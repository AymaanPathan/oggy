import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentFor, config } from './config.js'
import { emit } from './events.js'
import { onRoomMessage, teamPresence, type Presence, type RoomMessage } from './integrations/switch.js'
import type { AgentLive, AgentStep, TraceEntry } from './shared/types.js'

/**
 * Watching the team work, live. Every agent is a Claude Code session on this computer, and Claude
 * Code writes each step it takes (read a file, edit one, run a command, think) to a transcript
 * under ~/.claude/projects as it happens. Oggy follows those transcripts all the time and keeps,
 * per agent: working / waiting for you / idle, the job it's on, and its last steps. The desktop
 * app shows that as the Team view; jobs Oggy hands out also get the steps as live lines.
 *
 * An agent on another machine has no transcript here. For those, Switch is the source (see "the team,
 * through Switch" below): whether a session of it is up and in which room, the jobs Oggy hands it, and
 * what it says in Oggy's rooms. Coarser than a transcript, but it works wherever the agent runs.
 */

const PROJECTS = process.env.OGGY_CLAUDE_PROJECTS || join(homedir(), '.claude', 'projects')
const POLL_MS = 700
/** Never read more than this from one file in one go (a transcript line can carry big blobs). */
const MAX_CHUNK = 4_000_000
/** On start, read this much of recently used transcripts to know who's in the middle of something. */
const SEED_BYTES = 400_000
const SEED_WITHIN_MS = 30 * 60_000
/** Working but silent this long: it stopped (crashed, closed), call it idle. */
const STALE_MS = 10 * 60_000
const STEPS_KEPT = 12
/** Stopped, with no report reaching Oggy, for this long: it isn't coming. */
const QUIET_MS = 60_000
/** It stopped and its session holds its report: this long for the room's copy, then Oggy uses that one. */
const REPORT_GRACE_MS = 3000
const OUTPUT_KEPT = 1500

export interface LiveHooks {
  /** A step the agent just took, in plain words. */
  onAction: (line: string) => void
  /** The agent may have changed a file (an edit, or a command): look at the diff now. */
  onEdit?: () => void
  /** Everything it does, in full; an entry comes again, same id, when it finishes. */
  onTrace?: (entry: TraceEntry) => void
  /** It ended its turn and stayed quiet. `report`: its DONE or BLOCKED, if that never reached the room. `refused`: the last message the room turned down. */
  onStopped?: (s: { report?: string; refused?: string; said?: string; failed: number }) => void
}

interface Follower {
  id: number
  /** A piece of the job's text, to recognise the transcript that received it. */
  snippet: string
  hooks: LiveHooks
  file?: string
  /** Actions not finished yet, by the id their result comes back with. */
  open: Map<string, { entry: TraceEntry; report?: string; body?: string }>
  /** Its report, when the room refused it or it never posted it. */
  report?: string
  /** The last message the room refused: often the whole answer. */
  refused?: string
  /** What it last said. */
  said?: string
  /** Room calls that failed. */
  failed: number
  quietMs: number
  quiet?: NodeJS.Timeout
  /** Waiting for you: stopping is expected. */
  held: boolean
}

interface Tail {
  /** Bytes read so far (always the end of a full line). */
  offset: number
  /** The agent this transcript belongs to (by its folder, or by who its jobs were addressed to). */
  agent?: string
  follower?: number
}

const followers = new Map<number, Follower>()
const tails = new Map<string, Tail>()
const team = new Map<string, AgentLive>()
let nextId = 1
let timer: NodeJS.Timeout | undefined
let seeding = false
let emitTimer: NodeJS.Timeout | undefined

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
/** "C:\Users\me\Desktop\code" -> "C--Users-me-Desktop-code", the way Claude Code names project folders. */
const encode = (p: string) => p.replace(/[:\\/.]/g, '-')

/* ---------- the team ---------- */

/** Everyone, as of now (also the first thing the desktop app asks for). */
export function teamNow(): AgentLive[] {
  const now = Date.now()
  return Object.values(config.switch.agents).map((a) => {
    const t = team.get(a.alias)
    const p = presence.get(a.name.toLowerCase())
    const where = { online: p?.online, room: p?.room ?? undefined, via: isLocal(a.alias) ? ('this-pc' as const) : ('switch' as const) }
    const base: AgentLive = { alias: a.alias, name: a.name, does: a.does, status: 'idle', steps: [], ...where }
    if (!t) return base
    // Working, but nothing for a long while: it stopped without saying so.
    const stale = t.status === 'working' && now - (t.lastAt ?? 0) > STALE_MS
    return { ...t, ...where, does: a.does, status: stale ? 'idle' : t.status }
  })
}

