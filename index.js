// opencode-slack-director: delivers the Slack Director's skill to OpenCode,
// and polls Slack for the messages the user flagged so each new one gets a
// session.
//
// The server part is the plugin's only host adapter: the skill registration,
// the RPC contract, the session-progress subscription and the watcher's timer
// are wired here, and every piece of behaviour lives in the modules under src/,
// so the whole watcher replays in the node suite with a fake context and a fake
// HTTP layer.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SlackDirectorRpc } from "./rpc.js"
import { createClaims } from "./src/claims.js"
import { createConfigReader, DEFAULT_POLL_SECONDS } from "./src/config.js"
import { claimsDir, reissueDir } from "./src/state.js"
import { createWatcher, SESSION_EVENT_TYPES } from "./src/watcher.js"

/** The skill this package ships. */
export const SKILL = "slack-director"

/** Split a SKILL.md into its frontmatter fields and its body. */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!m) throw new Error("SKILL.md has no frontmatter")
  const field = (key) => {
    const line = m[1].split(/\r?\n/).find((l) => l.startsWith(key + ":"))
    if (!line) throw new Error(`SKILL.md frontmatter has no ${key}`)
    return line.slice(key.length + 1).trim()
  }
  return { name: field("name"), description: field("description"), body: m[2] }
}

/** The path of one skill's SKILL.md, beside this file in the repo or installed. */
export function skillPath(name) {
  return fileURLToPath(new URL(`./skills/${name}/SKILL.md`, import.meta.url))
}

/** Every configured MCP server, with the URL a remote one is reached at. */
async function mcpServers(ctx) {
  let servers = []
  await ctx.mcp.transform((editor) => {
    servers = editor.list().map(([name, config]) => ({
      name,
      url: config && config.type === "remote" ? config.url : undefined,
    }))
  })
  return servers
}

/** The OAuth credential a Slack MCP server is signed in with, if it is signed in. */
async function resolveCredential(ctx, name) {
  const listed = await ctx.mcp.list()
  const server = (listed?.data ?? []).find((candidate) => candidate.name === name)
  if (!server?.integrationID) return undefined
  const connection = await ctx.integration.connection.active(server.integrationID)
  if (!connection) return undefined
  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type !== "oauth") return undefined
  return { access: credential.access, expires: credential.expires }
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

export default {
  id: "slack-director",
  async setup(ctx) {
    const log = (message) => console.warn(`slack-director: ${message}`)
    const skillRegistration = await ctx.skill.transform((editor) => {
      const path = skillPath(SKILL)
      const skill = parseSkill(readFileSync(path, "utf8"))
      editor.add({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        path,
        content: skill.body,
      })
    })

    const config = createConfigReader()
    // The watcher's change notice goes out through the RPC registration, which
    // is created after it: the holder is filled in as soon as that returns.
    let emitUpdated = () => {}
    const watcher = createWatcher({
      storage: ctx.storage,
      claims: createClaims({ dir: claimsDir(), randomID: () => randomUUID() }),
      // The reissue's own claim and commit files, beside the main claims.
      reissue: createClaims({ dir: reissueDir(), randomID: () => randomUUID() }),
      now: () => Date.now(),
      fetch: (url, init) => fetch(url, init),
      readConfig: () => config.read(),
      writeConfig: (field, value) => config.write(field, value),
      onChange: () => emitUpdated(),
      mcpServers: () => mcpServers(ctx),
      resolveCredential: (name) => resolveCredential(ctx, name),
      session: ctx.session,
      log,
    })
    const rpcRegistration = await ctx.rpc.register(SlackDirectorRpc, {
      status: () => watcher.status(),
      items: () => watcher.items(),
      getConfig: () => watcher.getConfig(),
      setConfig: async (input, context) => {
        const result = await watcher.setConfig(input)
        if (result.error) return context.error("invalid", result.error.message, { field: result.error.field })
        return result
      },
      // A poll can take a whole workspace's deadline, so the call starts one and
      // answers at once: the `updated` event tells the caller when it finished.
      // The handler answers a promise, which is what the RPC layer awaits.
      pollNow: async () => {
        void watcher.pollNow().catch((error) => log(`poll now failed: ${messageOf(error)}`))
        return {}
      },
      // A close can wait on a sparta approval in the item session, so the call
      // starts it and answers at once; the close's outcome reaches the dialog as
      // the item's record leaving.
      done: async (input) => {
        void watcher.done(input).catch((error) => log(`the close failed: ${messageOf(error)}`))
        return {}
      },
      markOpened: (input) => watcher.markOpened(input),
    })
    emitUpdated = () => {
      rpcRegistration.events.emit("updated", {}).catch((error) => log(`the update notice failed: ${messageOf(error)}`))
    }
    await watcher.start()

    // The item map follows its own sessions: a turn that ends and a permission
    // request that arrives are events, not polls.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: SESSION_EVENT_TYPES, signal: controller.signal })) {
          try {
            await watcher.observe(event)
          } catch (error) {
            log(`a session event was not handled: ${messageOf(error)}`)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`the event stream ended: ${messageOf(error)}`)
      }
    })()

    // One poll, then the next one after the config's interval: a changed
    // interval takes effect on the next tick rather than at the next restart.
    let timer
    let stopped = false
    const tick = async () => {
      let seconds = DEFAULT_POLL_SECONDS
      try {
        const result = await watcher.poll()
        seconds = result?.pollSeconds ?? seconds
      } catch (error) {
        log(`poll failed: ${messageOf(error)}`)
      }
      // A tick that was already running when the plugin unloaded must not
      // schedule the next one.
      if (stopped) return
      timer = setTimeout(() => {
        void tick()
      }, seconds * 1000)
    }
    timer = setTimeout(() => {
      void tick()
    }, 0)

    return async () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      // The watcher stops first: a close still in flight is abandoned before it
      // can remove anything the next install would not know about.
      watcher.stop()
      await rpcRegistration.dispose()
      await skillRegistration.dispose()
    }
  },
}
