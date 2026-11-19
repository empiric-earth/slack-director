// The watcher: the flag scan, the claim files and the sessions they guard.
//
// Every test drives one or more watcher instances with a fake context and a
// fake HTTP layer over a temporary claims directory, and asserts what the
// poll's files and storage hold. No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaims, permalinkHash, STALE_MS } from "../src/claims.js"
import { DEFAULT_TRIAGE_AGENT } from "../src/config.js"
import { SKELETON_LIMITS } from "../src/first-prompt.js"
import { SEARCH_TOOL, SLACK_MCP_URL } from "../src/slack-mcp.js"
import { claimsDir, KEYS, NAMESPACE } from "../src/state.js"
import { createWatcher, LEASE_MS, REFRESH_AGENT, SUSPENDED_ERROR } from "../src/watcher.js"

const NOW = Date.now()
const NEXAR = { name: "slack_nexar", url: SLACK_MCP_URL }
const NAUTO = { name: "slack_nauto", url: SLACK_MCP_URL }
const TODOIST = { name: "todoist", url: "https://ai.todoist.net/mcp" }

const permalinkOf = (channel, ts, host = "nexar") =>
  `https://${host}.slack.com/archives/${channel}/p${ts.replace(".", "")}`
const hitRow = (channel, ts, channelName, host) => ({
  channel,
  ts,
  channelName,
  permalink: permalinkOf(channel, ts, host),
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
      `From: Someone (U0000000000)`,
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

/**
 * A fake context: one shared storage and claims directory, a fake HTTP layer
 * that answers MCP over HTTP from `pages`, and a fake session API that records
 * every call.
 */
function harness({ pages = {}, statuses = {}, servers = [NEXAR, NAUTO], emoji = "oc", credentials } = {}) {
  const root = mkdtempSync(join(tmpdir(), "slack-director-watcher-"))
  const stateHome = join(root, "state")
  const dir = claimsDir({ XDG_STATE_HOME: stateHome })
  const storage = memoryStorage()
  const clock = { ms: NOW }
  const now = () => clock.ms
  const calls = []
  const logs = []
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
  const tokens = credentials ?? { slack_nexar: { access: "tok-nexar", expires: 0 }, slack_nauto: { access: "tok-nauto", expires: 0 } }
  const config = {
    flag_emoji: emoji,
    intake_repo: "empiric-earth/almeida-slack-intake",
    session_directory: join(root, "session-directory"),
    poll_seconds: 60,
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
    const override = statuses[token]
    if (override) return respond(override.status, override.text ?? "")
    if (body.method === "initialize") {
      return respond(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        "mcp-session-id": `mcp-${token}`,
      })
    }
    if (body.method === "notifications/initialized") return respond(202, "")
    if (body.method === "tools/call") {
      const list = pages[token] ?? []
      const cursor = body.params?.arguments?.cursor
      const index = cursor === undefined ? 0 : Number(cursor)
      const current = list[index] ?? page([], null)
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
  }

  const claims = createClaims({ dir, now })

  const newWatcher = () =>
    createWatcher({
      storage,
      claims,
      now,
      fetch,
      readConfig: () => ({ config }),
      mcpServers: async () => servers,
      resolveCredential: async (name) => tokens[name],
      session,
      log: (message) => logs.push(message),
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
    tokens,
    config,
    session,
    claims,
    newWatcher,
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

test("the skeleton first prompt names no skill and asks for no issue, comment or other write", async () => {
  const ts = message(60)
  const h = harness({ pages: { "tok-nexar": [page([hitRow("C0PLATFORM", ts, "#platform-help")], null)] } })
  try {
    await h.watcher.poll()
    const prompt = h.prompts[0].text
    assert.ok(!prompt.includes("slack-director"), "the prompt names no skill")
    assert.ok(!/\bissue\b/i.test(prompt), "the prompt asks for no issue")
    assert.ok(!/\bcomment\b/i.test(prompt), "the prompt asks for no comment")
    assert.ok(prompt.includes(SKELETON_LIMITS), "the prompt states the read-only limits")
    assert.ok(/read that message's thread/i.test(prompt), "the prompt asks for the thread read")
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

test("every storage key and every claims file sits under the skeleton namespace", async () => {
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