function agentState(alias: string): AgentLive {
  let t = team.get(alias)
  if (!t) {
    const a = agentFor(alias)
    t = { alias, name: a?.name ?? alias, does: a?.does ?? '', status: 'idle', steps: [] }
    team.set(alias, t)
  }
  return t
}

function pushStep(t: AgentLive, step: AgentStep) {
  const last = t.steps.at(-1)
  if (last && last.text === step.text && last.detail === step.detail) return
  t.steps = [...t.steps, step].slice(-STEPS_KEPT)
  t.lastAt = step.at
}

/** Tell the desktop app, at most a few times a second. */
function changed() {
  if (seeding || emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = undefined
    emit({ type: 'team', agents: teamNow() })
  }, 250)
}

/** Start following the whole team. Called once at startup; reads only the recent past. */
export function startTeamWatch() {
  watchThroughSwitch()
  if (!existsSync(PROJECTS) || timer) return
  seeding = true
  const now = Date.now()
  for (const file of transcripts()) {
    try {
      const st = statSync(file)
      const recent = now - st.mtimeMs < SEED_WITHIN_MS
      const t: Tail = { offset: recent ? Math.max(0, st.size - SEED_BYTES) : st.size, agent: agentOfDir(file) }
      tails.set(file, t)
      if (recent) readNew(file, t, st.size, t.offset > 0)
    } catch {
      /* gone */
    }
  }
  seeding = false
  timer = setInterval(poll, POLL_MS)
  // Re-send now and then, so "idle" shows up for an agent that went quiet.
  setInterval(() => emit({ type: 'team', agents: teamNow() }), 30_000).unref()
}

/* ---------- the team, through Switch ---------- */

/** How often to ask Switch who's up. */
const PRESENCE_MS = 30_000
/** Switch's word on each agent, by its Switch name (lowercase). */
const presence = new Map<string, Presence>()
let watchingSwitch = false

/** Does this computer have the agent's transcripts? Then they're the source, in full detail. */
function isLocal(alias: string): boolean {
  for (const t of tails.values()) if (t.agent === alias) return true
  return false
}

/** The configured agent a room sender is, if any. */
const agentNamed = (name: string) => Object.values(config.switch.agents).find((a) => a.name.toLowerCase() === name.trim().toLowerCase())

function watchThroughSwitch() {
  if (watchingSwitch) return
  watchingSwitch = true
  onRoomMessage(fromRoom)
  const ask = () =>
    void teamPresence(Object.values(config.switch.agents).map((a) => a.name))
      .then((now) => {
        let moved = false
        for (const [name, p] of now) {
          const was = presence.get(name)
          if (was?.online !== p.online || was?.room !== p.room) moved = true
          presence.set(name, p)
        }
        if (moved) changed()
      })
      .catch(() => {})
  ask()
  setInterval(ask, PRESENCE_MS).unref()
}

/**
 * Oggy handed an agent a job. For an agent on another machine this is the start of its live row
 * (a local one's transcript says so itself, in more detail). Call `end` with how it went.
 */
export function teamJob(alias: string, job: string, project?: string): { end: (line: string, waiting?: boolean) => void } {
  if (isLocal(alias)) return { end() {} }
  const s = agentState(alias)
  const at = Date.now()
  s.status = 'working'
  s.task = clip(job.replace(/^in the [\w.-]+ project:\s*/i, '').split('\n')[0], 160)
  s.project = project
  s.since = at
  s.steps = []
  pushStep(s, { at, kind: 'job', text: 'Got the job' })
  changed()
  return {
    end(line) {
      if (isLocal(alias)) return
      const t = agentState(alias)
      t.status = 'idle'
      pushStep(t, { at: Date.now(), kind: 'post', text: 'Finished', detail: clip(line.replace(/^(DONE|BLOCKED|LOOKS GOOD|CHANGES NEEDED)[:\s]*/i, ''), 120) })
      changed()
    }
  }
}

