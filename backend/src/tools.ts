import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { memory } from './db.js'

/**
 * Project commands for the toolbox's project.* tools. Oggy never runs arbitrary shell strings:
 * each of these is a fixed binary and argument shape. Whether one is risky is decided in toolbox.ts.
 */
export type ToolName = 'vscode.open' | 'pm.install' | 'pm.build' | 'pm.test' | 'pm.dev' | 'git.status'

export interface ToolResult {
  ok: boolean
  code: number | null
  output: string
}

const isWin = process.platform === 'win32'

const LOCK_FILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun']
]

/** A runnable part of a project: the project itself, or a sub-folder like frontend/ or backend/. */
export interface Part {
  /** "" for the project root, else the folder name ("frontend"). */
  name: string
  dir: string
  scripts: Record<string, string>
}

function scriptsIn(dir: string): Record<string, string> | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}) as Record<string, string>
  } catch {
    return undefined
  }
}

/**
 * A project's parts. One package.json at the top: the project is one part. None at the top
 * (dashboard-crm has frontend/ and backend/): every sub-folder with its own package.json.
 */
export function projectParts(dir: string): Part[] {
  const root = scriptsIn(dir)
  if (root) return [{ name: '', dir, scripts: root }]
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .flatMap((e) => {
        const scripts = scriptsIn(join(dir, e.name))
        return scripts ? [{ name: e.name, dir: join(dir, e.name), scripts }] : []
      })
  } catch {
    return []
  }
}

/** A script that really does something (npm's "no test specified" placeholder doesn't). */
export const hasScript = (part: Part, script: string) => Boolean(part.scripts[script]) && !/no test specified/i.test(part.scripts[script])

/** The project's own package manager (from its lock file), else the remembered one, else pnpm. */
export function packageManager(cwd?: string): string {
  const fromLock = cwd && LOCK_FILES.find(([file]) => existsSync(join(cwd, file)))
  if (fromLock) return fromLock[1]
  const pm = memory.get('package_manager')
  return pm === 'npm' || pm === 'yarn' || pm === 'bun' || pm === 'pnpm' ? pm : 'pnpm'
}

function resolve(tool: ToolName, cwd: string): { bin: string; args: string[]; detached?: boolean; server?: boolean } {
  const pm = packageManager(cwd)
  switch (tool) {
    case 'vscode.open':
      return { bin: 'code', args: ['.'], detached: true }
    case 'pm.install':
      return { bin: pm, args: ['install'] }
    case 'pm.build':
      return { bin: pm, args: ['run', 'build'] }
    case 'pm.test':
      return { bin: pm, args: ['test'] }
    case 'pm.dev':
      return { bin: pm, args: ['run', 'dev'], server: true }
    case 'git.status':
      return { bin: 'git', args: ['status', '--short'] }
  }
}

const tail = (s: string, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s)

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s'"]*/
const SAID_PORT = /\b(?:listening|running|started|ready|serving|server)\b.*?\bport\b\s*:?\s*(\d{2,5})\b/i

/** Open a URL in the default browser. */
export function openUrl(url: string) {
  const [bin, args] = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  spawn(bin, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/**
 * Run an allowlisted tool. `onLine` gets each output line as it arrives (for the live view).
 * Dev servers keep running: the result comes back once they print their local URL (in `url`).
 */
export function runTool(
  tool: ToolName,
  cwd: string,
  onLine?: (line: string) => void,
  timeoutMs = 10 * 60_000
): Promise<ToolResult & { url?: string }> {
  if (!existsSync(cwd)) {
    return Promise.resolve({ ok: false, code: null, output: `Project folder not found: ${cwd}` })
  }
  const { bin, args, detached, server } = resolve(tool, cwd)

  // One dev server per project: asking again reuses it instead of stacking another.
  const running = server ? devServers.get(cwd) : undefined
  if (running) {
    return Promise.resolve({ ok: true, code: null, output: `Dev server already running${running.url ? ` at ${running.url}` : ''}`, url: running.url })
  }

  return new Promise((done) => {
    let out = ''
    let settled = false
    const finish = (r: ToolResult & { url?: string }) => {
      if (!settled) {
        settled = true
        // A dev server keeps talking after it's up; the run is over, so stop forwarding its lines.
        onLine = undefined
        done(r)
      }
    }

    const child = spawn(bin, args, {
      cwd,
      shell: isWin, // needed for .cmd shims (pnpm, code) on Windows
      detached: Boolean(detached),
      stdio: detached ? 'ignore' : 'pipe',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' }
    })

    child.on('error', (err) => finish({ ok: false, code: null, output: `Could not start ${bin}: ${err.message}` }))

    if (detached) {
      // Long-running (dev server) or GUI (VS Code): report started, don't wait.
      child.unref()
      setTimeout(() => finish({ ok: true, code: null, output: `Started: ${bin} ${args.join(' ')}` }), 300)
      return
    }

    const onData = (d: Buffer) => {
      const text = d.toString().replace(/\x1b\[[0-9;]*m/g, '') // strip colours
      out = tail(out + text, 20_000)
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim())
      // "Local: http://localhost:5173", or an API that only says its port ("listening on port 4000").
      const port = text.match(SAID_PORT)?.[1]
      const url = server && !settled && (text.match(LOCAL_URL)?.[0] ?? (port ? `http://localhost:${port}` : undefined))
      if (url) {
        const s = devServers.get(cwd)
        if (s) s.url = url
        finish({ ok: true, code: null, output: `Dev server running at ${url}`, url })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    if (server) {
      if (child.pid) trackDevServer(cwd, child)
      // Keeps running after we report back; only a failed start ends it early.
      setTimeout(() => finish({ ok: true, code: null, output: `Dev server started (no URL seen yet).\n${tail(out, 1000)}` }), 60_000)
      child.on('close', (code) => {
        forgetDevServer(cwd, child)
        finish({ ok: false, code, output: tail(out.trim()) || `Dev server exited (${code})` })
      })
      return
    }

    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid) // the whole tree, not just the shell
      finish({ ok: false, code: null, output: tail(out) + `\nTimed out after ${timeoutMs / 1000}s` })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, output: tail(out.trim()) || `(exit ${code})` })
    })
  })
}

