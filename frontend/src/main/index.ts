import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@common/api'
import type { AgentLive, Approval, FileChange, IntegrationStatus, MemoryItem, Review, Run, TraceEntry, Workflow } from '@shared/types'
import { api, streamEvents } from './backend'
import { handleShow, passThrough, setupShow } from './show'
import { bootBackend, restartBackend, stopBackend } from './server'
import { runSetup } from './setup'

const SHORTCUT = process.env.OGGY_SHORTCUT || 'Control+Space'

let dashboard: BrowserWindow | null = null
let commandBar: BrowserWindow | null = null
let tray: Tray | null = null
let hideTimer: NodeJS.Timeout | null = null
let backendOnline = false
/** A job is running: keep the bar up when you click elsewhere. */
let barPinned = false
/** The big review screen is open: the whole bar window takes the mouse. */
let reviewOpen = false
/** On the way out: windows may really close now. */
let quitting = false

// The bar window covers the screen's work area, transparent and click-through except over the
// bar itself (see IPC.barInteractive). That way the bar can glide between the centre (asking) and
// any corner (working) as a GPU transform, instead of dragging a window around.
// Matches the leave transition in styles.css.
const BAR_LEAVE_MS = 150
/** How long a clean quit gets before Oggy simply exits. */
const QUIT_MS = 1500

function loadRenderer(win: BrowserWindow, route: 'dashboard' | 'bar' | 'show' | 'setup') {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${route}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

const webPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: 'Oggy',
    backgroundColor: '#0d0d0f',
    show: false,
    webPreferences
  })
  dashboard.once('ready-to-show', () => dashboard?.show())
  // Oggy keeps running in the tray; the dashboard is opened on demand.
  dashboard.on('closed', () => (dashboard = null))
  loadRenderer(dashboard, 'dashboard')
}

function openDashboard() {
  if (!dashboard) return createDashboard()
  if (dashboard.isMinimized()) dashboard.restore()
  dashboard.show()
  dashboard.focus()
}

function createCommandBar() {
  commandBar = new BrowserWindow({
    ...screen.getPrimaryDisplay().workArea,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false, // drawn in CSS so it follows the rounded bar
    backgroundColor: '#00000000',
    webPreferences: { ...webPreferences, backgroundThrottling: false }
  })
  commandBar.setAlwaysOnTop(true, 'pop-up-menu')
  commandBar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  passThrough(commandBar, false)
  commandBar.on('blur', () => {
    // The review stays open behind your other apps; everything else hides when you click away.
    if (!barPinned && !reviewOpen) hideCommandBar()
  })
  // Alt+F4 or the taskbar must not destroy the bar: everything Oggy knows about it would go stale.
  commandBar.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    if (commandBar?.isMinimized()) commandBar.restore()
    if (reviewOpen) commandBar?.webContents.send(IPC.closeRequested)
    else hideCommandBar()
  })
  commandBar.on('closed', () => {
    commandBar = null
    reviewOpen = false
    barPinned = false
  })
  loadRenderer(commandBar, 'bar')
}

function showCommandBar(focus = true) {
  if (!commandBar) createCommandBar()
  if (!commandBar) return
  if (commandBar.isMinimized()) commandBar.restore()
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (!commandBar.isVisible()) {
    // Cover the screen you're on; the renderer places the bar (centre, or the corner while working).
    commandBar.setBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)
  }
  // The workspace takes every click. Only the small bar lets clicks through around itself, with
  // hover tracking only while it's on screen (see passThrough).
  if (reviewOpen) commandBar.setIgnoreMouseEvents(false)
  else passThrough(commandBar, true)
  if (focus) {
    commandBar.show()
    commandBar.focus()
  } else {
    commandBar.showInactive()
  }
  commandBar.webContents.send(IPC.barVisible, true, focus)
}

/** Lets the renderer play its leave animation, then hides the window. */
function hideCommandBar() {
  if (!commandBar?.isVisible() || hideTimer) return
  commandBar.webContents.send(IPC.barVisible, false, false)
  hideTimer = setTimeout(() => {
    hideTimer = null
    commandBar?.hide()
    if (commandBar) passThrough(commandBar, false)
  }, BAR_LEAVE_MS)
}

function toggleCommandBar() {
  // Up in the corner while working but not focused: Ctrl+Space takes you to it, not away.
  if (commandBar?.isVisible() && !hideTimer && commandBar.isFocused()) hideCommandBar()
  else showCommandBar()
}

