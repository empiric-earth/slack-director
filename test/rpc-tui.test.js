// The RPC contract and the TUI part that calls it.
//
// The contract's schemas are checked against every answer the contract
// describes, with a validator written here so the suite needs no dependency,
// and the TUI part is driven with a fake context that records the keymap layers
// it registers, the sidebar claim, the dialogs it opens, the process it spawns
// and the toasts it shows. The dialog's own element tree is drawn with a stub
// renderer: the real renderer modules exist only inside a running TUI.
// No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { SlackDirectorRpc } from "../rpc.js"
import { schemaProblem } from "./schema.js"
import {
  DIALOG_INSET,
  NEW_ACTIVITY_MARK,
  NO_SESSION_MARK,
  PAGE_TITLE,
  SESSION_MARK,
  countsText,
  footerParts,
  footerText,
  hasSession,
  headerLines,
  legendText,
  moveSelection,
  pageRows,
  partsText,
  pollerLineText,
  rowText,
  sidebarText,
  slackLineText,
  titleParts,
  todayText,
} from "../src/page.js"
import tui, {
  COMMAND_ID,
  NO_SESSION_CLOSE_NOTICE,
  NO_SESSION_OPEN_NOTICE,
  SETTINGS_COMMAND_ID,
  createTui,
  dialogView,
  roleColour,
  selectedBackground,
} from "../tui.js"

const NOW = Date.parse("2026-11-19T14:32:00.000Z")
const HOURS = { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "18:00", time_zone: "UTC" }

const STATUS = {
  lastPoll: "2026-11-19T14:32:00.000Z",
  outcome: "ok",
  workspaces: [
    { name: "slack_nexar", ok: true, error: null },
    { name: "slack_nauto", ok: false, error: "sign-in expired — run /mcps" },
  ],
  configError: null,
  today: { flagged: 2, nextStepsPosted: 1, skipped: 1 },
}

const CONFIG = {
  flag_emoji: "magic_wand",
  intake_repo: "empiric-earth/almeida-slack-intake",
  session_directory: "/home/someone/notes",
  poll_seconds: 60,
  poll_minutes: 5,
  work_hours: HOURS,
  session_agent: "slack-director",
}

// A stub theme with OpenCode v2.4.0's shape: every role and every step a
// distinct value, the primary action text the title and the sections take, and
// the hues the waiting, working and new-activity marks take.
const STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const scale = (name) => Object.fromEntries(STEPS.map((step) => [step, `${name}-${step}`]))
const SEMANTIC_HUES = { accent: scale("accent"), interactive: scale("interactive"), neutral: scale("neutral") }
const THEME = {
  text: {
    base: "base",
    muted: "muted",
    action: { primary: { base: "primary" } },
    formfield: { focused: "formfield-focused" },
    feedback: { warning: { base: "warning" }, error: { base: "error" }, info: { base: "info" } },
  },
  background: { action: { primary: { focused: "bg-primary-focused" } } },
  hue: { ...SEMANTIC_HUES, orange: scale("orange"), blue: scale("blue"), yellow: scale("yellow") },
}
/** A theme that defines only the required semantic hues, so orange, blue and yellow are absent. */
const THEME_NO_HUES = { ...THEME, hue: SEMANTIC_HUES }
/** A theme whose action record names no primary text colour, so the accent falls back. */
const THEME_NO_PRIMARY = { ...THEME, text: { ...THEME.text, action: {} } }
const BOLD = 1

const ITEM = {
  permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219",
  workspace: "slack_nexar",
  channel: "#platform-help",
  asker: "Maria Costa",
  flaggedAt: "2026-11-19T14:30:00.000Z",
  sessionID: "ses_1",
  title: "Access to the staging dashboards",
  issueNumber: 41,
  issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/41",
  requestState: "needs-me",
  stateSince: null,
  blockedOn: null,
  waitingOn: [],
  issueClosed: false,
  firstTurnEndedAt: "2026-11-19T14:31:00.000Z",
  firstTurnFailed: false,
  permissionPending: false,
  openedAt: null,
}

/** A second item, in the Idle section, so the dialog holds two rows. */
const SECOND = {
  ...ITEM,
  permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137220",
  sessionID: "ses_2",
  title: "Review of the Terraform module change",
  issueNumber: 40,
  issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/40",
  flaggedAt: "2026-11-19T13:32:00.000Z",
  openedAt: "2026-11-19T14:00:00.000Z",
  requestState: "idle",
}

/** One unattended open issue, as the poller's last cycle serves it. */
const UNATTENDED = {
  number: 36,
  url: "https://github.com/empiric-earth/almeida-slack-intake/issues/36",
  title: "Nuno Ferreira — VPN profile for the contractors",
  permalink: "https://nexar.slack.com/archives/C0IT/p1795194400999000",
  state: "blocked",
  state_since: "2026-11-19T09:32:00.000Z",
  asked_at: "2026-11-18T08:32:00.000Z",
  newActivity: true,
  asker: "Nuno Ferreira (U0000000036)",
  channel_name: "eng-infra",
}

/** The same entry as a status the older build stored carries it: the two new fields absent. */
const OLDER_UNATTENDED = {
  number: 36,
  url: "https://github.com/empiric-earth/almeida-slack-intake/issues/36",
  title: "Nuno Ferreira — VPN profile for the contractors",
  permalink: "https://nexar.slack.com/archives/C0IT/p1795194400999000",
  state: "blocked",
  state_since: "2026-11-19T09:32:00.000Z",
  asked_at: "2026-11-18T08:32:00.000Z",
  newActivity: true,
}

/** The status with one poller cycle, carrying the unattended issue. */
const STATUS_WITH_POLLER = {
  ...STATUS,
  poller: {
    lastCycle: "2026-11-19T14:32:00.000Z",
    outcome: "ok",
    issues: 11,
    threads: 4,
    conversations: 2,
    unattended: [UNATTENDED],
    ghError: null,
    failed: [],
    possiblyCut: false,
  },
}

/** The same status as the older build stored it: the unattended entry lacks the two new fields. */
const OLDER_STATUS = {
  ...STATUS_WITH_POLLER,
  poller: { ...STATUS_WITH_POLLER.poller, unattended: [OLDER_UNATTENDED] },
}

/** The same status whose last cycle failed on three issues. */
const STATUS_FAILED = {
  ...STATUS_WITH_POLLER,
  poller: { ...STATUS_WITH_POLLER.poller, outcome: "rate limited: #7", failed: [7, 8, 9] },
}

function fakeTuiContext({
  status = STATUS,
  items = [ITEM, SECOND],
  config = CONFIG,
  rejection,
  setRejection,
  selectAnswer,
  promptAnswer,
  confirmAnswer,
} = {}) {
  // The item map the contract serves. `setItems` swaps it, so a test drives a
  // refresh with rows that appeared, reordered or left.
  let currentItems = items
  // The status the contract serves. `setStatus` swaps it, so a test drives a
  // refresh with a poller cycle that read another list of issues.
  let currentStatus = status
  const layers = []
  const dropped = []
  const toasts = []
  const slots = []
  const navigations = []
  const rpcIds = []
  const calls = []
  const eventHandlers = []
  const opened = []
  const selections = []
  const prompts = []
  const confirms = []
  const doneInputs = []
  const dialogs = []
  const dialogSettings = []
  const cleared = []
  const context = {
    theme: THEME,
    keymap: {
      layer: (factory) => {
        const entry = factory()
        layers.push(entry)
        return () => dropped.push(entry)
      },
    },
    ui: {
      toast: { show: (options) => toasts.push(options) },
      router: { navigate: (destination) => navigations.push(destination) },
      slot: (claim) => {
        slots.push(claim)
        return () => {}
      },
      dialog: {
        show: (render, onClose) => {
          dialogs.push({ render, onClose })
          return () => {}
        },
        set: (options) => dialogSettings.push(options),
        clear: () => cleared.push(true),
        select: async (options) => {
          selections.push(options)
          return selectAnswer
        },
        prompt: async (options) => {
          prompts.push(options)
          return promptAnswer
        },
        confirm: async (options) => {
          confirms.push(options)
          return confirmAnswer
        },
      },
    },
    client: {
      rpc(definition) {
        rpcIds.push(definition.id)
        return {
          async status() {
            calls.push("status")
            if (rejection) throw rejection
            return currentStatus
          },
          async items() {
            calls.push("items")
            if (rejection) throw rejection
            return { items: currentItems }
          },
          async getConfig() {
            calls.push("getConfig")
            if (rejection) throw rejection
            return { config }
          },
          async setConfig(input) {
            calls.push("setConfig")
            if (setRejection) throw setRejection
            return { config: { ...config, [input.field]: input.value } }
          },
          async pollNow() {
            calls.push("pollNow")
            return {}
          },
          async markOpened(input) {
            calls.push("markOpened")
            opened.push(input)
            return {}
          },
          async done(input) {
            calls.push("done")
            doneInputs.push(input)
            return {}
          },
          events: {
            on: (name, handler) => {
              eventHandlers.push([name, handler])
              return () => {}
            },
          },
        }
      },
    },
    data: {
      session: {
        status: () => "idle",
        permission: { list: () => [] },
      },
    },
  }
  return {
    context,
    layers,
    dropped,
    toasts,
    slots,
    navigations,
    rpcIds,
    calls,
    eventHandlers,
    opened,
    selections,
    prompts,
    confirms,
    doneInputs,
    dialogs,
    dialogSettings,
    cleared,
    setItems: (next) => {
      currentItems = next
    },
    setStatus: (next) => {
      currentStatus = next
    },
  }
}

/** The TUI part with a stub renderer, so the dialog's own element tree can be read. */
const renderedTui = () => createTui({ renderer: stubRenderer() })

/** The TUI part with the URL opener recorded rather than run. */
function recordedTui(spawned) {
  return createTui({
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options })
      return { on: () => {}, unref: () => {} }
    },
  })
}

