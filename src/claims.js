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

/** The file name stem of one intake issue: its repo and its number. */
export function issueHash(repo, number) {
  return createHash("sha256").update(`${repo}#${number}`).digest("hex")
}

/**
 * The PID namespace of one process, as the kernel names it, or undefined where
 * there is no `/proc`. Two processes that share a namespace can see each other.
 */
function pidNamespace(fs, pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/pid`)
  } catch {
    return undefined
  }
}

/**
 * The start time of one process — field 22 of `/proc/<pid>/stat` — or undefined
 * when the process is gone or the field cannot be read. The command name sits in
 * parentheses as field 2 and may hold spaces, so the fields are counted from the
 * closing parenthesis: the start time is the twentieth field after it.
 */
function processStart(fs, pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return fields[19]
  } catch {
    return undefined
  }
}

/** The identity of this process: its PID namespace, its id and its start time. */
export function processIdentity(fs = nodeFs) {
  return { namespace: pidNamespace(fs, process.pid), pid: process.pid, start: processStart(fs, process.pid) }
}

/**
 * Whether a holder recorded in a lock generation file is gone. A holder in
 * another PID namespace, one whose identity cannot be read, and one whose
 * process is alive all keep their lock, however old their file is; a holder is
 * gone only when its namespace matches and its process has no entry or a
 * different start time — or, where `/proc` is absent, when a zero signal
 * answers `ESRCH`.
 */
export function holderIsGone(holder, fs = nodeFs) {
  if (!holder || typeof holder !== "object") return false
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false
  const mine = pidNamespace(fs, process.pid)
  if (mine === undefined || typeof holder.namespace !== "string") {
    try {
      process.kill(holder.pid, 0)
      return false
    } catch (error) {
      return error?.code === "ESRCH"
    }
  }
  if (holder.namespace !== mine) return false
  if (typeof holder.start !== "string" || holder.start === "") return false
  const start = processStart(fs, holder.pid)
  return start === undefined || start !== holder.start
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

  /**
   * Remove every claim generation, the commit file and any temporary file of
   * one permalink, so its next hit is a fresh one. A permalink's file names all
   * start with its hash and a dot, and a hash is a fixed sixty-four characters,
   * so no other permalink's files match. A caller forgets a permalink only once
   * its message is unflagged and no open issue carries it (src/watcher.js).
   */
  function forget(hash) {
    const prefix = `${hash}.`
    for (const name of names()) {
      if (name.startsWith(prefix)) fs.rmSync(path(name), { force: true })
    }
  }

  return { claim, removeClaim, commit, listCommits, removeStaleTemporaries, forget, dir }
}

/**
 * An exclusive lock under the **holder fence**, for the calls that must not run
 * at once: one lock per intake issue, shared by the calls that adopt or close
 * it, and one lock per poller cycle, in claim subdirectories of their own that
 * every server process shares.
 *
 * Plugin storage offers no compare-and-set, so the lock is the same
 * exclusive-create generation files the flag path uses, in a mode of their own.
 * A generation file holds its holder's identity — PID namespace, process id and
 * process start time — and is written complete before it is visible. The
 * highest generation is free only when it carries a release marker or its
 * holder is gone; a holder that is alive, in another namespace, or whose state
 * cannot be read keeps the lock however old its file is, so a call that stalls
 * and resumes still holds the only lock, and a lock passes on only when its
 * holder's process has died, which never resumes. Generation names are never
 * reused: the highest generation file is never removed, and a holder releases
 * by adding the release marker of its own generation and removing nothing else.
 * An acquirer creates the generation above a free highest one, then lists
 * again: a higher generation means a newer holder, so it removes its own file
 * and withdraws. A caller that acts on an old observation therefore either
 * finds its name taken or finds a higher generation and withdraws.
 *
 * Every session a call creates is named, from the moment the create returns,
 * by a **leftover file** of its own; the call removes it once the session is
 * recorded and prompted, and a call that dies keeps it, so the next call on the
 * issue can find what it left behind. `dir` is the one claim subdirectory the
 * fence, its leftover files and its release markers live in.
 */
export function createFence({
  dir,
  fs = nodeFs,
  now = Date.now,
  identity = () => processIdentity(fs),
  gone = (holder) => holderIsGone(holder, fs),
}) {
  const lockPath = (key, generation) => join(dir, `${key}.lock.${generation}`)
  const releasePath = (key, generation) => join(dir, `${key}.release.${generation}`)
  const leftoverPath = (key, sessionID) => join(dir, `${key}.leftover.${sessionID}`)

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true })

  function names() {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }

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

  function generations(key) {
    const prefix = `${key}.lock.`
    return names()
      .filter((name) => name.startsWith(prefix))
      .map((name) => Number(name.slice(prefix.length)))
      .filter((value) => Number.isInteger(value) && value >= 0)
      .sort((a, b) => a - b)
  }

  /** The holder identity one generation file carries, or undefined when it cannot be read. */
  function holderOf(key, generation) {
    try {
      return JSON.parse(fs.readFileSync(lockPath(key, generation), "utf8"))
    } catch {
      return undefined
    }
  }

  /** Whether one generation is free: it carries a release marker, or its holder is gone. */
  function free(key, generation) {
    if (stat(releasePath(key, generation))) return true
    const holder = holderOf(key, generation)
    if (!holder || typeof holder !== "object") return false
    return gone(holder) === true
  }

  /**
   * Take the lock for `key`. Answers the generation this call holds, or null
   * when another call holds it. The caller releases with that generation.
   */
  function acquire(key) {
    ensureDir()
    const listed = generations(key)
    let target
    if (listed.length === 0) {
      target = 0
    } else {
      const highest = listed.at(-1)
      if (!free(key, highest)) return null
      target = highest + 1
    }
    if (!writeExclusive(lockPath(key, target), JSON.stringify(identity()))) return null
    // A generation above this one exists: a newer holder appeared while this
    // call acted on its older observation, so it withdraws without holding.
    if (generations(key).some((generation) => generation > target)) {
      fs.rmSync(lockPath(key, target), { force: true })
      return null
    }
    // This call holds, and every lower generation is dead.
    for (const generation of generations(key)) {
      if (generation === target) continue
      fs.rmSync(lockPath(key, generation), { force: true })
      fs.rmSync(releasePath(key, generation), { force: true })
    }
    return target
  }

  /**
   * Release the lock: add the release marker of this generation. It removes
   * nothing else, so a generation file an acquirer's old observation can still
   * name is never resurrected beside a live holder.
   */
  function release(key, generation) {
    ensureDir()
    writeExclusive(releasePath(key, generation), String(now()))
  }

  /** Name one session as this call's own, from the moment the create returned. */
  function writeLeftover(key, sessionID) {
    ensureDir()
    return writeExclusive(leftoverPath(key, sessionID), JSON.stringify({ sessionID, at: new Date(now()).toISOString() }))
  }

  /** Every session of one issue a leftover file still names. */
  function leftovers(key) {
    const prefix = `${key}.leftover.`
    return names()
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
  }

  /** Remove the leftover file of one session. */
  function removeLeftover(key, sessionID) {
    fs.rmSync(leftoverPath(key, sessionID), { force: true })
  }

  return { acquire, release, writeLeftover, leftovers, removeLeftover, dir }
}
