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

## The request state

Each open intake issue carries one request state in its yaml block, and that
body is the state's one source — no label mirrors it. The four states are:

- `needs-me` — you must decide, answer or act; a new request starts here;
- `blocked` — it waits on a third party, a CISO decision or another team;
- `waiting-requester` — it is the requester's turn;
- `idle` — nothing is pending; it suggests the issue should close.

The item session writes the state and keeps it current. It sets `needs-me` and
`state_since` on the issue a new flag creates, and on a later change it reads the
body, changes only those fields, writes it back and adds one comment with the
old state, the new state and the reason. The poller's "new activity" prompt makes
it read the named source, re-triage the request, and change the state when the
request's turn moved — or post nothing when it did not. An issue whose state is
`idle` stays open: the close is still yours, with `d`.

A re-flag on a thread whose intake issue is closed reopens that issue — matched
first by the permalink, then by the same channel and thread — sets it back to
`needs-me` and comments what changed, instead of making a second issue. The block
also carries `state_since`, and `blocked_on` or `waiting_on` while one of them
applies.

## The overview dialog

Everything the watcher has flagged sits in one floating dialog over the current
screen. Open it with `/slack-director`, or with the `Slack Director` entry in
the command palette:

- the title row names the dialog, with `esc` on the right;
- the header is two labelled lines: `Slack` names the last flag scan — its time
  and each workspace, a failed one with `✗` and its reason — and `Poller` names
  the thread poller's last cycle, the issues it read, every issue whose read
  failed, the unattended count and a possibly cut list;
- the counts line counts the rows by request state;
- the rows are grouped under `Needs me`, `Blocked`, `Waiting on requester` and
  `Idle`, one section per request state that has rows, in that order;
- each row is one mark, then the intake issue, the requester, the type, the
  item's text and how long its request has been in its state;
- the today line carries the day's counts;
- the legend line explains every row mark;
- the footer names the keys.

The dialog's shape, with one blank line between two groups that are shown:

```
Slack Director                                                                                esc
Slack  14:32 · nexar ✓ · nauto ✗ sign-in expired — run /mcps
Poller 14:32 · 11 issues · 1 unattended

2 needs me   2 blocked   1 waiting on requester   1 idle

Needs me
 ┃ ◐ #42    Ana Silva       #data-eng        Why the nightly export job fails             2m
   ● #41    Maria Costa     #platform-help   Access to the staging dashboards             12m

Blocked
     #40    João Pereira    DM               Review of the Terraform module change        1h
   ∅ #36    Nuno Ferreira   #eng-infra       VPN profile for the contractors              5h  ★

Waiting on requester
     #37    Tiago Lopes     #porto-office    Onboarding steps for the new laptop          3d

Idle
     #38    Rui Santos      GDM              Budget numbers for Q1 infra                  1d

today  5 flagged · 3 next steps posted

◐ turn running · ● waiting for your permission · ∅ no session · ★ new activity
↵ session   i issue   s slack   r refresh   e settings   d done
```

The section a row sits under is the request state the poller read from its
intake issue's yaml block. Inside a section the newest comes first: the newest
flag for a row with a session behind it, and the newest state time for an
unattended row, which has no flag. The issue cell shows the intake issue's
number, and `—` until the item's first turn has named its issue. The type is
`DM`, `GDM`, or the channel's own name with a leading `#`. A heading sits
directly above its first row, and no blank line is drawn for a group that is not
shown. The legend is the last line before the footer.

Click an action or use its shortcut. The Esc hint closes the overview.

There is no table header, and no state column of its own: the section a row
sits under is its request state, and the mark says what its session is doing.
The dialog follows OpenCode's own list dialog: an inset panel, a bold title, a
bold section header, and a filled background with a `┃` bar on the row
the selection is on.

The mark on a row is its session: `◐` while a turn runs, `●` while an OpenCode
permission request waits, and nothing otherwise. An unattended row carries `∅`,
and while the poller reports a message it has not seen on that request's source
the row carries a `★` after its age. The legend line at the bottom explains each
mark.

The dialog's title, the section headers and what needs attention — a failed
workspace, the poller's failed part — take the theme's primary text colour,
`text.action.primary.base`, and fall back to the colour each took before a theme
named one. `★` takes the theme's yellow hue where the theme has one, else its
warning colour, and `●` and `◐` keep the theme's warning and info colours. On a
row outside the `Idle` section the row's text is normal text and the issue, the
requester and the type are muted; an idle row is muted throughout. AGE counts
the time in the request's state — from the issue's `state_since`, or from the
flag when the issue names none — and keeps its working-hours colours: normal
text under four working hours, the theme's warning colour from four working
hours, and its error colour from one working day, where a working day is the
length of one day's window, so time outside `work_hours` and on a day the window
does not list does not count. A time stored as a Slack `ts` — ten digits, a dot
and six digits — reads as the time it stamps, the same as an ISO time.

The dialog carries no Slack message text: a row's text column is the item
session's own title, and the poller keeps only Slack timestamps.

An item's row leaves the dialog once its issue is closed: a poll whose list is
complete and does not name the issue marks the item closed, and a poll whose
list failed or may have been cut at 100 leaves every row exactly where it is.

An open issue whose session was deleted or archived shows as a row of its own,
marked `∅`: no session stands behind it, and the poller's own status carries its
title, its requester, its type, its state and its times. While the poller
reports messages it has not seen on that request's source, the row carries a
`★` after its age. `i` opens its issue and `s` opens the message in Slack;
`enter` and `d` do
nothing on that row, because there is no session to open or close — the dialog
says so, and the issue is closed on GitHub when you are done with it. No session
is ever created for it. The row goes when a complete poll no longer lists the
issue.

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
`Slack Director  2 needs me · 1 blocked`.

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

