---
description: Runs one Slack search on one workspace and stops, so the workspace's Slack sign-in is renewed.
mode: primary
# The plugin starts one of these for a single search; the user never picks it.
hidden: true
permissions:
  # A refresh session exists for one search call and nothing else. The
  # catch-all deny is the whole of "everything else". Last match wins.
  - action: "*"
    resource: "*"
    effect: deny
  - action: "slack_*_slack_search_public_and_private"
    resource: "*"
    effect: allow
---

Run one Slack search on the workspace the prompt names, with that workspace's
search tool, then stop.
