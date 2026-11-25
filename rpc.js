// The RPC contract between the server part and the TUI part.
//
// The server part registers it with `ctx.rpc.register`, and the TUI part calls
// it through `client.rpc`. It is written as the plain definition object the RPC
// runtime reads — `Rpc.define` from the plugin SDK returns the same object,
// validating only that no error name is reserved — so this file imports nothing
// and the package's tests load it with plain Node.
//
// The overview dialog reads `status`, `items` and the `updated` event, and the
// settings dialog reads and writes the config through `getConfig` and
// `setConfig`. The overview's `d` key closes one item with `done`: the item's
// own session closes its intake issue, and the plugin deletes the session on the
// close turn's own proof, and a close it refuses reaches the dialog as the
// `closeRefused` event, so the user is not left waiting for one that never ran.
// The live state of an item's session — whether it is
// running and whether it waits on a permission — is not here: the TUI reads that
// from its own session data.

const emptyObject = { type: "object", properties: {}, additionalProperties: false }
const nullableString = { type: ["string", "null"] }
const nullableInteger = { type: ["integer", "null"] }

const workHours = {
  type: "object",
  properties: {
    days: { type: "array", items: { type: "string" } },
    start: { type: "string" },
    end: { type: "string" },
    time_zone: { type: "string" },
  },
  required: ["days", "start", "end", "time_zone"],
  additionalProperties: false,
}

const config = {
  type: "object",
  properties: {
    flag_emoji: { type: "string" },
    intake_repo: { type: "string" },
    session_directory: { type: "string" },
    poll_seconds: { type: "integer" },
    poll_minutes: { type: "integer" },
    work_hours: workHours,
    session_agent: { type: "string" },
  },
  required: ["flag_emoji", "intake_repo", "session_directory", "poll_seconds", "poll_minutes", "work_hours", "session_agent"],
  additionalProperties: false,
}

const workspace = {
  type: "object",
  properties: {
    name: { type: "string" },
    ok: { type: "boolean" },
    error: nullableString,
  },
  required: ["name", "ok", "error"],
  additionalProperties: false,
}

// One open, in-scope issue whose session was deleted or archived. It is shown,
// never woken, and never given a new session.
const unattended = {
  type: "object",
  properties: {
    number: { type: "integer" },
    url: { type: "string" },
    title: { type: "string" },
    permalink: { type: "string" },
    state: { type: "string" },
    state_since: { type: "string" },
    asked_at: { type: "string" },
    newActivity: { type: "boolean" },
  },
  required: ["number", "url", "title", "permalink", "state", "state_since", "asked_at", "newActivity"],
  additionalProperties: false,
}

// The thread poller's last cycle. It is optional: an older status carries none,
// and the header shows no poller cell until a cycle has run.
const poller = {
  type: "object",
  properties: {
    lastCycle: nullableString,
    outcome: { type: "string" },
    issues: { type: "integer" },
    threads: { type: "integer" },
    conversations: { type: "integer" },
    unattended: { type: "array", items: unattended },
    ghError: nullableString,
    failed: { type: "array", items: { type: "integer" } },
    possiblyCut: { type: "boolean" },
  },
  required: [
    "lastCycle",
    "outcome",
    "issues",
    "threads",
    "conversations",
    "unattended",
    "ghError",
    "failed",
    "possiblyCut",
  ],
  additionalProperties: false,
}

const status = {
  type: "object",
  properties: {
    lastPoll: nullableString,
    outcome: { type: "string" },
    workspaces: { type: "array", items: workspace },
    configError: nullableString,
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
    poller,
  },
  required: ["lastPoll", "outcome", "workspaces", "configError", "today"],
  additionalProperties: false,
}

const item = {
  type: "object",
  properties: {
    permalink: { type: "string" },
    workspace: { type: "string" },
    channel: { type: "string" },
    asker: { type: "string" },
    flaggedAt: { type: "string" },
    sessionID: { type: "string" },
    title: { type: "string" },
    issueNumber: nullableInteger,
    issueUrl: nullableString,
    firstTurnEndedAt: nullableString,
    firstTurnFailed: { type: "boolean" },
    permissionPending: { type: "boolean" },
    openedAt: nullableString,
  },
  required: [
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
  ],
  additionalProperties: false,
}

export const SlackDirectorRpc = {
  id: "slack-director",
  methods: {
    status: { input: emptyObject, output: status },
    items: {
      input: emptyObject,
      output: {
        type: "object",
        properties: { items: { type: "array", items: item } },
        required: ["items"],
        additionalProperties: false,
      },
    },
    getConfig: {
      input: emptyObject,
      output: {
        type: "object",
        properties: { config },
        required: ["config"],
        additionalProperties: false,
      },
    },
    setConfig: {
      input: {
        type: "object",
        properties: { field: { type: "string" }, value: {} },
        required: ["field", "value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { config },
        required: ["config"],
        additionalProperties: false,
      },
      errors: {
        invalid: {
          type: "object",
          properties: { field: nullableString },
          required: ["field"],
          additionalProperties: false,
        },
      },
    },
    pollNow: { input: emptyObject, output: emptyObject },
    done: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: emptyObject,
    },
    markOpened: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: emptyObject,
    },
  },
  events: {
    updated: { schema: emptyObject },
    // A close the watcher refused before it removed anything: the dialog shows
    // the reason, so the user is not left waiting for a close that never ran.
    closeRefused: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, reason: { type: "string" } },
        required: ["sessionID", "reason"],
        additionalProperties: false,
      },
    },
  },
}
