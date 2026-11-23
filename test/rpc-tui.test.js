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
  KEY_HELP,
  PAGE_TITLE,
  countsText,
  headerText,
  moveSelection,
  pageRows,
  rowText,
  sidebarText,
  tableHeaderText,
} from "../src/page.js"
import tui, { COMMAND_ID, SETTINGS_COMMAND_ID, createTui, dialogView } from "../tui.js"

const NOW = Date.parse("2026-11-19T14:32:00.000Z")

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
  intake_repo: "empiric-earth/almeida-slack-intake",
  session_directory: "/home/someone/notes",
  poll_seconds: 60,
  work_hours: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "18:00", time_zone: "UTC" },
  session_agent: "slack-director",
}

const THEME = { text: { base: "base", muted: "muted", feedback: { warning: { base: "warning" } } } }

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
  firstTurnEndedAt: "2026-11-19T14:31:00.000Z",
  firstTurnFailed: false,
  permissionPending: false,
  openedAt: null,
}

/** A second item, opened and quiet, so the dialog holds two rows. */
const SECOND = {
  ...ITEM,
  permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137220",
  sessionID: "ses_2",
  title: "Review of the Terraform module change",
  issueNumber: 40,
  issueUrl: "https://github.com/empiric-earth/almeida-slack-intake/issues/40",
  flaggedAt: "2026-11-19T13:32:00.000Z",
  openedAt: "2026-11-19T14:00:00.000Z",
}

