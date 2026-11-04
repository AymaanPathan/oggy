import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emit, log } from './events.js'
import type { DiffHunk, FileChange } from './shared/types.js'

/**
 * Watching the agents work. When a coding job starts on a project, Oggy snapshots it and follows
 * every file the agents change, with the diff itself, so the review panel can show it live.
 * Git does the work (counting, diffing, putting files back), so nothing depends on what the
 * agents say in the room.
 */

const POLL_MS = 2500
const KEEP_RUNS = 20
/** Diff lines per file the panel gets; the rest are counted, not sent (keeps it fast). */
const MAX_LINES = 400
const MAX_FILES = 60

interface Watch {
  root: string
  /** The project as the job found it: a commit of the working tree (your own unsaved edits included). */
  base: string
  /** Branch and commit at the start, to tell you when an agent left its work on another one. */
  branch: string
  head: string
  /** What the diff is against right now: `base`, or where the agent's new branch left off (see poll). */
  from: string
  /** Look again soon (an agent just edited something). */
  poke?: NodeJS.Timeout
  /** Untracked files that were already there, with their modified time, so they don't count as the agent's. */
  before: Map<string, number>
  files: Map<string, FileChange>
  timer?: NodeJS.Timeout
  busy: boolean
}

const watches = new Map<string, Watch>()

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: Buffer }> {
  return new Promise((done) => {
    const chunks: Buffer[] = []
    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], { cwd, windowsHide: true })
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', () => done({ ok: false, out: Buffer.alloc(0) }))
    child.on('close', (code) => done({ ok: code === 0, out: Buffer.concat(chunks) }))
  })
}

const lines = (b: Buffer) => b.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Start following a project for this run. Safe to call for every agent step.
 * `continues`: a change you asked for in that run's review, so it starts from the same snapshot
 * and the review shows the whole change, not just the latest tweak.
 */
export async function watchCode(runId: string, dir: string, continues?: string) {
  if (watches.has(runId) || !existsSync(dir)) return
  const earlier = continues ? watches.get(continues) : undefined
  const w: Watch = { root: '', base: '', branch: '', head: '', from: '', before: new Map(), files: new Map(), busy: false }
  watches.set(runId, w)
  if (earlier?.base) {
    Object.assign(w, { root: earlier.root, base: earlier.base, branch: earlier.branch, head: earlier.head, from: earlier.from, before: earlier.before, files: new Map(earlier.files) })
    w.timer = setInterval(() => void poll(runId, w), POLL_MS)
    emit({ type: 'run.changes', runId, files: [...w.files.values()] })
    return
  }
  for (const id of [...watches.keys()].slice(0, -KEEP_RUNS)) {
    clearInterval(watches.get(id)?.timer)
    watches.delete(id)
  }

  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return log('info', `${dir} isn't a git repo, so Oggy can't show the agents' changes`)
  w.root = lines(top.out)[0]
  // `stash create` snapshots the working tree without touching it; a clean tree has nothing to snapshot.
  const snap = await git(w.root, ['stash', 'create'])
  const head = await git(w.root, ['rev-parse', 'HEAD'])
  w.head = lines(head.out)[0] ?? ''
  w.base = w.from = lines(snap.out)[0] || w.head
  w.branch = lines((await git(w.root, ['branch', '--show-current'])).out)[0] ?? ''
  if (!w.base) return log('info', `${w.root} has no commits yet, so Oggy can't show the agents' changes`)
  for (const p of lines((await git(w.root, ['ls-files', '--others', '--exclude-standard'])).out)) w.before.set(p, mtime(join(w.root, p)))
  if (watches.get(runId) === w) w.timer = setInterval(() => void poll(runId, w), POLL_MS)
}

/** The branch each run's coding happens on. */
const jobBranches = new Map<string, string>()
const MAIN_BRANCHES = /^(main|master|develop|dev|trunk)$/

/**
 * The branch a coding job works on. Your agents never commit on main and don't make branches
 * themselves, so Oggy makes one per job ("oggy/add-get-ping-route") from where you are (a local
 * branch: nothing is pushed, nothing is thrown away), on main or on a branch it made for an earlier
 * job. On a branch of your own, the work stays there. A change you asked for in a review stays on
 * the branch of the job it changes.
 */
