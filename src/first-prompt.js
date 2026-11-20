// The fixed prompts the server part sends.
//
// The triage agent allows the Slack read tools, the file read tools, the
// `slack-director` skill and the credential broker, so the first prompt asks
// for one intake issue, one comment and the same text as the reply.

/**
 * The first prompt of an item session: find or create the intake issue for the
 * permalink, read the thread, and post the findings and next steps once.
 */
export function itemFirstPrompt(hit, intakeRepo) {
  return [
    "A Slack message was flagged for triage.",
    "",
    `permalink: ${hit.permalink}`,
    `workspace: ${hit.workspace}`,
    `channel: ${hit.channel.label} (${hit.channel.id})`,
    `ts: ${hit.ts}`,
    `intake repo: ${intakeRepo}`,
    "",
    "Load the `slack-director` skill and follow it.",
    "",
    "Find the intake issue in that repo whose `permalink` field equals the permalink",
    "above, among open and closed issues alike, and create one in the skill's issue",
    "format when there is none. Write a paraphrase and the permalink only, never",
    "verbatim Slack text.",
    "",
    "Read that message's thread with the Slack read tools and investigate, read-only.",
    "",
    "Post the findings and proposed next steps as one comment on the issue, and reply",
    "with the same findings and next steps. End your reply with exactly these two",
    "lines:",
    "",
    "Intake issue: <the issue's URL>",
    "Title: <the issue title's paraphrase>",
    "",
    "Then stop, and take no other action.",
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
