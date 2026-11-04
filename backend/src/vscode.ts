import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { log } from './events.js'

/**
 * VS Code, through Oggy Bridge (vscode-bridge/ in this repo): a project's dev server runs in a VS Code
 * terminal you can see ("Oggy: portfolio"), not hidden inside Oggy. It keeps running when Oggy restarts.
 *
 * Every VS Code window's bridge asks Oggy for work on the folders it has open (GET /vscode/jobs), so a
 * job goes to the window that has the project, whenever it's ready: no guessing which window, or how
 * long it takes to open. The bridge sends the terminal's output back (POST /vscode/report), so Oggy reads
 * the real address, sees a crash with its error, and shows the output live.
 */

const isWin = process.platform === 'win32'
// The installed app says where it put the bridge; from the repo it's next to backend/.
const BRIDGE_DIR = process.env.OGGY_BRIDGE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vscode-bridge')
const VSIX = join(BRIDGE_DIR, 'oggy-bridge.vsix')
const BRIDGE = 'oggy.oggy-bridge'

/** Run the `code` command line and wait (it's a .cmd shim on Windows, hence the shell). */
function code(args: string[], timeoutMs = 60_000): { ok: boolean; out: string } {
  const quoted = args.map((a) => (/[\s&^|<>"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  const r = spawnSync('code', quoted, { shell: isWin, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** Open (or bring forward) a folder in VS Code without waiting for it. */
function openFolder(dir: string) {
  spawn('code', [`"${dir}"`], { shell: isWin, detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

let bridgeChecked = false

/** Oggy Bridge in VS Code, at this repo's version (installed or updated once per run of Oggy). */
export function bridgeReady(): { ok: boolean; why?: string } {
  if (bridgeChecked) return { ok: true }
  let want = ''
  try {
    want = (JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    /* no bridge in this checkout */
  }
  const listed = code(['--list-extensions', '--show-versions'], 30_000)
  if (!listed.ok && !listed.out) return { ok: false, why: "VS Code's `code` command isn't available" }
  const have = listed.out.toLowerCase().match(/oggy\.oggy-bridge@([\w.-]+)/)?.[1]
  // No bridge source in this checkout: one already installed is the one to use, not a reason to give up.
  if (!have || (want && have !== want)) {
    if (!existsSync(VSIX)) return { ok: false, why: `Oggy Bridge isn't built (${VSIX} is missing)` }
    const installed = code(['--install-extension', VSIX, '--force'], 120_000)
    if (!installed.ok) return { ok: false, why: `couldn't install Oggy Bridge in VS Code: ${installed.out.split('\n').pop()}` }
    log('info', `${have ? `Updated Oggy Bridge ${have} → ${want}` : `Installed Oggy Bridge ${want}`} in VS Code`)
  }
  bridgeChecked = true
  return { ok: true }
}

/* ---------- jobs for VS Code windows ---------- */

export interface BridgeJob {
  id: string
  type: 'run' | 'stop' | 'changes'
  /** The project's folder: a window that has it (or a folder above it) open takes the job. */
  root: string
  cwd: string
  /** The terminal ("Oggy: portfolio"). */
  name: string
  pm?: string
  script?: string
  /** For 'changes': the tab's title and the files to compare. */
  title?: string
  files?: { file: string; path: string; status: string; before: string }[]
}

/** What a window said about a job. */
interface JobState {
  job: BridgeJob
  claimed: boolean
  started: boolean
  /** The bridge can read the terminal's output (else the server runs, Oggy just can't see it). */
  streaming: boolean
  lines: string[]
  /** Set when the command ended. */
  exitCode?: number | null
  /** The terminal was closed. */
  stopped: boolean
  onLine?: (line: string) => void
}

const jobs = new Map<string, JobState>()
/** Windows waiting for work (their long poll), woken when a job comes in. */
const pollers = new Set<() => void>()

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const inside = (root: string, folder: string) => norm(root) === norm(folder) || norm(root).startsWith(`${norm(folder)}\\`)

/**
 * A window asks for work on its open folders: the oldest job for one of them, or nothing within `waitMs`.
 * `can`: what its bridge knows how to do beyond servers, so a window on an older bridge (it hasn't
 * been reloaded yet) never takes a job only to drop it.
 */
export async function takeJob(folders: string[], waitMs = 25_000, can: string[] = []): Promise<BridgeJob | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    const next = [...jobs.values()].find((s) => !s.claimed && (s.job.type !== 'changes' || can.includes('changes')) && folders.some((f) => inside(s.job.root, f)))
    if (next) {
      next.claimed = true
      return next.job
    }
    const left = until - Date.now()
    if (left <= 0) return undefined
    await new Promise<void>((wake) => {
      const done = () => {
        clearTimeout(timer)
        pollers.delete(done)
        wake()
      }
      const timer = setTimeout(done, left)
      pollers.add(done)
    })
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g

/** A window reports on a job: started, output lines, exited (code), stopped. */
export function jobReport(id: string, r: { event?: string; streaming?: boolean; lines?: unknown; code?: number | null }): boolean {
  const s = jobs.get(id)
  if (!s) return false
  if (r.event === 'started') {
    s.started = true
    s.streaming = Boolean(r.streaming)
  }
  if (Array.isArray(r.lines)) {
    for (const raw of r.lines) {
      const line = String(raw).replace(ANSI, '').trimEnd()
      if (!line.trim()) continue
      s.lines.push(line)
      s.onLine?.(line.trim())
    }
    if (s.lines.length > 300) s.lines.splice(0, s.lines.length - 300)
  }
  if (r.event === 'exited') s.exitCode = r.code ?? null
  if (r.event === 'stopped') s.stopped = true
  return true
}

function queue(job: Omit<BridgeJob, 'id'>, onLine?: (line: string) => void): JobState {
  const s: JobState = { job: { id: randomUUID(), ...job }, claimed: false, started: false, streaming: false, lines: [], stopped: false, onLine }
  jobs.set(s.job.id, s)
  for (const wake of [...pollers]) wake()
  // A job nobody finished with is forgotten after an hour.
  setTimeout(() => jobs.delete(s.job.id), 60 * 60_000).unref()
  return s
}

/** How long VS Code gets to open the project and pick up the job (a cold start takes a while). */
const CLAIM_MS = 45_000

async function untilClaimed(s: JobState, ms = CLAIM_MS): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until && !s.claimed) await pause(250)
  if (!s.claimed) {
    // Nobody took it: don't let a window pick it up later, out of the blue.
    s.claimed = true
    return false
  }
  return true
}

/** The address a dev server prints ("Local: http://localhost:5000"). */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+/

/** A server that only says its port ("API listening on port 4000", "Server running on port: 3001"). */
const SAID_PORT = /\b(?:listening|running|started|ready|serving|server)\b.*?\bport\b\s*:?\s*(\d{2,5})\b/i

/** The first address in a server's output, as one to open ("0.0.0.0" means this computer). */
export const printedUrl = (lines: string[]) =>
  lines.map((l) => l.match(LOCAL_URL)?.[0]).find(Boolean)?.replace('0.0.0.0', 'localhost') ??
  lines.map((l) => l.match(SAID_PORT)?.[1]).filter(Boolean).map((port) => `http://localhost:${port}`)[0]

export type ServerOutcome =
  | { state: 'up'; url: string; streaming: boolean }
  | { state: 'running'; streaming: boolean }
  | { state: 'exited'; code: number | null; tail: string[] }
  | { state: 'slow'; url?: string; tail: string[] }

/**
 * Start `<pm> run <script>` in a VS Code terminal in the project's window and watch it come up: its
 * output (live, through `onLine`), the address it prints (else `guessUrl`), and the port taking
 * connections. Ends when it's up, when it exits (with the last of its output), or after `timeoutMs`.
 */
export async function startServer(
  p: { root: string; cwd: string; name: string; pm: string; script: string; guessUrl?: string },
  onLine?: (line: string) => void,
  timeoutMs = 120_000,
  /** Stand-ins for the tests, which have no VS Code to talk to. */
  vscode = { ready: bridgeReady, open: openFolder, claimMs: CLAIM_MS }
): Promise<{ ok: false; why: string } | ({ ok: true } & ServerOutcome)> {
  const ready = vscode.ready()
  if (!ready.ok) return { ok: false, why: ready.why! }
  const s = queue({ type: 'run', root: p.root, cwd: p.cwd, name: p.name, pm: p.pm, script: p.script }, onLine)
  vscode.open(p.root)
  if (!(await untilClaimed(s, vscode.claimMs))) {
    return { ok: false, why: `VS Code didn't pick up the job within ${CLAIM_MS / 1000}s (after installing or updating Oggy Bridge, reload VS Code once)` }
  }
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (s.exitCode !== undefined) return { ok: true, state: 'exited', code: s.exitCode, tail: s.lines.slice(-15) }
    const url = printedUrl(s.lines) ?? p.guessUrl
    if (url && (await answers(url))) return { ok: true, state: 'up', url, streaming: s.streaming }
    // Started, but neither output nor an address to check: it's running, nothing more to know.
    if (s.started && !s.streaming && !url) return { ok: true, state: 'running', streaming: false }
    await pause(700)
  }
  return { ok: true, state: 'slow', url: printedUrl(s.lines) ?? p.guessUrl, tail: s.lines.slice(-15) }
}

/** Close the project's VS Code terminal (ends its server, mostly; see project.stop). True once a window did. */
export async function stopServer(p: { root: string; name: string }, waitMs = 8000): Promise<boolean> {
  if (!bridgeReady().ok) return false
  const s = queue({ type: 'stop', root: p.root, cwd: p.root, name: p.name })
  const until = Date.now() + waitMs
  while (Date.now() < until && !s.stopped) await pause(250)
  // Not taken (the window is closed, so is its terminal): nobody should pick it up later.
  s.claimed = true
  return s.stopped
}

/** How long an open window gets to take a diff (the project has just been asked to open). */
const DIFF_CLAIM_MS = 20_000

/**
 * Show a project's changes in VS Code's changes view, every file in one scrollable diff, in the window
 * that has the project. False when no window with an up-to-date bridge took it.
 */
export async function showChanges(
  p: { root: string; title: string; files: NonNullable<BridgeJob['files']> },
  /** A stand-in for the tests, which have no VS Code to talk to. */
  vscode = { ready: bridgeReady, claimMs: DIFF_CLAIM_MS }
): Promise<boolean> {
  if (!vscode.ready().ok) return false
  const s = queue({ type: 'changes', root: p.root, cwd: p.root, name: p.title, title: p.title, files: p.files })
  if (!(await untilClaimed(s, vscode.claimMs))) return false
  const until = Date.now() + 8000
  while (Date.now() < until && !s.started && s.exitCode === undefined) await pause(100)
  return s.started
}

/** One file in VS Code's own diff, no bridge needed: for a window that hasn't been reloaded onto the new bridge. */
export function diffOneFile(file: string, before: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oggy-before-'))
  mkdirSync(dir, { recursive: true })
  const old = join(dir, basename(file))
  writeFileSync(old, before)
  spawn('code', ['-r', '--diff', `"${old}"`, `"${file}"`], { shell: isWin, detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** Default ports of the usual dev servers, when the script doesn't say. */
const DEFAULT_PORTS: [RegExp, number][] = [
  [/\bnext\b/, 3000],
  [/\bnuxt\b/, 3000],
  [/\breact-scripts\b/, 3000],
  [/\bremix\b/, 3000],
  [/\bng\s+serve\b/, 4200],
  [/\bastro\b/, 4321],
  [/\bvite\b|\bsvelte-kit\b/, 5173]
]

/** Where a dev script will listen ("next dev -p 5000" → http://localhost:5000), if it can be told. */
export function devUrlOf(script: string): string | undefined {
  const port = script.match(/(?:^|\s)(?:-p|--port)[=\s]+(\d{2,5})\b/)?.[1] ?? script.match(/\bPORT=(\d{2,5})\b/)?.[1] ?? DEFAULT_PORTS.find(([re]) => re.test(script))?.[1]
  return port ? `http://localhost:${port}` : undefined
}

/**
 * Is the server at this address up, taking connections? Not "has a page loaded": a dev server builds
 * a page on its first visit (10s and more for a big Next.js app), and it's up long before that.
 * Tries IPv4 and IPv6, since dev servers listen on either.
 */
export async function answers(url: string, timeoutMs = 1500): Promise<boolean> {
  const { hostname, port } = new URL(url)
  const hosts = hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname]
  const tries = hosts.map(
    (host) =>
      new Promise<boolean>((done) => {
        const socket = connect({ host, port: Number(port) || 80 })
        const end = (up: boolean) => {
          socket.destroy()
          done(up)
        }
        socket.setTimeout(timeoutMs, () => end(false))
        socket.once('connect', () => end(true))
        socket.once('error', () => end(false))
      })
  )
  return (await Promise.all(tries)).some(Boolean)
}

/** Wait until the address answers (a first `next dev` compile can take a while). */
export async function waitFor(url: string, timeoutMs = 120_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await answers(url)) return true
    await pause(1500)
  }
  return false
}

/**
 * The server process holding a port, as far up as it is still the project's own (next dev starts a
 * worker that does the listening; the whole tree has to go, or it lingers). Windows only, for now.
 */
export function serverOnPort(url: string, dir: string): number | undefined {
  if (!isWin) return undefined
  const port = Number(new URL(url).port)
  if (!port) return undefined
  const script = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) { exit }
$dir = $env:OGGY_DIR.ToLower()
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
$top = $p
while ($p) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
  if (-not $parent -or -not $parent.CommandLine -or -not $parent.CommandLine.ToLower().Contains($dir)) { break }
  $top = $parent; $p = $parent
}
if ($top.CommandLine -and $top.CommandLine.ToLower().Contains($dir)) { $top.ProcessId }`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, OGGY_DIR: dir }, windowsHide: true, timeout: 20_000 })
  const pid = Number(r.stdout?.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** The dev script of a project part ("next dev -p 5000"). */
export function devScriptOf(dir: string): string {
  try {
    return String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts?.dev ?? '')
  } catch {
    return ''
  }
}
