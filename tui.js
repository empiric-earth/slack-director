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
  hasSession,
  headerLines,
  legendParts,
  moveSelection,
  openerCommand,
  pageRows,
  reconcileSelection,
  rowID,
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

/**
 * What `enter` says on a row whose open issue has no session behind it: the row
 * is opened in the browser, and the request is handled on GitHub.
 */
export const NO_SESSION_OPEN_NOTICE = "this request has no session — its issue is open on GitHub"

/**
 * What `d` says on the same row: there is no session to close, and the issue is
 * closed by hand on GitHub.
 */
export const NO_SESSION_CLOSE_NOTICE = "this request has no session — close its issue on GitHub"

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
 * dialog title, the section titles and the attention parts take the theme's
 * primary action text, and fall back to the colour each took before the theme
 * named one. The new-activity mark takes step 200 of the theme's `yellow` hue
 * scale, and falls back to the warning feedback text; the waiting and working
 * marks take step 200 of the `orange` and `blue` scales — a hue is a scale keyed
 * by the steps 100 to 900, not a colour — and fall back to the warning and info
 * feedback text when the theme defines no such hue.
 */
export function roleColour(theme, role) {
  const text = theme?.text ?? {}
  const hue = theme?.hue ?? {}
  const primary = text.action?.primary?.base
  switch (role) {
    case "title":
      return primary ?? text.base
    case "section":
      return primary ?? text.muted
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
    case "new-activity":
      return hue?.yellow?.[200] ?? text.feedback?.warning?.base
    case "age-warn":
      return text.feedback?.warning?.base
    case "workspace-fail":
      return primary ?? text.feedback?.warning?.base
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
 * decides which part a press hits.
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
 * title row, the header's own lines — the Slack scan, then the poller once a
 * cycle has run — the counts line, one section per state that has rows — each a
 * bold accented header, then its rows — the today line, the legend of the row
 * marks and the footer, one blank line between each block but none between the
 * legend and the footer. Two sections that are both shown take exactly one blank
 * line between them, and a section's header is followed by its first row with no
 * blank between.
 */
function bodyLines({ renderer, rows, status, selected, now, hours, theme, actions }) {
  const lines = [
    rowBox(renderer, titleParts(), theme, {
      paddingLeft: DIALOG_INSET,
      paddingRight: DIALOG_INSET,
      justifyContent: "space-between",
      actions,
    }),
  ]
  for (const header of headerLines(read(status))) {
    lines.push(rowBox(renderer, header, theme, { paddingLeft: DIALOG_INSET }))
  }
  lines.push(blankLine(renderer), rowBox(renderer, countsParts(read(rows)), theme, { paddingLeft: DIALOG_INSET }))
  lines.push(blankLine(renderer))
  for (const [position, section] of sections(read(rows)).entries()) {
    // One blank line between two visible groups, and none before the first one
    // and none between a heading and its first row.
    if (position > 0) lines.push(blankLine(renderer))
    lines.push(
      rowBox(renderer, [{ text: section.title, role: "section", bold: true }], theme, { paddingLeft: DIALOG_INSET }),
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
  // The legend sits directly above the footer, so it is the last line a reader
  // passes before the keys.
  lines.push(
    blankLine(renderer),
    rowBox(renderer, legendParts(), theme, { paddingLeft: DIALOG_INSET }),
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
      if (!hasSession(item)) return {}
      try {
        return {
          running: context.data.session.status(item.sessionID) === "running",
          pending: (context.data.session.permission.list(item.sessionID) ?? []).length,
        }
      } catch {
        return {}
      }
    }

    /**
     * The rows the dialog shows: one per item whose issue is still open, and one
     * per unattended open issue the poller's last cycle reported.
     */
    const rows = () => pageRows(items(), live, status()?.poller?.unattended ?? [])
    const current = () => selectedItem(rows(), selected())

    // The marker follows a row's identity, not its index: the identity the
    // `rowID` helper gives the row the user last selected — an item's session,
    // or an unattended issue's number — and the display order they last saw.
    // Both survive a refresh, a confirmation and a restore, so the same row
    // stays marked when the rows are reordered and a removed row hands the
    // marker to a neighbor.
    let selectedID = null
    let order = []

    /** Put the marker on one index, and remember the identity it sits on. */
    function select(index) {
      const list = rows()
      setSelected(index)
      selectedID = rowID(list[index])
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
      selectedID = rowID(list[at])
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
     * failed request leaves the item visible and the overview usable. It comes
     * back as soon as the user answers, not when the close settles, so a late
     * answer can never reopen a view the user has left.
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
        restoreOverview()
        return
      }
      if (confirmed !== true) {
        restoreOverview()
        return
      }
      // The overview comes back on the user's yes, before the close is sent and
      // without waiting for it: the answer settles on its own time, and a late
      // answer, a refusal or a failure only adds a notice. Nothing in that
      // continuation touches the dialog, so a stale one can never reopen a view
      // the user has since left, or move its selection.
      restoreOverview()
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
    }

    /**
     * Show the overview again, on the item the user left it on. The marker
     * already follows that item's identity through any reordering, and a
     * refresh that ran while the confirm was up has already handed a removed
     * item's marker to its neighbor, so the restore keeps the rows' own
     * reconcile result instead of reconciling the captured identity again.
     */
    function restoreOverview() {
      reconcile()
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

    /**
     * The operations the overview's keys and its clickable parts both run, so a
     * click on a control and its shortcut can never drift apart. Each one acts on
     * the row the marker is on at that moment; a click with no row to act on runs
     * the same no-op the key does.
     */
    const closeOverview = () => closeDialog()
    const openSelected = () => {
      const item = current()
      // An unattended row has no session to open: its issue is opened with `i`,
      // and the overview stays up so the marked row is still there.
      if (item && !hasSession(item)) {
        toast(`${PAGE_TITLE}: ${NO_SESSION_OPEN_NOTICE}`)
        return
      }
      closeDialog()
      void openItem(item)
    }
    const openSelectedIssue = () => openUrl(current()?.issueUrl)
    const openSelectedSlack = () => openUrl(current()?.permalink)
    const pollNowFromOverview = () => void pollNow()
    const openSettingsFromOverview = () => {
      closeDialog()
      void openSettings()
    }
    const closeSelectedItem = () => {
      const item = current()
      // An unattended row has no session to close: the user closes its issue on
      // GitHub, and nothing here removes the row.
      if (item && !hasSession(item)) {
        toast(`${PAGE_TITLE}: ${NO_SESSION_CLOSE_NOTICE}`)
        return
      }
      void closeItem(item)
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
            run: openSelected,
          },
          {
            id: `${COMMAND_ID}.issue`,
            title: "Open the intake issue",
            bind: "i",
            run: openSelectedIssue,
          },
          {
            id: `${COMMAND_ID}.slack`,
            title: "Open the message in Slack",
            bind: "s",
            run: openSelectedSlack,
          },
          {
            id: `${COMMAND_ID}.poll`,
            title: "Poll now",
            bind: "r",
            run: pollNowFromOverview,
          },
          {
            id: `${COMMAND_ID}.settings`,
            title: "Settings",
            bind: "e",
            run: openSettingsFromOverview,
          },
          {
            id: `${COMMAND_ID}.done`,
            title: "Close the item and delete its session",
            bind: "d",
            run: closeSelectedItem,
          },
          { id: `${COMMAND_ID}.up`, title: "Move up", bind: "up", run: () => move(-1) },
          { id: `${COMMAND_ID}.down`, title: "Move down", bind: "down", run: () => move(1) },
        ],
      }))
    }

    /**
     * The click actions the dialog's parts carry, one per control: the `esc` hint
     * closes the overview, and each footer key and its label run that key's own
     * operation. Every one is wrapped so a physical primary click runs it once —
     * on the release, with both events consumed, so the release never reaches the
     * dialog's backdrop. A part with no action carries no handler at all.
     */
    const dialogActions = () => ({
      close: primaryClick(closeOverview),
      session: primaryClick(openSelected),
      issue: primaryClick(openSelectedIssue),
      slack: primaryClick(openSelectedSlack),
      refresh: primaryClick(pollNowFromOverview),
      settings: primaryClick(openSettingsFromOverview),
      done: primaryClick(closeSelectedItem),
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
