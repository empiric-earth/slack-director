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

/** A rule's value: a double-quoted YAML scalar is unquoted, `\"` unescaped. */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return trimmed
}

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
    const field = /^(resource|effect):[ \t]*(.*)$/.exec(line)
    const rule = rules.at(-1)
    assert.ok(field && rule, `${rel}: a rule field follows its rule, got: ${line}`)
    rule[field[1]] = unquote(field[2])
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
  assert.equal(effect("skill", "example-slack-helper"), "allow", "the user's Slack skills are loadable")
  assert.equal(effect("skill", "my-slack-director"), "allow", "the customization hook is loadable")
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

// A baseline shaped like a user's rules where the shell asks by default, so a
// shell command proceeds without a prompt only through a rule of the agent
// file. The session-opening fixture uses this shape.
const SHELL_ASKS = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "ask" },
]
const RESOLVED_ASKING = [...SHELL_ASKS, ...FILE_RULES, ...TRAILING]
const effectAsking = (action, resource = "*") => resolve(RESOLVED_ASKING, action, resource)

const CREATE_COMMAND =
  `opencode api post /api/session -d "$(jq -c '{id: .id, agent: .agent, title: .title, location: {directory: .location.directory}}' open-session-create.json)"`
const PROMPT_COMMAND = (id) =>
  `opencode api post /api/session/${id}/prompt -d "$(jq -c '{id: .id, text: .text}' open-session-prompt.json)"`

test("the director opens a work session with exactly two pinned shell commands and nothing else", () => {
  assert.equal(effectAsking("shell", CREATE_COMMAND), "allow", "the pinned create command proceeds without a prompt")
  assert.equal(
    effectAsking("shell", PROMPT_COMMAND("ses_x")),
    "allow",
    "the pinned prompt command proceeds without a prompt",
  )
  assert.equal(
    effectAsking("external_directory", "/tmp/other"),
    "deny",
    "work outside the session directory is still refused",
  )

  // A body that comes another way, or any other API call, matches no rule of
  // the agent file: the allow is exactly the two pinned commands.
  const refused = [
    `opencode api post /api/session -d "$(cat open-session-create.json)"`,
    `opencode api post /api/session -d '{"id":"ses_x","agent":"build","title":"t","location":{"directory":"/tmp"}}'`,
    `opencode api post /api/session -d "$(jq -c '. + {}' open-session-create.json)"`,
    `opencode api post /api/session -d "$(jq -c '{id: .id, agent: .agent, title: .title, location: {directory: .location.directory}}' other.json)"`,
    `${CREATE_COMMAND} extra`,
    `opencode api post /api/session/ses_x/prompt -d "$(cat open-session-prompt.json)"`,
    `opencode api post /api/session/ses_x/prompt -d "$(jq -c '{id: .id, text: .text, files: .files}' open-session-prompt.json)"`,
    `opencode api get /api/session`,
    `opencode api delete /api/session/ses_x`,
    `opencode api post /api/session/ses_x/interrupt -d {}`,
    `opencode api post /api/session/ses_x/agent -d {}`,
    `opencode api post /api/session/ses_x/fork -d {}`,
    `cat open-session-create.json`,
    `jq -c '{id: .id, text: .text}' open-session-prompt.json`,
    `rm open-session-create.json`,
    `rm open-session-prompt.json`,
  ]
  for (const command of refused) {
    assert.notEqual(effectAsking("shell", command), "allow", `${command} is not allowed by the agent file`)
    assert.ok(
      !FILE_RULES.some((rule) => matches(rule.action, "shell") && matches(rule.resource, command)),
      `no rule of ${AGENT_REL} matches ${command}`,
    )
  }
})

test("the agent file denies no opencode api call, so the README claims no block it does not enforce", () => {
  for (const command of ["opencode api get /api/session", "opencode api delete /api/session/ses_x", CREATE_COMMAND]) {
    const denies = FILE_RULES.filter(
      (rule) => rule.effect === "deny" && matches(rule.action, "shell") && matches(rule.resource, command),
    )
    assert.equal(denies.length, 0, `${AGENT_REL} denies no part of ${command}`)
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
