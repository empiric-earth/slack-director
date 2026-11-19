// The watcher: one poll finds the messages the user flagged and gives each new
// one a session.
//
// A poll resolves each Slack MCP server's own OAuth credential, searches that
// workspace through MCP over HTTP, and claims every new permalink with the
// exclusive-create files in src/claims.js before it starts a session and sends
// the first prompt. The lease in plugin storage only spares two instances the
// same poll; the claim and commit files are what keep one flagged message to
// one prompted session.
import { randomUUID } from "node:crypto"
import { permalinkHash, STALE_MS } from "./claims.js"
import { DEFAULT_POLL_SECONDS } from "./config.js"
import { refreshPrompt, skeletonFirstPrompt } from "./first-prompt.js"
import { searchFlagged, SLACK_MCP_URL } from "./slack-mcp.js"
import { KEYS } from "./state.js"

/** The agent a refresh session runs on. */
export const REFRESH_AGENT = "slack-director-refresh"

/**
 * How long one instance's lease keeps another from polling. It is shorter than
 * the default poll interval, so a tick is never blocked by the previous tick's
 * lease.
 */
export const LEASE_MS = 30_000

/** The status of a workspace whose credential cannot be renewed. */
export const SUSPENDED_ERROR = "sign-in expired — run /mcps"

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

const emptyToday = () => ({ flagged: 0, nextStepsPosted: 0, skipped: 0 })

export function createWatcher({
  storage,
  claims,
  now = Date.now,
  fetch,
  readConfig,
  mcpServers,
  resolveCredential,
  session,
  log = () => {},
  leaseMs = LEASE_MS,
  staleMs = STALE_MS,
}) {
  const owner = randomUUID()

  const isExpired = (credential) =>
    credential?.expires !== 0 && credential?.expires !== undefined && credential.expires <= now()

  async function writeStatus(status) {
    await storage.set(KEYS.status, status)
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

  async function today({ skipped = 0 } = {}) {
    const day = new Date(now()).toISOString().slice(0, 10)
    const stored = (await storage.get(KEYS.today)) ?? { day, skipped: 0 }
    const counted = stored?.day === day ? stored : { day, skipped: 0 }
    const items = (await storage.get(KEYS.items)) ?? {}
    const records = Object.values(items)
    const onDay = (value) => typeof value === "string" && value.slice(0, 10) === day
    const next = { day, skipped: (counted.skipped ?? 0) + skipped }
    await storage.set(KEYS.today, next)
    return {
      flagged: records.filter((record) => onDay(record?.flaggedAt)).length,
      nextStepsPosted: records.filter((record) => onDay(record?.firstTurnEndedAt)).length,
      skipped: next.skipped,
    }
  }

  /** Write the item record and the seen-set entry for one permalink. */
  async function recordItem(record, seen) {
    const items = (await storage.get(KEYS.items)) ?? {}
    items[record.permalink] = record
    await storage.set(KEYS.items, items)
    seen.add(record.permalink)
    await storage.set(KEYS.seen, [...seen])
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
      await recordItem({ ...record, firstTurnFailed: true, firstTurnEndedAt: null }, seen)
    }
    claims.removeStaleTemporaries()
  }

  /** One new hit: claim it, create one session, commit it, then record and prompt it. */
  async function handleHit(hit, config, seen) {
    const hash = permalinkHash(hit.permalink)
    const generation = claims.claim(hash)
    if (generation === null) return
    let created
    try {
      created = await session.create({
        title: sessionTitle(hit),
        agent: config.triage_agent,
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
      flaggedAt: new Date(now()).toISOString(),
      title: sessionTitle(hit),
      sessionID: created.id,
      firstTurnFailed: true,
      firstTurnEndedAt: null,
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
    await recordItem(record, seen)
    try {
      await session.prompt({ sessionID: created.id, text: skeletonFirstPrompt(hit) })
    } catch (error) {
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

  async function scanWorkspace(server, config, seen) {
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
    let search = await searchFlagged({ fetch, url: server.url, token: credential.access, emoji: config.flag_emoji })
    if (search.unauthorized && !refreshed) {
      refreshed = true
      credential = (await refresh(name, config)) ?? credential
      search = await searchFlagged({ fetch, url: server.url, token: credential.access, emoji: config.flag_emoji })
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
    let skipped = 0
    for (const hit of search.hits) {
      if (seen.has(hit.permalink)) {
        skipped += 1
        continue
      }
      await handleHit({ ...hit, workspace: name }, config, seen)
    }
    if (search.rateLimited) return { ok: false, error: "rate limited" }
    return { ok: true, error: null, skipped }
  }

  /** One poll. Returns the config's poll interval and the status it wrote. */
  async function poll({ force = false } = {}) {
    const previous = await readStatus()
    const { config, error } = readConfig()
    if (error) {
      const status = {
        lastPoll: previous.lastPoll ?? null,
        outcome: `config error: ${error}`,
        workspaces: [],
        configError: error,
        today: await today(),
      }
      await writeStatus(status)
      return { pollSeconds: DEFAULT_POLL_SECONDS, status }
    }
    const lease = await storage.get(KEYS.lease)
    if (!force && lease && typeof lease.expires === "number" && lease.expires > now()) {
      // Another instance polls; the claim and commit files still hold.
      return { pollSeconds: config.poll_seconds, status: previous }
    }
    await storage.set(KEYS.lease, { owner, expires: now() + leaseMs })

    await reconcile()

    const seen = new Set((await storage.get(KEYS.seen)) ?? [])
    const workspaces = []
    let skipped = 0
    let servers
    try {
      servers = (await mcpServers()).filter((server) => server.url === SLACK_MCP_URL)
    } catch (error) {
      servers = []
      log(`MCP servers were not read: ${messageOf(error)}`)
    }
    for (const server of servers) {
      let outcome
      try {
        outcome = await scanWorkspace(server, config, seen)
      } catch (error) {
        log(`scan failed for ${server.name}: ${messageOf(error)}`)
        outcome = { ok: false, error: messageOf(error) }
      }
      workspaces.push({ name: server.name, ok: outcome.ok, error: outcome.error ?? null })
      skipped += outcome.skipped ?? 0
    }
    const failed = workspaces.find((workspace) => !workspace.ok)
    const status = {
      lastPoll: new Date(now()).toISOString(),
      outcome: failed ? failed.error : "ok",
      workspaces,
      configError: null,
      today: await today({ skipped }),
    }
    await writeStatus(status)
    return { pollSeconds: config.poll_seconds, status }
  }

  /** A poll the user asked for: it clears every suspension and ignores the lease. */
  async function pollNow() {
    await storage.set(KEYS.suspended, {})
    return poll({ force: true })
  }

  /** The status the RPC contract serves. */
  async function status() {
    return readStatus()
  }

  /**
   * Clear the suspensions at load: the task's one other way out of a suspension
   * besides a changed credential and pollNow is a restart of OpenCode.
   */
  async function start() {
    await storage.set(KEYS.suspended, {})
  }

  return { poll, pollNow, status, start }
}

function sessionTitle(hit) {
  return `Flagged message in ${hit.channel.label} — ${hit.ts}`
}
