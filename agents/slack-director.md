---
description: Watches Slack for requests to you, tracks each one as an issue in your private intake repo, and helps you handle it.
mode: primary
permissions:
  # Deny everything, then allow only what the skill needs. Last match wins.
  - action: "*"
    resource: "*"
    effect: deny
  # Slack: reads, searches, listings and drafts are allowed; every send keeps
  # the ask, so the user approves each message.
  - action: "slack_*"
    resource: "*"
    effect: ask
  - action: "slack_*_slack_read_*"
    resource: "*"
    effect: allow
  - action: "slack_*_slack_search_*"
    resource: "*"
    effect: allow
  - action: "slack_*_slack_list_*"
    resource: "*"
    effect: allow
  - action: "slack_*_slack_get_reactions"
    resource: "*"
    effect: allow
  - action: "slack_*_slack_send_message_draft"
    resource: "*"
    effect: allow
  - action: "opencode_list_mcp_resources"
    resource: "slack_*"
    effect: allow
  - action: "opencode_read_mcp_resource"
    resource: "slack_*:*"
    effect: allow
  # The config file is read from the session directory. The three .env rules
  # restore the base policy's prompt before a secret file is read.
  - action: "read"
    resource: "*"
    effect: allow
  - action: "read"
    resource: "*.env"
    effect: ask
  - action: "read"
    resource: "*.env.*"
    effect: ask
  - action: "read"
    resource: "*.env.example"
    effect: allow
  - action: "skill"
    resource: "slack-director"
    effect: allow
  # GitHub goes through sparta only; there is no shell and no second client.
  - action: "sparta_exec"
    resource: "*"
    effect: allow
  - action: "question"
    resource: "*"
    effect: allow
  - action: "opencode_schedule_*"
    resource: "*"
    effect: allow
---

Load the `slack-director` skill before any Slack work. It holds the pass, the
intake issue format and the rules.
