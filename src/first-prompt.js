// The fixed prompts the server part sends.
//
// The `slack-director` agent allows the Slack read tools, the file read tools,
// the `slack-director` skill and the credential broker, and denies the shell
// commands of the credentialed CLIs. The broker judges each of its calls
// against the session's task, so the first prompt names the only GitHub writes
// the first turn may make: one issue create and one comment.

/**
 * The first prompt of an item session: find the intake issue for the permalink
 * — creating one only when no issue carries it, before either branch writes —
 * apply the skill's scope rules, read the thread, and post the findings and
 * next steps once. Every flagged message gets an issue; a message the scope
 * rules leave out gets the one the lookup found or made, holding the permalink
 * fields and its category only. The category is decided from what this prompt
 * already carries, so a session reads nothing to place a message it leaves out.
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
    "The flag is the user's own triage, so a flagged message counts as a request to the user.",
    "",
    "Find the intake issue first, before any other write: look in that repo for the issue whose `permalink` field equals the permalink above, among open and closed issues alike, and create one in the skill's issue format only when no issue carries it. One issue per permalink is what keeps a later turn — a reissue included — from making a second one for the same message, so no branch below creates an issue of its own.",
    "",
    "Then apply the skill's scope rules, and decide the category without reading anything: the permalink, the workspace and the channel above are what tell it. The skill's out-of-scope categories are customer or production data, Slack Connect or an external channel, and a category the permalink, the workspace and the channel do not tell; only a message in one of them is left out of the investigation. A message you leave out still gets its issue — the one the lookup found or made — which holds the permalink fields and the category only, with no paraphrase of its content, and one comment that says it is out of scope and asks the user. Read no thread and no channel for it, in any workspace: not to confirm the category, and not to look for a message Slack does not hold.",
    "",
    "Otherwise write a paraphrase and the permalink only, never verbatim Slack text; read that message's thread with the Slack read tools and investigate, read-only; and post the findings and proposed next steps as one comment on the issue.",
    "",
    "Make no GitHub write but that one issue create and that one comment: no issue edit, label, close or reopen, and no second comment. A correction goes into the one comment.",
    "",
    "Reply with the template below, filled in from what you found — the chat reply is what the user reads, so keep it scannable. Write its sections in this order, and end your reply with the two fixed lines, below the `---` rule:",
    "",
    "```",
    "**<asker>** · <#channel | DM | GDM> · <asked_at, e.g. Mon 24 Nov 09:55> · [message](<permalink>)",
    "**Gist:** <one line: what they want from you>",
    "**Status:** <unanswered | answered by X | nudged N times> · **Due:** <date | none named>",
    "",
    "**What we know**",
    "- <what they want, paraphrased>",
    "- <fact checked> (<source>)",
    "- Missing: <what the message leaves out>",
    "- Not checked: <what this pass could not read>",
    "- ⚠️ <compliance flag, only when one applies>",
    "",
    "**Next steps**",
    "1. ⭐ <recommended> — <what the director does when picked>",
    "2. <a real alternative>",
    "",
    "---",
    "Intake issue: <the issue's URL>",
    "Title: <the issue's exact title>",
    "```",
    "",
    "**Next steps** lists every real option, the recommended one first with ⭐: two or more when there clearly are several, no filler, and a single option when only one path makes sense.",
    "",
    "A message the scope rules leave out gets the header line, **What we know** with the one bullet `Out of scope: <category>. I read nothing.`, and its real options.",
    "",
    "The issue comment is not bound by the template: it keeps the fuller record, with the detailed findings, the sources and the reasoning.",
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

/**
 * The close prompt of an item session, sent when the user presses `d` in the
 * overview. The user's own key is the ask, so the session closes its intake
 * issue as the skill's close form says, and the reply's one fixed line lets the
 * plugin bind the close to the turn it started before it deletes the session.
 */
export function closePrompt(issueUrl, intakeRepo) {
  return [
    "The user marked this item done.",
    "",
    `Intake issue: ${issueUrl}`,
    `Intake repo: ${intakeRepo}`,
    "",
    "Post one comment on that issue holding the one-line reason the item is done, then close the issue as completed — `state` and `state_reason` — with one `sparta_exec` call.",
    "",
    "End your reply with exactly this line:",
    "",
    `Closed: ${issueUrl}`,
    "",
    "Then stop, and take no other action.",
  ].join("\n")
}
