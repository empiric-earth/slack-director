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
  DIALOG_INSET,
  DIALOG_SIZE,
  PAGE_TITLE,
  countsParts,
  fieldValue,
  footerParts,
  headerParts,
  moveSelection,
  openerCommand,
  pageRows,
  reconcileSelection,
  rowIDs,
  rowParts,
  sections,
  selectedItem,
  settingsValue,
  sidebarText,
  titleParts,
  todayParts,
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

/** The bold text attribute, as the host's own renderer names it (`TextAttributes.BOLD`). */
const BOLD = 1

/**
 * The theme colour one role takes, or undefined for the host's own default. The
 * waiting and working marks take step 200 of the theme's `orange` and `blue`
 * hue scales — a hue is a scale keyed by the steps 100 to 900, not a colour —
 * and fall back to the warning and info feedback text when the theme defines no
 * such hue.
 */
export function roleColour(theme, role) {
  const text = theme?.text ?? {}
  const hue = theme?.hue ?? {}
  switch (role) {
    case "title":
    case "base":
    case "age-calm":
      return text.base
    case "muted":
    case "state-idle":
    case "workspace-ok":
      return text.muted
    case "state-waiting":
      return hue?.orange?.[200] ?? text.feedback?.warning?.base
    case "state-working":
      return hue?.blue?.[200] ?? text.feedback?.info?.base
    case "age-warn":
    case "workspace-fail":
      return text.feedback?.warning?.base
    case "age-error":
      return text.feedback?.error?.base
    case "bar":
      return text.formfield?.focused
    default:
      return undefined
  }
}

/** The background the selected row takes across its whole width. */
export function selectedBackground(theme) {
  return theme?.background?.action?.primary?.focused
}

/**
 * One part of a line, as the host's text element. A part that carries an action
 * takes that action's mouse handlers, so the host's own mouse routing is what
 * decides a press landed on it.
 */
function textEl(renderer, segment, theme, press) {
  const element = renderer.createElement("text")
  const props = { content: segment.text }
  const colour = roleColour(theme, segment.role)
  if (colour !== undefined) props.fg = colour
  if (segment.bold) props.attributes = BOLD
  if (press) {
    props.onMouseDown = press.onMouseDown
    props.onMouseUp = press.onMouseUp
  }
  renderer.spread(element, props)
  return element
}

/** Whether a mouse event is a primary (left) button press. */
const isPrimary = (event) => !event || event.button === undefined || event.button === 0

/**
 * The handlers a clickable part takes. A physical primary click arrives as a
 * down and an up, not a click, so the action runs on the release — and only
 * once. Both events are consumed: the press starts no text selection, and the
 * release never reaches the dialog's own backdrop, which treats a release it
 * sees as a click outside and closes the view the action just opened.
 */
function primaryClick(run) {
  return {
    onMouseDown: (event) => {
      if (!isPrimary(event)) return
      event?.preventDefault?.()
      event?.stopPropagation?.()
    },
    onMouseUp: (event) => {
      if (!isPrimary(event)) return
      event?.preventDefault?.()
      event?.stopPropagation?.()
      run()
    },
  }
}

/** One line as a row of its parts. A part with an action takes that action's handlers. */
function rowBox(renderer, segments, theme, options = {}) {
  const box = renderer.createElement("box")
  const actions = options.actions ?? {}
  const props = {
    flexDirection: "row",
    children: segments.map((segment) => textEl(renderer, segment, theme, actions[segment.action])),
  }
  if (options.paddingLeft !== undefined) props.paddingLeft = options.paddingLeft
  if (options.paddingRight !== undefined) props.paddingRight = options.paddingRight
  if (options.justifyContent) props.justifyContent = options.justifyContent
  if (options.background !== undefined) props.backgroundColor = options.background
  renderer.spread(box, props)
  return box
}

/** One blank line. */
function blankLine(renderer) {
  const element = renderer.createElement("text")
  renderer.spread(element, { content: "" })
  return element
}

/** One plain line of text, in the host's own default colour. */
function plainLine(renderer, content) {
  const element = renderer.createElement("text")
  renderer.spread(element, { content })
  return element
}

/**
 * Every line of the dialog's body, in the order the mock lays them out: the
 * title row, the header line, the counts line, one section per state that has
 * rows — each a bold muted header, then its rows — the today line and the
 * footer, one blank line between each block.
 */