/** Make the bar invisible at once (no leave animation) so a screenshot doesn't catch it. */
function stepAside(): () => void {
  const bar = commandBar
  if (!bar?.isVisible()) return () => {}
  bar.setOpacity(0)
  return () => {
    if (!bar.isDestroyed()) bar.setOpacity(1)
  }
}

function trayIcon() {
  // The ring: an ember circle round a warm core, drawn at runtime so the tray needs no image asset.
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const edge = (v: number) => Math.max(0, Math.min(1, v)) // anti-aliased
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const ring = edge(13 - d) * edge(d - 9.5)
      const core = edge(5 - d)
      const i = (y * size + x) * 4
      buf[i] = core ? 214 : 59 // BGRA
      buf[i + 1] = core ? 225 : 169
      buf[i + 2] = core ? 255 : 242
      buf[i + 3] = Math.round(Math.max(ring, core) * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip(`Oggy (${SHORTCUT.replace('Control', 'Ctrl')})`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ask Oggy', accelerator: SHORTCUT, click: () => showCommandBar() },
      { label: 'Open dashboard', click: openDashboard },
      { type: 'separator' },
      { label: 'Set up Oggy again…', click: () => void setUpAgain() },
      { label: 'Quit Oggy', click: quit }
    ])
  )
  tray.on('click', () => showCommandBar())
}

/**
 * Oggy starts in the tray with no window, which after an install looks like nothing happened. So it
 * says so every time it starts, and the first time a new version runs it opens the dashboard too.
 */
function announceStart() {
  if (!app.isPackaged) return
  const keys = SHORTCUT.replace('Control', 'Ctrl')
  notify('Oggy is running', `Press ${keys} to talk to it. It lives in the tray, by the clock.`)
  const marker = join(app.getPath('userData'), 'last-version')
  let last = ''
  try {
    last = readFileSync(marker, 'utf8').trim()
  } catch {
    /* first run */
  }
  if (last !== app.getVersion()) {
    openDashboard()
    try {
      writeFileSync(marker, app.getVersion())
    } catch {
      /* not worth failing over */
    }
  }
}

/** Change Switch, the team or your details later: the same setup window, then a fresh backend. */
async function setUpAgain() {
  const saved = await runSetup((win) => loadRenderer(win, 'setup'), webPreferences)
  if (!saved) return
  if (await restartBackend()) notify('Oggy is set up', 'Your new settings are in use.')
  else notify('Oggy is set up', 'Restart the backend to use your new settings.')
}

/** Leave, whatever state things are in: a window that won't go can't keep Oggy alive. */
function quit() {
  if (quitting) return
  quitting = true
  setTimeout(() => app.exit(0), QUIT_MS).unref()
  app.quit()
}

function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
}

