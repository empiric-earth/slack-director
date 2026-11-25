// The thread poller: one loop, no model call, inside the configured work hours.
//
// Every `poll_minutes` it lists the intake repo's open issues through the
// host's `gh` (one read, bodies included), and for every open, in-scope issue
// it reads the Slack thread — plus the conversation for a DM or a group DM —
// for messages newer than the newest one it has seen. A newer message wakes the
// issue's item session with a fixed "new activity" prompt that names the source
// and the watermark; an open issue whose session was deleted or archived is
// unattended: it is read and shown, never woken and never given a new session.
//
// The poller writes nothing to GitHub and nothing to Slack. It keeps only Slack
// `ts` values — never message text — and its log lines and status name issue
// numbers and reasons, never an issue body.
import { DEFAULT_POLL_MINUTES } from "./config.js"
import { newActivityPrompt } from "./first-prompt.js"
import { ISSUE_LIST_LIMIT, issueListArgs } from "./gh.js"
import { readMessages, newestTs, READ_CHANNEL_TOOL, READ_PAGES, READ_THREAD_TOOL, SLACK_MCP_URL } from "./slack-mcp.js"
import { KEYS } from "./state.js"
import { inWorkHours } from "./work-hours.js"

export { DEFAULT_POLL_MINUTES }

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** The poller status before its first cycle. */
export function defaultPollerStatus() {
  return {
    lastCycle: null,
    outcome: "never polled",
    issues: 0,
    threads: 0,
    conversations: 0,
    unattended: [],
    ghError: null,
    failed: [],
    possiblyCut: false,
  }
}

/** The fenced yaml block at the top of an intake issue's body, or undefined. */
export function yamlBlockOf(body) {
  const match = typeof body === "string" ? /```ya?ml\r?\n([\s\S]*?)```/.exec(body) : null
  return match ? match[1] : undefined
}

/**
 * The fields of that block, one `key: value` line each. Answers undefined when
 * the block holds no field at all, which is how a block that does not parse is
 * told from an empty one. A `#` starts a comment, and a value's surrounding
 * quotes are dropped.
 */
export function blockFields(text) {
  const fields = {}
  let any = false
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const at = line.indexOf(":")
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (!/^[A-Za-z_][\w-]*$/.test(key)) continue
    let value = line.slice(at + 1).replace(/\s+#.*$/, "").trim()
    value = value.replace(/^["'](.*)["']$/, "$1")
    any = true
    if (value !== "") fields[key] = value
  }
  return any ? fields : undefined
}

/** A Slack `ts` value for an ISO time, to the microsecond Slack writes. */
export function tsOfIso(iso) {
  if (typeof iso !== "string") return undefined
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return undefined
  return (ms / 1000).toFixed(6)
}

/** The Slack `ts` 60 seconds before one, for a new item's first watermark. */
export function tsBefore(ts, seconds) {
  if (typeof ts !== "string") return undefined
  const value = Number(ts) - seconds
  if (!Number.isFinite(value) || value < 0) return undefined
  return value.toFixed(6)
}

/** The open issues a successful `gh` read returned, or why it cannot be read. */
export function issueList(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout ?? "")
  } catch {
    throw new Error("the issue list was not JSON")
  }
  if (!Array.isArray(parsed)) throw new Error("the issue list was not an array")
  return parsed
    .filter((issue) => issue && typeof issue.number === "number")
    .map((issue) => ({
      number: issue.number,
      url: typeof issue.url === "string" ? issue.url : "",
      title: typeof issue.title === "string" ? issue.title : "",
      body: typeof issue.body === "string" ? issue.body : "",
    }))
}

/** The one line a failed `gh` read reports, carrying no token and no body. */
export function ghFailureText(result) {
  if (!result || result.ok !== true) {
    const stderr = typeof result?.stderr === "string" ? result.stderr.split(/\r?\n/).find((line) => line.trim() !== "") : undefined
    const detail = stderr ?? (result?.code === null || result?.code === undefined ? "gh could not be run" : `exit ${result.code}`)
    return detail.trim().slice(0, 200)
  }
  return "the issue list could not be read"
}

/** The servers the poller reads through: the Slack MCP servers, by name. */
function slackServer(servers, name) {
  return (servers ?? []).find((server) => server?.name === name && server.url === SLACK_MCP_URL)
}

/**
 * Create the poller over one plugin storage. `run` makes one cycle and answers
 * the next interval in minutes and the status it wrote.
 */
