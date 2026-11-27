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
import { randomUUID } from "node:crypto"
import { DEFAULT_POLL_MINUTES } from "./config.js"
import { newActivityPrompt } from "./first-prompt.js"
import { ISSUE_LIST_LIMIT, issueListArgs } from "./gh.js"
import { readMessages, newestTs, READ_CHANNEL_TOOL, READ_FORMAT, READ_PAGES, READ_THREAD_TOOL, SLACK_MCP_URL } from "./slack-mcp.js"
import { KEYS, LEASE_MS } from "./state.js"
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

/**
 * The status of a cycle whose issue list failed: nothing was read, so every row
 * keeps the visibility the last cycle gave it. The unattended rows of the last
 * cycle are carried over, so a failed read hides no open request.
 */
function failedCycle(previous, ranAt, detail) {
  return {
    ...defaultPollerStatus(),
    lastCycle: ranAt,
    outcome: `gh failed: ${detail}`,
    ghError: detail,
    unattended: Array.isArray(previous?.unattended) ? previous.unattended : [],
  }
}

/**
 * The unattended rows of a possibly cut list: the ones it names, plus every row
 * the last cycle carried whose issue this list does not name. A cut list proves
 * nothing about the issues it leaves out, so it hides none of them; a row this
 * list names is the fresh one.
 */
function carriedUnattended(previous, listed) {
  const carried = (Array.isArray(previous?.unattended) ? previous.unattended : []).filter(
    (row) => row && typeof row.number === "number" && !listed.some((fresh) => fresh.number === row.number),
  )
  return [...carried, ...listed]
}

/** The fenced yaml block at the top of an intake issue's body, or undefined. */
export function yamlBlockOf(body) {
  const match = typeof body === "string" ? /```ya?ml\r?\n([\s\S]*?)```/.exec(body) : null
  return match ? match[1] : undefined
}

/**
 * The fields of that block, one `key: value` line each. Answers undefined when
 * the block holds no field at all, which is how a block that does not parse is
 * told from an empty one. A `#` starts a comment, and a key's or a value's
 * surrounding quotes are dropped.
 *
 * A field is kept even when its value is empty, so a scope marker's presence is
 * never lost: an empty `category:` still excludes the issue. A line that is not
 * a plain `key: value` field — a line with no key, a quoted key the reader
 * cannot trust, a nested key — makes the whole block unreadable rather than
 * that one line dropped, so an issue whose scope marker hides behind such a
 * line is never read.
 */
