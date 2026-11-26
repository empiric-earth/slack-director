// The overview dialog's own logic: the state of one item, the order of the rows,
// the text of every line the dialog and the sidebar show, and the colour role
// each part of a line takes from the theme.
//
// A row is grouped by the request state the poller read from the intake issue's
// yaml block, and the session's own state shrinks to one mark on the row. An
// open issue whose session is gone shows as a row too, marked as having no
// session, and is backed by the poller's status rather than by an item record.
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

/** The side inset every line of the dialog takes, so the title, the section headers and the rows share one left edge. */
export const DIALOG_INSET = 3

/**
 * The request states, in the order their sections show, and the section header
 * and the counts line's name of each. The state lives in the intake issue's yaml
 * block; `needs-me` is the state of an item whose issue carries none, of one
 * that has no issue yet, and of one whose issue carries a value that is not one
 * of the four.
 */
export const REQUEST_STATES = ["needs-me", "blocked", "waiting-requester", "idle"]

/** The section header of each request state. */
export const SECTION_TITLE = {
  "needs-me": "Needs me",
  blocked: "Blocked",
  "waiting-requester": "Waiting on requester",
  idle: "Idle",
}

/** The name each request state takes in the counts line and the sidebar. */
export const STATE_LABEL = {
  "needs-me": "needs me",
  blocked: "blocked",
  "waiting-requester": "waiting on requester",
  idle: "idle",
}

/**
 * The one mark a row shows for its session: a running turn, and a pending
 * OpenCode permission request. A row whose session shows neither carries no
 * mark, so the marker column stays blank.
 */
export const SESSION_MARK = { running: "◐", pending: "●" }

/**
 * The mark of an unattended row: an open issue whose session was deleted or
 * archived, so no session is behind the row.
 */
export const NO_SESSION_MARK = "∅"

/** The flag an unattended row carries while the poller reports unseen messages on its source. */
export const NEW_ACTIVITY_MARK = "new activity"

/** How long a flag may age before its AGE colour warns: four working hours. */
export const AGE_WARNING_MINUTES = 4 * 60

/** The widths the row's columns take, so long values are shortened with an ellipsis. */
export const ROW_WIDTHS = { item: 44, asker: 15, channel: 16, issue: 6, age: 4 }

/**
 * One part of a line: its text, the colour role it takes, whether it is bold,
 * and — for a part a primary click runs — the name of the action it carries.
 * The action is left out of every part that carries none, so a plain part's
 * shape is unchanged.
 */
const part = (text, role = "none", bold = false, action) => {
  const entry = { text, role, bold }
  if (action !== undefined) entry.action = action
  return entry
}

/** A line's parts as the one string a person reads. */
export const partsText = (parts) => (parts ?? []).map((entry) => entry.text).join("")

/**
 * One item's session mark, or undefined when its session shows neither: `◐`
 * while a turn runs, `●` while a permission request waits. `live` is what the
 * TUI knows about the item's session: `running`, and the number of `pending`
 * permission requests.
 */
export function sessionMark(item, live = {}) {
  const pending = item.permissionPending === true || (live.pending ?? 0) > 0
  if (pending) return SESSION_MARK.pending
  if (live.running === true) return SESSION_MARK.running
  return undefined
}

/**
 * One item's request state: the state the poller read from its issue's yaml
 * block. An item with no issue yet, an issue with no `state`, and a value that
 * is not one of the four all read as `needs-me`.
 */
export function requestStateOf(item) {
  return REQUEST_STATES.includes(item?.requestState) ? item.requestState : "needs-me"
}

/**
 * The time a row's age counts from: the issue's `state_since` when it has a
 * usable one, else the flag. An unusable `state_since` falls back to the flag,
 * and a record with neither counts from no time at all.
 */
export function ageStamp(item) {
  if (typeof item?.stateSince === "string" && !Number.isNaN(Date.parse(item.stateSince))) return item.stateSince
  return typeof item?.flaggedAt === "string" ? item.flaggedAt : undefined
}

/** The instant a row's age counts from, or 0 when it names no usable time. */
function atTime(row) {
  const at = Date.parse(row?.at)
  return Number.isNaN(at) ? 0 : at
}

