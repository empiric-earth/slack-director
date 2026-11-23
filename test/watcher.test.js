// The watcher: the flag scan, the claim files and the sessions they guard.
//
// Every test drives one or more watcher instances with a fake context and a
// fake HTTP layer over a temporary claims directory, and asserts what the
// poll's files and storage hold. No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as nodeFs from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaims, permalinkHash, STALE_MS } from "../src/claims.js"
import { DEFAULT_SESSION_AGENT, fieldProblem } from "../src/config.js"
import { SEARCH_TOOL, SLACK_MCP_URL } from "../src/slack-mcp.js"
import { claimsDir, KEYS, NAMESPACE, reissueDir } from "../src/state.js"
import { createWatcher, LEASE_MS, RECORD_FORMAT, REFRESH_AGENT, SESSION_EVENT_TYPES, SUSPENDED_ERROR } from "../src/watcher.js"
import { SlackDirectorRpc } from "../rpc.js"
import { schemaProblem } from "./schema.js"

// A fixed clock, at noon UTC on a Wednesday: the harness's window covers a
// whole day, so every test that does not set its own window polls inside it.
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const ALL_DAY = { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], start: "00:00", end: "23:59", time_zone: "UTC" }
const NEXAR = { name: "slack_nexar", url: SLACK_MCP_URL }
const NAUTO = { name: "slack_nauto", url: SLACK_MCP_URL }
const TODOIST = { name: "todoist", url: "https://ai.todoist.net/mcp" }

const permalinkOf = (channel, ts, host = "nexar") =>
  `https://${host}.slack.com/archives/${channel}/p${ts.replace(".", "")}`
const hitRow = (channel, ts, channelName, host, asker) => ({
  channel,
  ts,
  channelName,
  permalink: permalinkOf(channel, ts, host),
  ...(asker === undefined ? {} : { asker }),
})

/**
 * One page of the search tool's answer, in the shape the live tool returns: one
 * markdown report under `results`, one `### Result` block per message, each
 * carrying its permalink, and the next page's cursor in a `pagination_info`
 * line.
 */
const page = (rows, next) => ({
  results: [
    `Search results for: "is:saved"`,
    "",
    `## Messages (${rows.length} results) ===`,
    ...rows.flatMap((row, index) => [
      `### Result ${index + 1} of ${rows.length}`,
      `Channel: ${row.channelName} (${row.channel})`,
      `From: ${row.asker ?? "Someone"} (U0000000000)`,
      `Time: 2026-11-19 10:00:00 UTC`,
      `Message_ts: ${row.ts}`,
      `Permalink: [link](${row.permalink})`,
      `Text: A message the user flagged.`,
      "",
      `Context before:`,
      `- From: Someone else (U0000000001)`,
      `Message_ts: ${row.ts}`,
      `Text: An earlier message in the same channel.`,
      "",
    ]),
  ].join("\n"),
  pagination_info: next ? `For the next page of results use cursor \`${next}\`` : "",
})
const message = (secondsAgo) => `${Math.floor((NOW - secondsAgo * 1000) / 1000)}.000100`

function respond(status, text, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async text() {
      return text
    },
  }
}

function memoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined
    },
    async set(key, value) {
      map.set(key, structuredClone(value))
    },
    async remove(key) {
      map.delete(key)
    },
  }
}

async function waitFor(condition, label) {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let every pending microtask and macrotask of the other work run. */
async function yieldTimes(times) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * One item record in the form an earlier build wrote: no `recordFormat`, and no
 * issue URL unless the test gives one.
 */
function earlierRecord({
  link,
  ts,
  sessionID,
  flaggedAt,
  issueUrl = null,
  issueNumber = null,
  title = "Flagged message in #platform-help — Maria Costa",
  permissionPending = false,
}) {
  return {
    permalink: link,
    workspace: "slack_nexar",
    channel: "#platform-help",
    channelID: "C0PLATFORM",
    ts,
    asker: "Maria Costa",
    flaggedAt,
    title,
    sessionID,
    issueNumber,
    issueUrl,
    firstTurnEndedAt: null,
    firstTurnFailed: true,
    permissionPending,
    openedAt: null,
  }
}

/** The run times of a session that has been idle and unchanged past the stale age. */
const quietTimes = (now) => ({ busy: now - 3_600_000, idle: now - 3_500_000, updated: now - 20 * 60_000 })

/** Age one reissue claim and commit pair past the stale age. */
function ageReissue(h, hash) {
  const old = new Date(h.now() - STALE_MS - 60_000)
  for (const name of [`${hash}.claim.0`, `${hash}.session`]) {
    const file = join(h.reissueDir, name)
    if (existsSync(file)) utimesSync(file, old, old)
  }
}

/**
 * The claims files' timestamps follow the harness clock rather than the
 * machine's, so a test that moves the clock makes a claim or a commit file
 * exactly as stale as it says.
 */
function pinnedFs(now) {
  const stamp = (file) => {
    try {
      const at = new Date(now())
      utimesSync(file, at, at)
    } catch {
      // A path the call did not create needs no stamp.
    }
  }
  return {
    ...nodeFs,
    writeFileSync(file, data, options) {
      nodeFs.writeFileSync(file, data, options)
      stamp(file)
    },
    linkSync(from, to) {
      nodeFs.linkSync(from, to)
      stamp(to)
    },
  }
}

/**
 * A fake context: one shared storage and claims directory, a fake HTTP layer
 * that answers MCP over HTTP from `pages`, and a fake session API that records
 * every call.
 */
function harness({
  pages = {},
  statuses = {},
  servers = [NEXAR, NAUTO],
  credentials,
  stall = [],
  fetchHold,
  serverError,
  requestTimeoutMs,
  workHours = ALL_DAY,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "slack-director-watcher-"))
  const stateHome = join(root, "state")
  const dir = claimsDir({ XDG_STATE_HOME: stateHome })
  const reissueDirPath = reissueDir({ XDG_STATE_HOME: stateHome })
  const storage = memoryStorage()
  const clock = { ms: NOW }
  const now = () => clock.ms
  const calls = []
  const logs = []
  const searches = new Map()
  const consoleOutput = []
  const realWarn = console.warn
  const realLog = console.log
  const realError = console.error
  const record = (write) => (...args) => {
    consoleOutput.push(args.map((value) => String(value)).join(" "))
    write(...args)
  }
  console.warn = record(realWarn)
  console.log = record(realLog)
  console.error = record(realError)
  const created = []
  const prompts = []
  const removed = []
  const waited = []
  const retitles = []
  const contexts = new Map()
  // The run times `session.get` answers for one session id, and the error it
  // throws instead when a test seeds one.
  const sessions = new Map()
  const changes = []
  const configWrites = []
  const tokens = credentials ?? { slack_nexar: { access: "tok-nexar", expires: 0 }, slack_nauto: { access: "tok-nauto", expires: 0 } }
  const config = {
    intake_repo: "empiric-earth/almeida-slack-intake",
    session_directory: join(root, "session-directory"),
    poll_seconds: 60,
    work_hours: structuredClone(workHours),
    session_agent: DEFAULT_SESSION_AGENT,
  }

  const fetch = async (url, init) => {
    const token = String(init.headers.authorization ?? "").replace(/^Bearer /, "")
    const body = JSON.parse(init.body)
    calls.push({
      url,
      token,
      headers: init.headers,
      method: body.method,
      name: body.params?.name,
      args: body.params?.arguments,
    })
    if (fetchHold) await fetchHold
    if (stall.includes(token)) return new Promise(() => {})
    const override = statuses[token]
    if (override) return respond(override.status, override.text ?? "")
    if (body.method === "initialize") {
      return respond(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        "mcp-session-id": `mcp-${token}`,
      })
    }
    if (body.method === "notifications/initialized") return respond(202, "")
    if (body.method === "tools/call") {
      const raw = pages[token] ?? []
      const cursor = body.params?.arguments?.cursor
      const index = cursor === undefined ? 0 : Number(cursor)
      const search = searches.get(token) ?? 0
      searches.set(token, search + 1)
      const current = typeof raw === "function" ? raw(index, search, body.params?.arguments) : (raw[index] ?? page([], null))
      return respond(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(current) }] },
        }),
      )
    }
    return respond(200, "{}")
  }

  const session = {
    onCreate: null,
    onPrompt: null,
    async create(input) {
      if (session.onCreate) await session.onCreate(input)
      const id = `ses_${created.length + 1}`
      created.push({ id, ...input })
      return { id }
    },
    async prompt(input) {
      if (session.onPrompt) await session.onPrompt(input)
      prompts.push(input)
      return {}
    },
    async remove({ sessionID }) {
      removed.push(sessionID)
    },
    async wait({ sessionID }) {
      waited.push(sessionID)
    },
    async get({ sessionID }) {
      const seeded = sessions.get(sessionID)
      if (seeded?.error) throw seeded.error
      if (seeded) return { id: sessionID, time: structuredClone(seeded.time) }
      throw new Error(`session not found: ${sessionID}`)
    },
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? [])
    },
    async update({ sessionID, title }) {
      retitles.push({ sessionID, title })
    },
  }

  const claims = createClaims({ dir, now, fs: pinnedFs(now) })
  const reissue = createClaims({ dir: reissueDirPath, now, fs: pinnedFs(now) })

  /**
   * A storage object of its own over the same plugin namespace, as every host
   * context holds one: it forwards to the shared storage at call time.
   */
  const facade = () => ({
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, value),
    remove: (key) => storage.remove(key),
  })

  const newWatcher = (own = storage) =>
    createWatcher({
      storage: own,
      claims,
      reissue,
      now,
      fetch,
      readConfig: () => ({ config }),
      writeConfig: (field, value) => {
        const problem = fieldProblem(field, value)
        if (problem) return { error: { field, message: problem } }
        configWrites.push({ field, value })
        config[field] = value
        return { config }
      },
      onChange: () => changes.push(now()),
      mcpServers: async () => {
        if (serverError) throw serverError
        return servers
      },
      resolveCredential: async (name) => tokens[name],
      session,
      log: (message) => logs.push(message),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    })

  return {
    root,
    dir,
    reissueDir: reissueDirPath,
    storage,
    clock,
    now,
    calls,
    logs,
    consoleOutput,
    created,
    prompts,
    removed,
    waited,
    retitles,
    contexts,
    sessions,
    changes,
    configWrites,
    tokens,
    config,
    session,
    claims,
    reissue,
    newWatcher,
    facade,
    watcher: newWatcher(),
    items: () => storage.map.get(KEYS.items) ?? {},
    seen: () => storage.map.get(KEYS.seen) ?? [],
    status: () => storage.map.get(KEYS.status) ?? {},
    toolCalls: () => calls.filter((call) => call.method === "tools/call"),
    setItems: (value) => storage.map.set(KEYS.items, value),
    setSeen: (value) => storage.map.set(KEYS.seen, value),
    clean: () => {
      console.warn = realWarn
      console.log = realLog
      console.error = realError
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a poll calls only the Slack servers, only the search tool, with the Save-for-later filter and no date modifier", async () => {
  const h = harness({ servers: [NEXAR, NAUTO, TODOIST] })
  try {
    await h.watcher.poll()
    assert.equal(h.calls.filter((call) => call.url === TODOIST.url).length, 0, "the non-Slack MCP server is never called")
    assert.deepEqual([...new Set(h.calls.map((call) => call.url))], [SLACK_MCP_URL])
    assert.deepEqual(
      [...new Set(h.calls.map((call) => call.method))].sort(),
      ["initialize", "notifications/initialized", "tools/call"],
      "the transport is initialize, notifications/initialized and tools/call",
    )
    const searches = h.toolCalls()
    assert.equal(searches.length, 2, "both Slack workspaces are searched")
    for (const call of searches) {
      assert.equal(call.name, SEARCH_TOOL, "every tool call names the search tool and no other")
      assert.equal(call.args.filters, "is:saved", "the search carries the Save-for-later filter")
      assert.equal(call.args.query, undefined, "the search sends no `query` argument the tool does not take")
      assert.ok(!/(after|before|on|during):/.test(call.args.filters), "the filter carries no date modifier")
      assert.equal(call.args.sort, "timestamp", "the scan sorts by message time")
    }
  } finally {
    h.clean()
  }
})

