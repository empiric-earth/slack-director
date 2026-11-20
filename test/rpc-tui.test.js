// The RPC contract and the TUI part that calls it.
//
// The TUI part is driven with a fake context that records the keymap layer it
// registers and the toast it shows. No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { SlackDirectorRpc } from "../rpc.js"
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

test("the RPC contract defines status with an input and an output schema", () => {
  assert.equal(SlackDirectorRpc.id, "slack-director")
  assert.deepEqual(Object.keys(SlackDirectorRpc.methods), ["status"])
  assert.deepEqual(SlackDirectorRpc.events, {})
  const method = SlackDirectorRpc.methods.status
  assert.equal(method.input.type, "object")
  assert.equal(method.output.type, "object")
  assert.deepEqual(method.output.required, ["lastPoll", "outcome", "workspaces", "configError", "today"])
  assert.deepEqual(method.output.properties.workspaces.items.required, ["name", "ok", "error"])
  assert.deepEqual(method.output.properties.today.required, ["flagged", "nextStepsPosted", "skipped"])
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

test("the command calls status and shows the answer as a toast", async () => {
  const { context, layers, toasts, rpcCalls } = fakeTuiContext()
  await tui.setup(context)
  await layers[0].commands[0].run()
  assert.deepEqual(rpcCalls, ["slack-director", {}], "the command calls status through the contract")
  assert.equal(toasts.length, 1, "one toast")
  assert.match(toasts[0].message, /last poll \d\d:\d\d/, "the toast names the last poll")
  assert.ok(toasts[0].message.includes("ok"), "the toast names the outcome")
  assert.ok(toasts[0].message.includes("slack_nexar ✓"), "the toast names each workspace")
  assert.ok(toasts[0].message.includes("sign-in expired — run /mcps"), "the toast names a failing workspace")
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
  assert.equal(line, "Slack Director: last poll never · never polled")
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