export function createPoller({
  storage,
  now = Date.now,
  fetch,
  runGh,
  readConfig,
  resolveCredential = async () => undefined,
  mcpServers = async () => [],
  session,
  log = () => {},
  onChange = () => {},
  requestTimeoutMs,
  pages = READ_PAGES,
  inHours = inWorkHours,
}) {
  async function writeStatus(status) {
    await storage.set(KEYS.poller, status)
    try {
      onChange()
    } catch (error) {
      log(`poller: the change notice failed — ${messageOf(error)}`)
    }
  }

  async function readStatus() {
    return (await storage.get(KEYS.poller)) ?? defaultPollerStatus()
  }

  async function readWatermarks() {
    const stored = await storage.get(KEYS.watermarks)
    return stored && typeof stored === "object" ? stored : {}
  }

  /** Whether an item session may be prompted: it is not running and waits on no permission. */
  async function promptable(record) {
    if (record?.permissionPending === true) return false
    if (typeof record?.sessionID !== "string" || record.sessionID === "") return false
    try {
      const found = await session.get({ sessionID: record.sessionID })
      if (found === undefined || found === null) return false
      const times = found.time
      if (
        times &&
        typeof times === "object" &&
        times.busy !== undefined &&
        times.busy !== null &&
        !(typeof times.idle === "number" && times.idle >= times.busy)
      ) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  async function readOne({ server, token, tool, args }) {
    return readMessages({
      fetch,
      url: server.url,
      token: token.access,
      tool,
      args,
      pages,
      ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
    })
  }

  async function cycle(config, ranAt) {
    const listed = await runGh(issueListArgs(config.intake_repo))
    if (!listed || listed.ok !== true) {
      const detail = ghFailureText(listed)
      log(`poller: the issue list failed — ${detail}`)
      return { ...defaultPollerStatus(), lastCycle: ranAt, outcome: `gh failed: ${detail}`, ghError: detail }
    }
    let issues
    try {
      issues = issueList(listed.stdout)
    } catch (error) {
      const detail = messageOf(error)
      log(`poller: the issue list could not be read — ${detail}`)
      return { ...defaultPollerStatus(), lastCycle: ranAt, outcome: `gh failed: ${detail}`, ghError: detail }
    }
    const possiblyCut = issues.length === ISSUE_LIST_LIMIT
    if (possiblyCut) log(`poller: the issue list is possibly cut at ${ISSUE_LIST_LIMIT}`)

    let servers = []
    try {
      servers = await mcpServers()
    } catch (error) {
      log(`poller: the MCP servers were not read — ${messageOf(error)}`)
    }

    const watermarks = await readWatermarks()
    const nextWatermarks = { ...watermarks }
    const records = Object.values((await storage.get(KEYS.items)) ?? {}).filter(
      (record) => record && typeof record.permalink === "string",
    )
    const recordFor = (issue, fields) =>
      records.find(
        (record) =>
          (typeof record.issueNumber === "number" && record.issueNumber === issue.number) ||
          (typeof fields.permalink === "string" && record.permalink === fields.permalink),
      )

    const unattended = []
    const failed = []
    let issuesRead = 0
    let threads = 0
    let conversations = 0
    let outcome = "ok"
    let watermarksChanged = false

    for (const issue of issues) {
      const block = yamlBlockOf(issue.body)
      const fields = block === undefined ? undefined : blockFields(block)
      if (!fields) {
        log(`poller: issue #${issue.number} skipped — its yaml block did not parse`)
        continue
      }
      // A message the scope rules leave out is never read and never wakes.
      if (typeof fields.category === "string" && fields.category !== "") continue

      issuesRead += 1
      const key = String(issue.number)
      const stored = watermarks[key]
      const storedTs = typeof stored?.ts === "string" ? stored.ts : undefined
      const firstReadAt = typeof stored?.firstReadAt === "string" ? stored.firstReadAt : ranAt
      const record = recordFor(issue, fields)
      const flaggedTs = record ? tsOfIso(record.flaggedAt) : undefined

      // The effective watermark: what was stored, else a new item's flag minus
      // 60 seconds, else (an issue no item record names) nothing yet.
      let watermark = storedTs
      if (watermark === undefined && record && flaggedTs !== undefined) watermark = tsBefore(flaggedTs, 60)

      const server = slackServer(servers, fields.workspace)
      const token = server ? await resolveCredential(fields.workspace) : undefined
      const channelID = fields.channel_id
      const threadTs = fields.thread_ts
      if (!server || !token?.access || !channelID || !threadTs) {
        failed.push(issue.number)
        if (outcome === "ok") outcome = `read failed: #${issue.number}`
        log(`poller: issue #${issue.number} was not read — ${!server ? "no Slack server" : !token?.access ? "no credential" : "the issue names no channel or thread"}`)
        continue
      }

      const oldest = watermark
      const threadRead = await readOne({
        server,
        token,
        tool: READ_THREAD_TOOL,
        args: { channel_id: channelID, message_ts: threadTs, ...(oldest ? { oldest } : {}) },
      })
      threads += 1
      const isDm = fields.channel_name === "DM" || fields.channel_name === "GDM"
      const conversationRead = isDm
        ? await readOne({
            server,
            token,
            tool: READ_CHANNEL_TOOL,
            args: { channel_id: channelID, ...(oldest ? { oldest } : {}) },
          })
        : undefined
      if (isDm) conversations += 1

      const stop = threadRead.error || threadRead.unauthorized || threadRead.rateLimited
        ? threadRead
        : conversationRead && (conversationRead.error || conversationRead.unauthorized || conversationRead.rateLimited)
          ? conversationRead
          : undefined
      if (stop) {
        failed.push(issue.number)
        const reason = stop.rateLimited ? "rate limited" : stop.unauthorized ? "sign-in expired" : "read failed"
        if (outcome === "ok") outcome = `${reason}: #${issue.number}`
        log(`poller: issue #${issue.number} ${reason} — no watermark moved`)
        continue
      }

      const threadNewest = newestTs(threadRead.timestamps)
      const convNewest = conversationRead ? newestTs(conversationRead.timestamps) : undefined
      const newest = newestTs([threadNewest, convNewest].filter((value) => value !== undefined))
      const newer = (value) => value !== undefined && (watermark === undefined || Number(value) > Number(watermark))
      const threadNewer = newer(threadNewest)
      const convNewer = newer(convNewest)
      const anyNewer = (threadNewer || convNewer) && watermark !== undefined

      if (!record) {
        // An unattended issue: read and shown, never woken. Its watermark is set
        // once, at its first read, and does not move after that.
        const newActivity = storedTs !== undefined && anyNewer
        if (storedTs === undefined) {
          nextWatermarks[key] = { ts: newest ?? null, firstReadAt }
          watermarksChanged = true
        } else if (newActivity) {
          // The watermark stays; only the mark moves.
        }
        const askedAt = fields.asked_at ?? firstReadAt
        unattended.push({
          number: issue.number,
          url: issue.url,
          title: issue.title,
          permalink: fields.permalink ?? "",
          state: fields.state ?? "needs-me",
          state_since: fields.state_since ?? askedAt,
          asked_at: askedAt,
          newActivity,
        })
        continue
      }

      let moved
      if (storedTs === undefined && watermark === undefined) {
        // A record with no flag time: start at this read's newest, with no wake.
        moved = newest
      } else if (anyNewer) {
        if (await promptable(record)) {
          const source = threadNewer && convNewer ? "both" : convNewer ? "conversation" : "thread"
          try {
            await session.prompt({
              sessionID: record.sessionID,
              text: newActivityPrompt({ issueUrl: issue.url, source, watermark }),
            })
            moved = newest ?? watermark
          } catch (error) {
            log(`poller: the wake for issue #${issue.number} failed — ${messageOf(error)}`)
          }
        }
        // A session that is running or waits on a permission keeps its
        // watermark, so the next cycle retries.
      } else {
        moved = newest ?? watermark
      }
      if (moved !== undefined && moved !== storedTs) {
        nextWatermarks[key] = { ts: moved, firstReadAt }
        watermarksChanged = true
      } else if (storedTs === undefined && moved === undefined) {
        nextWatermarks[key] = { ts: null, firstReadAt }
        watermarksChanged = true
      }
    }

    if (watermarksChanged) await storage.set(KEYS.watermarks, nextWatermarks)
    return {
      lastCycle: ranAt,
      outcome,
      issues: issuesRead,
      threads,
      conversations,
      unattended,
      ghError: null,
      failed,
      possiblyCut,
    }
  }

  /** One cycle. Returns the next interval in minutes and the status it wrote. */
  async function run() {
    const previous = await readStatus()
    const { config, error } = readConfig()
    const minutes = Number.isInteger(config?.poll_minutes) ? config.poll_minutes : DEFAULT_POLL_MINUTES
    if (config?.poll_minutes === 0) return { pollMinutes: 0, status: previous }
    if (!config || config.intake_repo === "") return { pollMinutes: minutes, status: previous }
    if (error) return { pollMinutes: minutes, status: previous }
    // Outside the work window nothing is read at all, like the flag scan.
    if (!inHours(config.work_hours, now())) return { pollMinutes: minutes, status: previous }
    const status = await cycle(config, new Date(now()).toISOString())
    await writeStatus(status)
    return { pollMinutes: minutes, status }
  }

  return { run, status: readStatus }
}