/**
 * The TUI part with both the stub renderer and the recorded opener, so a test
 * can read the drawn tree and see what a click opened.
 */
function renderedRecordedTui(spawned) {
  return createTui({
    renderer: stubRenderer(),
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options })
      return { on: () => {}, unref: () => {} }
    },
  })
}

/** The host's element factory, replaced by a recorder with a plain memo. */
function stubRenderer() {
  return {
    createElement: (type) => ({ type, props: {} }),
    spread: (node, props) => {
      node.props = { ...node.props, ...props }
    },
    createSignal: (initial) => {
      let value = initial
      return [() => value, (next) => (value = next)]
    },
    createMemo: (fn) => fn,
  }
}

/** The lines the dialog draws, in order. */
const drawnLines = (view) => view.props.children()

/** The parts of one line; a blank line has none. */
const lineChildren = (line) => (line.type === "box" ? line.props.children : [])

/** The text of one line. */
const lineText = (line) =>
  line.type === "box" ? lineChildren(line).map((child) => child.props.content).join("") : line.props.content

const childWith = (line, text) => lineChildren(line).find((child) => child.props.content === text)

/**
 * The dialog's row lines: a row starts at its own inset, with a gutter bar, so
 * its first part is one space and it carries more than one part. Every other
 * line — the title, the header, the counts, a section header, the today line and
 * the footer — starts with its own text.
 */
const rowLines = (view) =>
  drawnLines(view).filter((line) => lineChildren(line).length > 1 && lineChildren(line)[0].props.content === " ")

/** Render the dialog with these rows and this theme, through the stub renderer. */
function viewOf(rows, { status = STATUS, selected = () => 0, theme = THEME, now = () => NOW, hours = () => HOURS } = {}) {
  return dialogView({
    renderer: stubRenderer(),
    rows: () => rows,
    status: () => status,
    selected,
    now,
    hours,
    theme,
  })
}

/** The modal keymap layer the dialog registered. */
const modalLayer = (layers) => layers.find((layer) => layer.mode === "modal")

/**
 * The host renders a shown dialog once, and the dialog registers its own key
 * layer from that render; the layer lives and dies with the dialog.
 */
const renderDialog = (dialogs) => dialogs.at(-1).render()

/** Let the pending promises of a key's handler settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** The dialog's clickable parts, in the order they are drawn. */
const clickables = (view) =>
  drawnLines(view)
    .flatMap((line) => lineChildren(line))
    .filter((child) => typeof child.props.onMouseUp === "function")

/** A mouse event of the host's own shape. */
const mouseEvent = (button = 0) => ({ button, preventDefault() {}, stopPropagation() {} })

/** A primary click on one of the dialog's clickable parts: a press, then a release. */
function primaryClick(view, index = 0) {
  const part = clickables(view)[index]
  assert.ok(part, `a clickable part is drawn at ${index}`)
  part.props.onMouseDown(mouseEvent())
  part.props.onMouseUp(mouseEvent())
}

/** The text of every clickable part, in the order it is drawn. */
const clickableTexts = (view) => clickables(view).map((child) => child.props.content)

/**
 * A primary click on the one clickable part whose text is exactly `content`, so
 * a test names the control it clicks instead of counting parts. Fails when no
 * part reads that text, and when more than one does.
 */
function clickPart(view, content) {
  const found = clickables(view).filter((child) => child.props.content === content)
  assert.equal(found.length, 1, `exactly one clickable part reads ${JSON.stringify(content)}`)
  found[0].props.onMouseDown(mouseEvent())
  found[0].props.onMouseUp(mouseEvent())
  return found[0]
}

/** A primary click on the footer's Done hint. */
const clickDone = (view) => clickPart(view, "d")

/** The text cell of the row the marker is on, or undefined when no row is marked. */
function markedItem(view) {
  const line = rowLines(view).find((candidate) => childWith(candidate, "┃") !== undefined)
  return line ? lineChildren(line)[11].props.content.trim() : undefined
}

/** The modal layers the dialog has registered and not dropped. */
const liveModalLayers = ({ layers, dropped }) =>
  layers.filter((layer) => layer.mode === "modal" && !dropped.includes(layer))

test("the RPC contract defines every method and every event with a schema", () => {
  assert.equal(SlackDirectorRpc.id, "slack-director")
  assert.deepEqual(Object.keys(SlackDirectorRpc.methods).sort(), [
    "done",
    "getConfig",
    "items",
    "markOpened",
    "pollNow",
    "setConfig",
    "status",
  ])
  assert.deepEqual(Object.keys(SlackDirectorRpc.events), ["updated", "closeRefused"])
  assert.equal(SlackDirectorRpc.events.updated.schema, SlackDirectorRpc.methods.pollNow.output)
  const refusal = SlackDirectorRpc.events.closeRefused.schema
  assert.deepEqual(refusal.required, ["sessionID", "reason"])
  assert.equal(refusal.additionalProperties, false, "a refusal notice carries no other field")
  assert.equal(schemaProblem(refusal, { sessionID: "ses_1", reason: "the session is running — try again when it is idle" }), undefined)
  assert.match(schemaProblem(refusal, { sessionID: "ses_1" }), /has no reason/)
  for (const [name, method] of Object.entries(SlackDirectorRpc.methods)) {
    assert.equal(method.input.type, "object", `${name} takes an object`)
    assert.equal(method.output.type, "object", `${name} answers an object`)
  }
  const status = SlackDirectorRpc.methods.status
  assert.deepEqual(status.output.required, ["lastPoll", "outcome", "workspaces", "configError", "today"])
  assert.deepEqual(status.output.properties.workspaces.items.required, ["name", "ok", "error"])
  assert.deepEqual(status.output.properties.today.required, ["flagged", "nextStepsPosted", "skipped"])
  const poller = status.output.properties.poller
  const unattended = poller.properties.unattended.items
  assert.deepEqual(
    unattended.required,
    ["number", "url", "title", "permalink", "state", "state_since", "asked_at", "newActivity"],
    "an unattended issue carries what a row needs, from the poller's own status",
  )
  assert.deepEqual(
    [unattended.properties.asker, unattended.properties.channel_name],
    [{ type: "string" }, { type: "string" }],
    "the requester and the type are declared",
  )
  assert.ok(
    !unattended.required.includes("asker") && !unattended.required.includes("channel_name"),
    "and both are optional, so a status the older build stored still validates",
  )
  assert.equal(
    schemaProblem(status.output, STATUS_WITH_POLLER),
    undefined,
    "a status whose poller read one unattended issue fits the contract",
  )
  assert.equal(
    schemaProblem(status.output, OLDER_STATUS),
    undefined,
    "a status stored before the two fields existed still validates",
  )
  assert.equal(schemaProblem(status.output, STATUS_FAILED), undefined, "a status naming failed issues fits too")
})

test("the contract's config schema carries the flag emoji and the session agent, and not the retired field", () => {
  const config = SlackDirectorRpc.methods.getConfig.output.properties.config
  assert.ok(config.properties.flag_emoji, "the config schema declares flag_emoji")
  assert.ok(config.required.includes("flag_emoji"), "flag_emoji is required")
  assert.ok(config.properties.session_agent, "the config schema carries session_agent")
  assert.equal(config.properties.triage_agent, undefined, "the retired field is gone from the schema")
  assert.ok(config.required.includes("session_agent"), "session_agent is required")
  assert.ok(!config.required.includes("triage_agent"))
})

test("the contract's schemas describe the answers it names, and reject a value that misses", () => {
  const items = SlackDirectorRpc.methods.items.output
  assert.equal(schemaProblem(items, { items: [ITEM] }), undefined, "a full item record fits")
  assert.match(schemaProblem(items, { items: [{ ...ITEM, channel: 3 }] }), /channel is not a string/)
  assert.match(schemaProblem(items, { items: [{ ...ITEM, extra: true }] }), /undeclared extra/)
  assert.match(schemaProblem(items, { items: [{}] }), /has no permalink/)
  const item = SlackDirectorRpc.methods.items.output.properties.items.items
  assert.deepEqual(item.required, [
    "permalink",
    "workspace",
    "channel",
    "asker",
    "flaggedAt",
    "sessionID",
    "title",
    "issueNumber",
    "issueUrl",
    "requestState",
    "stateSince",
    "blockedOn",
    "waitingOn",
    "issueClosed",
    "firstTurnEndedAt",
    "firstTurnFailed",
    "permissionPending",
    "openedAt",
  ])
  assert.equal(item.properties.requestState.type, "string", "the request state the poller read is served")
  assert.deepEqual(item.properties.waitingOn.items, { type: "string" })
  assert.equal(item.properties.issueClosed.type, "boolean", "a closed issue is told from an open one")
  const config = SlackDirectorRpc.methods.getConfig.output
  assert.equal(schemaProblem(config, { config: CONFIG }), undefined, "the config fits")
  assert.match(schemaProblem(config, { config: { ...CONFIG, poll_seconds: "60" } }), /poll_seconds is not an integer/)
  assert.match(schemaProblem(config, { config: { ...CONFIG, work_hours: { days: [], start: "09:00" } } }), /has no end/)
  const invalid = SlackDirectorRpc.methods.setConfig.errors.invalid
  assert.equal(schemaProblem(invalid, { field: "poll_seconds" }), undefined)
  assert.equal(schemaProblem(invalid, { field: null }), undefined, "a file-level problem has no field to name")
  assert.match(schemaProblem(invalid, { field: 3 }), /field is none of string, null/)
  assert.equal(schemaProblem(SlackDirectorRpc.methods.status.output, STATUS), undefined, "a status fits")
  assert.equal(schemaProblem(SlackDirectorRpc.methods.pollNow.output, {}), undefined, "an empty answer fits")
})

