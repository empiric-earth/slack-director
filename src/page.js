// The overview dialog's own logic: the state of one item, the order of the rows,
// the text of every line the dialog and the sidebar show, and the colour role
// each part of a line takes from the theme.
//
// A line is a list of parts, each carrying its text and the name of the colour
// role it takes. The TUI part turns a role into the theme's own colour and a
// part into an element; nothing here touches a terminal or reads a theme, so the
// node suite drives it with fixed items, a fixed clock and a fixed window.
import { workingDayMinutes, workingMinutesBetween } from "./work-hours.js"

/** The dialog's title, and the name of its palette entry. */
export const PAGE_TITLE = "Slack Director"

/** The dialog's size, as the host's own dialog sizes name it. */
export const DIALOG_SIZE = "xlarge"

/** The side inset the host's own list dialog gives its title, header and footer lines. */
export const DIALOG_INSET = 3

/** The inset the host's own list dialog gives its rows and section headers. */
export const DIALOG_LIST_INSET = 4

/** The mark each state shows, and the only place a state colour is used. */
export const STATE_MARK = { waiting: "●", working: "◐", idle: "○" }

/** The display order of the states: waiting first, then working, then idle. */
export const STATE_ORDER = ["waiting", "working", "idle"]

/** The section header of each state. */
export const SECTION_TITLE = { waiting: "Waiting for you", working: "Working", idle: "Idle" }

/** How long a flag may age before its AGE colour warns: four working hours. */
export const AGE_WARNING_MINUTES = 4 * 60

/** The widths the row's columns take, so long values are shortened with an ellipsis. */
export const ROW_WIDTHS = { item: 44, asker: 15, channel: 16, issue: 6, age: 4 }

/** One part of a line: its text, the colour role it takes, and whether it is bold. */
const part = (text, role = "none", bold = false) => ({ text, role, bold })

/** A line's parts as the one string a person reads. */
export const partsText = (parts) => (parts ?? []).map((entry) => entry.text).join("")

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
      const byState = STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
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

/** The issue cell: the intake issue's number, or a dash while there is none. */
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