test("the scan follows the cursor to the last page and gives a week-old hit one session", async () => {
  const ts = message(7 * 24 * 60 * 60)
  const h = harness({
    pages: {
      "tok-nexar": [
        page([], "1"),
        page([], "2"),
        page([hitRow("C0PLATFORM", ts, "#platform-help")], null),
      ],
      "tok-nauto": [page([], null)],
    },
  })
  try {
    await h.watcher.poll()
    const searches = h.toolCalls().filter((call) => call.token === "tok-nexar")
    assert.equal(searches.length, 3, "the poll followed the cursor to the last page")
    assert.deepEqual(
      searches.map((call) => call.args.cursor),
      [undefined, "1", "2"],
      "each call carries the previous page's cursor",
    )
    assert.equal(h.created.length, 1, "the week-old hit on the last page got one session")
    assert.equal(h.prompts.length, 1)
  } finally {
    h.clean()
  }
})

test("a week-old hit on an Enterprise Grid permalink gets one session", async () => {
  const ts = message(7 * 24 * 60 * 60)
  const grid = `https://grid-nauto.enterprise.slack.com/archives/D03KHBF103X/p${ts.replace(".", "")}`
  const h = harness({ pages: { "tok-nexar": [page([hitRow("D03KHBF103X", ts, "DM", "grid-nauto.enterprise")], null)] } })
  try {
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the Grid host does not stop the hit")
    const prompt = h.prompts[0].text
    assert.ok(prompt.includes(grid), "the prompt carries the Grid permalink")
    assert.ok(prompt.includes("DM"), "the prompt carries the channel label")
    assert.ok(prompt.includes(ts), "the prompt carries the message ts")
    assert.equal(h.items()[grid].channelID, "D03KHBF103X")
    assert.equal(h.items()[grid].ts, ts)
    assert.equal(h.items()[grid].workspace, "slack_nexar", "the workspace is the MCP server's name")
  } finally {
    h.clean()
  }
})

test("a report that lists results but carries no permalink logs the shape and creates nothing", async () => {
  const ts = message(60)
  const h = harness({
    pages: { "tok-nexar": [page([{ channel: "D03KHBF103X", ts, channelName: "DM", permalink: "" }], null)] },
  })
  try {
    await h.watcher.poll()
    assert.equal(h.created.length, 0)
    assert.equal(h.logs.length, 1, "one shape line")
    assert.match(h.logs[0], /fields results, pagination_info/, "the line names the answer's fields")
    assert.match(h.logs[0], /result blocks 1/)
    assert.ok(!h.logs[0].includes("Text:"), "the line carries no message text")
  } finally {
    h.clean()
  }
})

test("a new hit gets exactly one session on the triage agent, and the same hit on the next poll gets none", async () => {
  const ts = message(120)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "exactly one session")
    const [session] = h.created
    assert.equal(session.agent, DEFAULT_SESSION_AGENT, "the configured session agent")
    assert.deepEqual(session.location, { directory: h.config.session_directory }, "the configured directory")
    assert.equal(h.prompts.length, 1, "exactly one first prompt")
    const prompt = h.prompts[0].text
    assert.ok(prompt.includes(permalinkOf("C0PLATFORM", ts)), "the prompt carries the permalink")
    assert.ok(prompt.includes("slack_nexar"), "the prompt carries the workspace")
    assert.ok(prompt.includes("#platform-help"), "the prompt carries the channel")
    assert.ok(prompt.includes(ts), "the prompt carries the message ts")
    assert.equal(h.prompts[0].sessionID, session.id)

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the same hit on the next poll creates none")
    assert.equal(h.prompts.length, 1)
  } finally {
    h.clean()
  }
})

test("a new hit's session gets the full first prompt of an item session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const prompt = h.prompts[0].text
    assert.ok(prompt.includes("`slack-director` skill"), "the prompt loads the slack-director skill")
    assert.ok(prompt.includes(h.config.intake_repo), "the prompt carries the intake repo")
    assert.ok(/one comment/i.test(prompt), "the prompt asks for one comment on the issue")
    assert.ok(prompt.includes("a request to the user"), "a flagged message counts as a request to the user")
    assert.ok(prompt.includes("no issue edit, label, close or reopen"), "the prompt forbids an issue edit")
    assert.ok(prompt.includes("Intake issue: "), "the reply's first fixed line")
    assert.ok(prompt.includes("Title: "), "the reply's second fixed line")
    assert.ok(prompt.includes("A message you leave out still gets its issue"), "the reply's line for a message left out")
    assert.match(prompt, /take no other action/i, "the first turn is bounded")
  } finally {
    h.clean()
  }
})

test("a permalink the earlier build already saw gets one item session with the full first prompt", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    // The earlier build kept its state under the `skeleton` namespace: a seen
    // entry, an item record, a claim file and a commit file. The item build
    // reads none of it, so the permalink is new again.
    const hash = permalinkHash(link)
    const record = {
      permalink: link,
      workspace: "slack_nexar",
      channel: "#platform-help",
      channelID: "C0PLATFORM",
      ts,
      flaggedAt: new Date(h.now()).toISOString(),
      sessionID: "ses_skeleton",
      firstTurnFailed: true,
      firstTurnEndedAt: null,
    }
    h.storage.map.set("skeleton/seen", [link])
    h.storage.map.set("skeleton/items", { [link]: record })
    const skeletonDir = join(h.root, "state", "opencode", "slack-director", "claims", "skeleton")
    mkdirSync(skeletonDir, { recursive: true })
    writeFileSync(join(skeletonDir, `${hash}.claim.0`), String(h.now()))
    writeFileSync(
      join(skeletonDir, `${hash}.session`),
      JSON.stringify({ sessionID: "ses_skeleton", committedAt: new Date(h.now()).toISOString(), ...record }),
    )

    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the skeleton-seen permalink gets one item session")
    assert.equal(h.created[0].agent, DEFAULT_SESSION_AGENT, "on the configured session agent")
    const prompt = h.prompts[0].text
    assert.ok(prompt.includes(link), "the full first prompt carries the permalink")
    assert.ok(prompt.includes("`slack-director` skill"), "and the skill it loads")
    assert.ok(prompt.includes(h.config.intake_repo), "and the intake repo")

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the next poll creates no second session")
    assert.equal(h.prompts.length, 1)
  } finally {
    h.clean()
  }
})

test("two instances that both find the lease absent still give one hit one prompted session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const second = h.newWatcher()
    await Promise.all([h.watcher.poll(), second.poll()])
    assert.equal(h.prompts.length, 1, "exactly one prompted session for the hit")
    assert.equal(Object.keys(h.items()).length, 1)
  } finally {
    h.clean()
  }
})