test("the TUI part registers the two palette entries and the sidebar line, and no route", async () => {
  const { context, layers, slots, dialogs } = fakeTuiContext()
  await tui.setup(context)
  assert.equal(tui.id, "slack-director.tui")

  assert.equal(dialogs.length, 0, "no dialog is open before the user asks for one")
  assert.equal(layers.length, 1, "one keymap layer for the commands")
  assert.equal(layers[0].mode, "global")
  const [page, settings] = layers[0].commands
  assert.equal(page.id, COMMAND_ID)
  assert.equal(page.title, PAGE_TITLE, "the palette entry is the dialog's title")
  assert.equal(page.palette, true)
  assert.deepEqual(page.slash, { name: "slack-director" }, "the slash command is /slack-director")
  assert.equal(settings.id, SETTINGS_COMMAND_ID)
  assert.equal(settings.title, "Slack Director: settings")
  assert.equal(settings.palette, true)

  assert.equal(slots.length, 1, "one slot claim")
  assert.equal(slots[0].append, "sidebar.content", "the sidebar line sits in the session sidebar")
  assert.equal(typeof slots[0].render, "function")
})

test("the Slack Director entry opens a floating dialog with its own modal keys", async () => {
  const { context, layers, dialogs, dialogSettings, calls, navigations } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)

  assert.equal(dialogs.length, 1, "one floating dialog is open")
  assert.deepEqual(dialogSettings, [{ size: "xlarge", centered: true }], "the dialog takes the layout's own size")
  assert.deepEqual(navigations, [], "no route is navigated to: the dialog floats over the current screen")
  assert.deepEqual(calls.slice(-3), ["items", "status", "getConfig"], "the command reads the items, the status and the config")

  const modal = modalLayer(layers)
  assert.ok(modal, "the dialog registers a keymap layer")
  assert.equal(modal.mode, "modal", "the layer answers while the dialog holds the modal mode")
  assert.deepEqual(
    modal.commands.map((command) => [command.bind, command.id]),
    [
      ["return", `${COMMAND_ID}.open`],
      ["i", `${COMMAND_ID}.issue`],
      ["s", `${COMMAND_ID}.slack`],
      ["r", `${COMMAND_ID}.poll`],
      ["e", `${COMMAND_ID}.settings`],
      ["d", `${COMMAND_ID}.done`],
      ["up", `${COMMAND_ID}.up`],
      ["down", `${COMMAND_ID}.down`],
    ],
  )
  assert.equal(
    modal.commands.some((command) => command.bind === "comma"),
    false,
    "the settings key is e, not a comma",
  )
})

test("up and down move the marker while the dialog stays open", () => {
  const rows = pageRows([ITEM, SECOND], () => ({ running: false, pending: 0 }))
  const [selected, setSelected] = stubRenderer().createSignal(0)
  const view = viewOf(rows, { selected })
  const marker = (index) => childWith(rowLines(view)[index], "┃") !== undefined

  assert.equal(marker(0), true, "the first row is marked when the dialog opens")
  assert.equal(marker(1), false)

  setSelected(moveSelection(selected(), rows.length, 1))
  assert.equal(marker(0), false, "down moves the marker off the first row")
  assert.equal(marker(1), true, "the marker follows the selection while the dialog stays open")

  setSelected(moveSelection(selected(), rows.length, 1))
  assert.equal(marker(0), true, "down from the last row goes to the first")

  setSelected(moveSelection(selected(), rows.length, -1))
  assert.equal(marker(1), true, "up from the first row goes to the last")
})

test("the keys act on the row the marker marks", async () => {
  const spawned = []
  const { context, layers, dialogs, opened, navigations } = fakeTuiContext()
  await recordedTui(spawned).setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)

  const modal = modalLayer(layers)
  const command = (bind) => modal.commands.find((entry) => entry.bind === bind)

  // Up from the first row wraps to the last, and Enter opens that row's session.
  command("up").run()
  command("return").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(opened, [{ sessionID: SECOND.sessionID }], "Enter marks the row the marker is on as read")
  assert.deepEqual(
    navigations,
    [{ type: "session", sessionID: SECOND.sessionID }],
    "Enter opens the session of the marked row",
  )

  // i and s open the marked row's own URLs, and never another row's.
  const second = fakeTuiContext()
  await recordedTui(spawned).setup(second.context)
  await second.layers[0].commands[0].run()
  renderDialog(second.dialogs)
  const secondModal = modalLayer(second.layers)
  secondModal.commands.find((entry) => entry.bind === "down").run()
  secondModal.commands.find((entry) => entry.bind === "i").run()
  secondModal.commands.find((entry) => entry.bind === "s").run()
  assert.deepEqual(spawned.at(-2).args, [SECOND.issueUrl], "i opens the marked row's intake issue")
  assert.deepEqual(spawned.at(-1).args, [SECOND.permalink], "s opens the marked row's Slack message")
})

test("an unattended open issue takes one row from the poller's status, with the no session and new activity marks", async () => {
  const fake = fakeTuiContext({ status: STATUS_WITH_POLLER, items: [ITEM] })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)
  const rows = rowLines(view)
  const rowTexts = rows.map(lineText)
  const texts = drawnLines(view).map(lineText)

  assert.equal(rows.length, 2, "the item and the unattended issue take one row each")
  const orphan = rowTexts.find((text) => text.includes(UNATTENDED.title.split(" — ")[1]))
  assert.ok(orphan, "the unattended issue shows the request its issue title names")
  assert.ok(orphan.includes(NO_SESSION_MARK), "its row carries the no session mark")
  assert.ok(orphan.includes(NEW_ACTIVITY_MARK), "and the new activity flag the status carries")
  assert.ok(texts.includes("Blocked"), "it sits in the section of the state its issue carries")
  assert.ok(
    lineText(rows[0]).includes(UNATTENDED.title.split(" — ")[1]) === false,
    "the item with a session keeps its own row",
  )
})

test("the unattended row leaves the dialog once the poller's list no longer carries its issue", async () => {
  const fake = fakeTuiContext({ status: STATUS_WITH_POLLER, items: [] })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)
  assert.equal(rowLines(view).length, 1, "the open issue no item record names takes a row")

  const updated = fake.eventHandlers.find(([name]) => name === "updated")[1]
  fake.setStatus({ ...STATUS_WITH_POLLER, poller: { ...STATUS_WITH_POLLER.poller, unattended: [] } })
  updated({})
  await tick()
  assert.equal(rowLines(view).length, 0, "a complete list without the issue leaves no row behind")
})

test("enter and d on an unattended row open no session and close nothing", async () => {
  const fake = fakeTuiContext({ status: STATUS_WITH_POLLER, items: [] })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  const modal = modalLayer(fake.layers)
  const command = (bind) => modal.commands.find((entry) => entry.bind === bind)

  command("return").run()
  await tick()
  assert.deepEqual(fake.opened, [], "no session is marked read, and none is opened")
  assert.deepEqual(fake.navigations, [], "no session is opened for an unattended issue")
  assert.ok(fake.toasts.at(-1).message.includes(NO_SESSION_OPEN_NOTICE), "the dialog says it has no session")
  assert.equal(fake.cleared.length, 0, "the overview stays up, so the row is still there to act on")

  command("d").run()
  await tick()
  assert.deepEqual(fake.doneInputs, [], "no close is requested")
  assert.deepEqual(fake.confirms, [], "and no confirm is asked for it")
  assert.ok(fake.toasts.at(-1).message.includes(NO_SESSION_CLOSE_NOTICE), "the dialog says the issue is closed on GitHub")
})

test("i and s on an unattended row open its issue and its message from the poller's status", async () => {
  const spawned = []
  const fake = fakeTuiContext({ status: STATUS_WITH_POLLER, items: [] })
  await renderedRecordedTui(spawned).setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  const modal = modalLayer(fake.layers)

  modal.commands.find((entry) => entry.bind === "i").run()
  modal.commands.find((entry) => entry.bind === "s").run()
  assert.deepEqual(spawned.at(-2).args, [UNATTENDED.url], "i opens the unattended issue")
  assert.deepEqual(spawned.at(-1).args, [UNATTENDED.permalink], "s opens the message the poller reported")
})

test("the marker stays on an unattended row across a refresh, and its shortcuts stay its own", async () => {
  const spawned = []
  const fake = fakeTuiContext({ status: STATUS_WITH_POLLER, items: [ITEM] })
  await renderedRecordedTui(spawned).setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)
  const modal = modalLayer(fake.layers)
  const command = (bind) => modal.commands.find((entry) => entry.bind === bind)

  // Row 0 is the item, row 1 the unattended issue; the marker moves to it.
  command("down").run()
  assert.equal(markedItem(view), "VPN profile for the contractors", "the marker sits on the unattended row")

  // A routine poll answers with the same rows: the marker must stay on the
  // unattended row, whose identity is its issue, not slide to the item above it.
  const updated = fake.eventHandlers.find(([name]) => name === "updated")[1]
  updated({})
  await tick()
  assert.equal(
    markedItem(view),
    "VPN profile for the contractors",
    "the marker stays on the unattended row after a refresh",
  )

  command("i").run()
  command("s").run()
  assert.deepEqual(spawned.at(-2).args, [UNATTENDED.url], "i still opens the unattended row's issue")
  assert.deepEqual(spawned.at(-1).args, [UNATTENDED.permalink], "s still opens its message")
})

