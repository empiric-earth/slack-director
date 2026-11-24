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

/** The formatter each zone is read with, built once and reused. */
const FORMATTERS = new Map()

function formatterFor(zone) {
  let formatter = FORMATTERS.get(zone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    FORMATTERS.set(zone, formatter)
  }
  return formatter
}

/** The weekday, the calendar date and the minutes since midnight of an instant, in one zone. */
function partsIn(zone, at) {
  const parts = formatterFor(zone).formatToParts(new Date(at))
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

const MINUTE_MS = 60000
const HOUR_MS = 3600000
const DAY_MINUTES = 1440

/**
 * The next instant at or after `at` and below `limit` where the zone's offset
 * changes, or `limit` when it does not. An hourly probe finds the change and a
 * binary search lands on its own minute; no zone changes its offset twice within
 * an hour.
 */
function transitionAfter(zone, at, limit) {
  const offset = zoneOffsetMs(zone, at)
  let probe = at
  while (probe < limit) {
    const next = Math.min(probe + HOUR_MS, limit)
    if (zoneOffsetMs(zone, next) !== offset) {
      let low = probe
      let high = next
      while (high - low > MINUTE_MS) {
        const mid = low + Math.floor((high - low) / (2 * MINUTE_MS)) * MINUTE_MS
        if (zoneOffsetMs(zone, mid) === offset) low = mid
        else high = mid
      }
      return high
    }
    probe = next
  }
  return limit
}

/** The length of one day's window in minutes: `end` − `start`. */
export function workingDayMinutes(hours) {
  const start = minutesOf(hours?.start)
  const end = minutesOf(hours?.end)
  return start === undefined || end === undefined || end <= start ? 0 : end - start
}

/**
 * The working minutes between two instants: the minutes of `[from, to]` that fall
 * in the window — a listed local day, from `start` up to `end` — counted in the
 * zone's own clock. The interval is cut at each offset change and each local
 * midnight, so a daylight-saving jump or repeat counts exactly the minutes the
 * window's own `inWorkHours` predicate accepts, and a window time that does not
 * exist on that day counts nothing. Time outside the window and on a day the
 * window does not list is not counted; both instants are read at whole-minute
 * resolution, and `to` at or before `from` is zero minutes.
 */
export function workingMinutesBetween(hours, from, to) {
  const start = minutesOf(hours?.start)
  const end = minutesOf(hours?.end)
  if (start === undefined || end === undefined || end <= start) return 0
  const zone = hours.time_zone
  const first = Math.floor(from / MINUTE_MS) * MINUTE_MS
  const last = Math.floor(to / MINUTE_MS) * MINUTE_MS
  if (!(last > first)) return 0
  const listed = hours.days ?? []
  let total = 0
  let cursor = first
  while (cursor < last) {
    const segmentEnd = transitionAfter(zone, cursor, last)
    let at = cursor
    while (at < segmentEnd) {
      const { day, minutes } = partsIn(zone, at)
      const midnight = at + (DAY_MINUTES - minutes) * MINUTE_MS
      const pieceEnd = midnight < segmentEnd ? midnight : segmentEnd
      if (listed.includes(day)) {
        const length = (pieceEnd - at) / MINUTE_MS
        total += Math.max(0, Math.min(minutes + length, end) - Math.max(minutes, start))
      }
      at = pieceEnd
    }
    cursor = segmentEnd
  }
  return total
}
