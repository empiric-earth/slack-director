// The config file and the work window.
//
// The config reader is driven over a real file in a temporary directory, and a
// watcher over it with no Slack server and no session, so a change to the
// interval is read the way the running plugin reads it. No dependencies; run
// with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  configPath,
  createConfigReader,
  defaultConfig,
  FIELD_NAMES,
  fieldProblem,
  parseConfig,
  REQUIRED_FIELDS,
} from "../src/config.js"
import { createWatcher } from "../src/watcher.js"
import { defaultWorkHours, inWorkHours, machineTimeZone, validateWorkHours } from "../src/work-hours.js"

// A Wednesday at noon UTC, inside every window these tests set.
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const REQUIRED = { intake_repo: "empiric-earth/almeida-slack-intake", session_directory: "/home/someone/notes" }
const WINDOW = { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "18:00", time_zone: "UTC" }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slack-director-config-"))
  const env = { XDG_CONFIG_HOME: join(root, "config") }
  const path = configPath(env)
  mkdirSync(dirname(path), { recursive: true })
  return { root, env, path, clean: () => rmSync(root, { recursive: true, force: true }) }
}

/** A watcher over one config file, with no Slack server and no session to keep. */
function watcherOver(reader) {
  const clock = { ms: NOW }
  const storage = new Map()
  return {
    clock,
    watcher: createWatcher({
      storage: {
        async get(key) {
          return storage.has(key) ? structuredClone(storage.get(key)) : undefined
        },
        async set(key, value) {
          storage.set(key, structuredClone(value))
        },
        async remove(key) {
          storage.delete(key)
        },
      },
      claims: {
        claim: () => null,
        removeClaim() {},
        commit: async () => false,
        listCommits: () => [],
        removeStaleTemporaries() {},
      },
      now: () => clock.ms,
      fetch: async () => {
        throw new Error("no Slack call is expected")
      },
      readConfig: () => reader.read(),
      writeConfig: (field, value) => reader.write(field, value),
      mcpServers: async () => [],
      resolveCredential: async () => undefined,
      session: {
        async create() {
          return { id: "ses_1" }
        },
        async prompt() {},
        async remove() {},
        async update() {},
        async context() {
          return []
        },
      },
      log: () => {},
    }),
  }
}

test("every field takes its default when the file omits it", () => {
  const { config, error } = parseConfig(JSON.stringify(REQUIRED))
  assert.equal(error, undefined)
  assert.deepEqual(Object.keys(config).sort(), [...FIELD_NAMES].sort(), "the config carries every field and no other")
  assert.equal(config.flag_emoji, "oc")
  assert.equal(config.poll_seconds, 60)
  assert.equal(config.triage_agent, "slack-director-triage")
  assert.deepEqual(config.work_hours, defaultWorkHours(), "the window is the documented default")
  assert.equal(config.intake_repo, REQUIRED.intake_repo)
  assert.equal(config.session_directory, REQUIRED.session_directory)

  const defaults = defaultConfig()
  assert.deepEqual(defaults.work_hours.days, ["Mon", "Tue", "Wed", "Thu", "Fri"])
  assert.equal(defaults.work_hours.start, "09:00")
  assert.equal(defaults.work_hours.end, "18:00")
  assert.equal(defaults.work_hours.time_zone, machineTimeZone(), "the default window is in this machine's own zone")
  for (const field of REQUIRED_FIELDS) assert.equal(defaults[field], "", `${field} has no default`)
})

