// The config file: one JSON object in the user's OpenCode config directory.
//
// The server part is its only writer. It reads the file when it starts and
// again whenever the file changes, so a hand edit takes effect at the next
// poll; an unreadable file, or a field it cannot use, is named in the status
// and the values it last read stay in use, so a typo never stops a working
// watcher.
//
// The parser reads the fields named below and nothing else, so a field an
// earlier build wrote and this one does not know is ignored rather than
// refused.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { defaultWorkHours, normalizeWorkHours, validateWorkHours } from "./work-hours.js"

export const DEFAULT_POLL_SECONDS = 60
export const DEFAULT_SESSION_AGENT = "slack-director"

/** The fields a poll cannot run without. */
export const REQUIRED_FIELDS = ["intake_repo", "session_directory"]

/** Every field the file may carry, in the order the settings dialog shows them. */
export const FIELD_NAMES = [
  "intake_repo",
  "session_directory",
  "poll_seconds",
  "work_hours",
  "session_agent",
]

/** The config file's path. */
export function configPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")
  return join(configHome, "opencode", "slack-director", "config.json")
}

const filled = (value) => typeof value === "string" && value.trim() !== ""

/** Every field's default, with an empty value where the field has none. */
export function defaultConfig() {
  return {
    intake_repo: "",
    session_directory: "",
    poll_seconds: DEFAULT_POLL_SECONDS,
    work_hours: defaultWorkHours(),
    session_agent: DEFAULT_SESSION_AGENT,
  }
}

/** Why a value is not usable for a field, or undefined. The message names the field. */
export function fieldProblem(field, value) {
  switch (field) {
    case "intake_repo":
      return /^[^/\s]+\/[^/\s]+$/.test(typeof value === "string" ? value.trim() : "")
        ? undefined
        : "config field invalid: intake_repo"
    case "session_directory":
      return typeof value === "string" && value.trim().startsWith("/")
        ? undefined
        : "config field invalid: session_directory"
    case "poll_seconds":
      return Number.isInteger(value) && value > 0 ? undefined : "config field invalid: poll_seconds"
    case "work_hours":
      return validateWorkHours(value)
    case "session_agent":
      return filled(value) ? undefined : "config field invalid: session_agent"
    default:
      return `no config field named ${String(field)}`
  }
}

/** A field's value as the config holds it, once it has passed `fieldProblem`. */
function normalized(field, value) {
  if (field === "work_hours") return normalizeWorkHours(value)
  return typeof value === "string" ? value.trim() : value
}

/**
 * Read a config file's text. Returns `{ config }` with every field filled —
 * an absent field takes its default — or `{ error }` naming the first field the
 * file gets wrong.
 */
export function parseConfig(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: "config file is not JSON" }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "config file is not a JSON object" }
  }
  const config = defaultConfig()
  for (const field of REQUIRED_FIELDS) {
    if (!filled(raw[field])) return { error: `config field missing: ${field}` }
  }
  for (const field of FIELD_NAMES) {
    if (!Object.hasOwn(raw, field)) continue
    const problem = fieldProblem(field, raw[field])
    if (problem) return { error: problem }
    config[field] = normalized(field, raw[field])
  }
  return { config }
}

/** The key that says whether the file changed since the last read. */
function stampOf(stat, path) {
  try {
    const info = stat(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return "absent"
  }
}

/**
 * The config file over time. `read` re-reads it only when its stamp changed and
 * always answers with a whole config: the last good one while the file is
 * wrong. `write` is the server part's only way to change it, and it validates
 * the one field before it touches the file.
 */
export function createConfigReader({
  env = process.env,
  read = readFileSync,
  stat = statSync,
  write = writeFileSync,
  mkdir = mkdirSync,
} = {}) {
  const path = configPath(env)
  let cached = { stamp: null, config: undefined, error: undefined }

  function load() {
    const stamp = stampOf(stat, path)
    if (cached.stamp === stamp) return { config: cached.config, error: cached.error }
    let parsed
    try {
      parsed = parseConfig(read(path, "utf8"))
    } catch {
      parsed = { error: `config file not readable: ${path}` }
    }
    const config = parsed.error ? (cached.config ?? defaultConfig()) : parsed.config
    cached = { stamp, config, error: parsed.error }
    return { config, error: parsed.error }
  }

  function writeField(field, value) {
    if (!FIELD_NAMES.includes(field)) return { error: { field: null, message: `no config field named ${String(field)}` } }
    const problem = fieldProblem(field, value)
    if (problem) return { error: { field, message: problem } }
    let raw = {}
    let text
    try {
      text = read(path, "utf8")
    } catch {
      text = undefined
    }
    if (text !== undefined) {
      try {
        raw = JSON.parse(text)
      } catch {
        return { error: { field: null, message: `config file is not JSON: ${path}` } }
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: { field: null, message: `config file is not a JSON object: ${path}` } }
      }
    }
    const next = { ...raw, [field]: normalized(field, value) }
    mkdir(dirname(path), { recursive: true })
    write(path, `${JSON.stringify(next, null, 2)}\n`)
    // The file just changed under the reader's feet: read it back rather than
    // trust the stamp, which a same-millisecond rewrite can leave unchanged.
    cached = { stamp: null, config: cached.config, error: cached.error }
    const loaded = load()
    if (loaded.error) return { error: { field, message: loaded.error } }
    return { config: loaded.config }
  }

  return { path, read: load, write: writeField }
}
