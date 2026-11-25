# slack-director

The Slack Director turns a flagged Slack message into a working OpenCode
session. React to a message with the flag emoji, and the plugin's watcher finds
it and starts one session for it, on the `slack-director` agent — the agent you
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

- the title row names the dialog, with `esc` on the right;
- the header names the last poll, each workspace — a workspace that failed
  carries `✗` and the reason — and the poller's one cell;
- the counts line counts the items by state, each state's mark in its own
  colour;
- the rows are grouped under `Waiting for you`, `Working` and `Idle`, one
  section per state that has rows, in that order;
- each row is the state mark, then the item's title, its asker, its channel, its
  intake issue and how long ago it was flagged;
- the today line carries the day's counts;
- the footer names the keys.

The dialog's shape, with one blank line between two groups that are shown:

```
Slack Director                                                                            esc
last poll 14:32 · nexar ✓ · nauto ✗ sign-in expired — run /mcps · poller 14:32 ✓ 4 issues · 2 threads · 1 conversation

● 2 waiting for you   ◐ 1 working   ○ 1 idle

Waiting for you
 ┃ ● Access to the staging dashboards             Maria Costa     #platform-help   —      12m
   ● Review of the Terraform module change        João Pereira    DM               —      1h

Working
   ◐ Why the nightly export job fails             Ana Silva       #data-eng        —      2m

Idle
   ○ Budget numbers for Q1 infra                  Rui Santos      GDM              —      1d

today  4 flagged · 3 next steps posted

↵ session   i issue   s slack   r refresh   e settings   d done
```

The issue cell shows `—` until the item's first turn has named its issue. A
heading sits directly above its first row, and no blank line is drawn for a
group that is not shown.

Click an action or use its shortcut. The Esc hint closes the overview.

There is no table header, and no state column of its own: the section a row
sits under is its state, and the mark repeats it. The dialog follows OpenCode's
own list dialog: an inset panel, a bold title, a bold muted section header, and
a filled background with a `┃` bar on the row the selection is on.

Only the state mark takes a state colour: `●` for waiting and `◐` for working
take their colour from the theme, and `○` for idle is muted. On a waiting or
working row the title is normal text and the asker, the channel and the issue
number are muted; an idle row is muted throughout. AGE is normal text under four
working hours, the theme's warning colour from four working hours, and its error
colour from one working day — where a working day is the length of one day's
window, so time outside `work_hours` and on a day the window does not list does
not count.

The dialog carries no Slack message text: a row's title is the item session's
own title.

An item's state is its session's live state: `working` while the session runs,
`waiting` while it waits on a permission request or until you have opened it
from the dialog, and `idle` once you have opened it and it is quiet. Waiting
comes first, then working, then idle; the newest flag comes first inside each.

A row leaves the dialog when its session is deleted or archived: the item's
record goes with the session, so the row is gone from the overview and stays
gone.

Keys: `↑` and `↓` move the selection, `enter` opens the item's session, `i`
opens its intake issue in your browser, `s` opens the Slack message, `r` polls
now, `e` opens the settings dialog, `d` closes the item and deletes its session,
and `esc` closes the dialog.

Click Done or press `d` to close the item and delete its session. The confirm
names the item and says the delete cannot be restored. Cancel or Esc returns to
the same item, still highlighted, wherever it now sits in the list. Confirming
starts the close; the item stays in the list until it is removed, and the
overview comes straight back, so you can carry on. A close the watcher refuses,
or a request that fails, keeps the item visible and shows the reason and what to
do next; the overview stays usable, and you can try again through the confirm.

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
3. Add the flag emoji to your Slack workspaces, under the name the config's
   `flag_emoji` holds (default `oc`). Only your own reaction counts.
4. Write the config file `~/.config/opencode/slack-director/config.json`: one
   JSON object, and no secret in it. Its fields are:
   - `flag_emoji` — the emoji name without colons; default `oc`.
   - `intake_repo` — `owner/name`; required.
   - `session_directory` — the absolute path an item session runs in; required.
   - `poll_seconds` — the interval between flag scans; default `60`.
   - `poll_minutes` — the interval between thread-poller cycles; default `5`.
     `0` turns the poller off and leaves the flag scan running.
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
- The flag scan and the thread poller run once per OpenCode server process, not
  once per workspace or project: the first plugin instance a process loads owns
  the timers, and another loaded instance takes them over when it unloads. A
  poll-now from any instance runs the owner's scan.
- The thread poller reads the intake repo's open issues through the host's `gh`
  — the CLI's own login, its argument list fixed and no shell, a list of at most
  100 issues — and, for every open issue that is in scope, its Slack thread for
  messages newer than the newest one seen; a DM's or a group DM's conversation
  is read too. A newer message wakes the item session with a "new activity"
  prompt that names the issue, the source (`thread`, `conversation` or both) and
  the `ts` it is newer than. The poller writes nothing to GitHub or Slack, makes
  no model call, and keeps only Slack `ts` values — never message text. The
  newest-seen `ts` per issue stays in the plugin's local storage, never on the
  issue.
- An open, in-scope issue whose session was deleted or archived is **unattended**:
  the poller still reads it — so a new message is noticed — but it is never
  woken and never given a new session. The overview's header shows the poller's
  last cycle (its time, the issues, threads and conversations read, the
  unattended issues, a `gh` failure, a rate-limited read, a possibly cut list),
  and the status lists each unattended issue with its `permalink`, `state`,
  `state_since` and `asked_at`, and a mark when its source has newer activity.
- A session is titled after the flagged message's channel and its author until
  its first turn ends, and after the intake issue's title from then on.
- Removing the flag from a message you have handled keeps the scan short: the
  watcher searches for the messages you have flagged, so a cleared flag leaves
  the search.
- One permalink gets one item session and one intake issue. Flagging the same
  message again, or sending the first prompt for it again, finds the issue that
  permalink already has, so no second issue appears. A second message in the
  same thread is a different permalink, so it gets its own issue.
- An item an earlier build left without an issue is reissued once, on the next
  poll, when its message is still flagged and its earlier session is quiet: one
  new session on `session_agent`, whose first turn makes the issue that
  permalink was missing.
- Deleting or archiving an item's session takes its row out of the overview for
  good. The message is not picked up again: a permalink that has had a session
  keeps its place, so a removed item gets no second session.
- `d`, or a click on the footer's Done hint, closes the item for good: the
  item's own session posts a close-reason comment and closes the intake issue as
  completed, and the plugin deletes the session and every child session under it
  once that session's own reply names the issue as closed. A turn running in the
  session is stopped. The confirm before it names the item and says the delete
  cannot be restored; cancelling returns to the same item, and the row stays
  until the session is actually deleted.
- A session that is running, or one with a permission request pending, refuses
  the close and keeps its row: the close turn must be the only turn in the
  session. The dialog says the close was refused, and what to do next.
- A record whose session is already gone is dropped from the list, and its
  intake issue stays open: the plugin cannot prompt a session that no longer
  exists, so it closes nothing, and both its log and the dialog say so.
- Every close writes two lines to the plugin's log — one when it starts and one
  when it ends, with the outcome — so a close still in flight can be found. A
  close the watcher refuses reaches the dialog as well, with the reason and what
  to do next.
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
