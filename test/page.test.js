// The overview dialog's own logic: the state of an item, the order of the rows,
// the text and colour roles of every line, the AGE colour in working time, the
// selection move, the URL opener and the settings dialog's values.
//
// The expected lines are the approved layout's own lines, so this suite fails
// when a column moves or a label changes, and the colour-role assertions fail
// when a part takes the wrong role. No dependencies; run with `node --test`
// (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  AGE_WARNING_MINUTES,
  DIALOG_INSET,
  PAGE_TITLE,
  ROW_WIDTHS,
  SECTION_TITLE,
  STATE_MARK,
  STATE_ORDER,
  ageRole,
  ageText,
  askerName,
  countsParts,
  countsText,
  fieldValue,
  footerParts,
  footerText,
  headerParts,
  headerText,
  issueLabel,
  itemAsker,
  itemTitle,
  moveSelection,
  openerCommand,
  pageRows,
  partsText,
  pollClock,
  rowParts,
  rowText,
  sections,
  selectedItem,
  settingsValue,
  sidebarText,
  stateOf,
  titleParts,
  todayParts,
  todayText,
  workspaceLabel,
} from "../src/page.js"

const NOW = Date.parse("2026-11-19T14:32:00.000Z")
const minutes = (n) => new Date(NOW - n * 60000).toISOString()

/** The window the actions in this suite use: weekdays, 09:00 to 18:00, UTC. */
const HOURS = { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "18:00", time_zone: "UTC" }

/** One item record, as the RPC contract serves it. */
function item(over = {}) {
  return {
    permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219",
    workspace: "slack_nexar",
    channel: "#platform-help",
    asker: "Maria Costa",
    flaggedAt: minutes(12),
    sessionID: "ses_1",
    title: "Access to the staging dashboards",
    issueNumber: 41,
    issueUrl: "https://github.com/empire/almeida-slack-intake/issues/41",
    firstTurnEndedAt: minutes(11),
    firstTurnFailed: false,
    permissionPending: false,
    openedAt: null,
    ...over,
  }
}

/** The five items of the approved layout, in the order they are flagged. */
const ITEMS = [
  item(),
  item({
    permalink: "p2",
    asker: "João Pereira",
    flaggedAt: minutes(60),
    sessionID: "ses_2",
    title: "Review of the Terraform module change",
    issueNumber: 40,
    channel: "DM",
  }),
  item({
    permalink: "p3",
    asker: "Ana Silva",
    flaggedAt: minutes(2),
    sessionID: "ses_3",
    title: "Why the nightly export job fails",
    issueNumber: 42,
    channel: "#data-eng",
  }),
  item({
    permalink: "p4",
    asker: "Rui Santos",
    flaggedAt: minutes(60 * 24),
    sessionID: "ses_4",
    title: "Budget numbers for Q1 infra",
    issueNumber: 38,
    channel: "GDM",
    openedAt: minutes(60 * 23),
  }),
  item({
    permalink: "p5",
    asker: "Tiago Lopes",
    flaggedAt: minutes(60 * 24 * 3),
    sessionID: "ses_5",
    title: "Onboarding steps for the new laptop",
    issueNumber: 37,
    channel: "#porto-office",
    openedAt: minutes(60 * 24 * 2),
  }),
]

/** What the TUI knows about each of those sessions: only the third one runs. */
const LIVE = { ses_3: { running: true, pending: 0 } }
const liveOf = (record) => LIVE[record.sessionID] ?? { running: false, pending: 0 }

const STATUS = {
  lastPoll: "2026-11-19T14:32:00.000Z",
  outcome: "ok",
  workspaces: [
    { name: "slack_nexar", ok: true, error: null },
    { name: "slack_nauto", ok: false, error: "sign-in expired — run /mcps" },
  ],
  configError: null,
  today: { flagged: 5, nextStepsPosted: 3, skipped: 1 },
}

