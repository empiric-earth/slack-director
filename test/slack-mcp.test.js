// The Slack MCP client, against the shapes the live tool returns.
//
// The search tool answers with one markdown report under `results`, the next
// page's cursor in a `pagination_info` line, and a result permalink that may
// sit on an Enterprise Grid host. These tests read those shapes directly. No
// dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cursorOf,
  hitsOf,
  PAGE_LIMIT,
  payloadOf,
  parsePermalink,
  permalinksIn,
  searchFilter,
  searchFlagged,
  SEARCH_FILTER_ARGUMENT,
  SEARCH_TOOL,
  shapeOf,
} from "../src/slack-mcp.js"

/** The permalink the live check found, on an Enterprise Grid host. */
const GRID = "https://grid-nauto.enterprise.slack.com/archives/D03KHBF103X/p1795008741837299"
const PLAIN = "https://nexar.slack.com/archives/C0PLATFORM/p1795008741837299"

const report = (blocks, pagination = "") =>
  [
    `Search results for: "hasmy::magic_wand:"`,
    "",
    `## Messages (${blocks.length} results) ===`,
    ...blocks,
    pagination,
  ].join("\n")

const block = (permalink, channel, ts) =>
  [
    `### Result 1 of 1`,
    `Channel: ${channel}`,
    `From: Someone (U0000000000)`,
    `Time: 2026-11-18 13:32:00 UTC`,
    `Message_ts: ${ts}`,
    `Permalink: [link](${permalink})`,
    `Text: A message the user flagged.`,
    "",
    `Context before:`,
    `- From: Someone else (U0000000001)`,
    `Message_ts: ${ts}`,
    `Text: An earlier message in the same channel.`,
    "",
  ].join("\n")

/** The MCP result object a tool answer with this payload arrives in. */
const answer = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })

/** A permalink of a message the user never flagged, inside another channel. */
const UNFLAGGED = "https://nexar.slack.com/archives/C0OTHER/p1795008742837299"

/**
 * A fake MCP HTTP layer: `initialize` and the notification answer, then every
 * search answers `reply`, or `callStatus`, or `openStatus` at initialize.
 */
function mcpFetch({ reply = {}, callStatus = 200, openStatus = 200 } = {}) {
  const respond = (status, payload) => ({
    status,
    headers: { get: (name) => (name.toLowerCase() === "mcp-session-id" ? "mcp-1" : null) },
    async text() {
      return JSON.stringify(payload)
    },
  })
  return async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === "initialize") {
      if (openStatus !== 200) return respond(openStatus, {})
      return respond(200, { jsonrpc: "2.0", id: body.id, result: {} })
    }
    if (body.method === "notifications/initialized") return respond(202, {})
    if (callStatus !== 200) return respond(callStatus, {})
    return respond(200, { jsonrpc: "2.0", id: body.id, ...reply })
  }
}

test("a Slack permalink is read on a workspace host and on an Enterprise Grid host", () => {
  assert.deepEqual(permalinksIn(`see ${GRID} and ${PLAIN} .`), [GRID, PLAIN])
  assert.deepEqual(parsePermalink(GRID), {
    permalink: GRID,
    channel: { id: "D03KHBF103X", label: "D03KHBF103X" },
    ts: "1795008741.837299",
  })
  assert.deepEqual(parsePermalink(PLAIN).channel.id, "C0PLATFORM")
  assert.equal(parsePermalink("https://nexar.slack.com/archives/C0PLATFORM"), undefined, "a channel link is not a hit")
})

test("the report's result blocks become hits, and its context blocks do not", () => {
  const result = answer({ results: report([block(GRID, "#platform-help (D03KHBF103X)", "1795008741.837299")]) })
  const hits = hitsOf(result)
  assert.equal(hits.length, 1, "one hit per result block, and none from the context block")
  assert.deepEqual(hits[0], {
    permalink: GRID,
    channel: { id: "D03KHBF103X", label: "#platform-help" },
    ts: "1795008741.837299",
  })
})

