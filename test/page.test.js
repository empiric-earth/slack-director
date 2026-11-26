// The overview dialog's own logic: the request state of a row, the order of the
// rows, the text and colour roles of every line, the AGE colour in working time,
// the selection move, the URL opener and the settings dialog's values.
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
  NEW_ACTIVITY_MARK,
  NO_SESSION_MARK,
  PAGE_TITLE,
  REQUEST_STATES,
  ROW_WIDTHS,
  SECTION_TITLE,
  SESSION_MARK,
  STATE_LABEL,
  ageRole,
  ageStamp,
  ageText,
  askerName,
  countsParts,
  countsText,
  fieldValue,
  footerParts,
  footerText,
  hasSession,
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
  pollerCell,
  reconcileSelection,
  requestStateOf,
  rowID,
  rowIDs,
  rowParts,
  rowText,
  sections,
  selectedItem,
  sessionMark,
  settingsValue,
  sidebarText,
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
    requestState: "needs-me",
    stateSince: null,
    blockedOn: null,
    waitingOn: [],
    issueClosed: false,
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
    requestState: "blocked",
    blockedOn: "https://github.com/empiric-earth/almeida-slack-intake/issues/40",
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
    requestState: "idle",
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
    requestState: "waiting-requester",
    waitingOn: ["U0000000001"],
  }),
]

/** One unattended open issue, as the poller's status serves it. */
function orphan(over = {}) {
  return {
    number: 36,
    url: "https://github.com/empiric-earth/almeida-slack-intake/issues/36",
    title: "Nuno Ferreira — VPN profile for the contractors",
    permalink: "https://nexar.slack.com/archives/C0IT/p1795194400999000",
    state: "blocked",
    state_since: minutes(60 * 5),
    asked_at: minutes(60 * 30),
    newActivity: false,
    ...over,
  }
}

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

test("the request state is the issue's own, and needs-me until the issue names another", () => {
  assert.equal(requestStateOf(item()), "needs-me")
  assert.equal(requestStateOf(item({ requestState: "blocked" })), "blocked")
  assert.equal(requestStateOf(item({ requestState: "waiting-requester" })), "waiting-requester")
  assert.equal(requestStateOf(item({ requestState: "idle" })), "idle")
  assert.equal(requestStateOf(item({ requestState: undefined })), "needs-me", "an issue with no state reads as needs-me")
  assert.equal(requestStateOf(item({ requestState: "in-progress" })), "needs-me", "an unknown value reads as needs-me")
  assert.equal(requestStateOf({ issueNumber: null }), "needs-me", "an item with no issue yet reads as needs-me")
  assert.deepEqual(REQUEST_STATES, ["needs-me", "blocked", "waiting-requester", "idle"])
})

test("a row's session mark is a running turn, a pending permission request, or no mark at all", () => {
  assert.equal(sessionMark(item(), { running: true }), SESSION_MARK.running, "a running turn shows its mark")
  assert.equal(
    sessionMark(item(), { running: false, pending: 2 }),
    SESSION_MARK.pending,
    "a pending permission request shows its mark",
  )
  assert.equal(
    sessionMark(item(), { running: true, pending: 1 }),
    SESSION_MARK.pending,
    "a session that runs and waits on a permission at once shows the permission's mark",
  )
  assert.equal(
    sessionMark(item({ permissionPending: true }), { running: true }),
    SESSION_MARK.pending,
    "the record's own pending permission wins over a running session",
  )
  assert.equal(sessionMark(item(), {}), undefined, "a quiet session shows no mark at all")
})

test("the rows are grouped by request state, newest first inside each section", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.deepEqual(
    rows.map((row) => row.state),
    ["needs-me", "needs-me", "blocked", "waiting-requester", "idle"],
    "the sections come in the order of REQUEST_STATES",
  )
  assert.deepEqual(
    rows.map((row) => row.item.sessionID),
    ["ses_3", "ses_1", "ses_2", "ses_5", "ses_4"],
    "the newest row comes first inside each section",
  )
})