test("an instance is never blocked by its own lease, so a shorter configured interval is honoured", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    h.config.poll_seconds = 15
    await h.watcher.poll()
    const first = h.status().lastPoll
    const searches = h.toolCalls().length
    // One new interval later: well inside the lease this instance just took.
    h.clock.ms += 15_000
    await h.watcher.poll()
    assert.equal(h.status().lastPoll, new Date(h.now()).toISOString(), "the next tick at the configured interval ran")
    assert.notEqual(h.status().lastPoll, first)
    assert.equal(h.toolCalls().length, searches + 2, "it searched both Slack workspaces, as a poll does")
  } finally {
    h.clean()
  }
})

test("a scan that outruns part of the interval leaves no lease that skips the next tick", async () => {
  const ts = message(60)
  let h
  const pages = {
    "tok-nexar": () => {
      h.clock.ms += 10_000
      return page([hitRow("C0PLATFORM", ts, "#platform-help")], null)
    },
  }
  h = harness({ servers: [NEXAR], pages })
  try {
    h.config.poll_seconds = 15
    await h.watcher.poll()
    assert.equal(h.status().lastPoll, new Date(h.now()).toISOString(), "the first scan ran")
    // The scan above took ten seconds, so the next tick lands inside the lease
    // that poll took. The instance's own lease must not skip it.
    h.clock.ms += 15_000
    await h.watcher.poll()
    assert.equal(h.status().lastPoll, new Date(h.now()).toISOString(), "the next tick ran")
  } finally {
    h.clean()
  }
})

test("another instance's unexpired lease still spares a duplicate poll", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const searches = h.toolCalls().length
    // The other instance's lease is still valid one interval later.
    h.clock.ms += 15_000
    const blocked = await h.newWatcher().poll()
    assert.equal(h.toolCalls().length, searches, "the second instance made no Slack call")
    assert.equal(blocked.status.lastPoll, new Date(NOW).toISOString(), "the second instance answered the last status unchanged")
  } finally {
    h.clean()
  }
})

test("a lease that expires mid-poll lets a second instance take over, and still one hit gets one session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    let release
    h.session.onCreate = () => new Promise((resolve) => (release = resolve))
    const first = h.watcher.poll()
    await waitFor(() => release !== undefined, "the first instance to reach its session create")
    h.clock.ms += LEASE_MS + 1
    h.session.onCreate = null
    const second = h.newWatcher()
    await second.poll()
    release()
    await first
    assert.equal(h.prompts.length, 1, "one prompted session for the hit")
  } finally {
    h.clean()
  }
})

test("a failed session create drops the claim, and the next poll creates and prompts the session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    let attempt = 0
    h.session.onCreate = async () => {
      attempt += 1
      if (attempt === 1) throw new Error("session create refused")
    }
    await h.watcher.poll()
    assert.equal(h.created.length, 0)
    assert.equal(h.prompts.length, 0)
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the next poll created the session")
    assert.equal(h.prompts.length, 1, "and prompted it")
  } finally {
    h.clean()
  }
})

test("a claim older than ten minutes with no commit file gets one prompted session on the next poll", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const hash = permalinkHash(permalinkOf("C0PLATFORM", ts))
    h.claims.claim(hash)
    const old = new Date(h.now() - STALE_MS - 60_000)
    utimesSync(join(h.dir, `${hash}.claim.0`), old, old)
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the stale claim was recovered")
    assert.equal(h.prompts.length, 1)
    assert.ok(existsSync(join(h.dir, `${hash}.claim.1`)), "recovery created the next generation")
  } finally {
    h.clean()
  }
})

test("two instances that both see one stale claim create exactly one session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const hash = permalinkHash(permalinkOf("C0PLATFORM", ts))
    h.claims.claim(hash)
    const old = new Date(h.now() - STALE_MS - 60_000)
    utimesSync(join(h.dir, `${hash}.claim.0`), old, old)
    await Promise.all([h.watcher.poll(), h.newWatcher().poll()])
    assert.equal(h.created.length, 1, "exactly one instance created a session")
    assert.equal(h.prompts.length, 1, "exactly one session is prompted")
  } finally {
    h.clean()
  }
})

test("a stalled holder that resumes after a takeover removes its session and prompts nothing", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    let release
    h.session.onCreate = () => new Promise((resolve) => (release = resolve))
    const stalled = h.watcher.poll()
    await waitFor(() => release !== undefined, "the stalled holder to reach its session create")
    h.clock.ms += STALE_MS + 60_000
    h.session.onCreate = null
    await h.newWatcher().poll()
    assert.equal(h.prompts.length, 1, "the second instance prompted one session")
    const winner = h.prompts[0].sessionID
    release()
    await stalled
    assert.equal(h.prompts.length, 1, "the resumed holder prompted nothing")
    assert.equal(h.created.length, 2, "both instances created a session")
    const loser = h.created.find((session) => session.id !== winner)
    assert.ok(h.removed.includes(loser.id), "the loser's session is removed")
    assert.equal(h.items()[permalinkOf("C0PLATFORM", ts)].sessionID, winner, "the item map holds the winner")
  } finally {
    h.clean()
  }
})

test("a stalled holder that commits first keeps the item, and the recoverer removes its session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const realCommit = h.claims.commit
    const parked = []
    h.claims.commit = async (hash, record) => {
      await new Promise((resolve) => parked.push({ sessionID: record.sessionID, resolve }))
      return realCommit(hash, record)
    }
    const holder = h.watcher.poll()
    await waitFor(() => parked.length === 1, "the original holder to reach its commit")
    h.clock.ms += STALE_MS + 60_000
    const recoverer = h.newWatcher().poll()
    await waitFor(() => parked.length === 2, "the recoverer to reach its commit")
    const [first, second] = parked
    first.resolve()
    await holder
    assert.equal(h.prompts.length, 1, "the original holder prompted one session")
    const winner = first.sessionID
    second.resolve()
    await recoverer
    assert.equal(h.prompts.length, 1, "the recoverer prompted nothing")
    const loser = h.created.find((session) => session.id !== winner)
    assert.ok(h.removed.includes(loser.id), "the recoverer's session is removed")
    assert.equal(h.items()[permalinkOf("C0PLATFORM", ts)].sessionID, winner, "the item map holds the winner")
  } finally {
    h.clean()
  }
})

test("a commit whose holder stopped before recording stays invisible, then reconciles as waiting without a prompt", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const link = permalinkOf("C0PLATFORM", ts)
    const hash = permalinkHash(link)
    const record = {
      sessionID: "ses_holder",
      committedAt: new Date(h.now()).toISOString(),
      permalink: link,
      workspace: "slack_nexar",
      channel: "#platform-help",
      channelID: "C0PLATFORM",
      ts,
      firstTurnFailed: true,
      firstTurnEndedAt: null,
      recordFormat: RECORD_FORMAT,
    }
    h.claims.claim(hash)
    await h.claims.commit(hash, record)

    await h.watcher.poll()
    assert.equal(h.created.length, 0, "less than ten minutes later nothing is created")
    assert.equal(h.prompts.length, 0, "and nothing is prompted")
    assert.deepEqual(h.items(), {}, "and no item record is written")
    assert.deepEqual(h.seen(), [])

    h.clock.ms += STALE_MS + 60_000
    await h.watcher.poll()
    const stored = h.items()[link]
    assert.equal(stored.sessionID, "ses_holder", "the record holds the committed session id")
    assert.equal(stored.permalink, link)
    assert.equal(stored.workspace, "slack_nexar")
    assert.equal(stored.channel, "#platform-help")
    assert.equal(stored.ts, ts)
    assert.equal(stored.firstTurnFailed, true, "the reconciled record reads as waiting")
    assert.deepEqual(h.seen(), [link], "the permalink joins the seen-set")
    assert.equal(h.created.length, 0, "no session is created")
    assert.equal(h.prompts.length, 0, "no prompt is sent to any session")
    assert.ok(existsSync(join(h.dir, `${hash}.session`)), "the commit file stays in place")
  } finally {
    h.clean()
  }
})

test("a holder that stopped after its temporary file, before the link, is recovered into one prompted session", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const link = permalinkOf("C0PLATFORM", ts)
    const hash = permalinkHash(link)
    h.claims.claim(hash)
    const old = new Date(h.now() - STALE_MS - 60_000)
    utimesSync(join(h.dir, `${hash}.claim.0`), old, old)
    writeFileSync(join(h.dir, `${hash}.crash.tmp`), JSON.stringify({ sessionID: "ses_holder", permalink: link }))
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "recovery gave the hit one session")
    assert.equal(h.prompts.length, 1)
    assert.equal(h.items()[link].sessionID, h.prompts[0].sessionID)
  } finally {
    h.clean()
  }
})

test("the item record reads as waiting before the first prompt is sent", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    let atPrompt
    h.session.onPrompt = async () => {
      atPrompt = h.items()[permalinkOf("C0PLATFORM", ts)]
    }
    await h.watcher.poll()
    assert.ok(atPrompt, "the item record exists before the prompt")
    assert.equal(atPrompt.firstTurnFailed, true)
    assert.equal(atPrompt.firstTurnEndedAt, null)
    assert.equal(atPrompt.sessionID, h.created[0].id)
  } finally {
    h.clean()
  }
})

