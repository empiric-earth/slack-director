// The process-wide registry that keeps one loaded plugin instance per OpenCode
// server process running the plugin's timers — the flag scan and the thread
// poller.
//
// A server plugin's `setup` runs once per Location, and a plugin installed as a
// local directory is re-imported per Location, so module state is not shared
// between instances. The process global is shared, because plugins load in the
// server's own process, so this registry lives there. The first instance to
// register owns the timers; when it unloads, the next loaded instance takes
// them over. The storage lease still guards a second server process.
//
// Every instance still serves the RPC from the shared plugin storage, and a
// poll-now on any instance runs the owner's scan through the same registry.

import { randomUUID } from "node:crypto"

const REGISTRY = Symbol.for("slack-director.singleton")
const OWNER = Symbol.for("slack-director.lease-owner")

function registry() {
  const existing = globalThis[REGISTRY]
  if (existing) return existing
  const created = { instances: new Map(), ownerID: null, next: 0 }
  globalThis[REGISTRY] = created
  return created
}

/**
 * This server process's lease identity, stable for the process's life. Every
 * loaded instance shares it, so the lease never lets one instance of a process
 * block another, and a second server process — a different owner — is still
 * guarded.
 */
export function processOwner() {
  const existing = globalThis[OWNER]
  if (existing) return existing
  const created = randomUUID()
  globalThis[OWNER] = created
  return created
}

/**
 * Register one loaded instance. The first registration, and the next one after
 * the owner unloads, owns the timers: its `onTakeover` starts them. Answers a
 * handle whose `release` unregisters the instance and hands the timers to
 * another loaded one, if any.
 */
export function registerInstance({ onTakeover, pollNow } = {}) {
  const reg = registry()
  const id = (reg.next += 1)
  reg.instances.set(id, { onTakeover, pollNow })
  if (reg.ownerID === null || !reg.instances.has(reg.ownerID)) {
    reg.ownerID = id
    onTakeover?.()
  }
  return {
    release() {
      reg.instances.delete(id)
      if (reg.ownerID !== id) return
      reg.ownerID = null
      const next = reg.instances.keys().next()
      if (next.done) return
      reg.ownerID = next.value
      reg.instances.get(next.value)?.onTakeover?.()
    },
  }
}

/** Run the owner's poll-now, from whichever instance asked. */
export function ownerPollNow() {
  const reg = registry()
  if (reg.ownerID === null) return undefined
  return reg.instances.get(reg.ownerID)?.pollNow?.()
}

/** Whether this process currently holds an owner for the timers. */
export function hasOwner() {
  return registry().ownerID !== null
}

/** Forget every registered instance. The suite uses it between tests. */
export function resetRegistry() {
  delete globalThis[REGISTRY]
}
