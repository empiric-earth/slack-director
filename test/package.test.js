// Test for the slack-director package. No dependencies; run with
// `node --test test/*.test.js` (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin, { COMMANDS, parseSkill, skillPath } from "../index.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")
const SKILL_ID = "slack-director"
const SKILL_REL = `skills/${SKILL_ID}/SKILL.md`
const AGENT_REL = "agents/slack-director.md"

/**
 * A fake plugin context that records what the plugin registers, and rejects any
 * domain the plugin is not allowed to touch.
 */
function fakeContext() {
  const skills = []
  const commands = []
  const prompts = []
  const calls = { skill: 0, command: 0 }
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
    session: {
      async prompt(input) {
        prompts.push(input)
      },
    },
  }
  const ctx = new Proxy(domains, {
    get(target, key) {
      if (!(key in target)) throw new Error(`setup touched ctx.${String(key)}`)
      return target[key]
    },
  })
  return { ctx, skills, commands, prompts, calls }
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
})

test("setup registers the command table, and the command prompts its session", async () => {
  const { ctx, commands, prompts, calls } = fakeContext()
  await plugin.setup(ctx)
  assert.equal(calls.command, 1, "one command registration")
  assert.deepEqual(
    commands.map((c) => c.name).sort(),
    Object.keys(COMMANDS).sort(),
    "the registered commands are the table's rows",
  )
  assert.equal(commands.length, 1)
  const [command] = commands
  assert.deepEqual(Object.keys(COMMANDS), ["slack-director-intake"])
  assert.equal(COMMANDS["slack-director-intake"].prompt, "run one Slack Director pass")
  assert.equal(command.description, COMMANDS["slack-director-intake"].description)
  await command.execute({ sessionID: "ses_fixture", prompt: { text: "" }, delivery: "steer" })
  assert.deepEqual(prompts, [
    { sessionID: "ses_fixture", text: "run one Slack Director pass", delivery: "steer" },
  ])
})

test("the package registers nothing but the skill and its commands", () => {
  const pkg = JSON.parse(read("package.json"))
  assert.equal(pkg.type, "module")
  assert.deepEqual(pkg.exports, { ".": "./index.js" })
  assert.ok(pkg.name, "the package is named")
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)

  const source = read("index.js")
  const banned = [
    [/\bctx\.(tool|event|permission|agent|vcs|shell|mcp|storage|worktree|rpc|integration)\b/, "no other ctx domain"],
    [/\.hook\s*\(/, "no hook"],
    [/\bset(Interval|Timeout|Immediate)\b/, "no timer"],
  ]
  for (const [pattern, why] of banned) assert.ok(!pattern.test(source), why)
})

test("the README install and uninstall steps match the Makefile", () => {
  const readme = read("README.md")
  for (const step of ["make install", "make uninstall", "opencode reload", "/slack-director-intake"]) {
    assert.ok(readme.includes(step), `the README names ${step}`)
  }
  const makefile = read("Makefile")
  for (const target of ["install:", "uninstall:", "test:"]) {
    assert.ok(makefile.includes(target), `the Makefile defines ${target}`)
  }
})

test("a fixture install lays down the package and removes the stale skill; uninstall removes it", () => {
  const fixture = mkdtempSync(join(tmpdir(), "slack-director-install-"))
  const home = join(fixture, "home")
  const prefix = join(fixture, "prefix")
  const pluginDir = join(prefix, "plugins", "slack-director")
  const agentFile = join(prefix, "agents", "slack-director.md")
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
      [join(pluginDir, "package.json"), "package.json"],
      [join(pluginDir, SKILL_REL), SKILL_REL],
      [agentFile, AGENT_REL],
    ]) {
      assert.ok(existsSync(installed), `${installed} is installed`)
      assert.equal(readFileSync(installed, "utf8"), read(source), `${source} is installed unchanged`)
    }
    assert.ok(!existsSync(join(pluginDir, "skills", "skills")), "a second install nests no skills directory")
    assert.ok(!existsSync(staleSkill), "the stale config-directory skill is removed")

    make("uninstall", `PREFIX=${prefix}`)
    assert.ok(!existsSync(pluginDir), "uninstall removes the plugin directory")
    assert.ok(!existsSync(agentFile), "uninstall removes the agent file")
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
