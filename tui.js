// The TUI part: the overview dialog, its sidebar line and the settings dialog.
//
// The overview is a floating dialog over the current screen, opened by the
// palette entry and by `/slack-director`, and its body is drawn from
// `src/page.js`, which holds the layout, the state rules and the colour roles.
// The dialog reads the item map and the status through the RPC contract and the
// live state of each item's session from the TUI's own session data.
//
// The host pushes its `modal` keymap mode while a dialog is open, so the keys
// are one modal layer registered with the dialog and dropped when it closes.
// The dialog's body is one reactive child of the host's Solid runtime: the
// host renders a dialog's body once, so every line that changes reads its
// signal inside that child rather than at render time.
//
// The element factory comes from the TUI host at load time: those renderer
// modules exist only inside a running TUI, so they are reached by a runtime
// import and the node suite loads this file without them.
import { spawn } from "node:child_process"
import { SlackDirectorRpc } from "./rpc.js"
import { FIELD_NAMES } from "./src/config.js"
import {
  DIALOG_SIZE,
  KEY_HELP,
  PAGE_TITLE,
  colourRole,
  countsText,
  fieldValue,
  headerParts,
  moveSelection,
  openerCommand,
  pageRows,
  rowText,
  selectedItem,
  settingsValue,
  sidebarText,
  tableHeaderText,
  todayText,
} from "./src/page.js"

/** The dialog's palette entry and slash command. */
export const COMMAND_ID = "slack-director.page"

/** The settings dialog's palette entry. */
export const SETTINGS_COMMAND_ID = "slack-director.settings"

/** A message for a toast or a log: an error's own text, whatever its shape. */
const messageOf = (error) => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error.message === "string") return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * The TUI host's own renderer, or undefined outside a TUI. The host serves
 * `@opentui/solid` and `solid-js` to its plugins at runtime, so the import
 * answers inside OpenCode and fails in plain node, where nothing renders.
 */
