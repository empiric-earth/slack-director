// The RPC contract and the TUI part that calls it.
//
// The contract's schemas are checked against every answer the contract
// describes, with a validator written here so the suite needs no dependency,
// and the TUI part is driven with a fake context that records the keymap layer
// it registers and the toast it shows. No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { SlackDirectorRpc } from "../rpc.js"
import { schemaProblem } from "./schema.js"
import tui, { COMMAND_ID, formatStatus } from "../tui.js"

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

function fakeTuiContext({ status = STATUS, rejection } = {}) {
  const layers = []
  const toasts = []
  const rpcCalls = []
  const context = {
    keymap: {
      layer(factory) {
        layers.push(factory())
      },
    },
    ui: { toast: { show: (options) => toasts.push(options) } },
    client: {
      rpc(definition) {
        rpcCalls.push(definition.id)
        return {
          async status(input) {
            rpcCalls.push(input)
            if (rejection) throw rejection
            return status
          },
        }
      },
    },
  }
  return { context, layers, toasts, rpcCalls }
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

test("the TUI part registers the /slack-director slash command and its palette entry", async () => {
  const { context, layers } = fakeTuiContext()
  await tui.setup(context)
  assert.equal(tui.id, "slack-director.tui")
  assert.equal(layers.length, 1, "one keymap layer")
  assert.equal(layers[0].mode, "global")
  const commands = layers[0].commands
  assert.equal(commands.length, 1)
  const [command] = commands
  assert.equal(command.id, COMMAND_ID)
  assert.deepEqual(command.slash, { name: "slack-director" }, "the slash command is /slack-director")
  assert.equal(command.palette, true, "the command is in the palette")
})

test("the command calls status and shows the answer, today's counts included, as a toast", async () => {
  const { context, layers, toasts, rpcCalls } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  assert.deepEqual(rpcCalls, ["slack-director", {}], "the command calls status through the contract")
  assert.equal(toasts.length, 1, "one toast")
  assert.match(toasts[0].message, /last poll \d\d:\d\d/, "the toast names the last poll")
  assert.ok(toasts[0].message.includes("ok"), "the toast names the outcome")
  assert.ok(toasts[0].message.includes("slack_nexar ✓"), "the toast names each workspace")
  assert.ok(toasts[0].message.includes("sign-in expired — run /mcps"), "the toast names a failing workspace")
  assert.ok(toasts[0].message.includes("Today: 2 flagged · 1 next steps posted · 1 skipped"), "the toast names today's counts")
})

test("a rejected status call becomes a toast rather than a crash", async () => {
  const { context, layers, toasts } = fakeTuiContext({ rejection: new Error("RPC is unavailable: slack-director") })
  await tui.setup(context)
  await layers[0].commands[0].run()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /RPC is unavailable/)
})

test("the toast line reports a poll that never ran", () => {
  const line = formatStatus({ lastPoll: null, outcome: "never polled", workspaces: [], configError: null, today: {} })
  assert.equal(line, "Slack Director: last poll never · never polled · Today: 0 flagged · 0 next steps posted · 0 skipped")
})

test("the toast shows the last poll on the local clock, not on the UTC clock", () => {
  const lastPoll = "2026-11-20T14:32:00.000Z"
  const previous = process.env.TZ
  const shown = (zone) => {
    process.env.TZ = zone
    return formatStatus({ ...STATUS, lastPoll })
  }
  try {
    assert.match(shown("America/Los_Angeles"), /^Slack Director: last poll 06:32 · /, "eight hours behind UTC")
    assert.match(shown("Asia/Tokyo"), /^Slack Director: last poll 23:32 · /, "nine hours ahead of UTC")
    assert.match(shown("UTC"), /^Slack Director: last poll 14:32 · /, "UTC")
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test("a last poll that is not a time reads as never", () => {
  assert.equal(formatStatus({ lastPoll: "not a time", outcome: "ok", workspaces: [] }).startsWith("Slack Director: last poll never"), true)
})
