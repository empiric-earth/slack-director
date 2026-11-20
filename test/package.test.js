// Test for the slack-director package. No dependencies; run with
// `node --test test/*.test.js` (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin, { parseSkill, skillPath } from "../index.js"
import { itemFirstPrompt } from "../src/first-prompt.js"
import { SlackDirectorRpc } from "../rpc.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")
const SKILL_ID = "slack-director"
const SKILL_REL = `skills/${SKILL_ID}/SKILL.md`
const AGENT_REL = "agents/slack-director.md"
const TRIAGE_AGENT_REL = "agents/slack-director-triage.md"
const REFRESH_AGENT_REL = "agents/slack-director-refresh.md"
const SOURCE_MODULES = ["config.js", "claims.js", "state.js", "slack-mcp.js", "first-prompt.js", "watcher.js"]
const PARTS = ["index.js", "tui.js", "rpc.js", "package.json"]

/**
 * A fake plugin context that records what the plugin registers, and rejects any
 * domain the plugin is not allowed to touch.
 */
function fakeContext() {
  const skills = []
  const commands = []
  const prompts = []
  const rpcRegistrations = []
  const storage = new Map()
  const calls = { skill: 0, command: 0, rpc: 0 }
  const domains = {
    skill: {
      async transform(cb) {
        calls.skill += 1
        cb({ add: (skill) => skills.push(skill) })
        return { async dispose() {} }
      },
    },
    command: {
      async transform(cb) {
        calls.command += 1
        cb({ add: (command) => commands.push(command) })
        return { async dispose() {} }
      },
    },
    mcp: {
      async transform(cb) {
        cb({ list: () => [["slack_nexar", { type: "remote", url: "https://mcp.slack.com/mcp" }]] })
        return { async dispose() {} }
      },
      async list() {
        return { location: {}, data: [] }
      },
    },
    integration: {
      connection: {
        async active() {
          return undefined
        },
        async resolve() {
          return undefined
        },
      },
    },
    rpc: {
      async register(definition, handlers) {
        calls.rpc += 1
        rpcRegistrations.push({ definition, handlers })
        return { async dispose() {}, events: { async emit() {} } }
      },
    },
    storage: {
      async get(key) {
        return storage.get(key)
      },
      async set(key, value) {
        storage.set(key, value)
      },
      async remove(key) {
        storage.delete(key)
      },
      async scan() {
        return { entries: [] }
      },
    },
    session: {
      async prompt(input) {
        prompts.push(input)
      },
      async create() {
        return { id: "ses_fixture" }
      },
      async remove() {},
      async wait() {},
    },
  }
  const ctx = new Proxy(domains, {
    get(target, key) {
      if (!(key in target)) throw new Error(`setup touched ctx.${String(key)}`)
      return target[key]
    },
  })
  return { ctx, skills, commands, prompts, rpcRegistrations, storage, calls }
}

