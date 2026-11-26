// The watcher: one poll finds the messages the user flagged and gives each new
// one a session, and the item map holds what the overview dialog and the
// settings dialog show.
//
// A poll reads the config again, does nothing outside the configured work
// hours, resolves each Slack MCP server's own OAuth credential, searches that
// workspace through MCP over HTTP, and claims every new permalink with the
// exclusive-create files in src/claims.js before it starts a session and sends
// the first prompt. The lease in plugin storage only spares two instances the
// same poll; the claim and commit files are what keep one flagged message to
// one prompted session.
//
// A record an earlier build left with no issue and whose message is still
// flagged is reissued once, through the same claim files in a `reissue/`
// subdirectory: the search treats its permalink as unseen, so the hit is
// established as the tool's own result, and the record is replaced in place
// only when the earlier session is quiet by its persisted run times. A commit
// whose holder stopped before the replacement is reconciled without a prompt.
//
// A session's first turn ends as an event, so the watcher follows the event
// stream for its own item sessions: it writes the item map and the session
// title from the reply's two fixed lines, and records a pending permission
// request. OpenCode declares `session.idle` but never publishes it, so a turn's
// end arrives as `session.execution.succeeded`, `.failed` or `.interrupted`.
//
// A session that is deleted or archived takes its item record with it, so the
// row leaves the dialog for good. Every later update of the same item is
// conditional on the record still naming the session its caller read, so a
// write already under way never brings a removed record back.
//
// The `done` RPC starts a close for one item: the item's own session closes its
// intake issue, and the plugin deletes the session only when the close turn the
// plugin started ends well and the reply bound to that turn names the record's
// own issue as closed. Nothing is removed without that proof, and a session the
// host reports gone drops its record without closing its issue. Every close
// writes one log line when it starts and one when it ends; a close that refuses
// also reaches the dialog, so the user is never left waiting for one that never
// ran. The plugin's unload stops the watcher, and every close still in flight is
// abandoned before it can remove anything.
//
// The completion binds to the first execution: only a turn of a session this
// instance started may complete the item, and only the first one to end, and
// only when its reply names the issue it made. A turn that ended in error, a
// turn whose reply names no issue, a later turn, and a turn whose end no
// instance saw (a restart) all leave the item in the pessimistic waiting state
// its record was written with. The event carries no execution identity, so the
// binding is the set of sessions this instance started, held for the instance's
// lifetime: a new instance accepts no first turn it did not start.
import { randomUUID } from "node:crypto"
import { permalinkHash, STALE_MS } from "./claims.js"
import { DEFAULT_POLL_SECONDS } from "./config.js"
import { itemFirstPrompt, closePrompt, refreshPrompt } from "./first-prompt.js"
import { closeReply, contextMessages, parseReply, replyText } from "./reply.js"
import { REQUEST_TIMEOUT_MS, searchFlagged, SLACK_MCP_URL } from "./slack-mcp.js"
import { KEYS, LEASE_MS } from "./state.js"
import { inWorkHours } from "./work-hours.js"

export { LEASE_MS }

/** The agent a refresh session runs on. */
export const REFRESH_AGENT = "slack-director-refresh"

/** The record form this build writes; a record without it is an earlier build's. */
export const RECORD_FORMAT = 2

/** The status of a workspace whose credential cannot be renewed. */
export const SUSPENDED_ERROR = "sign-in expired — run /mcps"

/** The events an item session's progress arrives in. */
export const SESSION_EVENT_TYPES = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "session.deleted",
  "session.archived",
]

