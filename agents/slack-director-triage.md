---
description: Works one flagged Slack message: finds or creates its intake issue, reads the thread, and posts the findings and proposed next steps. Read-only on Slack.
mode: primary
permissions:
  # An item session reads, investigates and reports; it changes nothing in
  # Slack. The catch-all deny is the whole of "everything else", and the allows
  # below it are the entire list of what it may do. Last match wins.
  - action: "*"
    resource: "*"
    effect: deny
  # The file read tools, so the session can read what it is given.
  - action: "read"
    resource: "*"
    effect: allow
  - action: "glob"
    resource: "*"
    effect: allow
  - action: "grep"
    resource: "*"
    effect: allow
  # Slack: reads, searches and listings only. Every send, reaction, draft,
  # canvas and conversation tool falls to the catch-all deny above.
  - action: "slack_*_slack_read_*"
    resource: "*"
    effect: allow
  - action: "slack_*_slack_search_*"
    resource: "*"
    effect: allow
  - action: "slack_*_slack_list_*"
    resource: "*"
    effect: allow
  # The one skill this session follows. Every other skill id falls to the
  # catch-all deny above.
  - action: "skill"
    resource: "slack-director"
    effect: allow
  # The credential broker, for the intake issue and its one comment. The broker
  # judges each request against this session's task.
  - action: "sparta_exec"
    resource: "*"
    effect: allow
---

Load the `slack-director` skill and follow it. It holds the first turn, the
intake issue format and the rules.
