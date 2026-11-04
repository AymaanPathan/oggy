import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { config, type AppSpec } from './config.js'

/**
 * Windows desktop actions: apps, files, screen, volume, keys, speech.
 * Values from a command never get pasted into a script: PowerShell reads them from OGGY_* env vars.
 */

export interface DesktopResult {
  ok: boolean
  output: string
}

const isWin = process.platform === 'win32'

/** Run a fixed PowerShell script. `vars` arrive as $env:OGGY_<NAME>. */
export function powershell(
  script: string,
  vars: Record<string, string> = {},
  timeoutMs = 60_000,
  onLine?: (line: string) => void
): Promise<DesktopResult> {
  if (!isWin) return Promise.resolve({ ok: false, output: 'This action only works on Windows.' })
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(vars)) env[`OGGY_${k.toUpperCase()}`] = v
  return new Promise((done) => {
    let out = ''
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env,
      windowsHide: true
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    let partial = ''
    child.stdout.on('data', (d) => {
      out += d
      if (!onLine) return
      const lines = (partial + d).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l.trim())
    })
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (err) => done({ ok: false, output: `Could not start PowerShell: ${err.message}` }))
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, output: out.trim() })
    })
  })
}

/* ---------- folders ---------- */

/** "~\Pictures", "Desktop\notes.txt" or an absolute path -> absolute path. Relative paths start at your home folder. */
export function resolvePath(p: string): string {
  const trimmed = p.trim().replace(/^["']|["']$/g, '')
  if (trimmed === '~') return homedir()
  if (/^~[\\/]/.test(trimmed)) return join(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(homedir(), trimmed)
}

/** Real path of `p`, or of its nearest existing parent for paths that don't exist yet (follows junctions). */
function realish(p: string): string {
  let cur = p
  const rest: string[] = []
  while (!existsSync(cur)) {
    const up = dirname(cur)
    if (up === cur) return p
    rest.unshift(basename(cur))
    cur = up
  }
  return join(realpathSync.native(cur), ...rest)
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Is this path inside one of the allowed folders (config safety.allowedFolders)? */
export function folderAllowed(p: string): boolean {
  const real = realish(resolve(p))
  return config.safety.folders.some((root) => existsSync(root) && inside(realpathSync.native(root), real))
}

/** First problem with these paths, if any. */
export function checkPaths(paths: string[], { mustExist = true } = {}): string | undefined {
  for (const p of paths) {
    if (!folderAllowed(p)) return `${p} is outside the folders Oggy may touch.`
    if (mustExist && !existsSync(p)) return `${p} does not exist.`
  }
  return undefined
}

/** "*.png", "Screenshot*" -> RegExp. Only * and ? are special. */
function wildcard(pattern: string): RegExp {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i')
}

/** Files in `folder` (not sub-folders) whose names match `pattern`. */
export function matchFiles(folder: string, pattern = '*'): string[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return []
  const re = wildcard(pattern)
  return readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isFile() && re.test(e.name))
    .map((e) => join(folder, e.name))
}

/* ---------- finding things by name ("my resume", "the new jobs folder") ---------- */

/** Folders never worth searching: tooling, caches, and your projects (code has its own tools). */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '.vscode', '__pycache__', 'venv', '.venv'])
/** Words that describe a file without naming it: "interview docs" means files about "interview". */
const FILLER = new Set(['my', 'the', 'a', 'an', 'all', 'and', 'of', 'doc', 'docs', 'document', 'documents', 'file', 'files', 'folder', 'stuff'])

const norm = (s: string) => s.toLowerCase().replace(/[_\-.()[\]]+/g, ' ')
const stem = (w: string) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)

/** "offer letter" -> ["offer", "letter"]; "interview docs" -> ["interview"]. */
export function termWords(term: string): string[] {
  const words = norm(term).split(/\s+/).filter((w) => w && !FILLER.has(w))
  return (words.length ? words : norm(term).split(/\s+/).filter(Boolean)).map(stem)
}

