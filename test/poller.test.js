// The thread poller: the `gh` read, the Slack reads, the watermarks and the
// wake it sends. Every test drives one poller with a fake storage, a fake `gh`
// runner, a fake HTTP layer and a fake session API. No dependencies; run with
// `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { fieldProblem, DEFAULT_POLL_MINUTES, FIELD_NAMES } from "../src/config.js"
import { createGhRunner, issueListArgs, ISSUE_LIST_LIMIT } from "../src/gh.js"
import { blockFields, createPoller, tsBefore, tsOfIso, yamlBlockOf } from "../src/poller.js"
import { newActivityPrompt } from "../src/first-prompt.js"
import { cursorOf, newestTs, READ_CHANNEL_TOOL, READ_THREAD_TOOL, SLACK_MCP_URL, timestampsOf } from "../src/slack-mcp.js"
import { pageRows } from "../src/page.js"
import { KEYS, LEASE_MS } from "../src/state.js"

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const ALL_DAY = { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], start: "00:00", end: "23:59", time_zone: "UTC" }
const NEXAR = { name: "slack_nexar", url: SLACK_MCP_URL }
const openIssue = (number, fields) => ({
  number,
  url: `https://github.com/empiric-earth/almeida-slack-intake/issues/${number}`,
  title: `Request ${number}`,
  body: `Managed as IaaI. \n\n\`\`\`yaml\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n\`\`\`\n\nA paraphrase.`,
})

/** An intake issue whose yaml block is written line for line. */
const issueWithBody = (number, lines) => ({
  number,
  url: `https://github.com/empiric-earth/almeida-slack-intake/issues/${number}`,
  title: `Request ${number}`,
  body: ["Managed as IaaI.", "", "```yaml", ...lines, "```", "", "A paraphrase."].join("\n"),
})

const tsOf = (secondsAgo) => `${Math.floor((NOW - secondsAgo * 1000) / 1000)}.000100`

function respond(status, text, headers = {}) {
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, async text() { return text } }
}

function memoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined },
    async set(key, value) { map.set(key, structuredClone(value)) },
    async remove(key) { map.delete(key) },
  }
}

/** The answer of one Slack read: each row's `ts` (and its `thread_ts`). */
function answer(rows, next) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          messages: rows.map((row) => ({ ts: row.ts, thread_ts: row.thread_ts ?? row.ts })),
          ...(next ? { next_cursor: next } : {}),
        }),
      },
    ],
  }
}

// The live read answer's shape: one JSON object with the report in a `messages`
// string and the next page in `pagination_info`. Each message's `ts` sits on its
// own `Message TS:` line; the `detailed` format is the only one that carries it.
const reportAnswer = (report) => ({ content: [{ type: "text", text: JSON.stringify(report) }] })
const threadReport = (timestamps) => ({
  messages: [
    "=== THREAD PARENT MESSAGE ===",
    "From: Maria Costa (U123)",
    `Message TS: ${timestamps[0]}`,
    "> placeholder text",
    ...timestamps.slice(1).map((ts) => `=== Reply ===\nMessage TS: ${ts}\n> placeholder text`),
  ].join("\n"),
  pagination_info: "There are no more messages in this thread.",
})
const dmReport = (timestamps) => ({
  messages: [
    "Channel: DM (D03KHBF103X)",
    ...timestamps.map((ts) => `=== Message from Maria Costa (U123) at 12:00 UTC ===\nMessage TS: ${ts}\n> placeholder text`),
  ].join("\n"),
  pagination_info: "There are more messages available. To view the next page, use cursor: `abc123`",
})

function harness({
  issues = [],
  reads = () => answer([]),
  gh = undefined,
  config = {},
  token = { access: "tok" },
  servers = [NEXAR],
  sessionTime = { busy: 0, idle: 5 },
  owner,
  signal,
  onSessionGet,
} = {}) {
  const storage = memoryStorage()
  const clock = { ms: NOW }
  const logs = []
  const prompts = []
  const mcpCalls = []
  const ghCalls = []
  const stateCalls = []
  const cfg = {
    flag_emoji: "oc",
    intake_repo: "empiric-earth/almeida-slack-intake",
    session_directory: "/tmp/sessions",
    poll_seconds: 60,
    poll_minutes: 5,
    work_hours: structuredClone(ALL_DAY),
    session_agent: "slack-director",
    ...config,
  }
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    mcpCalls.push({ method: body.method, name: body.params?.name, args: body.params?.arguments })
    if (body.method === "initialize") {
      return respond(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { "mcp-session-id": "mcp-1" })
    }
    if (body.method === "notifications/initialized") return respond(202, "")
    if (body.method === "tools/call") {
      const result = reads({ name: body.params?.name, args: body.params?.arguments, call: mcpCalls.length })
      return respond(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
    }
    return respond(200, "{}")
  }
  const session = {
    async get() {
      if (onSessionGet) await onSessionGet()
      return { id: "ses_1", time: structuredClone(sessionTime) }
    },
    async prompt(input) { prompts.push(input) },
    async create() { throw new Error("the poller creates no session") },
    async remove() { throw new Error("the poller removes no session") },
  }
  const poller = createPoller({
    storage,
    now: () => clock.ms,
    fetch,
    ...(owner === undefined ? {} : { owner }),
    ...(signal === undefined ? {} : { signal }),
    runGh: async (args) => {
      ghCalls.push(args)
      if (typeof gh === "function") return gh(args)
      return { ok: true, code: 0, stdout: JSON.stringify(issues), stderr: "" }
    },
    readConfig: () => ({ config: cfg }),
    resolveCredential: async () => token,
    mcpServers: async () => servers,
    session,
    log: (message) => logs.push(message),
    applyIssueStates: async (input) => {
      stateCalls.push(input)
      return true
    },
  })
  return {
    storage,
    clock,
    cfg,
    logs,
    prompts,
    mcpCalls,
    ghCalls,
    stateCalls,
    poller,
    run: () => poller.run(),
    reads: (name) => mcpCalls.filter((call) => call.name === name),
    items: () => storage.map.get(KEYS.items) ?? {},
    setItems: (value) => storage.map.set(KEYS.items, value),
    setWatermarks: (value) => storage.map.set(KEYS.watermarks, value),
    watermarks: () => storage.map.get(KEYS.watermarks) ?? {},
    status: () => storage.map.get(KEYS.poller) ?? {},
    lease: () => storage.map.get(KEYS.lease),
    setLease: (value) => storage.map.set(KEYS.lease, value),
  }
}