test("an opener that cannot start is reported instead of failing silently", async () => {
  const spawned = []
  const handlers = []
  const { context, layers, dialogs, toasts } = fakeTuiContext()
  await createTui({
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options })
      return { on: (name, handler) => handlers.push([name, handler]), unref: () => {} }
    },
  }).setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  modalLayer(layers).commands.find((entry) => entry.bind === "i").run()

  assert.equal(spawned.length, 1, "the opener was started")
  const failure = handlers.find(([name]) => name === "error")
  assert.ok(failure, "the opener's own failure event is watched")
  // A missing opener binary is reported asynchronously, on the child's error
  // event; the user must see it rather than a key that did nothing.
  failure[1](new Error("spawn xdg-open ENOENT"))
  assert.deepEqual(
    toasts.map((entry) => entry.message),
    [`${PAGE_TITLE}: spawn xdg-open ENOENT`],
    "the opener's failure reaches the user",
  )
  assert.equal(toasts.at(-1).variant, "error", "and it is shown as an error")
})

test("the dialog's footer names each key, and its keys are the ones it names", async () => {
  const { context, layers, dialogs } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  const modal = modalLayer(layers)
  const keys = modal.commands.map((command) => command.bind)
  for (const key of ["up", "down", "return", "i", "s", "r", "e", "d"]) {
    assert.ok(keys.includes(key), `the dialog answers ${key}`)
  }
  assert.equal(footerText(), "↵ session   i issue   s slack   r refresh   e settings   d done")
  assert.equal(
    layers[0].commands.some((command) => command.bind === "escape"),
    false,
    "Esc closes the dialog through the host's own modal layer",
  )
})

test("r polls now through the contract", async () => {
  const { context, layers, dialogs, calls } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  modalLayer(layers).commands.find((command) => command.bind === "r").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.includes("pollNow"), "r calls pollNow")
})

test("the contract's done method takes one session id and answers an empty object", () => {
  const done = SlackDirectorRpc.methods.done
  assert.ok(done, "the contract carries done")
  assert.equal(done.input.type, "object")
  assert.deepEqual(done.input.properties, { sessionID: { type: "string" } })
  assert.deepEqual(done.input.required, ["sessionID"])
  assert.equal(done.input.additionalProperties, false, "no other field is accepted")
  assert.deepEqual(done.output, { type: "object", properties: {}, additionalProperties: false })
  assert.equal(schemaProblem(done.output, {}), undefined, "an empty answer fits")
  assert.match(schemaProblem(done.input, { sessionID: 3 }), /sessionID is not a string/)
  assert.match(schemaProblem(done.input, { sessionID: "ses_1", extra: true }), /undeclared extra/)
})

test("d asks the confirm dialog once, naming the item and the delete, and a no answer calls no RPC method", async () => {
  const { context, layers, dialogs, confirms, cleared, calls } = fakeTuiContext({ confirmAnswer: false })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  const before = calls.length
  modalLayer(layers).commands.find((command) => command.bind === "d").run()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(confirms.length, 1, "the key asks one confirm dialog")
  assert.match(confirms[0].message, /Access to the staging dashboards/, "the message names the item")
  assert.match(confirms[0].message, /intake issue/i, "it says the intake issue will be closed")
  assert.match(confirms[0].message, /child sessions/i, "it says the session and its child sessions are deleted")
  assert.ok(cleared.length > 0, "the overview closes behind the confirm")
  assert.equal(dialogs.length, 2, "the key's own cancel brings the overview back")
  assert.equal(calls.length, before, "a no answer calls no RPC method")
  assert.equal(calls.includes("done"), false)
})

test("d's yes calls done once with the selected row's session and says the close started", async () => {
  const { context, layers, dialogs, confirms, doneInputs, calls, toasts } = fakeTuiContext({ confirmAnswer: true })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  const modal = modalLayer(layers)
  modal.commands.find((command) => command.bind === "down").run()
  modal.commands.find((command) => command.bind === "d").run()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(confirms.length, 1)
  assert.deepEqual(doneInputs, [{ sessionID: SECOND.sessionID }], "done is called once with the marked row's session")
  assert.equal(calls.filter((name) => name === "done").length, 1, "and only once")
  assert.match(toasts.at(-1).message, /closing/i, "a toast says the close started")
})

test("a close the contract refuses shows an error toast", async () => {
  const { context, layers, dialogs, toasts } = fakeTuiContext({ confirmAnswer: true })
  context.client.rpc = () => ({
    async items() {
      return { items: [ITEM, SECOND] }
    },
    async status() {
      return STATUS
    },
    async getConfig() {
      return { config: CONFIG }
    },
    async done() {
      throw new Error("the close was refused")
    },
    events: { on: () => () => {} },
  })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  modalLayer(layers).commands.find((command) => command.bind === "d").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toasts.at(-1).variant, "error")
  assert.match(toasts.at(-1).message, /the close was refused/)
})

test("e on the dialog opens the settings dialog", async () => {
  const { context, layers, dialogs, selections, prompts, toasts, cleared } = fakeTuiContext({
    selectAnswer: "poll_seconds",
    promptAnswer: "90",
  })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  modalLayer(layers).commands.find((command) => command.bind === "e").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cleared.length > 0, true, "the overview dialog closes behind the settings dialog")
  assert.equal(selections.length, 1, "one select list")
  assert.deepEqual(
    selections[0].options.map((option) => option.title),
    ["flag_emoji", "intake_repo", "session_directory", "poll_seconds", "poll_minutes", "work_hours", "session_agent"],
    "every config field is a row",
  )
  assert.equal(selections[0].options[3].description, "60", "the row shows the field's current value")
  assert.equal(prompts.length, 1, "one prompt for the chosen field")
  assert.equal(prompts[0].title, "Slack Director: poll_seconds")
  assert.equal(prompts[0].value, "60")
  assert.match(toasts.at(-1).message, /poll_seconds saved/)
  assert.equal(toasts.at(-1).variant, "success")
})

test("the overview's keys are registered by its own dialog, so no other dialog answers them", async () => {
  const { context, layers, dialogs, dropped } = fakeTuiContext()
  await tui.setup(context)
  const binds = () =>
    layers
      .filter((layer) => !dropped.includes(layer))
      .flatMap((layer) => (layer.commands ?? []).map((command) => command.bind))
      .filter(Boolean)
  assert.deepEqual(binds(), [], "setup registers no key of its own")

  // Another dialog is open — the TUI's own settings, the session list — and the
  // plugin answers none of its keys.
  await layers[0].commands[1].run()
  assert.deepEqual(binds(), [], "the settings entry registers no key")

  await layers[0].commands[0].run()
  assert.deepEqual(binds(), [], "opening the overview registers no key outside its dialog")
  renderDialog(dialogs)
  assert.ok(binds().includes("e"), "the dialog's own render registers the overview's keys")

  dialogs.at(-1).onClose()
  assert.deepEqual(binds(), [], "and the host's close takes them away with the dialog")
  assert.equal(dropped.length, 1)
})

test("e on the dialog drops the overview's own keys, so the settings dialog's keys reach it", async () => {
  const { context, layers, dialogs, dropped, selections } = fakeTuiContext({ selectAnswer: "poll_seconds", promptAnswer: "90" })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  assert.equal(dropped.length, 0, "the overview's keys hold while its dialog is open")
  modalLayer(layers).commands.find((command) => command.bind === "e").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dropped.length, 1, "the overview's modal keys are dropped as the settings dialog opens")
  assert.equal(selections.length, 1, "so the settings dialog is the one that answers the keys")

  const closed = fakeTuiContext()
  await tui.setup(closed.context)
  await closed.layers[0].commands[0].run()
  renderDialog(closed.dialogs)
  closed.dialogs.at(-1).onClose()
  assert.equal(closed.dropped.length, 1, "the host's own close drops the overview's keys too")
})

test("a rejection that is not an Error still shows its message", async () => {
  const { context, toasts } = fakeTuiContext({
    rejection: { type: "error", message: "RPC is unavailable: slack-director" },
  })
  await tui.setup(context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /RPC is unavailable/)
  assert.equal(toasts[0].message.includes("[object Object]"), false, "an error object is not shown as its own string")
})

test("the item map follows the contract's updated event", async () => {
  const { context, eventHandlers, calls } = fakeTuiContext()
  await tui.setup(context)
  assert.deepEqual(eventHandlers.map(([name]) => name), ["updated", "closeRefused"])
  const before = calls.length
  eventHandlers[0][1]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, before + 3, "the dialog reads the items, the status and the config again")
})

test("a close the watcher refuses reaches the dialog as an error toast with what to do next", async () => {
  const { context, eventHandlers, toasts } = fakeTuiContext()
  await tui.setup(context)
  const refused = eventHandlers.find(([name]) => name === "closeRefused")
  assert.ok(refused, "the dialog follows the contract's refusal event")
  refused[1]({ sessionID: "ses_1", reason: "the session is running — try again when it is idle" })
  assert.equal(toasts.at(-1).variant, "error", "a refusal is an error, not a success")
  assert.match(toasts.at(-1).message, /the session is running/, "the toast carries the reason")
  assert.match(toasts.at(-1).message, /try again/, "and what to do next")
})

test("a refusal event that arrives before the done answer is not overwritten by the closing toast", async () => {
  const { context, layers, dialogs, toasts, eventHandlers } = fakeTuiContext({ confirmAnswer: true })
  const base = context.client.rpc
  context.client.rpc = (definition) => ({
    ...base(definition),
    async done(input) {
      const refused = eventHandlers.find(([name]) => name === "closeRefused")
      refused[1]({ sessionID: input.sessionID, reason: "the session is running — try again when it is idle" })
      return {}
    },
  })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  modalLayer(layers).commands.find((command) => command.bind === "d").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toasts.at(-1).variant, "error", "the refusal stays the last toast")
  assert.match(toasts.at(-1).message, /try again/, "and it still says what to do next")
  assert.equal(toasts.some((toast) => /closing/.test(toast.message)), false, "no closing toast follows a refusal")
})

