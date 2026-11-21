// The TUI part: the overview page, its sidebar line and the settings dialog.
//
// The page draws the item map and the status through the RPC contract and the
// live state of each item's session from the TUI's own session data, and every
// line it shows comes from `src/page.js`, which holds the layout and the state
// rules. The element factory comes from the TUI host at load time: those
// renderer modules exist only inside a running TUI, so they are reached by a
// runtime import and the node suite loads this file without them.
import { spawn } from "node:child_process"
import { SlackDirectorRpc } from "./rpc.js"
import { FIELD_NAMES } from "./src/config.js"
import {
  KEY_HELP,
  PAGE_TITLE,
  countsText,
  fieldValue,
  headerText,
  openerCommand,
  pageRows,
  rowText,
  settingsValue,
  sidebarText,
  tableHeaderText,
  todayText,
} from "./src/page.js"

/** The page's palette entry and slash command. */
export const COMMAND_ID = "slack-director.page"

/** The settings dialog's palette entry. */
export const SETTINGS_COMMAND_ID = "slack-director.settings"

/** The route's name, as the page registers it. */
export const PAGE_NAME = "slack-director"

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * The TUI host's own element factory, or undefined outside a TUI. The host
 * serves `@opentui/solid` and `solid-js` to its plugins at runtime, so the
 * import answers inside OpenCode and fails in plain node, where nothing renders.
 */
export async function loadRenderer() {
  try {
    const [tui, solid] = await Promise.all([import("@opentui/solid"), import("solid-js")])
    const renderer = { createElement: tui.createElement, spread: tui.spread, createSignal: solid.createSignal }
    for (const [name, value] of Object.entries(renderer)) {
      if (typeof value !== "function") return undefined
    }
    return renderer
  } catch {
    return undefined
  }
}

/** A signal from the host's Solid runtime, or a plain holder outside a TUI. */
function signalOf(renderer, initial) {
  if (renderer) return renderer.createSignal(initial)
  let value = initial
  return [() => value, (next) => (value = next)]
}

/** One line of text, as the host's element. */
function line(renderer, text) {
  if (!renderer) return null
  const element = renderer.createElement("text")
  renderer.spread(element, { content: text })
  return element
}

/** The whole page, from the rows and the status. */
export function pageView({ renderer, rows, status, selected = 0, now = Date.now() }) {
  if (!renderer) return null
  const title = line(renderer, PAGE_TITLE)
  const header = line(renderer, headerText(status))
  const head = renderer.createElement("box")
  renderer.spread(head, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    children: [title, header],
  })
  const children = [
    head,
    line(renderer, countsText(rows)),
    line(renderer, ""),
    line(renderer, tableHeaderText()),
    ...rows.map((row, index) =>
      line(renderer, rowText(row.item, row.state, { selected: index === selected, now })),
    ),
    line(renderer, ""),
    line(renderer, todayText(status)),
    line(renderer, ""),
    line(renderer, KEY_HELP),
  ]
  const page = renderer.createElement("box")
  renderer.spread(page, { flexDirection: "column", children })
  return page
}