/**
 * One unattended open issue as a row: it has no item record behind it, so its
 * title, its issue number, its permalink and its request state come from the
 * poller's status. Its age counts from its `state_since`, else from its
 * `asked_at`.
 */
function unattendedRow(entry) {
  const at = typeof entry?.state_since === "string" ? entry.state_since : undefined
  const asked = typeof entry?.asked_at === "string" ? entry.asked_at : undefined
  return {
    item: {
      permalink: typeof entry?.permalink === "string" ? entry.permalink : "",
      channel: "",
      asker: "",
      title: typeof entry?.title === "string" ? entry.title : "",
      issueNumber: entry?.number,
      issueUrl: typeof entry?.url === "string" ? entry.url : "",
      sessionID: null,
    },
    state: REQUEST_STATES.includes(entry?.state) ? entry.state : "needs-me",
    session: {},
    note: entry?.newActivity === true ? NEW_ACTIVITY_MARK : undefined,
    unattended: true,
    at: at !== undefined && !Number.isNaN(Date.parse(at)) ? at : asked,
  }
}

/**
 * Every row the dialog shows, in display order: one per item whose issue the
 * poller has not marked closed, then one per unattended open issue the poller's
 * last cycle reported. An item whose issue left a complete open-issue list is
 * closed and takes no row; a failed or possibly cut list leaves every row in
 * place. Rows are grouped by request state in the order of `REQUEST_STATES`, and
 * the newest first inside a section, by the time the row's own age counts from.
 */
