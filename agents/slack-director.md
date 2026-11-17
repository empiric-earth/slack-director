---
description: Watches Slack for requests to you, tracks each one as an issue in your private intake repo, and helps you handle it.
mode: primary
permissions:
  # These rules sit after the OpenCode rules the user already has, so shell,
  # edits, writes, reads, web access and subagents resolve the way they do for
  # every other agent. Only what the director needs on top is written here.
  # Last match wins.
  #
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
  # A director runs passes on a schedule, which the rules above the agent file
  # deny to every agent.
  - action: "opencode_schedule_*"
    resource: "*"
    effect: allow
  # The director works only in its own session directory. File tools outside it
  # are refused. The shell is checked only for its working directory and its
  # `cd` targets, so a command that names any other path still runs.
  - action: "external_directory"
    resource: "*"
    effect: deny
---

Load the `slack-director` skill before any Slack work. It holds the pass, the
intake issue format and the rules.