/** A value that fits its column, shortened with an ellipsis when it does not. */
function clip(text, width) {
  const value = typeof text === "string" ? text : String(text ?? "")
  if (value.length <= width) return value
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

/** A value padded to its column's width, so the columns after it line up. */
function pad(text, width) {
  const value = clip(text, width)
  return value + " ".repeat(Math.max(0, width - value.length))
}

/**
 * The last poll's time on the local clock, so it reads against the user's own.
 */
export function pollClock(lastPoll) {
  if (typeof lastPoll !== "string") return "never"
  const at = new Date(lastPoll)
  if (Number.isNaN(at.getTime())) return "never"
  return [at.getHours(), at.getMinutes()].map((value) => String(value).padStart(2, "0")).join(":")
}

/**
 * A workspace's name without the Slack MCP server's own prefix, so the header
 * reads `nexar`, not `slack_nexar`.
 */
export function workspaceLabel(name) {
  const text = typeof name === "string" ? name : ""
  return text.startsWith("slack_") ? text.slice("slack_".length) : text
}

/** The title row: the dialog's name in base text, and `esc` in muted text. */
export function titleParts() {
  return [part(PAGE_TITLE, "title", true), part("esc", "muted")]
}

/**
 * The header line: the last poll, then each workspace with its mark. A failing
 * workspace's mark carries the warning colour and its reason follows it.
 */
export function headerParts(status) {
  const parts = [part(`last poll ${pollClock(status?.lastPoll)}`, "muted")]
  for (const workspace of status?.workspaces ?? []) {
    parts.push(part(" · ", "muted"))
    parts.push(part(`${workspaceLabel(workspace.name)} `, "muted"))
    parts.push(part(workspace.ok ? "✓" : "✗", workspace.ok ? "workspace-ok" : "workspace-fail"))
    if (workspace.error) parts.push(part(` ${workspace.error}`, "muted"))
  }
  return parts
}

/** The header line as one string. */
export function headerText(status) {
  return partsText(headerParts(status))
}

/** The counts line: each state's mark in its state colour, then its count. */
export function countsParts(rows) {
  const of = (state) => (rows ?? []).filter((row) => row.state === state).length
  const parts = []
  for (const [index, state] of STATE_ORDER.entries()) {
    if (index > 0) parts.push(part("   ", "muted"))
    parts.push(part(STATE_MARK[state], `state-${state}`))
    parts.push(part(` ${of(state)} ${state === "waiting" ? "waiting for you" : state}`, "muted"))
  }
  return parts
}

/** The counts line as one string. */
export function countsText(rows) {
  return partsText(countsParts(rows))
}

/** Every section that has rows, in state order, each entry carrying its row and its index among all rows. */
export function sections(rows) {
  const list = rows ?? []
  const indexed = list.map((row, index) => ({ row, index }))
  return STATE_ORDER.map((state) => ({
    state,
    title: SECTION_TITLE[state],
    entries: indexed.filter((entry) => entry.row.state === state),
  })).filter((section) => section.entries.length > 0)
}

/** The today line: the day's counts. */
export function todayParts(status) {
  const today = status?.today ?? {}
  return [
    part("today", "muted"),
    part(`  ${today.flagged ?? 0} flagged · ${today.nextStepsPosted ?? 0} next steps posted`, "muted"),
  ]
}

/** The today line as one string. */
export function todayText(status) {
  return partsText(todayParts(status))
}

/** The footer: each key in base text, bold, then its muted label. */
export function footerParts() {
  const keys = [
    ["↵", "session"],
    ["i", "issue"],
    ["s", "slack"],
    ["r", "refresh"],
    ["e", "settings"],
  ]
  const parts = []
  for (const [index, [key, label]] of keys.entries()) {
    if (index > 0) parts.push(part("   ", "muted"))
    parts.push(part(key, "base", true))
    parts.push(part(` ${label}`, "muted"))
  }
  return parts
}

/** The footer as one string. */
export function footerText() {
  return partsText(footerParts())
}

/**
 * The colour role AGE takes on a row. An idle row is muted throughout. On a
 * waiting or working row AGE is base text under four working hours, the warning
 * colour from four working hours, and the error colour from one working day —
 * where a working day is the length of one day's window.
 */
export function ageRole(state, flaggedAt, now = Date.now(), hours) {
  if (state === "idle") return "muted"
  const minutes = workingMinutesBetween(hours, Date.parse(flaggedAt), now)
  const day = workingDayMinutes(hours)
  if (day > 0 && minutes >= day) return "age-error"
  if (minutes >= AGE_WARNING_MINUTES) return "age-warn"
  return "age-calm"
}

/**
 * One row's parts: the gutter bar, the state mark, then the item's title, its
 * asker, its channel, its intake issue and the age of the flag. Only the mark
 * takes a state colour; on a waiting or working row the title is base text and
 * the rest is muted, and an idle row is muted throughout. No Slack message text
 * is in the dialog: the title is the session's own.
 */
export function rowParts(row, options = {}) {
  const item = row?.item ?? {}
  const state = row?.state
  const selected = options.selected === true
  const now = options.now ?? Date.now()
  const itemRole = state === "idle" ? "muted" : "base"
  return [
    part(" ".repeat(DIALOG_LIST_INSET - 2)),
    part(selected ? "┃" : " ", selected ? "bar" : "none"),
    part(" "),
    part(STATE_MARK[state] ?? " ", `state-${state}`),
    part(" "),
    part(pad(itemTitle(item), ROW_WIDTHS.item), itemRole),
    part(" "),
    part(pad(itemAsker(item), ROW_WIDTHS.asker), "muted"),
    part(" "),
    part(pad(item.channel, ROW_WIDTHS.channel), "muted"),
    part(" "),
    part(pad(issueLabel(item), ROW_WIDTHS.issue), "muted"),
    part(" "),
    part(ageText(item.flaggedAt, now), ageRole(state, item.flaggedAt, now, options.hours)),
  ]
}

/** One row as the string a person reads. */
export function rowText(row, options = {}) {
  return partsText(rowParts(row, options))
}

/** The sidebar's one line. */
export function sidebarText(rows) {
  const of = (state) => (rows ?? []).filter((row) => row.state === state).length
  return `${PAGE_TITLE}  ${of("waiting")} waiting · ${of("working")} working`
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
