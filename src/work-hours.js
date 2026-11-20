// The window a poll runs in.
//
// A window is a list of weekdays, a start and an end clock time, and an IANA
// time zone. The clock times are read in that zone, so one window means the
// same hours wherever the machine is, and a poll outside it makes no Slack
// call at all.

/** The weekday names a window lists. */
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const DEFAULT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]
const DEFAULT_START = "09:00"
const DEFAULT_END = "18:00"

/** The machine's own IANA time zone, or `UTC` when it cannot be read. */
export function machineTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** The window the config uses when it names none. */
export function defaultWorkHours() {
  return { days: [...DEFAULT_DAYS], start: DEFAULT_START, end: DEFAULT_END, time_zone: machineTimeZone() }
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

/** The minutes since midnight a `HH:MM` clock reads, or undefined. */
function minutesOf(clock) {
  const match = CLOCK.exec(typeof clock === "string" ? clock : "")
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

function knownZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Why a window is not usable, or undefined. */
export function validateWorkHours(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "config field invalid: work_hours"
  if (!Array.isArray(value.days) || value.days.length === 0 || !value.days.every((day) => DAY_NAMES.includes(day))) {
    return "config field invalid: work_hours.days"
  }
  if (minutesOf(value.start) === undefined) return "config field invalid: work_hours.start"
  if (minutesOf(value.end) === undefined) return "config field invalid: work_hours.end"
  if (minutesOf(value.end) <= minutesOf(value.start)) return "config field invalid: work_hours.end"
  if (typeof value.time_zone !== "string" || !knownZone(value.time_zone)) {
    return "config field invalid: work_hours.time_zone"
  }
  return undefined
}

/** A validated window, copied so a caller cannot change the config it came from. */
export function normalizeWorkHours(value) {
  return { days: [...value.days], start: value.start, end: value.end, time_zone: value.time_zone }
}

/** The weekday and the minutes since midnight of an instant, in one zone. */
function clockIn(zone, at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at))
  const part = (type) => parts.find((entry) => entry.type === type)?.value
  return { day: part("weekday"), minutes: Number(part("hour")) * 60 + Number(part("minute")) }
}

/** Whether an instant is inside the window: a listed day, from start up to end. */
export function inWorkHours(hours, at) {
  const { day, minutes } = clockIn(hours.time_zone, at)
  return hours.days.includes(day) && minutes >= minutesOf(hours.start) && minutes < minutesOf(hours.end)
}