test("a row with a session orders by its flag, while its age counts from its state time", () => {
  const older = item({
    permalink: "pa",
    sessionID: "ses_a",
    flaggedAt: minutes(60 * 24),
    stateSince: minutes(5),
    requestState: "needs-me",
  })
  const newer = item({
    permalink: "pb",
    sessionID: "ses_b",
    flaggedAt: minutes(2),
    stateSince: minutes(60),
    requestState: "needs-me",
  })
  const rows = pageRows([older, newer], () => ({}))
  assert.deepEqual(
    rows.map((row) => row.item.sessionID),
    ["ses_b", "ses_a"],
    "the newest flag comes first, not the newest state change",
  )
  assert.equal(
    rows.find((row) => row.item.sessionID === "ses_a").at,
    minutes(5),
    "while its age still counts from its state_since",
  )
})

test("an item whose issue left a complete open-issue list takes no row", () => {
  const closed = ITEMS.map((record) => (record.sessionID === "ses_1" ? { ...record, issueClosed: true } : record))
  const rows = pageRows(closed, liveOf)
  assert.deepEqual(
    rows.map((row) => row.item.sessionID),
    ["ses_3", "ses_2", "ses_5", "ses_4"],
    "a closed issue's row is gone, and every other row stays",
  )
  assert.equal(
    rows.some((row) => row.item.sessionID === "ses_1"),
    false,
    "the dialog shows no row for an item whose issue is closed",
  )
})

test("the title row, the header line, the counts line, the today line and the footer are the layout's own", () => {
  const rows = pageRows(ITEMS, liveOf)

  assert.equal(partsText(titleParts()), `${PAGE_TITLE}esc`, "the title row holds the name and esc")
  assert.equal(headerText(STATUS), "last poll 14:32 · nexar ✓ · nauto ✗ sign-in expired — run /mcps")
  assert.equal(headerText({ lastPoll: null, outcome: "never polled", workspaces: [] }), "last poll never")
  assert.equal(pollClock("2026-11-19T14:32:00.000Z"), "14:32")
  assert.equal(countsText(rows), "2 needs me   1 blocked   1 waiting on requester   1 idle")
  assert.equal(countsText([]), "0 needs me   0 blocked   0 waiting on requester   0 idle")
  assert.equal(todayText(STATUS), "today  5 flagged · 3 next steps posted", "the skipped hits are gone")
  assert.equal(todayText(undefined), "today  0 flagged · 0 next steps posted")
  assert.equal(footerText(), "↵ session   i issue   s slack   r refresh   e settings   d done")
  assert.ok(footerText().includes("d done"), "the footer names the d key")
  assert.equal(sidebarText(rows), "Slack Director  2 needs me · 1 blocked")
})

