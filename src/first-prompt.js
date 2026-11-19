// The fixed prompts the server part sends.
//
// This build's triage agent allows the Slack read tools and the file read tools
// and nothing else, so the skeleton prompt asks for a read and a paraphrase and
// no other change. The full first turn arrives with the skill, the intake issue
// and the next steps.
export const SKELETON_LIMITS = "Load no skill, create nothing and write nothing."

/** The first prompt of a skeleton item session. */
export function skeletonFirstPrompt(hit) {
  return [
    "A Slack message was flagged for triage.",
    "",
    `permalink: ${hit.permalink}`,
    `workspace: ${hit.workspace}`,
    `channel: ${hit.channel.label}`,
    `ts: ${hit.ts}`,
    "",
    "Read that message's thread with the Slack read tools, then reply with a short",
    "paraphrase of the request and the permalink.",
    SKELETON_LIMITS,
  ].join("\n")
}

/**
 * The prompt of a refresh session: one Slack search through OpenCode's own MCP
 * client, whose request renews the workspace's credential.
 */
export function refreshPrompt(workspace) {
  return [
    `Run one Slack search on the ${workspace} server, then stop.`,
    "",
    `Call ${workspace}_slack_search_public_and_private with the query "is:saved".`,
    "Make no other change.",
  ].join("\n")
}
