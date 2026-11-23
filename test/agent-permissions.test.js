// The permission rules of the shipped agent file.
//
// OpenCode resolves an agent's rules as one list with the last match winning,
// `*` wildcards matching a whole action and a whole resource. The agent file's
// rules come after the user's own config and before OpenCode's trailing rules.
// This test reads the rules out of `agents/slack-director.md`, rebuilds that
// order around a fixture baseline shaped like a real one, and asserts the
// effect every rule of the file is there to produce. No dependencies; run with
// `node --test test/*.test.js` (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const AGENT_REL = "agents/slack-director.md"

/** The rules `permissions:` declares, in the order the file declares them. */
function declaredRules(text, rel = AGENT_REL) {
  const block = /^permissions:[ \t]*\n((?:[ \t]+\S.*\n|[ \t]*\n)*)/m.exec(text)
  assert.ok(block, `${rel} declares a permissions list`)
  const rules = []
  for (const raw of block[1].split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const start = /^- action:[ \t]*"?([^"]*)"?$/.exec(line)
    if (start) {
      rules.push({ action: start[1], resource: "", effect: "" })
      continue
    }
    const field = /^(resource|effect):[ \t]*"?([^"]*)"?$/.exec(line)
    const rule = rules.at(-1)
    assert.ok(field && rule, `${rel}: a rule field follows its rule, got: ${line}`)
    rule[field[1]] = field[2]
  }
  assert.ok(rules.length > 0, `${rel} declares at least one rule`)
  for (const rule of rules) {
    assert.ok(
      rule.action && rule.resource && rule.effect,
      `every rule names an action, a resource and an effect: ${JSON.stringify(rule)}`,
    )
  }
  return rules
}

/** A `*` wildcard pattern, matched against the whole text. */
function matches(pattern, text) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${source}$`).test(text)
}

/** The effect of the last rule whose action and resource both match. */
function resolve(rules, action, resource) {
  let effect
  for (const rule of rules) {
    if (matches(rule.action, action) && matches(rule.resource, resource)) effect = rule.effect
  }
  return effect
}

// A baseline shaped like a user's own rules, in OpenCode's resolution order:
// its defaults, then the config's rules — a destructive-shell deny, and the
// Slack and schedule denies every agent inherits. The agent file's rules follow
// the baseline, and OpenCode's two trailing rules close the list.
const BASELINE = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "shell", resource: "rm *-r*", effect: "deny" },
  { action: "slack_*", resource: "*", effect: "deny" },
  { action: "opencode_schedule_*", resource: "*", effect: "deny" },
]
const TRAILING = [
  { action: "browser", resource: "*", effect: "deny" },
  { action: "skill", resource: "browser", effect: "deny" },
]

const SERVERS = ["slack_nexar", "slack_nauto"]
const SHIPPED = readFileSync(join(ROOT, AGENT_REL), "utf8")
const FILE_RULES = declaredRules(SHIPPED)
const RESOLVED = [...BASELINE, ...FILE_RULES, ...TRAILING]

/** The effect a tool resolves to, with `*` as the usual resource. */
const effect = (action, resource = "*") => resolve(RESOLVED, action, resource)

test("the agent file carries no catch-all rule and no rule the baseline already decides", () => {
  for (const rule of FILE_RULES) {
    assert.notEqual(rule.action, "*", `${AGENT_REL} carries no deny-everything or allow-everything rule`)
    assert.ok(
      !["read", "skill", "sparta_exec", "question"].includes(rule.action),
      `${AGENT_REL} leaves the ${rule.action} rules to the baseline`,
    )
  }
})

test("every Slack send keeps the ask, on both servers", () => {
  const sends = [
    "send_message",
    "schedule_message",
    "add_reaction",
    "create_canvas",
    "update_canvas",
    "create_conversation",
  ]
  for (const server of SERVERS) {
    for (const tool of sends) {
      assert.equal(effect(`${server}_slack_${tool}`), "ask", `${server}_slack_${tool} asks the user first`)
    }
  }
})

test("Slack reads, searches, listings, reactions and drafts need no prompt", () => {
  const reads = ["read_channel", "search_messages", "list_channels", "get_reactions", "send_message_draft"]
  for (const server of SERVERS) {
    for (const tool of reads) {
      assert.equal(effect(`${server}_slack_${tool}`), "allow", `${server}_slack_${tool} proceeds without a prompt`)
    }
  }
})

test("the director inherits the baseline and adds its own rules on top", () => {
  assert.equal(effect("external_directory"), "deny", "work outside the session directory is refused")
  assert.equal(effect("shell", "rm -rf build"), "deny", "the baseline's destructive-shell rule still decides")
  assert.equal(effect("read", "certificate.env"), "ask", "a secret file still asks")
  assert.equal(effect("skill", "slack-minion"), "allow", "the user's Slack skills are loadable")
  assert.equal(effect("sparta_exec"), "allow", "GitHub through sparta is allowed")
  assert.equal(effect("skill", "browser"), "deny", "OpenCode's browser skill stays denied")
})

test("the director agent allows no schedule", () => {
  for (const action of [
    "opencode_schedule_run",
    "opencode_schedule_list",
    "opencode_schedule_create",
    "opencode_schedule_delete",
  ]) {
    assert.equal(effect(action), "deny", `${action} is refused, over the baseline's deny`)
  }
})

test("the credentialed CLIs' shell commands are refused, so their calls go through the broker", () => {
  for (const command of ["gh api user", "glab api user", "aws sts get-caller-identity"]) {
    assert.equal(effect("shell", command), "deny", `${command} is refused on this agent`)
  }
  assert.equal(effect("sparta_exec"), "allow", "the same calls go through the credential broker")
})

test("other authenticated shell clients stay by the user's own rules", () => {
  for (const command of ["git push origin HEAD:refs/heads/example", "ssh git@github.com", "ls -la"]) {
    assert.equal(effect("shell", command), "allow", `${command} resolves by the user's own rules`)
  }
})

// The one agent the watcher runs its short refresh session on. Its file starts
// from the same baseline and the same trailing rules, and decides everything
// else itself.
const REFRESH_REL = "agents/slack-director-refresh.md"
const REFRESH = [...BASELINE, ...declaredRules(readFileSync(join(ROOT, REFRESH_REL), "utf8"), REFRESH_REL), ...TRAILING]

/** The effect a tool resolves to under one agent's rules, with `*` as the usual resource. */
const effectUnder = (rules, action, resource = "*") => resolve(rules, action, resource)

test("the refresh agent allows only the Slack search tool", () => {
  for (const server of SERVERS) {
    assert.equal(
      effectUnder(REFRESH, `${server}_slack_search_public_and_private`),
      "allow",
      `${server}'s search tool is allowed`,
    )
    for (const action of [
      `${server}_slack_read_channel`,
      `${server}_slack_list_channels`,
      `${server}_slack_send_message`,
      `${server}_slack_search_messages`,
    ]) {
      assert.equal(effectUnder(REFRESH, action), "deny", `${action} is refused`)
    }
  }
  for (const action of ["read", "edit", "write", "shell", "skill", "sparta_exec", "subagent", "external_directory"]) {
    assert.equal(effectUnder(REFRESH, action, "*"), "deny", `${action} is refused`)
  }
})