test("the poller cell shows its cycle time, its distinct reason and what the cycle read", () => {
  assert.equal(pollerCell(undefined), undefined, "nothing is shown before a cycle")
  assert.equal(pollerCell({ lastCycle: null }), undefined)
  assert.equal(
    pollerCell({
      lastCycle: "2026-11-19T14:32:00.000Z",
      outcome: "ok",
      issues: 11,
      threads: 4,
      conversations: 2,
      unattended: [],
      failed: [],
      possiblyCut: false,
    }),
    "poller 14:32 ✓ 11 issues · 4 threads · 2 conversations",
  )
  assert.equal(
    pollerCell({
      lastCycle: "2026-11-19T14:32:00.000Z",
      outcome: "rate limited",
      issues: 11,
      threads: 4,
      conversations: 2,
      unattended: [{}],
      failed: [7],
      possiblyCut: true,
    }),
    "poller 14:32 ✗ rate limited · 11 issues · 4 threads · 2 conversations · 1 unattended · list cut at 100",
    "throttling is told from a sign-in problem, and an incomplete list is not hidden by a failure",
  )
  assert.equal(
    pollerCell({
      lastCycle: "2026-11-19T14:32:00.000Z",
      outcome: "gh failed: not logged in",
      issues: 0,
      threads: 0,
      conversations: 0,
      unattended: [],
      failed: [],
      ghError: "not logged in",
      possiblyCut: false,
    }),
    "poller 14:32 ✗ not logged in · 0 issues · 0 threads · 0 conversations",
  )
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

test("the rows are grouped under their section, in request-state order, each entry carrying its index", () => {
  const rows = pageRows(ITEMS, liveOf)
  const groups = sections(rows)
  assert.deepEqual(
    groups.map((group) => [group.state, group.title]),
    [
      ["needs-me", "Needs me"],
      ["blocked", "Blocked"],
      ["waiting-requester", "Waiting on requester"],
      ["idle", "Idle"],
    ],
  )
  assert.deepEqual(
    groups.map((group) => group.entries.map((entry) => entry.index)),
    [
      [0, 1],
      [2],
      [3],
      [4],
    ],
    "each entry carries its position among all rows",
  )
  assert.deepEqual(sections([]), [], "a state with no rows has no section")
  assert.deepEqual(REQUEST_STATES, ["needs-me", "blocked", "waiting-requester", "idle"])
  assert.deepEqual(SECTION_TITLE, {
    "needs-me": "Needs me",
    blocked: "Blocked",
    "waiting-requester": "Waiting on requester",
    idle: "Idle",
  })
  assert.deepEqual(STATE_LABEL, {
    "needs-me": "needs me",
    blocked: "blocked",
    "waiting-requester": "waiting on requester",
    idle: "idle",
  })
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
      ["2 ", "base"],
      ["needs me", "muted"],
      ["   ", "muted"],
      ["1 ", "base"],
      ["blocked", "muted"],
      ["   ", "muted"],
      ["1 ", "base"],
      ["waiting on requester", "muted"],
      ["   ", "muted"],
      ["1 ", "base"],
      ["idle", "muted"],
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
      ["   ", "muted", false],
      ["d", "base", true],
      [" done", "muted", false],
    ],
  )
  assert.deepEqual(todayParts(STATUS).map((entry) => entry.role), ["muted", "muted"])
})

test("one row is the bar, the session mark, then ITEM, ASKER, CHANNEL, the issue and AGE", () => {
  const rows = pageRows(ITEMS, liveOf)
  const parts = rowParts(rows[0], { selected: true, now: NOW, hours: HOURS })

  assert.equal(rows[0].item.sessionID, "ses_3", "the first row is the newest of the first section")
  assert.equal(parts[0].text, " ".repeat(DIALOG_INSET - 2), "the row starts at its inset")
  assert.equal(parts[1].text, "┃", "the selected row draws the bar")
  assert.equal(parts[1].role, "bar")
  assert.equal(parts[3].text, SESSION_MARK.running, "a running turn shows its mark on the row")
  assert.equal(parts[3].role, "state-working")
  assert.equal(parts[5].text.trimEnd(), "Why the nightly export job fails")
  assert.equal(parts[5].role, "base", "ITEM is base text on a row outside the Idle section")
  assert.equal(parts[7].text.trimEnd(), "Ana Silva")
  assert.equal(parts[9].text.trimEnd(), "#data-eng")
  assert.equal(parts[11].text.trimEnd(), issueLabel(rows[0].item))
  assert.equal(parts[13].text, "2m", "AGE keeps its calendar text")

  const quiet = rowParts(rows[1], { selected: false, now: NOW, hours: HOURS })
  assert.equal(quiet[1].text, " ")
  assert.equal(quiet[1].role, "none")
  assert.equal(quiet[3].text, " ", "a session with no mark leaves the marker column blank")
  assert.equal(quiet[3].role, "none")

  const idle = rowParts(rows[4], { selected: false, now: NOW, hours: HOURS })
  assert.equal(rows[4].state, "idle")
  assert.equal(idle[5].role, "muted", "an idle row is muted throughout")
  assert.equal(idle[7].role, "muted")
})