/** What an agent on another machine says in Oggy's rooms: its progress, its questions, its report. */
function fromRoom(m: RoomMessage) {
  const a = agentNamed(m.senderName)
  if (!a || isLocal(a.alias)) return
  const s = agentState(a.alias)
  const first = m.body.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (!first) return
  const at = m.timestamp || Date.now()
  const asking = new RegExp(`^[\\s*_\`>]*${config.switch.markers.ask}`, 'im').test(m.body)
  if (asking) s.status = 'waiting'
  else if (REPORT().test(m.body)) s.status = s.status === 'waiting' ? 'working' : s.status
  else if (s.status !== 'idle') s.status = 'working'
  pushStep(s, { at, kind: asking ? 'ask' : 'post', text: asking ? 'Asking you' : 'Said', detail: clip(first, 120) })
  changed()
}

/* ---------- following one job ---------- */

/** Start following the agent that receives `job`. Call `stop()` when its reply is in. */
export function followAgent(job: string, hooks: LiveHooks, quietMs = QUIET_MS): { stop: () => void; hold: (held: boolean) => void } {
  if (!existsSync(PROJECTS)) return { stop() {}, hold() {} }
  // Skip the "In the x project:" lead-in: the job's own words are the most distinctive part.
  const body = squash(job.replace(/^in the [\w.-]+ project:\s*/i, ''))
  const f: Follower = { id: nextId++, snippet: body.slice(0, 70), hooks, open: new Map(), failed: 0, quietMs, held: false }
  if (f.snippet.length < 12) return { stop() {}, hold() {} }
  followers.set(f.id, f)
  startTeamWatch()
  return {
    hold(held) {
      f.held = held
      if (held) clearTimeout(f.quiet)
    },
    stop() {
      clearTimeout(f.quiet)
      followers.delete(f.id)
      for (const t of tails.values()) if (t.follower === f.id) t.follower = undefined
    }
  }
}

/* ---------- reading the transcripts ---------- */

/** The folders the agents work in: the code folder, and each agent's own Switch folder. */
function watchedDirs(): string[] {
  const code = encode(config.projectsDir).toLowerCase()
  try {
    return readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name.toLowerCase() === code || /switch-agents/i.test(d.name)))
      .map((d) => join(PROJECTS, d.name))
  } catch {
    return []
  }
}

function transcripts(): string[] {
  const out: string[] = []
  for (const dir of watchedDirs()) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(join(dir, f))
    } catch {
      /* gone */
    }
  }
  return out
}