const recordFor = (number, permalink, extra = {}) => ({
  permalink,
  workspace: "slack_nexar",
  channel: "#platform-help",
  channelID: "C0PLATFORM",
  ts: "1795194443.137219",
  asker: "Maria Costa",
  flaggedAt: new Date(NOW).toISOString(),
  pollerFrom: new Date(NOW).toISOString(),
  title: "Maria Costa — Access",
  sessionID: "ses_1",
  issueNumber: number,
  issueUrl: `https://github.com/empiric-earth/almeida-slack-intake/issues/${number}`,
  firstTurnEndedAt: null,
  firstTurnFailed: false,
  permissionPending: false,
  openedAt: null,
  recordFormat: 2,
  ...extra,
})

test("a cycle makes one gh read and, per in-scope issue, one thread read", async () => {
  const issue = openIssue(11, {
    permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219",
    workspace: "slack_nexar",
    channel_id: "C0PLATFORM",
    channel_name: "platform-help",
    thread_ts: "1795194443.137219",
  })
  const h = harness({ issues: [issue] })
  const { pollMinutes } = await h.run()
  assert.equal(pollMinutes, 5, "the next cycle is one poll_minutes away")
  assert.equal(h.ghCalls.length, 1, "exactly one gh read")
  assert.deepEqual(h.ghCalls[0], issueListArgs("empiric-earth/almeida-slack-intake"), "the gh read is the fixed issue list")
  assert.equal(h.reads(READ_THREAD_TOOL).length, 1, "one thread read")
  assert.equal(h.reads(READ_CHANNEL_TOOL).length, 0, "a channel's thread reads no conversation")
  assert.equal(h.prompts.length, 0, "a first read with no stored watermark wakes nothing")
  assert.equal(h.status().issues, 1, "the status counts the issue read")
  assert.equal(h.status().threads, 1)
  assert.equal(h.status().conversations, 0)
})

test("a newer message in the thread wakes the item session once, with its source and watermark", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 1, "exactly one wake")
  const text = h.prompts[0].text
  assert.ok(text.includes("https://github.com/empiric-earth/almeida-slack-intake/issues/11"), "the wake names the issue")
  assert.ok(text.includes("Source: thread"), "the wake names the thread as the source")
  assert.ok(text.includes(tsOf(600)), "the wake names the watermark it is newer than")
  assert.equal(h.prompts[0].sessionID, "ses_1", "the wake goes to the record's session")
  assert.equal(h.watermarks()["11"].ts, tsOf(30), "the watermark moves to the newest ts read")
})

test("a read with no newer message sends no wake and moves the watermark", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(900) }]),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 0, "nothing newer, no wake")
  assert.equal(h.watermarks()["11"].ts, tsOf(900), "the watermark follows the read's newest ts")
})

test("a running session is not prompted and keeps its watermark", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
    sessionTime: { busy: NOW, idle: null },
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 0, "a running session is not prompted")
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "its watermark stays, so the next cycle retries")
})

test("a session with a permission request pending is not prompted and keeps its watermark", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setItems({ [link]: recordFor(11, link, { permissionPending: true }) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 0, "a pending permission blocks the wake")
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "its watermark stays")
})

test("an unthreaded DM message returned only by the conversation read wakes with source `conversation`", async () => {
  const link = "https://nexar.slack.com/archives/D03KHBF103X/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "D03KHBF103X",
        channel_name: "DM",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: ({ name }) => (name === READ_CHANNEL_TOOL ? answer([{ ts: tsOf(30) }]) : answer([{ ts: tsOf(900) }])),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.reads(READ_CHANNEL_TOOL).length, 1, "a DM's conversation is read")
  assert.equal(h.prompts.length, 1, "the unthreaded message wakes the session")
  assert.ok(h.prompts[0].text.includes("Source: conversation"), "the wake names the conversation")
})

test("a new item starts at 60 seconds before its flag, so a reply around the first turn is replayed once", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    // A reply that arrived after the flag: its ts lies between `flaggedAt - 60`
    // and the first turn's end.
    reads: () => answer([{ ts: tsOf(-30) }]),
  })
  h.setItems({ [link]: recordFor(11, link) })
  await h.run()
  assert.equal(h.prompts.length, 1, "the overlap is replayed once")
  assert.ok(h.watermarks()["11"].ts === tsOf(-30), "the watermark starts 60 seconds before the flag and moves after the wake")
})

test("an issue first read with no watermark wakes nothing on that read", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  // No item record and no watermark: an issue first seen.
  await h.run()
  assert.equal(h.prompts.length, 0, "no wake on the first read")
  assert.equal(h.watermarks()["11"].ts, tsOf(30), "the watermark starts at that read's newest ts")
})

test("an earlier build's item is read but never woken on adoption, and baselines at its first read", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const yesterday = new Date(NOW - 24 * 60 * 60 * 1000).toISOString()
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  // An item an earlier build recorded and completed: it holds `flaggedAt` but no
  // `pollerFrom`, and no watermark yet.
  const earlier = recordFor(11, link, { flaggedAt: yesterday, firstTurnEndedAt: yesterday })
  delete earlier.pollerFrom
  h.setItems({ [link]: earlier })
  await h.run()
  assert.equal(h.prompts.length, 0, "adoption must not wake an earlier build's item")
  assert.equal(h.watermarks()["11"].ts, tsOf(30), "its watermark starts at its first read's newest ts")
})

test("an unattended issue is read, never woken, keeps its watermark and is listed with its fields", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 0, "no wake and no new session")
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "its watermark does not move")
  const [entry] = h.status().unattended
  assert.equal(entry.number, 11)
  assert.equal(entry.permalink, link)
  assert.equal(entry.state, "needs-me", "a missing state reads as needs-me")
  assert.equal(entry.state_since, "2026-11-18T12:00:00.000Z", "a missing state_since falls back to asked_at")
  assert.equal(entry.asked_at, "2026-11-18T12:00:00.000Z", "the given asked_at is kept")
  assert.equal(entry.newActivity, true, "a newer message marks it")
})