export default {
  id: "slack-director.tui",
  async setup(context) {
    const renderer = await loadRenderer()
    const [items, setItems] = signalOf(renderer, [])
    const [status, setStatus] = signalOf(renderer, undefined)
    const rpc = () => context.client.rpc(SlackDirectorRpc)
    const toast = (message, variant = "info") => context.ui.toast.show({ message, variant })

    /** What the TUI knows about one item's session, read where it is drawn. */
    const live = (item) => {
      try {
        return {
          running: context.data.session.status(item.sessionID) === "running",
          pending: (context.data.session.permission.list(item.sessionID) ?? []).length,
        }
      } catch {
        return {}
      }
    }

    const rows = () => pageRows(items(), live)

    async function refresh() {
      try {
        const client = rpc()
        const [list, state] = await Promise.all([client.items({}), client.status({})])
        setItems(list?.items ?? [])
        setStatus(state)
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
    }

    /** Open one item's session, and record that the user has read it. */
    async function openItem(item) {
      if (!item) return
      try {
        await rpc().markOpened({ sessionID: item.sessionID })
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
      context.ui.router.navigate({ type: "session", sessionID: item.sessionID })
    }

    /** Open a URL with the operating system's own opener; nothing else is opened. */
    function openUrl(url) {
      const command = openerCommand(url)
      if (!command) {
        toast(`${PAGE_TITLE}: not a web address: ${url ?? "none"}`)
        return
      }
      try {
        const child = spawn(command.command, command.args, { detached: true, stdio: "ignore" })
        child.on("error", () => {})
        child.unref()
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
    }

    async function pollNow() {
      try {
        await rpc().pollNow({})
        toast(`${PAGE_TITLE}: polling now`)
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
    }

    /** The config fields, one prompt per value, saved through the RPC contract. */
    async function openSettings() {
      let config
      try {
        config = (await rpc().getConfig({})).config
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
        return
      }
      const field = await context.ui.dialog.select({
        title: `${PAGE_TITLE}: settings`,
        options: FIELD_NAMES.map((name) => ({
          title: name,
          value: name,
          description: settingsValue(name, config?.[name]),
        })),
      })
      if (field === undefined) return
      const text = await context.ui.dialog.prompt({
        title: `${PAGE_TITLE}: ${field}`,
        value: settingsValue(field, config?.[field]),
      })
      if (text === undefined) return
      let value
      try {
        value = fieldValue(field, text)
      } catch (error) {
        toast(`${PAGE_TITLE}: ${field}: ${messageOf(error)}`, "error")
        return
      }
      try {
        await rpc().setConfig({ field, value })
        toast(`${PAGE_TITLE}: ${field} saved`, "success")
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
    }

    const unregisterPage = context.ui.router.register({
      name: PAGE_NAME,
      render: () => {
        const [selected, setSelected] = signalOf(renderer, 0)
        const current = () => rows()[selected()]?.item
        const move = (step) => {
          const count = rows().length
          if (count === 0) return
          setSelected((((selected() + step) % count) + count) % count)
        }
        context.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: [
            {
              id: `${COMMAND_ID}.open`,
              title: "Open the item's session",
              bind: "return",
              run: () => openItem(current()),
            },
            {
              id: `${COMMAND_ID}.issue`,
              title: "Open the intake issue",
              bind: "i",
              run: () => openUrl(current()?.issueUrl),
            },
            {
              id: `${COMMAND_ID}.slack`,
              title: "Open the message in Slack",
              bind: "s",
              run: () => openUrl(current()?.permalink),
            },
            {
              id: `${COMMAND_ID}.poll`,
              title: "Poll now",
              bind: "r",
              run: () => pollNow(),
            },
            {
              // The keymap reads a comma inside a binding string as the
              // separator between alternative bindings, so the comma key is
              // named `comma`, which is the name its own key events carry.
              id: `${COMMAND_ID}.settings`,
              title: "Settings",
              bind: "comma",
              run: () => openSettings(),
            },
            {
              id: `${COMMAND_ID}.back`,
              title: "Back",
              bind: "escape",
              run: () => context.ui.router.navigate({ type: "home" }),
            },
            { id: `${COMMAND_ID}.up`, title: "Move up", bind: "up", run: () => move(-1) },
            { id: `${COMMAND_ID}.down`, title: "Move down", bind: "down", run: () => move(1) },
          ],
        }))
        return pageView({ renderer, rows: rows(), status: status(), selected: selected() })
      },
    })

    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => line(renderer, sidebarText(rows())),
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: COMMAND_ID,
          title: PAGE_TITLE,
          group: "slack-director",
          palette: true,
          slash: { name: "slack-director" },
          run: async () => {
            await refresh()
            context.ui.router.navigate({ type: "plugin", name: PAGE_NAME })
          },
        },
        {
          id: SETTINGS_COMMAND_ID,
          title: `${PAGE_TITLE}: settings`,
          group: "slack-director",
          palette: true,
          run: () => openSettings(),
        },
      ],
    }))

    // The item map follows its own changes, and the page follows the item map.
    const unsubscribe = context.client.rpc(SlackDirectorRpc).events.on("updated", () => void refresh())
    void refresh()

    return () => {
      unsubscribe()
      unregisterSidebar()
      unregisterPage()
    }
  },
}