/** Breadth-first walk of the allowed folders (not the code folder), a few levels deep. */
function walk(visit: (path: string, isDir: boolean, name: string) => void, maxDepth = 4, maxEntries = 40_000) {
  const code = resolve(config.projectsDir).toLowerCase()
  let queue = config.safety.folders.filter((f) => existsSync(f) && resolve(f).toLowerCase() !== code).map((f) => resolve(f))
  let seen = 0
  for (let depth = 0; depth <= maxDepth && queue.length && seen < maxEntries; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (++seen > maxEntries) break
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || e.name.startsWith('$') || SKIP_DIRS.has(e.name) || p.toLowerCase() === code) continue
          visit(p, true, e.name)
          next.push(p)
        } else if (e.isFile()) visit(p, false, e.name)
      }
    }
    queue = next
  }
}

export interface Found {
  term: string
  files: string[]
}

/** Files in your folders whose names contain every word of each term, newest first (max 8 per term). */
export function findFiles(terms: string[]): Found[] {
  const wanted = terms.map((term) => ({ term, words: termWords(term), hits: [] as { path: string; at: number }[] }))
  walk((path, isDir, name) => {
    if (isDir) return
    const n = norm(name)
    for (const w of wanted) {
      if (w.words.length && w.words.every((word) => n.includes(word))) {
        try {
          w.hits.push({ path, at: statSync(path).mtimeMs })
        } catch {
          /* vanished */
        }
      }
    }
  })
  const taken = new Set<string>()
  return wanted.map((w) => ({
    term: w.term,
    files: w.hits
      .sort((a, b) => b.at - a.at)
      .map((h) => h.path)
      .filter((p) => !taken.has(p) && taken.add(p))
      .slice(0, 8)
  }))
}

/**
 * The real names of your files, for the planner: everything in your folders and one level of
 * sub-folders (not the code folder), newest first. Claude may only pick files from this list.
 */
export function fileCatalog(max = 1500): { files: string[]; dirs: string[] } {
  const files: { path: string; at: number }[] = []
  const dirs: string[] = []
  walk(
    (path, isDir) => {
      if (isDir) return void dirs.push(path)
      try {
        files.push({ path, at: statSync(path).mtimeMs })
      } catch {
        /* vanished */
      }
    },
    1,
    20_000
  )
  return { files: files.sort((a, b) => b.at - a.at).slice(0, max).map((f) => f.path), dirs: dirs.slice(0, 400) }
}

/**
 * Where "new jobs folder" is: an existing folder with that name in your folders, else a new one
 * in Documents. Paths ("~\Desktop\Jobs", "C:\…") are used as they are.
 */
export function resolveFolder(name: string): { path: string; isNew: boolean } {
  const clean = name.trim().replace(/\s+folder$/i, '')
  if (/[\\/:~]/.test(clean)) {
    const p = resolvePath(clean)
    return { path: p, isNew: !existsSync(p) }
  }
  const key = norm(clean).replace(/\s+/g, ' ').trim()
  let found: string | undefined
  walk((path, isDir, n) => {
    if (!found && isDir && norm(n).replace(/\s+/g, ' ').trim() === key) found = path
  }, 3)
  if (found) return { path: found, isNew: false }
  const title = clean.replace(/\b\w/g, (c) => c.toUpperCase())
  return { path: join(homedir(), 'Documents', title), isNew: true }
}

/** Open a folder in Explorer, optionally with one file selected. */
export function openFolder(folder: string, select?: string): DesktopResult {
  if (!isWin) return { ok: false, output: 'This action only works on Windows.' }
  // Windows paths can't contain quotes, so this quoting is safe; explorer needs exactly this shape.
  const arg = select ? `/select,"${select}"` : `"${folder}"`
  spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
  return { ok: true, output: select ? `Showing ${basename(select)} in ${folder}` : `Opened ${folder}` }
}

/**
 * What "open" may start: things you look at or listen to. Allow-listed on purpose, because anything
 * else (.exe, .bat, .ps1, .lnk, macro documents…) would run code on a misheard word.
 */
const OPENABLE = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|log|json|html?|png|jpe?g|gif|webp|bmp|tiff?|heic|svg|mp4|mov|mkv|avi|webm|wmv|m4v|mp3|wav|m4a|flac|ogg|aac|zip)$/i