test("an unattended issue's asked_at falls back to the time the poller first read it", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  const [entry] = h.status().unattended
  assert.equal(entry.asked_at, new Date(NOW).toISOString(), "a missing asked_at falls back to the first read")
  assert.equal(entry.state_since, new Date(NOW).toISOString(), "and so does the state_since")
  assert.equal(entry.newActivity, false, "the first read marks nothing")
})

const toolError = (text) => ({ isError: true, content: [{ type: "text", text }] })

/** The one open, in-scope, unattended issue of the failed-read tests. */
const unattendedIssue = (extra = {}) =>
  openIssue(11, {
    permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219",
    workspace: "slack_nexar",
    channel_id: "C0PLATFORM",
    channel_name: "platform-help",
    thread_ts: "1795194443.137219",
    ...extra,
  })

test("a failed Slack read never hides an unattended open issue, whichever way it fails", async () => {
  const cases = {
    "a tool error": { reads: () => toolError("the channel could not be read") },
    "a rate limit": { reads: () => toolError("rate_limited: too many requests") },
    "an answer the reader cannot read": { reads: () => reportAnswer({ messages: "an unrecognized report" }) },
    "no credential": { token: null, reads: () => answer([{ ts: tsOf(30) }]) },
    "no Slack server": { servers: [], reads: () => answer([{ ts: tsOf(30) }]) },
  }
  for (const [name, options] of Object.entries(cases)) {
    const h = harness({ issues: [unattendedIssue()], ...options })
    await h.run()
    assert.deepEqual(h.status().failed, [11], `${name}: the failure is reported`)
    assert.equal(h.prompts.length, 0, `${name}: no wake`)
    assert.equal(h.watermarks()["11"], undefined, `${name}: no watermark is written`)
    const [entry] = h.status().unattended
    assert.equal(entry?.number, 11, `${name}: the open issue is still listed as unattended`)
    assert.equal(entry.permalink, "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219", name)
    assert.equal(entry.state, "needs-me", `${name}: its request state is the issue's`)
    assert.equal(entry.newActivity, false, `${name}: the failed read marks nothing it did not see`)
    const rows = pageRows([], () => ({}), h.status().unattended)
    assert.equal(rows.filter((row) => row.unattended && row.item.issueNumber === 11).length, 1, `${name}: the overview shows its row`)
  }
})

test("a failed read keeps an unattended issue's activity mark and the age it first had", async () => {
  const h = harness({ issues: [unattendedIssue()], reads: () => answer([{ ts: tsOf(30) }]) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW - 3600_000).toISOString() } })
  await h.run()
  assert.equal(h.status().unattended[0].newActivity, true, "a healthy read marks the new message")
  const healthy = h.status().unattended[0]

  const failing = harness({ issues: [unattendedIssue()], reads: () => toolError("boom") })
  failing.clock.ms = NOW + 300_000
  failing.storage.map.set(KEYS.poller, structuredClone(h.status()))
  failing.storage.map.set(KEYS.watermarks, structuredClone(h.watermarks()))
  await failing.run()
  const [entry] = failing.status().unattended
  assert.equal(entry.number, 11, "the next cycle's failed read still lists the issue")
  assert.equal(entry.newActivity, true, "and keeps the mark the last cycle found")
  assert.equal(entry.asked_at, healthy.asked_at, "and its age")
  assert.deepEqual(failing.status().failed, [11])
})

test("an unattended issue whose very first read fails keeps the time it was first seen", async () => {
  const issue = unattendedIssue()
  const first = harness({ issues: [issue], reads: () => toolError("boom") })
  await first.run()
  const seen = first.status().unattended[0].asked_at
  assert.equal(seen, new Date(NOW).toISOString(), "a missing asked_at starts at the first cycle")

  const later = harness({ issues: [issue], reads: () => toolError("boom") })
  later.clock.ms = NOW + 600_000
  later.storage.map.set(KEYS.poller, structuredClone(first.status()))
  await later.run()
  assert.equal(later.status().unattended[0].asked_at, seen, "a later failed read does not restart its age")
})

test("a recovered read after failed ones reads the issue normally again", async () => {
  let healthy = false
  const h = harness({
    issues: [unattendedIssue()],
    reads: () => (healthy ? answer([{ ts: tsOf(30) }]) : toolError("boom")),
  })
  await h.run()
  await h.run()
  assert.equal(h.status().unattended.length, 1, "the failed cycles list the issue")
  healthy = true
  await h.run()
  assert.deepEqual(h.status().failed, [], "the healthy cycle reports no failure")
  assert.equal(h.status().unattended.length, 1, "and still lists the issue once")
  assert.equal(h.watermarks()["11"].ts, tsOf(30), "its first healthy read sets the watermark")
})

test("a recovered unattended issue keeps the time it was first seen on every later cycle", async () => {
  let healthy = false
  const h = harness({
    issues: [unattendedIssue()],
    reads: () => (healthy ? answer([{ ts: tsOf(30) }]) : toolError("boom")),
  })
  const seen = new Date(NOW).toISOString()
  await h.run()
  await h.run()
  assert.equal(h.status().unattended[0].asked_at, seen, "the failed cycles start the age at the first cycle")

  healthy = true
  for (const minutes of [10, 15, 20]) {
    h.clock.ms = NOW + minutes * 60_000
    await h.run()
    const [entry] = h.status().unattended
    assert.equal(entry.asked_at, seen, `healthy cycle at +${minutes} minutes keeps the age`)
    assert.equal(entry.state_since, seen, `and the state_since fallback at +${minutes} minutes`)
  }
  assert.equal(h.watermarks()["11"].firstReadAt, seen, "the stored baseline carries the first-seen time")
})

