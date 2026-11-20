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
import { DEFAULT_TRIAGE_AGENT, fieldProblem } from "../src/config.js"
import { SEARCH_TOOL, SLACK_MCP_URL } from "../src/slack-mcp.js"
import { claimsDir, KEYS, NAMESPACE } from "../src/state.js"
import { createWatcher, LEASE_MS, REFRESH_AGENT, SESSION_EVENT_TYPES, SUSPENDED_ERROR } from "../src/watcher.js"
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
    `Search results for: "hasmy::oc:"`,
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
  emoji = "oc",
  credentials,
  stall = [],
  serverError,
  requestTimeoutMs,
  workHours = ALL_DAY,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "slack-director-watcher-"))
  const stateHome = join(root, "state")
  const dir = claimsDir({ XDG_STATE_HOME: stateHome })
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
  const changes = []
  const configWrites = []
  const tokens = credentials ?? { slack_nexar: { access: "tok-nexar", expires: 0 }, slack_nauto: { access: "tok-nauto", expires: 0 } }
  const config = {
    flag_emoji: emoji,
    intake_repo: "empiric-earth/almeida-slack-intake",
    session_directory: join(root, "session-directory"),
    poll_seconds: 60,
    work_hours: structuredClone(workHours),
    triage_agent: DEFAULT_TRIAGE_AGENT,
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
    async context({ sessionID }) {
      return structuredClone(contexts.get(sessionID) ?? [])
    },
    async update({ sessionID, title }) {
      retitles.push({ sessionID, title })
    },
  }

  const claims = createClaims({ dir, now, fs: pinnedFs(now) })

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
    changes,
    configWrites,
    tokens,
    config,
    session,
    claims,
    newWatcher,
    facade,
    watcher: newWatcher(),
    items: () => storage.map.get(KEYS.items) ?? {},
    seen: () => storage.map.get(KEYS.seen) ?? [],
    status: () => storage.map.get(KEYS.status) ?? {},
    toolCalls: () => calls.filter((call) => call.method === "tools/call"),
    clean: () => {
      console.warn = realWarn
      console.log = realLog
      console.error = realError
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a poll calls only the Slack servers, only the search tool, with the configured flag and no date modifier", async () => {
  const h = harness({ servers: [NEXAR, NAUTO, TODOIST], emoji: "triage" })
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
      assert.equal(call.args.filters, "hasmy::triage:", "the search carries the configured flag as its filter")
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
    assert.equal(session.agent, DEFAULT_TRIAGE_AGENT, "the configured triage agent")
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
    assert.ok(prompt.includes("Intake issue: none — <the reason"), "the reply's line for a message left out")
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
    assert.equal(h.created[0].agent, DEFAULT_TRIAGE_AGENT, "on the triage agent")
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
    assert.equal(h.created.filter((session) => session.agent === DEFAULT_TRIAGE_AGENT).length, 1, "the hit got a session")
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
    assert.equal(h.created.filter((session) => session.agent === DEFAULT_TRIAGE_AGENT).length, 0, "no item session")
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

test("two concurrent polls of one instance keep both item records and both seen entries", async () => {
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
      if (itemsReads === 1) await yieldTimes(20)
      return value
    }
    await Promise.all([h.watcher.poll(), h.watcher.poll()])
    assert.equal(h.prompts.length, 2, "both hits got a prompted session")
    const stored = Object.keys(h.items()).sort()
    assert.equal(stored.length, 2, "both item records survive")
    assert.deepEqual(h.seen().sort(), stored, "and both seen entries")
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
      `Search results for: "hasmy::oc:"`,
      "",
      `## Messages (${slice.length} results) ===`,
      ...slice.flatMap((row, position) => [
        `### Result ${position + 1} of ${slice.length}`,
        `Channel: ${row.channelName} (${row.channel})`,
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

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.status().today.nextStepsPosted, 1, "today's count includes it")
    assert.equal(h.status().today.flagged, 1)
    assert.equal(h.status().today.skipped, 1)
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

test("a reply that leaves the message out records no issue, keeps the title and posts no next steps", async () => {
  const ts = message(60)
  const link = permalinkOf("C0PLATFORM", ts)
  const h = harness({ servers: [NEXAR], pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const sessionID = h.created[0].id
    h.contexts.set(sessionID, [
      {
        type: "assistant",
        content: [{ type: "text", text: "Intake issue: none — customer data\nTitle: A customer's export question" }],
      },
    ])
    await h.watcher.observe({ type: "session.execution.succeeded", data: { sessionID } })

    const stored = h.items()[link]
    assert.equal(stored.issueUrl, null, "no issue URL is recorded")
    assert.equal(stored.issueNumber, null, "and no issue number")
    assert.equal(stored.title, "A customer's export question", "the title still comes from the reply")
    assert.equal(stored.firstTurnFailed, false)
    assert.deepEqual(h.retitles, [{ sessionID, title: "A customer's export question" }])

    h.clock.ms += h.config.poll_seconds * 1000
    await h.watcher.poll()
    assert.equal(h.status().today.nextStepsPosted, 0, "a message left out is not a next-steps post")
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

    h.contexts.set(sessionID, [
      { type: "assistant", content: [{ type: "text", text: "Intake issue: none — unreadable\nTitle: Never paraphrased" }] },
    ])
    await restarted.observe({ type: "session.execution.succeeded", data: { sessionID } })
    assert.equal(h.items()[link].firstTurnFailed, false, "the end it did see clears the flag")
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
