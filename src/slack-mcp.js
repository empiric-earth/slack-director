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
//
// A hit is read from the result's own field lines only, never from a message's
// text or its context. A message body is untrusted text and may hold a
// permalink or a whole result-looking section of its own, so the position of a
// block inside the report does not show that the block is a result: only the
// first block of a page is the tool's own. Every other block is a candidate,
// and a candidate that no poll has seen is established by searching the same
// page again one result at a time, where each answer's first block is the
// tool's own. A candidate the page does not establish never becomes a hit.
//
// Every request is bounded by a deadline, so one answer that never arrives
// fails its own workspace instead of stopping the poll.
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

/** How long one MCP request, its body read included, may take. */
export const REQUEST_TIMEOUT_MS = 30_000

// A Slack message permalink, on a workspace host or an Enterprise Grid host:
// https://nexar.slack.com/... and https://grid-nauto.enterprise.slack.com/...
const PERMALINK = /https:\/\/[a-z0-9][a-z0-9.-]*\.slack\.com\/archives\/[A-Z0-9]+\/p\d{10,}(\?[^\s)"'<]*)?/g
const ARCHIVE = /^https:\/\/[a-z0-9][a-z0-9.-]*\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})(\?.*)?$/
const RESULT_MARKER = /^#{2,3}[ \t]*Result[ \t]+\d+/gm
const PERMALINK_FIELD = /^Permalink:[ \t]*(.*)$/m
const TEXT_FIELD = /^Text:/
const CHANNEL_LINE = /^Channel:[ \t]*(.*)$/m
const FROM_LINE = /^From:[ \t]*(.*)$/m
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

/** The result blocks of one report, in the order their markers appear. */
function resultBlocks(text) {
  const parts = text.split(RESULT_MARKER)
  return parts.length <= 1 ? [text] : parts.slice(1)
}

/**
 * The trusted metadata lines of a result block: every line up to its `Text:`
 * field. Everything from there on is the message and its context — untrusted
 * text that may hold a permalink of its own.
 */
function blockFields(block) {
  const lines = block.split(/\r?\n/)
  const end = lines.findIndex((line) => TEXT_FIELD.test(line))
  return (end === -1 ? lines : lines.slice(0, end)).join("\n")
}

/**
 * The display name a `From:` line carries, without the id or the address beside
 * it: Slack writes the name and then `(U…)`, `<U…>` or `<address>`.
 */
function askerOf(line) {
  const text = typeof line === "string" ? line.trim() : ""
  if (text === "") return ""
  return (text.replace(/\s*[<(][^>)]*[>)]\s*$/, "") || text).trim()
}

function hitOfRow(row) {
  if (row === null || typeof row !== "object") return undefined
  const permalink =
    typeof row.permalink === "string" ? row.permalink : permalinksIn(typeof row.text === "string" ? row.text : "")[0]
  const hit = parsePermalink(permalink)
  if (!hit) return undefined
  const label = row.channel_name ?? row.channel ?? row.channel_id
  if (typeof label === "string" && label.trim() !== "") hit.channel.label = label.trim()
  const asker = row.user_name ?? row.username ?? row.author
  hit.asker = typeof asker === "string" ? askerOf(asker) : ""
  return hit
}

