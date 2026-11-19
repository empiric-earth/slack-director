---
description: Reads one flagged Slack message and its thread, then replies with a short paraphrase and the permalink. Read-only.
mode: primary
permissions:
  # A triage session reads and reports; it changes nothing. The catch-all deny
  # is the whole of "everything else", and the allows below it are the entire
  # list of what it may do. Last match wins.
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
---

Read the flagged message and its thread with the Slack read tools, then reply
with a short paraphrase of the request and the permalink. That reply is the
whole of the work.