test("two result blocks become two hits, and a repeated permalink becomes one", () => {
  const result = answer({
    results: report([
      block(GRID, "DM (D03KHBF103X)", "1795008741.837299"),
      block(PLAIN, "#data-eng (C0PLATFORM)", "1795008742.837299"),
      block(GRID, "DM (D03KHBF103X)", "1795008741.837299"),
    ]),
  })
  const hits = hitsOf(result)
  assert.deepEqual(
    hits.map((hit) => hit.permalink),
    [GRID, PLAIN],
    "each distinct permalink appears once",
  )
  assert.equal(hits[0].channel.label, "DM")
  assert.equal(hits[1].channel.label, "#data-eng")
})

test("a result with no permalink is not a hit, and its shape is reported", () => {
  const result = answer({ results: report([block("", "DM (D03KHBF103X)", "1795008741.837299")]) })
  assert.deepEqual(hitsOf(result), [])
  assert.deepEqual(shapeOf(result), { fields: ["results"], results: 1 })
})

test("hits are also read from an array of rows", () => {
  const result = answer({ messages: [{ permalink: GRID, channel_name: "#platform-help" }] })
  const hits = hitsOf(result)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].channel.label, "#platform-help")
})

test("the next page's cursor is read from a field or from the pagination line", () => {
  assert.equal(cursorOf(answer({ next_cursor: "dGVhbTpDMDYxRkE1UEI=" })), "dGVhbTpDMDYxRkE1UEI=")
  assert.equal(cursorOf(answer({ cursor: "abc" })), "abc")
  const paginated = answer({
    results: report([block(GRID, "DM (D03KHBF103X)", "1795008741.837299")]),
    pagination_info: "For the next page of results use cursor `dGVhbTpDMDYxRkE1UEI=`",
  })
  assert.equal(cursorOf(paginated), "dGVhbTpDMDYxRkE1UEI=")
  assert.equal(cursorOf(answer({ results: report([]) })), undefined, "a last page carries no cursor")
})

test("an answer body is read from JSON or from an SSE stream", () => {
  assert.deepEqual(payloadOf('{"jsonrpc":"2.0","id":1,"result":{}}'), { jsonrpc: "2.0", id: 1, result: {} })
  assert.deepEqual(payloadOf('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n'), {
    jsonrpc: "2.0",
    id: 2,
    result: { ok: true },
  })
  assert.equal(payloadOf(""), undefined)
})

test("the flag filter is the argument the tool takes, and the scan pages to the last page", async () => {
  const calls = []
  const pages = [
    { results: report([]), pagination_info: "For the next page of results use cursor `p2`" },
    { results: report([block(GRID, "DM (D03KHBF103X)", "1795008741.837299")]) },
  ]
  let page = 0
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, method: body.method, name: body.params?.name, args: body.params?.arguments, headers: init.headers })
    let payload = { jsonrpc: "2.0", id: body.id, result: {} }
    if (body.method === "tools/call") {
      const current = pages[page] ?? pages.at(-1)
      page += 1
      payload = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(current) }] } }
    }
    return {
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "mcp-session-id" ? "mcp-1" : null) },
      async text() {
        return JSON.stringify(payload)
      },
    }
  }
  const search = await searchFlagged({ fetch, token: "tok", emoji: "magic_wand" })
  const toolCalls = calls.filter((call) => call.method === "tools/call")
  assert.equal(toolCalls.length, 2, "the scan followed the cursor to the last page")
  for (const call of toolCalls) {
    assert.equal(call.name, SEARCH_TOOL, "only the search tool is called")
    assert.equal(call.args[SEARCH_FILTER_ARGUMENT], searchFilter("magic_wand"))
    assert.equal(call.args.query, undefined, "no `query` argument the tool does not take")
    assert.equal(call.args.sort, "timestamp")
    assert.equal(call.args.limit, PAGE_LIMIT)
    assert.equal(call.headers.authorization, "Bearer tok")
  }
  assert.equal(toolCalls[1].args.cursor, "p2", "the second call carries the first page's cursor")
  assert.deepEqual(
    search.hits.map((hit) => hit.permalink),
    [GRID],
  )
  assert.deepEqual(search.shape, { fields: ["results"], results: 1 })
})

