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

/** The weekday, the calendar date and the minutes since midnight of an instant, in one zone. */
function partsIn(zone, at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at))
  const part = (type) => parts.find((entry) => entry.type === type)?.value
  return {
    day: part("weekday"),
    year: Number(part("year")),
    month: Number(part("month")),
    date: Number(part("day")),
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  }
}

/** The weekday and the minutes since midnight of an instant, in one zone. */
function clockIn(zone, at) {
  const { day, minutes } = partsIn(zone, at)
  return { day, minutes }
}

/** Whether an instant is inside the window: a listed day, from start up to end. */
export function inWorkHours(hours, at) {
  const { day, minutes } = clockIn(hours.time_zone, at)
  return hours.days.includes(day) && minutes >= minutesOf(hours.start) && minutes < minutesOf(hours.end)
}

/** The zone's offset from UTC at one instant, in milliseconds. */
function zoneOffsetMs(zone, at) {
  const p = partsIn(zone, at)
  const asUTC = Date.UTC(p.year, p.month - 1, p.date, Math.floor(p.minutes / 60), p.minutes % 60)
  return asUTC - at
}

/**
 * The instant a wall-clock time on a local calendar date names in one zone. The
 * offset is read twice around the guess, so a zone whose offset changes near the
 * target still lands on the right minute.
 */
function wallClockInstant(zone, year, month, date, minutes) {
  const guess = Date.UTC(year, month - 1, date, Math.floor(minutes / 60), minutes % 60)
  let instant = guess
  for (let pass = 0; pass < 2; pass += 1) instant = guess - zoneOffsetMs(zone, instant)
  return instant
}

/** The length of one day's window in minutes: `end` − `start`. */
export function workingDayMinutes(hours) {
  const start = minutesOf(hours?.start)
  const end = minutesOf(hours?.end)
  return start === undefined || end === undefined || end <= start ? 0 : end - start
}

/**
 * The working minutes between two instants: the minutes of `[from, to]` that fall
 * in the window — a listed day, from `start` up to `end` — summed over each local
 * calendar day in the zone. Time outside the window, on a day the window does not
 * list, and after `to` or before `from` is not counted. Both instants are read at
 * whole-minute resolution, and `to` at or before `from` is zero minutes.
 */
export function workingMinutesBetween(hours, from, to) {
  const start = minutesOf(hours?.start)
  const end = minutesOf(hours?.end)
  if (start === undefined || end === undefined || end <= start) return 0
  const zone = hours.time_zone
  const first = Math.floor(from / 60000) * 60000
  const last = Math.floor(to / 60000) * 60000
  if (!(last > first)) return 0
  const dayKey = (p) => p.year * 10000 + p.month * 100 + p.date
  const startParts = partsIn(zone, first)
  const lastKey = dayKey(partsIn(zone, last))
  let year = startParts.year
  let month = startParts.month
  let date = startParts.date
  let total = 0
  // The loop advances one local calendar day at a time, so it ends; the guard
  // only bounds a zone whose calendar arithmetic misbehaves.
  for (let guard = 0; guard < 4000; guard += 1) {
    if (year * 10000 + month * 100 + date > lastKey) break
    const weekday = DAY_NAMES[(new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7]
    if (hours.days.includes(weekday)) {
      const windowStart = wallClockInstant(zone, year, month, date, start)
      const windowEnd = wallClockInstant(zone, year, month, date, end)
      total += Math.max(0, Math.min(last, windowEnd) - Math.max(first, windowStart))
    }
    const next = new Date(Date.UTC(year, month - 1, date) + 86400000)
    year = next.getUTCFullYear()
    month = next.getUTCMonth() + 1
    date = next.getUTCDate()
  }
  return total / 60000
}
