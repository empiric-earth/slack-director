// The state namespace of the server part.
//
// OpenCode's plugin storage is one namespace per plugin id, shared by every
// location, and this plugin's claims files live in one directory under the
// state home. Both sit under the one constant below, so a build that changes
// the state it keeps never reads the previous build's.
import { homedir } from "node:os"
import { join } from "node:path"

/** The namespace every storage key and every claims file sits under. */
export const NAMESPACE = "item"

const key = (name) => `${NAMESPACE}/${name}`

/** The plugin storage keys, each under the namespace. */
export const KEYS = {
  seen: key("seen"),
  lease: key("lease"),
  items: key("items"),
  status: key("status"),
  suspended: key("suspended"),
  today: key("today"),
}

/** The claims directory, one per namespace. */
export function claimsDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state")
  return join(stateHome, "opencode", "slack-director", "claims", NAMESPACE)
}

/** The subdirectory the reissue's own claim and commit files live in. */
export const REISSUE_DIR = "reissue"

/** The reissue directory, beside the claims it belongs to. */
export function reissueDir(env = process.env) {
  return join(claimsDir(env), REISSUE_DIR)
}