test("a refusal for another session does not hide the closing toast", async () => {
  const { context, layers, dialogs, toasts, eventHandlers } = fakeTuiContext({ confirmAnswer: true })
  const base = context.client.rpc
  context.client.rpc = (definition) => ({
    ...base(definition),
    async done() {
      const refused = eventHandlers.find(([name]) => name === "closeRefused")
      refused[1]({ sessionID: "ses_other", reason: "the session is running — try again when it is idle" })
      return {}
    },
  })
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  modalLayer(layers).commands.find((command) => command.bind === "d").run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(toasts.at(-1).message, /closing/, "a refusal of another close leaves this close's toast")
})

test("the Done hint is clickable: a primary click asks one confirm for the marked row, and another button asks none", async () => {
  const fake = fakeTuiContext({ confirmAnswer: false })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)

  assert.deepEqual(
    clickableTexts(view),
    ["esc", "↵", " session", "i", " issue", "s", " slack", "r", " refresh", "e", " settings", "d", " done"],
    "the esc hint and every footer key and its label carry a click handler",
  )

  // A non-primary press runs nothing, and a press alone is not yet a click.
  const part = clickables(view).find((child) => child.props.content === "d")
  part.props.onMouseDown(mouseEvent(2))
  part.props.onMouseUp(mouseEvent(2))
  part.props.onMouseDown(mouseEvent(0))
  await tick()
  assert.equal(fake.confirms.length, 0, "a press alone, and another button, ask no confirm")

  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.equal(fake.confirms.length, 1, "one click asks one confirm")
  assert.match(fake.confirms[0].message, /Review of the Terraform module change/, "the confirm names the marked row")
  assert.equal(fake.cleared.length > 0, true, "the overview closes behind the confirm, so its commands cannot fire")
})

test("every footer control is one target: its glyph and its label carry the same action", () => {
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
    "each key glyph and its label carry that key's own action",
  )
  assert.deepEqual(
    footerParts()
      .filter((entry) => entry.text === "   ")
      .map((entry) => "action" in entry),
    [false, false, false, false, false],
    "the spacers between the controls carry no action",
  )
  assert.equal("action" in titleParts()[0], false, "the dialog's name is not a control")
  assert.equal(titleParts()[1].action, "close", "the esc hint carries the close action")
})

test("a click on Issue, Slack or Refresh does what its shortcut does, on the marked row", async () => {
  const spawned = []
  const fake = fakeTuiContext()
  await renderedRecordedTui(spawned).setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  // The marked row is the second one, so a click must act on that row's own
  // values and never on the first row's.
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()

  clickPart(renderDialog(fake.dialogs), "i")
  assert.deepEqual(spawned.at(-1).args, [SECOND.issueUrl], "a click on the Issue key opens the marked row's intake issue")
  clickPart(renderDialog(fake.dialogs), " issue")
  assert.deepEqual(spawned.at(-1).args, [SECOND.issueUrl], "a click on the Issue label opens the same issue")

  clickPart(renderDialog(fake.dialogs), "s")
  assert.deepEqual(spawned.at(-1).args, [SECOND.permalink], "a click on the Slack key opens the marked row's message")
  clickPart(renderDialog(fake.dialogs), " slack")
  assert.deepEqual(spawned.at(-1).args, [SECOND.permalink], "a click on the Slack label opens the same message")
  assert.notEqual(SECOND.issueUrl, SECOND.permalink, "the two targets differ, so a swap between them is visible")

  const polls = () => fake.calls.filter((name) => name === "pollNow").length
  const before = polls()
  clickPart(renderDialog(fake.dialogs), "r")
  await tick()
  assert.equal(polls(), before + 1, "a click on Refresh runs exactly one poll")
  assert.equal(fake.dialogs.length, 1, "and leaves the overview open")
})

test("a click on Session, Settings or the esc hint runs its shortcut's own operation", async () => {
  // Session: a click closes the overview and opens the marked row's session.
  const session = fakeTuiContext()
  await renderedTui().setup(session.context)
  await session.layers[0].commands[0].run()
  renderDialog(session.dialogs)
  modalLayer(session.layers).commands.find((command) => command.bind === "down").run()
  clickPart(renderDialog(session.dialogs), "↵")
  await tick()
  assert.deepEqual(session.opened, [{ sessionID: SECOND.sessionID }], "a click on Session marks the marked row read")
  assert.deepEqual(session.navigations, [{ type: "session", sessionID: SECOND.sessionID }], "and opens its session")
  assert.equal(session.cleared.length > 0, true, "the overview closes behind it")

  // Settings: a click closes the overview and opens the settings dialog.
  const settings = fakeTuiContext({ selectAnswer: undefined })
  await renderedTui().setup(settings.context)
  await settings.layers[0].commands[0].run()
  renderDialog(settings.dialogs)
  clickPart(renderDialog(settings.dialogs), "e")
  await tick()
  assert.equal(settings.selections.length, 1, "a click on Settings opens the settings dialog")
  assert.equal(settings.cleared.length > 0, true, "the overview closes behind it")

  // The esc hint: a click closes the overview and takes its keys with it, as
  // the host's own Escape does.
  const hint = fakeTuiContext()
  await renderedTui().setup(hint.context)
  await hint.layers[0].commands[0].run()
  renderDialog(hint.dialogs)
  assert.equal(liveModalLayers(hint).length, 1, "the overview's keys hold while it is open")
  clickPart(renderDialog(hint.dialogs), "esc")
  await tick()
  assert.equal(hint.cleared.length > 0, true, "a click on the esc hint closes the overview")
  assert.equal(hint.dropped.length, 1, "and its own keys go with it")
  assert.equal(liveModalLayers(hint).length, 0, "so no modal layer answers afterwards")
})

test("a click in a gap between two controls runs nothing", async () => {
  const spawned = []
  const fake = fakeTuiContext({ selectAnswer: undefined })
  await renderedRecordedTui(spawned).setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)

  // Every part that is not a control — the spacers between the footer controls,
  // the dialog's name and its headings — carries no handler, so a press there
  // reaches no action.
  const footer = drawnLines(view).at(-2)
  const spacers = lineChildren(footer).filter((child) => child.props.content === "   ")
  assert.equal(spacers.length, 5, "a spacer sits between each pair of controls")
  for (const spacer of spacers) assert.equal("onMouseUp" in spacer.props, false, "a gap cell carries no handler")
  assert.equal("onMouseUp" in childWith(drawnLines(view)[0], PAGE_TITLE).props, false, "the dialog's name is not a control")
  assert.equal("onMouseUp" in childWith(drawnLines(view)[5], "Needs me").props, false, "a heading is not a control")

  // Nothing happened: no link opened, no session opened, no poll, no dialog.
  assert.deepEqual(spawned, [], "no link was opened")
  assert.deepEqual(fake.navigations, [], "no session was opened")
  assert.deepEqual(fake.doneInputs, [], "no close was requested")
  assert.equal(fake.calls.includes("pollNow"), false, "no poll ran")
  assert.deepEqual(fake.selections, [], "no dialog opened")
})

test("a click with no row acts like its shortcut: nothing to open, one notice", async () => {
  const spawned = []
  const fake = fakeTuiContext({ items: [], selectAnswer: undefined })
  await renderedRecordedTui(spawned).setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)

  clickPart(view, "i")
  assert.deepEqual(spawned, [], "no link is opened with no row to act on")
  assert.match(fake.toasts.at(-1).message, /not a web address/, "the missing link is reported, as the key reports it")

  clickPart(view, "↵")
  await tick()
  assert.deepEqual(fake.opened, [], "no session is opened with no row to act on")
  assert.deepEqual(fake.navigations, [], "and no route is navigated to")
  assert.equal(fake.cleared.length > 0, true, "the Session control closes the overview, exactly as its key does")
})

test("cancel restores the overview on the captured item, by identity, after its position moved", async () => {
  const older = { ...ITEM, flaggedAt: "2026-11-19T14:00:00.000Z" }
  const newer = {
    ...ITEM,
    sessionID: "ses_2",
    title: "Review of the Terraform module change",
    issueNumber: 40,
    issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/40",
    flaggedAt: "2026-11-19T14:30:00.000Z",
  }
  const fake = fakeTuiContext({ items: [older, newer], confirmAnswer: undefined })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)

  // The older item sits second; the user selects it.
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()
  assert.equal(markedItem(renderDialog(fake.dialogs)), ITEM.title)

  // A refresh reorders the rows while the confirm is open, and the marker
  // follows the identity rather than the position.
  const opened = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  assert.equal(fake.dialogs.length, opened, "the overview is closed while the confirm is up")
  await tick()
  assert.equal(fake.confirms.length, 1)
  fake.setItems([{ ...older, flaggedAt: "2026-11-19T14:45:00.000Z" }, newer])
  fake.eventHandlers.find(([name]) => name === "updated")[1]()
  await tick()

  assert.equal(fake.dialogs.length, opened + 1, "the overview is shown again after the cancel")
  const restored = renderDialog(fake.dialogs)
  assert.equal(markedItem(restored), ITEM.title, "the captured item is marked at its new position")
  assert.deepEqual(fake.doneInputs, [], "a cancel sends no request")
})

/**
 * Three waiting items, newest first, and a confirm that stays pending until the
 * test settles it: the middle item is the marked one and the one a refresh
 * removes while the confirm is up. The overview is closed behind the confirm,
 * so only a refresh can move the marker before the answer.
 */
function disappearanceDuringConfirm() {
  const first = { ...ITEM, sessionID: "ses_1", flaggedAt: "2026-11-19T14:30:00.000Z" }
  const removed = {
    ...ITEM,
    sessionID: "ses_2",
    title: "Review of the Terraform module change",
    issueNumber: 40,
    issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/40",
    flaggedAt: "2026-11-19T14:20:00.000Z",
  }
  const third = {
    ...ITEM,
    sessionID: "ses_3",
    title: "Budget question for Q1",
    issueNumber: 39,
    issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/39",
    flaggedAt: "2026-11-19T14:10:00.000Z",
  }
  const fake = fakeTuiContext({ items: [first, removed, third] })
  let settleConfirm
  const dialogs = fake.context.ui.dialog
  fake.context.ui.dialog = {
    ...dialogs,
    confirm: (options) => {
      fake.confirms.push(options)
      return new Promise((resolve) => {
        settleConfirm = resolve
      })
    },
  }
  return { fake, first, removed, third, settleConfirm: (answer) => settleConfirm(answer) }
}