export async function branchForJob(runId: string, dir: string, about: string, continues?: string): Promise<{ branch: string; made: boolean } | undefined> {
  const known = jobBranches.get(runId) ?? (continues ? jobBranches.get(continues) : undefined)
  if (known) {
    jobBranches.set(runId, known)
    return { branch: known, made: false }
  }
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return undefined
  const root = lines(top.out)[0]
  const current = lines((await git(root, ['branch', '--show-current'])).out)[0]
  if (!current) return undefined // detached HEAD: leave it alone
  // Your own branch: the work stays there. Oggy's branch for an earlier job: this job gets its own.
  if (!MAIN_BRANCHES.test(current) && !current.startsWith('oggy/')) {
    jobBranches.set(runId, current)
    return { branch: current, made: false }
  }
  const slug = `oggy/${about.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change'}`
  let name = slug
  for (let i = 2; (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok; i++) name = `${slug}-${i}`
  if (!(await git(root, ['checkout', '-b', name])).ok) return undefined
  jobBranches.set(runId, name)
  log('info', `Made branch ${name} for the job (was on ${current})`)
  return { branch: name, made: true }
}

/** The branch a job's work is on: its own, else whatever the project has checked out. */
export async function workBranch(runId: string, dir: string): Promise<string | undefined> {
  return jobBranches.get(runId) ?? lines((await git(dir, ['branch', '--show-current'])).out)[0]
}

/** An agent just edited a file or ran a command: look now instead of at the next tick. */
export function pokeWatch(runId: string) {
  const w = watches.get(runId)
  if (!w?.timer) return
  clearTimeout(w.poke)
  w.poke = setTimeout(() => void poll(runId, w), 350)
}

/** One last look (the final edits), then stop following. */
export async function stopWatch(runId: string) {
  const w = watches.get(runId)
  if (!w?.timer) return
  clearInterval(w.timer)
  w.timer = undefined
  await poll(runId, w)
}

/** The branch a run's project is on now. */
export async function branchOf(runId: string): Promise<string | undefined> {
  const w = watches.get(runId)
  return w?.root ? lines((await git(w.root, ['branch', '--show-current'])).out)[0] : undefined
}

/** What a run changed, for the review. */
export function changesOf(runId: string): FileChange[] {
  return [...(watches.get(runId)?.files.values() ?? [])]
}

async function poll(runId: string, w: Watch) {
  if (w.busy) return
  w.busy = true
  try {
    // An agent that moved to a new branch: its work is what that branch adds since it split off,
    // not every file that differs between the two branches.
    const branch = lines((await git(w.root, ['branch', '--show-current'])).out)[0] ?? ''
    const was = w.from
    w.from = branch && w.branch && branch !== w.branch ? lines((await git(w.root, ['merge-base', 'HEAD', w.head])).out)[0] || w.base : w.base

    const next = new Map<string, FileChange>()
    const stat = await git(w.root, ['diff', '--numstat', '--no-renames', w.from])
    // A (added, committed or staged) / D (deleted) / M, from git itself.
    const kinds = new Map(
      lines((await git(w.root, ['diff', '--name-status', '--no-renames', w.from])).out).map((l) => [l.slice(1).trim(), l[0]] as const)
    )
    for (const line of lines(stat.out)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      const kind = kinds.get(m[3])
      const status = kind === 'A' ? 'added' : kind === 'D' || !existsSync(join(w.root, m[3])) ? 'deleted' : 'modified'
      next.set(m[3], { path: m[3], added: Number(m[1]) || 0, removed: Number(m[2]) || 0, status, binary: m[1] === '-' || undefined })
    }
    for (const p of lines((await git(w.root, ['ls-files', '--others', '--exclude-standard'])).out)) {
      const file = join(w.root, p)
      if (w.before.get(p) === mtime(file)) continue // was already there, untouched
      next.set(p, { path: p, added: 0, removed: 0, status: 'added' })
    }
    if (next.size > MAX_FILES) for (const p of [...next.keys()].slice(MAX_FILES)) next.delete(p)

    // Same files, same counts: nothing new to send (new files are re-read below, they have no counts yet).
    const same = next.size === w.files.size && [...next].every(([p, f]) => f.status !== 'added' && w.files.get(p)?.added === f.added && w.files.get(p)?.removed === f.removed)
    if (same && was === w.from) return

    const hunks = parseDiff((await git(w.root, ['diff', '-U3', '--no-renames', '--no-color', w.from])).out.toString('utf8'))
    for (const f of next.values()) {
      if (f.binary || f.status === 'deleted') continue
      const h = f.status === 'added' ? newFile(join(w.root, f.path)) : hunks.get(f.path)
      if (!h) continue
      if (f.status === 'added') f.added = h.total
      const kept = trim(h.hunks)
      f.hunks = kept.hunks
      if (kept.cut) f.cut = kept.cut
    }
    const before = JSON.stringify([...w.files.values()])
    w.files = next
    if (JSON.stringify([...next.values()]) !== before) emit({ type: 'run.changes', runId, files: [...next.values()] })
  } finally {
    w.busy = false
  }
}

/** `git diff` output -> hunks per file. */
function parseDiff(text: string): Map<string, { hunks: DiffHunk[]; total: number }> {
  const files = new Map<string, { hunks: DiffHunk[]; total: number }>()
  let cur: { hunks: DiffHunk[]; total: number } | undefined
  let hunk: DiffHunk | undefined
  let oldPath = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      cur = undefined
      hunk = undefined
      continue
    }
    if (line.startsWith('--- ')) {
      oldPath = line.slice(4).replace(/\t$/, '').replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t$/, '')
      const path = p === '/dev/null' ? oldPath : p.replace(/^b\//, '')
      cur = { hunks: [], total: 0 }
      files.set(path, cur)
      continue
    }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (m && cur) {
      hunk = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk || !cur) continue
    const t = line[0]
    if (t === '+' || t === '-' || t === ' ') {
      hunk.lines.push({ t, text: line.slice(1) })
      cur.total++
    }
  }
  return files
}

