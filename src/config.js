// The config file: one JSON object in the user's OpenCode config directory.
//
// This module reads it and reports what is missing; the server part polls
// nothing while a required field is absent.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_FLAG_EMOJI = "oc"
export const DEFAULT_POLL_SECONDS = 60
export const DEFAULT_TRIAGE_AGENT = "slack-director-triage"

/** The fields a poll cannot run without. */
export const REQUIRED_FIELDS = ["intake_repo", "session_directory"]

/** The config file's path. */
export function configPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")
  return join(configHome, "opencode", "slack-director", "config.json")
}

const filled = (value) => typeof value === "string" && value.trim() !== ""

/**
 * Read the config file. Returns `{ config }` when it holds every required
 * field, else `{ error }` naming what is missing or unreadable.
 */
export function readConfig({ read = readFileSync, env = process.env } = {}) {
  const path = configPath(env)
  let text
  try {
    text = read(path, "utf8")
  } catch {
    return { error: `config file not readable: ${path}` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: `config file is not JSON: ${path}` }
  }
  if (raw === null || typeof raw !== "object") return { error: `config file is not a JSON object: ${path}` }
  const missing = REQUIRED_FIELDS.filter((field) => !filled(raw[field]))
  if (missing.length > 0) return { error: `config field missing: ${missing.join(", ")}` }
  return {
    config: {
      flag_emoji: filled(raw.flag_emoji) ? raw.flag_emoji.trim() : DEFAULT_FLAG_EMOJI,
      intake_repo: raw.intake_repo.trim(),
      session_directory: raw.session_directory.trim(),
      poll_seconds:
        Number.isInteger(raw.poll_seconds) && raw.poll_seconds > 0 ? raw.poll_seconds : DEFAULT_POLL_SECONDS,
      triage_agent: filled(raw.triage_agent) ? raw.triage_agent.trim() : DEFAULT_TRIAGE_AGENT,
    },
  }
}