test("a cancel after the marked item disappears during confirmation keeps the reconciled neighbor", async () => {
  const { fake, first, removed, third, settleConfirm } = disappearanceDuringConfirm()
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)

  // The user marks the second row: the item the refresh will remove.
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()
  assert.equal(markedItem(renderDialog(fake.dialogs)), removed.title)

  // The confirm is up and unanswered when a refresh removes that row; the
  // refresh hands the marker to its next surviving neighbor.
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.equal(fake.confirms.length, 1, "the click asks one confirm for the marked row")
  fake.setItems([first, third])
  fake.eventHandlers.find(([name]) => name === "updated")[1]()
  await tick()

  settleConfirm(undefined)
  await tick()
  const restored = renderDialog(fake.dialogs)
  assert.equal(rowLines(restored).length, 2, "the removed row is gone")
  assert.equal(markedItem(restored), third.title, "the next surviving neighbor keeps the marker")
  assert.deepEqual(fake.doneInputs, [], "a cancel sends no request")
})

test("a yes after the marked item disappears during confirmation requests the captured item and keeps the neighbor", async () => {
  const { fake, first, removed, third, settleConfirm } = disappearanceDuringConfirm()
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()

  clickDone(renderDialog(fake.dialogs))
  await tick()
  fake.setItems([first, third])
  fake.eventHandlers.find(([name]) => name === "updated")[1]()
  await tick()

  settleConfirm(true)
  await tick()
  assert.deepEqual(fake.doneInputs, [{ sessionID: removed.sessionID }], "one request, for the captured item")
  const restored = renderDialog(fake.dialogs)
  assert.equal(markedItem(restored), third.title, "the next surviving neighbor keeps the marker")
})

test("only a yes sends one Done request, for the captured item, and the row stays until its record leaves", async () => {
  const fake = fakeTuiContext({ confirmAnswer: true })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()

  const opened = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.deepEqual(fake.doneInputs, [{ sessionID: SECOND.sessionID }], "one request, for the captured item")
  assert.equal(fake.calls.filter((name) => name === "done").length, 1, "and only once")
  assert.equal(fake.dialogs.length, opened + 1, "the overview comes back without waiting for the deletion")

  const restored = renderDialog(fake.dialogs)
  assert.equal(rowLines(restored).length, 2, "the acknowledgment removes no row")
  assert.equal(markedItem(restored), SECOND.title, "and the captured item stays marked")

  // The record leaves only when the close completes; the marker hands over then.
  fake.setItems([ITEM])
  fake.eventHandlers.find(([name]) => name === "updated")[1]()
  await tick()
  const after = renderDialog(fake.dialogs)
  assert.equal(rowLines(after).length, 1, "the removed row is gone")
  assert.equal(markedItem(after), ITEM.title, "the surviving neighbor takes the marker")
})

test("a refusal keeps the item visible with the watcher's reason, and restores the overview", async () => {
  const fake = fakeTuiContext({ confirmAnswer: true })
  const base = fake.context.client.rpc
  fake.context.client.rpc = (definition) => ({
    ...base(definition),
    async done(input) {
      fake.eventHandlers.find(([name]) => name === "closeRefused")[1]({
        sessionID: input.sessionID,
        reason: "the session is running — try again when it is idle",
      })
      return {}
    },
  })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()

  const opened = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.equal(fake.toasts.at(-1).variant, "error", "a refusal is an error")
  assert.match(fake.toasts.at(-1).message, /try again when it is idle/, "the reason and its recovery advice are shown")
  assert.equal(fake.dialogs.length, opened + 1, "the overview is shown again after the refusal")
  const restored = renderDialog(fake.dialogs)
  assert.equal(markedItem(restored), SECOND.title, "the still-listed item stays marked")
  assert.equal(rowLines(restored).length, 2, "and its row stays visible")
})

test("a failed Done request shows the error and restores the overview, so the user can retry", async () => {
  const fake = fakeTuiContext({ confirmAnswer: true })
  const base = fake.context.client.rpc
  fake.context.client.rpc = (definition) => ({
    ...base(definition),
    async done() {
      throw new Error("RPC is unavailable: slack-director")
    },
  })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)

  const opened = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.equal(fake.toasts.at(-1).variant, "error")
  assert.match(fake.toasts.at(-1).message, /RPC is unavailable/, "the returned error is shown")
  assert.equal(fake.dialogs.length, opened + 1, "the overview is shown again after the failed request")
  const restored = renderDialog(fake.dialogs)
  assert.equal(markedItem(restored), ITEM.title, "the overview is back on the captured item")

  // Retry through the confirm: a second press asks a second confirm and sends the request.
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.equal(fake.confirms.length, 2, "the retry asks the confirm again")
})

test("the restored overview answers one keypress once", async () => {
  const fake = fakeTuiContext({ confirmAnswer: undefined })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()

  const opened = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.equal(fake.dialogs.length, opened + 1, "the overview is shown again after the cancel")
  const restored = renderDialog(fake.dialogs)
  assert.equal(markedItem(restored), SECOND.title, "the restore marks the captured item")
  assert.equal(liveModalLayers(fake).length, 1, "exactly one modal layer answers after the restore")
  assert.equal(fake.dropped.length, 1, "the overview's earlier keys were dropped once")

  liveModalLayers(fake)[0].commands.find((command) => command.bind === "down").run()
  assert.equal(markedItem(restored), ITEM.title, "one keypress moves the marker exactly once")
})

test("a completion after the user left the overview never reopens it", async () => {
  const fake = fakeTuiContext({ confirmAnswer: true })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)

  clickDone(renderDialog(fake.dialogs))
  await tick()
  const opened = fake.dialogs.length
  fake.dialogs.at(-1).onClose()
  fake.setItems([SECOND])
  fake.eventHandlers.find(([name]) => name === "updated")[1]()
  await tick()
  assert.equal(fake.dialogs.length, opened, "the later completion opens no dialog")
})

test("a delayed Done answer never reopens an overview the user has left", async () => {
  const fake = fakeTuiContext({ confirmAnswer: true })
  let settleDone
  const base = fake.context.client.rpc
  fake.context.client.rpc = (definition) => ({
    ...base(definition),
    done(input) {
      fake.calls.push("done")
      fake.doneInputs.push(input)
      return new Promise((resolve) => {
        settleDone = resolve
      })
    },
  })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)
  modalLayer(fake.layers).commands.find((command) => command.bind === "down").run()

  // The user confirms the close of the marked item; its answer is still pending.
  const before = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.deepEqual(fake.doneInputs, [{ sessionID: SECOND.sessionID }], "one request, for the captured item")
  assert.equal(fake.dialogs.length, before + 1, "the overview comes back before the answer settles")

  // While the answer is pending the user leaves that overview, opens a new one
  // and moves its marker.
  fake.dialogs.at(-1).onClose()
  await fake.layers[0].commands[0].run()
  const opened = fake.dialogs.length
  renderDialog(fake.dialogs)
  liveModalLayers(fake)[0].commands.find((command) => command.bind === "down").run()
  assert.equal(markedItem(renderDialog(fake.dialogs)), SECOND.title, "the user's own selection is the marked one")
  fake.dialogs.at(-1).onClose()

  // The stale answer settles: it must not reopen the overview, nor move the marker.
  settleDone({})
  await tick()
  assert.equal(fake.dialogs.length, opened, "the late answer opens no dialog")
  assert.equal(markedItem(renderDialog(fake.dialogs)), SECOND.title, "and leaves the user's own selection where it was")
})

test("with no rows the Done hint asks no confirm and sends no request", async () => {
  const fake = fakeTuiContext({ items: [], confirmAnswer: true })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  const view = renderDialog(fake.dialogs)

  assert.deepEqual(
    clickableTexts(view).slice(-2),
    ["d", " done"],
    "the Done hint is still drawn",
  )
  clickDone(view)
  await tick()
  assert.equal(fake.confirms.length, 0, "no item, no confirm")
  assert.deepEqual(fake.doneInputs, [], "no item, no request")
  assert.equal(fake.dialogs.length, 1, "and the overview stays open")
})

test("deleting the last item leaves the empty overview with nothing to act on", async () => {
  const fake = fakeTuiContext({ items: [ITEM], confirmAnswer: true })
  await renderedTui().setup(fake.context)
  await fake.layers[0].commands[0].run()
  renderDialog(fake.dialogs)

  const opened = fake.dialogs.length
  clickDone(renderDialog(fake.dialogs))
  await tick()
  assert.deepEqual(fake.doneInputs, [{ sessionID: ITEM.sessionID }])
  assert.equal(fake.dialogs.length, opened + 1, "the overview is shown again after the confirmation")

  fake.setItems([])
  fake.eventHandlers.find(([name]) => name === "updated")[1]()
  await tick()
  const empty = renderDialog(fake.dialogs)
  assert.equal(rowLines(empty).length, 0, "no row is drawn")
  assert.equal(markedItem(empty), undefined, "and no row is marked")

  clickDone(empty)
  await tick()
  assert.equal(fake.confirms.length, 1, "with nothing selected, the hint asks no further confirm")
  assert.deepEqual(fake.doneInputs, [{ sessionID: ITEM.sessionID }], "and sends no further request")
})

test("a rejected call becomes a toast rather than a crash", async () => {
  const { context, toasts, layers, dialogs } = fakeTuiContext({ rejection: new Error("RPC is unavailable: slack-director") })
  await tui.setup(context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /RPC is unavailable/)
  assert.equal(toasts[0].variant, "error")
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  assert.equal(toasts.length, 2, "opening the dialog reports the failure instead of throwing")
})