test("a field the file gets wrong is named, and the last good config stays in use", () => {
  const fx = fixture()
  try {
    const reader = createConfigReader({ env: fx.env })
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, ...{ poll_seconds: 60, work_hours: WINDOW } }))
    const good = reader.read()
    assert.equal(good.error, undefined)
    assert.equal(good.config.poll_seconds, 60)

    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: "soon", work_hours: WINDOW }))
    const bad = reader.read()
    assert.equal(bad.error, "config field invalid: poll_seconds", "the error names the field")
    assert.equal(bad.config.poll_seconds, 60, "the last good config is kept")

    writeFileSync(fx.path, JSON.stringify({ intake_repo: REQUIRED.intake_repo, work_hours: WINDOW }))
    assert.equal(reader.read().error, "config field missing: session_directory")

    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, work_hours: { ...WINDOW, days: ["Funday"] } }))
    assert.equal(reader.read().error, "config field invalid: work_hours.days")

    writeFileSync(fx.path, "not json at all")
    assert.equal(reader.read().error, "config file is not JSON")
    assert.equal(reader.read().config.poll_seconds, 60, "the last good config survives an unreadable file too")
  } finally {
    fx.clean()
  }
})

test("setConfig refuses a value of the wrong type and leaves the file unchanged", () => {
  const fx = fixture()
  try {
    const reader = createConfigReader({ env: fx.env })
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: 60, work_hours: WINDOW }))
    const before = readFileSync(fx.path, "utf8")

    assert.deepEqual(reader.write("poll_seconds", "soon"), {
      error: { field: "poll_seconds", message: "config field invalid: poll_seconds" },
    })
    assert.equal(readFileSync(fx.path, "utf8"), before, "the refused write left the file alone")
    assert.deepEqual(reader.write("session_directory", "relative/path"), {
      error: { field: "session_directory", message: "config field invalid: session_directory" },
    })
    assert.equal(readFileSync(fx.path, "utf8"), before)
    assert.equal(reader.write("not_a_field", 1).error.field, null, "a field that does not exist has no name")

    const written = reader.write("poll_seconds", 5)
    assert.equal(written.config.poll_seconds, 5)
    const stored = JSON.parse(readFileSync(fx.path, "utf8"))
    assert.equal(stored.poll_seconds, 5)
    assert.equal(stored.intake_repo, REQUIRED.intake_repo, "the other fields survive the write")
    assert.equal(reader.read().config.poll_seconds, 5, "the next read sees the new value")
  } finally {
    fx.clean()
  }
})

test("a change to the poll interval takes effect at the next poll, with no restart", async () => {
  const fx = fixture()
  try {
    const reader = createConfigReader({ env: fx.env })
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: 60, work_hours: WINDOW }))
    const { watcher, clock } = watcherOver(reader)
    const first = await watcher.poll()
    assert.equal(first.pollSeconds, 60)
    assert.equal(first.status.lastPoll, new Date(clock.ms).toISOString(), "the first poll ran")
    clock.ms += 60_000
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: 15, work_hours: WINDOW }))
    const second = await watcher.poll()
    assert.equal(second.pollSeconds, 15, "the new interval is read without a restart")
    assert.equal(second.status.lastPoll, new Date(clock.ms).toISOString(), "the tick that read the new interval ran")
    // The next tick comes one new interval later, not one old lease later: the
    // instance's own lease from the poll just run must not skip it.
    clock.ms += 15_000
    const third = await watcher.poll()
    assert.equal(third.pollSeconds, 15)
    assert.equal(third.status.lastPoll, new Date(clock.ms).toISOString(), "the next tick at the shorter interval ran")
  } finally {
    fx.clean()
  }
})

test("an invalid field keeps the poll running and names itself in the status", async () => {
  const fx = fixture()
  try {
    const reader = createConfigReader({ env: fx.env })
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: 60, work_hours: WINDOW }))
    const { watcher, clock } = watcherOver(reader)
    assert.equal((await watcher.poll()).status.configError, null)
    clock.ms += 60_000
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: "soon", work_hours: WINDOW }))
    const result = await watcher.poll()
    assert.equal(result.status.configError, "config field invalid: poll_seconds")
    assert.equal(result.status.outcome, "config field invalid: poll_seconds", "the status names the field")
    assert.equal(result.pollSeconds, 60, "the last good interval is still in use")
  } finally {
    fx.clean()
  }
})