function hitOfBlock(block) {
  const fields = blockFields(block)
  const field = PERMALINK_FIELD.exec(fields)
  if (!field) return undefined
  const hit = parsePermalink(permalinksIn(field[1])[0])
  if (!hit) return undefined
  const line = CHANNEL_LINE.exec(fields)
  if (line) {
    const name = /^(?:#|@)?([^\s(]+)/.exec(line[1].trim())
    if (name && name[1] !== "") hit.channel.label = line[1].trim().startsWith("#") ? `#${name[1]}` : name[1]
  }
  const from = FROM_LINE.exec(fields)
  hit.asker = from ? askerOf(from[1]) : ""
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

/**
 * What one search answer carries.
 *
 * - `established`: the hits the answer's own structure shows are results — the
 *   rows of an array, or the first block of a report, which comes before any
 *   message text.
 * - `candidates`: every further block's hit. Its block may be a section a
 *   message's text forged, so it is a hit only once the page establishes it.
 * - `blocks`: how many result markers the report holds, forged ones included.
 */
export function pageOf(result) {
  const payload = resultPayload(result)
  const rows = [payload.messages, payload.results, payload.hits].find(Array.isArray) ?? []
  const fromRows = dedupe(rows.map(hitOfRow).filter(Boolean))
  if (fromRows.length > 0) return { established: fromRows, candidates: [], blocks: fromRows.length }
  const fields = [payload.results, payload.messages, payload.hits].filter((value) => typeof value === "string")
  const reports = fields.length > 0 ? fields : textOf(result?.content)
  const blocks = reports.flatMap(resultBlocks)
  const [first, ...rest] = blocks.map(hitOfBlock)
  const established = first ? [first] : []
  const known = new Set(established.map((hit) => hit.permalink))
  const candidates = dedupe(rest.filter(Boolean)).filter((hit) => !known.has(hit.permalink))
  return { established, candidates, blocks: blocks.length }
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

/** A rejection that a caller can cancel, for `Promise.race` against a deadline. */
function deadline(ms, onExpire) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onExpire) onExpire()
      reject(new Error(`Slack request timed out after ${ms} ms`))
    }, ms)
  })
  return { expired, cancel: () => clearTimeout(timer) }
}

/**
 * One MCP request. The deadline covers the whole operation — the request and
 * the read of its body — and aborts the request too when the fetch honours the
 * signal, so one answer that never arrives cannot hold the poll.
 */
async function post({ fetch, url, token, sessionID, body, timeoutMs = REQUEST_TIMEOUT_MS, signal }) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionID) headers["mcp-session-id"] = sessionID
  const controller = new AbortController()
  const { expired, cancel } = deadline(timeoutMs, () => controller.abort())
  // A caller's own stop — the plugin unloading — aborts this request too, so an
  // in-flight read never outlives the instance that started it.
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    const response = await Promise.race([
      fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }),
      expired,
    ])
    const text = await Promise.race([response.text(), expired])
    return {
      status: response.status,
      sessionID: response.headers.get("mcp-session-id") || sessionID,
      payload: payloadOf(text),
    }
  } finally {
    cancel()
    if (signal) signal.removeEventListener("abort", onAbort)
  }
}

/** Why a JSON-RPC answer failed, in one line that carries no message text. */
function answerFailure(answer) {
  if (answer.status < 200 || answer.status >= 300) return `HTTP ${answer.status}`
  const message = answer.payload?.error?.message
  if (typeof message === "string" && message.trim() !== "") return message.trim()
  return "the answer carried no result"
}