/* ---------- dev servers: one per project, always cleaned up ----------
 * A dev server (next dev, vite) is a tree of processes: shell -> package manager -> server -> workers.
 * Killing only the top leaves the rest running forever, so Oggy always kills the whole tree,
 * and remembers PIDs on disk to clean up after a crash or a `tsx watch` restart.
 */

const devServers = new Map<string, { child: ChildProcess; url?: string }>()
const PID_FILE = join(config.dataDir, 'dev-servers.json')

function saveDevServers() {
  try {
    writeFileSync(PID_FILE, JSON.stringify([...devServers].map(([cwd, s]) => ({ cwd, pid: s.child.pid }))))
  } catch {
    /* best effort */
  }
}

function trackDevServer(cwd: string, child: ChildProcess) {
  devServers.set(cwd, { child })
  saveDevServers()
}

function forgetDevServer(cwd: string, child: ChildProcess) {
  if (devServers.get(cwd)?.child === child) devServers.delete(cwd)
  saveDevServers()
}

/** Kill a process and everything it started. */
export function killTree(pid: number) {
  if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

/** Stop the project's dev server (the whole tree). */
export function stopDevServer(cwd: string): ToolResult {
  const s = devServers.get(cwd)
  if (!s?.child.pid) return { ok: true, code: null, output: 'No dev server running for it.' }
  killTree(s.child.pid)
  forgetDevServer(cwd, s.child)
  return { ok: true, code: null, output: `Stopped the dev server${s.url ? ` at ${s.url}` : ''}.` }
}

export const devServerFor = (cwd: string) => devServers.get(cwd)

function stopAllDevServers() {
  for (const [cwd, s] of devServers) {
    if (s.child.pid) killTree(s.child.pid)
    devServers.delete(cwd)
  }
  saveDevServers()
}

/**
 * At startup: stop dev servers a previous backend left running, and node processes from the
 * code folder whose parent is gone (workers orphaned when a server's top process died).
 * Your own servers in a terminal still have their parent, so they are never touched.
 */
export function cleanupOrphans() {
  try {
    const stale = JSON.parse(readFileSync(PID_FILE, 'utf8')) as { pid?: number }[]
    for (const s of stale) if (s.pid) killTree(s.pid)
  } catch {
    /* no file yet */
  }
  saveDevServers()
  if (!isWin) return
  const script = `$root = $env:OGGY_ROOT
$alive = @{}; Get-Process | ForEach-Object { $alive[$_.Id] = $true }
$n = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and -not $alive[[int]$_.ParentProcessId] } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
$n`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, OGGY_ROOT: config.projectsDir },
    windowsHide: true
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.on('close', () => {
    const n = Number(out.trim())
    if (n) console.log(`[oggy] Cleaned up ${n} orphaned dev-server process(es) from ${config.projectsDir}`)
  })
}

// Dev servers die with the backend (Ctrl+C, restart), never left behind.
process.on('exit', stopAllDevServers)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(0))

export async function checkUrl(url: string, timeoutMs = 10_000): Promise<ToolResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    return { ok: res.status < 400, code: res.status, output: `${url} → HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, code: null, output: `${url} did not load: ${(err as Error).message}` }
  }
}