test("a failed gh read keeps the unattended rows the last cycle reported", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const listed = JSON.stringify([
    openIssue(11, {
      permalink: link,
      workspace: "slack_nexar",
      channel_id: "C0PLATFORM",
      channel_name: "platform-help",
      thread_ts: "1795194443.137219",
    }),
  ])
  let calls = 0
  const h = harness({
    gh: () => {
      calls += 1
      return calls === 1
        ? { ok: true, code: 0, stdout: listed, stderr: "" }
        : { ok: false, code: 1, stdout: "", stderr: "not logged in" }
    },
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.equal(h.status().unattended.length, 1, "the first cycle lists the unattended issue")
  await h.run()
  assert.equal(h.status().unattended.length, 1, "a failed read hides no unattended row")
  assert.equal(h.status().unattended[0].number, 11)
  assert.match(h.status().ghError, /not logged in/, "and the failure is still reported")
})

test("a possibly cut list keeps an unattended row it does not name", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const first = JSON.stringify([
    openIssue(11, {
      permalink: link,
      workspace: "slack_nexar",
      channel_id: "C0PLATFORM",
      channel_name: "platform-help",
      thread_ts: "1795194443.137219",
    }),
  ])
  const cut = JSON.stringify(
    Array.from({ length: ISSUE_LIST_LIMIT }, (_, index) =>
      openIssue(index + 100, {
        permalink: `https://nexar.slack.com/archives/C0PLATFORM/p${index}`,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: `179519444${index}.137219`,
      }),
    ),
  )
  let calls = 0
  const h = harness({
    gh: () => (calls++ === 0 ? { ok: true, code: 0, stdout: first, stderr: "" } : { ok: true, code: 0, stdout: cut, stderr: "" }),
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.equal(h.status().unattended.length, 1)
  await h.run()
  assert.equal(h.status().possiblyCut, true, "the second list is cut")
  assert.ok(
    h.status().unattended.some((entry) => entry.number === 11),
    "the row the cut list does not name stays",
  )
  assert.equal(h.status().unattended.length, ISSUE_LIST_LIMIT + 1, "the cut list's own rows join it")
})

test("an issue whose yaml block carries a category gets no Slack read and no wake", async () => {
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PROD/p1",
        workspace: "slack_nexar",
        channel_id: "C0PROD",
        channel_name: "prod",
        thread_ts: "1795194443.137219",
        category: "customer data",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.equal(h.reads(READ_THREAD_TOOL).length, 0, "an out-of-scope issue is not read")
  assert.equal(h.prompts.length, 0, "and never wakes")
  assert.equal(h.status().issues, 0, "it is not counted among the issues read")
})

test("a quoted category key still excludes the issue from every read", async () => {
  const h = harness({
    issues: [
      issueWithBody(11, [
        '"category": customer data',
        "permalink: https://nexar.slack.com/archives/C0PROD/p1",
        "workspace: slack_nexar",
        "channel_id: C0PROD",
        "channel_name: prod",
        'thread_ts: "1795194443.137219"',
      ]),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.equal(h.reads(READ_THREAD_TOOL).length, 0, "a quoted category key excludes the issue")
  assert.equal(h.prompts.length, 0, "and it never wakes")
})

test("an empty category value still excludes the issue from every read", async () => {
  const h = harness({
    issues: [
      issueWithBody(11, [
        "category:",
        "permalink: https://nexar.slack.com/archives/C0PROD/p1",
        "workspace: slack_nexar",
        "channel_id: C0PROD",
        "channel_name: prod",
        "thread_ts: 1795194443.137219",
      ]),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.ok(Object.hasOwn(blockFields("permalink: p\ncategory: \n"), "category"), "an empty value keeps the marker")
  assert.equal(h.reads(READ_THREAD_TOOL).length, 0, "an empty category still excludes the issue")
  assert.equal(h.prompts.length, 0, "and it never wakes")
})

test("a yaml block with an explicit mapping key is rejected, so the issue is not read", async () => {
  const h = harness({
    issues: [
      issueWithBody(11, [
        "? category",
        ": customer data",
        "permalink: https://nexar.slack.com/archives/C0PROD/p1",
        "workspace: slack_nexar",
        "channel_id: C0PROD",
        "channel_name: prod",
        "thread_ts: 1795194443.137219",
      ]),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.equal(h.reads(READ_THREAD_TOOL).length, 0, "a block with unsupported syntax is not read")
  assert.equal(h.prompts.length, 0, "and it never wakes")
  assert.ok(h.logs.some((line) => /did not parse/.test(line)), "the log names the reason")
})

test("a yaml block with a key the reader cannot trust is rejected, so the issue is not read", async () => {
  const h = harness({
    issues: [
      issueWithBody(11, [
        '"the category": customer data',
        "permalink: https://nexar.slack.com/archives/C0PROD/p1",
        "workspace: slack_nexar",
        "channel_id: C0PROD",
        "channel_name: prod",
        "thread_ts: 1795194443.137219",
      ]),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  await h.run()
  assert.equal(h.reads(READ_THREAD_TOOL).length, 0, "a block the reader cannot trust is not read")
  assert.equal(h.prompts.length, 0, "and it never wakes")
  assert.ok(h.logs.some((line) => /did not parse/.test(line)), "the log names the reason")
})

test("an issue whose yaml block does not parse is skipped and named by number", async () => {
  const h = harness({
    issues: [{ number: 11, url: "https://github.com/empiric-earth/almeida-slack-intake/issues/11", title: "No block", body: "just a paraphrase" }],
  })
  await h.run()
  assert.equal(h.reads(READ_THREAD_TOOL).length, 0, "nothing is read")
  assert.ok(h.logs.some((line) => /issue #\d+ skipped/.test(line)), "the log names the issue by number")
})

test("an unreadable read moves no watermark and reaches the status and the log", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => ({ isError: true, content: [{ type: "text", text: "the tool call failed" }] }),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "a failed read moves no watermark")
  assert.deepEqual(h.status().failed, [11], "the status names the issue")
  assert.ok(h.logs.some((line) => /issue #\d+ read failed/.test(line)))
})

test("a successful answer the reader cannot read is a failed read, not an empty one", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    // A non-error answer whose payload carries no report field the reader knows:
    // a changed report format must never read as an empty one.
    reads: () => ({ content: [{ type: "text", text: JSON.stringify({ unexpected: "shape" }) }] }),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "an unreadable answer moves no watermark")
  assert.deepEqual(h.status().failed, [11], "the status names the issue")
  assert.ok(h.logs.some((line) => /issue #\d+ read failed/.test(line)))
})

test("a nonempty answer whose report holds no timestamp is a failed read, and a recognized empty one is not", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const setup = (reads) => {
    const h = harness({
      issues: [
        openIssue(11, {
          permalink: link,
          workspace: "slack_nexar",
          channel_id: "C0PLATFORM",
          channel_name: "platform-help",
          thread_ts: "1795194443.137219",
        }),
      ],
      reads,
    })
    h.setItems({ [link]: recordFor(11, link) })
    h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
    return h
  }
  for (const messages of ["unrecognized nonempty report format", [{ text: "no timestamp field" }], ["a row"]]) {
    const h = setup(() => reportAnswer({ messages }))
    await h.run()
    assert.deepEqual(h.status().failed, [11], "the status names the issue")
    assert.equal(h.watermarks()["11"].ts, tsOf(600), "and no watermark moves")
    assert.equal(h.prompts.length, 0)
  }
  for (const messages of ["", "No thread messsages", "No messages", []]) {
    const h = setup(() => reportAnswer({ messages }))
    await h.run()
    assert.deepEqual(h.status().failed, [], "a recognized empty answer is a healthy read")
    assert.equal(h.prompts.length, 0, "and wakes nothing")
  }
})

test("a rate-limited read is reported and the watermark stays", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  let answer429 = false
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === "initialize") {
      return respond(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { "mcp-session-id": "m1" })
    }
    if (body.method === "notifications/initialized") return respond(202, "")
    if (body.method === "tools/call") return respond(429, "")
    return respond(200, "{}")
  }
  const storage = memoryStorage()
  const logs = []
  const poller = createPoller({
    storage,
    now: () => NOW,
    fetch,
    runGh: async () => ({
      ok: true,
      code: 0,
      stdout: JSON.stringify([
        openIssue(11, {
          permalink: link,
          workspace: "slack_nexar",
          channel_id: "C0PLATFORM",
          channel_name: "platform-help",
          thread_ts: "1795194443.137219",
        }),
      ]),
      stderr: "",
    }),
    readConfig: () => ({ config: { intake_repo: "empiric-earth/almeida-slack-intake", poll_minutes: 5, work_hours: ALL_DAY } }),
    resolveCredential: async () => ({ access: "tok" }),
    mcpServers: async () => [NEXAR],
    session: { get: async () => ({ time: { busy: 0, idle: 5 } }), prompt: async () => {} },
    log: (message) => logs.push(message),
  })
  storage.map.set(KEYS.watermarks, { 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await poller.run()
  assert.equal(storage.map.get(KEYS.watermarks)["11"].ts, tsOf(600), "a rate-limited read moves no watermark")
  assert.deepEqual(storage.map.get(KEYS.poller).failed, [11], "the status reports it")
  assert.ok(logs.some((line) => line.includes("rate limited")))
})

test("a gh failure reaches the status and the log, and the next cycle runs", async () => {
  let calls = 0
  const h = harness({
    gh: () => {
      calls += 1
      return calls === 1
        ? { ok: false, code: 1, stdout: "", stderr: "gh: not logged in" }
        : { ok: true, code: 0, stdout: "[]", stderr: "" }
    },
  })
  await h.run()
  assert.equal(h.status().ghError, "gh: not logged in", "the status names the gh failure")
  assert.ok(h.logs.some((line) => line.includes("gh: not logged in")))
  await h.run()
  assert.equal(h.status().ghError, null, "the next cycle runs and clears the failure")
  assert.equal(calls, 2, "both cycles made their gh read")
})

test("a gh timeout reaches the status and the log, and the next cycle runs", async () => {
  let calls = 0
  const h = harness({
    gh: () => {
      calls += 1
      return calls === 1
        ? { ok: false, code: null, timedOut: true, stdout: "", stderr: "gh timed out after 30000 ms" }
        : { ok: true, code: 0, stdout: "[]", stderr: "" }
    },
  })
  await h.run()
  assert.match(h.status().ghError, /timed out/, "the status names the timeout")
  assert.ok(h.logs.some((line) => line.includes("timed out")))
  await h.run()
  assert.equal(h.status().ghError, null, "the next cycle runs and clears the timeout")
  assert.equal(calls, 2, "both cycles made their gh read")
})

test("a list of exactly 100 issues is marked possibly cut", async () => {
  const issues = Array.from({ length: ISSUE_LIST_LIMIT }, (_, index) =>
    openIssue(index + 1, {
      permalink: `https://nexar.slack.com/archives/C0PLATFORM/p${index}`,
      workspace: "slack_nexar",
      channel_id: "C0PLATFORM",
      channel_name: "platform-help",
      thread_ts: `179519444${index}.137219`,
    }),
  )
  const h = harness({ issues, reads: () => answer([{ ts: tsOf(30) }]) })
  await h.run()
  assert.equal(h.status().possiblyCut, true, "a full list is possibly cut")
  assert.ok(h.logs.some((line) => line.includes("possibly cut")))
})

test("the poller writes nothing but reads: no Slack write, no model call, no session change", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  const names = new Set(h.mcpCalls.filter((call) => call.method === "tools/call").map((call) => call.name))
  assert.deepEqual([...names].sort(), [READ_CHANNEL_TOOL, READ_THREAD_TOOL].filter((name) => names.has(name)).sort(), "only the read tools are called")
  for (const call of h.mcpCalls) {
    assert.ok(["initialize", "notifications/initialized", "tools/call"].includes(call.method), "no other MCP method")
  }
  // No message text and no issue body reaches the log or the status.
  const status = JSON.stringify(h.status())
  assert.ok(!status.includes("A paraphrase."), "the status carries no issue body")
  for (const line of h.logs) {
    assert.ok(!line.includes("A paraphrase."), "the log carries no issue body")
  }
})

test("the poller reads no issue and writes nothing outside the work hours", async () => {
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    config: { work_hours: { days: ["Mon"], start: "09:00", end: "10:00", time_zone: "UTC" } },
  })
  await h.run()
  assert.equal(h.ghCalls.length, 0, "no gh read outside the window")
  assert.equal(h.mcpCalls.length, 0, "no Slack read outside the window")
})

test("poll_minutes: 0 turns the poller off and reads nothing", async () => {
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    config: { poll_minutes: 0 },
  })
  const { pollMinutes } = await h.run()
  assert.equal(pollMinutes, 0, "the poller reports itself off")
  assert.equal(h.ghCalls.length, 0, "nothing is read")
  assert.equal(h.status().lastCycle, undefined, "and no cycle is recorded")
})

test("the next cycle follows a poll_minutes change with no restart", async () => {
  const h = harness()
  assert.equal((await h.run()).pollMinutes, 5)
  h.cfg.poll_minutes = 9
  assert.equal((await h.run()).pollMinutes, 9, "a change takes effect at the next cycle")
})

test("the read follows the next cursor for at most 5 pages", async () => {
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: ({ args }) => answer([{ ts: tsOf(30) }], args.cursor === undefined ? "c1" : args.cursor === "c1" ? "c2" : undefined),
  })
  await h.run()
  const threadCalls = h.reads(READ_THREAD_TOOL)
  assert.ok(threadCalls.length <= 5, "at most five pages")
  assert.deepEqual(threadCalls.map((call) => call.args.cursor), [undefined, "c1", "c2"], "each call carries the previous page's cursor")
})

test("the fixed gh runner runs `gh` with no shell and inherits the process environment", () => {
  const seen = []
  const runner = createGhRunner({
    exec: (program, args, options, callback) => {
      seen.push({ program, args, options })
      callback(null, "[]", "")
    },
  })
  return runner(issueListArgs("empiric-earth/almeida-slack-intake")).then((result) => {
    assert.equal(result.ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].program, "gh", "the program is gh")
    assert.deepEqual(seen[0].args, issueListArgs("empiric-earth/almeida-slack-intake"), "the argument list is fixed")
    assert.equal(Object.hasOwn(seen[0].options, "env"), false, "the environment is inherited unchanged")
  })
})

test("the gh runner bounds the child, and an expired child is a failed list naming the expiry", () => {
  const seen = []
  const runner = createGhRunner({
    exec: (program, args, options, callback) => {
      seen.push({ program, args, options })
      const error = new Error("Command failed")
      error.killed = true
      error.signal = "SIGTERM"
      callback(error, "", "")
    },
  })
  return runner(issueListArgs("empiric-earth/almeida-slack-intake")).then((result) => {
    assert.equal(result.ok, false, "an expired child is a failed list")
    assert.equal(result.timedOut, true)
    assert.match(result.stderr, /timed out/, "the failure names the expiry")
    assert.ok(Number.isFinite(seen[0].options.timeout) && seen[0].options.timeout > 0, "the child is bounded")
  })
})

test("the block reader takes the fields, drops an inline comment and keeps a quoted ts", () => {
  const block = yamlBlockOf("```yaml\npermalink: https://x/p1\nthread_ts: \"1795194443.137219\"  # the root\nstate: blocked\n```")
  const fields = blockFields(block)
  assert.equal(fields.permalink, "https://x/p1")
  assert.equal(fields.thread_ts, "1795194443.137219", "a quoted value keeps its text")
  assert.equal(fields.state, "blocked", "an inline comment is dropped")
  assert.deepEqual(blockFields('"category": x'), { category: "x" }, "a quoted key is the same key")
  assert.deepEqual(blockFields("category: \n"), { category: "" }, "an empty value keeps the marker")
  assert.equal(blockFields('"the category": x'), undefined, "a key the reader cannot trust rejects the block")
  assert.equal(blockFields("? category\n: x\npermalink: https://x/p1"), undefined, "an explicit mapping key rejects the block")
  assert.equal(blockFields("permalink: https://x/p1\n- item"), undefined, "a line that is not a field rejects the block")
})

test("tsOfIso and tsBefore give Slack's ts form", () => {
  assert.equal(tsOfIso("2026-11-18T12:00:00.000Z"), `${NOW / 1000}.000000`)
  assert.equal(tsBefore(`${NOW / 1000}.000000`, 60), `${NOW / 1000 - 60}.000000`)
})

test("poll_minutes is validated, defaults to 5, and is written like the other fields", () => {
  assert.equal(fieldProblem("poll_minutes", 5), undefined)
  assert.equal(fieldProblem("poll_minutes", 0), undefined, "0 is a valid value")
  assert.match(fieldProblem("poll_minutes", -1), /poll_minutes/)
  assert.match(fieldProblem("poll_minutes", 1.5), /poll_minutes/)
  assert.match(fieldProblem("poll_minutes", "5"), /poll_minutes/)
  assert.equal(DEFAULT_POLL_MINUTES, 5)
  assert.ok(FIELD_NAMES.includes("poll_minutes"), "the settings dialog lists it")
})

test("the new-activity prompt names the issue, its source and the watermark, and carries no Slack text", () => {
  const text = newActivityPrompt({ issueUrl: "https://x/issues/11", source: "both", watermark: "1795194443.137219" })
  assert.ok(text.includes("https://x/issues/11"))
  assert.ok(text.includes("Source: both"))
  assert.ok(text.includes("1795194443.137219"))
  assert.match(text, /slack-director/)
})

test("the new-activity prompt asks for the conversation read when its source is the conversation", () => {
  const conversation = newActivityPrompt({
    issueUrl: "https://x/issues/11",
    source: "conversation",
    watermark: "1795194443.137219",
  })
  // A DM's or a group DM's unthreaded message is returned by the conversation
  // read alone, so the wake for that source must ask for the conversation.
  assert.match(
    conversation,
    /Read the DM's or group DM's conversation from 1795194443\.137219/,
    "the conversation source reads the conversation, not only the thread",
  )
  assert.ok(!/Read the thread from/.test(conversation), "a conversation source does not read the thread only")
  assert.match(conversation, /re-triage/, "the wake asks for a re-triage by the skill")
  assert.match(conversation, /change its state when its turn moved/, "the wake asks for a state change")

  const both = newActivityPrompt({ issueUrl: "https://x/issues/11", source: "both", watermark: "1795194443.137219" })
  assert.match(both, /Read the thread and the DM's or group DM's conversation from/, "the both source names both reads")

  const thread = newActivityPrompt({ issueUrl: "https://x/issues/11", source: "thread", watermark: "1795194443.137219" })
  assert.match(thread, /Read the thread from/, "the thread source reads the thread")
})

test("the reader takes each message's ts from the live read answer shape", () => {
  const thread = reportAnswer(threadReport([tsOf(600), tsOf(300)]))
  assert.deepEqual(timestampsOf(thread), [tsOf(600), tsOf(300)], "a thread answer's Message TS lines")
  assert.equal(cursorOf(thread), undefined, "a thread with no next page carries no cursor")
  const dm = reportAnswer(dmReport([tsOf(300), tsOf(120)]))
  assert.deepEqual(timestampsOf(dm), [tsOf(300), tsOf(120)], "a DM answer's Message TS lines")
  assert.equal(cursorOf(dm), "abc123", "the DM's pagination line carries its cursor")
  assert.equal(newestTs(timestampsOf(dm)), tsOf(120), "the newest is the most recent message")
})

test("a run of a message body that looks like a field is not taken, and a `ts`-named field still is", () => {
  const report = reportAnswer({
    messages: `Message TS: ${tsOf(600)}\n> Message TS: 1111111111.111111\n`,
    pagination_info: "There are no more messages in this thread.",
  })
  // The quoted body's own line is indented by `> ` and is not a message's own
  // field, so only the real line is taken; a message body may not add one.
  assert.deepEqual(timestampsOf(report), [tsOf(600)])
  const structured = { content: [{ type: "text", text: JSON.stringify({ messages: [{ ts: tsOf(30) }] }) }] }
  assert.deepEqual(timestampsOf(structured), [tsOf(30)], "a structured `ts` field is still read")
})

test("a real DM answer with an unthreaded message newer than the watermark wakes with source `conversation`", async () => {
  const link = "https://nexar.slack.com/archives/D03KHBF103X/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "D03KHBF103X",
        channel_name: "DM",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: ({ name }) =>
      name === READ_CHANNEL_TOOL ? reportAnswer(dmReport([tsOf(30)])) : reportAnswer(threadReport([tsOf(900)])),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 1, "the unthreaded message wakes the session")
  assert.ok(h.prompts[0].text.includes("Source: conversation"))
  assert.equal(h.watermarks()["11"].ts, tsOf(30), "the watermark moves to the newest ts read")
})

test("a real thread answer with a new reply newer than the watermark wakes with source `thread`", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => reportAnswer(threadReport([tsOf(900), tsOf(30)])),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 1)
  assert.ok(h.prompts[0].text.includes("Source: thread"))
})

test("every read asks for the detailed format, the only one that carries a message's ts", async () => {
  const link = "https://nexar.slack.com/archives/D03KHBF103X/p1795194443137219"
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "D03KHBF103X",
        channel_name: "DM",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => reportAnswer(dmReport([tsOf(900)])),
  })
  await h.run()
  assert.equal(h.reads(READ_THREAD_TOOL)[0].args.response_format, "detailed")
  assert.equal(h.reads(READ_CHANNEL_TOOL)[0].args.response_format, "detailed")
})

test("a foreign, unexpired lease spares the poller its cycle", async () => {
  const h = harness({
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setLease({ owner: "another process", expires: NOW + LEASE_MS })
  await h.run()
  assert.equal(h.ghCalls.length, 0, "a foreign lease reads nothing")
  assert.equal(h.status().lastCycle, undefined, "and records no cycle")
})

test("an expired foreign lease lets the cycle run, and the cycle keeps the lease for its process", async () => {
  const h = harness({
    owner: "this process",
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setLease({ owner: "another process", expires: NOW - 1 })
  await h.run()
  assert.equal(h.ghCalls.length, 1, "an expired lease lets the cycle run")
  assert.equal(h.lease().owner, "this process", "the cycle keeps the lease for its own process")
  assert.ok(h.lease().expires > NOW, "and the lease is live again")
})

test("the poller is never blocked by its own lease", async () => {
  const h = harness({
    owner: "this process",
    issues: [
      openIssue(11, {
        permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
  })
  h.setLease({ owner: "this process", expires: NOW + LEASE_MS })
  await h.run()
  assert.equal(h.ghCalls.length, 1, "its own live lease never blocks it")
})

test("a cycle the unload aborts prompts nothing and writes no watermark", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const controller = new AbortController()
  const h = harness({
    signal: controller.signal,
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    // The unload lands while the thread read is in flight, so the abort is seen
    // before the cycle can send its prompt.
    reads: () => {
      controller.abort()
      return answer([{ ts: tsOf(30) }])
    },
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 0, "an aborted cycle sends no prompt")
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "and writes no watermark")
  assert.equal(h.status().lastCycle, undefined, "and records no cycle")
})

test("an unload during the session lookup stops the wake before its prompt", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const controller = new AbortController()
  const h = harness({
    signal: controller.signal,
    issues: [
      openIssue(11, {
        permalink: link,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: "1795194443.137219",
      }),
    ],
    reads: () => answer([{ ts: tsOf(30) }]),
    // The unload lands while the eligibility lookup is awaited.
    onSessionGet: () => controller.abort(),
  })
  h.setItems({ [link]: recordFor(11, link) })
  h.setWatermarks({ 11: { ts: tsOf(600), firstReadAt: new Date(NOW).toISOString() } })
  await h.run()
  assert.equal(h.prompts.length, 0, "a cycle aborted during the lookup sends no prompt")
  assert.equal(h.watermarks()["11"].ts, tsOf(600), "and writes no watermark")
})

test("a read the unload aborts mid-flight ends the cycle with the last status and throws nothing", async () => {
  const link = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const previous = {
    lastCycle: "2026-11-18T11:00:00.000Z",
    outcome: "ok",
    issues: 3,
    threads: 1,
    conversations: 0,
    unattended: [],
    ghError: null,
    failed: [],
    possiblyCut: false,
  }
  const controller = new AbortController()
  const storage = memoryStorage()
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === "initialize") {
      return respond(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { "mcp-session-id": "m1" })
    }
    if (body.method === "notifications/initialized") return respond(202, "")
    // The unload lands while the read is in flight: the request aborts.
    controller.abort()
    throw new Error("This operation was aborted")
  }
  const poller = createPoller({
    storage,
    now: () => NOW,
    fetch,
    owner: "this process",
    signal: controller.signal,
    runGh: async () => ({
      ok: true,
      code: 0,
      stdout: JSON.stringify([
        openIssue(11, {
          permalink: link,
          workspace: "slack_nexar",
          channel_id: "C0PLATFORM",
          channel_name: "platform-help",
          thread_ts: "1795194443.137219",
        }),
      ]),
      stderr: "",
    }),
    readConfig: () => ({ config: { intake_repo: "empiric-earth/almeida-slack-intake", poll_minutes: 5, work_hours: ALL_DAY } }),
    resolveCredential: async () => ({ access: "tok" }),
    mcpServers: async () => [NEXAR],
    session: { get: async () => ({ time: { busy: 0, idle: 5 } }), prompt: async () => {} },
  })
  storage.map.set(KEYS.items, { [link]: recordFor(11, link) })
  storage.map.set(KEYS.poller, previous)
  const result = await poller.run()
  assert.equal(result.status.lastCycle, previous.lastCycle, "the last cycle is answered unchanged")
  assert.deepEqual(storage.map.get(KEYS.poller), previous, "and nothing is written over it")
  assert.equal(storage.map.get(KEYS.watermarks), undefined, "and no watermark is written")
})

test("a cycle hands the request state of every open issue over, in scope or not", async () => {
  const h = harness({
    issues: [
      openIssue(7, {
        permalink: "p7",
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "#platform-help",
        thread_ts: tsOf(600),
        state: "blocked",
        state_since: "2026-11-18T09:00:00.000Z",
        blocked_on: "https://example.test/decisions/1",
      }),
      openIssue(8, {
        permalink: "p8",
        workspace: "slack_nexar",
        channel_id: "D03KHBF103X",
        channel_name: "DM",
        thread_ts: tsOf(700),
        state: "waiting-requester",
        state_since: "2026-11-18T10:00:00.000Z",
        waiting_on: "[U0000000001, U0000000002]",
      }),
      openIssue(9, { permalink: "p9", category: "customer-data" }),
      issueWithBody(10, ["permalink: p10", "workspace: slack_nexar"]),
      { number: 11, url: "https://github.com/empiric-earth/almeida-slack-intake/issues/11", title: "Request 11", body: "no yaml block here" },
    ],
    reads: () => answer([]),
  })
  const result = await h.run()

  assert.equal(h.stateCalls.length, 1, "one cycle hands its read over once")
  const [call] = h.stateCalls
  assert.equal(call.complete, true, "a list under the limit is a complete read")
  assert.deepEqual(
    call.issues.map((entry) => entry.number),
    [7, 8, 9, 10, 11],
    "every open issue is named, an out-of-scope one included",
  )
  assert.deepEqual(call.issues[0], {
    number: 7,
    state: "blocked",
    stateSince: "2026-11-18T09:00:00.000Z",
    blockedOn: "https://example.test/decisions/1",
    waitingOn: [],
  })
  assert.equal(call.issues[1].state, "waiting-requester")
  assert.deepEqual(call.issues[1].waitingOn, ["U0000000001", "U0000000002"], "a waiting_on list is read as its ids")
  assert.equal(call.issues[2].state, undefined, "an out-of-scope issue names no state")
  assert.equal(call.issues[3].state, undefined, "an issue whose block names no state carries none")
  assert.deepEqual(
    call.issues[4],
    { number: 11, state: undefined, stateSince: undefined, blockedOn: undefined, waitingOn: [] },
    "an issue whose block does not parse still names its number",
  )
  assert.equal(result.status.issues, 3, "the scope rules still decide which issues are read from Slack")
})

test("a list at the limit is handed over as possibly cut, and a failed list hands nothing over", async () => {
  const cut = harness({
    issues: Array.from({ length: ISSUE_LIST_LIMIT }, (_, index) => issueWithBody(index + 1, ["permalink: p", "state: idle"])),
    reads: () => answer([]),
  })
  await cut.run()
  assert.equal(cut.stateCalls[0].complete, false, "a list at the limit proves nothing about an issue it does not name")
  assert.equal(cut.stateCalls[0].issues.length, ISSUE_LIST_LIMIT, "and still hands over every issue it names")
  assert.equal(cut.stateCalls[0].issues[0].state, "idle")

  const failed = harness({ gh: async () => ({ ok: false, code: 1, stdout: "", stderr: "not logged in" }) })
  await failed.run()
  assert.deepEqual(failed.stateCalls, [], "a failed list changes no record's state and no record's visibility")
})

test("the open-issue read names every permalink and whether the read is whole, for the flag scan's forget rule", async () => {
  const permalink = "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219"
  const whole = harness({
    issues: [
      openIssue(7, {
        permalink,
        workspace: "slack_nexar",
        channel_id: "C0PLATFORM",
        channel_name: "platform-help",
        thread_ts: tsOf(600),
      }),
      openIssue(8, { permalink: "p8", category: "customer-data" }),
    ],
    reads: () => answer([]),
  })
  await whole.run()
  assert.deepEqual(
    whole.storage.map.get(KEYS.open),
    { at: new Date(NOW).toISOString(), complete: true, permalinks: [permalink, "p8"] },
    "every open issue's permalink, out-of-scope ones included, and a whole read",
  )

  const cut = harness({
    issues: Array.from({ length: ISSUE_LIST_LIMIT }, (_, index) => issueWithBody(index + 1, ["permalink: p", "state: idle"])),
    reads: () => answer([]),
  })
  await cut.run()
  assert.equal(cut.storage.map.get(KEYS.open).complete, false, "a list at its limit is not a whole read")

  const unreadable = harness({
    issues: [{ number: 9, url: "https://github.com/empiric-earth/almeida-slack-intake/issues/9", title: "Request 9", body: "no yaml block here" }],
  })
  await unreadable.run()
  assert.equal(unreadable.storage.map.get(KEYS.open).complete, false, "an issue whose block will not parse makes the read not whole")
  assert.deepEqual(unreadable.storage.map.get(KEYS.open).permalinks, [], "and names only the permalinks it could read")

  const failed = harness({ gh: async () => ({ ok: false, code: 1, stdout: "", stderr: "not logged in" }) })
  await failed.run()
  assert.equal(failed.storage.map.get(KEYS.open).complete, false, "a failed list is not a whole read")
  assert.deepEqual(failed.storage.map.get(KEYS.open).permalinks, [])
})

test("a cycle the unload aborted hands no request state over, like its watermark", async () => {
  const controller = new AbortController()
  const h = harness({ issues: [issueWithBody(7, ["permalink: p7", "state: blocked"])], signal: controller.signal })
  controller.abort()
  const result = await h.run()
  assert.deepEqual(h.stateCalls, [], "an aborted cycle writes no item state")
  assert.equal(result.status.lastCycle, null, "and reports no cycle")
})