/** The one-line message an error tool result carries. */
function toolErrorText(result) {
  const text = textOf(result?.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return text === "" ? "the tool call failed" : text.slice(0, 200)
}

/**
 * Search one workspace for the messages the user flagged, paging to the last
 * page. Returns the hits, whether the scan ended early because Slack rate
 * limited it or refused the credential, why it failed when the transport, the
 * protocol or the tool itself failed, and the last answer's shape.
 *
 * `isSeen` says whether an earlier poll already recorded a permalink. A page
 * with a candidate the poll has not seen is searched again one result at a
 * time (see the top of this file), and only the candidates that walk reaches
 * are returned as hits.
 */
export async function searchFlagged({
  fetch,
  url = SLACK_MCP_URL,
  token,
  emoji,
  limit = PAGE_LIMIT,
  timeoutMs = REQUEST_TIMEOUT_MS,
  isSeen = () => false,
}) {
  const empty = () => ({ fields: [], results: 0 })
  const opened = await post({
    fetch,
    url,
    token,
    timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT },
    },
  })
  if (opened.status === 401) return { unauthorized: true, hits: [], shape: empty() }
  if (opened.status === 429) return { rateLimited: true, hits: [], shape: empty() }
  if (opened.status < 200 || opened.status >= 300 || !opened.payload?.result) {
    return { error: `Slack initialize failed: ${answerFailure(opened)}`, hits: [], shape: empty() }
  }
  const sessionID = opened.sessionID
  await post({
    fetch,
    url,
    token,
    sessionID,
    timeoutMs,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  })

  let id = 2
  /** One search call: the answer's result, or why the scan must stop. */
  async function search(args) {
    const call = await post({
      fetch,
      url,
      token,
      sessionID,
      timeoutMs,
      body: { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: SEARCH_TOOL, arguments: args } },
    })
    if (call.status === 401) return { stop: { unauthorized: true } }
    if (call.status === 429) return { stop: { rateLimited: true } }
    const result = call.payload?.result
    // A transport, protocol or tool failure is not an empty search: the
    // workspace reports it, so a broken scan never reads as healthy.
    if (call.status < 200 || call.status >= 300 || !result) {
      return { stop: { error: `Slack search failed: ${answerFailure(call)}` } }
    }
    if (rateLimited(result)) return { stop: { rateLimited: true } }
    if (result.isError === true) return { stop: { error: `Slack search failed: ${toolErrorText(result)}` } }
    return { result }
  }

  const argsFor = (cursor, size) => {
    const args = { [SEARCH_FILTER_ARGUMENT]: searchFilter(emoji), sort: SORT_BY, sort_dir: "desc", limit: size }
    if (cursor) args.cursor = cursor
    return args
  }

  /**
   * The page that starts at `cursor`, one result per call: the first block of
   * each answer is the tool's own, so every hit this returns is one of the
   * user's flagged messages whatever the messages' text says.
   */
  async function walk(cursor, steps) {
    const found = []
    let at = cursor
    for (let step = 0; step < steps; step += 1) {
      const answered = await search(argsFor(at, 1))
      if (answered.stop) return { stop: answered.stop, found }
      found.push(...pageOf(answered.result).established)
      const next = cursorOf(answered.result)
      if (!next || next === at) break
      at = next
    }
    return { found }
  }

  const hits = []
  let shape = empty()
  let cursor
  for (;;) {
    const answered = await search(argsFor(cursor, limit))
    if (answered.stop) return { ...answered.stop, hits: dedupe(hits), shape }
    const { result } = answered
    shape = shapeOf(result)
    const page = pageOf(result)
    hits.push(...page.established)
    if (page.candidates.some((candidate) => !isSeen(candidate.permalink))) {
      const walked = await walk(cursor, Math.min(page.blocks, limit))
      hits.push(...walked.found)
      if (walked.stop) return { ...walked.stop, hits: dedupe(hits), shape }
    } else {
      hits.push(...page.candidates)
    }
    const next = cursorOf(result)
    if (!next || next === cursor) break
    cursor = next
  }
  return { hits: dedupe(hits), shape }
}

/** The Slack tools the poller reads conversations with. */
export const READ_THREAD_TOOL = "slack_read_thread"
export const READ_CHANNEL_TOOL = "slack_read_channel"

/** The poller follows a read's next cursor for at most this many pages. */
export const READ_PAGES = 5

/**
 * The read answer's detail level. The default (`detailed`) is the only one that
 * carries each message's `Message TS:` line; `concise` drops it, so the reader
 * asks for `detailed` explicitly.
 */
export const READ_FORMAT = "detailed"

// A Slack message timestamp: `seconds.microseconds`, ten digits before the dot.
const TS_FORM = /^\d{10}\.\d{6}$/

// The one line a read report gives a message's timestamp on: the field at the
// start of a line, with nothing before it and nothing after the timestamp. A
// message's body is quoted or indented, so a timestamp-looking line inside it
// never matches.
const MESSAGE_TS_LINE = /^message[\s_]*ts\s*[:=]\s*(\d{10}\.\d{6})\s*$/i

/** Whether a value is in Slack's `ts` form. */
export function isTimestamp(value) {
  return typeof value === "string" && TS_FORM.test(value)
}

/**
 * Every Slack `ts` value an answer carries. The live read answers are a JSON
 * object whose `messages` field is one text report: each message's timestamp
 * sits on its own `Message TS: <ts>` line, and the thread root carries none of
 * the door fields. So the reader takes both routes — a `..._ts` field of a
 * structured answer, and a `Message TS:` line of a report — and never a value
 * that is not in Slack's `ts` form. A message's text is not read for timestamps
 * beyond that final anchored line.
 */
export function timestampsOf(result) {
  const out = []
  const collectField = (value, key) => {
    if (typeof value === "string") {
      if (/(^|_)ts$/.test(key ?? "") && TS_FORM.test(value)) out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collectField(item, undefined)
      return
    }
    if (value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) collectField(child, name)
    }
  }
  const payload = resultPayload(result)
  collectField(payload, undefined)
  for (const text of reportTexts(result, payload)) collectTsLines(text, out)
  return out
}