/** A new file is one long addition. */
function newFile(file: string): { hunks: DiffHunk[]; total: number } | undefined {
  try {
    if (statSync(file).size > 1_000_000) return undefined
    const text = readFileSync(file, 'utf8')
    if (text.includes('\u0000')) return undefined // binary
    const all = text.replace(/\r/g, '').replace(/\n$/, '').split('\n')
    return { hunks: [{ oldStart: 0, newStart: 1, lines: all.map((l) => ({ t: '+' as const, text: l })) }], total: all.length }
  } catch {
    return undefined
  }
}

/** At most MAX_LINES lines per file; the rest is a count. */
function trim(hunks: DiffHunk[]): { hunks: DiffHunk[]; cut: number } {
  let left = MAX_LINES
  let cut = 0
  const out: DiffHunk[] = []
  for (const h of hunks) {
    if (left <= 0) {
      cut += h.lines.length
      continue
    }
    out.push(h.lines.length <= left ? h : { ...h, lines: h.lines.slice(0, left) })
    cut += Math.max(0, h.lines.length - left)
    left -= h.lines.length
  }
  return { hunks: out, cut }
}

/**
 * Put every file the run changed back the way the job found it (your own earlier edits included),
 * and remove the files it added. Commits an agent made stay in git; Oggy says where.
 */
export async function undoChanges(runId: string): Promise<{ ok: boolean; message: string }> {
  const w = watches.get(runId)
  if (!w?.root || !w.base) return { ok: false, message: "Oggy doesn't have the changes for that job any more." }
  clearInterval(w.timer)
  w.timer = undefined
  let restored = 0
  const failed: string[] = []
  for (const f of w.files.values()) {
    const file = join(w.root, f.path)
    try {
      if (f.status === 'added') rmSync(file, { force: true })
      else {
        const before = await git(w.root, ['show', `${w.from}:${f.path}`])
        if (!before.ok) throw new Error('not in the snapshot')
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, before.out)
      }
      restored++
    } catch {
      failed.push(f.path)
    }
  }
  const branch = lines((await git(w.root, ['branch', '--show-current'])).out)[0] ?? ''
  const moved = branch && w.branch && branch !== w.branch ? ` You're on ${branch} now (it was ${w.branch}); its commits are still there.` : ''
  const message = failed.length
    ? `Put back ${restored} file${restored === 1 ? '' : 's'}, but not ${failed.join(', ')}.${moved}`
    : `Put back ${restored} file${restored === 1 ? '' : 's'}. The project is as it was.${moved}`
  log('info', `Undo for ${runId}: ${message}`)
  return { ok: !failed.length, message }
}