test("a holder that stopped after recording, before the prompt, keeps its record and prompts nothing", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    const link = permalinkOf("C0PLATFORM", ts)
    const hash = permalinkHash(link)
    const record = {
      permalink: link,
      workspace: "slack_nexar",
      channel: "#platform-help",
      channelID: "C0PLATFORM",
      ts,
      flaggedAt: new Date(h.now()).toISOString(),
      sessionID: "ses_holder",
      firstTurnFailed: true,
      firstTurnEndedAt: null,
      recordFormat: RECORD_FORMAT,
    }
    h.claims.claim(hash)
    await h.claims.commit(hash, { sessionID: "ses_holder", committedAt: new Date(h.now()).toISOString(), ...record })
    await h.storage.set(KEYS.items, { [link]: record })
    await h.storage.set(KEYS.seen, [link])

    await h.watcher.poll()
    h.clock.ms += STALE_MS + 60_000
    await h.watcher.poll()
    assert.equal(h.prompts.length, 0, "no prompt is sent to any session")
    assert.equal(h.created.length, 0, "no session is created")
    assert.equal(h.items()[link].firstTurnFailed, true, "the record still reads as waiting")
    assert.ok(existsSync(join(h.dir, `${hash}.session`)), "the commit file stays in place")
  } finally {
    h.clean()
  }
})

test("a prompt call that throws leaves the record as waiting and retries nothing", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    h.session.onPrompt = async () => {
      throw new Error("prompt refused")
    }
    await h.watcher.poll()
    const link = permalinkOf("C0PLATFORM", ts)
    assert.equal(h.created.length, 1)
    assert.equal(h.prompts.length, 0, "the failed prompt is not recorded as a prompt")
    assert.equal(h.items()[link].firstTurnFailed, true)
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the next poll creates no session")
    assert.equal(h.logs.length, 1, "the failure is logged once")
  } finally {
    h.clean()
  }
})

test("every storage key and every claims file sits under the item namespace", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    assert.ok(h.storage.map.size > 0, "the poll wrote state")
    for (const key of h.storage.map.keys()) {
      assert.ok(key.startsWith(`${NAMESPACE}/`), `storage key ${key} is under the namespace`)
    }
    const files = readdirSync(h.dir)
    assert.ok(files.length > 0, "the poll created claim files")
    assert.ok(h.dir.endsWith(join("claims", NAMESPACE)), "the claims directory is the namespace's")
    for (const name of files) assert.ok(name.startsWith(`${permalinkHash(permalinkOf("C0PLATFORM", ts))}.`))
  } finally {
    h.clean()
  }
})

test("the access token reaches the authorization header and nothing else the plugin produces", async () => {
  const secret = "xoxb-secret-token-1234"
  const ts = message(60)
  const h = harness({
    pages: { [secret]: [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] },
    credentials: { slack_nexar: { access: secret, expires: 0 } },
    servers: [NEXAR],
  })
  try {
    h.session.onPrompt = async () => {
      throw new Error("prompt refused")
    }
    await h.watcher.poll()
    const searches = h.calls.filter((call) => call.method === "tools/call")
    assert.equal(searches.length, 1, "the search ran")
    assert.equal(searches[0].headers.authorization, `Bearer ${secret}`, "the token is the bearer header")

    const produced = [
      JSON.stringify([...h.storage.map.entries()]),
      ...readdirSync(h.dir).map((name) => readFileSync(join(h.dir, name), "utf8")),
      ...h.prompts.map((prompt) => prompt.text),
      ...h.created.map((session) => session.title ?? ""),
      ...h.logs,
      ...h.consoleOutput,
      JSON.stringify(h.status()),
    ]
    for (const text of produced) assert.ok(!text.includes(secret), `the token is not in: ${text.slice(0, 120)}`)
  } finally {
    h.clean()
  }
})

test("an expired credential runs one refresh session, removes it, and retries the search once", async () => {
  const ts = message(60)
  const h = harness({
    pages: {
      "tok-stale": [page([], null)],
      "tok-fresh": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)],
    },
    credentials: { slack_nexar: { access: "tok-stale", expires: NOW - 60_000 } },
    servers: [NEXAR],
  })
  try {
    h.session.onPrompt = async ({ text }) => {
      if (text.includes("is:saved")) h.tokens.slack_nexar = { access: "tok-fresh", expires: NOW + 3_600_000 }
    }
    await h.watcher.poll()
    const refreshes = h.created.filter((session) => session.agent === REFRESH_AGENT)
    assert.equal(refreshes.length, 1, "one refresh session on the refresh agent")
    assert.ok(h.removed.includes(refreshes[0].id), "the refresh session is removed after it ends")
    assert.equal(h.toolCalls().filter((call) => call.token === "tok-fresh").length, 1, "the search is retried once")
    assert.equal(h.created.filter((session) => session.agent === DEFAULT_SESSION_AGENT).length, 1, "the hit got a session")
    assert.equal(h.status().outcome, "ok")
  } finally {
    h.clean()
  }
})

test("a refused credential suspends the workspace until the credential changes or pollNow runs", async () => {
  const h = harness({
    pages: {},
    statuses: { "tok-bad": { status: 401 } },
    credentials: { slack_nexar: { access: "tok-bad", expires: NOW + 3_600_000 } },
    servers: [NEXAR],
  })
  try {
    await h.watcher.poll()
    assert.equal(h.created.filter((session) => session.agent === REFRESH_AGENT).length, 1, "one refresh session")
    assert.equal(h.created.filter((session) => session.agent === DEFAULT_SESSION_AGENT).length, 0, "no item session")
    assert.deepEqual(
      h.status().workspaces,
      [{ name: "slack_nexar", ok: false, error: SUSPENDED_ERROR }],
      "the workspace reports the suspension",
    )

    for (let i = 0; i < 10; i += 1) {
      h.clock.ms += h.config.poll_seconds * 1000
      await h.watcher.poll()
    }
    assert.equal(h.created.filter((session) => session.agent === REFRESH_AGENT).length, 1, "no further refresh session")

    h.tokens.slack_nexar = { access: "tok-bad", expires: h.now() + 7_200_000 }
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.filter((session) => session.agent === REFRESH_AGENT).length, 2, "a changed credential tries once")

    await h.watcher.pollNow()
    assert.equal(h.created.filter((session) => session.agent === REFRESH_AGENT).length, 3, "pollNow tries once")
  } finally {
    h.clean()
  }
})

test("a rate-limited workspace ends that workspace's scan for the poll", async () => {
  const h = harness({ pages: {}, statuses: { "tok-nexar": { status: 429 } }, servers: [NEXAR, NAUTO] })
  try {
    await h.watcher.poll()
    const status = h.status()
    assert.equal(status.workspaces.find((workspace) => workspace.name === "slack_nexar").error, "rate limited")
    assert.equal(status.workspaces.find((workspace) => workspace.name === "slack_nauto").ok, true, "the other workspace ran")
    assert.equal(h.toolCalls().filter((call) => call.token === "tok-nexar").length, 0, "no further call for it")
  } finally {
    h.clean()
  }
})

test("a missing config field polls nothing and names the field in the status", async () => {
  const h = harness()
  try {
    const watcher = createWatcher({
      storage: h.storage,
      claims: h.claims,
      now: h.now,
      fetch: async () => respond(200, "{}"),
      readConfig: () => ({ error: "config field missing: intake_repo" }),
      mcpServers: async () => [NEXAR],
      resolveCredential: async () => ({ access: "tok-nexar", expires: 0 }),
      session: h.session,
    })
    await watcher.poll()
    assert.equal(h.status().configError, "config field missing: intake_repo")
    assert.equal(h.calls.length, 0, "nothing is called")
    assert.equal(h.created.length, 0)
  } finally {
    h.clean()
  }
})

test("two polls on separate storage objects over one namespace that win different hits keep both item records and both seen entries", async () => {
  const tsA = message(60)
  const tsB = message(120)
  const h = harness({
    servers: [NEXAR],
    pages: {
      "tok-nexar": (index, search) =>
        search % 2 === 0
          ? page([hitRow("C0AAAAAAAA", tsA, "#a")], null)
          : page([hitRow("C0BBBBBBBB", tsB, "#b")], null),
    },
  })
  try {
    const realGet = h.storage.get.bind(h.storage)
    let itemsReads = 0
    h.storage.get = async (key) => {
      const value = await realGet(key)
      if (key !== KEYS.items) return value
      itemsReads += 1
      // Hold the first read-modify-write of the item map open. Without one
      // writer at a time the other poll reads this same stale map inside the
      // window and one of the two records is lost.
      if (itemsReads === 1) await yieldTimes(20)
      return value
    }
    await Promise.all([h.newWatcher(h.facade()).poll(), h.newWatcher(h.facade()).poll()])
    assert.equal(h.prompts.length, 2, "both hits got a prompted session")
    const stored = Object.keys(h.items()).sort()
    assert.equal(stored.length, 2, "both item records survive")
    assert.deepEqual(h.seen().sort(), stored, "and both seen entries")
  } finally {
    h.clean()
  }
})

