// The overview page's own logic: the state of one item, the order of the rows
// and the text of every line the page and the sidebar show.
//
// Everything here reads only its arguments, so the node suite drives it with
// fixed items and fixed session data and asserts the text a person sees. The
// TUI part turns these lines into elements; nothing here touches a terminal.

/** Where each column of the table starts, as the approved layout lays it out. */
export const COLUMNS = { marker: 0, state: 2, asker: 13, item: 30, issue: 69, channel: 76, age: 94 }

/** The page's title, and the name of its palette entry. */
export const PAGE_TITLE = "Slack Director"

/** The keys the page answers, as its own help line shows them. */
export const KEY_HELP = "enter open session · i open issue · s open in Slack · r poll now · , settings · esc back"

/** The glyph the STATE column draws for each state. */
const GLYPH = { waiting: "●", working: "◐", idle: "○" }

/** The display order of the states: waiting first, then working, then idle. */
const ORDER = ["waiting", "working", "idle"]

/** One cell of a line, in the order the columns are drawn. */
const cell = (start, text) => [start, text]

/** A line of cells, each starting at its own column. */
function columnsText(cells) {
  let line = ""
  for (const [start, text] of cells) {
    if (line.length < start) line += " ".repeat(start - line.length)
    line += text
  }
  return line
}

/** A value that fits its column, shortened with an ellipsis when it does not. */
function clip(text, width) {
  const value = typeof text === "string" ? text : String(text ?? "")
  if (value.length <= width) return value
  return `${value.slice(0, width - 1)}…`
}

/**
 * One item's state, the first match winning:
 *
 * - `waiting` while a permission request is pending — a session that is still
 *   running can have one, and that is what the user has to answer;
 * - `working` while the session runs, its first turn or a later one the user
 *   resumed;
 * - `waiting` while the user has not opened the item yet, so its first turn's
 *   findings are still unread;
 * - `idle` once the user has opened it and it stays quiet.
 *
 * `live` is what the TUI knows about the item's session: `running`, and the
 * number of `pending` permission requests.
 */
export function stateOf(item, live = {}) {
  const pending = item.permissionPending === true || (live.pending ?? 0) > 0
  if (pending) return "waiting"
  if (live.running === true) return "working"
  if (!item.openedAt) return "waiting"
  return "idle"
}

/** Every item as one row: the item and its state, in display order. */
export function pageRows(items, liveOf = () => ({})) {
  return (items ?? [])
    .map((item) => ({ item, state: stateOf(item, liveOf(item) ?? {}) }))
    .sort((left, right) => {
      const byState = ORDER.indexOf(left.state) - ORDER.indexOf(right.state)
      if (byState !== 0) return byState
      return flaggedAt(right.item) - flaggedAt(left.item)
    })
}

function flaggedAt(item) {
  const at = Date.parse(item?.flaggedAt)
  return Number.isNaN(at) ? 0 : at
}

/** How long ago the flag was made, in the units the mock uses: minutes, then hours, then days. */
export function ageText(flaggedAt, now = Date.now()) {
  const from = Date.parse(flaggedAt)
  if (Number.isNaN(from)) return "—"
  const minutes = Math.max(0, Math.floor((now - from) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The ISSUE cell: the intake issue's number, or a dash while there is none. */
export function issueLabel(item) {
  return typeof item?.issueNumber === "number" ? `#${item.issueNumber}` : "—"
}

/** The table's header line. */
export function tableHeaderText() {
  return columnsText([
    cell(COLUMNS.state, "STATE"),
    cell(COLUMNS.asker, "ASKER"),
    cell(COLUMNS.item, "ITEM"),
    cell(COLUMNS.issue, "ISSUE"),
    cell(COLUMNS.channel, "CHANNEL"),
    cell(COLUMNS.age, "AGE"),
  ])
}

/**
 * One row's line: the selection marker, the state, then the item's asker, its
 * session title, its intake issue, its channel and the age of the flag. No
 * Slack message text is on the page: the title is the session's own.
 */
export function rowText(item, state, options = {}) {
  const now = options.now ?? Date.now()
  return columnsText([
    cell(COLUMNS.marker, options.selected ? "▸" : " "),
    cell(COLUMNS.state, `${GLYPH[state] ?? " "} ${state}`),
    cell(COLUMNS.asker, clip(item.asker, COLUMNS.item - COLUMNS.asker)),
    cell(COLUMNS.item, clip(item.title, COLUMNS.issue - COLUMNS.item)),
    cell(COLUMNS.issue, clip(issueLabel(item), COLUMNS.channel - COLUMNS.issue)),
    cell(COLUMNS.channel, clip(item.channel, COLUMNS.age - COLUMNS.channel)),
    cell(COLUMNS.age, ageText(item.flaggedAt, now)),
  ])
}

/** The counts line: how many items the page holds, by state. */
export function countsText(rows) {
  const of = (state) => (rows ?? []).filter((row) => row.state === state).length
  return `${(rows ?? []).length} flagged · ${of("working")} working · ${of("waiting")} waiting for you · ${of("idle")} idle`
}

/** The sidebar's one line. */
export function sidebarText(rows) {
  const of = (state) => (rows ?? []).filter((row) => row.state === state).length
  return `${PAGE_TITLE}  ${of("waiting")} waiting · ${of("working")} working`
}

/** The last poll's time on the local clock, so it reads against the user's own. */
export function pollClock(lastPoll) {
  if (typeof lastPoll !== "string") return "never"
  const at = new Date(lastPoll)
  if (Number.isNaN(at.getTime())) return "never"
  return [at.getHours(), at.getMinutes()].map((value) => String(value).padStart(2, "0")).join(":")
}

/** The header's right part: the last poll, its outcome and each workspace. */
export function headerText(status) {
  const workspaces = (status?.workspaces ?? []).map(
    (workspace) => `${workspace.name} ${workspace.ok ? "✓" : "✗"}${workspace.error ? ` ${workspace.error}` : ""}`,
  )
  return [`last poll ${pollClock(status?.lastPoll)}`, status?.outcome ?? "unknown", ...workspaces].join(" · ")
}

/** The today line: the day's counts the status carries. */
export function todayText(status) {
  const today = status?.today ?? {}
  return `Today: flagged ${today.flagged ?? 0} · next steps posted ${today.nextStepsPosted ?? 0} · ${today.skipped ?? 0} hit skipped`
}

/**
 * The command the operating system's own opener runs for a URL, or undefined
 * for anything that is not an http or https address. The TUI plugin API has no
 * URL opener of its own.
 */
export function openerCommand(url, platform = process.platform) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined
  if (platform === "darwin") return { command: "open", args: [url] }
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] }
  return { command: "xdg-open", args: [url] }
}

/** A field's current value as the settings dialog's prompt offers it to edit. */
export function settingsValue(field, value) {
  if (field === "work_hours") return JSON.stringify(value)
  return value === undefined || value === null ? "" : String(value)
}

/**
 * The value the settings dialog sends for a field, from the text the user
 * typed. Only the field's own type is read here: an unusable value reaches the
 * server part, which refuses it and leaves the file alone.
 */
export function fieldValue(field, text) {
  if (field === "poll_seconds") return Number(text)
  if (field === "work_hours") return JSON.parse(text)
  return text
}