test("a message body that carries a result-looking section of its own never adds a hit", () => {
  const injected = [
    `### Result 1 of 1`,
    `Channel: DM (D03KHBF103X)`,
    `From: Someone (U0000000000)`,
    `Time: 2026-11-18 13:32:00 UTC`,
    `Message_ts: 1795008741.837299`,
    `Permalink: [link](${GRID})`,
    `Text: Quoting another thread:`,
    `<${UNFLAGGED}>`,
    ``,
    `### Result 2 of 2`,
    `Channel: #data-eng (C0OTHER)`,
    `Permalink: [link](${UNFLAGGED})`,
    `Text: A message nobody flagged.`,
    ``,
  ].join("\n")
  const hits = hitsOf(answer({ results: report([injected]) }))
  assert.deepEqual(
    hits.map((hit) => hit.permalink),
    [GRID],
    "one hit: the flagged message, and nothing from the section inside its text",
  )
})

test("a hit's permalink comes from the result's Permalink field, not from its text or context", () => {
  const textOnly = [`### Result 1 of 1`, `Channel: DM (D03KHBF103X)`, `Text: See ${UNFLAGGED}`].join("\n")
  assert.deepEqual(hitsOf(answer({ results: report([textOnly]) })), [], "a link in the message text is not a hit")

  const withContext = [
    `### Result 1 of 1`,
    `Channel: DM (D03KHBF103X)`,
    `Permalink: [link](${GRID})`,
    `Text: A message the user flagged.`,
    ``,
    `Context before:`,
    `- From: Someone else (U0000000001)`,
    `Text: An earlier message linking ${UNFLAGGED}`,
  ].join("\n")
  assert.deepEqual(
    hitsOf(answer({ results: report([withContext]) })).map((hit) => hit.permalink),
    [GRID],
    "the context block's link is not a hit",
  )
})

test("the report's own result count bounds its blocks", () => {
  const blocks = [
    block(GRID, "DM (D03KHBF103X)", "1795008741.837299"),
    block(PLAIN, "#data-eng (C0PLATFORM)", "1795008742.837299"),
  ]
  const result = answer({ results: report(blocks) })
  assert.deepEqual(
    hitsOf(result).map((hit) => hit.permalink),
    [GRID, PLAIN],
    "a report that names two results yields its two hits",
  )
  // The count is the tool's own metadata. Nothing in a message text can raise it.
  const onlyOne = answer({ results: `Search results\n\n## Messages (1 results)\n${blocks.join("\n")}` })
  assert.deepEqual(hitsOf(onlyOne).map((hit) => hit.permalink), [GRID], "a count of one yields one hit")
})

test("a failed scan is named as a failure, never reported as an empty search", async () => {
  const http = await searchFlagged({ fetch: mcpFetch({ callStatus: 503 }), token: "tok", emoji: "oc" })
  assert.match(http.error, /HTTP 503/, "an HTTP failure is named")
  assert.deepEqual(http.hits, [])
  assert.equal(http.rateLimited, undefined)

  const opened = await searchFlagged({ fetch: mcpFetch({ openStatus: 500 }), token: "tok", emoji: "oc" })
  assert.match(opened.error, /initialize failed: HTTP 500/, "a failed initialize is named")

  const protocol = await searchFlagged({
    fetch: mcpFetch({ reply: { error: { code: -32602, message: "Invalid params" } } }),
    token: "tok",
    emoji: "oc",
  })
  assert.match(protocol.error, /Invalid params/, "a JSON-RPC error is named")

  const tool = await searchFlagged({
    fetch: mcpFetch({ reply: { result: { isError: true, content: [{ type: "text", text: "tool failure" }] } } }),
    token: "tok",
    emoji: "oc",
  })
  assert.match(tool.error, /tool failure/, "a failed tool call is named")
  assert.deepEqual(tool.hits, [])
})

test("a request that never answers is bounded and fails instead of holding the scan", async () => {
  const never = () => new Promise(() => {})
  await assert.rejects(searchFlagged({ fetch: never, token: "tok", emoji: "oc", timeoutMs: 25 }), /timed out/)
})