/** "…-switch-agents-localhost-53754-claude-code-dev-aymaan" -> the agent named claude-code.dev.aymaan. */
function agentOfDir(file: string): string | undefined {
  const dir = file.replace(/[\\/][^\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const m = dir.match(/switch-agents-localhost-\d+-(.+)$/i)
  if (!m) return undefined
  const slug = m[1].toLowerCase()
  return Object.values(config.switch.agents).find((a) => a.name.replace(/[.]/g, '-').toLowerCase() === slug || a.alias === slug)?.alias
}

function poll() {
  for (const file of transcripts()) {
    let size: number
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    // A transcript that appeared after we started: read it from the top.
    let t = tails.get(file)
    if (!t) tails.set(file, (t = { offset: 0, agent: agentOfDir(file) }))
    if (size > t.offset) readNew(file, t, size, false)
  }
}

/** Read what's new in one transcript, whole lines only (a line still being written is read next time). */
function readNew(file: string, t: Tail, size: number, skipFirst: boolean) {
  const buf = read(file, t.offset, Math.min(size - t.offset, MAX_CHUNK))
  const end = buf.lastIndexOf(10)
  if (end < 0) {
    if (buf.length >= MAX_CHUNK) t.offset += buf.length // one giant line: skip it
    return
  }
  t.offset += end + 1
  const lines = buf.subarray(0, end).toString('utf8').split('\n')
  // Reading from the middle of a file: the first line is a piece of one.
  for (const line of skipFirst ? lines.slice(1) : lines) if (line.trim()) take(file, t, line)
}

function read(file: string, from: number, length: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    return buf.subarray(0, readSync(fd, buf, 0, length, from))
  } finally {
    closeSync(fd)
  }
}

/** A Switch message as the agent received it: who it was for, and the message itself. */
function switchJob(text: string): { to?: string; body: string } | undefined {
  const m = text.match(/BEGIN SWITCH MESSAGE \w+\s*\n([\s\S]*?)\nEND SWITCH MESSAGE/)
  if (!m) return undefined
  const body = m[1].trim()
  const to = body.match(/^@([\w.-]+)/)?.[1]
  return { to: to && agentFor(to)?.alias, body: body.replace(/^@[\w.-]+\s*/, '') }
}

function take(file: string, t: Tail, line: string) {
  let e: any
  try {
    e = JSON.parse(line)
  } catch {
    return
  }
  const at = Date.parse(e.timestamp ?? '') || Date.now()

  if (e.type === 'user') {
    if (Array.isArray(e.message?.content) && t.follower) finishActions(followers.get(t.follower), e.message.content, at)
    const text = textOf(e.message?.content)
    const job = typeof e.message?.content === 'string' ? switchJob(text) : undefined
    if (!job) return // a tool result: the work goes on
    // A new job: whose transcript this is (if the folder didn't say), and what it's about.
    if (!t.agent && job.to) t.agent = job.to
    if (t.agent) {
      const s = agentState(t.agent)
      s.status = 'working'
      s.task = clip(job.body.replace(/^in the [\w.-]+ project:\s*/i, '').split('\n')[0], 160)
      s.project = job.body.match(/^in the ([\w.-]+) project/i)?.[1]
      s.since = at
      s.steps = []
      pushStep(s, { at, kind: 'job', text: 'Got the job' })
      changed()
    }
    // …and if Oggy sent it, this is the transcript to follow for that job.
    if (!t.follower) {
      const said = squash(text)
      for (const f of followers.values()) {
        if (!f.file && said.includes(f.snippet)) {
          f.file = file
          t.follower = f.id
          f.hooks.onAction('Read the job, starting')
          break
        }
      }
    }
    return
  }

  if (e.type !== 'assistant') return
  const s = t.agent ? agentState(t.agent) : undefined
  const f = t.follower ? followers.get(t.follower) : undefined
  if (f) clearTimeout(f.quiet)
  const who = t.agent ?? '?'
  for (const c of e.message?.content ?? []) {
    let step: AgentStep | undefined
    if (c.type === 'tool_use') {
      step = describe(c.name, c.input ?? {}, at)
      if (f) startAction(f, who, c, step, at)
      if (/^(Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell)$/.test(c.name)) f?.hooks.onEdit?.()
      // Its message to the room: an ASK means it's waiting for you.
      const post = c.name === 'mcp__switch__post_message' ? String(c.input?.body ?? '') : ''
      if (s && new RegExp(`^\\s*${config.switch.markers.ask}`, 'im').test(post)) {
        s.status = 'waiting'
        step = { at, kind: 'ask', text: 'Asking you', detail: clip(post.match(new RegExp(`${config.switch.markers.ask}\\s*(.+)`, 'i'))?.[1] ?? '', 120) }
      }
    } else if (c.type === 'text' && typeof c.text === 'string') {
      // What it says between steps: the first sentence, as a thought.
      if (f && c.text.trim()) noteWords(f, who, c.text.trim(), e.uuid ?? `${at}`, at)
      const first = c.text.trim().split(/(?<=[.!?])\s|\n/)[0]
      if (first && first.length > 8 && !/^(DONE|BLOCKED|LOOKS GOOD|CHANGES NEEDED|ASK)/i.test(first)) step = { at, kind: 'think', text: clip(first, 140) }
    }
    if (!step) continue
    if (s) {
      pushStep(s, step)
      if (s.status === 'idle') s.status = 'working'
    }
    f?.hooks.onAction(lineOf(step))
  }
  // The turn is over: it answered and stopped (unless it's waiting on your answer).
  const stop = e.message?.stop_reason
  if (f && (stop === 'end_turn' || stop === 'stop_sequence') && !f.held) {
    const known = f.report || f.refused
    f.quiet = setTimeout(() => f.hooks.onStopped?.({ report: f.report, refused: f.refused, said: f.said, failed: f.failed }), known ? Math.min(REPORT_GRACE_MS, f.quietMs) : f.quietMs)
    f.quiet.unref?.()
  }
  if (s && (stop === 'end_turn' || stop === 'stop_sequence') && s.status !== 'waiting') {
    s.status = 'idle'
    s.lastAt = at
  }
  if (s) changed()
}

const REPORT = () => new RegExp(`^[\\s*_\`>]*(?:${[config.switch.markers.done, config.switch.markers.blocked, config.switch.markers.looksGood, config.switch.markers.changesNeeded].join('|')})`, 'im')

/** Room housekeeping, in plain words, because it's where a job goes quietly wrong. */
const ROOM_ACTIONS: Record<string, string> = {
  mcp__switch__connect_to_room: 'Joining the room',
  mcp__switch__assume_role: 'Taking its seat in the room',
  mcp__switch__read_context: 'Reading the room'
}

/** An action started: it goes in the live window now, and again when it ends. */
function startAction(f: Follower, agent: string, c: { id?: string; name: string; input?: Record<string, any> }, step: AgentStep | undefined, at: number) {
  const body = c.name === 'mcp__switch__post_message' ? String(c.input?.body ?? '') : ''
  const text = step?.text ?? ROOM_ACTIONS[c.name]
  if (!text || !c.id) {
    if (REPORT().test(body)) f.report = body
    return
  }
  const entry: TraceEntry = { id: c.id, at, agent, kind: step?.kind ?? 'other', text, detail: step?.detail ?? (body ? clip(body.replace(/\s+/g, ' '), 140) : undefined), ...(step?.items?.length ? { items: step.items } : {}) }
  // A report counts as delivered only once the room took it.
  f.open.set(c.id, { entry, report: REPORT().test(body) ? body : undefined, body: body || undefined })
  f.hooks.onTrace?.(entry)
}

/** Results came back: how each action ended. */
function finishActions(f: Follower | undefined, content: any[], at: number) {
  if (!f) return
  clearTimeout(f.quiet)
  for (const c of content) {
    if (c?.type !== 'tool_result') continue
    const open = f.open.get(c.tool_use_id)
    if (!open) continue
    f.open.delete(c.tool_use_id)
    const text = textOf(c.content)
    const bad = Boolean(c.is_error) || /Not connected to a room/i.test(text)
    if (open.report) {
      if (bad) f.report = open.report
      else if (f.report === open.report) f.report = undefined
    }
    if (bad && open.entry.text.match(/room|Posting/i)) f.failed++
    if (bad && open.body) f.refused = open.body
    f.hooks.onTrace?.({ ...open.entry, ok: !bad, endedAt: at, output: clip(text.trim(), OUTPUT_KEPT) || undefined })
  }
}

/** The agent's own words. A report it wrote out but never posted still counts as its report. */
function noteWords(f: Follower, agent: string, text: string, id: string, at: number) {
  f.said = clip(text, 2000)
  if (REPORT().test(text)) f.report = text
  f.hooks.onTrace?.({ id, at, agent, kind: 'say', text: clip(text, 2000) })
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : typeof c?.content === 'string' ? c.content : '')).join(' ')
  return ''
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** A step as one plain line ("Reading routes/index.ts"), for job feeds. */
const lineOf = (s: AgentStep) =>
  s.kind === 'think' ? `“${s.text}”` : s.kind === 'run' ? s.text + (s.slow ? `. ${s.slow}` : '') : [s.text, s.detail].filter(Boolean).join(' ')

