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
2. Copy `agents/slack-director.md` into `~/.config/opencode/agents/`, and the
   folder `skills/slack-director/` into `~/.config/opencode/skills/`.
3. Add `"experimental": { "schedules": true }` to your OpenCode config, so a
   session can be woken on an interval. Optionally bind the agent's model with
   `agents.slack-director.model`.
4. Create a directory for the session. Copy `slack-director.example.yaml` into
   it as `slack-director.yaml` and fill it in: the intake repo, the workspaces,
   the user groups to watch and the working hours.
5. Restart OpenCode in that directory, pick the `slack-director` agent, and
   tell it what to watch and which intake repo to use. sparta judges its GitHub
   requests against what you tell it.
6. Run `/schedule every <N> minutes: run one Slack Director pass`.

## Uninstall

Delete the schedule, remove the two files you copied, and restart OpenCode. The
intake repo stays.

## Notes

- Run one director per intake repo. Two directors on one repo can track the same
  request twice.
- A pass runs only while the OpenCode service runs. Passes missed while it is
  stopped are covered by the next pass, which searches from the cursor.
- The director reads Slack and writes to the intake repo. Every Slack send waits
  for the user's approval in OpenCode's prompt.