/** The execution events that end a turn, and whether each one failed. */
const TURN_ENDED = {
  "session.execution.succeeded": false,
  "session.execution.failed": true,
  "session.execution.interrupted": true,
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * The reissue store of a watcher built without one: it claims nothing, so a
 * caller that holds no reissue directory reissues nothing. The plugin passes
 * the real one, over the `reissue/` subdirectory of its claims directory.
 */
const NO_REISSUE = {
  claim: () => null,
  removeClaim: () => {},
  commit: async () => false,
  listCommits: () => [],
  removeStaleTemporaries: () => {},
  forget: () => {},
}

const emptyToday = () => ({ flagged: 0, nextStepsPosted: 0, skipped: 0 })

/**
 * One writer at a time. Plugin storage offers get and set and no
 * compare-and-set, so two polls that both read the item map or the seen-set and
 * then write it back lose the first writer's change. Every host context gets
 * its own storage object over the same plugin namespace, so the queue is one
 * per process and not one per storage object.
 */
let writeQueue = Promise.resolve()

function serializedWrite(work) {
  const run = writeQueue.then(work, work)
  writeQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

/** The neutral title of an item before its first turn paraphrases it. */
export function neutralTitle(hit) {
  const named = typeof hit.asker === "string" && hit.asker.trim() !== "" ? hit.asker.trim() : hit.ts
  return `Flagged message in ${hit.channel.label} — ${named}`
}

/** One item record as the RPC contract serves it. */
export function itemOfRecord(record) {
  return {
    permalink: record.permalink,
    workspace: record.workspace,
    channel: record.channel,
    asker: record.asker ?? "",
    flaggedAt: record.flaggedAt,
    sessionID: record.sessionID,
    title: record.title,
    issueNumber: record.issueNumber ?? null,
    issueUrl: record.issueUrl ?? null,
    // The request state the poller read from the issue's yaml block. An item
    // whose issue carries no state reads as `needs-me`, and so does one that has
    // no issue yet.
    requestState: typeof record.requestState === "string" && record.requestState !== "" ? record.requestState : "needs-me",
    stateSince: record.stateSince ?? null,
    blockedOn: record.blockedOn ?? null,
    waitingOn: Array.isArray(record.waitingOn) ? record.waitingOn : [],
    issueClosed: record.issueClosed === true,
    firstTurnEndedAt: record.firstTurnEndedAt ?? null,
    firstTurnFailed: record.firstTurnFailed === true,
    permissionPending: record.permissionPending === true,
    openedAt: record.openedAt ?? null,
  }
}

/** A field's value when it is a non-empty string, else the fallback. */
const textOr = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback)

/**
 * Whether a record already carries exactly the fields a read names, closure
 * included. The closure is part of what the write sets: an issue that returns to
 * an open read is written even when its yaml block did not change, so reopening
 * an issue without touching its body shows its row again.
 */
function sameRequestState(record, next) {
  if ((record.issueClosed === true) !== (next.issueClosed === true)) return false
  if (record.requestState !== next.requestState) return false
  if ((record.stateSince ?? null) !== next.stateSince) return false
  if ((record.blockedOn ?? null) !== next.blockedOn) return false
  const waiting = Array.isArray(record.waitingOn) ? record.waitingOn : []
  return waiting.length === next.waitingOn.length && waiting.every((id, index) => id === next.waitingOn[index])
}

export function createWatcher({
  storage,
  claims,
  now = Date.now,
  fetch,
  readConfig,
  writeConfig = () => ({ error: { field: null, message: "the config file is not writable" } }),
  onChange = () => {},
  onRefused = () => {},
  mcpServers,
  resolveCredential,
  session,
  log = () => {},
  leaseMs = LEASE_MS,
  staleMs = STALE_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  inHours = inWorkHours,
  reissue = NO_REISSUE,
  owner = randomUUID(),
}) {
  // The item sessions this instance started and whose first turn it is still
  // waiting on. A turn-end event completes the item only for one of these, so a
  // later turn, or a turn whose start this instance never saw, cannot.
  const firstTurns = new Set()
  // The closes in flight, by session id: one close per session at a time. Each
  // holds the record it closes, the boundary it noted, the admitted close
  // prompt's id once the host returned it, and whether it was abandoned.
  const closes = new Map()
  // The `done` calls whose record is still being read. The entry is taken before
  // the first await, so a second `done` for the same session starts nothing, and
  // an unload during the read abandons the call before any close begins.
  const pendingDone = new Set()
  // The plugin's unload stops the watcher: a close still in flight after that
  // makes no further host call, in particular no remove.
  let closesStopped = false
  // The one scan in flight, if any: a request that arrives while it runs joins
  // it rather than starting a second.
  let scanning = null

  const isExpired = (credential) =>
    credential?.expires !== 0 && credential?.expires !== undefined && credential.expires <= now()

  const changed = () => {
    try {
      onChange()
    } catch (error) {
      log(`the change notice failed: ${messageOf(error)}`)
    }
  }

  async function writeStatus(status) {
    await storage.set(KEYS.status, status)
    changed()
  }

  async function readStatus() {
    return (
      (await storage.get(KEYS.status)) ?? {
        lastPoll: null,
        outcome: "never polled",
        workspaces: [],
        configError: null,
        today: emptyToday(),
      }
    )
  }

  /** The thread poller's last cycle, as its status key holds it. */
  async function readPoller() {
    return (
      (await storage.get(KEYS.poller)) ?? {
        lastCycle: null,
        outcome: "never polled",
        issues: 0,
        threads: 0,
        conversations: 0,
        unattended: [],
        ghError: null,
        failed: [],
        possiblyCut: false,
      }
    )
  }

  async function readItems() {
    return (await storage.get(KEYS.items)) ?? {}
  }

  /**
   * Today's counts. `skipped` is the permalinks the scan met today that were
   * already seen: each one counts once a day, however many polls met it, so
   * the number answers how many flagged messages the scan left alone today and
   * not how often it looked at them.
   */
  async function today({ skipped = [] } = {}) {
    const day = new Date(now()).toISOString().slice(0, 10)
    return serializedWrite(async () => {
      const stored = (await storage.get(KEYS.today)) ?? { day, skipped: [] }
      const counted = stored?.day === day ? stored : { day, skipped: [] }
      const skippedToday = new Set(Array.isArray(counted.skipped) ? counted.skipped : [])
      for (const permalink of skipped) skippedToday.add(permalink)
      const records = Object.values(await readItems())
      const onDay = (value) => typeof value === "string" && value.slice(0, 10) === day
      const next = { day, skipped: [...skippedToday] }
      await storage.set(KEYS.today, next)
      return {
        flagged: records.filter((record) => onDay(record?.flaggedAt)).length,
        // A message the scope rules leave out posted no next steps: its record
        // has a first turn that ended and no issue.
        nextStepsPosted: records.filter((record) => onDay(record?.firstTurnEndedAt) && record?.issueUrl).length,
        skipped: next.skipped.length,
      }
    })
  }

  /**
   * Write the item record and the seen-set entry for one permalink, one writer
   * at a time, so each read sees the change the writer before it made. Both
   * records survive: the map key holds every permalink, and the seen-set holds
   * every recorded one.
   */
  function recordItem(record) {
    return serializedWrite(() => writeRecord(record))
  }

  async function writeRecord(record) {
    const items = await readItems()
    items[record.permalink] = record
    await storage.set(KEYS.items, items)
    const seen = new Set((await storage.get(KEYS.seen)) ?? [])
    seen.add(record.permalink)
    await storage.set(KEYS.seen, [...seen])
    changed()
  }

  /**
   * Replace one item record, one writer at a time, and only while the map still
   * holds a record for the permalink that still names the session the caller
   * read. The record is re-read inside the queue, so a removal or a replacement
   * that happened after the caller's read is never undone: the caller's field
   * changes are applied to the record read here. A record that is gone, or that
   * names another session, writes nothing and sends no change notice. Answers
   * whether the write happened.
   */
  function updateItem(permalink, sessionID, changes) {
    return serializedWrite(async () => {
      const items = await readItems()
      const current = items[permalink]
      if (!current || current.sessionID !== sessionID) return false
      items[permalink] = { ...current, ...changes }
      await storage.set(KEYS.items, items)
      changed()
      return true
    })
  }

  /**
   * Remove every item record that names one session, one writer at a time, and
   * send the change notice. The seen-set and the claim files are not touched, so
   * the permalink is never picked up again. Answers whether a record was
   * removed.
   */
  function dropSessionRecord(sessionID) {
    if (typeof sessionID !== "string" || sessionID === "") return Promise.resolve(false)
    return serializedWrite(async () => {
      const items = await readItems()
      let removed = false
      for (const [permalink, record] of Object.entries(items)) {
        if (record?.sessionID !== sessionID) continue
        delete items[permalink]
        removed = true
      }
      if (!removed) return false
      await storage.set(KEYS.items, items)
      changed()
      return true
    })
  }

  /**
   * Apply the poller's last open-issue read to the item records, one writer at a
   * time: every record that names an issue gets that issue's request state, the
   * time it was set, and the fields that apply while it is blocked or waits on
   * the requester. A record whose issue has left a **complete** read is closed,
   * so its row leaves the dialog; a record whose issue is missing from a failed
   * or possibly cut read keeps the visibility it had. Answers whether anything
   * changed.
   */
  function applyIssueStates(input = {}) {
    const complete = input.complete === true
    const listed = new Map(
      (Array.isArray(input.issues) ? input.issues : [])
        .filter((entry) => entry && typeof entry.number === "number")
        .map((entry) => [entry.number, entry]),
    )
    return serializedWrite(async () => {
      const items = await readItems()
      let dirty = false
      for (const [permalink, record] of Object.entries(items)) {
        if (!record || typeof record.issueNumber !== "number") continue
        const entry = listed.get(record.issueNumber)
        if (entry === undefined) {
          if (complete && record.issueClosed !== true) {
            items[permalink] = { ...record, issueClosed: true }
            dirty = true
          }
          continue
        }
        const next = {
          requestState: textOr(entry.state, "needs-me"),
          stateSince: textOr(entry.stateSince, null),
          blockedOn: textOr(entry.blockedOn, null),
          waitingOn: Array.isArray(entry.waitingOn) ? entry.waitingOn : [],
          issueClosed: false,
        }
        if (sameRequestState(record, next)) continue
        items[permalink] = { ...record, ...next }
        dirty = true
      }
      if (!dirty) return false
      await storage.set(KEYS.items, items)
      changed()
      return true
    })
  }

  /**
   * The latest open-issue read the poller left: whether it was complete — the
   * list succeeded, was not possibly cut, and every issue's block could be read
   * — and every open issue's `permalink`. A read that never happened, failed,
   * was possibly cut, or held a body the reader could not parse answers
   * `complete: false`: the flag scan then treats no unlisted permalink as a
   * closed issue's.
   */
  async function readOpenIssues() {
    const stored = await storage.get(KEYS.open)
    if (!stored || stored.complete !== true || !Array.isArray(stored.permalinks)) {
      return { complete: false, permalinks: new Set() }
    }
    return {
      complete: true,
      permalinks: new Set(stored.permalinks.filter((permalink) => typeof permalink === "string")),
    }
  }

  /**
   * Forget every seen permalink a complete scan no longer lists and no open
   * issue carries: its seen entry, its item record, and its claim and commit
   * files, so the next flag of the same message is a fresh one. The record's
   * session is never deleted — a session the user kept stays, whether the item
   * was closed or its session was archived. One writer at a time, and nothing
   * at all unless the latest open-issue read was complete; the caller checks
   * the scan is complete too. Answers the permalinks it forgot.
   */
  function forgetUnlisted({ listed, open }) {
    if (!open.complete) return Promise.resolve([])
    return serializedWrite(async () => {
      const seen = new Set((await storage.get(KEYS.seen)) ?? [])
      const items = await readItems()
      const forgotten = []
      for (const permalink of [...seen]) {
        if (listed.has(permalink) || open.permalinks.has(permalink)) continue
        seen.delete(permalink)
        delete items[permalink]
        const hash = permalinkHash(permalink)
        claims.forget(hash)
        reissue.forget(hash)
        forgotten.push(permalink)
      }
      if (forgotten.length === 0) return []
      await storage.set(KEYS.seen, [...seen])
      await storage.set(KEYS.items, items)
      changed()
      return forgotten
    })
  }

  /** The item record one session belongs to, if it is one of ours. */
  async function itemOf(sessionID) {
    const records = Object.values(await readItems())
    return records.find((record) => record?.sessionID === sessionID)
  }

  async function removeSession(sessionID) {
    try {
      await session.remove({ sessionID })
    } catch (error) {
      log(`session ${sessionID} was not removed: ${messageOf(error)}`)
    }
  }

  /**
   * Reconcile commit files older than the stale age that no poll has recorded
   * yet: they become an item record that reads as waiting, and never a second
   * prompt. Temporary files left by a crashed poll are removed.
   */
  async function reconcile() {
    const seen = new Set((await storage.get(KEYS.seen)) ?? [])
    for (const entry of claims.listCommits()) {
      if (now() - entry.mtimeMs <= staleMs) continue
      const record = entry.record
      if (!record || typeof record.permalink !== "string" || seen.has(record.permalink)) continue
      await recordItem({ ...record, firstTurnFailed: true, firstTurnEndedAt: null })
    }
    claims.removeStaleTemporaries()
  }

  /**
   * The records an earlier build left with no issue: this build's own form
   * carries `recordFormat`, so a record without it is an earlier build's, and
   * one whose message is still flagged is reissued once.
   */
  async function reissueCandidates() {
    const candidates = new Map()
    for (const record of Object.values(await readItems())) {
      if (!record || typeof record.permalink !== "string") continue
      if (record.recordFormat !== undefined) continue
      if (typeof record.issueUrl === "string" && record.issueUrl !== "") continue
      candidates.set(record.permalink, record)
    }
    return candidates
  }

  /**
   * Whether an error means the session is gone rather than unreadable. The host
   * throws a missing session as an `Error` tagged `Session.NotFoundError`, with
   * an empty message and no code.
   */
  const notFound = (error) =>
    error?._tag === "Session.NotFoundError" ||
    error?.code === "NOT_FOUND" ||
    /not found|no such session/i.test(messageOf(error))

  /**
   * Whether a session's run times show a busy period that has not ended. The
   * close turn must be the only turn in the session, so a close refuses one.
   */
  const busyNow = (times) =>
    times?.busy !== undefined && times?.busy !== null && !(typeof times.idle === "number" && times.idle >= times.busy)

  /**
   * Whether an earlier build's session is quiet, by the run times every process
   * reads: no busy period that has not ended, and no change for the stale age.
   * A session that is gone is quiet too. Anything else is an unknown outcome —
   * the earlier writer may still be writing — so the record is left alone.
   */
  async function quietSession(sessionID, record) {
    if (record?.permissionPending === true) {
      return { quiet: false, reason: "a permission request is pending" }
    }
    if (typeof sessionID !== "string" || sessionID === "") {
      return { quiet: false, reason: "the record names no session" }
    }
    let times
    try {
      const found = await session.get({ sessionID })
      if (found === undefined || found === null) return { quiet: true, reason: "the session is gone" }
      times = found.time
    } catch (error) {
      if (notFound(error)) return { quiet: true, reason: "the session is gone" }
      return { quiet: false, reason: `the session was not read: ${messageOf(error)}` }
    }
    if (!times || typeof times !== "object") return { quiet: false, reason: "the session's run times were not read" }
    if (busyNow(times)) {
      return { quiet: false, reason: `a busy period that began at ${times.busy} has not ended` }
    }
    if (typeof times.updated !== "number") return { quiet: false, reason: "the session's update time was not read" }
    if (now() - times.updated <= staleMs) {
      return { quiet: false, reason: `the session changed ${Math.round((now() - times.updated) / 1000)} s ago` }
    }
    return { quiet: true, reason: "the session is quiet" }
  }

  /** The hit fields an item record carries, as the first prompt takes them. */
  const hitOfRecord = (record) => ({
    permalink: record.permalink,
    workspace: record.workspace,
    channel: { id: record.channelID, label: record.channel },
    ts: record.ts,
    asker: record.asker,
  })

  /**
   * Reissue one still-flagged record an earlier build left with no issue: read
   * the record and the handoff, claim it in the reissue directory, create one
   * session on the configured agent, commit the replacement, replace the record
   * in place and send the first prompt. A commit another instance made first
   * refuses this one, and its session is removed unprompted.
   */
  async function handleReissue(hit, config) {
    const hash = permalinkHash(hit.permalink)
    const record = (await readItems())[hit.permalink]
    if (!record || record.recordFormat !== undefined || record.issueUrl) return
    const handoff = await quietSession(record.sessionID, record)
    if (!handoff.quiet) {
      log(`reissue held for ${hit.permalink}: session ${record.sessionID} — ${handoff.reason}`)
      return
    }
    const generation = reissue.claim(hash)
    if (generation === null) return
    const title = typeof record.title === "string" && record.title !== "" ? record.title : neutralTitle(hit)
    let created
    try {
      created = await session.create({
        title,
        agent: config.session_agent,
        location: { directory: config.session_directory },
      })
    } catch (error) {
      reissue.removeClaim(hash, generation)
      log(`reissue session create failed for ${hit.permalink}: ${messageOf(error)}`)
      return
    }
    const next = {
      ...record,
      sessionID: created.id,
      title,
      // An earlier build's record carries no asker; the search result has it.
      asker: record.asker || hit.asker || "",
      firstTurnEndedAt: null,
      firstTurnFailed: true,
      permissionPending: false,
      recordFormat: RECORD_FORMAT,
    }
    const committed = await reissue.commit(hash, {
      ...next,
      committedAt: new Date(now()).toISOString(),
      replaces: record.sessionID,
    })
    if (!committed) {
      // Another instance committed the reissue first: this session is unprompted.
      await removeSession(created.id)
      return
    }
    firstTurns.add(created.id)
    const written = await updateItem(record.permalink, record.sessionID, {
      sessionID: created.id,
      title,
      // An earlier build's record carries no asker; the search result has it.
      asker: record.asker || hit.asker || "",
      firstTurnEndedAt: null,
      firstTurnFailed: true,
      permissionPending: false,
      recordFormat: RECORD_FORMAT,
    })
    if (!written) {
      // The record left the map after this reissue read it: the session it made
      // is unprompted and goes with it.
      firstTurns.delete(created.id)
      await removeSession(created.id)
      return
    }
    try {
      await session.prompt({ sessionID: created.id, text: itemFirstPrompt(hitOfRecord(next), config.intake_repo) })
    } catch (error) {
      firstTurns.delete(created.id)
      log(`reissue first prompt failed for ${hit.permalink}: ${messageOf(error)}`)
    }
  }

  /**
   * Reconcile the reissue commits: one older than the stale age whose record is
   * still an earlier build's and still names the session it replaced becomes
   * that commit's session, without a prompt. Any other record is left alone, so
   * a replacement that succeeded is never overwritten.
   */
  async function reconcileReissues() {
    for (const entry of reissue.listCommits()) {
      if (now() - entry.mtimeMs <= staleMs) continue
      const commit = entry.record
      if (!commit || typeof commit.permalink !== "string" || typeof commit.sessionID !== "string") continue
      const record = (await readItems())[commit.permalink]
      if (!record || record.recordFormat !== undefined) continue
      if (record.sessionID !== commit.replaces) continue
      await updateItem(commit.permalink, record.sessionID, {
        sessionID: commit.sessionID,
        firstTurnFailed: true,
        recordFormat: RECORD_FORMAT,
      })
    }
    reissue.removeStaleTemporaries()
  }

  /** One new hit: claim it, create one session, commit it, then record and prompt it. */
  async function handleHit(hit, config) {
    const hash = permalinkHash(hit.permalink)
    const generation = claims.claim(hash)
    if (generation === null) return
    const title = neutralTitle(hit)
    let created
    try {
      created = await session.create({
        title,
        agent: config.session_agent,
        location: { directory: config.session_directory },
      })
    } catch (error) {
      claims.removeClaim(hash, generation)
      log(`session create failed for ${hit.permalink}: ${messageOf(error)}`)
      return
    }
    const flaggedAt = new Date(now()).toISOString()
    const record = {
      permalink: hit.permalink,
      workspace: hit.workspace,
      channel: hit.channel.label,
      channelID: hit.channel.id,
      ts: hit.ts,
      asker: hit.asker ?? "",
      flaggedAt,
      // The instant this build's flag scan recorded the item: the poller starts
      // a new item's first watermark here. A record without it is an earlier
      // build's, whose item the poller baselines without a wake.
      pollerFrom: flaggedAt,
      title,
      sessionID: created.id,
      issueNumber: null,
      issueUrl: null,
      firstTurnEndedAt: null,
      firstTurnFailed: true,
      permissionPending: false,
      openedAt: null,
      recordFormat: RECORD_FORMAT,
    }
    const committed = await claims.commit(hash, {
      sessionID: created.id,
      committedAt: new Date(now()).toISOString(),
      ...record,
    })
    if (!committed) {
      // Another instance created the commit file first: this session is unprompted.
      await removeSession(created.id)
      return
    }
    firstTurns.add(created.id)
    await recordItem(record)
    try {
      await session.prompt({ sessionID: created.id, text: itemFirstPrompt(hit, config.intake_repo) })
    } catch (error) {
      // A failed prompt call leaves the item waiting: a turn the user runs later
      // in that session is not this item's first turn.
      firstTurns.delete(created.id)
      log(`first prompt failed for ${hit.permalink}: ${messageOf(error)}`)
    }
  }

  /** One refresh session: it makes OpenCode's MCP client renew the credential. */
  async function refresh(name, config) {
    let created
    try {
      created = await session.create({
        title: `Slack sign-in refresh — ${name}`,
        agent: REFRESH_AGENT,
        location: { directory: config.session_directory },
      })
    } catch (error) {
      log(`refresh session create failed for ${name}: ${messageOf(error)}`)
      return undefined
    }
    try {
      await session.prompt({ sessionID: created.id, text: refreshPrompt(name) })
      if (typeof session.wait === "function") await session.wait({ sessionID: created.id })
    } catch (error) {
      log(`refresh session failed for ${name}: ${messageOf(error)}`)
    } finally {
      await removeSession(created.id)
    }
    return resolveCredential(name)
  }

  async function suspend(name, credential) {
    const suspended = (await storage.get(KEYS.suspended)) ?? {}
    suspended[name] = credential?.expires ?? 0
    await storage.set(KEYS.suspended, suspended)
  }

  async function scanWorkspace(server, config, seen, candidates) {
    const name = server.name
    const suspended = (await storage.get(KEYS.suspended)) ?? {}
    if (Object.hasOwn(suspended, name)) {
      const current = await resolveCredential(name)
      // The suspension stands until the credential changes.
      if (current && current.expires === suspended[name]) return { ok: false, error: SUSPENDED_ERROR }
    }
    let credential = await resolveCredential(name)
    if (!credential) return { ok: false, error: "no Slack credential" }
    let refreshed = false
    if (isExpired(credential)) {
      refreshed = true
      credential = (await refresh(name, config)) ?? credential
    }
    // A candidate's permalink is treated as unseen, so the search establishes
    // its hit as the tool's own result exactly as it does a new one.
    const isSeen = (permalink) => seen.has(permalink) && !candidates.has(permalink)
    let search = await searchFlagged({
      fetch,
      url: server.url,
      token: credential.access,
      emoji: config.flag_emoji,
      timeoutMs: requestTimeoutMs,
      isSeen,
    })
    if (search.unauthorized && !refreshed) {
      refreshed = true
      credential = (await refresh(name, config)) ?? credential
      search = await searchFlagged({
        fetch,
        url: server.url,
        token: credential.access,
        emoji: config.flag_emoji,
        timeoutMs: requestTimeoutMs,
        isSeen,
      })
    }
    if (search.unauthorized) {
      await suspend(name, credential)
      return { ok: false, error: SUSPENDED_ERROR }
    }
    if (search.hits.length === 0 && search.shape.results > 0) {
      // The shape only: the answer's field names and its block count, never its text.
      log(
        `${name}: the search answer listed results but carried no permalink — fields ${search.shape.fields.join(", ")}, result blocks ${search.shape.results}`,
      )
    }
    const skipped = []
    for (const hit of search.hits) {
      // A reissued hit is not one the scan left alone, so it is never counted
      // in today's skipped.
      if (candidates.has(hit.permalink)) {
        await handleReissue({ ...hit, workspace: name }, config)
        continue
      }
      if (seen.has(hit.permalink)) {
        skipped.push(hit.permalink)
        continue
      }
      await handleHit({ ...hit, workspace: name }, config)
    }
    // A failed scan is not an empty one: the workspace reports it.
    if (search.error) return { ok: false, error: search.error }
    if (search.rateLimited) return { ok: false, error: "rate limited" }
    return {
      ok: true,
      error: null,
      skipped,
      // Every permalink this workspace's search listed, seen or new, and
      // whether its paging saw the search's last page.
      listed: search.hits.map((hit) => hit.permalink),
      complete: search.complete === true,
    }
  }

  /** Whether a config can run a poll at all. */
  const usable = (config) =>
    Boolean(config) && config.intake_repo !== "" && config.session_directory !== ""

  /**
   * Outside the work window no scan runs, but the config's own state still
   * reaches the status: an unusable field is named there, and fixing it clears
   * the name, both with no Slack call. The status is written only when that
   * state changed, so a quiet closed window keeps the last scan's status.
   */
  async function withoutScan(previous, configError) {
    const cleared = configError === null && previous.configError != null
    if (!configError && !cleared) return previous
    const status = {
      ...previous,
      outcome: configError ?? (previous.outcome === previous.configError ? "ok" : previous.outcome),
      configError,
      today: await today(),
    }
    await writeStatus(status)
    return status
  }

  /**
   * One scan, and at most one at a time. A request that arrives while a scan
   * runs joins it instead of starting a second: the repeated refresh requests a
   * slow Slack answer invites share the running scan rather than multiplying the
   * HTTP traffic and the refresh sessions. A forced request is no exception —
   * the scan already running is the current one.
   */
  function scan({ config, configError }) {
    if (scanning) return scanning
    scanning = runScan({ config, configError }).finally(() => {
      scanning = null
    })
    return scanning
  }

  async function runScan({ config, configError }) {
    await storage.set(KEYS.lease, { owner, expires: now() + leaseMs })

    await reconcile()
    await reconcileReissues()

    const seen = new Set((await storage.get(KEYS.seen)) ?? [])
    const candidates = await reissueCandidates()
    const workspaces = []
    const skipped = []
    // Every permalink the scan listed, and whether each workspace's paging saw
    // the search's last page. A scan forgets only when both are whole.
    const listed = new Set()
    const completions = []
    let discoveryError = null
    let servers
    try {
      servers = (await mcpServers()).filter((server) => server.url === SLACK_MCP_URL)
    } catch (error) {
      // A failed discovery is not "no Slack servers": the poll reports it.
      discoveryError = `MCP servers were not read: ${messageOf(error)}`
      log(discoveryError)
      servers = []
    }
    for (const server of servers) {
      let outcome
      try {
        outcome = await scanWorkspace(server, config, seen, candidates)
      } catch (error) {
        log(`scan failed for ${server.name}: ${messageOf(error)}`)
        outcome = { ok: false, error: messageOf(error) }
      }
      workspaces.push({ name: server.name, ok: outcome.ok, error: outcome.error ?? null })
      skipped.push(...(outcome.skipped ?? []))
      for (const permalink of outcome.listed ?? []) listed.add(permalink)
      completions.push(outcome.ok === true && outcome.complete === true)
    }
    // A complete scan: there is at least one connected workspace and every one
    // answered with no error, no rate limit, a sign-in that held, and a paging
    // that saw the search's last page with no page-limit notice. Only after one
    // may the watcher forget a message a flag is gone from.
    const scanComplete =
      servers.length > 0 && discoveryError === null && completions.length === servers.length && completions.every(Boolean)
    if (scanComplete) {
      const forgotten = await forgetUnlisted({ listed, open: await readOpenIssues() })
      if (forgotten.length > 0) log(`forgot ${forgotten.length} unflagged permalink(s) whose issue is not open`)
    }
    const failed = workspaces.find((workspace) => !workspace.ok)
    const status = {
      lastPoll: new Date(now()).toISOString(),
      outcome: configError ?? discoveryError ?? failed?.error ?? "ok",
      workspaces,
      configError,
      today: await today({ skipped }),
    }
    await writeStatus(status)
    return { pollSeconds: config.poll_seconds, status }
  }

  /** One poll. Returns the config's poll interval and the status it wrote. */
  async function poll({ force = false } = {}) {
    const previous = await readStatus()
    const { config, error } = readConfig()
    if (error && !usable(config)) {
      const status = {
        lastPoll: previous.lastPoll ?? null,
        outcome: error,
        workspaces: [],
        configError: error,
        today: await today(),
      }
      await writeStatus(status)
      return { pollSeconds: DEFAULT_POLL_SECONDS, status }
    }
    const configError = error ?? null
    // Outside the window nothing is polled at all: no credential is resolved
    // and no Slack call is made. The config is still validated, so an unusable
    // field reaches the status even when no scan may run.
    if (!force && !inHours(config.work_hours, now())) {
      return { pollSeconds: config.poll_seconds, status: await withoutScan(previous, configError) }
    }
    const lease = await storage.get(KEYS.lease)
    if (
      !force &&
      lease &&
      lease.owner !== owner &&
      typeof lease.expires === "number" &&
      lease.expires > now()
    ) {
      // Another instance polls; the claim and commit files still hold.
      return { pollSeconds: config.poll_seconds, status: previous }
    }
    return scan({ config, configError })
  }

  /** A poll the user asked for: it clears every suspension and ignores the lease and the window. */
  async function pollNow() {
    await storage.set(KEYS.suspended, {})
    return poll({ force: true })
  }

  /**
   * The status the RPC contract serves. Today's counts are computed from the
   * item map now rather than left at the last scan's snapshot, so a first turn
   * that ends between scans is counted at once and the counts follow the
   * calendar day rather than a weekend's last scan.
   */
  async function status() {
    const stored = await readStatus()
    return { ...stored, today: await today(), poller: await readPoller() }
  }

  /**
   * Every item record, as the RPC contract serves them. An earlier build's
   * record is served too: its row is how the user opens the session it holds,
   * and the ones that need recovery are the ones an earlier build left. The
   * record's internal form is read here and not served.
   */
  async function items() {
    const records = Object.values(await readItems()).filter(
      (record) => record && typeof record.permalink === "string",
    )
    return { items: records.map(itemOfRecord) }
  }

  /** The config as the RPC contract serves it. */
  async function getConfig() {
    return { config: readConfig().config }
  }

  /** One field's new value, validated before the file is touched. */
  async function setConfig(input = {}) {
    return writeConfig(input.field, input.value)
  }

  /** The user opened one item's session. */
  async function markOpened(input = {}) {
    const sessionID = input.sessionID
    if (typeof sessionID !== "string") return {}
    const record = await itemOf(sessionID)
    if (!record) return {}
    await updateItem(record.permalink, sessionID, { openedAt: new Date(now()).toISOString() })
    return {}
  }

  /** The intake repo the close prompt names, as the config holds it now. */
  function intakeRepo() {
    try {
      return readConfig()?.config?.intake_repo ?? ""
    } catch {
      return ""
    }
  }

  /** The issue a close names, or `none` while its record names none. */
  const closeIssue = (close) =>
    typeof close.record?.issueUrl === "string" && close.record.issueUrl !== "" ? close.record.issueUrl : "none"

  /** The one line a close writes when it starts, so a close in flight is visible. */
  const logCloseStart = (close) => log(`close started: session ${close.sessionID} — issue ${closeIssue(close)}`)

  /** The one line a close writes when it ends, with its outcome. */
  const logCloseEnd = (close, outcome) =>
    log(`close ended: session ${close.sessionID} — issue ${closeIssue(close)} — ${outcome}`)

  /** Tell the dialog a close did not run, so the user is not left waiting for it. */
  function notifyRefused(sessionID, reason) {
    try {
      onRefused({ sessionID, reason })
    } catch (error) {
      log(`the refusal notice failed: ${messageOf(error)}`)
    }
  }

  /**
   * Refuse one close: its end line, the dialog's notice, and its map entry, so a
   * later `done` for the same item may try again. `detail` stays in the log; the
   * reason is what the dialog shows, and says what to do next.
   */
  function refuseClose(close, reason, detail) {
    logCloseEnd(close, detail ? `refused — ${reason} (${detail})` : `refused — ${reason}`)
    closes.delete(close.sessionID)
    notifyRefused(close.sessionID, reason)
  }

  /**
   * Drop the record of a close whose session the host reports gone. The issue is
   * left open: the plugin cannot prompt a session that no longer exists, so it
   * closed nothing, and both the log line and the dialog's notice say so.
   */
  async function closeSessionGone(close) {
    logCloseEnd(close, "record dropped — session gone, issue not closed")
    closes.delete(close.sessionID)
    notifyRefused(close.sessionID, "the session was gone — its intake issue was not closed")
    await dropSessionRecord(close.sessionID)
  }

  /**
   * The close flow of one item, in the order the close needs: the session is
   * read from the host first, its record is dropped only when the host reports
   * it gone, a session that is running or waits on a permission request refuses,
   * and otherwise the close notes the boundary, sends the close prompt and waits
   * for the session's next turn end. Nothing is removed here; the turn end
   * decides, in `decideCloseTurn`.
   */
  async function runClose(close) {
    const { sessionID, record } = close
    // Authoritative absence first: a session the host reports gone can never be
    // prompted, so only its record goes, and its intake issue stays open.
    let found
    try {
      found = await session.get({ sessionID })
    } catch (error) {
      if (close.abandoned) return
      if (notFound(error)) return closeSessionGone(close)
      return refuseClose(close, "the session could not be read — try again", messageOf(error))
    }
    if (close.abandoned) return
    if (found === undefined || found === null) return closeSessionGone(close)
    if (record.permissionPending === true) {
      return refuseClose(close, "the session waits on a permission request — answer it, then try again")
    }
    if (busyNow(found.time)) {
      return refuseClose(close, "the session is running — try again when it is idle")
    }
    // A record with no intake issue has nothing to close: its session goes now.
    // The removal is read here rather than through `removeSession`, so a host
    // refusal that is not "already gone" keeps the record and its retry path.
    if (typeof record.issueUrl !== "string" || record.issueUrl === "") {
      try {
        await session.remove({ sessionID })
      } catch (error) {
        if (close.abandoned) return
        if (!notFound(error)) {
          return refuseClose(close, "the session could not be deleted — try again", messageOf(error))
        }
      }
      if (close.abandoned) return
      logCloseEnd(close, "removed")
      closes.delete(sessionID)
      await dropSessionRecord(sessionID)
      return
    }
    // The boundary: the last message the session's context holds now. The close
    // reply is read only after it, so an earlier turn's line never decides.
    let list
    try {
      list = contextMessages(await session.context({ sessionID }))
    } catch (error) {
      if (close.abandoned) return
      return refuseClose(close, "the session's context could not be read — try again", messageOf(error))
    }
    if (close.abandoned) return
    close.boundaryID = list.length > 0 ? (list[list.length - 1]?.id ?? null) : null
    let admitted
    // The prompt is in flight: a turn end that arrives now is held, because the
    // admitted id that binds the close turn is not known yet.
    close.awaitingAdmission = true
    try {
      admitted = await session.prompt({ sessionID, text: closePrompt(record.issueUrl, intakeRepo()) })
    } catch (error) {
      close.awaitingAdmission = false
      if (close.abandoned) return
      if (notFound(error)) return closeSessionGone(close)
      return refuseClose(close, "the close prompt could not be sent — try again", messageOf(error))
    }
    close.awaitingAdmission = false
    if (close.abandoned) return
    // The host admits a prompt and answers its id at once; the close now waits
    // for this session's next turn end, bound to that admitted message.
    close.admittedID = admitted?.id ?? admitted?.data?.id
    if (typeof close.admittedID !== "string" || close.admittedID === "") {
      return refuseClose(close, "the close prompt's admission could not be read — try again")
    }
    // A turn end held while the admission was in flight is this close's next
    // turn end: decide it now, so no event is lost and the close never sticks.
    if (close.pendingTurnEnd !== undefined) {
      const failed = close.pendingTurnEnd
      close.pendingTurnEnd = undefined
      await decideCloseTurn(close, failed)
    }
  }

  /**
   * One turn end for a close whose prompt was admitted: the close is decided by
   * this turn alone, and by nothing else.
   */
  async function decideCloseTurn(close, failed) {
    const { sessionID } = close
    if (close.abandoned) return
    if (failed) return refuseClose(close, "the close turn did not succeed — try again")
    let list
    try {
      list = contextMessages(await session.context({ sessionID }))
    } catch (error) {
      if (close.abandoned) return
      return refuseClose(close, "the session's context could not be read — try again", messageOf(error))
    }
    if (close.abandoned) return
    const reply = closeReply(list, { boundaryID: close.boundaryID, admittedID: close.admittedID })
    if (reply.refused) return refuseClose(close, reply.refused)
    if (reply.url !== close.record.issueUrl) {
      return refuseClose(close, "the session's reply named another issue — try again")
    }
    // The reply names this record's own issue: remove the session, then drop the
    // record, so the row leaves even when the delete event is missed.
    try {
      await session.remove({ sessionID })
    } catch (error) {
      if (close.abandoned) return
      if (!notFound(error)) {
        return refuseClose(close, "the session could not be deleted — try again", messageOf(error))
      }
    }
    if (close.abandoned) return
    logCloseEnd(close, "removed")
    closes.delete(sessionID)
    await dropSessionRecord(sessionID)
  }

  /**
   * One turn-end event for a session with a close waiting. Answers whether a
   * close was waiting, so the first-turn path never reads the same event. A turn
   * end that arrives while the close prompt's admission is still in flight is
   * held, not dropped, and decided as soon as the admitted id is known.
   */
  async function closeTurnEnded(sessionID, failed) {
    const close = closes.get(sessionID)
    if (!close) return false
    if (close.abandoned) return true
    if (close.admittedID === undefined) {
      if (close.awaitingAdmission === true && close.pendingTurnEnd === undefined) close.pendingTurnEnd = failed
      return true
    }
    await decideCloseTurn(close, failed)
    return true
  }

  /**
   * Close one item for good: its own session closes its intake issue, and the
   * session is deleted only on the close turn's own proof. The call starts the
   * close and answers once it has started or refused it; the close itself runs
   * on in the background and is decided by the session's next turn end.
   */
  async function done(input = {}) {
    const sessionID = input?.sessionID
    if (typeof sessionID !== "string" || sessionID === "") return {}
    if (closesStopped) {
      log(`a close for session ${sessionID} was refused: the watcher has stopped`)
      return {}
    }
    // One close per session, taken before the first await: a second `done` in the
    // same instant starts nothing, and an unload during the record read abandons
    // this call before any close begins.
    if (closes.has(sessionID) || pendingDone.has(sessionID)) {
      log(`a close for session ${sessionID} is already in flight`)
      notifyRefused(sessionID, "a close for this item is already in flight")
      return {}
    }
    pendingDone.add(sessionID)
    try {
      const record = await itemOf(sessionID)
      if (closesStopped) {
        log(`a close for session ${sessionID} was refused: the watcher has stopped`)
        return {}
      }
      if (!record) {
        log(`a close for session ${sessionID} found no item record`)
        notifyRefused(sessionID, "this item is no longer in the list")
        return {}
      }
      const close = {
        sessionID,
        record,
        boundaryID: undefined,
        admittedID: undefined,
        awaitingAdmission: false,
        pendingTurnEnd: undefined,
        abandoned: false,
      }
      closes.set(sessionID, close)
      logCloseStart(close)
      await runClose(close)
    } catch (error) {
      const close = closes.get(sessionID)
      if (close) refuseClose(close, "the close failed — try again", messageOf(error))
      else log(`the close of session ${sessionID} failed: ${messageOf(error)}`)
    } finally {
      pendingDone.delete(sessionID)
    }
    return {}
  }

  /**
   * Stop the watcher: every close still in flight is abandoned. It makes no
   * further host call — in particular no remove — and each abandoned close
   * writes one log line. A `done` still reading its record is abandoned too: it
   * starts no close. The plugin's unload calls this.
   */
  function stop() {
    closesStopped = true
    for (const close of closes.values()) {
      close.abandoned = true
      logCloseEnd(close, "abandoned")
    }
    closes.clear()
  }

  /** The text the session's own reply ends with, or undefined. */
  async function readReply(sessionID) {
    try {
      return replyText(await session.context({ sessionID }))
    } catch (error) {
      log(`the reply of session ${sessionID} was not read: ${messageOf(error)}`)
      return undefined
    }
  }

  async function renameSession(sessionID, title) {
    try {
      await session.update({ sessionID, title })
    } catch (error) {
      log(`session ${sessionID} was not retitled: ${messageOf(error)}`)
    }
  }

  /**
   * The first turn of one item session ended. Only the first turn of a session
   * this instance started may complete the item, and only when it ends without
   * error and its reply names the issue it made: a turn that ended in error, a
   * turn whose reply names no issue, a later turn, and a turn whose start no
   * instance saw (a restart) all leave the item waiting, the pessimistic state
   * its record was written with. Once the first turn closes, whatever its
   * outcome, no later turn changes the record.
   */
  async function firstTurnEnded(sessionID, failed) {
    if (!firstTurns.has(sessionID)) return
    firstTurns.delete(sessionID)
    const record = await itemOf(sessionID)
    if (!record || record.firstTurnFailed !== true) return
    if (failed) return
    const text = await readReply(sessionID)
    const reply = text === undefined ? undefined : parseReply(text)
    // Both are needed: a turn this instance saw end without error, and a reply
    // that names the issue it made. An errorless reply with no issue URL leaves
    // the item waiting.
    if (!reply || !reply.issueUrl) return
    const written = await updateItem(record.permalink, sessionID, {
      firstTurnEndedAt: new Date(now()).toISOString(),
      firstTurnFailed: false,
      title: reply.title,
      issueUrl: reply.issueUrl,
      issueNumber: reply.issueNumber,
    })
    if (written) await renameSession(sessionID, reply.title)
  }

  async function permissionChanged(sessionID, pending) {
    const record = await itemOf(sessionID)
    if (!record || record.permissionPending === pending) return
    await updateItem(record.permalink, sessionID, { permissionPending: pending })
  }

  /** One event of the server's stream, for the sessions this plugin started. */
  async function observe(event) {
    const type = event?.type
    const sessionID = event?.data?.sessionID
    if (typeof sessionID !== "string" || sessionID === "") return
    if (Object.hasOwn(TURN_ENDED, type)) {
      // A close waiting for this session is decided by this turn alone.
      if (await closeTurnEnded(sessionID, TURN_ENDED[type])) return
      await firstTurnEnded(sessionID, TURN_ENDED[type])
      return
    }
    if (type === "session.deleted" || type === "session.archived") {
      await dropSessionRecord(sessionID)
      return
    }
    if (type === "permission.asked") await permissionChanged(sessionID, true)
    if (type === "permission.replied") await permissionChanged(sessionID, false)
  }

  /**
   * Clear the suspensions at load: the one other way out of a suspension
   * besides a changed credential and pollNow is a restart of OpenCode. No item
   * record is touched here, so a first turn whose end this instance never saw
   * keeps reading as waiting.
   */
  async function start() {
    await storage.set(KEYS.suspended, {})
  }

  return { poll, pollNow, status, items, getConfig, setConfig, markOpened, done, stop, observe, start, dropSessionRecord, applyIssueStates }
}