test("the settings dialog shows a field's value, prompts for it and saves it through the contract", async () => {
  const { context, layers, selections, prompts, toasts } = fakeTuiContext({
    selectAnswer: "session_agent",
    promptAnswer: "slack-director",
  })
  await tui.setup(context)
  await layers[0].commands[1].run()
  assert.equal(selections.length, 1, "one select list")
  assert.equal(selections[0].options[6].description, "slack-director", "the row shows the agent in use")
  assert.equal(prompts[0].title, "Slack Director: session_agent")
  assert.match(toasts.at(-1).message, /session_agent saved/)
})

test("a rejected value shows the error and changes nothing", async () => {
  const { context, layers, toasts } = fakeTuiContext({
    selectAnswer: "intake_repo",
    promptAnswer: "not a repo",
    setRejection: new Error("config field invalid: intake_repo"),
  })
  await tui.setup(context)
  await layers[0].commands[1].run()
  assert.equal(toasts.at(-1).variant, "error")
  assert.match(toasts.at(-1).message, /config field invalid: intake_repo/)
})

test("a settings dialog the user closes changes nothing", async () => {
  const { context, layers, selections, prompts, toasts } = fakeTuiContext({ selectAnswer: undefined })
  await tui.setup(context)
  await layers[0].commands[1].run()
  assert.equal(selections.length, 1)
  assert.equal(prompts.length, 0, "no prompt without a chosen field")
  assert.equal(toasts.length, 0)
})

test("the dialog draws the title, the two header lines, the counts, the sections, the rows, the today line, the legend and the footer in order", () => {
  const rows = pageRows([ITEM, SECOND], (item) => ({ running: item.sessionID === ITEM.sessionID, pending: 0 }))
  const view = viewOf(rows, { status: STATUS_WITH_POLLER })
  const lines = drawnLines(view)

  const title = lines[0]
  assert.equal(title.type, "box")
  assert.equal(title.props.justifyContent, "space-between", "the title and esc share one row")
  assert.equal(title.props.paddingLeft, DIALOG_INSET, "the title takes the side inset")
  assert.equal(title.props.paddingRight, DIALOG_INSET, "and leaves esc a right margin")
  assert.equal(lineChildren(title)[0].props.content, PAGE_TITLE)
  assert.equal(lineChildren(title)[1].props.content, "esc")
  assert.equal(lineText(lines[1]), slackLineText(STATUS_WITH_POLLER), "the Slack line names the scan and each workspace")
  assert.equal(lineText(lines[2]), pollerLineText(STATUS_WITH_POLLER.poller), "the poller line follows it")
  assert.equal(lineText(lines[3]), "", "a blank line separates the blocks")
  assert.equal(lineText(lines[4]), countsText(rows))
  assert.equal(lines[5].props.content, "", "the counts line is followed by a blank line")
  const needsMe = childWith(lines[6], "Needs me")
  assert.ok(needsMe, "the first section is Needs me")
  assert.equal(lines[6].props.paddingLeft, DIALOG_INSET, "a section header shares the title's left edge")
  assert.equal(lineText(lines[7]), rowText(rows[0], { selected: true, now: NOW, hours: HOURS }))
  assert.equal(
    lineText(lines[7]).indexOf(SESSION_MARK.running),
    DIALOG_INSET,
    "and the row's session mark aligns with it",
  )
  assert.equal(lineText(lines[8]), "", "exactly one blank line separates the two visible groups")
  assert.equal(childWith(lines[9], "Idle") !== undefined, true, "the idle section follows, with no empty section")
  assert.equal(lineText(lines[10]), rowText(rows[1], { selected: false, now: NOW, hours: HOURS }))
  assert.equal(lineText(lines[12]), todayText(STATUS_WITH_POLLER))
  assert.equal(lineText(lines[14]), legendText(), "the legend is the last line before the footer")
  assert.equal(lineText(lines[15]), footerText())
  assert.equal(lines.length, 17)
  assert.equal(lineText(lines[16]), "", "a blank margin line sits below the footer")
})

test("the header draws one line before a cycle has run and two after it", () => {
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  const before = drawnLines(viewOf(rows))
  const after = drawnLines(viewOf(rows, { status: STATUS_WITH_POLLER }))
  assert.equal(lineText(before[1]), slackLineText(STATUS), "the Slack line is always drawn")
  assert.equal(before[2].props.content, "", "with no poller cycle, the blank line follows it")
  assert.deepEqual(
    after.slice(1, 3).map(lineText),
    headerLines(STATUS_WITH_POLLER).map(partsText),
    "a cycle adds the poller line under the Slack line",
  )
})

test("the dialog draws the header and the legend once per render, whatever the rows", () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    item: { ...ITEM, sessionID: `ses_${index}`, issueNumber: 100 + index },
    state: "needs-me",
    session: {},
  }))
  const lines = drawnLines(viewOf(many, { status: STATUS_WITH_POLLER })).map(lineText)
  assert.equal(lines.filter((text) => text === slackLineText(STATUS_WITH_POLLER)).length, 1, "one Slack line")
  assert.equal(lines.filter((text) => text === pollerLineText(STATUS_WITH_POLLER.poller)).length, 1, "one poller line")
  assert.equal(lines.filter((text) => text === legendText()).length, 1, "one legend line")
  assert.equal(lines.filter((text) => text.startsWith("Slack Director")).length, 1, "one title row")
  assert.equal(lines.length, 13 + many.length, "the blocks are drawn once and one line is drawn per row")
})

test("opening and refreshing the dialog read the items, the status and the config, and nothing per row", async () => {
  const fake = fakeTuiContext({ items: [ITEM, SECOND] })
  await renderedTui().setup(fake.context)
  await tick()

  fake.calls.length = 0
  await fake.layers[0].commands[0].run()
  assert.deepEqual(fake.calls, ["items", "status", "getConfig"], "three reads to open it, and no per-row call")

  const updated = fake.eventHandlers.find(([name]) => name === "updated")[1]
  fake.calls.length = 0
  updated({})
  await tick()
  assert.deepEqual(fake.calls, ["items", "status", "getConfig"], "a refresh makes the same three reads")
})

test("exactly one blank line separates two visible groups, and none sits under a heading", () => {
  const rowOf = (state, sessionID, session = {}) => ({ item: { ...ITEM, sessionID, requestState: state }, state, session })
  const texts = (view) => drawnLines(view).map((line) => lineText(line))

  // Three groups shown: one blank line between each pair, and each heading's
  // next line is its first row, never a blank.
  const needsMe = rowOf("needs-me", "ses_1")
  const blocked = rowOf("blocked", "ses_2")
  const idle = rowOf("idle", "ses_3")
  const three = viewOf([needsMe, blocked, idle])
  const threeTexts = texts(three)
  assert.deepEqual(threeTexts, [
    partsText(titleParts()),
    slackLineText(STATUS),
    "",
    countsText([needsMe, blocked, idle]),
    "",
    "Needs me",
    rowText(needsMe, { selected: true, now: NOW, hours: HOURS }),
    "",
    "Blocked",
    rowText(blocked, { selected: false, now: NOW, hours: HOURS }),
    "",
    "Idle",
    rowText(idle, { selected: false, now: NOW, hours: HOURS }),
    "",
    todayText(STATUS),
    "",
    legendText(),
    footerText(),
    "",
  ])

  // One group: its heading is followed by its first row and nothing separates a
  // group from itself, so the layout carries no extra blank.
  const single = viewOf([idle])
  assert.deepEqual(texts(single).slice(4, 9), ["", "Idle", rowText(idle, { selected: true, now: NOW, hours: HOURS }), "", todayText(STATUS)])

  // Two groups that are not adjacent — needs-me and idle, with blocked absent —
  // still take exactly one blank line between them.
  const apart = viewOf([needsMe, idle])
  const apartTexts = texts(apart)
  assert.deepEqual(apartTexts.slice(4, 9), [
    "",
    "Needs me",
    rowText(needsMe, { selected: true, now: NOW, hours: HOURS }),
    "",
    "Idle",
  ])

  // No group at all: no separator is drawn for a group that is not shown.
  const none = viewOf([])
  assert.deepEqual(texts(none).slice(3, 9), [countsText([]), "", "", todayText(STATUS), "", legendText()])
})

test("a failing workspace's mark takes the theme's primary colour, and the rest of the Slack line is muted", () => {
  const view = viewOf(pageRows([ITEM], () => ({ running: false, pending: 0 })))
  const header = drawnLines(view)[1]
  assert.equal(childWith(header, "✗").props.fg, THEME.text.action.primary.base, "a failing workspace stands out")
  assert.equal(childWith(header, "✓").props.fg, THEME.text.muted, "a healthy workspace is dimmed")
  assert.equal(childWith(header, "Slack  ").props.fg, THEME.text.muted, "the label is muted")
  assert.equal(childWith(header, "14:32").props.fg, THEME.text.muted, "and so is the scan time")
})

test("the poller line's failing part takes the theme's primary colour, and a healthy one is muted", () => {
  const rows = pageRows([ITEM], () => ({}))
  const failed = drawnLines(viewOf(rows, { status: STATUS_FAILED }))[2]
  assert.equal(lineChildren(failed)[1].props.fg, THEME.text.action.primary.base, "a failed read stands out")
  assert.ok(lineText(failed).includes("3 failed: #7 #8 #9"), "and the line names every failed issue")

  const healthy = drawnLines(viewOf(rows, { status: STATUS_WITH_POLLER }))[2]
  assert.equal(lineChildren(healthy)[1].props.fg, THEME.text.muted, "a healthy cell is muted")
  assert.ok(!lineText(healthy).includes("failed:"), "and names no failure")
})