function bodyLines({ renderer, rows, status, selected, now, hours, theme, actions }) {
  const lines = [
    rowBox(renderer, titleParts(), theme, {
      paddingLeft: DIALOG_INSET,
      paddingRight: DIALOG_INSET,
      justifyContent: "space-between",
    }),
    rowBox(renderer, headerParts(read(status)), theme, { paddingLeft: DIALOG_INSET }),
    blankLine(renderer),
    rowBox(renderer, countsParts(read(rows)), theme, { paddingLeft: DIALOG_INSET }),
    blankLine(renderer),
  ]
  for (const section of sections(read(rows))) {
    lines.push(
      rowBox(renderer, [{ text: section.title, role: "muted", bold: true }], theme, { paddingLeft: DIALOG_INSET }),
    )
    for (const entry of section.entries) {
      const marked = entry.index === read(selected)
      lines.push(
        rowBox(renderer, rowParts(entry.row, { selected: marked, now: read(now), hours: read(hours) }), theme, {
          background: marked ? selectedBackground(theme) : undefined,
        }),
      )
    }
  }
  lines.push(blankLine(renderer), rowBox(renderer, todayParts(read(status)), theme, { paddingLeft: DIALOG_INSET }))
  lines.push(
    blankLine(renderer),
    rowBox(renderer, footerParts(), theme, { paddingLeft: DIALOG_INSET, actions }),
  )
  lines.push(blankLine(renderer))
  return lines
}

/**
 * The dialog's whole body. `rows`, `status`, `selected`, `now` and `hours` are
 * accessors, so the one reactive child the host renders reads them again
 * whenever the item map, the status, the selection or the config changes.
 * `actions` maps a part's action name to the click handler that runs it.
 */
export function dialogView({ renderer, rows, status, selected, now = Date.now, hours = () => undefined, theme, actions }) {
  if (!renderer) return null
  const body = renderer.createMemo(() => bodyLines({ renderer, rows, status, selected, now, hours, theme, actions }))
  const dialog = renderer.createElement("box")
  renderer.spread(dialog, { flexDirection: "column", children: body })
  return dialog
}

/**
 * The TUI part. The process spawner the URL opener uses is a parameter, so the
 * suite drives the keys with a recorder and never opens a browser; the renderer
 * the host serves is one too, so the suite drives the sidebar and the dialog
 * with a stub where no TUI is running.
 */