export function blockFields(text) {
  const fields = {}
  let any = false
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const at = line.indexOf(":")
    // A line that is not a `key: value` field — an explicit mapping key, a list
    // item, a continuation — is syntax this reader does not support, and a scope
    // marker could hide in it, so the whole block is unreadable.
    if (at <= 0) return undefined
    const key = line.slice(0, at).trim().replace(/^["'](.*)["']$/, "$1")
    if (!/^[A-Za-z_][\w-]*$/.test(key)) return undefined
    let value = line.slice(at + 1).replace(/\s+#.*$/, "").trim()
    value = value.replace(/^["'](.*)["']$/, "$1")
    any = true
    fields[key] = value
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

/**
 * The Slack ids of a `waiting_on` field, as the issue writes them: a flow list
 * inside brackets, one bare id, or nothing at all.
 */
export function waitingIdsOf(value) {
  if (typeof value !== "string") return []
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "")
  return inner
    .split(",")
    .map((entry) => entry.trim().replace(/^["'](.*)["']$/, "$1"))
    .filter((entry) => entry !== "")
}

/** The request-state fields one open issue carries, as the item records and the dialog read them. */
function requestStateOfIssue(issue, fields) {
  return {
    number: issue.number,
    state: typeof fields?.state === "string" ? fields.state : undefined,
    stateSince: typeof fields?.state_since === "string" ? fields.state_since : undefined,
    blockedOn: typeof fields?.blocked_on === "string" ? fields.blocked_on : undefined,
    waitingOn: waitingIdsOf(fields?.waiting_on),
  }
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
 * the next interval in minutes and the status it wrote. `applyIssueStates`
 * receives the request state each open issue carries, so the item records and
 * the dialog follow it.
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
  applyIssueStates = async () => false,
  requestTimeoutMs,
  pages = READ_PAGES,
  inHours = inWorkHours,
  owner = randomUUID(),
  leaseMs = LEASE_MS,
  signal,
}) {
  // The instance's own stop. The plugin's unload aborts it, so a cycle still
  // reading when the timers move to another instance makes no more prompt and
  // writes no watermark: the successor's newer progress is never overwritten.
  const cancelled = () => signal?.aborted === true

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

  /**
   * Write the latest open-issue read for the flag scan's forget rule: whether
   * the read was complete (the list succeeded, was not possibly cut, and every
   * issue's block could be read) and every open issue's `permalink`. A failed
   * or cut read is written `complete: false`, so the flag scan forgets nothing
   * on it. The poller is the only writer of this key.
   */
  async function writeOpenIssues(snapshot) {
    await storage.set(KEYS.open, snapshot)
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
      // The default detail level is the only one that carries each message's
      // `Message TS:` line, so the reader asks for it explicitly.
      args: { ...args, response_format: READ_FORMAT },
      pages,
      signal,
      ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
    })
  }

  async function cycle(config, ranAt, previous) {
    if (cancelled()) return undefined
    const listed = await runGh(issueListArgs(config.intake_repo))
    if (!listed || listed.ok !== true) {
      const detail = ghFailureText(listed)
      log(`poller: the issue list failed — ${detail}`)
      await writeOpenIssues({ at: ranAt, complete: false, permalinks: [] })
      return failedCycle(previous, ranAt, detail)
    }
    let issues
    try {
      issues = issueList(listed.stdout)
    } catch (error) {
      const detail = messageOf(error)
      log(`poller: the issue list could not be read — ${detail}`)
      await writeOpenIssues({ at: ranAt, complete: false, permalinks: [] })
      return failedCycle(previous, ranAt, detail)
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

    const unattendedListed = []
    const failed = []
    const previousUnattended = Array.isArray(previous?.unattended) ? previous.unattended : []
    // One unattended issue's status entry. It is built from the open-issue list
    // alone, so a failed Slack read never hides the issue; `newActivity` is what
    // the read found, or, on a failed read, what the last cycle already knew. The
    // requester and the type come from the issue's yaml block, the same two
    // values a session row keeps, so the dialog's row shows them too.
    const unattendedEntry = (issue, fields, firstReadAt, newActivity) => {
      const before = previousUnattended.find((row) => row?.number === issue.number)
      const askedAt = fields.asked_at ?? firstReadAt
      return {
        number: issue.number,
        url: issue.url,
        title: issue.title,
        permalink: fields.permalink ?? "",
        state: fields.state ?? "needs-me",
        state_since: fields.state_since ?? askedAt,
        asked_at: askedAt,
        newActivity: newActivity ?? before?.newActivity === true,
        asker: fields.asker ?? "",
        channel_name: fields.channel_name ?? "",
        // The three fields a session needs to be created for the issue. They
        // are optional in the RPC contract, so an entry the older build stored
        // still validates; `adopt` refuses such an entry until a cycle rewrites
        // it.
        workspace: fields.workspace ?? "",
        channel_id: fields.channel_id ?? "",
        thread_ts: fields.thread_ts ?? "",
      }
    }
    // The request state every open issue carries, read before anything else is
    // decided about it, so the item records and the dialog follow the issue even
    // for an issue whose Slack source is not read.
    const openIssues = []
    // Every `permalink` the open issues name, and whether every issue's block
    // could be read. Both feed the flag scan's forget rule: an issue whose block
    // did not parse might carry a permalink, so its read is not a complete one.
    const openPermalinks = []
    let everyIssueRead = true
    let issuesRead = 0
    let threads = 0
    let conversations = 0
    let outcome = "ok"
    let watermarksChanged = false

    for (const issue of issues) {
      if (cancelled()) return undefined
      const block = yamlBlockOf(issue.body)
      const fields = block === undefined ? undefined : blockFields(block)
      if (!fields) everyIssueRead = false
      const permalink = typeof fields?.permalink === "string" ? fields.permalink.trim() : ""
      if (permalink !== "") openPermalinks.push(permalink)
      openIssues.push(requestStateOfIssue(issue, fields))
      if (!fields) {
        log(`poller: issue #${issue.number} skipped — its yaml block did not parse`)
        continue
      }
      // A message the scope rules leave out is never read and never wakes. The
      // marker counts whatever its value: a quoted key and an empty value both
      // reach here; a block the reader cannot trust was skipped above.
      if (Object.hasOwn(fields, "category")) continue

      issuesRead += 1
      const key = String(issue.number)
      const stored = watermarks[key]
      const storedTs = typeof stored?.ts === "string" ? stored.ts : undefined
      // With no `asked_at` of its own, an issue ages from the time the poller
      // first saw it: the stored time, else the one its last status entry
      // carried (a failed read stores none), else this cycle's. The baseline
      // write below stores this same time.
      const carriedAt = previousUnattended.find((row) => row?.number === issue.number)?.asked_at
      const firstReadAt =
        typeof stored?.firstReadAt === "string" ? stored.firstReadAt : typeof carriedAt === "string" ? carriedAt : ranAt
      const record = recordFor(issue, fields)

      // The effective watermark: what was stored, else the flag of an item this
      // build recorded, minus 60 seconds, so a reply that arrived while its
      // first turn ran is replayed once. An earlier build's item — a record with
      // no `pollerFrom` — and an issue no item record names baseline at their
      // first read, with no wake.
      let watermark = storedTs
      if (watermark === undefined && typeof record?.pollerFrom === "string") {
        const flaggedTs = tsOfIso(record.pollerFrom)
        if (flaggedTs !== undefined) watermark = tsBefore(flaggedTs, 60)
      }
      // An adopted item is never woken for a message older than its adopt time:
      // the session's first turn already read the thread at that point, so the
      // adopt time is the floor whatever watermark the issue was baselined with.
      if (typeof record?.adoptedAt === "string") {
        const adoptedTs = tsOfIso(record.adoptedAt)
        if (adoptedTs !== undefined && (watermark === undefined || Number(adoptedTs) > Number(watermark))) {
          watermark = adoptedTs
        }
      }

      const server = slackServer(servers, fields.workspace)
      const token = server ? await resolveCredential(fields.workspace) : undefined
      const channelID = fields.channel_id
      const threadTs = fields.thread_ts
      if (!server || !token?.access || !channelID || !threadTs) {
        failed.push(issue.number)
        if (outcome === "ok") outcome = `read failed: #${issue.number}`
        log(`poller: issue #${issue.number} was not read — ${!server ? "no Slack server" : !token?.access ? "no credential" : "the issue names no channel or thread"}`)
        if (!record) unattendedListed.push(unattendedEntry(issue, fields, firstReadAt))
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
        if (!record) unattendedListed.push(unattendedEntry(issue, fields, firstReadAt))
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
        unattendedListed.push(unattendedEntry(issue, fields, firstReadAt, newActivity))
        continue
      }

      let moved
      if (storedTs === undefined && watermark === undefined) {
        // No baseline for this item: start at this read's newest, with no wake.
        moved = newest
      } else if (anyNewer) {
        // A cycle the unload aborted stops here: it prompts nothing more, so a
        // successor that already owns the timers is the only one that wakes.
        if (cancelled()) return undefined
        const eligible = await promptable(record)
        // The session lookup awaits; an unload that aborted during it must not
        // prompt, so the boundary is checked again before the prompt.
        if (cancelled()) return undefined
        if (eligible) {
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

    // An aborted cycle writes nothing: its watermark snapshot may already be
    // older than the progress the successor made, and must not overwrite it.
    if (cancelled()) return undefined
    // The open-issue read the flag scan's forget rule reads: the permalinks
    // every issue names, and whether the read is whole — a list under the limit
    // whose every block could be read. A cut list or an unreadable body is no
    // proof that a permalink is gone.
    await writeOpenIssues({ at: ranAt, complete: !possiblyCut && everyIssueRead, permalinks: openPermalinks })
    // The request state the read carries reaches the item records, so the dialog
    // groups by it. A possibly cut list still names its issues' states; only a
    // complete one may hide an item whose issue it does not list.
    await applyIssueStates({ complete: !possiblyCut, issues: openIssues })
    if (watermarksChanged) await storage.set(KEYS.watermarks, nextWatermarks)
    return {
      lastCycle: ranAt,
      outcome,
      issues: issuesRead,
      threads,
      conversations,
      unattended: possiblyCut ? carriedUnattended(previous, unattendedListed) : unattendedListed,
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
    // The lease guards a second server process: a foreign, unexpired lease
    // spares this one the cycle, and this instance's own trip never blocks it.
    const lease = await storage.get(KEYS.lease)
    if (lease && lease.owner !== owner && typeof lease.expires === "number" && lease.expires > now()) {
      return { pollMinutes: minutes, status: previous }
    }
    await storage.set(KEYS.lease, { owner, expires: now() + leaseMs })
    let status
    try {
      status = await cycle(config, new Date(now()).toISOString(), previous)
    } catch (error) {
      // A read the unload aborted is not a failure: the cycle ends with the last
      // cycle in place, and the successor carries on.
      if (!cancelled()) throw error
      return { pollMinutes: minutes, status: previous }
    }
    // An aborted cycle leaves the last cycle in place, not a half-finished one.
    if (status === undefined) return { pollMinutes: minutes, status: previous }
    await writeStatus(status)
    return { pollMinutes: minutes, status }
  }

  return { run, status: readStatus }
}