test("a value too long for its column is shortened with an ellipsis", () => {
  const long = item({ title: "B".repeat(80), asker: "A".repeat(40), channel: "C".repeat(40) })
  const parts = rowParts({ item: long, state: "needs-me" }, { now: NOW, hours: HOURS })
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
  assert.equal(rowParts({ item: earlier, state: "needs-me" }, { now: NOW, hours: HOURS })[7].text.trimEnd(), "André Almeida")
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
  assert.equal(rowParts({ item: fresh, state: "needs-me" }, { now: NOW, hours: HOURS })[7].text, " ".repeat(ROW_WIDTHS.asker))
})

test("the selection move wraps at both ends, and the marker picks the row the keys act on", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.equal(moveSelection(4, 5, 1), 0, "down from the last row goes to the first")
  assert.equal(moveSelection(0, 5, -1), 4, "up from the first row goes to the last")
  assert.equal(moveSelection(2, 5, 1), 3, "down from a middle row is the next one")
  assert.equal(moveSelection(0, 0, 1), 0, "an empty table has no move")
  assert.equal(selectedItem(rows, 4).sessionID, "ses_4", "the selected row's item is the one the keys act on")
  assert.equal(selectedItem(rows, 0).sessionID, "ses_3")
  assert.equal(selectedItem([], 0), undefined)
})

test("the rows carry their identities in display order", () => {
  const rows = pageRows(ITEMS, liveOf)
  assert.deepEqual(rowIDs(rows), ["ses_3", "ses_1", "ses_2", "ses_5", "ses_4"])
  assert.deepEqual(rowIDs([]), [])
  assert.deepEqual(
    rowIDs(pageRows(ITEMS, liveOf, [orphan()])),
    ["ses_3", "ses_1", "ses_2", "issue:36", "ses_5", "ses_4"],
    "an unattended row is identified by its issue",
  )
  assert.equal(rowID({ item: { sessionID: "ses_9", issueNumber: 41 } }), "ses_9", "a session's own id wins")
  assert.equal(rowID({ item: { issueNumber: 41 } }), "issue:41")
  assert.equal(rowID({ item: {} }), undefined, "a row with neither has no identity")
})

test("the marker follows an identity through a reordering, and a removed item hands it to a neighbor", () => {
  const ids = (order) => order.map((id) => ({ item: { sessionID: id }, state: "waiting" }))
  const order = ["a", "b", "c", "d"]

  assert.equal(
    reconcileSelection(ids(["d", "c", "b", "a"]), "b", order),
    2,
    "the selected identity keeps the marker where it now sits",
  )
  assert.equal(reconcileSelection(ids(["a", "c", "d"]), "b", order), 1, "the next survivor takes it")
  assert.equal(reconcileSelection(ids(["a", "d"]), "b", order), 1, "with no next survivor, the previous one takes it")
  assert.equal(reconcileSelection(ids(["c", "d"]), "b", order), 0, "with neither, the first remaining row takes it")
  assert.equal(reconcileSelection(ids(["c", "d"]), "a", ["a"]), 0, "the last item deleted picks the first remaining row")
  assert.equal(reconcileSelection([], "b", order), 0, "an empty table marks no row")
  assert.equal(reconcileSelection(ids(["a"]), "gone", []), 0, "an identity no order knows falls back to the first row")
})

test("every footer control carries its own action, and the esc hint carries close", () => {
  const carried = footerParts().filter((entry) => entry.action !== undefined)
  assert.deepEqual(
    carried.map((entry) => [entry.text, entry.action]),
    [
      ["↵", "session"],
      [" session", "session"],
      ["i", "issue"],
      [" issue", "issue"],
      ["s", "slack"],
      [" slack", "slack"],
      ["r", "refresh"],
      [" refresh", "refresh"],
      ["e", "settings"],
      [" settings", "settings"],
      ["d", "done"],
      [" done", "done"],
    ],
    "each key and its label are one control, with that key's own action",
  )
  assert.ok(
    footerParts().filter((entry) => entry.action === undefined).every((entry) => !("action" in entry)),
    "a part with no action keeps its plain shape",
  )
  assert.equal("action" in titleParts()[0], false, "the dialog's name carries no action")
  assert.equal(titleParts()[1].action, "close", "the esc hint carries the close action")
})

