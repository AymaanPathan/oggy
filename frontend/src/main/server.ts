import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * The installed Oggy (Oggy-Setup.exe) carries its own backend: the bundled server, Node 22 to run it
 * and the bridge, under resources/oggy (see scripts/pack.mjs). It starts with the app and stops with
 * it. The first time, a small setup window asks for what ~/.oggy/config.json needs.
 * From the repo (`pnpm start`), the backend runs on its own and none of this happens.
 */

const DATA_DIR = process.env.OGGY_DATA_DIR || join(homedir(), '.oggy')
const CONFIG = join(DATA_DIR, 'config.json')
const PORT = Number(process.env.OGGY_PORT || 4317)
const res = () => join(process.resourcesPath, 'oggy')

/** Example values the template config ships with: still there means setup isn't done. */
const UNFILLED = ['YOUR-OGGY-AGENT-ID', 'YOUR-OGGY-AGENT-KEY', 'localhost:PORT', 'your-chat-username']

let child: ChildProcess | undefined

function needsSetup(): boolean {
  if (!existsSync(CONFIG)) return true
  const text = readFileSync(CONFIG, 'utf8')
  return UNFILLED.some((s) => text.includes(s))
}

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

/** Write what the setup window asked for into the config, on top of the example (the agents, the safety rules). */
function saveSetup(q: URLSearchParams) {
  mkdirSync(DATA_DIR, { recursive: true })
  const base = existsSync(CONFIG) ? CONFIG : join(res(), 'switch', 'config.example.json')
  const cfg = JSON.parse(readFileSync(base, 'utf8'))
  cfg.switch = { ...cfg.switch, apiUrl: q.get('apiUrl')?.trim(), agentId: q.get('agentId')?.trim(), agentApiKey: q.get('agentKey')?.trim(), agentName: q.get('agentName')?.trim() || 'oggy' }
  cfg.owner = { ...cfg.owner, name: q.get('name')?.trim(), discordUsername: q.get('username')?.trim(), switchUserId: cfg.owner?.switchUserId || '' }
  cfg.paths = { ...cfg.paths, codeFolder: q.get('codeFolder')?.trim() }
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`)
}

const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function setupPage(): string {
  const field = (id: string, label: string, hint: string, value = '', type = 'text') =>
    `<label><span>${label}</span><input name="${id}" type="${type}" value="${esc(value)}" required spellcheck="false"><small>${hint}</small></label>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Set up Oggy</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;padding:34px 36px;background:#0d0d0f;color:#f2f2f3;font:14px/1.5 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif}
  h1{margin:0 0 4px;font:600 22px 'Segoe UI Variable Display','Segoe UI',sans-serif}
  p.lead{margin:0 0 22px;color:rgba(242,242,243,.6)}
  h2{margin:22px 0 10px;font:600 11px 'Cascadia Code',Consolas,monospace;letter-spacing:.08em;color:#e8b04b}
  label{display:block;margin-bottom:12px}label span{display:block;font-weight:500;margin-bottom:5px}
  input{width:100%;height:36px;padding:0 11px;border-radius:8px;border:0;background:#19191d;color:#f2f2f3;font:13px 'Cascadia Code',Consolas,monospace;box-shadow:inset 0 0 0 1px rgba(255,255,255,.11)}
  input:focus{outline:0;box-shadow:inset 0 0 0 1.5px #e8b04b}
  small{display:block;margin-top:4px;color:rgba(242,242,243,.45);font-size:12px}
  button{margin-top:18px;width:100%;height:42px;border:0;border-radius:10px;font:600 14px 'Segoe UI',sans-serif;color:#17110a;cursor:pointer;background:linear-gradient(180deg,#f3cd85,#e8b04b 55%,#b98a35)}
  </style></head><body><form id="f">
  <h1>Set up Oggy</h1><p class="lead">Once. You can change it later in ~/.oggy/config.json.</p>
  <h2>SWITCH</h2>
  ${field('apiUrl', 'Switch address', 'Shown in Switch Console, for example http://localhost:53754', 'http://localhost:')}
  ${field('agentId', 'Oggy agent id', 'Switch Console → Agents → your Oggy agent')}
  ${field('agentKey', 'Oggy agent API key', 'From the same page', '', 'password')}
  <h2>YOU</h2>
  ${field('name', 'Your name', 'How Oggy talks about you')}
  ${field('username', 'Your chat username', 'Your Discord (or Slack, Teams) username')}
  ${field('codeFolder', 'Code folder', 'Every folder in it is a project. Use the same one as in the team template.', join(homedir(), 'code'))}
  <button type="submit">Save and start Oggy</button>
  </form><script>
  document.getElementById('f').addEventListener('submit',(e)=>{e.preventDefault();location.href='oggy-setup://save?'+new URLSearchParams(new FormData(e.target))})
  </script></body></html>`
}

/** The setup window; resolves once the config is saved (or never, if it's closed: then Oggy quits). */
function runSetup(): Promise<void> {
  return new Promise((done) => {
    const win = new BrowserWindow({ width: 520, height: 760, title: 'Set up Oggy', backgroundColor: '#0d0d0f', autoHideMenuBar: true, resizable: false })
    let saved = false
    // The form "navigates" to oggy-setup://save?…: caught here, never loaded.
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('oggy-setup://')) return
      e.preventDefault()
      saveSetup(new URL(url).searchParams)
      saved = true
      win.close()
      done()
    })
    win.on('closed', () => {
      if (!saved) app.quit()
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(setupPage())}`)
  })
}

/** In the installed app: set up if needed, then start the backend (unless one is already running). */
export async function bootBackend(): Promise<void> {
  if (!app.isPackaged) return
  mkdirSync(DATA_DIR, { recursive: true })
  if (needsSetup()) await runSetup()
  if (!(await running())) startBackend()
}