export const opensSafely = (file: string) => OPENABLE.test(file)

/** Open a file in its usual app and say if that worked. The path reaches PowerShell as an env var, never as script text. */
export function openInApp(file: string): Promise<DesktopResult> {
  return powershell('Invoke-Item -LiteralPath $env:OGGY_PATH', { path: file })
}

/** A file move or copy that can be undone ("undo that"). */
export type UndoOp = { kind: 'move'; from: string; to: string } | { kind: 'recycle'; path: string }

/** Called after each file so show mode can follow along; it paces the work so you can watch it. */
export type OnEach = (done: number) => Promise<void> | void

/** About 2.5 seconds for the whole batch, never more than 220ms a file. */
export const paceMs = (n: number) => Math.min(220, 2500 / Math.max(1, n))
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Move files into a folder, never overwriting. Returns the undo ops for what actually moved. */
export async function moveInto(files: string[], toDir: string, onEach?: OnEach): Promise<{ moved: UndoOp[]; skipped: string[] }> {
  mkdirSync(toDir, { recursive: true })
  const moved: UndoOp[] = []
  const skipped: string[] = []
  for (const [i, from] of files.entries()) {
    const to = join(toDir, basename(from))
    if (existsSync(to)) skipped.push(`${basename(from)} (already in ${basename(toDir)})`)
    else {
      moveOne(from, to)
      moved.push({ kind: 'move', from, to })
    }
    await onEach?.(i + 1)
  }
  return { moved, skipped }
}

export function moveOne(from: string, to: string) {
  try {
    renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    // Different drive: copy, then remove the original.
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    rmSync(from, { recursive: true })
  }
}

/** Copy files or folders into a folder, never overwriting. */
export async function copyInto(paths: string[], toDir: string, onEach?: OnEach): Promise<{ copied: UndoOp[]; skipped: string[] }> {
  mkdirSync(toDir, { recursive: true })
  const copied: UndoOp[] = []
  const skipped: string[] = []
  for (const [i, from] of paths.entries()) {
    const to = join(toDir, basename(from))
    if (existsSync(to)) skipped.push(`${basename(from)} (already there)`)
    else {
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
      copied.push({ kind: 'recycle', path: to })
    }
    await onEach?.(i + 1)
  }
  return { copied, skipped }
}

/** Send files or folders to the Recycle Bin (never a permanent delete). `onEach` follows along. */
export function recycle(paths: string[], onEach?: OnEach): Promise<DesktopResult> {
  return powershell(
    `Add-Type -AssemblyName Microsoft.VisualBasic
$ErrorActionPreference = 'Stop'
$i = 0
foreach ($p in ($env:OGGY_PATHS -split "\`n")) {
  if (Test-Path -LiteralPath $p -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
  $i++
  "DONE $i"
  Start-Sleep -Milliseconds $env:OGGY_PACE
}`,
    { paths: paths.join('\n'), pace: String(onEach ? Math.round(paceMs(paths.length)) : 0) },
    5 * 60_000,
    (line) => {
      const n = line.match(/^DONE (\d+)$/)?.[1]
      if (n) void onEach?.(Number(n))
    }
  )
}

/** Zip files or folders into a new .zip (fails if it already exists). */
export function zip(paths: string[], to: string): Promise<DesktopResult> {
  return powershell(
    `$ErrorActionPreference = 'Stop'
Compress-Archive -LiteralPath ($env:OGGY_PATHS -split "\`n") -DestinationPath $env:OGGY_TO`,
    { paths: paths.join('\n'), to },
    10 * 60_000
  )
}

/* ---------- apps ---------- */

const APP_ALIASES: Record<string, string> = {
  code: 'vscode',
  vs: 'vscode',
  visualstudiocode: 'vscode',
  calc: 'calculator',
  googlechrome: 'chrome',
  microsoftedge: 'edge',
  windowsterminal: 'terminal',
  fileexplorer: 'explorer'
}