test("the age counts from the row's own time, in minutes, then hours, then days", () => {
  assert.equal(ageText(minutes(0), NOW), "0m")
  assert.equal(ageText(minutes(12), NOW), "12m")
  assert.equal(ageText(minutes(59), NOW), "59m")
  assert.equal(ageText(minutes(60), NOW), "1h")
  assert.equal(ageText(minutes(60 * 23), NOW), "23h")
  assert.equal(ageText(minutes(60 * 24), NOW), "1d")
  assert.equal(ageText(minutes(60 * 24 * 3), NOW), "3d")
  assert.equal(ageText("not a time", NOW), "—")
  assert.equal(ageText(undefined, NOW), "—", "a row that names no time shows a dash")
  assert.equal(ageText(minutes(-5), NOW), "0m", "a clock that runs behind reads as just now")
  assert.equal(issueLabel(item({ issueNumber: 41 })), "#41")
  assert.equal(issueLabel(item({ issueNumber: null })), "—")
})

test("a row's age counts from the issue's state_since when it has one, else from the flag", () => {
  assert.equal(ageStamp(item()), minutes(12), "a record with no state_since counts from its flag")
  assert.equal(
    ageStamp(item({ stateSince: minutes(90) })),
    minutes(90),
    "the issue's state_since wins over the flag",
  )
  assert.equal(
    ageStamp(item({ stateSince: "not a time" })),
    minutes(12),
    "an unreadable state_since falls back to the flag",
  )
  assert.equal(ageStamp({}), undefined, "a record with neither names no time")

  const rows = pageRows([item({ stateSince: minutes(90) })], () => ({}))
  assert.equal(rows[0].at, minutes(90))
  assert.equal(
    rowParts(rows[0], { now: NOW, hours: HOURS })[13].text,
    "1h",
    "AGE measures from state_since, not from the flag",
  )
})

test("an unattended open issue shows one row, in its state's section, marked as having no session", () => {
  const rows = pageRows(ITEMS, liveOf, [orphan()])
  const row = rows.find((entry) => entry.item.issueNumber === 36)
  assert.ok(row, "an open issue no item record names still takes a row")
  assert.equal(row.state, "blocked", "it sits in the section of its issue's own state")
  assert.ok(rowText(row, { now: NOW, hours: HOURS }).includes(NO_SESSION_MARK), "its row carries the no session mark")
  assert.equal(row.unattended, true)
  assert.equal(row.note, undefined, "with nothing unseen it carries no new activity flag")
  assert.equal(hasSession(row.item), false, "no session stands behind the row")
  assert.equal(row.item.issueUrl, orphan().url, "i opens the issue from the poller's status")
  assert.equal(row.item.permalink, orphan().permalink, "s opens the message from the poller's status")
  assert.equal(
    rows.filter((entry) => entry.item.issueNumber === 36).length,
    1,
    "one open issue takes exactly one row",
  )
  const parts = rowParts(row, { now: NOW, hours: HOURS })
  assert.equal(parts[3].text, NO_SESSION_MARK)
  assert.equal(parts[3].role, "muted")
  assert.equal(parts[5].text.trimEnd(), "VPN profile for the contractors", "the row keeps the issue's title")
  assert.equal(parts[7].text.trimEnd(), "Nuno Ferreira", "and the asker the issue's title carries")
})

test("an unattended row carries the new activity flag while the poller reports unseen messages", () => {
  const rows = pageRows(ITEMS, liveOf, [orphan({ newActivity: true })])
  const row = rows.find((entry) => entry.item.issueNumber === 36)
  assert.equal(row.note, NEW_ACTIVITY_MARK)
  const parts = rowParts(row, { now: NOW, hours: HOURS })
  assert.equal(parts.at(-1).text, NEW_ACTIVITY_MARK, "the flag follows the age cell")
  const text = rowText(row, { now: NOW, hours: HOURS })
  assert.ok(text.includes(NO_SESSION_MARK), "the row still carries the no session mark")
  assert.ok(text.includes(NEW_ACTIVITY_MARK), "and the new activity flag")
})

