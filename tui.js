// The TUI part: the `/slack-director` command and its palette entry.
//
// It asks the server part for the last poll through the RPC contract and shows
// the answer as a toast.
import { SlackDirectorRpc } from "./rpc.js"

/** The keymap command that carries the slash name and the palette entry. */
export const COMMAND_ID = "slack-director.status"

/** The last poll's time on the local clock, so it reads against the user's own. */
function pollClock(lastPoll) {
  if (typeof lastPoll !== "string") return "never"
  const at = new Date(lastPoll)
  if (Number.isNaN(at.getTime())) return "never"
  return [at.getHours(), at.getMinutes()].map((value) => String(value).padStart(2, "0")).join(":")
}

/** One line for the toast: the last poll, its outcome and each workspace. */
export function formatStatus(status) {
  const workspaces = (status?.workspaces ?? []).map(
    (workspace) => `${workspace.name} ${workspace.ok ? "✓" : "✗"}${workspace.error ? ` ${workspace.error}` : ""}`,
  )
  return [
    `Slack Director: last poll ${pollClock(status?.lastPoll)}`,
    status?.outcome ?? "unknown",
    ...workspaces,
  ].join(" · ")
}

export default {
  id: "slack-director.tui",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: COMMAND_ID,
          title: "Slack Director: status",
          group: "slack-director",
          palette: true,
          slash: { name: "slack-director" },
          run: async () => {
            let message
            try {
              // The client is read here, at call time: it changes after a server restart.
              message = formatStatus(await context.client.rpc(SlackDirectorRpc).status({}))
            } catch (error) {
              message = `Slack Director: ${error instanceof Error ? error.message : String(error)}`
            }
            context.ui.toast.show({ message })
          },
        },
      ],
    }))
  },
}