/** One file Oggy changed, as VS Code's diff needs it. */
export interface ChangedFile {
  path: string
  status: FileChange['status']
  /** The file as the job found it ('' for a new file). */
  before: string
}

export interface ProjectChanges {
  root: string
  branch: string
  files: ChangedFile[]
  /** Images and very big files: changed, but there's no text to compare. */
  notShown: number
  /** The work is on this branch and you're on another one, so there's nothing here to compare. */
  elsewhere?: string
}

/** A diff side bigger than this is a generated file nobody reads. */
const MAX_DIFF_BYTES = 512 * 1024

const sameDir = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(a) === n(b) || n(a).startsWith(`${n(b)}/`) || n(b).startsWith(`${n(a)}/`)
}

const text = (b: Buffer) => b.toString('utf8').replace(/\r\n/g, '\n')

/** Each file as it was at `ref`, dropping what's no longer different (kept and merged, undone, reverted by hand). */
async function compare(root: string, ref: string, files: { path: string; status: FileChange['status'] }[]): Promise<Pick<ProjectChanges, 'files' | 'notShown'>> {
  const out: ChangedFile[] = []
  let notShown = 0
  for (const f of files) {
    const old = f.status === 'added' ? Buffer.alloc(0) : (await git(root, ['show', `${ref}:${f.path}`])).out
    const file = join(root, f.path)
    const now = existsSync(file) ? readFileSync(file) : undefined
    // Git hands back LF, and with autocrlf the file on disk has CRLF: that's not a change.
    if (now ? text(now) === text(old) : f.status !== 'deleted') continue
    if (old.length > MAX_DIFF_BYTES || (now?.length ?? 0) > MAX_DIFF_BYTES || old.includes(0) || now?.includes(0)) notShown++
    else out.push({ path: f.path, status: f.status, before: old.toString('utf8') })
  }
  return { files: out, notShown }
}

/**
 * What Oggy changed in a project, for opening it in VS Code: the latest job that still has changes,
 * else (Oggy restarted and forgot its jobs) what the oggy/ branch you're on adds to its main branch.
 */
export async function changesIn(dir: string): Promise<ProjectChanges | undefined> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return undefined
  const root = lines(top.out)[0]
  const branch = lines((await git(root, ['branch', '--show-current'])).out)[0] ?? ''
  let elsewhere: string | undefined
  for (const [runId, w] of [...watches].reverse()) {
    if (!w.root || !sameDir(w.root, dir) || !w.files.size) continue
    const seen = await compare(w.root, w.from, [...w.files.values()])
    if (seen.files.length || seen.notShown) return { root: w.root, branch, ...seen }
    const made = jobBranches.get(runId)
    if (made && made !== branch) elsewhere ??= made
  }
  if (branch.startsWith('oggy/')) {
    for (const main of ['main', 'master', 'develop', 'dev', 'trunk']) {
      const split = await git(root, ['merge-base', 'HEAD', main])
      if (!split.ok) continue
      const ref = lines(split.out)[0]
      const tracked = lines((await git(root, ['diff', '--name-status', '--no-renames', ref])).out).map((l) => ({ path: l.slice(1).trim(), status: (l[0] === 'A' ? 'added' : l[0] === 'D' ? 'deleted' : 'modified') as FileChange['status'] }))
      const fresh = lines((await git(root, ['ls-files', '--others', '--exclude-standard'])).out).map((path) => ({ path, status: 'added' as const }))
      return { root, branch, ...(await compare(root, ref, [...tracked, ...fresh].slice(0, MAX_FILES))) }
    }
  }
  return { root, branch, files: [], notShown: 0, elsewhere }
}

/** Open one changed file in VS Code (only files the run changed), for when you want the full editor. */
export function openInEditor(runId: string, path: string): string | undefined {
  const w = watches.get(runId)
  if (!w?.files.has(path)) return 'That file is not one of the changes.'
  const isWin = process.platform === 'win32'
  const file = join(w.root, path)
  spawn('code', isWin ? ['-r', `"${file}"`] : ['-r', file], { shell: isWin, detached: true, stdio: 'ignore', windowsHide: true }).unref()
  return undefined
}
