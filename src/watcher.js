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
import { itemFirstPrompt, refreshPrompt } from "./first-prompt.js"
import { parseReply, replyText } from "./reply.js"
import { REQUEST_TIMEOUT_MS, searchFlagged, SLACK_MCP_URL } from "./slack-mcp.js"
import { KEYS } from "./state.js"
import { inWorkHours } from "./work-hours.js"

/** The agent a refresh session runs on. */
export const REFRESH_AGENT = "slack-director-refresh"

/** The record form this build writes; a record without it is an earlier build's. */
export const RECORD_FORMAT = 2

/**
 * How long one instance's lease keeps another from polling. An instance's own
 * lease never blocks it, so a tick is never skipped by the lease the tick
 * before it left; a lease that outlives a configured interval still spares a
 * second instance the same tick.
 */
export const LEASE_MS = 30_000

/** The status of a workspace whose credential cannot be renewed. */
export const SUSPENDED_ERROR = "sign-in expired — run /mcps"

/** The events an item session's progress arrives in. */
export const SESSION_EVENT_TYPES = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
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
    firstTurnEndedAt: record.firstTurnEndedAt ?? null,
    firstTurnFailed: record.firstTurnFailed === true,
    permissionPending: record.permissionPending === true,
    openedAt: record.openedAt ?? null,
  }
}

export function createWatcher({
  storage,
  claims,
  now = Date.now,
  fetch,
  readConfig,
  writeConfig = () => ({ error: { field: null, message: "the config file is not writable" } }),
  onChange = () => {},
  mcpServers,
  resolveCredential,
  session,
  log = () => {},
  leaseMs = LEASE_MS,
  staleMs = STALE_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  inHours = inWorkHours,
  reissue = NO_REISSUE,
}) {
  const owner = randomUUID()
  // The item sessions this instance started and whose first turn it is still
  // waiting on. A turn-end event completes the item only for one of these, so a
  // later turn, or a turn whose start this instance never saw, cannot.
  const firstTurns = new Set()
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

  /** Replace one item record, one writer at a time. */
  async function updateItem(record) {
    await serializedWrite(async () => {
      const items = await readItems()
      items[record.permalink] = record
      await storage.set(KEYS.items, items)
    })
    changed()
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

  /** Whether an error means the session is gone rather than unreadable. */
  const notFound = (error) =>
    error?.code === "NOT_FOUND" || /not found|no such session/i.test(messageOf(error))

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
    if (times.busy !== undefined && times.busy !== null) {
      if (!(typeof times.idle === "number" && times.idle >= times.busy)) {
        return { quiet: false, reason: `a busy period that began at ${times.busy} has not ended` }
      }
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
    await updateItem(next)
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
      await updateItem({
        ...record,
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
    const record = {
      permalink: hit.permalink,
      workspace: hit.workspace,
      channel: hit.channel.label,
      channelID: hit.channel.id,
      ts: hit.ts,
      asker: hit.asker ?? "",
      flaggedAt: new Date(now()).toISOString(),
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
    return { ok: true, error: null, skipped }
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
    return { ...stored, today: await today() }
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
    await updateItem({ ...record, openedAt: new Date(now()).toISOString() })
    return {}
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
    const next = {
      ...record,
      firstTurnEndedAt: new Date(now()).toISOString(),
      firstTurnFailed: false,
      title: reply.title,
      issueUrl: reply.issueUrl,
      issueNumber: reply.issueNumber,
    }
    await updateItem(next)
    await renameSession(sessionID, reply.title)
  }

  async function permissionChanged(sessionID, pending) {
    const record = await itemOf(sessionID)
    if (!record || record.permissionPending === pending) return
    await updateItem({ ...record, permissionPending: pending })
  }

  /** One event of the server's stream, for the sessions this plugin started. */
  async function observe(event) {
    const type = event?.type
    const sessionID = event?.data?.sessionID
    if (typeof sessionID !== "string" || sessionID === "") return
    if (Object.hasOwn(TURN_ENDED, type)) {
      await firstTurnEnded(sessionID, TURN_ENDED[type])
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

  return { poll, pollNow, status, items, getConfig, setConfig, markOpened, observe, start }
}