test("two concurrent polls of one instance run one scan and keep the item record", async () => {
  const ts = message(60)
  const link = permalinkOf("C0AAAAAAAA", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0AAAAAAAA", ts, "#a")], null)] } })
  try {
    const [first, second] = await Promise.all([h.watcher.poll(), h.watcher.poll()])
    assert.equal(h.toolCalls().length, 1, "the second poll joins the first's scan instead of searching again")
    assert.equal(h.created.length, 1, "one hit gets one session")
    assert.equal(h.prompts.length, 1)
    assert.deepEqual(Object.keys(h.items()), [link], "the item record is kept")
    assert.deepEqual(h.seen(), [link], "and the seen entry")
    assert.equal(first.status.lastPoll, second.status.lastPoll, "both callers see the one scan's status")
  } finally {
    h.clean()
  }
})

test("a workspace whose scan fails is reported, and the other workspace still runs", async () => {
  const h = harness({
    servers: [NEXAR, NAUTO],
    statuses: { "tok-nexar": { status: 503 } },
    pages: { "tok-nauto": [page([], null)] },
  })
  try {
    await h.watcher.poll()
    const status = h.status()
    const failed = status.workspaces.find((workspace) => workspace.name === "slack_nexar")
    assert.equal(failed.ok, false, "the failed workspace is not ok")
    assert.match(failed.error, /HTTP 503/, "the failure is named")
    assert.notEqual(status.outcome, "ok", "the poll's outcome is not a healthy empty scan")
    assert.equal(
      status.workspaces.find((workspace) => workspace.name === "slack_nauto").ok,
      true,
      "the other workspace ran",
    )
  } finally {
    h.clean()
  }
})

test("a failed MCP discovery is reported instead of an empty healthy scan", async () => {
  const h = harness({ servers: [NEXAR], serverError: new Error("discovery unavailable") })
  try {
    await h.watcher.poll()
    assert.match(h.status().outcome, /discovery unavailable/, "the status names the discovery failure")
    assert.notEqual(h.status().outcome, "ok")
    assert.equal(h.created.length, 0)
  } finally {
    h.clean()
  }
})

test("a workspace whose answer never arrives fails without stopping future polls", async () => {
  const h = harness({
    servers: [NEXAR, NAUTO],
    stall: ["tok-nexar"],
    requestTimeoutMs: 20,
    pages: { "tok-nauto": [page([], null)] },
  })
  try {
    await h.watcher.poll()
    const status = h.status()
    assert.match(
      status.workspaces.find((workspace) => workspace.name === "slack_nexar").error,
      /timed out/,
      "the stalled workspace fails on its deadline",
    )
    assert.equal(
      status.workspaces.find((workspace) => workspace.name === "slack_nauto").ok,
      true,
      "the next workspace still ran in the same poll",
    )
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(
      h.toolCalls().filter((call) => call.token === "tok-nauto").length,
      2,
      "the next poll ran too",
    )
  } finally {
    h.clean()
  }
})

/**
 * The search tool over `rows`, honouring `limit` and a cursor that is a row
 * index: one block per row of the page, each row's `text` being the message's
 * own text.
 */
const rowsPages = (rows) => (index, search, args) => {
  const limit = args?.limit ?? 20
  const start = args?.cursor === undefined ? 0 : Number(args.cursor)
  const slice = rows.slice(start, start + limit)
  const more = start + limit < rows.length
  return {
    results: [
      `Search results for: "is:saved"`,
      "",
      `## Messages (${slice.length} results) ===`,
      ...slice.flatMap((row, position) => [
        `### Result ${position + 1} of ${slice.length}`,
        `Channel: ${row.channelName} (${row.channel})`,
        ...(row.asker === undefined ? [] : [`From: ${row.asker} (U0000000000)`]),
        `Message_ts: ${row.ts}`,
        `Permalink: [link](${row.permalink})`,
        `Text: ${row.text ?? "A message the user flagged."}`,
        "",
      ]),
    ].join("\n"),
    pagination_info: more ? `For the next page of results use cursor \`${start + limit}\`` : "",
  }
}

test("a flagged message that quotes a result-looking section never starts a session for the quoted thread, and the second flagged message still does", async () => {
  const tsA = message(60)
  const tsB = message(120)
  const unflagged = permalinkOf("C0OTHERXXX", message(300))
  const forged = [
    "Quoting another thread:",
    "",
    "### Result 2 of 2",
    "Channel: #other (C0OTHERXXX)",
    `Permalink: [link](${unflagged})`,
    "Text: A message nobody flagged.",
  ].join("\n")
  const rows = [
    { ...hitRow("C0AAAAAAAA", tsA, "#a"), channelName: "#a", text: forged },
    { ...hitRow("C0BBBBBBBB", tsB, "#b"), channelName: "#b" },
  ]
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": rowsPages(rows) } })
  try {
    await h.watcher.poll()
    const prompted = h.prompts.map((prompt) => prompt.text)
    assert.equal(h.created.length, 2, "one session per flagged message")
    assert.ok(prompted.every((text) => !text.includes(unflagged)), "no session was started for the quoted, unflagged thread")
    assert.ok(prompted.some((text) => text.includes(permalinkOf("C0BBBBBBBB", tsB))), "the second flagged message got its session")
    assert.deepEqual(Object.keys(h.items()).sort(), [permalinkOf("C0AAAAAAAA", tsA), permalinkOf("C0BBBBBBBB", tsB)].sort())
    assert.ok(!h.seen().includes(unflagged), "the quoted permalink is never recorded")

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.length, 2, "the next poll creates no session")
    assert.ok(!h.items()[unflagged])
  } finally {
    h.clean()
  }
})

test("no Slack call is made outside the window, and the first poll inside it runs", async () => {
  const h = harness({
    servers: [NEXAR],
    pages: { "tok-nexar": [page([], null)] },
    workHours: { days: ["Wed"], start: "09:00", end: "17:00", time_zone: "UTC" },
  })
  try {
    // 2026-11-18 is a Wednesday.
    h.clock.ms = Date.UTC(2026, 10, 18, 8, 30)
    await h.watcher.poll()
    assert.equal(h.calls.length, 0, "no call at all before the window opens")
    assert.deepEqual(h.status(), {}, "and no status is written")

    h.clock.ms = Date.UTC(2026, 10, 18, 16, 59)
    await h.watcher.poll()
    assert.equal(h.toolCalls().length, 1, "one search inside the window")
    assert.equal(h.status().outcome, "ok")

    h.clock.ms = Date.UTC(2026, 10, 18, 17, 0)
    await h.watcher.poll()
    assert.equal(h.toolCalls().length, 1, "the end of the window is already outside it")

    h.clock.ms = Date.UTC(2026, 10, 21, 12, 0)
    await h.watcher.poll()
    assert.equal(h.toolCalls().length, 1, "a Saturday is outside a Monday-to-Friday window")
  } finally {
    h.clean()
  }
})

test("a flag made while the plugin was stopped gets its session at the first poll of the next instance", async () => {
  const ts = message(7 * 24 * 60 * 60)
  const h = harness({
    servers: [NEXAR],
    pages: {
      "tok-nexar": (index, search) => (search === 0 ? page([], null) : page([hitRow("C0PLATFORM", ts, "#platform-help")], null)),
    },
  })
  try {
    await h.watcher.poll()
    assert.equal(h.created.length, 0, "the first instance finds nothing flagged")

    // The plugin stops, the message is flagged, and OpenCode starts again: the
    // scan has no time window, so the older message is found by the next start.
    h.clock.ms += 2 * 60_000
    const restarted = h.newWatcher()
    await restarted.start()
    await restarted.poll()
    assert.equal(h.created.length, 1, "the next instance creates its session")
    assert.equal(h.prompts.length, 1)
    assert.ok(h.prompts[0].text.includes("`slack-director` skill"), "with the full first prompt")
  } finally {
    h.clean()
  }
})

test("an instance started outside the window creates the session at the first poll once the window opens", async () => {
  const ts = message(120)
  const h = harness({
    servers: [NEXAR],
    pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] },
    workHours: { days: ["Wed"], start: "09:00", end: "17:00", time_zone: "UTC" },
  })
  try {
    h.clock.ms = Date.UTC(2026, 10, 18, 7, 0)
    const started = h.newWatcher()
    await started.start()
    await started.poll()
    assert.equal(h.created.length, 0, "nothing is created outside the window")

    h.clock.ms = Date.UTC(2026, 10, 18, 9, 1)
    await started.poll()
    assert.equal(h.created.length, 1, "the first poll inside the window creates it")
    assert.equal(h.prompts.length, 1)
  } finally {
    h.clean()
  }
})

test("a reply with the two fixed lines fills the item record and retitles the session", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const issue = "https://github.com/empiric-earth/almeida-slack-intake/issues/41"
  const h = harness({
    servers: [NEXAR],
    pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help", undefined, "Maria Costa")], null)] },
  })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    assert.equal(h.created[0].title, "Flagged message in #platform-help — Maria Costa", "the neutral label")
    const fresh = h.items()[link]
    assert.equal(fresh.asker, "Maria Costa")
    assert.equal(fresh.title, "Flagged message in #platform-help — Maria Costa")
    assert.equal(fresh.firstTurnFailed, true)
    assert.equal(fresh.firstTurnEndedAt, null)
    assert.equal(fresh.issueNumber, null)
    assert.equal(fresh.issueUrl, null)
    assert.equal(fresh.permissionPending, false)
    assert.equal(fresh.openedAt, null)

    h.changes.length = 0
    h.contexts.set(sessionID, [
      { type: "user", text: "A Slack message was flagged for triage." },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "Thinking about the thread." },
          { type: "text", text: `Findings and proposed next steps.\n\nIntake issue: ${issue}\nTitle: Access to the staging dashboards` },
        ],
      },
    ])
    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID } })

    const stored = h.items()[link]
    assert.equal(stored.issueUrl, issue)
    assert.equal(stored.issueNumber, 41)
    assert.equal(stored.title, "Access to the staging dashboards")
    assert.equal(stored.firstTurnFailed, false)
    assert.equal(typeof stored.firstTurnEndedAt, "string")
    assert.deepEqual(h.retitles, [{ sessionID, title: "Access to the staging dashboards" }], "the session is retitled")
    assert.ok(h.changes.length > 0, "the change notice fired for the item change")

    const projected = (await h.watcher.items()).items
    assert.equal(projected.length, 1)
    assert.equal(
      schemaProblem(SlackDirectorRpc.methods.items.output.properties.items.items, projected[0]),
      undefined,
      "the record is what the contract serves",
    )

    // The completion reaches the status at once, before any further scan.
    const live = await h.watcher.status()
    assert.equal(live.today.nextStepsPosted, 1, "today's count includes it with no further poll")
    assert.equal(live.today.flagged, 1)

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.status().today.skipped, 1, "the poll that met the seen hit counts one skip")
  } finally {
    h.clean()
  }
})