test("only the session mark takes a state colour: the title is base text and the rest of the row is muted", () => {
  const rows = [
    { item: { ...ITEM, requestState: "needs-me" }, state: "needs-me", session: { pending: 1 } },
    { item: { ...SECOND, requestState: "blocked" }, state: "blocked", session: { running: true } },
    { item: { ...SECOND, sessionID: "ses_3", requestState: "idle" }, state: "idle", session: {} },
  ]
  const view = viewOf(rows)
  const [pending, running, idle] = rowLines(view)

  // The mark takes exactly step 200 of the theme's hue scale.
  assert.equal(childWith(pending, SESSION_MARK.pending).props.fg, THEME.hue.orange[200])
  assert.equal(childWith(running, SESSION_MARK.running).props.fg, THEME.hue.blue[200])
  assert.equal(childWith(idle, NO_SESSION_MARK), undefined, "a quiet row carries no mark at all")

  // The text cell is base text, and it is not the state colour.
  const pendingText = lineChildren(pending)[11]
  assert.equal(pendingText.props.fg, THEME.text.base, "the text is base text on a row that needs the user")
  assert.notEqual(pendingText.props.fg, THEME.hue.orange[200], "the whole row is not the state colour")
  assert.equal(lineChildren(running)[11].props.fg, THEME.text.base, "the text is base text on a blocked row")
  assert.equal(lineChildren(idle)[11].props.fg, THEME.text.muted, "an idle row is muted throughout")

  // The issue, the requester and the type are muted on every row.
  for (const line of [pending, running, idle]) {
    for (const index of [5, 7, 9]) assert.equal(lineChildren(line)[index].props.fg, THEME.text.muted)
  }
})

test("the new-activity mark takes the theme's yellow hue, else the warning colour", () => {
  const row = { item: { ...ITEM, requestState: "blocked" }, state: "blocked", session: {}, note: NEW_ACTIVITY_MARK }
  const withYellow = rowLines(viewOf([row]))[0]
  assert.equal(
    childWith(withYellow, NEW_ACTIVITY_MARK).props.fg,
    THEME.hue.yellow[200],
    "the star takes the yellow hue when the theme has one",
  )
  const noYellow = rowLines(viewOf([row], { theme: THEME_NO_HUES }))[0]
  assert.equal(
    childWith(noYellow, NEW_ACTIVITY_MARK).props.fg,
    THEME.text.feedback.warning.base,
    "and the warning colour when it does not",
  )
  assert.equal(roleColour(THEME, "new-activity"), THEME.hue.yellow[200])
  assert.equal(roleColour(THEME_NO_HUES, "new-activity"), THEME.text.feedback.warning.base)
})

test("a theme without an orange or a blue hue falls back to the warning and info colours", () => {
  const rows = [
    { item: { ...ITEM, requestState: "needs-me" }, state: "needs-me", session: { pending: 1 } },
    { item: { ...SECOND, requestState: "blocked" }, state: "blocked", session: { running: true } },
  ]
  const view = viewOf(rows, { theme: THEME_NO_HUES })
  const [pending, running] = rowLines(view)
  assert.equal(
    childWith(pending, SESSION_MARK.pending).props.fg,
    THEME.text.feedback.warning.base,
    "the permission mark falls back to warning",
  )
  assert.equal(
    childWith(running, SESSION_MARK.running).props.fg,
    THEME.text.feedback.info.base,
    "the running mark falls back to info",
  )
  assert.equal(roleColour(THEME_NO_HUES, "state-waiting"), THEME.text.feedback.warning.base)
  assert.equal(roleColour(THEME, "state-waiting"), THEME.hue.orange[200])
})

test("the selected row takes the focused background and the bar, and no other row does", () => {
  const rows = [
    { item: { ...ITEM, requestState: "needs-me" }, state: "needs-me", session: {} },
    { item: { ...SECOND, requestState: "blocked" }, state: "blocked", session: {} },
  ]
  const view = viewOf(rows)
  const [first, second] = rowLines(view)
  assert.equal(first.props.backgroundColor, selectedBackground(THEME), "the selected row is filled")
  assert.equal(childWith(first, "┃").props.fg, THEME.text.formfield.focused, "the bar takes the focused form-field colour")
  assert.equal(second.props.backgroundColor, undefined, "an unselected row sets no background")
  assert.equal(childWith(second, "┃"), undefined, "only the selected row draws the bar")
})

test("the counts line counts by request state, its numbers in base text and its labels muted", () => {
  const rows = [
    { item: { ...ITEM, requestState: "needs-me" }, state: "needs-me", session: {} },
    { item: { ...ITEM, sessionID: "ses_4", requestState: "needs-me" }, state: "needs-me", session: {} },
    { item: { ...SECOND, requestState: "blocked" }, state: "blocked", session: {} },
  ]
  const view = viewOf(rows)
  const counts = drawnLines(view)[3]
  assert.equal(childWith(counts, "2 ").props.fg, THEME.text.base, "a count is base text")
  assert.equal(childWith(counts, "2 ").props.attributes, BOLD, "and bold")
  assert.equal(childWith(counts, "needs me").props.fg, THEME.text.muted)
  assert.equal(childWith(counts, "1 ").props.fg, THEME.text.base)
  assert.equal(childWith(counts, "blocked").props.fg, THEME.text.muted)
  assert.equal(childWith(counts, "waiting on requester").props.fg, THEME.text.muted)
})

test("the title, the section header and the footer's keys are bold, and the accent colours the titles", () => {
  const view = viewOf(pageRows([ITEM], () => ({ running: false, pending: 0 })))
  const lines = drawnLines(view)
  assert.equal(childWith(lines[0], PAGE_TITLE).props.attributes, BOLD, "the title is bold")
  assert.equal(childWith(lines[0], PAGE_TITLE).props.fg, THEME.text.action.primary.base, "the title takes the accent")
  assert.equal(childWith(lines[0], "esc").props.fg, THEME.text.muted, "esc is muted")
  const section = childWith(lines[5], "Needs me")
  assert.equal(section.props.attributes, BOLD, "the section header is bold")
  assert.equal(section.props.fg, THEME.text.action.primary.base, "and takes the accent")
  const footer = lines.at(-2)
  assert.equal(childWith(footer, "↵").props.attributes, BOLD, "a footer key is bold")
  assert.equal(childWith(footer, "↵").props.fg, THEME.text.base)
  assert.equal(childWith(footer, " session").props.fg, THEME.text.muted, "and its label is muted")
})

test("a theme with no primary action colour falls back to the colours each part took before", () => {
  const rows = pageRows([ITEM], () => ({}))
  const view = viewOf(rows, { theme: THEME_NO_PRIMARY, status: STATUS_FAILED })
  const lines = drawnLines(view)
  assert.equal(childWith(lines[0], PAGE_TITLE).props.fg, THEME.text.base, "the title falls back to base text")
  assert.equal(childWith(lines[6], "Needs me").props.fg, THEME.text.muted, "the section to muted text")
  assert.equal(
    childWith(lines[1], "✗").props.fg,
    THEME.text.feedback.warning.base,
    "a failing workspace to the warning colour",
  )
  assert.equal(
    lineChildren(lines[2])[1].props.fg,
    THEME.text.feedback.warning.base,
    "and the poller's failing part to the warning colour",
  )
  assert.equal(roleColour(THEME_NO_PRIMARY, "title"), THEME.text.base)
  assert.equal(roleColour(THEME_NO_PRIMARY, "section"), THEME.text.muted)
  assert.equal(roleColour(THEME_NO_PRIMARY, "workspace-fail"), THEME.text.feedback.warning.base)
})

test("AGE's colour is the theme's own: base, then warning from 4 working hours, then error from one day", () => {
  const flagged = (text) => ({ ...ITEM, flaggedAt: text })
  const rowOf = (item) => ({ item, state: "needs-me", session: {} })
  const warn = viewOf([rowOf(flagged("2026-11-19T10:00:00Z"))], { now: () => Date.parse("2026-11-19T14:00:00Z") })
  const error = viewOf([rowOf(flagged("2026-11-19T09:00:00Z"))], { now: () => Date.parse("2026-11-19T18:00:00Z") })
  const calm = viewOf([rowOf(flagged("2026-11-19T14:30:00Z"))])
  assert.equal(lineChildren(rowLines(calm)[0])[13].props.fg, THEME.text.base, "under four working hours is base text")
  assert.equal(lineChildren(rowLines(warn)[0])[13].props.fg, THEME.text.feedback.warning.base, "exactly four working hours warns")
  assert.equal(lineChildren(rowLines(error)[0])[13].props.fg, THEME.text.feedback.error.base, "one working day errors")
})

test("the sidebar line carries the needs-me and blocked counts", async () => {
  const { context, slots } = fakeTuiContext()
  await tui.setup(context)
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  assert.equal(sidebarText(rows), "Slack Director  1 needs me · 0 blocked")
  assert.equal(countsText(rows), "1 needs me   0 blocked   0 waiting on requester   0 idle")
  assert.equal(typeof slots[0].render, "function")
})

test("the sidebar slot renders its line, so the host never hits a missing helper", async () => {
  const { context, slots } = fakeTuiContext()
  await createTui({ renderer: stubRenderer() }).setup(context)
  await new Promise((resolve) => setImmediate(resolve))
  const element = slots[0].render()
  assert.equal(element.type, "text")
  assert.equal(element.props.content, sidebarText(pageRows([ITEM, SECOND], () => ({ running: false, pending: 0 }))))
})

test("the dialog shows no Slack message text and no permalink", () => {
  const view = viewOf(pageRows([ITEM], () => ({ running: false, pending: 0 })))
  for (const line of drawnLines(view)) {
    const text = lineText(line)
    assert.ok(!text.includes("slack.com"), `no permalink in the dialog: ${text}`)
    assert.ok(!text.includes("archives"), `no Slack path in the dialog: ${text}`)
  }
})
