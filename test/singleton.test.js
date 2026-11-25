// The process-wide registry: one loaded instance per server process runs the
// timers, and a poll-now reaches the owner's scan. No dependencies.
import { test } from "node:test"
import assert from "node:assert/strict"
import { hasOwner, ownerPollNow, registerInstance, resetRegistry } from "../src/singleton.js"

test("the first instance owns the timers, and a second loaded instance does not", () => {
  resetRegistry()
  const started = []
  const first = registerInstance({ onTakeover: () => started.push("first") })
  const second = registerInstance({ onTakeover: () => started.push("second") })
  assert.deepEqual(started, ["first"], "exactly one instance starts the timers")
  assert.equal(hasOwner(), true)
  second.release()
  assert.deepEqual(started, ["first"], "releasing a non-owner leaves the owner alone")
  first.release()
  assert.equal(hasOwner(), false, "with the owner gone there is none")
})

test("the next loaded instance takes the timers over when the owner unloads", () => {
  resetRegistry()
  const started = []
  const first = registerInstance({ onTakeover: () => started.push("first") })
  registerInstance({ onTakeover: () => started.push("second") })
  first.release()
  assert.deepEqual(started, ["first", "second"], "the other loaded instance takes over")
})

test("a poll-now on any instance runs the owner's scan", () => {
  resetRegistry()
  const ran = []
  registerInstance({ onTakeover: () => {}, pollNow: () => ran.push("first") })
  registerInstance({ onTakeover: () => {}, pollNow: () => ran.push("second") })
  ownerPollNow()
  assert.deepEqual(ran, ["first"], "the owner's scan is the one that runs")
})

test("a poll-now with no owner runs nothing", () => {
  resetRegistry()
  assert.equal(ownerPollNow(), undefined)
})