/** Every text a read answer carries its report in: each string field, and the raw content. */
function reportTexts(result, payload) {
  const texts = []
  const walk = (value) => {
    if (typeof value === "string") {
      texts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) walk(child)
    }
  }
  walk(payload)
  for (const text of textOf(result?.content)) texts.push(text)
  return texts
}

/** The `Message TS:` values a report text gives, one per line. */
function collectTsLines(text, out) {
  if (typeof text !== "string") return
  for (const line of text.split(/\r?\n/)) {
    const match = MESSAGE_TS_LINE.exec(line)
    if (match) out.push(match[1])
  }
}

/** The newest of a list of Slack `ts` values, or undefined. */
export function newestTs(values) {
  let newest
  for (const value of values ?? []) {
    if (!isTimestamp(value)) continue
    if (newest === undefined || Number(value) > Number(newest)) newest = value
  }
  return newest
}

// The fields a read answer carries its report in. The live read answers are one
// JSON object with `messages`; a search answer uses `results` or `hits`. An
// answer with none of them — or with a value that is not a report — is not a
// report this reader understands.
const READ_REPORT_FIELDS = ["messages", "results", "hits"]

// A report text the live read answers give for a conversation with no message.
const EMPTY_REPORT = /^no\s+(?:thread\s+)?mess+ages?\b/i

/** Whether a report field is one this reader recognizes as holding no message. */
function emptyReport(value) {
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "string") return value.trim() === "" || EMPTY_REPORT.test(value.trim())
  return false
}

/**
 * Whether a read answer is one this reader understands: it yields at least one
 * Slack `ts`, or a report field it recognizes as empty. A report field that
 * holds content but no timestamp is a format the reader does not know, so it is
 * unreadable rather than empty.
 */
export function readableAnswer(result) {
  if (timestampsOf(result).length > 0) return true
  const payload = resultPayload(result)
  return READ_REPORT_FIELDS.some((field) => emptyReport(payload[field]))
}

/**
 * Read one conversation through the Slack MCP server and answer the Slack `ts`
 * values it holds, following the answer's next cursor for at most `pages`
 * pages. Read-only: the only tool called is the one named. An answer that
 * cannot be read is a failed read, and it is named in the answer rather than
 * thrown, so one bad read never stops the cycle.
 */
export async function readMessages({
  fetch,
  url = SLACK_MCP_URL,
  token,
  tool,
  args,
  pages = READ_PAGES,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal,
}) {
  const opened = await post({
    fetch,
    url,
    token,
    timeoutMs,
    signal,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT },
    },
  })
  if (opened.status === 401) return { unauthorized: true, timestamps: [] }
  if (opened.status === 429) return { rateLimited: true, timestamps: [] }
  if (opened.status < 200 || opened.status >= 300 || !opened.payload?.result) {
    return { error: `Slack initialize failed: ${answerFailure(opened)}`, timestamps: [] }
  }
  const sessionID = opened.sessionID
  await post({
    fetch,
    url,
    token,
    sessionID,
    timeoutMs,
    signal,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  })

  const timestamps = []
  let cursor
  let id = 2
  for (let page = 0; page < pages; page += 1) {
    const callArgs = cursor ? { ...args, cursor } : { ...args }
    const call = await post({
      fetch,
      url,
      token,
      sessionID,
      timeoutMs,
      signal,
      body: { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: tool, arguments: callArgs } },
    })
    if (call.status === 401) return { unauthorized: true, timestamps }
    if (call.status === 429) return { rateLimited: true, timestamps }
    const result = call.payload?.result
    if (call.status < 200 || call.status >= 300 || !result) {
      return { error: `Slack read failed: ${answerFailure(call)}`, timestamps }
    }
    if (rateLimited(result)) return { rateLimited: true, timestamps }
    if (result.isError === true) return { error: `Slack read failed: ${toolErrorText(result)}`, timestamps }
    // A successful answer that carries no report the reader understands is a
    // failed read, not an empty one: the watermark must not move on it. A
    // changed report format must not make polling look healthy.
    if (!readableAnswer(result)) return { error: "Slack read failed: the answer could not be read", timestamps }
    timestamps.push(...timestampsOf(result))
    const next = cursorOf(result)
    if (!next || next === cursor) break
    cursor = next
  }
  return { timestamps }
}
