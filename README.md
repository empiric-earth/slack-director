# slack-director

The Slack Director is one OpenCode agent in one long-lived session. It watches
Slack for requests to its user — direct messages, @mentions and the user groups
it watches — tracks each request as an issue in the user's private intake repo,
and helps the user handle it in the same session. The open issues are the
pending list.

It never sends a Slack message on its own: OpenCode asks the user to approve
every send. It writes to the intake repo only, and always as a paraphrase plus
the Slack permalink — never the message text.

## Install

1. Create a private repo `empiric-earth/<you>-slack-intake`, and give your
   sparta GitHub account write on it.
2. From a checkout of this repo, run `make install`, then `opencode reload`.
   That installs the package into `~/.config/opencode/plugins/slack-director/`
   and the agent into `~/.config/opencode/agents/`, and removes any
   `~/.config/opencode/skills/slack-director/`, which would otherwise shadow
   the skill the package serves. Set `PREFIX` to install into another OpenCode
   config directory.
3. Add `"experimental": { "schedules": true }` to your OpenCode config, so a
   session can be woken on an interval. Optionally bind the agent's model with
   `agents.slack-director.model`.
4. Create a directory for the session — the session directory, which is the
   working directory OpenCode is started in. Copy `slack-director.example.yaml`
   into it as `slack-director.yaml` and fill it in: the intake repo, the
   workspaces, the user groups to watch and the working hours. The director
   reads that file by its relative name from the working directory, so it must
   sit there and nowhere else.
5. Start OpenCode in the session directory, pick the `slack-director` agent,
   and tell it what to watch and which intake repo to use. sparta judges its
   GitHub requests against what you tell it.
6. Run `/schedule every <N> minutes: run one Slack Director pass`. Type
   `/slack-director-intake` in the director session for a pass on demand.

## Uninstall

From the checkout run `make uninstall` — it removes the package directory and
the agent file — then delete the schedule and restart OpenCode. The intake repo
stays.

## Notes

- Run one director per intake repo. Two directors on one repo can track the same
  request twice.
- A pass runs only while the OpenCode service runs. Passes missed while it is
  stopped are covered by the next pass, which searches from the cursor.
- The director reads Slack and writes to the intake repo. Every Slack send waits
  for the user's approval in OpenCode's prompt.

## Permissions

The director starts from the OpenCode rules you already have, so the shell, the
edits, the writes, the reads, the web and the subagents resolve the way they do
for your other agents. On top of them it sets three things:

- every Slack send asks first — send a message, schedule one, add a reaction,
  create or update a canvas, open a conversation — while reads, searches,
  listings, reactions and drafts need no prompt;
- schedules are allowed, because a director runs its passes on one;
- the director works only in its session directory — the directory that holds
  `slack-director.yaml`, the one OpenCode was started in.

OpenCode enforces that last one with its `external_directory` rule: file tools
are confined to the workspace, and the shell is checked only for its working
directory and `cd` targets and can read any path the user can read. It is not a
sandbox. When the session directory is inside a git checkout, that whole
checkout counts as inside.

A teammate who wants tighter limits adds them in their own OpenCode config; the
director inherits whatever that config sets.
