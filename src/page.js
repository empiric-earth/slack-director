// The overview dialog's own logic: the state of one item, the order of the rows,
// the text of every line the dialog and the sidebar show, and the colour role
// each part of a row takes from the theme.
//
// Everything here reads only its arguments, so the node suite drives it with
// fixed items and fixed session data and asserts the text a person sees. The
// TUI part turns these lines into elements; nothing here touches a terminal.

/** Where each column of the table starts, as the approved layout lays it out. */
export const COLUMNS = { marker: 0, state: 2, asker: 13, item: 30, issue: 69, channel: 76, age: 94 }

/** The dialog's title, and the name of its palette entry. */
export const PAGE_TITLE = "Slack Director"

/** The dialog's size, as the host's own dialog sizes name it. */
export const DIALOG_SIZE = "xlarge"

/** The keys the dialog answers, as its own help line shows them. */
export const KEY_HELP =
  "↑↓ move · [enter] open session · [i]ssue · [s]lack · [r]efresh · s[e]ttings · [esc] close"

/** The two colour roles a part of the dialog takes from the theme. */
export const ATTENTION = "attention"
export const DIMMED = "dimmed"

/** The glyph the STATE column draws for each state. */
const GLYPH = { waiting: "●", working: "◐", idle: "○" }

/** The display order of the states: waiting first, then working, then idle. */
const ORDER = ["waiting", "working", "idle"]

/** One cell of a line: its column, and the text it holds. */
const cell = (start, text) => [start, text]

/**
 * A line of cells, each starting at its own column. A cell that would reach the
 * next column is pushed right, so at least one space always separates two
 * columns whatever the cell lengths are.
 */
function columnsText(cells) {
  let line = ""
  for (const [start, text] of cells) {
    const at = line === "" ? start : Math.max(start, line.length + 1)
    if (line.length < at) line += " ".repeat(at - line.length)
    line += text
  }
  return line
}