/** "VS Code" -> the allowedApps entry for vscode, if there is one. */
export function findApp(name: string): (AppSpec & { name: string }) | undefined {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const resolved = config.safety.apps[key] ? key : APP_ALIASES[key]
  const spec = resolved ? config.safety.apps[resolved] : undefined
  return spec && { name: resolved!, ...spec }
}

export interface AppResult extends DesktopResult {
  /** The app's .exe, for showing its real icon. */
  exe?: string
  /** The window Oggy itself opened (only when a new one appeared), to close later. */
  window?: number
}

/**
 * Finds an app's windows, by the app's process name. Store apps (Calculator, Settings…) are
 * hosted in an ApplicationFrameWindow owned by another process, so a frame counts as the app's
 * when one of its child windows belongs to the app.
 */
const WINDOWS_CS = `
using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text;
public static class OggyWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static long[] Of(string proc) {
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcessesByName(proc)) pids.Add((uint)p.Id);
    var found = new List<long>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0 || GetWindow(h, 4) != IntPtr.Zero) return true; // owned popups aren't app windows
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool mine = pids.Contains(pid);
      if (!mine) {
        var cls = new StringBuilder(64); GetClassName(h, cls, 64);
        if (cls.ToString() == "ApplicationFrameWindow")
          EnumChildWindows(h, (c, l2) => { uint cp; GetWindowThreadProcessId(c, out cp); if (pids.Contains(cp)) { mine = true; return false; } return true; }, IntPtr.Zero);
      }
      if (mine) found.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  public static bool Alive(long h) { return IsWindow(new IntPtr(h)) && IsWindowVisible(new IntPtr(h)); }
  public static void Close(long h) { PostMessage(new IntPtr(h), 0x10, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE: same as clicking X
}`
const WINDOWS_PS = `Add-Type -TypeDefinition @'\n${WINDOWS_CS}\n'@`

/** Open an app and wait until its window is really on screen. Reports which window is new. */
export async function openApp(app: AppSpec & { name: string }): Promise<AppResult> {
  if (!isWin) return { ok: false, output: 'This action only works on Windows.' }
  if (!app.process) {
    start(app.open)
    return { ok: true, output: `Opened ${app.name}` }
  }
  const before = (await powershell(`${WINDOWS_PS}\n[OggyWin]::Of($env:OGGY_PROC) -join ','`, { proc: app.process })).output.trim().split('\n').pop() ?? ''
  // The command comes from your config, never from what was said.
  start(app.open)
  const r = await powershell(
    `${WINDOWS_PS}
$before = $env:OGGY_BEFORE -split ',' | Where-Object { $_ }
$exe = { (Get-Process -Name $env:OGGY_PROC -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path }
$deadline = (Get-Date).AddSeconds([int]$env:OGGY_SECS)
while ((Get-Date) -lt $deadline) {
  $new = [OggyWin]::Of($env:OGGY_PROC) | Where-Object { $before -notcontains [string]$_ } | Select-Object -First 1
  # Store apps show a splash window first and swap it for the real one: only count a window that stays.
  if ($new) { Start-Sleep -Milliseconds 600; if ([OggyWin]::Of($env:OGGY_PROC) -contains $new) { "NEW|$(& $exe)|$new"; exit 0 } }
  Start-Sleep -Milliseconds 150
}
if ([OggyWin]::Of($env:OGGY_PROC).Count) { "OLD|$(& $exe)" } else { "NONE|" }`,
    // Already running: it usually reuses its window, so don't wait long for a new one.
    { proc: app.process, before, secs: before ? '3' : '15' },
    30_000
  )
  const [state, exe, hwnd] = (r.output.split('\n').pop() ?? '').trim().split('|')
  if (state === 'NEW') return { ok: true, output: `${app.name} is open`, exe: exe || undefined, window: Number(hwnd) || undefined }
  if (state === 'OLD') return { ok: true, output: `${app.name} was already open, brought it up`, exe: exe || undefined }
  return { ok: false, output: `${app.name} didn't open a window within 15 seconds.` }
}

/**
 * Close the windows Oggy opened, like clicking X, and wait to see that they went.
 * Only `windows` (and only while they still belong to this app): yours stay open.
 */
