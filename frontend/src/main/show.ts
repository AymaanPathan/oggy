import { app, BrowserWindow, ipcMain, nativeImage, screen, shell, type WebPreferences } from 'electron'
import { IPC } from '@common/api'
import type { ShowEffect } from '@shared/types'

/**
 * Show mode: one transparent, click-through window per screen that plays what Oggy is doing
 * (flash + thumbnail, app icons, files flying, keycaps, captions). A window only appears while
 * something is playing, so Windows never mistakes it for a full-screen app.
 */

type Load = (win: BrowserWindow, route: 'show') => void

/**
 * Click-through, optionally still noticing hover. On Windows, hover-forwarding installs a
 * system-wide low-level mouse hook: every cursor move on the machine waits for this process.
 * So it is only on while a click-through window is actually on screen and needs it.
 */
export function passThrough(win: BrowserWindow, trackHover: boolean) {
  win.setIgnoreMouseEvents(true, trackHover ? { forward: true } : undefined)
}

interface Hooks {
  /** Hide Oggy's own bar for a screenshot; returns how to bring it back. */
  stepAside: () => () => void
}

const windows = new Map<number, BrowserWindow>()
/** Screenshots the stage showed, the only files it may open. */
const shots = new Set<string>()
const icons = new Map<string, string>()
let restoreAfterShot: (() => void) | null = null

function create(display: Electron.Display, load: Load, webPreferences: WebPreferences) {
  const { x, y, width, height } = display.workArea // not the full screen: no "full-screen app" side effects
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { ...webPreferences, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // No hover tracking by default: only a screenshot thumbnail needs the mouse (see 'shutter').
  passThrough(win, false)
  win.on('closed', () => windows.delete(display.id))
  load(win, 'show')
  windows.set(display.id, win)
}

function rebuild(load: Load, webPreferences: WebPreferences) {
  for (const w of windows.values()) w.destroy()
  windows.clear()
  for (const d of screen.getAllDisplays()) create(d, load, webPreferences)
}

/** The screen you're looking at (under the cursor). */
function target(): BrowserWindow | undefined {
  return windows.get(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id) ?? windows.values().next().value
}

function play(win: BrowserWindow | undefined, effect: ShowEffect & { flashOnly?: boolean }) {
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) win.showInactive()
  win.webContents.send(IPC.show, effect)
}

async function iconFor(exe: string): Promise<string | undefined> {
  if (icons.has(exe)) return icons.get(exe)
  try {
    const url = (await app.getFileIcon(exe, { size: 'large' })).toDataURL()
    icons.set(exe, url)
    return url
  } catch {
    return undefined
  }
}

/** Route one effect from the backend to the right screen(s). */
export async function handleShow(effect: ShowEffect, hooks: Hooks) {
  switch (effect.kind) {
    case 'shutter.prep':
      // Out of the picture: the bar and anything still playing.
      restoreAfterShot?.()
      restoreAfterShot = hooks.stepAside()
      for (const w of windows.values()) w.setOpacity(0)
      return
    case 'shutter': {
      for (const w of windows.values()) w.setOpacity(1)
      shots.add(effect.path)
      const img = nativeImage.createFromPath(effect.path)
      const thumb = img.isEmpty() ? undefined : img.resize({ width: 640, quality: 'good' }).toDataURL()
      // Every screen flashes; the thumbnail lands on the one you're looking at.
      const main = target()
      for (const w of windows.values()) if (w !== main) play(w, { ...effect, flashOnly: true })
      // The thumbnail is clickable, so this one window notices hover until it goes idle.
      if (main) passThrough(main, true)
      play(main, { ...effect, thumb })
      setTimeout(() => {
        restoreAfterShot?.()
        restoreAfterShot = null
      }, 650)
      return
    }
    case 'app': {
      // Remember icons by app name too, so the next "start" already has one.
      const icon = effect.exe ? await iconFor(effect.exe) : icons.get(`app:${effect.app}`)
      if (effect.exe && icon) icons.set(`app:${effect.app}`, icon)
      return play(target(), { ...effect, icon })
    }
    default:
      return play(target(), effect)
  }
}

export function setupShow(load: Load, webPreferences: WebPreferences) {
  rebuild(load, webPreferences)
  // Screens added or removed: new windows. Resolution or taskbar changes (these fire often):
  // just move the existing ones, once things settle.
  screen.on('display-added', () => rebuild(load, webPreferences))
  screen.on('display-removed', () => rebuild(load, webPreferences))
  let settle: NodeJS.Timeout | undefined
  screen.on('display-metrics-changed', () => {
    clearTimeout(settle)
    settle = setTimeout(() => {
      for (const d of screen.getAllDisplays()) windows.get(d.id)?.setBounds(d.workArea)
    }, 400)
  })

  const from = (e: Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.on(IPC.showInteractive, (e, interactive: boolean) => {
    const w = from(e)
    if (!w) return
    if (interactive) w.setIgnoreMouseEvents(false)
    else passThrough(w, true) // still over the thumbnail's window: keep noticing hover
  })
  ipcMain.on(IPC.showIdle, (e) => {
    const w = from(e)
    if (w && [...windows.values()].includes(w)) {
      w.hide()
      passThrough(w, false)
    }
  })
  ipcMain.on(IPC.openShot, (_e, path: string, reveal: boolean) => {
    if (!shots.has(path)) return
    if (reveal) shell.showItemInFolder(path)
    else void shell.openPath(path)
  })
}