export function pageRows(items, liveOf = () => ({}), unattended = []) {
  const named = (items ?? [])
    .filter((item) => item?.issueClosed !== true)
    .map((item) => ({
      item,
      state: requestStateOf(item),
      session: liveOf(item) ?? {},
      note: undefined,
      unattended: false,
      at: ageStamp(item),
    }))
  const orphan = (unattended ?? []).map(unattendedRow)
  return [...named, ...orphan].sort((left, right) => {
    const byState = REQUEST_STATES.indexOf(left.state) - REQUEST_STATES.indexOf(right.state)
    if (byState !== 0) return byState
    return atTime(right) - atTime(left)
  })
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

/** Whether an item has a live session behind its row: an unattended row has none. */
export function hasSession(item) {
  return typeof item?.sessionID === "string" && item.sessionID !== ""
}

/**
 * The identity of one row: the item's own session id, or — for an unattended
 * row, which has no session — its intake issue's number. Every row has one, so
 * the marker never confuses two rows.
 */
export function rowID(row) {
  const item = row?.item
  if (hasSession(item)) return item.sessionID
  return typeof item?.issueNumber === "number" ? `issue:${item.issueNumber}` : undefined
}

/**
 * The identity of every row, in display order. The marker follows an identity,
 * not a position, so a refresh that reorders the rows keeps the same row
 * selected.
 */
export function rowIDs(rows) {
  return (rows ?? []).map(rowID)
}

/**
 * The index the marker takes once the rows change. The selected identity wins
 * while it still has a row. When it is gone, the next row that survives in the
 * previous display order takes the marker, then the one before it, and when
 * neither survives the first remaining row. An empty table has no row to mark,
 * so no item is selected and no action can act on one.
 */
export function reconcileSelection(rows, selectedID, previousOrder = []) {
  const list = rows ?? []
  if (list.length === 0) return 0
  const ids = rowIDs(list)
  const still = ids.indexOf(selectedID)
  if (still !== -1) return still
  const from = (previousOrder ?? []).indexOf(selectedID)
  if (from !== -1) {
    for (let step = from + 1; step < previousOrder.length; step += 1) {
      const found = ids.indexOf(previousOrder[step])
      if (found !== -1) return found
    }
    for (let step = from - 1; step >= 0; step -= 1) {
      const found = ids.indexOf(previousOrder[step])
      if (found !== -1) return found
    }
  }
  return 0
}

/** How long ago a row's own time was, in the units the mock uses: minutes, then hours, then days. */
export function ageText(at, now = Date.now()) {
  const from = Date.parse(at)
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

/**
 * The title row: the dialog's name in base text, and `esc` in muted text. The
 * `esc` hint carries the `close` action, so a primary click on it closes the
 * overview as the host's own Escape does; the name carries none.
 */
export function titleParts() {
  return [part(PAGE_TITLE, "title", true), part("esc", "muted", false, "close")]
}

/** One count with its noun in the right number. */
const countLabel = (count, one, many) => `${count} ${count === 1 ? one : many}`

/**
 * The poller's one cell: the time of its last cycle, whether it was healthy, the
 * distinct reason when it was not, and what it read — the issues, threads and
 * conversations, the unattended issues and a possibly cut list. Nothing is shown
 * until a cycle has run.
 */
export function pollerCell(poller) {
  if (!poller || typeof poller.lastCycle !== "string") return undefined
  const details = [
    countLabel(poller.issues ?? 0, "issue", "issues"),
    countLabel(poller.threads ?? 0, "thread", "threads"),
    countLabel(poller.conversations ?? 0, "conversation", "conversations"),
  ]
  const unattended = Array.isArray(poller.unattended) ? poller.unattended.length : 0
  if (unattended > 0) details.push(countLabel(unattended, "unattended", "unattended"))
  if (poller.possiblyCut) details.push("list cut at 100")
  const detail = details.join(" · ")
  const clock = pollClock(poller.lastCycle)
  // The distinct reason the last cycle recorded, so throttling is never read as
  // a sign-in problem and an incomplete list is never hidden by a failure.
  const reason = typeof poller.outcome === "string" && poller.outcome !== "" ? poller.outcome : "read failed"
  if (poller.ghError) return `poller ${clock} ✗ ${poller.ghError} · ${detail}`
  if (Array.isArray(poller.failed) && poller.failed.length > 0) return `poller ${clock} ✗ ${reason} · ${detail}`
  return `poller ${clock} ✓ ${detail}`
}

/** The poller cell's parts, with a failing cell in the warning colour. */
function pollerParts(poller) {
  const cell = pollerCell(poller)
  if (cell === undefined) return []
  const failed = cell.includes("✗") || cell.includes("!")
  return [part(" · ", "muted"), part(cell, failed ? "workspace-fail" : "workspace-ok")]
}

/**
 * The header line: the last poll, then each workspace with its mark, then the
 * poller's one cell, when it has run. A failing workspace's mark carries the
 * warning colour and its reason follows it.
 */
export function headerParts(status) {
  const parts = [part(`last poll ${pollClock(status?.lastPoll)}`, "muted")]
  for (const workspace of status?.workspaces ?? []) {
    parts.push(part(" · ", "muted"))
    parts.push(part(`${workspaceLabel(workspace.name)} `, "muted"))
    parts.push(part(workspace.ok ? "✓" : "✗", workspace.ok ? "workspace-ok" : "workspace-fail"))
    if (workspace.error) parts.push(part(` ${workspace.error}`, "muted"))
  }
  parts.push(...pollerParts(status?.poller))
  return parts
}

/** The header line as one string. */
export function headerText(status) {
  return partsText(headerParts(status))
}

/** The counts line: each request state's own count, in the order the sections show. */
export function countsParts(rows) {
  const of = (state) => (rows ?? []).filter((row) => row.state === state).length
  const parts = []
  for (const [index, state] of REQUEST_STATES.entries()) {
    if (index > 0) parts.push(part("   ", "muted"))
    parts.push(part(`${of(state)} `, "base", true))
    parts.push(part(STATE_LABEL[state], "muted"))
  }
  return parts
}

/** The counts line as one string. */
export function countsText(rows) {
  return partsText(countsParts(rows))
}

/** Every section that has rows, in request-state order, each entry carrying its row and its index among all rows. */
export function sections(rows) {
  const list = rows ?? []
  const indexed = list.map((row, index) => ({ row, index }))
  return REQUEST_STATES.map((state) => ({
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

/**
 * The footer: each key in base text, bold, then its muted label. Every key and
 * its label carry that key's own action — `session`, `issue`, `slack`,
 * `refresh`, `settings` or `done` — so a primary click on either part runs
 * exactly what the key runs. The spacers between the controls carry no action,
 * so a click in a gap runs nothing.
 */
export function footerParts() {
  const keys = [
    ["↵", "session", "session"],
    ["i", "issue", "issue"],
    ["s", "slack", "slack"],
    ["r", "refresh", "refresh"],
    ["e", "settings", "settings"],
    ["d", "done", "done"],
  ]
  const parts = []
  for (const [index, [key, label, action]] of keys.entries()) {
    if (index > 0) parts.push(part("   ", "muted"))
    parts.push(part(key, "base", true, action))
    parts.push(part(` ${label}`, "muted", false, action))
  }
  return parts
}

/** The footer as one string. */
export function footerText() {
  return partsText(footerParts())
}

/**
 * The colour role AGE takes on a row. A row in the `Idle` section is muted
 * throughout. On any other row AGE is base text under four working hours, the
 * warning colour from four working hours, and the error colour from one working
 * day — where a working day is the length of one day's window.
 */
export function ageRole(state, at, now = Date.now(), hours) {
  if (state === "idle") return "muted"
  const minutes = workingMinutesBetween(hours, Date.parse(at), now)
  const day = workingDayMinutes(hours)
  if (day > 0 && minutes >= day) return "age-error"
  if (minutes >= AGE_WARNING_MINUTES) return "age-warn"
  return "age-calm"
}

/**
 * The mark one row shows, and the colour role it takes: the mark of the row's
 * own session, or the no-session mark of an unattended row. A row whose session
 * shows neither carries no mark.
 */
function rowMark(row) {
  if (row?.unattended === true) return { mark: NO_SESSION_MARK, role: "muted" }
  const mark = sessionMark(row?.item ?? {}, row?.session ?? {})
  if (mark === SESSION_MARK.pending) return { mark, role: "state-waiting" }
  if (mark === SESSION_MARK.running) return { mark, role: "state-working" }
  return { mark: undefined, role: "none" }
}

/**
 * One row's parts: the gutter bar, the session mark, then the item's title, its
 * asker, its channel, its intake issue and the age of its request — measured
 * from the issue's `state_since` when it has one, else from the flag. Only the
 * mark takes a state colour; on a row outside the `Idle` section the title is
 * base text and the rest is muted, and an idle row is muted throughout. An
 * unattended row carries the `no session` mark and, while the poller reports
 * unseen activity on its source, the `new activity` flag after the age. No Slack
 * message text is in the dialog: the title is the session's own.
 */
export function rowParts(row, options = {}) {
  const item = row?.item ?? {}
  const state = row?.state
  const selected = options.selected === true
  const now = options.now ?? Date.now()
  const itemRole = state === "idle" ? "muted" : "base"
  const marked = rowMark(row)
  // A row pageRows built carries the time it ages from; a bare row falls back to
  // the item's own issue state time and flag.
  const at = row?.at ?? ageStamp(item)
  const parts = [
    part(" ".repeat(DIALOG_INSET - 2)),
    part(selected ? "┃" : " ", selected ? "bar" : "none"),
    part(" "),
    part(marked.mark ?? " ", marked.role),
    part(" "),
    part(pad(itemTitle(item), ROW_WIDTHS.item), itemRole),
    part(" "),
    part(pad(itemAsker(item), ROW_WIDTHS.asker), "muted"),
    part(" "),
    part(pad(item.channel, ROW_WIDTHS.channel), "muted"),
    part(" "),
    part(pad(issueLabel(item), ROW_WIDTHS.issue), "muted"),
    part(" "),
    part(ageText(at, now), ageRole(state, at, now, options.hours)),
  ]
  if (row?.note) parts.push(part("  "), part(row.note, "state-waiting"))
  return parts
}

/** One row as the string a person reads. */
export function rowText(row, options = {}) {
  return partsText(rowParts(row, options))
}

/** The sidebar's one line: the requests that need the user, and the blocked ones. */
export function sidebarText(rows) {
  const of = (state) => (rows ?? []).filter((row) => row.state === state).length
  return `${PAGE_TITLE}  ${of("needs-me")} needs me · ${of("blocked")} blocked`
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
  if (field === "poll_seconds" || field === "poll_minutes") return Number(text)
  if (field === "work_hours") return JSON.parse(text)
  return text
}
