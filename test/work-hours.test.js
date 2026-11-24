// The work-hours window's elapsed-time function: how many working minutes lie
// between two instants, on a window's own days and hours.
//
// No dependencies; run with `node --test` (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { inWorkHours, validateWorkHours, workingDayMinutes, workingMinutesBetween } from "../src/work-hours.js"

const HOURS = { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "18:00", time_zone: "UTC" }
const at = (text) => Date.parse(text)

test("a window's day is its start-to-end length", () => {
  assert.equal(workingDayMinutes(HOURS), 9 * 60)
  assert.equal(workingDayMinutes({ ...HOURS, start: "08:30", end: "17:15" }), 8 * 60 + 45)
  assert.equal(workingDayMinutes({ start: "18:00", end: "09:00" }), 0, "an end at or before the start is no day")
  assert.equal(workingDayMinutes(undefined), 0)
})

test("inside one working day only the elapsed minutes count", () => {
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T10:00:00Z"), at("2026-11-23T12:00:00Z")), 120)
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T09:00:00Z"), at("2026-11-23T09:30:00Z")), 30)
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T08:00:00Z"), at("2026-11-23T10:00:00Z")), 60, "the hour before the window is not counted")
})

test("time after the window's end is not counted", () => {
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T17:00:00Z"), at("2026-11-23T19:00:00Z")), 60)
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T18:00:00Z"), at("2026-11-23T20:00:00Z")), 0)
})

test("a weekend between two instants contributes nothing", () => {
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-20T17:00:00Z"), at("2026-11-23T10:00:00Z")), 120)
})

test("time on a day the window does not list is not counted", () => {
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-21T12:00:00Z"), at("2026-11-21T14:00:00Z")), 0, "Saturday")
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-22T09:00:00Z"), at("2026-11-22T18:00:00Z")), 0, "Sunday")
})

test("both instants outside the window, and a reversed or empty interval, give zero", () => {
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-21T01:00:00Z"), at("2026-11-21T02:00:00Z")), 0)
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T12:00:00Z"), at("2026-11-23T12:00:00Z")), 0)
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T12:00:00Z"), at("2026-11-23T11:00:00Z")), 0)
  assert.equal(workingMinutesBetween(undefined, at("2026-11-23T10:00:00Z"), at("2026-11-23T12:00:00Z")), 0)
})

test("whole days across a week sum to the window's own days", () => {
  // Monday 09:00 to the next Monday 09:00 is five working days.
  assert.equal(workingMinutesBetween(HOURS, at("2026-11-23T09:00:00Z"), at("2026-11-30T09:00:00Z")), 5 * 9 * 60)
})

test("the window's own predicate still holds", () => {
  assert.equal(inWorkHours(HOURS, at("2026-11-23T10:00:00Z")), true)
  assert.equal(inWorkHours(HOURS, at("2026-11-23T08:00:00Z")), false)
  assert.equal(inWorkHours(HOURS, at("2026-11-21T10:00:00Z")), false, "a day the window does not list")
  assert.equal(validateWorkHours(HOURS), undefined, "the window this suite uses is valid")
})