test("the state follows the item record and the session's live state, first match winning", () => {
  const unopened = { permissionPending: false, openedAt: null }
  const opened = { permissionPending: false, openedAt: minutes(5) }

  assert.equal(stateOf(unopened, { running: true }), "working", "a first turn that runs is working")
  assert.equal(stateOf(unopened, { running: false }), "waiting", "a first turn that ended is waiting to be read")
  assert.equal(stateOf(opened, { running: false }), "idle", "an item the user opened is idle once it is quiet")
  assert.equal(stateOf(opened, { running: true }), "working", "a turn the user resumed is working again")
  assert.equal(stateOf(opened, { running: false, pending: 1 }), "waiting", "a permission prompt is waiting")
  assert.equal(
    stateOf(unopened, { running: true, pending: 1 }),
    "waiting",
    "a session that runs and waits on a permission at once is waiting, not working",
  )
  assert.equal(
    stateOf({ permissionPending: true, openedAt: minutes(5) }, { running: true }),
    "waiting",
    "the record's own pending permission wins over a running session",
  )
  assert.equal(stateOf(opened, {}), "idle", "a session the TUI does not know reads as quiet")
})

test("the rows are waiting, then working, then idle, newest flag first in each", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.deepEqual(
    rows.map((row) => row.state),
    ["waiting", "waiting", "working", "idle", "idle"],
  )
  assert.deepEqual(
    rows.map((row) => row.item.sessionID),
    ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"],
    "newest flag first inside each state",
  )
})

test("the title row, the header line, the counts line, the today line and the footer are the layout's own", () => {
  const rows = pageRows(ITEMS, liveOf)

  assert.equal(partsText(titleParts()), `${PAGE_TITLE}esc`, "the title row holds the name and esc")
  assert.equal(headerText(STATUS), "last poll 14:32 · nexar ✓ · nauto ✗ sign-in expired — run /mcps")
  assert.equal(headerText({ lastPoll: null, outcome: "never polled", workspaces: [] }), "last poll never")
  assert.equal(pollClock("2026-11-19T14:32:00.000Z"), "14:32")
  assert.equal(countsText(rows), "● 2 waiting for you   ◐ 1 working   ○ 2 idle")
  assert.equal(countsText([]), "● 0 waiting for you   ◐ 0 working   ○ 0 idle")
  assert.equal(todayText(STATUS), "today  5 flagged · 3 next steps posted", "the skipped hits are gone")
  assert.equal(todayText(undefined), "today  0 flagged · 0 next steps posted")
  assert.equal(footerText(), "↵ session   i issue   s slack   r refresh   e settings")
  assert.equal(sidebarText(rows), "Slack Director  2 waiting · 1 working")
})

test("no line names a STATE column, and the dialog carries no table header", () => {
  const lines = [
    partsText(titleParts()),
    headerText(STATUS),
    countsText(pageRows(ITEMS, liveOf)),
    todayText(STATUS),
    footerText(),
    ...Object.values(SECTION_TITLE),
    ...pageRows(ITEMS, liveOf).map((row, index) => rowText(row, { selected: index === 0, now: NOW, hours: HOURS })),
  ]
  for (const line of lines) assert.ok(!line.includes("STATE"), `no STATE column: ${line}`)
  assert.ok(!lines.some((line) => line.includes("ASKER")), "no ASKER header column")
})

test("the rows are grouped under their section, in state order, each entry carrying its index", () => {
  const rows = pageRows(ITEMS, liveOf)
  const groups = sections(rows)
  assert.deepEqual(
    groups.map((group) => [group.state, group.title]),
    [
      ["waiting", "Waiting for you"],
      ["working", "Working"],
      ["idle", "Idle"],
    ],
  )
  assert.deepEqual(
    groups.map((group) => group.entries.map((entry) => entry.index)),
    [
      [0, 1],
      [2],
      [3, 4],
    ],
    "each entry carries its position among all rows",
  )
  assert.deepEqual(sections([]), [], "a state with no rows has no section")
  assert.deepEqual(STATE_ORDER, ["waiting", "working", "idle"])
})

