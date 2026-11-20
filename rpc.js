// The RPC contract between the server part and the TUI part.
//
// The server part registers it with `ctx.rpc.register`, and the TUI part calls
// it through `client.rpc`. It is written as the plain definition object the RPC
// runtime reads — `Rpc.define` from the plugin SDK returns the same object,
// validating only that no error name is reserved — so this file imports nothing
// and the package's tests load it with plain Node.
//
// This file serves `status` alone: the last poll, its outcome and each
// workspace's state.

const emptyObject = { type: "object", properties: {}, additionalProperties: false }

const workspace = {
  type: "object",
  properties: {
    name: { type: "string" },
    ok: { type: "boolean" },
    error: { type: ["string", "null"] },
  },
  required: ["name", "ok", "error"],
  additionalProperties: false,
}

const status = {
  type: "object",
  properties: {
    lastPoll: { type: ["string", "null"] },
    outcome: { type: "string" },
    workspaces: { type: "array", items: workspace },
    configError: { type: ["string", "null"] },
    today: {
      type: "object",
      properties: {
        flagged: { type: "integer" },
        nextStepsPosted: { type: "integer" },
        skipped: { type: "integer" },
      },
      required: ["flagged", "nextStepsPosted", "skipped"],
      additionalProperties: false,
    },
  },
  required: ["lastPoll", "outcome", "workspaces", "configError", "today"],
  additionalProperties: false,
}

export const SlackDirectorRpc = {
  id: "slack-director",
  methods: {
    status: { input: emptyObject, output: status },
  },
  events: {},
}