test("today's skipped count names each already-seen hit once, however many polls meet it", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    assert.equal(h.status().today.skipped, 0, "the poll that claimed the hit skipped nothing")
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.status().today.skipped, 1, "the hit is skipped once")
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.status().today.skipped, 1, "the same hit on a third poll does not raise the count")
    assert.deepEqual(Object.keys(h.items()), [link], "and the item map still holds the one item")
  } finally {
    h.clean()
  }
})

test("the status reflects a completed first turn at once, with no poll", async () => {
  const ts = message(60)
  const issue = "https://github.com/empiric-earth/almeida-slack-intake/issues/41"
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    h.contexts.set(sessionID, [
      { type: "assistant", content: [{ type: "text", text: `Findings.\n\nIntake issue: ${issue}\nTitle: Access to the staging dashboards` }] },
    ])
    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID } })

    // No scan runs between the completion and this read: the count is computed
    // from the item map, not left at the last scan's snapshot.
    const status = await h.watcher.status()
    assert.equal(status.today.nextStepsPosted, 1, "the completion is counted at once")
    assert.equal(status.today.flagged, 1)
  } finally {
    h.clean()
  }
})

test("today's counts follow the calendar day, not the last scan", async () => {
  const ts = message(60)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    assert.equal((await h.watcher.status()).today.flagged, 1, "the flag is today's")
    // The next calendar day, with no scan: the previous day's flag is not
    // today's, and the skipped set starts over.
    h.clock.ms = Date.UTC(2026, 10, 19, 12, 0)
    const next = await h.watcher.status()
    assert.equal(next.today.flagged, 0, "yesterday's flag is not today's")
    assert.equal(next.today.nextStepsPosted, 0)
    assert.equal(next.today.skipped, 0, "the skipped set is the new day's")
  } finally {
    h.clean()
  }
})

test("overlapping pollNow calls share one scan", async () => {
  let release
  const hold = new Promise((resolve) => {
    release = resolve
  })
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([], null)] }, fetchHold: hold })
  try {
    const pending = Array.from({ length: 10 }, () => h.watcher.pollNow())
    await yieldTimes(100)
    assert.equal(
      h.calls.filter((call) => call.method === "initialize").length,
      1,
      "ten overlapping requests start one scan, not ten",
    )
    release()
    await Promise.all(pending)
    assert.equal(h.toolCalls().length, 1, "the one workspace is searched once")
    assert.equal(h.created.length, 0)
  } finally {
    h.clean()
  }
})

test("an errorless reply that names no issue leaves the item waiting", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    const before = structuredClone(h.items()[link])
    assert.equal(before.firstTurnFailed, true, "the record is written pessimistic")
    h.contexts.set(sessionID, [
      {
        type: "assistant",
        content: [{ type: "text", text: "Intake issue: none — customer data\nTitle: A customer's export question" }],
      },
    ])
    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID } })

    assert.deepEqual(h.items()[link], before, "an errorless end whose reply names no issue leaves the record alone")
    assert.equal(h.items()[link].firstTurnFailed, true, "the item still reads as waiting")
    assert.equal(h.items()[link].firstTurnEndedAt, null)
    assert.equal(h.items()[link].issueUrl, null)
    assert.deepEqual(h.retitles, [], "no session is retitled")

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.status().today.nextStepsPosted, 0, "a reply that names no issue is not a next-steps post")
    assert.equal(h.status().today.flagged, 1)
  } finally {
    h.clean()
  }
})

test("a first turn that ends in error leaves the item waiting", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    h.contexts.set(sessionID, [
      { type: "assistant", content: [{ type: "text", text: "Intake issue: https://github.com/x/y/issues/1\nTitle: Half a reply" }] },
    ])
    for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
      await h.watcher.observe({ type, data: { sessionID } })
      assert.equal(h.items()[link].firstTurnFailed, true, `${type} leaves the item waiting`)
      assert.equal(h.items()[link].firstTurnEndedAt, null, `${type} records no end`)
    }
    assert.deepEqual(h.retitles, [], "no session is retitled")
    assert.equal(h.items()[link].issueUrl, null, "no issue is read off a failed turn")
  } finally {
    h.clean()
  }
})

test("a later turn does not complete the first turn", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const issue = "https://github.com/empiric-earth/almeida-slack-intake/issues/41"
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    const neutral = h.created[0].title
    // The first turn ends in error: the item stays waiting.
    await h.watcher.observe({ type: "session.execution.failed", data: { sessionID } })
    assert.equal(h.items()[link].firstTurnFailed, true)

    // A later turn in the same session ends well, with its own reply. It is not
    // the first turn, so it neither clears the flag nor supplies the item's
    // issue and title.
    h.contexts.set(sessionID, [
      { type: "assistant", content: [{ type: "text", text: `Later work.\n\nIntake issue: ${issue}\nTitle: Later turn` }] },
    ])
    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID } })
    assert.equal(h.items()[link].firstTurnFailed, true, "a later turn does not clear the pessimistic flag")
    assert.equal(h.items()[link].firstTurnEndedAt, null, "and records no first-turn end")
    assert.equal(h.items()[link].title, neutral, "the title stays the neutral label")
    assert.equal(h.items()[link].issueUrl, null, "no later issue is recorded")
    assert.deepEqual(h.retitles, [], "no session is retitled")
  } finally {
    h.clean()
  }
})

test("a first turn no instance saw end stays waiting after a restart, and nothing is prompted or created", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    assert.equal(h.items()[link].firstTurnFailed, true, "the record is written pessimistic")

    // The process stops while the first turn runs, and OpenCode starts again on
    // the same storage: the new instance never saw that turn end.
    h.clock.ms += 5 * 60_000
    const restarted = h.newWatcher()
    await restarted.start()
    await restarted.poll()

    assert.equal(h.items()[link].firstTurnFailed, true, "the interrupted turn keeps reading as waiting")
    assert.equal(h.items()[link].firstTurnEndedAt, null)
    assert.equal(h.items()[link].sessionID, sessionID, "the record keeps the committed session")
    assert.equal(h.created.length, 1, "no session is created")
    assert.equal(h.prompts.length, 1, "no session is prompted")

    // The new instance never saw this session's first turn start, so a turn-end
    // event it receives belongs to a later turn, not the first: the item stays
    // waiting rather than let a later reply complete it.
    h.contexts.set(sessionID, [
      { type: "assistant", content: [{ type: "text", text: "Intake issue: none — unreadable\nTitle: Never paraphrased" }] },
    ])
    await restarted.observe({ type: "session.execution.succeeded", data: { sessionID } })
    assert.equal(h.items()[link].firstTurnFailed, true, "a new instance does not complete a first turn it did not start")
    assert.equal(h.items()[link].firstTurnEndedAt, null)
    assert.deepEqual(h.retitles, [], "no session is retitled")
  } finally {
    h.clean()
  }
})

test("a pending permission request is recorded on the item, and its reply clears it", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    await h.watcher.observe({ type: "permission.asked", data: { id: "per_1", sessionID, action: "sparta_exec" } })
    assert.equal(h.items()[link].permissionPending, true)
    await h.watcher.observe({ type: "permission.replied", data: { sessionID, requestID: "per_1", reply: "once" } })
    assert.equal(h.items()[link].permissionPending, false)

    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID: "ses_not_ours" } })
    await h.watcher.observe({ type: "permission.asked", data: { id: "per_2" } })
    assert.equal(h.items()[link].permissionPending, false, "another session's events change nothing")
  } finally {
    h.clean()
  }
})

test("the item map can be marked as opened", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    assert.deepEqual(await h.watcher.markOpened({ sessionID }), {}, "the call answers with an empty object")
    assert.equal(h.items()[link].openedAt, new Date(h.now()).toISOString())
    assert.deepEqual(await h.watcher.markOpened({ sessionID: "ses_not_ours" }), {})
  } finally {
    h.clean()
  }
})

test("no item record, status value or config field holds the token or a message's text", async () => {  const secret = "xoxb-secret-token-1234"
  const ts = message(60)
  const h = harness({
    servers: [NEXAR],
    pages: { [secret]: [page([hitRow("C0PLATFORM", ts, "#platform-help", undefined, "Maria Costa")], null)] },
    credentials: { slack_nexar: { access: secret, expires: 0 } },
  })
  try {
    await h.watcher.poll()
    const produced = [
      JSON.stringify(h.items()),
      JSON.stringify(h.status()),
      JSON.stringify(await h.watcher.items()),
      JSON.stringify(await h.watcher.getConfig()),
      JSON.stringify(h.config),
    ]
    for (const text of produced) {
      assert.ok(!text.includes(secret), `the token is not in: ${text.slice(0, 160)}`)
      assert.ok(!text.includes("A message the user flagged."), "no message text is stored")
      assert.ok(!text.includes("An earlier message in the same channel."), "no context text is stored")
    }
    assert.ok(JSON.stringify(h.items()).includes("Maria Costa"), "the asker's own display name is kept")
  } finally {
    h.clean()
  }
})

