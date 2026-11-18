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

## Add your own rules with a custom skill

You can add your own rules to a pass, in a skill of your own, under one fixed
id: `my-slack-director`.

- **Where it lives.** The skill is an ordinary user skill, in a skill source
  OpenCode reads. In your OpenCode config directory that source is its `skills`
  directory: the skill is the folder `my-slack-director` inside it, holding a
  `SKILL.md` — `~/.config/opencode/skills/my-slack-director/SKILL.md` by
  default. A folder directly in the config directory is not in a source and is
  never found. Every other source works the same way, the global
  compatibility source `~/.claude/skills` included. OpenCode takes a skill's id
  from its folder name, so the folder must be named exactly `my-slack-director`.
  There is no discovery by description or by name pattern: the folder name is
  the id.
- **Keep it visible.** The skill needs a non-empty `description`, and must not
  set `metadata.opencode/autoinvoke: false` or
  `disable-model-invocation: true`. OpenCode leaves a skill without a
  description, or one that hides itself this way, out of the skill list — and a
  pass looks only in that list, so it never sees the skill.
- **What it may change.** A pass loads the skill when its list carries the id,
  and follows what it says. The skill may add rules at the hook points the
  director skill names. This skill names one hook point, **drop a hit**, in
  step 4 of a pass: a hit the rule matches is dropped before the dedup check —
  no issue, no comment, no deferred entry. A rule matches on what the Slack search
  result reports for the hit — its conversation kind, its sender's Slack id and
  its text — so it needs no Slack call of its own.
- **What it may not change.** A custom skill adds rules at hook points only. It
  never changes the issue format, the reply format, the state issue, the scope
  rules, the work hours or the tool permissions, and the director skill wins
  where the two conflict. These bounds are instructions the agent follows, not
  a mechanism: the loaded skill runs with the director agent's own rights, the
  same as the Slack skills a pass already loads.
- **In the reply.** Part 3 of the pass reply carries `custom: loaded` when the
  skill loaded on that pass, and `ignored: <n>` when n hits were dropped, with
  n greater than zero. When you have installed the skill and `custom: loaded`
  is missing from the reply, the pass did not load it: it went on as if the
  skill were not installed, and nothing was dropped.

The skill is one `SKILL.md` file. Save this one at
`~/.config/opencode/skills/my-slack-director/SKILL.md`, then run
`opencode reload`. Its `description` is what puts it in the skill list, and its
one rule drops an automated notification DM by sender id and a literal text
match — replace both values with your own:

```markdown
---
name: my-slack-director
description: My own rules for a slack-director pass — drops an automated notification DM.
---

# my-slack-director

- **drop a hit**: the hit is a DM, its sender's Slack id is `U0000000000`, and
  its text contains `Example notification text`.
```

Keep the rule narrow: every hit it matches is dropped silently, and a dropped
hit is never tracked.

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