test("an unattended row ages by its state_since, else by its asked_at", () => {
  const withSince = pageRows([], () => ({}), [orphan()])[0]
  assert.equal(withSince.at, minutes(60 * 5))
  assert.equal(rowParts(withSince, { now: NOW, hours: HOURS })[13].text, "5h")
  const noSince = pageRows([], () => ({}), [orphan({ state_since: undefined })])[0]
  assert.equal(noSince.at, orphan().asked_at, "with no state_since the age counts from asked_at")
  assert.equal(rowParts(noSince, { now: NOW, hours: HOURS })[13].text, "1d")
})

test("an unattended issue with no state or an unknown one reads as needs-me", () => {
  const rows = pageRows([], () => ({}), [orphan({ state: undefined }), orphan({ number: 35, state: "unknown" })])
  assert.deepEqual(
    rows.map((row) => row.state),
    ["needs-me", "needs-me"],
    "a missing state and an unknown one both read as needs-me",
  )
  assert.deepEqual(
    rows.map((row) => row.item.issueNumber),
    [36, 35],
  )
  assert.deepEqual(
    sections(rows).map((group) => group.state),
    ["needs-me"],
  )
})

test("the counts line and the sidebar count every row, unattended rows included", () => {
  const rows = pageRows(ITEMS, liveOf, [orphan()])
  assert.equal(countsText(rows), "2 needs me   2 blocked   1 waiting on requester   1 idle")
  assert.equal(sidebarText(rows), "Slack Director  2 needs me · 2 blocked")
  assert.equal(countsText([]), "0 needs me   0 blocked   0 waiting on requester   0 idle")
  assert.equal(sidebarText([]), "Slack Director  0 needs me · 0 blocked")
})

test("AGE's colour uses working time: base under 4 working hours, warning from 4, error from one day", () => {
  const flagged = "2026-11-23T09:00:00Z"
  const calm = ageRole("needs-me", flagged, Date.parse("2026-11-23T12:59:00Z"), HOURS)
  assert.equal(calm, "age-calm", "239 working minutes is under the warning")
  assert.equal(AGE_WARNING_MINUTES, 4 * 60)
  assert.equal(ageRole("needs-me", flagged, Date.parse("2026-11-23T13:00:00Z"), HOURS), "age-warn", "exactly 4 working hours warns")
  assert.equal(ageRole("needs-me", flagged, Date.parse("2026-11-23T17:59:00Z"), HOURS), "age-warn", "under one working day")
  assert.equal(ageRole("needs-me", flagged, Date.parse("2026-11-23T18:00:00Z"), HOURS), "age-error", "exactly one working day errors")
  assert.equal(ageRole("blocked", flagged, Date.parse("2026-11-24T10:00:00Z"), HOURS), "age-error", "one day plus an hour")
  assert.equal(ageRole("idle", flagged, Date.parse("2026-12-31T00:00:00Z"), HOURS), "muted", "an idle row is muted throughout")
})

test("AGE's colour counts working time, not calendar time", () => {
  // Friday 17:00 to Monday 10:00 is 65 calendar hours but only 2 working hours.
  const flagged = "2026-11-20T17:00:00Z"
  const now = Date.parse("2026-11-23T10:00:00Z")
  assert.equal(ageRole("needs-me", flagged, now, HOURS), "age-calm", "calendar time would have read as an error")
})

test("AGE's colour is calm outside the window and on a day it does not list", () => {
  assert.equal(ageRole("needs-me", "2026-11-21T12:00:00Z", Date.parse("2026-11-21T14:00:00Z"), HOURS), "age-calm")
  assert.equal(ageRole("needs-me", "not a time", NOW, HOURS), "age-calm", "an unreadable time is calm")
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
