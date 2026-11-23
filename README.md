# slack-director

The Slack Director turns a flagged Slack message into a working OpenCode
session. Save a message for later in Slack, and the plugin's watcher finds it
and starts one session for it, on the `slack-director` agent — the agent you
act with, so no switch is needed. That session finds or creates the intake issue
for the message in your private intake repo, reads the thread, investigates, and
posts the findings and proposed next steps as one comment on the issue. Then it
stops and waits for you.

Every flagged message gets its intake issue: a message the scope rules leave out
— customer or production data, a Slack Connect or external channel, or one the
session cannot classify — gets an issue that holds the permalink fields and the
category only, with no paraphrase of its content.

It never sends a Slack message on its own: OpenCode asks you to approve every
send. It writes to the intake repo only, and always as a paraphrase plus the
Slack permalink — never the message text.

## The overview dialog

Everything the watcher has flagged sits in one floating dialog over the current
screen. Open it with `/slack-director`, or with the `Slack Director` entry in
the command palette:

- the header names the last poll, its outcome and each workspace — a workspace
  that failed carries `✗` and the reason;
- the counts line counts the items by state;
- the table lists one row per item: its state, its asker, its title, its intake
  issue, its channel and how long ago it was flagged;
- the today line carries the day's counts;
- the help line names the keys.

The dialog carries no Slack message text: a row's title is the item session's
own title.

An item's state is its session's live state: `working` while the session runs,
`waiting` while it waits on a permission request or until you have opened it
from the dialog, and `idle` once you have opened it and it is quiet. Waiting
comes first, then working, then idle; the newest flag comes first inside each.

Keys: `↑` and `↓` move the selection, `enter` opens the item's session, `i`
opens its intake issue in your browser, `s` opens the Slack message, `r` polls
now, `e` opens the settings dialog and `esc` closes the dialog.

What needs your attention stands out in colour — a waiting row, the row the
marker is on, and a workspace that failed — and the rest is dimmed.

While you are in a session, the sidebar carries one line:
`Slack Director  2 waiting · 1 working`.

The settings dialog — `e`, or the `Slack Director: settings` entry in the
palette — lists the config fields with their current values. `enter` on a row
asks for that one value and writes it through the watcher, which refuses a value
it cannot use and leaves the file as it was.

Only `slack-director` is in the agent list and in the shift+tab cycle. The
`slack-director-refresh` agent is hidden: it is for the short session the
watcher starts to renew a Slack sign-in, and you never pick it.

## Install

1. Create a private repo `empiric-earth/<you>-slack-intake`, and give your
   sparta GitHub account write on it.
2. From a checkout of this repo, run `make install`, then `opencode reload`.
   That installs the package into `~/.config/opencode/plugins/slack-director/`
   and the agents into `~/.config/opencode/agents/`, removes a
   `~/.config/opencode/agents/slack-director-triage.md` an earlier install left,
   and removes any `~/.config/opencode/skills/slack-director/`, which would
   otherwise shadow the skill the package serves. Set `PREFIX` to install into
   another OpenCode config directory.
3. Flag a message by saving it for later: open the message's `⋯` menu and pick
   `Save for later`, or add it to `Later` in the Slack sidebar. Only messages
   you save yourself count, and only you can see the flag.
4. Write the config file `~/.config/opencode/slack-director/config.json`: one
   JSON object, and no secret in it. Its fields are:
   - `intake_repo` — `owner/name`; required.
   - `session_directory` — the absolute path an item session runs in; required.
   - `poll_seconds` — the interval between scans; default `60`.
   - `work_hours` — `days` (a list of `Mon` … `Sun`), `start` and `end`
     (`HH:MM`) and `time_zone` (an IANA name); default Monday to Friday, 09:00
     to 18:00, in this machine's time zone. Nothing is polled outside it.
   - `session_agent` — the agent an item session runs on; default
     `slack-director`.

   The watcher reads the file when it starts and again whenever the file
   changes, so a change takes effect at the next poll with no restart. While
   `intake_repo` or `session_directory` is missing, the watcher polls nothing
   and its status names the missing field. A field it cannot use is named in
   the status too, and the watcher keeps polling with the values it last read.
5. Start OpenCode in the session directory. The overview dialog and the item
   sessions work from any directory.

## Uninstall

From the checkout run `make uninstall`, then restart OpenCode. The intake repo
stays.

## Notes

- The watcher polls every connected Slack MCP server whose URL is
  `https://mcp.slack.com/mcp`, and gives each flagged message one item session.
  It writes nothing to Slack.
- Flagging is saving for later: on the first poll the watcher picks up every
  message already in your Save-for-later list that has no item record, each one
  as a separate item session.
- A session is titled after the flagged message's channel and its author until
  its first turn ends, and after the intake issue's title from then on.
- Removing the flag from a message you have handled keeps the scan short: the
  watcher searches your Save-for-later list, so marking the message Completed or
  removing it from Later leaves the search.
- One permalink gets one item session and one intake issue. Flagging the same
  message again, or sending the first prompt for it again, finds the issue that
  permalink already has, so no second issue appears. A second message in the
  same thread is a different permalink, so it gets its own issue.
- An item an earlier build left without an issue is reissued once, on the next
  poll, when its message is still saved for later and its earlier session is
  quiet: one new session on `session_agent`, whose first turn makes the issue
  that permalink was missing.
- An item session's transcript holds the thread text it read. It lives in your
  local OpenCode database, and deleting the session deletes it.
- The message you flag is read by the item session and reaches the model. That
  is what the flag asks for; the agent's permissions bound what it may do with
  it.

## Permissions

The `slack-director` agent starts from the OpenCode rules you already have, so
the shell, the edits, the writes, the reads, the web and the subagents resolve
the way they do for your other agents. On top of them it sets three things:

- every Slack send asks first — send a message, schedule one, add a reaction,
  create or update a canvas, open a conversation — while reads, searches,
  listings, reactions and drafts need no prompt;
- the shell commands of the credentialed CLIs — `gh`, `glab` and `aws` — are
  refused, so their calls go through the credential broker, whose judge
  classifies each request against the session's task. Other authenticated shell
  clients, such as `git push` and `ssh`, stay allowed by your own rules: the
  first turn's restraint there rests on its prompt alone, and after it each step
  runs only on your approval of a proposed step;
- the director works only in its session directory. OpenCode enforces that with
  its `external_directory` rule: file tools are confined to the workspace, and
  the shell is checked only for its working directory and `cd` targets and can
  read any path the user can read. It is not a sandbox. When the session
  directory is inside a git checkout, that whole checkout counts as inside.

A teammate who wants tighter limits adds them in their own OpenCode config; the
agents inherit whatever that config sets.