function registerIpc() {
  ipcMain.handle(IPC.submit, (_e, text: string) => api<Run>('/commands', { method: 'POST', body: { text, source: 'desktop' } }))
  ipcMain.handle(IPC.runs, () => api<Run[]>('/runs'))
  ipcMain.handle(IPC.approvals, () => api<Approval[]>('/approvals'))
  ipcMain.handle(IPC.decide, (_e, id: string, approve: boolean) =>
    api<Approval>(`/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { approve, via: 'desktop' } })
  )
  ipcMain.handle(IPC.workflows, () => api<Workflow[]>('/workflows'))
  ipcMain.handle(IPC.deleteWorkflow, async (_e, id: string) => {
    await api(`/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' })
  })
  ipcMain.handle(IPC.memory, () => api<MemoryItem[]>('/memory'))
  ipcMain.handle(IPC.integrations, () => api<IntegrationStatus[]>('/integrations'))
  ipcMain.handle(IPC.openChange, async (_e, runId: string, path: string) => {
    await api(`/runs/${encodeURIComponent(runId)}/changes/open`, { method: 'POST', body: { path } })
  })
  ipcMain.handle(IPC.decideReview, (_e, runId: string, text: string, ask: boolean) =>
    api(`/runs/${encodeURIComponent(runId)}/review`, { method: 'POST', body: { text, via: 'desktop', ask } })
  )
  ipcMain.on(IPC.reviewOpen, (_e, open: boolean, focus: boolean) => {
    reviewOpen = open
    if (!commandBar) return
    if (open) {
      if (!commandBar.isVisible() || hideTimer) showCommandBar(false)
      // A normal window while it's big: other apps you open come in front of it, and it has a taskbar
      // button to come back to (or Ctrl+Space).
      commandBar.setAlwaysOnTop(false)
      commandBar.setSkipTaskbar(false)
      commandBar.setMinimizable(true)
      commandBar.setIcon(trayIcon())
      commandBar.setIgnoreMouseEvents(false)
      if (focus) commandBar.focus()
    } else {
      // Back to the small panel in the corner: on top again, out of the taskbar.
      // Not one that has just been hidden: restoring would put an empty window back on screen.
      if (commandBar.isMinimized() && commandBar.isVisible()) commandBar.restore()
      commandBar.setMinimizable(false)
      commandBar.setAlwaysOnTop(true, 'pop-up-menu')
      commandBar.setSkipTaskbar(true)
      passThrough(commandBar, commandBar.isVisible() && !hideTimer)
    }
  })
  ipcMain.on(IPC.quit, quit)
  ipcMain.on(IPC.minimizeWindow, () => {
    if (reviewOpen) commandBar?.minimize()
  })
  ipcMain.handle(IPC.team, () => api<AgentLive[]>('/team'))
  ipcMain.handle(IPC.runDetail, (_e, runId: string) => api<{ changes: FileChange[]; review: Review | null; trace: TraceEntry[] }>(`/runs/${encodeURIComponent(runId)}/detail`))
  ipcMain.handle(IPC.backendStatus, () => backendOnline)
  ipcMain.on(IPC.hideBar, hideCommandBar)
  ipcMain.on(IPC.peekBar, () => {
    // Minimized: its taskbar icon flashes for you rather than the window jumping back.
    if (commandBar?.isMinimized()) commandBar.flashFrame(true)
    else if (!commandBar?.isVisible() || hideTimer) showCommandBar(false)
  })
  ipcMain.on(IPC.pinBar, (_e, pinned: boolean) => (barPinned = pinned))
  ipcMain.on(IPC.barInteractive, (_e, interactive: boolean) => {
    if (!commandBar || reviewOpen) return
    if (interactive) commandBar.setIgnoreMouseEvents(false)
    else passThrough(commandBar, commandBar.isVisible() && !hideTimer)
  })
}

// Windows shows notifications only for an app with an id: the same one the installer gives Oggy's shortcut.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'dev.oggy.app' : process.execPath)

// One Oggy at a time. While developing, the newest one runs instead (see below).
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => showCommandBar())

// Oggy lives in the tray, so stopping `pnpm dev` wouldn't end it: it goes when its terminal does.
app.on('before-quit', () => {
  stopBackend()
  if (quitting) return
  quitting = true
  setTimeout(() => app.exit(0), QUIT_MS).unref()
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, quit)
if (!app.isPackaged) {
  const parent = process.ppid
  setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch {
      quit()
    }
  }, 1000).unref()
}

app.whenReady().then(async () => {
  // The installed app brings its own backend (and asks for its settings the first time).
  await bootBackend((win) => loadRenderer(win, 'setup'), webPreferences)
  registerIpc()
  createCommandBar()
  setupShow(loadRenderer, webPreferences)
  createTray()
  if (process.env.OGGY_OPEN_DASHBOARD === '1') createDashboard()
  else announceStart()

  if (!globalShortcut.register(SHORTCUT, toggleCommandBar)) {
    console.warn(`[oggy] Could not register ${SHORTCUT}; it may be taken by the OS. Set OGGY_SHORTCUT.`)
  }

  streamEvents(
    (e) => {
      if (e.type === 'show') return void handleShow(e.effect, { stepAside })
      broadcast(IPC.event, e)
      if (e.type === 'approval.requested') notify('Oggy needs your approval', e.approval.action)
      if (e.type === 'run.updated' && (e.run.status === 'done' || e.run.status === 'failed') && e.run.summary) {
        notify(e.run.status === 'done' ? 'Oggy finished' : 'Oggy hit a problem', e.run.summary)
      }
    },
    (online) => {
      if (online !== backendOnline) {
        backendOnline = online
        broadcast(IPC.backendStatus, online)
      }
    }
  )

  app.on('activate', openDashboard)
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// Oggy lives in the tray; quitting goes through the tray menu.
app.on('window-all-closed', () => {})