/** A value that fits its column, shortened with an ellipsis when it does not. */
function clip(text, width) {
  const value = typeof text === "string" ? text : String(text ?? "")
  if (value.length <= width) return value
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

/** The width a column's value may use, one space short of the next column. */
const widthBefore = (start, next) => next - start - 1

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

/**
 * The row the selection marker sits on after one move: down from the last row
 * is the first, up from the first is the last, and an empty table has none.
 */
export function moveSelection(index, count, step) {
  if (!Number.isInteger(count) || count <= 0) return 0
  const from = Number.isInteger(index) ? index : 0
  return (((from + step) % count) + count) % count
}

/** The item the keys act on: the row the marker marks. */
export function selectedItem(rows, index) {
  const row = (rows ?? [])[index ?? 0]
  return row?.item
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

/**
 * The name part of an asker. Slack reports the display name with an id or an
 * address beside it — `Maria Costa (U123)`, `André Almeida <a@example.com>` —
 * and the session writes the issue title from the name alone, so the two agree
 * only on this part.
 */
export function askerName(asker) {
  const text = typeof asker === "string" ? asker.trim() : ""
  return text.replace(/\s*[<(][^>)]*[>)]\s*$/, "").trim()
}

/** Whether the record already names the intake issue its title comes from. */
function hasIssue(item) {
  if (typeof item?.issueNumber === "number") return true
  return typeof item?.issueUrl === "string" && item.issueUrl !== ""
}

/**
 * The asker an item's own title carries, for a record an earlier build left
 * without one. The issue's title is `<asker> — <short paraphrase>`, and an
 * item's title becomes the issue's own title exactly when its first turn has
 * named the issue; so the part before the first ` — ` of a titled item is the
 * asker. A record that names no issue still holds the neutral title the watcher
 * gave it — `Flagged message in <channel> — …`, whose dash separates the channel
 * from the asker or the flag's own time — so that title is read as carrying no
 * asker.
 */
function titleAsker(item) {
  if (!hasIssue(item)) return { raw: "", name: "" }
  const title = typeof item?.title === "string" ? item.title : ""
  const at = title.indexOf(" — ")
  if (at <= 0) return { raw: "", name: "" }
  const raw = title.slice(0, at).trim()
  return { raw, name: askerName(raw) }
}

/**
 * The ASKER cell: the name part of the asker the search reported, so the id or
 * the address beside it is not shown — or, for a record an earlier build left
 * without an asker, the asker its own title carries.
 */
export function itemAsker(item) {
  const stored = askerName(item?.asker)
  if (stored !== "") return stored
  return titleAsker(item).name
}

/**
 * The ITEM cell: the session's own title without the asker's part, so ASKER is
 * not shown twice. The asker the search reported may carry an id or an address
 * the session left out of the title, and a record an earlier build left may
 * carry no asker at all, so every form the record holds is tried.
 */
export function itemTitle(item) {
  const title = typeof item?.title === "string" ? item.title : ""
  if (title === "") return title
  const stored = typeof item?.asker === "string" ? item.asker.trim() : ""
  const fromTitle = stored === "" ? titleAsker(item) : { raw: "", name: "" }
  for (const form of new Set([stored, askerName(stored), fromTitle.raw, fromTitle.name])) {
    if (form === "") continue
    const prefix = `${form} — `
    if (title.startsWith(prefix)) return title.slice(prefix.length)
  }
  return title
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
 * title, its intake issue, its channel and the age of the flag. No Slack
 * message text is in the dialog: the title is the session's own.
 */
export function rowText(item, state, options = {}) {
  const now = options.now ?? Date.now()
  return columnsText([
    cell(COLUMNS.marker, options.selected ? "▸" : " "),
    cell(COLUMNS.state, `${GLYPH[state] ?? " "} ${state}`),
    cell(COLUMNS.asker, clip(itemAsker(item), widthBefore(COLUMNS.asker, COLUMNS.item))),
    cell(COLUMNS.item, clip(itemTitle(item), widthBefore(COLUMNS.item, COLUMNS.issue))),
    cell(COLUMNS.issue, clip(issueLabel(item), widthBefore(COLUMNS.issue, COLUMNS.channel))),
    cell(COLUMNS.channel, clip(item.channel, widthBefore(COLUMNS.channel, COLUMNS.age))),
    cell(COLUMNS.age, ageText(item.flaggedAt, now)),
  ])
}

/** The counts line: how many items the dialog holds, by state. */
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

/**
 * The colour role of one part of the dialog, from the theme's two roles:
 * `attention` for what the user has to look at — a waiting row, the row the
 * marker marks, a workspace that failed — and `dimmed` for everything else.
 */
export function colourRole(part, options = {}) {
  if (part === "row") {
    if (options.selected) return ATTENTION
    return options.state === "waiting" ? ATTENTION : DIMMED
  }
  if (part === "mark") return options.ok === false ? ATTENTION : DIMMED
  return DIMMED
}

/**
 * The header's right part in segments, each with its colour role: the last
 * poll, its outcome, and every workspace with its mark, so a failing workspace
 * stands out and the rest is dimmed.
 */
export function headerParts(status) {
  const parts = [
    { text: `last poll ${pollClock(status?.lastPoll)}`, role: DIMMED },
    { text: " · ", role: DIMMED },
    { text: status?.outcome ?? "unknown", role: DIMMED },
  ]
  for (const workspace of status?.workspaces ?? []) {
    parts.push({ text: " · ", role: DIMMED })
    parts.push({ text: `${workspace.name} `, role: DIMMED })
    parts.push({ text: workspace.ok ? "✓" : "✗", role: colourRole("mark", { ok: workspace.ok }) })
    if (workspace.error) parts.push({ text: ` ${workspace.error}`, role: DIMMED })
  }
  return parts
}

/** The header's right part as one line. */
export function headerText(status) {
  return headerParts(status)
    .map((part) => part.text)
    .join("")
}

/** The today line: the day's counts the status carries. */
export function todayText(status) {
  const today = status?.today ?? {}
  return `Today: flagged ${today.flagged ?? 0} · next steps posted ${today.nextStepsPosted ?? 0} · ${today.skipped ?? 0} hit skipped`
}

/**
 * The command the operating system's own opener runs for a URL, or undefined
 * for anything that is not an http or https address. The opener is given the
 * URL parser's own form of the string, and it is spawned without a shell: on
 * Windows `cmd` is never used, because it re-reads `&`, `^` and `|` inside a
 * URL as its own operators and would run whatever a reply put there. `rundll32`
 * hands the address to the registered protocol handler as one argument, with no
 * shell to re-parse it. The TUI plugin API has no URL opener of its own.
 */
export function openerCommand(url, platform = process.platform) {
  const address = webAddress(url)
  if (!address) return undefined
  if (platform === "darwin") return { command: "open", args: [address] }
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", address] }
  return { command: "xdg-open", args: [address] }
}

/**
 * An http or https address as the URL parser writes it, or undefined for
 * anything else: another scheme, or text the parser refuses. The parser's form
 * holds only what a URL may hold — a quote, a space or a line break in the text
 * comes back percent-encoded or dropped — so no text a reply carries reaches an
 * opener as it stands.
 */
function webAddress(url) {
  if (typeof url !== "string") return undefined
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  return parsed.href
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
