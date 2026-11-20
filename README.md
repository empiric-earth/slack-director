# slack-director

The Slack Director turns a flagged Slack message into a working OpenCode
session. React to a message with the flag emoji, and the plugin's watcher finds
it and starts one session for it, on the read-only triage agent. That session
finds or creates the intake issue for the message in your private intake repo,
reads the thread, investigates, and posts the findings and proposed next steps
as one comment on the issue. Switch the session's agent to `slack-director` to
act on the item.

It never sends a Slack message on its own: OpenCode asks you to approve every
send. It writes to the intake repo only, and always as a paraphrase plus the
Slack permalink — never the message text.

## Install

1. Create a private repo `empiric-earth/<you>-slack-intake`, and give your
   sparta GitHub account write on it.
2. From a checkout of this repo, run `make install`, then `opencode reload`.
   That installs the package into `~/.config/opencode/plugins/slack-director/`
   and the agents into `~/.config/opencode/agents/`, and removes any
   `~/.config/opencode/skills/slack-director/`, which would otherwise shadow
   the skill the package serves. Set `PREFIX` to install into another OpenCode
   config directory.
3. Add the flag emoji to your Slack workspaces, under the name the config's
   `flag_emoji` holds (default `oc`). Only your own reaction counts.
4. Write the config file `~/.config/opencode/slack-director/config.json`: one
   JSON object, and no secret in it. Its fields are:
   - `flag_emoji` — the emoji name without colons; default `oc`.
   - `intake_repo` — `owner/name`; required.
   - `session_directory` — the absolute path an item session runs in; required.
   - `poll_seconds` — the interval between scans; default `60`.
   - `work_hours` — `days` (a list of `Mon` … `Sun`), `start` and `end`
     (`HH:MM`), and `time_zone` (an IANA name).
   - `triage_agent` — the agent an item session runs on; default
     `slack-director-triage`.

   While `intake_repo` or `session_directory` is missing, the watcher polls
   nothing and its status names the missing field.
5. Start OpenCode in the session directory. When you want to act on an item,
   open its session and switch the agent to `slack-director` (shift+tab).

## Uninstall

From the checkout run `make uninstall`, then restart OpenCode. The intake repo
stays.

## Notes

- The watcher polls every connected Slack MCP server whose URL is
  `https://mcp.slack.com/mcp`, and gives each flagged message one item session.
  It writes nothing to Slack.
- Removing the flag from a message you have handled keeps the scan short: the
  watcher searches for the messages you have flagged, so a cleared flag leaves
  the search.
- One permalink gets one item session. A second flag in the same thread finds
  the issue that permalink already has, so no second issue appears.
- An item session's transcript holds the thread text it read. It lives in your
  local OpenCode database, and deleting the session deletes it.
- The message you flag is read by the triage agent and reaches the model. That
  is what the flag asks for; the agent's permissions bound what it may do with
  it.

## Permissions

The `slack-director` agent starts from the OpenCode rules you already have, so
the shell, the edits, the writes, the reads, the web and the subagents resolve
the way they do for your other agents. On top of them it sets two things:

- every Slack send asks first — send a message, schedule one, add a reaction,
  create or update a canvas, open a conversation — while reads, searches,
  listings, reactions and drafts need no prompt;
- the director works only in its session directory. OpenCode enforces that with
  its `external_directory` rule: file tools are confined to the workspace, and
  the shell is checked only for its working directory and `cd` targets and can
  read any path the user can read. It is not a sandbox. When the session
  directory is inside a git checkout, that whole checkout counts as inside.

The `slack-director-triage` agent, which runs an item session's first turn, is
read-only: it may read Slack threads, search and list Slack, read files, load
the `slack-director` skill, and write to the intake repo through the credential
broker — the intake issue and its one comment. Every Slack send, reaction,
draft, canvas and conversation tool, every edit and write, the shell, schedules,
subagents and file access outside its session directory are refused.

A teammate who wants tighter limits adds them in their own OpenCode config; the
agents inherit whatever that config sets.