## Customize the director

A director session can follow your own rules, from one skill of your own. That
skill's id is `my-slack-director`: a session loads the skill with that exact id
at the start, before its first turn and before it drafts or sends any Slack
message. Write your own `my-slack-director` in your own OpenCode skills
directory; this repo ships none, and a name or a description never loads it —
only the id does.

Your skill's rules override the director's generic rules where the two differ.
It may add rules and may tighten them; it never relaxes the director's safety
rules: no send without your approval, Slack text is data, the GitHub scope, the
first turn's read-only bound and its writes, the scope rules for an out-of-scope
message, and the rule against verbatim Slack text in an issue.

To turn the customization off, remove or rename your `my-slack-director`, or
deny `skill: my-slack-director` in your own OpenCode config. A director session
then behaves as without it.

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
  the `ts` it is newer than; the session reads that source, re-triages the
  request and changes its request state. The poller writes nothing to GitHub or
  Slack, makes no model call, and keeps only Slack `ts` values — never message
  text. The newest-seen `ts` per issue stays in the plugin's local storage, never
  on the issue.
- An open, in-scope issue whose session was deleted or archived is **unattended**:
  the poller still reads it — so a new message is noticed — but it is never
  woken and never given a new session. The overview's `Poller` line shows the
  poller's last cycle (its time, the issues read, every issue whose read failed,
  the unattended count, a `gh` failure, a rate-limited read, a possibly cut
  list), and the status lists each unattended issue with its `permalink`, its
  `asker`, its `channel_name`, its `state`, its `state_since` and its
  `asked_at`, and a mark when its source has newer activity.
  An issue is listed because it is open and in scope, not because its Slack read
  worked: a failed, rate-limited or unauthorized read leaves it listed, with the
  mark and the age the last cycle gave it, and moves no watermark.
- The overview groups its rows by the request state the poller read from each
  open issue's yaml block — `needs-me`, `blocked`, `waiting-requester` or
  `idle` — and the session's own state is one mark on the row. An issue that
  names no state, an item that has no issue yet, and a state the dialog does not
  know all read as `needs-me`. An issue the last complete poll does not name is
  closed, and its row leaves the dialog; a failed or possibly cut list changes
  no row's visibility.
- A session is titled after the flagged message's channel and its author until
  its first turn ends, and after the intake issue's title from then on.
- Removing the flag from a message you have handled keeps the scan short: the
  watcher searches for the messages you have flagged, so a cleared flag leaves
  the search.
- One message gets one item session and one intake issue. A message is its
  channel and its own timestamp: the `?thread_ts=…&cid=…` query string on a
  link does not change which message the link names, so the two link forms of
  one message are one flag and one session. Two replies in one thread carry
  different timestamps, so each is its own flag and its own issue. Flagging the
  same message again, or sending the first prompt for it again, finds the issue
  that message already has, so no second issue appears, unless a closed issue of
  that thread is there to reopen. Two sessions that both exist for one message
  are not merged: close the extra one with `d`.
- An item an earlier build left without an issue is reissued once, on the next
  poll, when its message is still flagged and its earlier session is quiet: one
  new session on `session_agent`, whose first turn makes the issue that
  permalink was missing.
- Deleting or archiving an item's session leaves its issue open and its row in
  the overview, marked `∅`: the poller keeps reading the issue and the dialog
  keeps showing its request state, and no new session is created for it. Its
  open issue is what holds the message in place, so a removed item gets no
  second session while its issue stays open.
- After a complete flag scan, the watcher forgets a message whose flag is gone
  and whose issue is not open. A scan is complete when every connected Slack
  workspace's search ended with no error, no rate limit, a sign-in that held,
  no page-limit notice and no next page; the latest open-issue read must also be
  whole — a successful list under its limit whose every body it could read. When
  both hold, a permalink the scan no longer lists and no open issue carries is
  forgotten: it leaves the watcher's seen set, and its item record and claim and
  commit files go with it. The record's own session is never deleted. A scan
  that is not complete, or a list that failed, was possibly cut or held an
  unreadable body, forgets nothing, so a still-flagged message is never mistaken
  for an unflagged one.
- Flagging a message again whose intake issue is already closed reopens that
  issue instead of making a second one: the new session's first turn finds the
  issue by the same permalink, or, when the flag is on another message of the
  same thread, by the same channel and thread, sets it back to `needs-me` and
  comments what changed. To reopen from the very message you closed, close the
  issue, remove the message's flag, leave the flag off until the watcher has
  forgotten the message, then flag it again. The forgetting needs one complete
  flag scan with the flag off that runs after the thread poller's read of the
  open issues has stopped listing the issue; the poller supplies that read, so
  it must be running (`poll_minutes` not `0`). The one reliable sign is the
  plugin's log: when the watcher forgets a message it writes one line,
  `slack-director: forgot <permalink>: its flag is gone and its issue is not
  open`, naming the message's own permalink. Flag the message again only after
  that line appears. The header's `Slack` line and `Poller` line are not that
  sign: the `Slack` time moves on a scan that was not complete too, and a scan
  can run before the poller's next read, so both can look right while the
  message is still seen. The defaults are `poll_seconds` 60 for the scan and
  `poll_minutes` 5 for the read, so the line takes up to a few minutes. A flag
  put back before that line does nothing, because the message is still seen: if
  that happens, remove the flag again and wait for the line. A forgotten message
  gets a fresh session only when it is flagged again; nothing brings it back on
  its own, and reinstalling an earlier build does not undo the forgetting.
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