test("the watcher acts on the turn-end and permission events, and on no other", async () => {
  const ts = message(60)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    assert.deepEqual(SESSION_EVENT_TYPES, [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "permission.asked",
      "permission.replied",
    ])
    await h.watcher.poll()
    const sessionID = h.created[0].id
    const before = JSON.stringify(h.items())
    // `session.idle` is in the schema but is never published, and the rest of
    // the stream says nothing about a turn's end.
    for (const type of ["session.idle", "session.status", "session.text.delta", "session.step.ended", "session.step.failed"]) {
      await h.watcher.observe({ type, data: { sessionID } })
    }
    assert.equal(JSON.stringify(h.items()), before, "no other event type changes an item")
  } finally {
    h.clean()
  }
})

test("the dialog serves an earlier build's records, and the record's internal form stays out of the answer", async () => {
  const tsA = message(60)
  const tsB = message(120)
  const linkA = permalinkOf("C0PLATFORM", tsA)
  const linkB = permalinkOf("C0PLATFORM", tsB)
  const issue = "https://github.com/empiric-earth/almeida-slack-intake/issues/41"
  const h = harness({
    servers: [NEXAR],
    pages: { "tok-nexar": rowsPages([hitRow("C0PLATFORM", tsA, "#platform-help")]) },
  })
  try {
    const flaggedAt = new Date(h.now()).toISOString()
    // An earlier build's record that already has its issue, and one held by a
    // permission request: neither is a reissue candidate, so its row is the
    // only way the user reaches the session it holds.
    const records = {
      [linkA]: earlierRecord({ link: linkA, ts: tsA, sessionID: "ses_old_a", flaggedAt, issueUrl: issue, issueNumber: 41 }),
      [linkB]: earlierRecord({ link: linkB, ts: tsB, sessionID: "ses_old_b", flaggedAt, permissionPending: true }),
    }
    h.setItems(structuredClone(records))
    h.setSeen([linkA, linkB])
    h.sessions.set("ses_old_a", { time: quietTimes(h.now()) })
    h.sessions.set("ses_old_b", { time: quietTimes(h.now()) })

    const served = (await h.watcher.items()).items
    assert.deepEqual(
      served.map((record) => record.permalink).sort(),
      [linkA, linkB].sort(),
      "both earlier records are served, so their rows are in the dialog",
    )
    for (const item of served) {
      assert.ok(!("recordFormat" in item), "the record's internal form stays out of the answer")
    }
    const held = served.find((item) => item.permalink === linkB)
    assert.equal(held.permissionPending, true, "a held record reads as waiting")
    assert.equal(held.issueUrl, null, "and shows no issue yet")

    await h.watcher.poll()

    assert.equal(h.created.length, 0, "neither record is reissued: one has its issue, the other is held")
    assert.deepEqual(h.items(), records, "and both records are left as they are")
  } finally {
    h.clean()
  }
})

test("a poll reissues one still-flagged record an earlier build left with no issue, once", async () => {
  const tsA = message(60)
  const tsB = message(120)
  const tsC = message(180)
  const tsD = message(240)
  const linkA = permalinkOf("C0PLATFORM", tsA)
  const linkB = permalinkOf("C0PLATFORM", tsB)
  const linkC = permalinkOf("C0PLATFORM", tsC)
  const linkD = permalinkOf("C0PLATFORM", tsD)
  const issue = "https://github.com/empiric-earth/almeida-slack-intake/issues/41"
  const h = harness({
    servers: [NEXAR],
    pages: {
      "tok-nexar": rowsPages([
        hitRow("C0PLATFORM", tsC, "#platform-help"),
        hitRow("C0PLATFORM", tsA, "#platform-help", undefined, "Maria Costa"),
        hitRow("C0PLATFORM", tsD, "#platform-help"),
      ]),
    },
  })
  try {
    const flaggedAt = new Date(h.now()).toISOString()
    const records = {
      // An earlier build's record carries no asker; the search result has it.
      [linkA]: { ...earlierRecord({ link: linkA, ts: tsA, sessionID: "ses_old_a", flaggedAt }), asker: "" },
      [linkB]: earlierRecord({ link: linkB, ts: tsB, sessionID: "ses_old_b", flaggedAt }),
      [linkC]: earlierRecord({ link: linkC, ts: tsC, sessionID: "ses_old_c", flaggedAt, issueUrl: issue, issueNumber: 41 }),
      [linkD]: {
        ...earlierRecord({ link: linkD, ts: tsD, sessionID: "ses_old_d", flaggedAt }),
        recordFormat: RECORD_FORMAT,
      },
    }
    h.setItems(structuredClone(records))
    h.setSeen([linkA, linkB, linkC, linkD])
    // Every earlier session is quiet: idle, and unchanged for longer than the
    // stale age.
    for (const id of ["ses_old_a", "ses_old_b", "ses_old_c", "ses_old_d"]) {
      h.sessions.set(id, { time: quietTimes(h.now()) })
    }
    const served = (await h.watcher.items()).items
    assert.deepEqual(
      served.map((record) => record.permalink).sort(),
      [linkA, linkB, linkC, linkD].sort(),
      "every item record is served, an earlier build's rows included",
    )
    for (const item of served) {
      assert.ok(!("recordFormat" in item), "the record's internal form stays out of the answer")
    }

    await h.watcher.poll()

    assert.equal(h.created.length, 1, "one new session, for the still-flagged issue-less record alone")
    const created = h.created[0]
    assert.equal(created.agent, DEFAULT_SESSION_AGENT, "on the configured session agent")
    assert.equal(created.title, records[linkA].title, "the record's own title")
    assert.equal(h.prompts.length, 1, "one first prompt")
    assert.equal(h.prompts[0].sessionID, created.id)
    const prompt = h.prompts[0].text
    assert.ok(prompt.includes(linkA), "the prompt carries the record's permalink")
    assert.ok(prompt.includes("slack_nexar"), "the record's workspace")
    assert.ok(prompt.includes("#platform-help"), "the record's channel label")
    assert.ok(prompt.includes(tsA), "the record's message ts")
    assert.ok(prompt.includes(h.config.intake_repo), "the intake repo")

    const stored = h.items()[linkA]
    assert.equal(stored.permalink, linkA, "the record keeps its key")
    assert.equal(stored.sessionID, created.id, "and takes the new session id")
    assert.equal(stored.firstTurnFailed, true, "and reads as waiting")
    assert.equal(stored.recordFormat, RECORD_FORMAT, "and takes this build's record form")
    assert.equal(stored.asker, "Maria Costa", "and takes the asker the search reported, which the earlier record left out")
    assert.equal(stored.flaggedAt, records[linkA].flaggedAt, "every other field is kept")
    assert.equal(stored.title, records[linkA].title)

    assert.deepEqual(h.items()[linkB], records[linkB], "the no-longer-flagged record is unchanged")
    assert.deepEqual(h.items()[linkC], records[linkC], "the record with an issue is unchanged")
    assert.deepEqual(h.items()[linkD], records[linkD], "this build's own record is unchanged")
    assert.deepEqual(
      [...h.seen()].sort(),
      [linkA, linkB, linkC, linkD].sort(),
      "the seen-set still holds every seeded permalink",
    )
    assert.equal(h.status().today.skipped, 2, "the two seen hits are counted, and the reissued one is not")
    assert.ok(
      h.toolCalls().some((call) => call.args.limit === 1),
      "the reissued permalink is established as the tool's own result, one result per call, like a new hit",
    )

    // The reply's issue and title are then recorded, like any first turn's.
    const replyIssue = "https://github.com/empiric-earth/almeida-slack-intake/issues/42"
    h.contexts.set(created.id, [
      {
        type: "assistant",
        content: [{ type: "text", text: `Findings and next steps.\n\nIntake issue: ${replyIssue}\nTitle: The reissued paraphrase` }],
      },
    ])
    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID: created.id } })
    assert.equal(h.items()[linkA].issueUrl, replyIssue, "the reply's issue is recorded")
    assert.equal(h.items()[linkA].issueNumber, 42)
    assert.equal(h.items()[linkA].title, "The reissued paraphrase", "and the reply's title")
    assert.equal(h.items()[linkA].firstTurnFailed, false)
    assert.deepEqual(h.retitles, [{ sessionID: created.id, title: "The reissued paraphrase" }])

    // A second poll, and a second watcher on the same storage and claims, create
    // no further session: a committed reissue refuses every later claim.
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    const second = h.newWatcher()
    await second.poll()
    assert.equal(h.created.length, 1, "no record gets a second session")
    assert.equal(h.prompts.length, 1, "and no record gets a second prompt")
  } finally {
    h.clean()
  }
})