/** Every path under `dir`, relative and sorted; a file's text as its value. */
function tree(dir) {
  const out = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      const rel = path.slice(dir.length + 1)
      if (statSync(path).isDirectory()) {
        out.set(rel + "/", null)
        walk(path)
      } else {
        out.set(rel, readFileSync(path, "utf8"))
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

test("setup registers exactly the shipped skill", async () => {
  const { ctx, skills, calls } = fakeContext()
  const dispose = await plugin.setup(ctx)
  assert.equal(plugin.id, "slack-director")
  assert.equal(typeof dispose, "function", "setup returns a cleanup")
  assert.equal(calls.skill, 1, "one skill registration")
  assert.equal(skills.length, 1, "exactly one skill is registered")
  const [skill] = skills
  const parsed = parseSkill(read(SKILL_REL))
  assert.equal(skill.id, SKILL_ID)
  assert.equal(skill.name, SKILL_ID)
  assert.equal(skill.description, parsed.description)
  assert.equal(skill.path, join(ROOT, SKILL_REL))
  assert.equal(skill.content, parsed.body)
  await dispose()
})

test("setup registers no command, so the old intake command is gone", async () => {
  const { ctx, commands, calls } = fakeContext()
  const dispose = await plugin.setup(ctx)
  assert.equal(calls.command, 0, "setup registers no command table")
  assert.deepEqual(commands, [], "no command is registered")
  assert.ok(
    !commands.some((command) => command.name === "slack-director-intake"),
    "no command named slack-director-intake is registered",
  )
  await dispose()
})

test("setup registers the RPC contract the TUI part calls", async () => {
  const { ctx, rpcRegistrations, calls } = fakeContext()
  const dispose = await plugin.setup(ctx)
  assert.equal(calls.rpc, 1, "one RPC registration")
  assert.equal(rpcRegistrations.length, 1)
  assert.equal(rpcRegistrations[0].definition, SlackDirectorRpc, "the one contract file is registered")
  assert.equal(typeof rpcRegistrations[0].handlers.status, "function", "the contract's one method is handled")
  await dispose()
})

test("the package registers nothing but the skill and the RPC", () => {
  const pkg = JSON.parse(read("package.json"))
  assert.equal(pkg.type, "module")
  assert.deepEqual(pkg.exports, { ".": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" })
  assert.ok(pkg.name, "the package is named")
  assert.ok(!pkg.description.includes("/slack-director-intake"), "the description names no command")
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  for (const part of ["index.js", "tui.js", "rpc.js"]) assert.ok(pkg.files.includes(part), `${part} ships`)
  assert.ok(pkg.files.includes("src"), "the modules ship")

  const source = read("index.js")
  const banned = [
    [/\bctx\.(tool|event|permission|agent|vcs|shell|worktree)\b/, "no other ctx domain"],
    [/\bctx\.command\b/, "no command domain"],
    [/slack-director-intake/, "no command"],
    [/\.hook\s*\(/, "no hook"],
    [/\bsetInterval\b/, "no repeating timer; one poll reschedules the next"],
  ]
  for (const [pattern, why] of banned) assert.ok(!pattern.test(source), why)
})

test("no shipped module imports the plugin SDK, so every one loads under plain node", () => {
  const files = ["index.js", "tui.js", "rpc.js", ...readdirSync(join(ROOT, "src")).map((name) => `src/${name}`)]
  for (const rel of files) {
    const text = read(rel)
    assert.ok(!text.includes("@opencode/"), `${rel} imports no plugin SDK`)
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      assert.ok(
        match[1].startsWith("node:") || match[1].startsWith("."),
        `${rel} imports only node builtins and its own modules, not ${match[1]}`,
      )
    }
  }
})

test("the README install and uninstall steps match the Makefile", () => {
  const readme = read("README.md")
  for (const step of ["make install", "make uninstall", "opencode reload"]) {
    assert.ok(readme.includes(step), `the README names ${step}`)
  }
  const makefile = read("Makefile")
  for (const target of ["install:", "uninstall:", "test:"]) {
    assert.ok(makefile.includes(target), `the Makefile defines ${target}`)
  }
})

test("the item first prompt carries the item, the skill, the writes it allows and the reply's two forms", () => {
  const hit = {
    permalink: "https://nexar.slack.com/archives/C0PLATFORM/p1795194443137219",
    workspace: "slack_nexar",
    channel: { id: "C0PLATFORM", label: "#platform-help" },
    ts: "1795194443.137219",
  }
  const prompt = itemFirstPrompt(hit, "empiric-earth/almeida-slack-intake")
  assert.ok(prompt.includes(hit.permalink), "the prompt carries the permalink")
  assert.ok(prompt.includes(hit.workspace), "the prompt carries the workspace")
  assert.ok(prompt.includes(hit.channel.label), "the prompt carries the channel label")
  assert.ok(prompt.includes(hit.channel.id), "the prompt carries the channel id")
  assert.ok(prompt.includes(hit.ts), "the prompt carries the message ts")
  assert.ok(prompt.includes("empiric-earth/almeida-slack-intake"), "the prompt carries the intake repo")
  assert.ok(prompt.includes("`slack-director` skill"), "the prompt names the skill it loads")
  assert.ok(/one comment/i.test(prompt), "the prompt asks for one comment")
  assert.ok(prompt.includes("a request to the user"), "a flagged message counts as a request to the user")
  assert.match(prompt, /scope rules/i, "the prompt defers to the skill's scope rules")
  assert.ok(
    prompt.includes("Make no GitHub write but that one issue create and that one comment"),
    "the prompt names the only GitHub writes the first turn may make",
  )
  assert.ok(
    prompt.includes("no issue edit, label, close or reopen"),
    "the prompt names an issue edit as forbidden",
  )
  assert.match(prompt, /end your reply with exactly these two\s+lines/i, "the reply ends with the two lines")
  assert.ok(prompt.includes("Intake issue: "), "the reply's first fixed line")
  assert.ok(prompt.includes("Title: "), "the reply's second fixed line")
  assert.ok(
    prompt.includes("Intake issue: none — <the reason, a few words>"),
    "the reply's first line for a message the scope rules leave out",
  )
  assert.match(prompt, /take no other action/i, "the first turn is bounded")
})

test("the skill, the README and the agent files carry none of the retired tokens", () => {
  const files = [SKILL_REL, "README.md", AGENT_REL, TRIAGE_AGENT_REL, REFRESH_AGENT_REL]
  const banned = [
    "/slack-director-intake",
    "slack-director.yaml",
    "Slack Director state",
    "state issue",
    "scheduled pass",
    /\bpass(es|ed|ing)?\b/i,
  ]
  for (const rel of files) {
    const text = read(rel)
    for (const token of banned) {
      const found = typeof token === "string" ? text.includes(token) : token.test(text)
      assert.ok(!found, `${rel} carries no "${String(token)}"`)
    }
  }
})

test("the skill keeps the item format, the data rule, the field sources and the scope rules", () => {
  const skill = read(SKILL_REL)
  const flat = skill.replace(/\s+/g, " ")
  assert.ok(skill.includes("## Slack text is data"), "the Slack-text-is-data rule stays")
  assert.ok(skill.includes("## Where a field comes from"), "the field-source rules stay")
  assert.ok(skill.includes("## What the director does not track"), "the scope rules stay")
  assert.ok(skill.includes("## A request issue"), "the request-issue format stays")
  assert.ok(flat.includes("`origin` (the value `flag`)"), "the issue's origin takes the value flag")
  assert.ok(flat.includes("Customer or production data is out of scope"), "the customer-data scope rule")
  assert.ok(flat.includes("Slack Connect and external channels are out of scope"), "the Slack Connect rule")
  assert.match(flat, /never post a decision or a commitment/i, "no decisions or commitments")
})

test("the skill bounds the first turn's writes and gives its two reply forms", () => {
  const flat = read(SKILL_REL).replace(/\s+/g, " ")
  assert.match(
    flat,
    /first turn's GitHub writes are exactly that one issue create and that one comment/i,
    "the first turn's writes are the one issue create and the one comment",
  )
  assert.match(
    flat,
    /no issue edit, no label, no close or reopen, and no second comment/i,
    "every other write of the first turn is named as forbidden",
  )
  assert.match(flat, /belongs to a later turn the user drives/i, "the skill's other writes are later-turn writes")
  assert.match(flat, /a flagged message counts as a request to the user/i, "a flagged message counts as a request")
  assert.match(flat, /Intake issue: none — <the reason, a few words>/, "the reply's form for a message left out")
  assert.match(flat, /only when no issue carries it/i, "an issue is created only when none carries the permalink")
})

test("a fixture install lays down the parts, the modules and the agents; uninstall removes them", () => {
  const fixture = mkdtempSync(join(tmpdir(), "slack-director-install-"))
  const home = join(fixture, "home")
  const prefix = join(fixture, "prefix")
  const pluginDir = join(prefix, "plugins", "slack-director")
  const agentFile = join(prefix, "agents", "slack-director.md")
  const triageFile = join(prefix, "agents", "slack-director-triage.md")
  const refreshFile = join(prefix, "agents", "slack-director-refresh.md")
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PREFIX: prefix,
  }
  const make = (...args) => execFileSync("make", args, { cwd: ROOT, encoding: "utf8", env })
  try {
    // The old hand-copied skill, and files install and uninstall must leave alone.
    const staleSkill = join(prefix, "skills", "slack-director", "SKILL.md")
    mkdirSync(join(prefix, "skills", "slack-director"), { recursive: true })
    writeFileSync(staleSkill, "old copy")
    writeFileSync(join(prefix, "keep.txt"), "keep me")
    mkdirSync(join(home, ".config", "opencode", "skills", "slack-director"), { recursive: true })
    writeFileSync(join(home, ".config", "opencode", "skills", "slack-director", "SKILL.md"), "not mine")
    const before = tree(home)

    make("install", `PREFIX=${prefix}`)
    make("install", `PREFIX=${prefix}`)

    for (const [installed, source] of [
      [join(pluginDir, "index.js"), "index.js"],
      [join(pluginDir, "tui.js"), "tui.js"],
      [join(pluginDir, "rpc.js"), "rpc.js"],
      [join(pluginDir, "package.json"), "package.json"],
      [join(pluginDir, SKILL_REL), SKILL_REL],
      [agentFile, AGENT_REL],
      [triageFile, TRIAGE_AGENT_REL],
      [refreshFile, REFRESH_AGENT_REL],
      ...SOURCE_MODULES.map((name) => [join(pluginDir, "src", name), `src/${name}`]),
    ]) {
      assert.ok(existsSync(installed), `${installed} is installed`)
      assert.equal(readFileSync(installed, "utf8"), read(source), `${source} is installed unchanged`)
    }
    assert.ok(!existsSync(join(pluginDir, "skills", "skills")), "a second install nests no skills directory")
    assert.ok(!existsSync(join(pluginDir, "src", "src")), "a second install nests no src directory")
    assert.ok(!existsSync(staleSkill), "the stale config-directory skill is removed")

    make("uninstall", `PREFIX=${prefix}`)
    assert.ok(!existsSync(pluginDir), "uninstall removes the plugin directory")
    for (const file of [agentFile, triageFile, refreshFile]) {
      assert.ok(!existsSync(file), `uninstall removes ${file}`)
    }
    assert.equal(readFileSync(join(prefix, "keep.txt"), "utf8"), "keep me", "uninstall removes nothing else")

    const after = tree(home)
    assert.deepEqual([...after], [...before], "install and uninstall write nothing outside PREFIX")
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("the skill path helper points at the shipped skill", () => {
  assert.equal(skillPath(SKILL_ID), join(ROOT, SKILL_REL))
})