function fakeTuiContext({
  status = STATUS,
  items = [ITEM, SECOND],
  config = CONFIG,
  rejection,
  setRejection,
  selectAnswer,
  promptAnswer,
} = {}) {
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
      },
    },
    client: {
      rpc(definition) {
        rpcIds.push(definition.id)
        return {
          async status() {
            calls.push("status")
            if (rejection) throw rejection
            return status
          },
          async items() {
            calls.push("items")
            if (rejection) throw rejection
            return { items }
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
    dialogs,
    dialogSettings,
    cleared,
  }
}

/** The TUI part with the URL opener recorded rather than run. */
function recordedTui(spawned) {
  return createTui({
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

/** The text of one element: a memo's own value, or the plain content. */
const contentOf = (element) =>
  element === undefined || element === null
    ? undefined
    : typeof element.props?.content === "function"
      ? element.props.content()
      : element.props?.content

/** The lines the dialog draws, in order. */
const drawnLines = (view) =>
  view.props.children().map((child) => (child.type === "box" ? undefined : contentOf(child)))

/** The modal keymap layer the dialog registered. */
const modalLayer = (layers) => layers.find((layer) => layer.mode === "modal")

/**
 * The host renders a shown dialog once, and the dialog registers its own key
 * layer from that render; the layer lives and dies with the dialog.
 */
const renderDialog = (dialogs) => dialogs.at(-1).render()

test("the RPC contract defines every method and the updated event with an input and an output schema", () => {
  assert.equal(SlackDirectorRpc.id, "slack-director")
  assert.deepEqual(Object.keys(SlackDirectorRpc.methods).sort(), [
    "getConfig",
    "items",
    "markOpened",
    "pollNow",
    "setConfig",
    "status",
  ])
  assert.deepEqual(Object.keys(SlackDirectorRpc.events), ["updated"])
  for (const [name, method] of Object.entries(SlackDirectorRpc.methods)) {
    assert.equal(method.input.type, "object", `${name} takes an object`)
    assert.equal(method.output.type, "object", `${name} answers an object`)
  }
  const status = SlackDirectorRpc.methods.status
  assert.deepEqual(status.output.required, ["lastPoll", "outcome", "workspaces", "configError", "today"])
  assert.deepEqual(status.output.properties.workspaces.items.required, ["name", "ok", "error"])
  assert.deepEqual(status.output.properties.today.required, ["flagged", "nextStepsPosted", "skipped"])
})

test("the contract's config schema carries the session agent and not the retired fields", () => {
  const config = SlackDirectorRpc.methods.getConfig.output.properties.config
  assert.ok(config.properties.session_agent, "the config schema carries session_agent")
  assert.equal(config.properties.triage_agent, undefined, "the retired triage field is gone from the schema")
  assert.equal(config.properties.flag_emoji, undefined, "the retired flag field is gone from the schema")
  assert.ok(config.required.includes("session_agent"), "session_agent is required")
  assert.ok(!config.required.includes("triage_agent"))
  assert.ok(!config.required.includes("flag_emoji"), "the retired flag field is not required")
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
    "firstTurnEndedAt",
    "firstTurnFailed",
    "permissionPending",
    "openedAt",
  ])
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
  assert.deepEqual(calls.slice(-2), ["items", "status"], "the command reads the item map and the status")

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
  const renderer = stubRenderer()
  const rows = pageRows([ITEM, SECOND], () => ({ running: false, pending: 0 }))
  const [selected, setSelected] = renderer.createSignal(0)
  const view = dialogView({
    renderer,
    rows: () => rows,
    status: () => STATUS,
    selected,
    now: () => NOW,
    theme: THEME,
  })
  const marker = (index) => drawnLines(view)[4 + index][0]

  assert.equal(marker(0), "▸", "the first row is marked when the dialog opens")
  assert.equal(marker(1), " ")

  setSelected(moveSelection(selected(), rows.length, 1))
  assert.equal(marker(0), " ", "down moves the marker off the first row")
  assert.equal(marker(1), "▸", "the marker follows the selection while the dialog stays open")

  setSelected(moveSelection(selected(), rows.length, 1))
  assert.equal(marker(0), "▸", "down from the last row goes to the first")

  setSelected(moveSelection(selected(), rows.length, -1))
  assert.equal(marker(1), "▸", "up from the first row goes to the last")
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

test("the dialog's help line is the layout's own, and its keys are the ones it names", async () => {
  const { context, layers, dialogs } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  renderDialog(dialogs)
  const modal = modalLayer(layers)
  const keys = modal.commands.map((command) => command.bind)
  for (const key of ["up", "down", "return", "i", "s", "r", "e"]) {
    assert.ok(keys.includes(key), `the dialog answers ${key}`)
  }
  assert.equal(
    KEY_HELP,
    "↑↓ move · [enter] open session · [i]ssue · [s]lack · [r]efresh · s[e]ttings · [esc] close",
  )
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
    ["intake_repo", "session_directory", "poll_seconds", "work_hours", "session_agent"],
    "every config field is a row",
  )
  assert.equal(selections[0].options[2].description, "60", "the row shows the field's current value")
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
  assert.deepEqual(eventHandlers.map(([name]) => name), ["updated"])
  const before = calls.length
  eventHandlers[0][1]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, before + 2, "the dialog reads the item map and the status again")
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
  assert.equal(selections[0].options[4].description, "slack-director", "the row shows the agent in use")
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

test("the dialog draws the header, the counts line, the table, the rows, the today line and the help line", () => {
  const renderer = stubRenderer()
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  const view = dialogView({
    renderer,
    rows: () => rows,
    status: () => STATUS,
    selected: () => 0,
    now: () => NOW,
    theme: THEME,
  })
  const lines = drawnLines(view)
  const head = view.props.children()[0]
  assert.equal(head.type, "box")
  assert.equal(head.props.justifyContent, "space-between", "the title and the poll line share one row")
  assert.equal(head.props.children[0].props.content, "Slack Director")
  assert.equal(
    head.props.children[1].props.children.map((child) => child.props.content).join(""),
    headerText(STATUS),
    "the header names the last poll, the outcome and each workspace",
  )
  assert.match(lines[1], /^1 flagged · 0 working · 1 waiting for you · 0 idle$/)
  assert.equal(lines[3], tableHeaderText())
  assert.equal(lines[4], rowText(rows[0].item, "waiting", { selected: true, now: NOW }))
  assert.match(lines.at(-3), /^Today: flagged 2 · next steps posted 1 · 1 hit skipped$/)
  assert.equal(lines.at(-1), KEY_HELP)
})

test("a failing workspace's mark takes the attention colour and the rest is dimmed", () => {
  const renderer = stubRenderer()
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  const view = dialogView({
    renderer,
    rows: () => rows,
    status: () => STATUS,
    selected: () => 0,
    now: () => NOW,
    theme: THEME,
  })
  const head = view.props.children()[0]
  const parts = head.props.children[1].props.children
  const failing = parts.find((part) => part.props.content === "✗")
  const healthy = parts.find((part) => part.props.content === "✓")
  assert.equal(failing.props.fg, THEME.text.feedback.warning.base, "a failing workspace stands out")
  assert.equal(healthy.props.fg, THEME.text.muted, "a healthy workspace is dimmed")
  const lines = view.props.children()
  assert.equal(lines[4].props.fg, THEME.text.feedback.warning.base, "the waiting row stands out")
})

test("the sidebar line carries the counts", async () => {
  const { context, slots } = fakeTuiContext()
  await tui.setup(context)
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  assert.equal(sidebarText(rows), "Slack Director  1 waiting · 0 working")
  assert.equal(countsText(rows), "1 flagged · 0 working · 1 waiting for you · 0 idle")
  assert.equal(typeof slots[0].render, "function")
})

test("the dialog shows no Slack message text and no permalink", () => {
  const renderer = stubRenderer()
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  const view = dialogView({
    renderer,
    rows: () => rows,
    status: () => STATUS,
    selected: () => 0,
    now: () => NOW,
    theme: THEME,
  })
  for (const line of drawnLines(view)) {
    if (line === undefined) continue
    assert.ok(!line.includes("slack.com"), `no permalink in the dialog: ${line}`)
    assert.ok(!line.includes("archives"), `no Slack path in the dialog: ${line}`)
  }
})