test("two watchers racing one reissue give the record one session, once", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const hash = permalinkHash(link)
  const flaggedAt = new Date(NOW).toISOString()
  const pages = { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] }

  // The first watcher is held at its session create until the second watcher's
  // poll has run, so both pass the handoff check before either replaces the
  // record. Its claim is fresh, so the second watcher may start no session.
  {
    const h = harness({ servers: [NEXAR], pages })
    try {
      const record = earlierRecord({ link, ts, sessionID: "ses_old", flaggedAt })
      h.setItems({ [link]: record })
      h.setSeen([link])
      h.sessions.set("ses_old", { time: quietTimes(h.now()) })
      let release
      let creates = 0
      h.session.onCreate = async () => {
        creates += 1
        if (creates === 1) await new Promise((resolve) => (release = resolve))
      }
      const first = h.watcher.poll()
      await waitFor(() => release !== undefined, "the first watcher to reach its session create")
      // The lease is over, so the second watcher polls; the claim is not stale.
      h.clock.ms += LEASE_MS + 1_000
      await h.newWatcher().poll()
      assert.equal(creates, 1, "the fresh claim holds the record to one session create")
      release()
      await first
      assert.equal(h.created.length, 1, "one session is created for the record")
      assert.equal(h.prompts.length, 1, "and one first prompt")
      const winner = h.prompts[0].sessionID
      assert.equal(h.items()[link].sessionID, winner, "the record names the session that was prompted")
    } finally {
      h.clean()
    }
  }

  // The first watcher is held after its create, before its commit, and its
  // claim is aged past the stale age: the second watcher takes the next
  // generation and replaces the record; the first watcher's commit is refused.
  {
    const h = harness({ servers: [NEXAR], pages })
    try {
      const record = earlierRecord({ link, ts, sessionID: "ses_old", flaggedAt })
      h.setItems({ [link]: record })
      h.setSeen([link])
      h.sessions.set("ses_old", { time: quietTimes(h.now()) })
      const realCommit = h.reissue.commit
      let release
      let commits = 0
      h.reissue.commit = async (claimHash, value) => {
        commits += 1
        if (commits === 1) await new Promise((resolve) => (release = resolve))
        return realCommit(claimHash, value)
      }
      const first = h.watcher.poll()
      await waitFor(() => release !== undefined, "the first watcher to reach its reissue commit")
      h.clock.ms += STALE_MS + 60_000
      await h.newWatcher().poll()
      assert.equal(h.prompts.length, 1, "the second watcher prompted one session")
      const winner = h.prompts[0].sessionID
      release()
      await first
      assert.equal(h.prompts.length, 1, "the held watcher prompted nothing")
      const loser = h.created.find((session) => session.id !== winner)
      assert.ok(h.removed.includes(loser.id), "the held watcher removed its own session")
      assert.equal(h.items()[link].sessionID, winner, "the record names the second watcher's session")
      assert.ok(existsSync(join(h.reissueDir, `${hash}.claim.1`)), "the second watcher took the next generation")
    } finally {
      h.clean()
    }
  }
})

test("the handoff holds a record whose earlier session may still be writing", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const sessionID = "ses_old"
  const pages = { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] }
  const cases = [
    {
      name: "a busy period that has not ended",
      seed: (now) => ({ time: { busy: now - 60_000, updated: now - 20 * 60_000 } }),
      reason: /busy period/,
    },
    {
      name: "a change inside the stale age",
      seed: (now) => ({ time: { busy: now - 3_600_000, idle: now - 3_500_000, updated: now - 60_000 } }),
      reason: /changed \d+ s ago/,
    },
    {
      name: "a read that fails for another reason",
      seed: () => ({ error: new Error("the session store is unavailable") }),
      reason: /was not read/,
    },
    {
      name: "a pending permission",
      seed: (now) => ({ time: quietTimes(now) }),
      reason: /permission request is pending/,
      permissionPending: true,
    },
  ]

  for (const item of cases) {
    const h = harness({ servers: [NEXAR], pages })
    try {
      const record = earlierRecord({
        link,
        ts,
        sessionID,
        flaggedAt: new Date(h.now()).toISOString(),
        permissionPending: item.permissionPending === true,
      })
      h.setItems({ [link]: record })
      h.setSeen([link])
      h.sessions.set(sessionID, item.seed(h.now()))

      await h.watcher.poll()
      assert.equal(h.created.length, 0, `${item.name}: no session is created`)
      assert.equal(h.prompts.length, 0, `${item.name}: no prompt is sent`)
      assert.deepEqual(h.items()[link], record, `${item.name}: the record is unchanged`)
      assert.equal(h.items()[link].firstTurnFailed, true, `${item.name}: the item still reads as waiting`)
      assert.ok(
        h.logs.some((line) => line.includes(sessionID) && item.reason.test(line)),
        `${item.name}: the poll logs the session id and the reason, got ${JSON.stringify(h.logs)}`,
      )
      h.clock.ms += h.config.poll_seconds * 1000
      await h.watcher.poll()
      assert.equal(h.created.length, 0, `${item.name}: the next poll still creates none`)
    } finally {
      h.clean()
    }
  }

  // The earlier session is quiet at last: the next poll reissues it exactly once.
  const h = harness({ servers: [NEXAR], pages })
  try {
    const record = earlierRecord({ link, ts, sessionID, flaggedAt: new Date(h.now()).toISOString() })
    h.setItems({ [link]: record })
    h.setSeen([link])
    h.sessions.set(sessionID, { time: { busy: h.now() - 60_000, updated: h.now() - 20 * 60_000 } })
    await h.watcher.poll()
    assert.equal(h.created.length, 0, "the in-flight session holds the record")
    h.clock.ms += 10 * 60_000
    h.sessions.set(sessionID, { time: quietTimes(h.now()) })
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "the quiet session lets the record be reissued")
    assert.equal(h.prompts.length, 1, "and prompted once")
    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.created.length, 1, "no second session for the same record")
  } finally {
    h.clean()
  }
})

test("a poll reconciles a reissue commit whose holder stopped before the replacement", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const hash = permalinkHash(link)
  const flaggedAt = new Date(NOW).toISOString()
  const pages = { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] }

  // (a) the crash between the reissue commit and the record replacement.
  {
    const h = harness({ servers: [NEXAR], pages })
    try {
      const record = earlierRecord({ link, ts, sessionID: "ses_old", flaggedAt })
      h.setItems({ [link]: record })
      h.setSeen([link])
      h.reissue.claim(hash)
      await h.reissue.commit(hash, { ...record, sessionID: "ses_new", committedAt: flaggedAt, replaces: "ses_old" })
      ageReissue(h, hash)

      await h.watcher.poll()
      const stored = h.items()[link]
      assert.equal(stored.sessionID, "ses_new", "the record takes the commit's session id")
      assert.equal(stored.firstTurnFailed, true, "and reads as waiting")
      assert.equal(stored.recordFormat, RECORD_FORMAT, "and takes this build's record form")
      const { sessionID: ignored, firstTurnFailed: ignoredToo, recordFormat: ignoredAsWell, ...rest } = stored
      const { sessionID: was, firstTurnFailed: wasFailed, recordFormat: wasFormat, ...before } = record
      assert.deepEqual(rest, before, "every other field is kept")
      assert.equal(h.created.length, 0, "no session is created")
      assert.equal(h.prompts.length, 0, "and no prompt is sent")

      h.clock.ms += h.config.poll_seconds * 1000
      await h.watcher.poll()
      assert.equal(h.created.length, 0, "a later poll creates no session either")
    } finally {
      h.clean()
    }
  }

  // (b) a replacement that succeeded: the record is this build's own and names
  // the commit's session, so the reconciliation leaves it alone.
  {
    const h = harness({ servers: [NEXAR], pages })
    try {
      const issue = "https://github.com/empiric-earth/almeida-slack-intake/issues/41"
      const record = {
        ...earlierRecord({ link, ts, sessionID: "ses_new", flaggedAt, issueUrl: issue, issueNumber: 41 }),
        firstTurnFailed: false,
        recordFormat: RECORD_FORMAT,
      }
      h.setItems({ [link]: record })
      h.setSeen([link])
      h.reissue.claim(hash)
      await h.reissue.commit(hash, { ...record, committedAt: flaggedAt, replaces: "ses_old" })
      ageReissue(h, hash)

      await h.watcher.poll()
      assert.deepEqual(h.items()[link], record, "the replaced record is unchanged, field for field")
      assert.equal(h.created.length, 0, "no session is created")
      assert.equal(h.prompts.length, 0, "and no prompt is sent")
      h.clock.ms += h.config.poll_seconds * 1000
      await h.watcher.poll()
      assert.equal(h.created.length, 0, "a later poll creates no session either")
    } finally {
      h.clean()
    }
  }

  // (c) a reissue in progress: a claim and a commit inside the stale age, and
  // the record still in the earlier build's form with the replaced session id.
  {
    const h = harness({ servers: [NEXAR], pages })
    try {
      const record = earlierRecord({ link, ts, sessionID: "ses_old", flaggedAt })
      h.setItems({ [link]: record })
      h.setSeen([link])
      h.sessions.set("ses_old", { time: quietTimes(h.now()) })
      h.reissue.claim(hash)
      await h.reissue.commit(hash, { ...record, sessionID: "ses_new", committedAt: flaggedAt, replaces: "ses_old" })

      await h.watcher.poll()
      assert.deepEqual(h.items()[link], record, "the record of a reissue in progress is unchanged")
      assert.equal(h.created.length, 0, "no session is created")
      assert.equal(h.prompts.length, 0, "and no prompt is sent")
      h.clock.ms += h.config.poll_seconds * 1000
      await h.watcher.poll()
      assert.equal(h.created.length, 0, "a later poll creates no session either")
    } finally {
      h.clean()
    }
  }
})