/** "C:\Users\me\Desktop\code\dashboard-crm\backend\routes\index.ts" -> "backend/routes/index.ts". */
function short(p: unknown): string {
  let s = String(p ?? '').replace(/\\/g, '/')
  const root = config.projectsDir.replace(/\\/g, '/')
  if (s.toLowerCase().startsWith(root.toLowerCase())) s = s.slice(root.length).replace(/^\/[^/]+\//, '')
  return s.length > 60 ? '…' + s.slice(-58) : s
}

/**
 * A shell command, in plain words. The slow ones (installing packages, a full build) say so,
 * so a long wait reads as "installing, this takes a while" instead of nothing happening.
 * The first match wins: "npm ci && npm run build" is mostly the install.
 */
function command(cmd: string, said: string, at: number): AgentStep {
  const run = (text: string, slow?: string): AgentStep => ({ at, kind: 'run', text, detail: clip(cmd, 90), slow })
  if (/\b(npm (ci|i|install)|pnpm (i|install)|yarn( install)?|bun (i|install))\b/.test(cmd)) return run('Installing the project’s packages', 'The first install can take a few minutes')
  if (/\b(next build|vite build|(npm|pnpm|yarn|bun)( run)? build)\b/.test(cmd)) return run('Building the whole app to check it', 'A full build takes a minute or two')
  if (/\bprisma (generate|migrate)\b/.test(cmd)) return run('Generating the database client', 'Usually under a minute')
  // Otherwise the agent's own words for it are best; guess only when it gave none.
  if (said) return run(said)
  const first = cmd.split(/\s*(?:&&|;|\|)\s*/).find((c) => !/^(cd|export|set)\b/.test(c)) ?? cmd
  if (/^git\b/.test(first)) return run('Working with git')
  if (/\b(test|vitest|jest|pytest|mocha)\b/.test(first)) return run('Running the tests')
  if (/\btsc\b|\blint\b|eslint/.test(first)) return run('Checking the types')
  return run('Running a command')
}

/** A tool call, as a plain step. Bookkeeping (loading tools, joining the room) says nothing. */
function describe(tool: string, input: Record<string, any>, at: number): AgentStep | undefined {
  switch (tool) {
    case 'Read':
      return { at, kind: 'read', text: 'Reading', detail: short(input.file_path) }
    case 'Edit':
    case 'MultiEdit':
      return { at, kind: 'edit', text: 'Editing', detail: short(input.file_path) }
    case 'Write':
      return { at, kind: 'edit', text: 'Writing', detail: short(input.file_path) }
    case 'NotebookEdit':
      return { at, kind: 'edit', text: 'Editing', detail: short(input.notebook_path) }
    case 'Bash':
    case 'PowerShell':
      return command(String(input.command ?? '').replace(/\s+/g, ' '), input.description ? clip(String(input.description), 90) : '', at)
    case 'Grep':
      return { at, kind: 'search', text: 'Searching the code for', detail: `“${clip(String(input.pattern ?? ''), 40)}”` }
    case 'Glob':
      return { at, kind: 'search', text: 'Looking for files', detail: clip(String(input.pattern ?? ''), 50) }
    case 'TodoWrite':
      return { at, kind: 'plan', text: 'Planning the steps' }
    case 'Task':
    case 'Agent':
      return { at, kind: 'other', text: 'Asking a helper', detail: clip(String(input.description ?? 'a side task'), 60) }
    case 'WebFetch':
    case 'WebSearch':
      return { at, kind: 'search', text: 'Looking something up online' }
    case 'mcp__switch__post_message':
      return { at, kind: 'post', text: 'Posting in the room' }
    default:
      return connector(tool, input, at)
  }
}

/** Every "- [ ] Reply to Maaz" in what it's writing, wherever in the call it sits. */
function checklist(input: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(/^\s*[-*]\s*\[[ xX]?\]\s+(.+)$/gm)) out.push(clip(m[1].trim(), 120))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(input)
  return out.slice(0, 50)
}