test("the colour roles name the mark, the text and the bar each part takes", () => {
  assert.deepEqual(
    titleParts().map((entry) => [entry.text, entry.role, entry.bold]),
    [
      [PAGE_TITLE, "title", true],
      ["esc", "muted", false],
    ],
  )
  const header = headerParts(STATUS)
  assert.deepEqual(
    header.map((entry) => entry.role),
    ["muted", "muted", "muted", "workspace-ok", "muted", "muted", "workspace-fail", "muted"],
  )
  const counts = countsParts(pageRows(ITEMS, liveOf))
  assert.deepEqual(
    counts.map((entry) => [entry.text, entry.role]),
    [
      ["●", "state-waiting"],
      [" 2 waiting for you", "muted"],
      ["   ", "muted"],
      ["◐", "state-working"],
      [" 1 working", "muted"],
      ["   ", "muted"],
      ["○", "state-idle"],
      [" 2 idle", "muted"],
    ],
  )
  assert.deepEqual(
    footerParts().map((entry) => [entry.text, entry.role, entry.bold]),
    [
      ["↵", "base", true],
      [" session", "muted", false],
      ["   ", "muted", false],
      ["i", "base", true],
      [" issue", "muted", false],
      ["   ", "muted", false],
      ["s", "base", true],
      [" slack", "muted", false],
      ["   ", "muted", false],
      ["r", "base", true],
      [" refresh", "muted", false],
      ["   ", "muted", false],
      ["e", "base", true],
      [" settings", "muted", false],
    ],
  )
  assert.deepEqual(todayParts(STATUS).map((entry) => entry.role), ["muted", "muted"])
})

test("one row is the bar, the mark, then ITEM, ASKER, CHANNEL, the issue and AGE", () => {
  const rows = pageRows(ITEMS, liveOf)
  const parts = rowParts(rows[0], { selected: true, now: NOW, hours: HOURS })

  assert.equal(parts[0].text, " ".repeat(DIALOG_INSET - 2), "the row starts at its inset")
  assert.equal(parts[1].text, "┃", "the selected row draws the bar")
  assert.equal(parts[1].role, "bar")
  assert.equal(parts[3].text, STATE_MARK.waiting)
  assert.equal(parts[3].role, "state-waiting")
  assert.equal(parts[5].text.trimEnd(), "Access to the staging dashboards")
  assert.equal(parts[5].role, "base", "ITEM is base text on a waiting row")
  assert.equal(parts[7].text.trimEnd(), "Maria Costa")
  assert.equal(parts[9].text.trimEnd(), "#platform-help")
  assert.equal(parts[11].text.trimEnd(), "#41")
  assert.equal(parts[13].text, "12m", "AGE keeps its calendar text")

  const unselected = rowParts(rows[0], { selected: false, now: NOW, hours: HOURS })
  assert.equal(unselected[1].text, " ")
  assert.equal(unselected[1].role, "none")

  const idle = rowParts(rows[3], { selected: false, now: NOW, hours: HOURS })
  assert.equal(idle[3].role, "state-idle")
  assert.equal(idle[5].role, "muted", "an idle row is muted throughout")
  assert.equal(idle[7].role, "muted")
})

test("a value too long for its column is shortened with an ellipsis", () => {
  const long = item({ title: "B".repeat(80), asker: "A".repeat(40), channel: "C".repeat(40) })
  const parts = rowParts({ item: long, state: "waiting" }, { now: NOW, hours: HOURS })
  assert.equal(parts[5].text, `${"B".repeat(ROW_WIDTHS.item - 1)}…`)
  assert.equal(parts[7].text, `${"A".repeat(ROW_WIDTHS.asker - 1)}…`, "ASKER is shortened to its column")
  assert.equal(parts[9].text, `${"C".repeat(ROW_WIDTHS.channel - 1)}…`)
})

test("the ITEM cell drops a leading asker, so ASKER is not shown twice", () => {
  const repeated = item({ asker: "Maria Costa", title: "Maria Costa — Access to the staging dashboards" })
  assert.equal(itemTitle(repeated), "Access to the staging dashboards")
  assert.equal(itemTitle(item()), "Access to the staging dashboards", "a title with no prefix is unchanged")
  assert.equal(
    itemTitle(item({ asker: "", title: "Someone — a paraphrase" })),
    "a paraphrase",
    "a record with no asker takes the one its own title carries",
  )
})

test("a record an earlier build left without an asker shows the asker its title carries", () => {
  const earlier = item({
    asker: "",
    title: "André Almeida — note-to-self to verify the dialog",
    issueNumber: 34,
    issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/34",
  })
  assert.equal(itemAsker(earlier), "André Almeida", "the ASKER cell is not left empty")
  assert.equal(itemTitle(earlier), "note-to-self to verify the dialog", "and ITEM keeps no asker prefix")
  assert.equal(rowParts({ item: earlier, state: "waiting" }, { now: NOW, hours: HOURS })[7].text.trimEnd(), "André Almeida")
})

