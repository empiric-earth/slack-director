// The claim files and the holder fence.
//
// The fence decides who may act on one intake issue at a time, across every
// server process that shares the claim directory. Its liveness test is injected
// here, so two processes are played inside one: the harness names each process
// by the identity its generation file carries, and decides which identities are
// gone. No dependencies; run with `node --test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as nodeFs from "node:fs"
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFence, holderIsGone, issueHash, permalinkHash, processIdentity } from "../src/claims.js"

const KEY = issueHash("empiric-earth/almeida-slack-intake", 36)
const OLD = new Date(Date.now() - 24 * 60 * 60 * 1000)

/** One process's identity, as a generation file carries it. */
const holder = (pid, start = "100", namespace = "ns:one") => ({ pid, start, namespace })

/** The lock generation files of one directory, sorted. */
const lockNames = (dir) =>
  readdirSync(dir)
    .filter((name) => /\.lock\.\d+$/.test(name))
    .sort()

/**
 * One fixture: a fresh claim directory, and a fence factory over it, so two
 * fences in one test share the directory two server processes would share.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "slack-director-fence-"))
  return {
    dir,
    fence: (options = {}) => createFence({ dir, fs: nodeFs, gone: () => false, ...options }),
    names: () => readdirSync(dir).sort(),
    age: () => {
      for (const name of readdirSync(dir)) utimesSync(join(dir, name), OLD, OLD)
    },
    clean: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("a lock whose holder is alive is never taken over, however old its file is", () => {
  const f = fixture()
  const alive = f.fence({ identity: () => holder(10) })
  const other = f.fence({ identity: () => holder(20) })
  try {
    assert.equal(alive.acquire(KEY), 0, "the first caller takes generation 0")
    f.age()
    // The holder's process is alive, so its file's age proves nothing.
    assert.equal(other.acquire(KEY), null, "a live holder keeps the lock")
    assert.deepEqual(f.names(), [`${KEY}.lock.0`], "and no second generation appears")
  } finally {
    f.clean()
  }
})

test("a lock is taken over only from a holder whose process is gone", () => {
  const f = fixture()
  const first = f.fence({ identity: () => holder(10) })
  const second = f.fence({ identity: () => holder(20), gone: (entry) => entry.pid === 10 })
  try {
    assert.equal(first.acquire(KEY), 0)
    assert.equal(second.acquire(KEY), 1, "the gone holder's lock passes to the next caller")
    assert.deepEqual(f.names(), [`${KEY}.lock.1`], "the dead generation is removed and the new one stays")
    // The first holder's own file is gone; its release adds nothing but a marker.
    first.release(KEY, 0)
    assert.ok(f.names().includes(`${KEY}.release.0`), "a release adds its own generation's marker")
  } finally {
    f.clean()
  }
})

test("two callers that both find a gone holder take the lock over, and only one gets it", () => {
  const f = fixture()
  const dead = f.fence({ identity: () => holder(10) })
  const gone = (entry) => entry.pid === 10
  const left = f.fence({ identity: () => holder(20), gone })
  const right = f.fence({ identity: () => holder(30), gone })
  try {
    assert.equal(dead.acquire(KEY), 0)
    const held = [left.acquire(KEY), right.acquire(KEY)].filter((generation) => generation !== null)
    assert.deepEqual(held, [1], "exactly one caller reaches generation 1")
    assert.deepEqual(lockNames(f.dir), [`${KEY}.lock.1`], "one generation file is left, and one caller holds")
  } finally {
    f.clean()
  }
})

test("a release never removes the highest generation file, so the next caller takes the generation above", () => {
  const f = fixture()
  const one = f.fence({ identity: () => holder(10) })
  const two = f.fence({ identity: () => holder(20), gone: (entry) => entry.pid === 10 })
  const three = f.fence({ identity: () => holder(30), gone: (entry) => entry.pid === 20 })
  try {
    assert.equal(one.acquire(KEY), 0)
    one.release(KEY, 0)
    assert.ok(f.names().includes(`${KEY}.lock.0`), "the released generation file is still there")
    assert.equal(two.acquire(KEY), 1, "the next caller takes the generation above the released one")
    two.release(KEY, 1)
    assert.ok(f.names().includes(`${KEY}.lock.1`), "and its own file stays too")
    assert.equal(three.acquire(KEY), 2, "so the third caller takes generation 2")
    assert.deepEqual(lockNames(f.dir), [`${KEY}.lock.2`], "only the live holder's generation file is left")
  } finally {
    f.clean()
  }
})

test("the delayed acquirer across release and reuse withdraws, and one holder remains", () => {
  const f = fixture()
  const dead = f.fence({ identity: () => holder(10) })
  const later = f.fence({ identity: () => holder(20), gone: (entry) => entry.pid === 10 })
  const reuse = f.fence({ identity: () => holder(30), gone: (entry) => entry.pid === 20 })
  let reused = null
  // The delayed caller's own look at the lock runs the two later holders: one
  // takes over from the dead holder and releases, and the next takes the lock
  // and stays alive. The delayed caller then creates its own generation.
  const delayed = f.fence({
    identity: () => holder(40),
    gone: (entry) =>
      entry.pid === 10
        ? (() => {
            assert.equal(later.acquire(KEY), 1, "the first later caller takes the dead holder's lock")
            later.release(KEY, 1)
            reused = reuse.acquire(KEY)
            return true
          })()
        : false,
  })
  try {
    assert.equal(dead.acquire(KEY), 0)
    assert.equal(delayed.acquire(KEY), null, "a higher generation exists, so the delayed caller withdraws")
    assert.equal(reused, 2, "the third caller holds generation 2 and stays alive")
    assert.deepEqual(lockNames(f.dir), [`${KEY}.lock.2`], "exactly one generation file is left: the live holder's")
  } finally {
    f.clean()
  }
})

test("holderIsGone reads the identity a generation file carries", () => {
  const mine = "ns:mine"
  // Field 22 of `/proc/<pid>/stat`, the start time, sits at index 19 after the
  // closing parenthesis: `S` is field 3, then eighteen more fields, then the
  // start time.
  const stat = (pid, start) => `${pid} (node) S${" 0".repeat(18)} ${start}`
  const fs = {
    readlinkSync: (path) => (path === `/proc/${process.pid}/ns/pid` ? mine : "ns:other"),
    readFileSync: (path) => {
      if (path === "/proc/60/stat") return stat(60, "200")
      if (path === "/proc/70/stat") return stat(70, "900")
      throw Object.assign(new Error("no such process"), { code: "ENOENT" })
    },
  }
  assert.equal(holderIsGone(holder(60, "200", mine), fs), false, "a live holder with the same start time is not gone")
  assert.equal(holderIsGone(holder(70, "200", mine), fs), true, "a different start time is a different process")
  assert.equal(holderIsGone(holder(99, "200", mine), fs), true, "a holder with no process entry is gone")
  assert.equal(holderIsGone(holder(60, "200", "ns:other"), fs), false, "a holder in another namespace keeps its lock")
  assert.equal(holderIsGone(holder(60, "", mine), fs), false, "a holder whose own state cannot be read keeps its lock")
  assert.equal(holderIsGone(undefined, fs), false, "a file that carries no identity keeps the lock")
})

test("processIdentity carries this process's namespace, id and start time", () => {
  const identity = processIdentity()
  assert.equal(identity.pid, process.pid)
  if (existsSync("/proc/self/ns/pid")) {
    assert.equal(typeof identity.namespace, "string", "the namespace is read where /proc exists")
    assert.equal(typeof identity.start, "string", "and so is the start time")
  }
})

test("a leftover file names one session until it is removed", () => {
  const f = fixture()
  const { fence, clean } = { fence: f.fence({ identity: () => holder(10) }), clean: f.clean }
  try {
    assert.deepEqual(fence.leftovers(KEY), [], "no leftover before a session is made")
    assert.equal(fence.writeLeftover(KEY, "ses_1"), true, "the session is named from the create's return")
    assert.equal(fence.writeLeftover(KEY, "ses_2"), true, "and so is a second one")
    assert.deepEqual(fence.leftovers(KEY).sort(), ["ses_1", "ses_2"], "both are found by the next call")
    fence.removeLeftover(KEY, "ses_1")
    assert.deepEqual(fence.leftovers(KEY), ["ses_2"], "a removed file names nothing")
  } finally {
    clean()
  }
})

test("the issue lock key is the repo and the number, and no other issue's", () => {
  assert.equal(issueHash("empiric-earth/almeida-slack-intake", 36), issueHash("empiric-earth/almeida-slack-intake", 36))
  assert.notEqual(issueHash("empiric-earth/almeida-slack-intake", 36), issueHash("empiric-earth/almeida-slack-intake", 37))
  assert.notEqual(issueHash("empiric-earth/almeida-slack-intake", 36), issueHash("empiric-earth/other-intake", 36))
  assert.equal(
    issueHash("a/b", 1).length,
    permalinkHash("x").length,
    "a key is a fixed-length hash, so a file name can hold it",
  )
})
