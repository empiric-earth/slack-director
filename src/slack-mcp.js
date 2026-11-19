// The Slack MCP client: the one Slack call the watcher makes.
//
// The transport is MCP over HTTP: `initialize`, `notifications/initialized`
// and `tools/call`, with the resolved access token as a bearer header. The
// token never leaves the request headers: it is not logged, not returned and
// not carried in an error.
//
// The search tool answers with one markdown report under `results` and the next
// page's cursor in a `pagination_info` line, and a result's permalink may sit
// on an Enterprise Grid host, so a hit's channel and timestamp are read out of
// the permalink itself.
export const SLACK_MCP_URL = "https://mcp.slack.com/mcp"

/** The only Slack tool this plugin calls. */
export const SEARCH_TOOL = "slack_search_public_and_private"

/** The search argument the flagged-message filter travels in. */
export const SEARCH_FILTER_ARGUMENT = "filters"

/** Slack search sorts by message time or by score; the flag scan wants time. */
export const SORT_BY = "timestamp"

/** Slack returns at most twenty results per page. */
export const PAGE_LIMIT = 20

const PROTOCOL_VERSION = "2025-06-18"
const CLIENT = { name: "slack-director", version: "0.1.0" }

// A Slack message permalink, on a workspace host or an Enterprise Grid host:
// https://nexar.slack.com/... and https://grid-nauto.enterprise.slack.com/...
const PERMALINK = /https:\/\/[a-z0-9][a-z0-9.-]*\.slack\.com\/archives\/[A-Z0-9]+\/p\d{10,}(\?[^\s)"'<]*)?/g
const ARCHIVE = /^https:\/\/[a-z0-9][a-z0-9.-]*\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})(\?.*)?$/
const RESULT_MARKER = /^#{2,3}[ \t]*Result[ \t]+\d+/gm
const CHANNEL_LINE = /^Channel:[ \t]*(.*)$/m
const CURSOR_LINE = /cursor[^`\n]*`([^`]+)`/i

/** The flag filter: the messages the user reacted to with the flag emoji. */
export function searchFilter(emoji) {
  return `hasmy::${emoji}:`
}

/** The JSON-RPC body of an answer, from a JSON body or from an SSE body. */
export function payloadOf(text) {
  const trimmed = (text ?? "").trim()
  if (trimmed === "") return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // An SSE answer carries one JSON object per `data:` line.
  }
  let last
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^data:\s?(.*)$/.exec(line)
    if (!match) continue
    try {
      last = JSON.parse(match[1])
    } catch {
      continue
    }
  }
  return last
}

/** Every Slack message permalink in a text. */
export function permalinksIn(text) {
  return typeof text === "string" ? (text.match(PERMALINK) ?? []) : []
}

/** The channel id and message timestamp a Slack permalink carries. */
export function parsePermalink(permalink) {
  const match = ARCHIVE.exec(permalink ?? "")
  if (!match) return undefined
  const digits = match[2]
  return {
    permalink,
    channel: { id: match[1], label: match[1] },
    ts: digits.length > 10 ? `${digits.slice(0, 10)}.${digits.slice(10)}` : digits,
  }
}

/** The JSON object a tool result carries, from its structured or text content. */
export function resultPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent
  const text = textOf(result?.content).find((part) => part.trim() !== "")
  if (text === undefined) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text)
}

/** One block per `### Result` marker in a report, else the whole report. */
function resultBlocks(text) {
  const parts = text.split(RESULT_MARKER)
  return parts.length > 1 ? parts.slice(1) : [text]
}

function hitOfRow(row) {
  if (row === null || typeof row !== "object") return undefined
  const permalink =
    typeof row.permalink === "string" ? row.permalink : permalinksIn(typeof row.text === "string" ? row.text : "")[0]
  const hit = parsePermalink(permalink)
  if (!hit) return undefined
  const label = row.channel_name ?? row.channel ?? row.channel_id
  if (typeof label === "string" && label.trim() !== "") hit.channel.label = label.trim()
  return hit
}