test("the ASKER cell drops the id or the address the search reported beside the name", () => {
  const idle = item({
    asker: "André Almeida <aalmeida@empiricearth.com>",
    title: "André Almeida — note-to-self to verify the dialog",
    issueNumber: 38,
    openedAt: minutes(60 * 5),
  })
  assert.equal(itemAsker(idle), "André Almeida")
  assert.equal(itemTitle(idle), "note-to-self to verify the dialog")
  assert.equal(askerName("Maria Costa (U0000000000)"), "Maria Costa")
  assert.equal(askerName("André Almeida <aalmeida@empiricearth.com>"), "André Almeida")
  assert.equal(askerName("Maria Costa"), "Maria Costa", "a name on its own is unchanged")
  assert.equal(askerName(""), "")
})

test("a record whose first turn has named no issue keeps its neutral title and shows no asker", () => {
  const fresh = item({
    asker: "",
    title: "Flagged message in DM — 1795263523.511709",
    issueNumber: null,
    issueUrl: null,
  })
  assert.equal(itemAsker(fresh), "", "the neutral title's dash is not an asker separator")
  assert.equal(itemTitle(fresh), "Flagged message in DM — 1795263523.511709")
  assert.equal(rowParts({ item: fresh, state: "waiting" }, { now: NOW, hours: HOURS })[7].text, " ".repeat(ROW_WIDTHS.asker))
})

test("the selection move wraps at both ends, and the marker picks the row the keys act on", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.equal(moveSelection(4, 5, 1), 0, "down from the last row goes to the first")
  assert.equal(moveSelection(0, 5, -1), 4, "up from the first row goes to the last")
  assert.equal(moveSelection(2, 5, 1), 3, "down from a middle row is the next one")
  assert.equal(moveSelection(0, 0, 1), 0, "an empty table has no move")
  assert.equal(selectedItem(rows, 4).sessionID, "ses_5", "the selected row's item is the one the keys act on")
  assert.equal(selectedItem(rows, 0).sessionID, "ses_1")
  assert.equal(selectedItem([], 0), undefined)
})

test("the age counts from the flag, in minutes, then hours, then days", () => {
  assert.equal(ageText(minutes(0), NOW), "0m")
  assert.equal(ageText(minutes(12), NOW), "12m")
  assert.equal(ageText(minutes(59), NOW), "59m")
  assert.equal(ageText(minutes(60), NOW), "1h")
  assert.equal(ageText(minutes(60 * 23), NOW), "23h")
  assert.equal(ageText(minutes(60 * 24), NOW), "1d")
  assert.equal(ageText(minutes(60 * 24 * 3), NOW), "3d")
  assert.equal(ageText("not a time", NOW), "—")
  assert.equal(ageText(minutes(-5), NOW), "0m", "a clock that runs behind reads as just now")
  assert.equal(issueLabel(item({ issueNumber: 41 })), "#41")
  assert.equal(issueLabel(item({ issueNumber: null })), "—")
})

test("AGE's colour uses working time: base under 4 working hours, warning from 4, error from one day", () => {
  const flagged = "2026-11-23T09:00:00Z"
  const calm = ageRole("waiting", flagged, Date.parse("2026-11-23T12:59:00Z"), HOURS)
  assert.equal(calm, "age-calm", "239 working minutes is under the warning")
  assert.equal(AGE_WARNING_MINUTES, 4 * 60)
  assert.equal(ageRole("waiting", flagged, Date.parse("2026-11-23T13:00:00Z"), HOURS), "age-warn", "exactly 4 working hours warns")
  assert.equal(ageRole("waiting", flagged, Date.parse("2026-11-23T17:59:00Z"), HOURS), "age-warn", "under one working day")
  assert.equal(ageRole("waiting", flagged, Date.parse("2026-11-23T18:00:00Z"), HOURS), "age-error", "exactly one working day errors")
  assert.equal(ageRole("working", flagged, Date.parse("2026-11-24T10:00:00Z"), HOURS), "age-error", "one day plus an hour")
  assert.equal(ageRole("idle", flagged, Date.parse("2026-12-31T00:00:00Z"), HOURS), "muted", "an idle row is muted throughout")
})

test("AGE's colour counts working time, not calendar time", () => {
  // Friday 17:00 to Monday 10:00 is 65 calendar hours but only 2 working hours.
  const flagged = "2026-11-20T17:00:00Z"
  const now = Date.parse("2026-11-23T10:00:00Z")
  assert.equal(ageRole("waiting", flagged, now, HOURS), "age-calm", "calendar time would have read as an error")
})

