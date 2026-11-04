import { app, type BrowserWindow, type WebPreferences } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { needsSetup, runSetup } from './setup'

/**
 * The installed Oggy (Oggy-Setup.exe) carries its own backend: the bundled server, Node 22 to run it
 * and the bridge, under resources/oggy (see frontend/scripts/pack.mjs). It starts with the app and
 * stops with it. The first time, the setup window (setup.ts) connects Oggy to Switch and writes
 * ~/.oggy/config.json.
 * From the repo (`pnpm dev`), the backend runs on its own and none of this happens, unless
 * OGGY_SETUP=1 asks for the setup window (use OGGY_DATA_DIR to keep your real config out of it).
 */

const DATA_DIR = process.env.OGGY_DATA_DIR || join(homedir(), '.oggy')
const PORT = Number(process.env.OGGY_PORT || 4317)
const res = () => join(process.resourcesPath, 'oggy')

let child: ChildProcess | undefined

/** A backend already answering (one you started from the repo, say): use it. */
async function running(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) })
    return true
  } catch {
    return false
  }
}

function startBackend() {
  const log = createWriteStream(join(DATA_DIR, 'backend.log'), { flags: 'a' })
  child = spawn(join(res(), 'node', 'node.exe'), [join(res(), 'backend', 'server.mjs')], {
    cwd: join(res(), 'backend'),
    env: { ...process.env, OGGY_BRIDGE_DIR: join(res(), 'vscode-bridge') },
    windowsHide: true
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  child.on('exit', (code) => {
    log.write(`\n[oggy] backend stopped (${code})\n`)
    child = undefined
  })
}

export function stopBackend() {
  if (child?.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  else child?.kill()
}

/** After new settings: the backend reads its config once, so start it again. Only the installed app owns one. */
export async function restartBackend(): Promise<boolean> {
  if (!app.isPackaged) return false
  const old = child
  stopBackend()
  if (old) await new Promise<void>((done) => (old.exitCode !== null ? done() : old.once('exit', () => done())))
  for (let i = 0; i < 20 && (await running()); i++) await new Promise((r) => setTimeout(r, 250))
  startBackend()
  return true
}

/**
 * In the installed app: set up if needed, then start the backend (unless one is already running).
 * Closing the setup window the first time quits Oggy: it can't do anything without Switch.
 */
export async function bootBackend(loadSetup: (win: BrowserWindow) => void, webPreferences: WebPreferences): Promise<void> {
  const forced = process.env.OGGY_SETUP === '1'
  if (!app.isPackaged && !forced) return
  mkdirSync(DATA_DIR, { recursive: true })
  if (forced || needsSetup()) {
    const saved = await runSetup(loadSetup, webPreferences)
    if (!saved && needsSetup()) {
      app.exit(0)
      return
    }
  }
  if (app.isPackaged && !(await running())) startBackend()
}