/** A page's title, from however the connector was given it. */
function titleOf(input: Record<string, any>): string | undefined {
  const page = Array.isArray(input.pages) ? input.pages[0] : input
  const t = page?.properties?.title ?? page?.title ?? input.title
  return typeof t === 'string' ? clip(t, 60) : undefined
}

/**
 * The owner's apps through claude.ai's connectors (Gmail, Calendar, Notion), in plain words, so a
 * routine shows what it's doing: reading mail, checking the calendar, writing to-dos.
 */
function connector(tool: string, input: Record<string, any>, at: number): AgentStep | undefined {
  const m = tool.match(/^mcp__claude_ai_([A-Za-z_]+)__(.+)$/)
  if (!m) return undefined
  const [, app, op] = m
  if (app === 'Gmail') {
    if (/search|list_threads|list_messages/.test(op)) return { at, kind: 'mail', text: 'Reading your mail', detail: input.query ? clip(String(input.query), 60) : undefined }
    if (/get_thread|get_message/.test(op)) return { at, kind: 'mail', text: 'Opening an email' }
    if (/draft/.test(op) && !/list|get|delete/.test(op)) return { at, kind: 'draft', text: 'Drafting an email', detail: input.subject ? clip(String(input.subject), 70) : undefined }
    if (/send|reply|forward/.test(op)) return { at, kind: 'draft', text: 'Sending an email', detail: input.subject ? clip(String(input.subject), 70) : undefined }
    return { at, kind: 'mail', text: 'Sorting your mail' }
  }
  if (app === 'Google_Calendar') {
    if (/create|update/.test(op)) return { at, kind: 'calendar', text: 'Adding to your calendar', detail: clip(String(input.summary ?? input.title ?? ''), 70) || undefined }
    return { at, kind: 'calendar', text: 'Checking your calendar' }
  }
  if (app === 'Notion') {
    const items = checklist(input)
    if (/create|update|append|insert/.test(op)) {
      const title = titleOf(input)
      return items.length
        ? { at, kind: 'todo', text: `Adding ${items.length} to-do${items.length === 1 ? '' : 's'}`, detail: title, items }
        : { at, kind: 'notes', text: /create/.test(op) ? 'Creating a Notion page' : 'Writing in Notion', detail: title }
    }
    return { at, kind: 'notes', text: 'Looking in Notion', detail: input.query ? clip(String(input.query), 60) : undefined }
  }
  if (app === 'Google_Drive') return { at, kind: 'read', text: 'Looking in Drive', detail: input.query ? clip(String(input.query), 60) : undefined }
  return undefined
}