export async function closeApp(app: AppSpec & { name: string }, windows: number[]): Promise<AppResult> {
  if (!app.process) return { ok: false, output: `Don't know ${app.name}'s process name. Add "process" for it in safety.allowedApps.` }
  const r = await powershell(
    `${WINDOWS_PS}
$app = [OggyWin]::Of($env:OGGY_PROC)
$mine = @($env:OGGY_WINDOWS -split ',' | Where-Object { $_ -and ($app -contains [long]$_) } | ForEach-Object { [long]$_ })
if (-not $mine.Count) { "NONE|"; exit 0 }
$exe = (Get-Process -Name $env:OGGY_PROC -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path
foreach ($h in $mine) { [OggyWin]::Close($h) }
$deadline = (Get-Date).AddSeconds(5)
do {
  Start-Sleep -Milliseconds 150
  $left = @($mine | Where-Object { [OggyWin]::Alive($_) })
} while ($left.Count -and (Get-Date) -lt $deadline)
"$(if ($left.Count) { 'ASKING' } else { 'CLOSED' })|$exe|$($mine.Count)"`,
    { proc: app.process, windows: windows.join(',') },
    30_000
  )
  if (!r.ok) return r
  const [state, exe, n] = (r.output.split('\n').pop() ?? '').trim().split('|')
  if (state === 'NONE') return { ok: true, output: `The ${app.name} window Oggy opened is already closed` }
  if (state === 'ASKING') return { ok: true, output: `${app.name} is still open, probably asking you to save`, exe }
  return { ok: true, output: `Closed ${app.name}${Number(n) > 1 ? ` (${n} windows)` : ''}`, exe }
}

/* ---------- screen, sound, keys ---------- */

/** Capture every monitor to a PNG. */
export async function screenshot(to: string): Promise<DesktopResult> {
  mkdirSync(dirname(to), { recursive: true })
  const r = await powershell(
    `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[W.U]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($env:OGGY_TO, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`,
    { to }
  )
  return r.ok ? { ok: true, output: `Saved screenshot to ${to}` } : r
}

/** Volume keys: each press is 2%. "set" goes to 0 first, then up to `level`. */
export async function volume(action: 'up' | 'down' | 'mute' | 'set', amount = 10): Promise<DesktopResult> {
  const presses =
    action === 'mute' ? [[173, 1]] : action === 'set' ? [[174, 50], [175, Math.round(Math.min(100, Math.max(0, amount)) / 2)]] : [[action === 'up' ? 175 : 174, Math.max(1, Math.round(amount / 2))]]
  const r = await powershell(
    `$sh = New-Object -ComObject WScript.Shell
foreach ($pair in ($env:OGGY_PRESSES -split ',')) {
  $k, $n = $pair -split ':'
  for ($i = 0; $i -lt [int]$n; $i++) { $sh.SendKeys([string][char][int]$k) }
}`,
    { presses: presses.map(([k, n]) => `${k}:${n}`).join(',') }
  )
  const said = action === 'mute' ? 'Toggled mute' : action === 'set' ? `Volume set to about ${amount}%` : `Volume ${action} ${amount}%`
  return r.ok ? { ok: true, output: said } : r
}

/** Press keys in the focused window (SendKeys syntax: "^s" = Ctrl+S, "{ENTER}", "%{F4}" = Alt+F4). */
export async function pressKeys(keys: string): Promise<DesktopResult> {
  const r = await powershell(`(New-Object -ComObject WScript.Shell).SendKeys($env:OGGY_KEYS)`, { keys })
  return r.ok ? { ok: true, output: `Pressed ${keys}` } : r
}

/** Open a file with its default app (an .ics opens in your calendar app). */
export function openFile(file: string) {
  // Windows paths can't contain quotes, so wrapping in them is safe.
  if (isWin) start(`"${file}"`)
}

/** `start "" <target>`. Verbatim, because Node's own quoting of "" breaks start. */
function start(target: string) {
  spawn('cmd.exe', [`/c start "" ${target}`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
}