test("an invalid field is named in the status even outside the work window", async () => {
  const fx = fixture()
  try {
    const reader = createConfigReader({ env: fx.env })
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: 60, work_hours: WINDOW }))
    const { watcher, clock } = watcherOver(reader)
    const good = await watcher.poll()
    assert.equal(good.status.outcome, "ok")
    assert.equal(good.status.configError, null)

    // After hours no scan runs, but the file's own state still reaches the
    // status: an unusable field is named there rather than hidden until the
    // next working day.
    clock.ms = Date.UTC(2026, 10, 18, 20, 0)
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: "soon", work_hours: WINDOW }))
    const bad = await watcher.poll()
    assert.equal(bad.status.configError, "config field invalid: poll_seconds", "the bad field is named after hours")
    assert.equal(bad.status.outcome, "config field invalid: poll_seconds")
    assert.equal(bad.pollSeconds, 60, "the last good interval is still in use")

    // Fixing the file clears the name, still with no scan.
    writeFileSync(fx.path, JSON.stringify({ ...REQUIRED, poll_seconds: 60, work_hours: WINDOW }))
    const fixed = await watcher.poll()
    assert.equal(fixed.status.configError, null, "the fixed file clears the name")
    assert.equal(fixed.status.outcome, "ok")
  } finally {
    fx.clean()
  }
})

test("a config that cannot be read at all polls nothing and names it", async () => {
  const fx = fixture()
  try {
    const reader = createConfigReader({ env: fx.env })
    const { watcher } = watcherOver(reader)
    const missing = await watcher.poll()
    assert.match(missing.status.configError, /^config file not readable: /)
    assert.deepEqual(missing.status.workspaces, [], "no workspace is scanned")
    assert.equal(missing.status.lastPoll, null, "no poll is recorded")

    writeFileSync(fx.path, JSON.stringify({ poll_seconds: 5 }))
    const incomplete = await watcher.poll()
    assert.equal(incomplete.status.configError, "config field missing: intake_repo")
  } finally {
    fx.clean()
  }
})

test("a window is read in its own time zone and on its own days", () => {
  const at = (hour, minute, day = 18) => Date.UTC(2026, 10, day, hour, minute)
  assert.equal(inWorkHours(WINDOW, at(8, 59)), false, "a minute before the start")
  assert.equal(inWorkHours(WINDOW, at(9, 0)), true, "the start itself")
  assert.equal(inWorkHours(WINDOW, at(17, 59)), true, "the last minute")
  assert.equal(inWorkHours(WINDOW, at(18, 0)), false, "the end itself")
  assert.equal(inWorkHours(WINDOW, at(12, 0, 21)), false, "a Saturday")

  const tokyo = { ...WINDOW, time_zone: "Asia/Tokyo" }
  assert.equal(inWorkHours(tokyo, at(0, 0)), true, "09:00 in Tokyo is midnight UTC")
  assert.equal(inWorkHours(tokyo, at(9, 0)), false, "18:00 in Tokyo is past the end")
})

test("a window the config cannot use is named by the field it breaks", () => {
  assert.equal(validateWorkHours(WINDOW), undefined)
  assert.equal(validateWorkHours(null), "config field invalid: work_hours")
  assert.equal(validateWorkHours({ ...WINDOW, days: [] }), "config field invalid: work_hours.days")
  assert.equal(validateWorkHours({ ...WINDOW, start: "9:00" }), "config field invalid: work_hours.start")
  assert.equal(validateWorkHours({ ...WINDOW, end: "25:00" }), "config field invalid: work_hours.end")
  assert.equal(validateWorkHours({ ...WINDOW, end: "08:00" }), "config field invalid: work_hours.end")
  assert.equal(validateWorkHours({ ...WINDOW, time_zone: "Mars/Olympus" }), "config field invalid: work_hours.time_zone")
  assert.equal(fieldProblem("work_hours", { ...WINDOW, days: ["Funday"] }), "config field invalid: work_hours.days")
  assert.equal(fieldProblem("flag_emoji", ":oc:"), "config field invalid: flag_emoji")
  assert.equal(fieldProblem("poll_seconds", 0), "config field invalid: poll_seconds")
  assert.equal(fieldProblem("poll_seconds", 60), undefined)
})