async function setup(context, spawnProcess, rendererOverride) {
    const renderer = rendererOverride ?? (await loadRenderer())
    const [items, setItems] = signalOf(renderer, [])
    const [status, setStatus] = signalOf(renderer, undefined)
    const [hours, setHours] = signalOf(renderer, undefined)
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

    // The marker follows an item's identity, not its index: the identity the
    // user last selected, and the display order they last saw. Both survive a
    // refresh, a confirmation and a restore, so the same item stays marked when
    // the rows are reordered and a removed item hands the marker to a neighbor.
    let selectedID = null
    let order = []

    /** Put the marker on one index, and remember the identity it sits on. */
    function select(index) {
      const list = rows()
      setSelected(index)
      selectedID = list[index]?.item?.sessionID ?? null
    }

    /**
     * Follow the rows after a change: keep the selected identity while it still
     * has a row, else take its neighbor in the order the user last saw.
     */
    function reconcile(identity = selectedID) {
      const list = rows()
      const at = reconcileSelection(list, identity, order)
      order = rowIDs(list)
      setSelected(at)
      selectedID = list[at]?.item?.sessionID ?? null
    }

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
        const [list, state, config] = await Promise.all([client.items({}), client.status({}), client.getConfig({})])
        setItems(list?.items ?? [])
        setStatus(state)
        setHours(config?.config?.work_hours)
        reconcile()
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
    }

    /** Move the marker one row, wrapping at both ends. */
    const move = (step) => select(moveSelection(selected(), rows().length, step))

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

    /**
     * Open a URL with the operating system's own opener; nothing else is opened.
     * An opener that cannot start reports it asynchronously, on the child's own
     * `error` event, so that failure is shown as well: otherwise the keys look
     * like they did nothing at all.
     */
    function openUrl(url) {
      const command = openerCommand(url)
      if (!command) {
        toast(`${PAGE_TITLE}: not a web address: ${url ?? "none"}`)
        return
      }
      try {
        const child = spawnProcess(command.command, command.args, { detached: true, stdio: "ignore" })
        child.on("error", (error) => toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error"))
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

    // Sessions whose close the watcher refused by event; `closeItem` reads it
    // so a refusal that beats the RPC answer is not overwritten.
    const refusedSessions = new Set()

    /**
     * Close one item for good, on the user's `d` or a click on the Done hint:
     * the confirm names the captured item and what the delete takes with it, and
     * only a yes calls `done`. The plugin closes the intake issue in the item's
     * own session and deletes the session on the close turn's own proof, so the
     * row leaves only then. The overview closes behind the confirm and comes
     * back on the captured item whatever the answer: a cancel, a refusal or a
     * failed request leaves the item visible and the overview usable.
     */
    async function closeItem(item) {
      if (!item) return
      const captured = { sessionID: item.sessionID, title: item.title }
      closeDialog()
      let confirmed
      try {
        confirmed = await context.ui.dialog.confirm({
          title: PAGE_TITLE,
          message: `Close the intake issue of “${captured.title}” and delete its session? The session and its child sessions are deleted, any turn in them stops, and this cannot be restored.`,
          label: { confirm: "Close and delete", cancel: "Cancel" },
        })
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
        restoreOverview(captured.sessionID)
        return
      }
      if (confirmed !== true) {
        restoreOverview(captured.sessionID)
        return
      }
      try {
        refusedSessions.delete(captured.sessionID)
        await rpc().done({ sessionID: captured.sessionID })
        // A refusal that arrived before the answer already told the user why;
        // "closing" would overwrite it.
        if (!refusedSessions.delete(captured.sessionID)) toast(`${PAGE_TITLE}: closing “${captured.title}”`)
      } catch (error) {
        toast(`${PAGE_TITLE}: ${messageOf(error)}`, "error")
      }
      // The row leaves only when the item's record does: the close's own
      // completion refreshes the list, and never reopens the overview.
      restoreOverview(captured.sessionID)
    }

    /**
     * Show the overview again, on the item the user left it on. The marker
     * follows that item's identity through any reordering, and when the item is
     * already gone it takes the neighbor the reconcile rule picks.
     */
    function restoreOverview(capturedID) {
      reconcile(capturedID)
      openOverview()
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

    /** The overview's own keys, as one modal layer its dialog owns. */
    function overviewKeys() {
      return context.keymap.layer(() => ({
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
          {
            id: `${COMMAND_ID}.done`,
            title: "Close the item and delete its session",
            bind: "d",
            run: () => void closeItem(current()),
          },
          { id: `${COMMAND_ID}.up`, title: "Move up", bind: "up", run: () => move(-1) },
          { id: `${COMMAND_ID}.down`, title: "Move down", bind: "down", run: () => move(1) },
        ],
      }))
    }

    /**
     * The click actions the dialog's parts carry. The Done hint runs the same
     * close the `d` key runs, on the row the marker is on at the click; the
     * click's own two events are consumed, so one physical click runs it once.
     */
    const dialogActions = () => ({
      done: primaryClick(() => void closeItem(current())),
    })

    /** Open the overview as a floating dialog over the current screen. */
    function openOverview() {
      // The dialog's own render registers the keys, so the host removes them
      // when it disposes the dialog: every dialog pushes the modal mode, so a
      // layer registered anywhere else would answer another dialog's keys and
      // the prompt's.
      context.ui.dialog.show(() => {
        if (dropOverviewLayer === null) dropOverviewLayer = overviewKeys()
        return dialogView({
          renderer,
          rows,
          status,
          selected,
          now: Date.now,
          hours,
          theme: theme(),
          actions: dialogActions(),
        })
      }, dropLayer)
      context.ui.dialog.set({ size: DIALOG_SIZE, centered: true })
    }

    /** Close the dialog the user is in, and its own keys with it. */
    function closeDialog() {
      context.ui.dialog.clear()
      dropLayer()
    }

    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => plainLine(renderer, sidebarText(rows())),
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
            select(0)
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
    // A close the watcher refuses reaches the dialog here, so the user is not
    // left waiting for a close that never ran: the reason says what to do next.
    const unsubscribeRefused = context.client.rpc(SlackDirectorRpc).events.on("closeRefused", (notice) => {
      if (notice?.sessionID) refusedSessions.add(notice.sessionID)
      toast(`${PAGE_TITLE}: ${notice?.reason ?? "the close was refused"}`, "error")
    })
    void refresh()

    return () => {
      unsubscribe()
      unsubscribeRefused()
      unregisterSidebar()
    }
}

/** The plugin the TUI host loads, over the operating system's own opener. */
export function createTui({ spawnProcess = spawn, renderer } = {}) {
  return { id: "slack-director.tui", setup: (context) => setup(context, spawnProcess, renderer) }
}

export default createTui()
