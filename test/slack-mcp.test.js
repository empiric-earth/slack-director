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
