// The RPC contract and the TUI part that calls it.
//
// The contract's schemas are checked against every answer the contract
// describes, with a validator written here so the suite needs no dependency,
// and the TUI part is driven with a fake context that records the keymap layers
// it registers, the route and the sidebar claim, the dialogs it opens and the
// toasts it shows. The page's own element tree is drawn with a stub renderer:
// the real renderer modules exist only inside a running TUI.
// No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { SlackDirectorRpc } from "../rpc.js"
import { schemaProblem } from "./schema.js"
import { KEY_HELP, countsText, headerText, pageRows, rowText, sidebarText, tableHeaderText } from "../src/page.js"
import tui, { COMMAND_ID, PAGE_NAME, SETTINGS_COMMAND_ID, pageView } from "../tui.js"

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
  flag_emoji: "magic_wand",
  intake_repo: "empiric-earth/almeida-slack-intake",
  session_directory: "/home/someone/notes",
  poll_seconds: 60,
  work_hours: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "18:00", time_zone: "UTC" },
  triage_agent: "slack-director-triage",
}

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

function fakeTuiContext({
  status = STATUS,
  items = [ITEM],
  config = CONFIG,
  rejection,
  setRejection,
  selectAnswer,
  promptAnswer,
} = {}) {
  const layers = []
  const toasts = []
  const routes = []
  const slots = []
  const navigations = []
  const rpcIds = []
  const calls = []
  const eventHandlers = []
  const opened = []
  const selections = []
  const prompts = []
  const context = {
    keymap: { layer: (factory) => layers.push(factory()) },
    ui: {
      toast: { show: (options) => toasts.push(options) },
      router: {
        register: (page) => {
          routes.push(page)
          return () => {}
        },
        navigate: (destination) => navigations.push(destination),
      },
      slot: (claim) => {
        slots.push(claim)
        return () => {}
      },
      dialog: {
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
  return { context, layers, toasts, routes, slots, navigations, rpcIds, calls, eventHandlers, opened, selections, prompts }
}

/** The page's own element tree, with the host's factory replaced by a recorder. */
function stubRenderer() {
  return {
    createElement: (type) => ({ type, props: {} }),
    spread: (node, props) => {
      node.props = { ...node.props, ...props }
    },
  }
}

/** The lines the page draws, in order. */
function drawnLines(view) {
  return view.props.children.map((child) => (child.type === "box" ? undefined : child.props.content))
}

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

test("the TUI part registers the overview page, its two palette entries and the sidebar line", async () => {
  const { context, layers, routes, slots } = fakeTuiContext()
  await tui.setup(context)
  assert.equal(tui.id, "slack-director.tui")

  assert.equal(routes.length, 1, "one route")
  assert.equal(routes[0].name, PAGE_NAME, "the page's name is the route's")
  assert.equal(typeof routes[0].render, "function")

  assert.equal(layers.length, 1, "one keymap layer for the commands")
  assert.equal(layers[0].mode, "global")
  const [page, settings] = layers[0].commands
  assert.equal(page.id, COMMAND_ID)
  assert.equal(page.title, "Slack Director", "the palette entry is the page's title")
  assert.equal(page.palette, true)
  assert.deepEqual(page.slash, { name: "slack-director" }, "the slash command is /slack-director")
  assert.equal(settings.id, SETTINGS_COMMAND_ID)
  assert.equal(settings.title, "Slack Director: settings")
  assert.equal(settings.palette, true)

  assert.equal(slots.length, 1, "one slot claim")
  assert.equal(slots[0].append, "sidebar.content", "the sidebar line sits in the session sidebar")
  assert.equal(typeof slots[0].render, "function")
})

test("the page's keymap answers the layout's keys", async () => {
  const { context, layers, routes } = fakeTuiContext()
  await tui.setup(context)
  routes[0].render()
  const pageLayer = layers.at(-1)
  assert.deepEqual(
    pageLayer.commands.map((command) => [command.bind, command.id]),
    [
      ["return", `${COMMAND_ID}.open`],
      ["i", `${COMMAND_ID}.issue`],
      ["s", `${COMMAND_ID}.slack`],
      ["r", `${COMMAND_ID}.poll`],
      ["comma", `${COMMAND_ID}.settings`],
      ["escape", `${COMMAND_ID}.back`],
      ["up", `${COMMAND_ID}.up`],
      ["down", `${COMMAND_ID}.down`],
    ],
  )
  for (const command of pageLayer.commands) {
    assert.ok(
      !command.bind.includes(","),
      `${command.id} names its key rather than a comma, which a binding string reads as a separator`,
    )
  }
})

test("the Slack Director command refreshes the item map and opens the page", async () => {
  const { context, layers, navigations, rpcIds, calls, routes } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  assert.deepEqual([...new Set(rpcIds)], ["slack-director"], "every call goes through the one contract")
  assert.deepEqual(calls.slice(-2), ["items", "status"], "the command reads the item map and the status")
  assert.deepEqual(navigations, [{ type: "plugin", name: PAGE_NAME }], "the command opens the page")
  assert.equal(routes[0].name, PAGE_NAME)
})

test("the item map follows the contract's updated event", async () => {
  const { context, eventHandlers, calls } = fakeTuiContext()
  await tui.setup(context)
  assert.deepEqual(eventHandlers.map(([name]) => name), ["updated"])
  const before = calls.length
  eventHandlers[0][1]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, before + 2, "the page reads the item map and the status again")
})

test("a rejected call becomes a toast rather than a crash", async () => {
  const { context, toasts, layers } = fakeTuiContext({ rejection: new Error("RPC is unavailable: slack-director") })
  await tui.setup(context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /RPC is unavailable/)
  assert.equal(toasts[0].variant, "error")
  await layers[0].commands[0].run()
  assert.equal(toasts.length, 2, "opening the page reports the failure instead of throwing")
})

test("the settings dialog shows a field's value, prompts for it and saves it through the contract", async () => {
  const { context, layers, selections, prompts, toasts } = fakeTuiContext({
    selectAnswer: "poll_seconds",
    promptAnswer: "90",
  })
  await tui.setup(context)
  await layers[0].commands[1].run()
  assert.equal(selections.length, 1, "one select list")
  assert.deepEqual(
    selections[0].options.map((option) => option.title),
    ["flag_emoji", "intake_repo", "session_directory", "poll_seconds", "work_hours", "triage_agent"],
    "every config field is a row",
  )
  assert.equal(selections[0].options[3].description, "60", "the row shows the field's current value")
  assert.equal(prompts.length, 1, "one prompt for the chosen field")
  assert.equal(prompts[0].title, "Slack Director: poll_seconds")
  assert.equal(prompts[0].value, "60")
  assert.match(toasts.at(-1).message, /poll_seconds saved/)
  assert.equal(toasts.at(-1).variant, "success")
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

test("the page draws the header, the counts line, the table, the rows, the today line and the help line", () => {
  const renderer = stubRenderer()
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  const view = pageView({ renderer, rows, status: STATUS, selected: 0, now: NOW })
  const lines = drawnLines(view)
  const head = view.props.children[0]
  assert.equal(head.type, "box")
  assert.equal(head.props.justifyContent, "space-between", "the title and the poll line share one row")
  assert.equal(head.props.children[0].props.content, "Slack Director")
  assert.equal(head.props.children[1].props.content, headerText(STATUS))
  assert.match(lines[1], /^1 flagged · 0 working · 1 waiting for you · 0 idle$/)
  assert.equal(lines[3], tableHeaderText())
  assert.equal(lines[4], rowText(rows[0].item, "waiting", { selected: true, now: NOW }))
  assert.match(lines.at(-3), /^Today: flagged 2 · next steps posted 1 · 1 hit skipped$/)
  assert.equal(lines.at(-1), KEY_HELP)
})

test("the sidebar line carries the counts", async () => {
  const { context, slots } = fakeTuiContext()
  await tui.setup(context)
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  assert.equal(sidebarText(rows), "Slack Director  1 waiting · 0 working")
  assert.equal(countsText(rows), "1 flagged · 0 working · 1 waiting for you · 0 idle")
  assert.equal(typeof slots[0].render, "function")
})

test("the page shows no Slack message text and no permalink", () => {
  const renderer = stubRenderer()
  const rows = pageRows([ITEM], () => ({ running: false, pending: 0 }))
  const view = pageView({ renderer, rows, status: STATUS, selected: 0, now: NOW })
  for (const line of drawnLines(view)) {
    if (line === undefined) continue
    assert.ok(!line.includes("slack.com"), `no permalink on the page: ${line}`)
    assert.ok(!line.includes("archives"), `no Slack path on the page: ${line}`)
  }
})