test("AGE's colour is calm outside the window and on a day it does not list", () => {
  assert.equal(ageRole("waiting", "2026-11-21T12:00:00Z", Date.parse("2026-11-21T14:00:00Z"), HOURS), "age-calm")
  assert.equal(ageRole("waiting", "not a time", NOW, HOURS), "age-calm", "an unreadable time is calm")
})

test("a workspace's name drops the Slack MCP server's own prefix", () => {
  assert.equal(workspaceLabel("slack_nexar"), "nexar")
  assert.equal(workspaceLabel("slack_nauto"), "nauto")
  assert.equal(workspaceLabel("other"), "other")
  assert.equal(workspaceLabel(undefined), "")
})

test("the dialog's title is the layout's own", () => {
  assert.equal(PAGE_TITLE, "Slack Director")
  assert.equal(DIALOG_INSET, 3, "the one side inset every line takes")
})

test("the URL opener runs the system's opener for http and https, and refuses every other URL", () => {
  assert.deepEqual(openerCommand("https://nexar.slack.com/archives/C1/p1", "linux"), {
    command: "xdg-open",
    args: ["https://nexar.slack.com/archives/C1/p1"],
  })
  assert.deepEqual(openerCommand("http://example.test/a", "darwin"), { command: "open", args: ["http://example.test/a"] })
  assert.deepEqual(openerCommand("https://example.test/a", "win32"), {
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", "https://example.test/a"],
  })
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://example.test/a",
    "slack://channel?id=C1",
    "",
    undefined,
    42,
  ]) {
    assert.equal(openerCommand(url, "linux"), undefined, `${String(url)} is not opened`)
  }
})

test("a hostile URL reaches no shell, and none of it reaches an opener as it stands", () => {
  // A URL may hold `&`, `|` and `^`, and `cmd` re-reads them as its own
  // operators. Windows opens an address through `rundll32`, which is not a
  // shell, and the whole address is one argument of it.
  const metacharacters = "https://example.test/a?x=1&calc.exe"
  const windows = openerCommand(metacharacters, "win32")
  assert.equal(windows.command, "rundll32", "Windows opens an address without cmd")
  assert.deepEqual(windows.args, ["url.dll,FileProtocolHandler", metacharacters], "the address is one argument")

  // Text a URL may not hold comes back in the parser's own form, or the address
  // is refused: a quote, a space and a line break never reach an opener as they
  // stand.
  assert.deepEqual(openerCommand('https://example.test/a" & calc.exe', "linux").args, [
    "https://example.test/a%22%20&%20calc.exe",
  ])
  assert.deepEqual(openerCommand("https://example.test/a\r\nb", "darwin").args, ["https://example.test/ab"])
  assert.deepEqual(openerCommand("https://example.test/a^|<>%", "win32").args, [
    "url.dll,FileProtocolHandler",
    "https://example.test/a%5E|%3C%3E%",
  ])
  for (const url of ["https://", "http://", "https:// example.test/a"]) {
    assert.equal(openerCommand(url, "linux"), undefined, `${JSON.stringify(url)} is not opened`)
  }
})

test("the settings dialog sends a field's own type and offers the current value", () => {
  assert.equal(fieldValue("poll_seconds", "90"), 90)
  assert.equal(Number.isNaN(fieldValue("poll_seconds", "soon")), true, "a value of the wrong type reaches the server")
  assert.deepEqual(fieldValue("work_hours", '{"days":["Mon"],"start":"09:00","end":"18:00","time_zone":"UTC"}'), {
    days: ["Mon"],
    start: "09:00",
    end: "18:00",
    time_zone: "UTC",
  })
  assert.equal(fieldValue("intake_repo", "empiric-earth/almeida-slack-intake"), "empiric-earth/almeida-slack-intake")
  assert.equal(settingsValue("poll_seconds", 60), "60")
  assert.equal(
    settingsValue("work_hours", { days: ["Mon"], start: "09:00", end: "18:00", time_zone: "UTC" }),
    '{"days":["Mon"],"start":"09:00","end":"18:00","time_zone":"UTC"}',
  )
  assert.equal(settingsValue("session_agent", undefined), "")
})
