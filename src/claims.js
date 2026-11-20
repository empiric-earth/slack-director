// The claim files that decide who may start a session for one flagged message.
//
// Plugin storage offers get and set and no compare-and-set, so the decision is
// made with files that can be created only once: a claim file per generation,
// created with Node's exclusive-create flag, and one commit file per permalink,
// hard-linked into place from a complete temporary file. Several plugin
// instances share the one directory, so a stale claim is recovered only by
// exclusively creating the next generation, and only the instance whose link
// creates the commit file may prompt the session it created.
import { createHash, randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import { join } from "node:path"

/** A claim or a temporary file older than this may be taken over or removed. */
export const STALE_MS = 10 * 60 * 1000

/** The file name stem of one permalink. */
export function permalinkHash(permalink) {
  return createHash("sha256").update(permalink).digest("hex")
}

export function createClaims({ dir, fs = nodeFs, now = Date.now, randomID = randomUUID, staleMs = STALE_MS }) {
  const path = (name) => join(dir, name)
  const claimPath = (hash, generation) => path(`${hash}.claim.${generation}`)
  const commitPath = (hash) => path(`${hash}.session`)
  const tempPath = (hash) => path(`${hash}.${randomID()}.tmp`)

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true })

  function stat(file) {
    try {
      return fs.statSync(file)
    } catch {
      return undefined
    }
  }

  function writeExclusive(file, text) {
    try {
      fs.writeFileSync(file, text, { flag: "wx" })
      return true
    } catch (error) {
      if (error?.code === "EEXIST") return false
      throw error
    }
  }

  function names() {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }

  function generations(hash) {
    const prefix = `${hash}.claim.`
    return names()
      .filter((name) => name.startsWith(prefix))
      .map((name) => Number(name.slice(prefix.length)))
      .filter((value) => Number.isInteger(value) && value >= 0)
      .sort((a, b) => a - b)
  }

  /**
   * Claim the right to start a session for `hash`: generation 0 for a fresh
   * permalink, else the next generation when the highest one is stale and no
   * commit file exists. Returns the generation this call created, or null when
   * another instance holds the claim.
   */
  function claim(hash) {
    ensureDir()
    const claimedAt = String(now())
    if (writeExclusive(claimPath(hash, 0), claimedAt)) return 0
    const highest = generations(hash).at(-1)
    if (highest === undefined) return null
    const info = stat(claimPath(hash, highest))
    if (!info) return null
    if (now() - info.mtimeMs <= staleMs) return null
    if (stat(commitPath(hash))) return null
    const next = highest + 1
    return writeExclusive(claimPath(hash, next), claimedAt) ? next : null
  }

  /** Drop a claim generation this instance created, so the next poll retries. */
  function removeClaim(hash, generation) {
    fs.rmSync(claimPath(hash, generation), { force: true })
  }

  /**
   * Write the commit file for `hash` from a complete temporary file. Returns
   * true for the one instance whose link created it; every other instance gets
   * false and must remove the session it created.
   */
  async function commit(hash, record) {
    ensureDir()
    const temp = tempPath(hash)
    fs.writeFileSync(temp, JSON.stringify(record))
    try {
      fs.linkSync(temp, commitPath(hash))
    } catch (error) {
      fs.rmSync(temp, { force: true })
      if (error?.code === "EEXIST") return false
      throw error
    }
    fs.rmSync(temp, { force: true })
    return true
  }

  /** Every commit file, with its age and the record it holds. */
  function listCommits() {
    const commits = []
    for (const name of names()) {
      if (!name.endsWith(".session")) continue
      const file = path(name)
      const info = stat(file)
      if (!info) continue
      let record
      try {
        record = JSON.parse(fs.readFileSync(file, "utf8"))
      } catch {
        continue
      }
      commits.push({ file, mtimeMs: info.mtimeMs, record })
    }
    return commits
  }

  /** Remove temporary files older than the stale age. */
  function removeStaleTemporaries() {
    for (const name of names()) {
      if (!name.endsWith(".tmp")) continue
      const file = path(name)
      const info = stat(file)
      if (info && now() - info.mtimeMs > staleMs) fs.rmSync(file, { force: true })
    }
  }

  return { claim, removeClaim, commit, listCommits, removeStaleTemporaries, dir }
}