export async function loadRenderer() {
  try {
    const [tui, solid] = await Promise.all([import("@opentui/solid"), import("solid-js")])
    const renderer = {
      createElement: tui.createElement,
      spread: tui.spread,
      createSignal: solid.createSignal,
      createMemo: solid.createMemo,
    }
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

/** Read a value that may be a signal's accessor. */
const read = (value) => (typeof value === "function" ? value() : value)

/** The theme colour one role takes, or undefined when the theme is absent. */
export function roleColour(theme, role) {
  const text = theme?.text ?? {}
  if (role === "attention") return text.feedback?.warning?.base
  if (role === "dimmed") return text.muted
  return text.base
}

/** One line of text, as the host's element. */
function line(renderer, content, colour) {
  const element = renderer.createElement("text")
  renderer.spread(element, colour === undefined ? { content } : { content, fg: colour })
  return element
}

/** One row's line, with the colour its role takes. */
function rowLine(renderer, row, index, selected, now, theme) {
  const marked = index === read(selected)
  const colour = roleColour(theme, colourRole("row", { state: row.state, selected: marked }))
  return line(renderer, rowText(row.item, row.state, { selected: marked, now: read(now) }), colour)
}

/** Every line of the dialog's body, in the order the mock lays them out. */
function bodyLines({ renderer, rows, status, selected, now, theme }) {
  const dimmed = roleColour(theme, "dimmed")
  const title = line(renderer, PAGE_TITLE, dimmed)
  const header = renderer.createElement("box")
  renderer.spread(header, {
    flexDirection: "row",
    children: headerParts(read(status)).map((part) => line(renderer, part.text, roleColour(theme, part.role))),
  })
  const head = renderer.createElement("box")
  renderer.spread(head, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    children: [title, header],
  })
  const lines = [
    head,
    line(renderer, countsText(read(rows)), dimmed),
    line(renderer, ""),
    line(renderer, tableHeaderText(), dimmed),
  ]
  for (const [index, row] of read(rows).entries()) {
    lines.push(rowLine(renderer, row, index, selected, now, theme))
  }
  lines.push(line(renderer, ""), line(renderer, todayText(read(status)), dimmed))
  lines.push(line(renderer, ""), line(renderer, KEY_HELP, dimmed))
  return lines
}

/**
 * The dialog's whole body. `rows`, `status`, `selected` and `now` are
 * accessors, so the one reactive child the host renders reads them again
 * whenever the item map, the status or the selection changes.
 */
export function dialogView({ renderer, rows, status, selected, now = Date.now, theme }) {
  if (!renderer) return null
  const body = renderer.createMemo(() => bodyLines({ renderer, rows, status, selected, now, theme }))
  const dialog = renderer.createElement("box")
  renderer.spread(dialog, { flexDirection: "column", children: body })
  return dialog
}

/**
 * The TUI part. The process spawner the URL opener uses is a parameter, so the
 * suite drives the keys with a recorder and never opens a browser.
 */
async function setup(context, spawnProcess) {
    const renderer = await loadRenderer()
    const [items, setItems] = signalOf(renderer, [])
    const [status, setStatus] = signalOf(renderer, undefined)
    const [selected, setSelected] = signalOf(renderer, 0)
    const rpc = () => context.client.rpc(SlackDirectorRpc)
    const toast = (message, variant = "info") => context.ui.toast.show({ message, variant })
    const theme = () => context.theme ?? {}

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
    const current = () => selectedItem(rows(), selected())

    /** The overview's own key layer, while its dialog is open. */
    let dropOverviewLayer = null

    /**
     * Drop the overview's key layer. The host pushes its `modal` mode for any
     * dialog, so a layer left behind would answer the keys of the dialog that
     * replaced it, and that dialog's own keys would never reach it.
     */
    function dropLayer() {
      if (typeof dropOverviewLayer === "function") dropOverviewLayer()
      dropOverviewLayer = null
    }

    async function refresh() {
      try {
        const client = rpc()
        const [list, state] = await Promise.all([client.items({}), client.status({})])
        setItems(list?.items ?? [])
        setStatus(state)
        const count = (list?.items ?? []).length
        if (selected() >= count) setSelected(moveSelection(0, count, 0))
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
    }

    /** Move the marker one row, wrapping at both ends. */
    const move = (step) => setSelected(moveSelection(selected(), rows().length, step))

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
        const child = spawnProcess(command.command, command.args, { detached: true, stdio: "ignore" })
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
        toast(`${PAGE_TITLE}: ${field}: ${messageOf(error)}`, "error")
      }
    }

    /** Open the overview as a floating dialog over the current screen. */
    function openOverview() {
      dropOverviewLayer = context.keymap.layer(() => ({
        mode: "modal",
        priority: 20,
        commands: [
          {
            id: `${COMMAND_ID}.open`,
            title: "Open the item's session",
            bind: "return",
            run: () => {
              const item = current()
              closeDialog()
              void openItem(item)
            },
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
            run: () => void pollNow(),
          },
          {
            id: `${COMMAND_ID}.settings`,
            title: "Settings",
            bind: "e",
            run: () => {
              closeDialog()
              void openSettings()
            },
          },
          { id: `${COMMAND_ID}.up`, title: "Move up", bind: "up", run: () => move(-1) },
          { id: `${COMMAND_ID}.down`, title: "Move down", bind: "down", run: () => move(1) },
        ],
      }))
      context.ui.dialog.show(
        () => dialogView({ renderer, rows, status, selected, now: Date.now, theme: theme() }),
        dropLayer,
      )
      context.ui.dialog.set({ size: DIALOG_SIZE, centered: true })
    }

    /** Close the dialog the user is in, and its own keys with it. */
    function closeDialog() {
      context.ui.dialog.clear()
      dropLayer()
    }

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
            setSelected(0)
            openOverview()
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

    // The item map follows its own changes, and the dialog follows the item map.
    const unsubscribe = context.client.rpc(SlackDirectorRpc).events.on("updated", () => void refresh())
    void refresh()

    return () => {
      unsubscribe()
      unregisterSidebar()
    }
}

/** The plugin the TUI host loads, over the operating system's own opener. */
export function createTui({ spawnProcess = spawn } = {}) {
  return { id: "slack-director.tui", setup: (context) => setup(context, spawnProcess) }
}

export default createTui()
