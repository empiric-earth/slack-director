// The overview page's own logic: the state of an item, the order of the rows,
// the text of every line, the URL opener and the settings dialog's values.
//
// The expected lines are the approved layout's own lines, so this suite fails
// when a column moves or a label changes. No dependencies; run with
// `node --test` (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COLUMNS,
  KEY_HELP,
  PAGE_TITLE,
  ageText,
  countsText,
  fieldValue,
  headerText,
  issueLabel,
  openerCommand,
  pageRows,
  pollClock,
  rowText,
  settingsValue,
  sidebarText,
  stateOf,
  tableHeaderText,
  todayText,
} from "../src/page.js"

const NOW = Date.parse("2026-11-19T14:32:00.000Z")
const minutes = (n) => new Date(NOW - n * 60000).toISOString()

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

test("the table's header and rows are the approved layout's lines", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.equal(tableHeaderText(), "  STATE      ASKER            ITEM                                   ISSUE  CHANNEL           AGE")
  assert.deepEqual(
    rows.map((row, index) => rowText(row.item, row.state, { selected: index === 0, now: NOW })),
    [
      "▸ ● waiting  Maria Costa      Access to the staging dashboards       #41    #platform-help    12m",
      "  ● waiting  João Pereira     Review of the Terraform module change  #40    DM                1h",
      "  ◐ working  Ana Silva        Why the nightly export job fails       #42    #data-eng         2m",
      "  ○ idle     Rui Santos       Budget numbers for Q1 infra            #38    GDM               1d",
      "  ○ idle     Tiago Lopes      Onboarding steps for the new laptop    #37    #porto-office     3d",
    ],
  )
})

test("every column starts where the approved layout puts it", () => {
  const row = rowText(ITEMS[0], "waiting", { selected: true, now: NOW })
  assert.equal(row[COLUMNS.marker], "▸")
  assert.equal(row.slice(COLUMNS.state, COLUMNS.state + 2), "● ")
  assert.equal(row.slice(COLUMNS.asker, COLUMNS.asker + "Maria Costa".length), "Maria Costa")
  assert.equal(row.slice(COLUMNS.item, COLUMNS.item + 5), "Acces")
  assert.equal(row.slice(COLUMNS.issue, COLUMNS.issue + 3), "#41")
  assert.equal(row.slice(COLUMNS.channel, COLUMNS.channel + "#platform-help".length), "#platform-help")
  assert.equal(row.slice(COLUMNS.age), "12m")
  assert.equal(tableHeaderText().length, COLUMNS.age + 3, "the header is as long as a row")
})

test("a value too long for its column is shortened, and an item without an issue shows a dash", () => {
  const long = item({
    asker: "A".repeat(40),
    title: "B".repeat(80),
    issueNumber: null,
    channel: "C".repeat(40),
  })
  const row = rowText(long, "waiting", { now: NOW })
  assert.equal(row.slice(COLUMNS.asker, COLUMNS.item), `${"A".repeat(16)}…`)
  assert.equal(row.slice(COLUMNS.item, COLUMNS.issue), `${"B".repeat(38)}…`)
  assert.equal(row.slice(COLUMNS.issue, COLUMNS.channel), "—      ")
  assert.equal(row.slice(COLUMNS.channel, COLUMNS.age), `${"C".repeat(17)}…`)
  assert.equal(issueLabel(item({ issueNumber: 41 })), "#41")
})

test("the header names the last poll, the outcome and every workspace, a failing one with its label", () => {
  assert.equal(headerText(STATUS), "last poll 14:32 · ok · slack_nexar ✓ · slack_nauto ✗ sign-in expired — run /mcps")
  assert.equal(headerText({ lastPoll: null, outcome: "never polled", workspaces: [] }), "last poll never · never polled")
  assert.equal(headerText({ lastPoll: "not a time", outcome: "ok", workspaces: [] }), "last poll never · ok")
})

test("the counts line, the today line and the sidebar line carry the counts", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.equal(countsText(rows), "5 flagged · 1 working · 2 waiting for you · 2 idle")
  assert.equal(sidebarText(rows), "Slack Director  2 waiting · 1 working")
  assert.equal(todayText(STATUS), "Today: flagged 5 · next steps posted 3 · 1 hit skipped")
  assert.equal(todayText(undefined), "Today: flagged 0 · next steps posted 0 · 0 hit skipped")
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
})

test("the page title and the help line are the approved layout's own", () => {
  assert.equal(PAGE_TITLE, "Slack Director")
  assert.equal(KEY_HELP, "enter open session · i open issue · s open in Slack · r poll now · , settings · esc back")
})

test("the URL opener runs the system's opener for http and https, and refuses every other URL", () => {
  assert.deepEqual(openerCommand("https://nexar.slack.com/archives/C1/p1", "linux"), {
    command: "xdg-open",
    args: ["https://nexar.slack.com/archives/C1/p1"],
  })
  assert.deepEqual(openerCommand("http://example.test/a", "darwin"), { command: "open", args: ["http://example.test/a"] })
  assert.deepEqual(openerCommand("https://example.test/a", "win32"), {
    command: "cmd",
    args: ["/c", "start", "", "https://example.test/a"],
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
  assert.equal(settingsValue("triage_agent", undefined), "")
})
