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

## The overview page

Everything the watcher has flagged sits on one page. Open it with
`/slack-director`, or with the `Slack Director` entry in the command palette:

- the header names the last poll, its outcome and each workspace — a workspace
  that failed carries `✗` and the reason;
- the counts line counts the items by state;
- the table lists one row per item: its state, its asker, its title, its intake
  issue, its channel and how long ago it was flagged;
- the today line carries the day's counts;
- the help line names the keys.

The page carries no Slack message text: a row's title is the item session's
own title.

An item's state is its session's live state: `working` while the session runs,
`waiting` while it waits on a permission request or until you have opened it
from the page, and `idle` once you have opened it and it is quiet. Waiting comes
first, then working, then idle; the newest flag comes first inside each.

Keys: `enter` opens the item's session, `i` opens its intake issue in your
browser, `s` opens the Slack message, `r` polls now, `,` opens the settings
dialog and `esc` goes back. `↑` and `↓` move the selection.

While you are in a session, the sidebar carries one line:
`Slack Director  2 waiting · 1 working`.

The settings dialog — `,`, or the `Slack Director: settings` entry in the
palette — lists the config fields with their current values. `enter` on a row
asks for that one value and writes it through the watcher, which refuses a value
it cannot use and leaves the file as it was.

Only `slack-director` is in the agent list and in the shift+tab cycle. The two
agents the watcher starts sessions on — `slack-director-triage` and
`slack-director-refresh` — are hidden: they are for the sessions the plugin
starts, and a flagged item still starts on the triage agent. To act on an item,
open its session and switch the agent to `slack-director`.

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
     (`HH:MM`) and `time_zone` (an IANA name); default Monday to Friday, 09:00
     to 18:00, in this machine's time zone. Nothing is polled outside it.
   - `triage_agent` — the agent an item session runs on; default
     `slack-director-triage`.

   The watcher reads the file when it starts and again whenever the file
   changes, so a change takes effect at the next poll with no restart. While
   `intake_repo` or `session_directory` is missing, the watcher polls nothing
   and its status names the missing field. A field it cannot use is named in
   the status too, and the watcher keeps polling with the values it last read.
5. Start OpenCode in the session directory. When you want to act on an item,
   open its session and switch the agent to `slack-director` (shift+tab).

## Uninstall

From the checkout run `make uninstall`, then restart OpenCode. The intake repo
stays.

## Notes

- The watcher polls every connected Slack MCP server whose URL is
  `https://mcp.slack.com/mcp`, and gives each flagged message one item session.
  It writes nothing to Slack.
- A session is titled after the flagged message's channel and its author until
  its first turn ends, and after the intake issue's paraphrase from then on.
- Removing the flag from a message you have handled keeps the scan short: the
  watcher searches for the messages you have flagged, so a cleared flag leaves
  the search.
- One permalink gets one item session and one intake issue. Flagging the same
  message again, or sending the first prompt for it again, finds the issue that
  permalink already has, so no second issue appears. A second message in the
  same thread is a different permalink, so it gets its own issue.
- A flagged message the scope rules leave out — customer or production data, a
  Slack Connect or external channel, or one the session cannot classify — gets
  no issue and no comment. The session's reply says so instead of naming an
  issue.
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
broker — the intake issue and its one comment, and nothing else: no issue edit,
no label, no close or reopen, and no second comment. Every Slack send,
reaction, draft, canvas and conversation tool, every edit and write, the shell,
schedules, subagents and file access outside its session directory are refused.

A teammate who wants tighter limits adds them in their own OpenCode config; the
agents inherit whatever that config sets.