function hitOfBlock(block) {
  const hit = parsePermalink(permalinksIn(block)[0])
  if (!hit) return undefined
  const line = CHANNEL_LINE.exec(block)
  if (line) {
    const name = /^(?:#|@)?([^\s(]+)/.exec(line[1].trim())
    if (name && name[1] !== "") hit.channel.label = line[1].trim().startsWith("#") ? `#${name[1]}` : name[1]
  }
  return hit
}

function dedupe(hits) {
  const seen = new Set()
  const out = []
  for (const hit of hits) {
    if (seen.has(hit.permalink)) continue
    seen.add(hit.permalink)
    out.push(hit)
  }
  return out
}

/** The hits a search result carries, from its rows or from its report's blocks. */
export function hitsOf(result) {
  const payload = resultPayload(result)
  const rows = [payload.messages, payload.results, payload.hits].find(Array.isArray) ?? []
  const fromRows = dedupe(rows.map(hitOfRow).filter(Boolean))
  if (fromRows.length > 0) return fromRows
  const blocks = [payload.results, payload.messages, payload.hits, ...textOf(result?.content)]
    .filter((value) => typeof value === "string")
    .flatMap(resultBlocks)
  return dedupe(blocks.map(hitOfBlock).filter(Boolean))
}

/** The next page's cursor: a `next_cursor` field, or the backticked token a pagination line carries. */
export function cursorOf(result) {
  const payload = resultPayload(result)
  const direct = payload.next_cursor ?? payload.cursor
  if (typeof direct === "string" && direct !== "") return direct
  const sources = [...Object.values(payload), ...textOf(result?.content)].filter((value) => typeof value === "string")
  for (const source of sources) {
    const match = CURSOR_LINE.exec(source)
    if (match) return match[1]
  }
  return undefined
}

/** The field names and result-block count of an answer, for a log line that carries no Slack text. */
export function shapeOf(result) {
  const payload = resultPayload(result)
  const blocks = typeof payload.results === "string" ? [...payload.results.matchAll(RESULT_MARKER)].length : 0
  return { fields: Object.keys(payload), results: blocks }
}

function rateLimited(result) {
  if (result?.isError !== true) return false
  return /rate.?limit/i.test(textOf(result.content).join("\n"))
}

async function post({ fetch, url, token, sessionID, body }) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionID) headers["mcp-session-id"] = sessionID
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  const text = await response.text()
  return {
    status: response.status,
    sessionID: response.headers.get("mcp-session-id") || sessionID,
    payload: payloadOf(text),
  }
}

/**
 * Search one workspace for the messages the user flagged, paging to the last
 * page. Returns the hits, whether the scan ended early because Slack rate
 * limited it or refused the credential, and the last answer's shape.
 */
export async function searchFlagged({ fetch, url = SLACK_MCP_URL, token, emoji, limit = PAGE_LIMIT }) {
  const opened = await post({
    fetch,
    url,
    token,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT },
    },
  })
  if (opened.status === 401) return { unauthorized: true, hits: [], shape: { fields: [], results: 0 } }
  if (opened.status === 429) return { rateLimited: true, hits: [], shape: { fields: [], results: 0 } }
  const sessionID = opened.sessionID
  await post({
    fetch,
    url,
    token,
    sessionID,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  })

  const hits = []
  let shape = { fields: [], results: 0 }
  let cursor
  let id = 2
  for (;;) {
    const args = { [SEARCH_FILTER_ARGUMENT]: searchFilter(emoji), sort: SORT_BY, sort_dir: "desc", limit }
    if (cursor) args.cursor = cursor
    const call = await post({
      fetch,
      url,
      token,
      sessionID,
      body: { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: SEARCH_TOOL, arguments: args } },
    })
    if (call.status === 401) return { unauthorized: true, hits, shape }
    if (call.status === 429) return { rateLimited: true, hits, shape }
    const result = call.payload?.result
    // Any other answer ends this workspace's scan for this poll.
    if (!result) return { hits, shape }
    if (rateLimited(result)) return { rateLimited: true, hits, shape }
    shape = shapeOf(result)
    hits.push(...hitsOf(result))
    const next = cursorOf(result)
    if (!next || next === cursor) break
    cursor = next
  }
  return { hits, shape }
}
