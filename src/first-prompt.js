// The fixed prompts the server part sends.
//
// The `slack-director` agent allows the Slack read tools, the file read tools,
// the `slack-director` skill and the credential broker, and denies the shell
// commands of the credentialed CLIs. The broker judges each of its calls
// against the session's task, so the first prompt names the only GitHub writes
// the first turn may make: one issue create and one comment.

/**
 * The first prompt of an item session: apply the skill's scope rules, find or
 * create the intake issue for the permalink, read the thread, and post the
 * findings and next steps once. Every flagged message gets an issue; a message
 * the scope rules leave out gets one that holds the permalink fields and its
 * category only. The category is decided from what this prompt already carries,
 * so a session reads nothing to place a message it leaves out.
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
    "The flag is the user's own triage, so a flagged message counts as a request to the user. Apply the skill's scope rules first, and decide the category without reading anything: the permalink, the workspace and the channel above are what tell it. Only a message in one of the skill's out-of-scope categories — customer or production data, Slack Connect or an external channel — or one whose category those do not tell is left out of the investigation. A message you leave out still gets its issue: create one that holds the permalink fields and the category only, with no paraphrase of its content, and post one comment that says it is out of scope and asks the user. Read no thread and no channel for it, in any workspace: not to confirm the category, and not to look for a message Slack does not hold.",
    "",
    "Otherwise find the intake issue in that repo whose `permalink` field equals the permalink above, among open and closed issues alike, and create one in the skill's issue format only when no issue carries it. Write a paraphrase and the permalink only, never verbatim Slack text.",
    "",
    "Read that message's thread with the Slack read tools and investigate, read-only.",
    "",
    "Post the findings and proposed next steps as one comment on the issue.",
    "",
    "Make no GitHub write but that one issue create and that one comment: no issue edit, label, close or reopen, and no second comment. A correction goes into the one comment.",
    "",
    "Reply with the same findings and next steps, and end your reply with exactly these two lines:",
    "",
    "Intake issue: <the issue's URL>",
    "Title: <the issue's exact title>",
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
