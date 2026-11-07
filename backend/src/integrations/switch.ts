import { randomUUID } from 'node:crypto'
import { config, type Agent } from '../config.js'
import { memory } from '../db.js'
import { log } from '../events.js'
import { isEveryday } from '../shared/everyday.js'
import type { IntegrationStatus, Run } from '../shared/types.js'

/**
 * Switch: the shared room connecting you, Oggy, @claude and @reviewer.
 * Oggy holds one WebSocket open (see "the connection" below) and reconnects by itself.
 * Every coding job is one thread in #team: what you asked, the agents' hand-offs, ASKs, approvals
 * and the result, so jobs never mix and the room reads like a log of work.
 */

export interface RoomMessage {
  roomId: string
  id: string
  threadId: string | null
  sender: string
  senderName: string
  body: string
  /** True when the message @-mentions Oggy. */
  addressed: boolean
  timestamp: number
}

export interface AgentReply {
  outcome: 'done' | 'blocked' | 'timeout'
  /** The marker line itself, e.g. "DONE: added a dark mode toggle". */
  line: string
  body: string
  /** It reached the room as the agent's own message, not read from its session. */
  posted?: boolean
}

const sw = config.switch
const base = `${sw.apiUrl}/agents/${sw.agentId}`
const RECONNECT_MS = 2000
const JOB_TIMEOUT_MS = 30 * 60_000
/** Not a word from an agent this long after its job went out: ping it once. */
const NUDGE_MS = 3 * 60_000
/** What Switch says on an agent's behalf when it can't run it (no session, machine offline, not live). */
const CANT_RUN = /couldn't start a session|session host is not running|did not take a message|isn't reporting as live|don't have a session connected|not online in this room|machine is offline/i

/** Kept for every reconnect, so the server resumes this connection instead of starting another. */
const connectionId = randomUUID()
let online = false
let started = false
/** Room this connection is connected to via connect_to_room (reset on every reconnect). */
let connectedRoom: string | undefined
const listeners = new Set<(m: RoomMessage) => void>()

/** The room ids can be left out of the config: Oggy finds its rooms by name when it connects. */
export const switchConfigured = () => Boolean(sw.apiUrl && sw.agentId && sw.apiKey)
export const switchOnline = () => online

export function switchStatus(): IntegrationStatus {
  if (!switchConfigured()) {
    return { name: 'switch', ready: false, detail: 'Add switch.apiUrl, agentId and agentApiKey to ~/.oggy/config.json' }
  }
  if (online && !sw.rooms.team) return { name: 'switch', ready: false, detail: `Listening as ${sw.agentName}, but no room named "team" (run switch/oggy-team.template.yaml)` }
  return { name: 'switch', ready: online, detail: online ? `Listening as ${sw.agentName}` : `Can't reach Switch at ${sw.apiUrl}, retrying` }
}

/** The rooms Oggy can see right now, or undefined when Switch didn't say (which says nothing about any room). */
async function liveRooms(): Promise<{ room_id: string; name: string; archived?: boolean }[] | undefined> {
  const listed = await call<{ result?: unknown }>('/ops/list_rooms', {}).then((r) => r.result).catch(() => undefined)
  return Array.isArray(listed) ? (listed as { room_id: string; name: string; archived?: boolean }[]).filter((r) => !r.archived) : undefined
}

/** The names the template gives Oggy's rooms. */
const ROOM_NAMES = { team: 'team', oggyDaily: 'oggy-daily' } as const

/**
 * Who Oggy is on this server, and its rooms when the config doesn't name them: the agent's own name
 * (so its posts are recognised as its own), and #team / #oggy-daily by name, as the template makes them.
 */
async function findMyself(): Promise<void> {
  const me = await call<{ result?: { you?: { name?: string } } }>('/ops/get_my_context', {})
  if (me.result?.you?.name) sw.agentName = me.result.you.name
  await findRooms()
}

/** #team and #oggy-daily, if Oggy is in them yet. Returns the ones it just found. */
async function findRooms(): Promise<string[]> {
  const rooms = await liveRooms()
  // A project room you deleted in Switch: its jobs go back to the team room, and it gets a new room when asked.
  if (rooms) for (const m of memory.list()) if (m.key.startsWith('project.room.') && m.value && !rooms.some((r) => r.room_id === m.value)) memory.set(m.key, '')
  const found: string[] = []
  if ((sw.rooms.team && sw.rooms.oggyDaily) || !rooms) return found
  for (const [key, name] of Object.entries(ROOM_NAMES) as [keyof typeof ROOM_NAMES, string][]) {
    if (sw.rooms[key]) continue
    const room = rooms.find((r) => r.name.toLowerCase() === name)
    if (room) {
      sw.rooms[key] = room.room_id
      found.push(room.room_id)
      log('info', `Found #${name} (${room.room_id})`)
    } else if (key === 'team' && !warnedNoTeam) {
      warnedNoTeam = true
      log('warn', 'No room named "team" for Oggy yet: invite it in Switch Console (no restart needed), or set rooms.team in ~/.oggy/config.json')
    }
  }
  return found
}
let warnedNoTeam = false

/**
 * Invited to a room while running: pick it up without a restart. #team gets its seats, and the
 * connection reconnects (resuming where it was) if it isn't listening to the new room yet.
 */
async function roomsChanged(why: string): Promise<void> {
  if (!online || (sw.rooms.team && sw.rooms.oggyDaily)) return
  const found = await findRooms().catch((err) => (log('warn', `Couldn't look up Oggy's rooms (${(err as Error).message})`), [] as string[]))
  if (!found.length) return
  log('info', `Joined ${found.length === 1 ? 'a room' : 'rooms'} while running (${why}): no restart needed`)
  if (found.includes(sw.rooms.team)) void ensureRoles(sw.rooms.team).catch((err) => log('warn', `Couldn't set up the roles in #team: ${(err as Error).message}`))
  if (found.some((id) => !listening.has(id))) socket?.close()
}

/** While #team or #oggy-daily is missing, check now and then, in case an invite came without an event. */
const ROOM_CHECK_MS = 60_000

/** What Switch knows about an agent, wherever it runs: is a session of it up, and in which room it's working. */
export interface Presence {
  online: boolean
  /** The room a live session of it is in ("paytrack"), when it's in one. */
  room?: string
  lastSeen?: number
}

/** Agent ids by name (they don't change, so asked once). */
let agentIds: Map<string, string> | undefined

/**
 * Switch's own view of the team, through ops any agent may call: `list_agents` for the ids, then
 * `get_agent_detail` for each one's sessions. Works for agents on any machine, unlike the transcripts
 * agentLive.ts reads on this one. Agents Switch didn't answer for are left out.
 */
export async function teamPresence(names: string[]): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>()
  if (!online) return out
  if (!agentIds) {
    const listed = await call<{ result?: unknown }>('/ops/list_agents', {}).then((r) => r.result)
    const rows = (Array.isArray(listed) ? listed : ((listed as { agents?: unknown[] })?.agents ?? [])) as { id?: string; name?: string }[]
    agentIds = new Map(rows.filter((a) => a.id && a.name).map((a) => [a.name!.toLowerCase(), a.id!]))
  }
  await Promise.all(
    names.map(async (name) => {
      const id = agentIds!.get(name.toLowerCase())
      if (!id) return
      const detail = await call<{ result?: { sessions?: { state?: string; room_name?: string | null; last_seen_at?: string }[] } }>('/ops/get_agent_detail', { agent_id: id })
        .then((r) => r.result)
        .catch(() => undefined)
      if (!detail) return
      const live = (detail.sessions ?? []).filter((s) => s.state === 'live')
      // "2026-11-07 07:35:29.578803+00:00": a space where ISO has a T.
      const seen = (detail.sessions ?? []).map((s) => Date.parse((s.last_seen_at ?? '').replace(' ', 'T'))).filter(Number.isFinite)
      out.set(name.toLowerCase(), {
        online: live.length > 0,
        room: live.find((s) => s.room_name)?.room_name ?? undefined,
        lastSeen: seen.length ? Math.max(...seen) : undefined
      })
    })
  )
  return out
}

/** Subscribe to every new message in Oggy's rooms. */
export function onRoomMessage(cb: (m: RoomMessage) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

async function call<T>(path: string, body: unknown = {}, withConnection = false): Promise<T> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sw.apiKey}`,
      'content-type': 'application/json',
      ...(withConnection ? { 'X-Switch-Connection-Id': connectionId } : {})
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Switch ${res.status} on ${path}: ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** Post a plain message into a room (defaults to #team). */
export async function postToRoom(text: string, roomId = sw.rooms.team): Promise<void> {
  await call('/message', { room_id: roomId, content: text })
}

async function ensureRoom(roomId: string) {
  if (connectedRoom === roomId) return
  await call('/ops/connect_to_room', { room_id: roomId, include_general_instructions: false }, true)
  connectedRoom = roomId
}

/**
 * Connected ops happen in the session's current room, and jobs in different rooms run at once,
 * so each "switch to the room, then act" runs whole, one at a time.
 */
let opQueue: Promise<unknown> = Promise.resolve()
function inRoom<T>(roomId: string, op: () => Promise<T>): Promise<T> {
  const next = opQueue.then(async () => {
    await ensureRoom(roomId)
    return op()
  })
  opQueue = next.catch(() => {})
  return next
}

/* ---------- rooms and threads ---------- */

/** The project a job is about, if any. */
const projectOfRun = (r: Pick<Run, 'steps'>) => r.steps.map((s) => s.args?.project).find((p): p is string => typeof p === 'string' && p !== '')

const roomKey = (project: string) => `project.room.${project.toLowerCase()}`
/** A project's own room, once it has one. */
export const projectRoomOf = (project?: string) => (project ? memory.get(roomKey(project)) || undefined : undefined)
/** The project whose room this is ("react-flow" for #react-flow). */
export const projectOfRoom = (roomId: string) =>
  memory
    .list()
    .find((m) => m.key.startsWith('project.room.') && m.value === roomId)
    ?.key.slice('project.room.'.length)

/** Coding (agents, projects, deploys) belongs with the team; everyday things (screenshots, apps, files) in #oggy-daily. */
export const isCoding = (r: Pick<Run, 'steps'>) => !isEveryday(r.steps) && r.steps.some((s) => s.kind === 'agent.job' || s.kind === 'deploy' || typeof s.args?.project === 'string')
/** Where a job belongs: its project's room, else #team; everyday things in #oggy-daily. */
export const homeRoom = (r: Pick<Run, 'steps'>): string => (isCoding(r) ? (projectRoomOf(projectOfRun(r)) ?? sw.rooms.team) : sw.rooms.oggyDaily)

const threadKey = (runId: string) => `run.thread.${runId}`
const threadRoomKey = (runId: string) => `run.thread-room.${runId}`
/** The thread a job's messages go in (the id of its first message), if it has one. */
export const threadOf = (runId: string) => memory.get(threadKey(runId)) || undefined
/** The room that thread is in (#team or the project's room). */
export const threadRoomOf = (runId: string) => (threadOf(runId) ? memory.get(threadRoomKey(runId)) || sw.rooms.team : undefined)
export function setThread(runId: string, threadId: string, roomId = sw.rooms.team) {
  memory.set(threadKey(runId), threadId)
  memory.set(threadRoomKey(runId), roomId)
}

/**
 * Open a job's thread with `text` (what you asked for) in its room, and remember it for the run.
 * Threads need the live connection; without it the text still goes in, just not as a thread.
 */
export async function openThread(runId: string, text: string, roomId = sw.rooms.team): Promise<string | undefined> {
  try {
    const r = await inRoom(roomId, () => call<{ result?: { event_id?: string }; event_id?: string }>('/ops/post_message', { body: text }, true))
    const id = r.result?.event_id ?? r.event_id
    if (id) setThread(runId, id, roomId)
    return id
  } catch (err) {
    log('warn', `Couldn't open a thread (${(err as Error).message}), posting without one`)
    await postToRoom(text, roomId)
    return undefined
  }
}

/** Post into a thread, or top-level when there's no thread. */
export async function postInThread(text: string, threadId?: string, roomId = sw.rooms.team): Promise<void> {
  if (!threadId) return postToRoom(text, roomId)
  await inRoom(roomId, () => call('/ops/post_message', { body: text, thread_id: threadId }, true))
}

/* ---------- roles ----------
 * Each agent's job on the team is a Switch role in #team (`!roles` there shows who holds what).
 * The seat says who does the job: whoever holds it gets it (by name, see askAgent); an empty seat goes
 * to the agent, and the job asks it to take the seat.
 * Only in #team: Switch lets an agent hold one role at a time, in one room, so a seat per project
 * room would make agents give up their team seat. Project rooms address agents by name.
 */

export interface RoleSpec {
  name: string
  instructions: string
  exclusive: boolean
}

/** Role names can't clash with agent names in a room, so the seats have their own names. */
const SEATS: Record<string, { name: string; instructions: string }> = {
  claude: { name: 'builder', instructions: 'General coder: builds and fixes anything in the project that no one else owns. Commit only on the branch Oggy gives you.' },
  frontend: { name: 'ui-dev', instructions: 'Builds and fixes UI only. Never edits backend code.' },
  backend: { name: 'api-dev', instructions: 'Builds and fixes APIs, server and database only. Never edits frontend code.' },
  tester: { name: 'qa', instructions: 'Proves bugs with a failing test, then confirms the fix. Only changes test files.' },
  scout: { name: 'investigator', instructions: 'Investigates and explains. Never edits anything.' },
  reviewer: { name: 'code-reviewer', instructions: 'Checks changes before they ship and ends with LOOKS GOOD or CHANGES NEEDED: what must change. Never edits anything.' },
  release: { name: 'release-manager', instructions: 'Writes the release notes, and ships to main once the team has voted yes. Never edits code.' }
}

/** An agent's seat on the team: its role name and what the role asks of it. */
export function roleOf(agent: Agent): RoleSpec {
  const seat = SEATS[agent.alias] ?? { name: `${agent.alias}-seat`, instructions: agent.does }
  return { name: seat.name, instructions: `${seat.instructions} Jobs come from @${sw.agentName} and you report back to it only.`, exclusive: true }
}

/** Rooms whose roles are being or have been defined (this run of Oggy): one setup per room, even when jobs start together. */
const rolesReady = new Map<string, Promise<void>>()

interface RoleState {
  name: string
  held_by?: { name: string }[]
}

async function listRoles(roomId: string): Promise<RoleState[]> {
  const r = await inRoom(roomId, () => call<{ result?: RoleState[] | { roles?: RoleState[] } }>('/ops/list_roles', {}, true))
  return Array.isArray(r.result) ? r.result : (r.result?.roles ?? [])
}

/** Define the team's roles in a room, once; seats nobody has taken yet are fine. */
export function ensureRoles(roomId: string): Promise<void> {
  let setup = rolesReady.get(roomId)
  if (!setup) {
    setup = (async () => {
      const have = new Set((await listRoles(roomId)).map((r) => r.name))
      for (const agent of Object.values(sw.agents)) {
        const role = roleOf(agent)
        if (!have.has(role.name)) await inRoom(roomId, () => call('/ops/define_role', role, true))
      }
    })()
    rolesReady.set(roomId, setup)
    // A failed setup is tried again next time.
    setup.catch(() => rolesReady.delete(roomId))
  }
  return setup
}

/** Who to send an agent's job to: in #team its role (with whoever holds it); elsewhere nothing, so by name. */
async function addressFor(agent: Agent, roomId: string): Promise<{ role: string; holders: string[] } | undefined> {
  if (roomId !== sw.rooms.team) return undefined
  const role = roleOf(agent).name
  await ensureRoles(roomId)
  const state = (await listRoles(roomId)).find((r) => r.name === role)
  return { role, holders: (state?.held_by ?? []).map((h) => h.name) }
}

/** Seats an earlier Oggy defined in a project room: nobody can sit there (see above), so they go. */
async function clearProjectSeats(roomId: string): Promise<void> {
  const seats = new Set(Object.values(sw.agents).map((a) => roleOf(a).name))
  for (const r of await listRoles(roomId)) {
    if (seats.has(r.name) && !r.held_by?.length) await inRoom(roomId, () => call('/ops/delete_role', { name: r.name }, true))
  }
}

/* ---------- room memory ----------
 * Each work room keeps a log document: what every reviewed job changed and what you decided, newest
 * first. Switch shows room documents to every agent that joins, so the next job (or teammate)
 * starts from what the room already did instead of a fresh guess.
 */

export interface LogEntry {
  at: number
  /** "Register crash fix" */
  title: string
  /** What you asked, word for word. */
  asked: string
  /** "Aymaan (voice)" */
  who: string
  /** "✅ kept", "↩️ undone", "✏️ change asked: friendlier message" */
  decision: string
  summary?: string
  files: string[]
  tests?: string
  branch?: string
  risks: string[]
}

/** Entries a log keeps (the oldest drop off). */
const LOG_KEEP = 40
const logDocKey = (roomId: string) => `room.log.${roomId}`
const logEntriesKey = (roomId: string) => `room.log.entries.${roomId}`
/** The room's log document, once Oggy has made it. */
export const roomLogOf = (roomId: string) => memory.get(logDocKey(roomId)) || undefined
export const logNameFor = (roomId: string) => (roomId === sw.rooms.team ? 'Team log' : 'Project log')

const when = (at: number) => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The log as the document agents and people read. */
export function renderLog(roomName: string, entries: LogEntry[], name = 'Project log'): string {
  const body = entries.map((e) =>
    [
      `## ${when(e.at)} · ${e.title} · ${e.decision}`,
      `- Asked: "${e.asked}" (${e.who})`,
      e.summary && `- What happened: ${e.summary}`,
      e.files.length > 0 && `- Files: ${e.files.slice(0, 15).join(', ')}${e.files.length > 15 ? ` and ${e.files.length - 15} more` : ''}`,
      e.tests && `- Tests: ${e.tests}`,
      e.branch && `- Branch: ${e.branch}`,
      e.risks.length > 0 && `- Watch out: ${e.risks.join(' · ')}`
    ]
      .filter(Boolean)
      .join('\n')
  )
  return [`# ${name}: ${roomName}`, `What earlier jobs in this room changed and what was decided, newest first. Kept by @${sw.agentName}.`, ...body].join('\n\n')
}

/** Add a job to its room's log (making the document the first time). */
export async function addToRoomLog(roomId: string, roomName: string, entry: LogEntry): Promise<void> {
  let entries: LogEntry[] = []
  try {
    entries = JSON.parse(memory.get(logEntriesKey(roomId)) || '[]') as LogEntry[]
  } catch {
    /* start over */
  }
  entries = [entry, ...entries].slice(0, LOG_KEEP)
  memory.set(logEntriesKey(roomId), JSON.stringify(entries))
  const name = logNameFor(roomId)
  const content = renderLog(roomName, entries, name)
  const existing = roomLogOf(roomId)
  if (existing) {
    try {
      await inRoom(roomId, () => call('/ops/update_room_document', { document_id: existing, content }, true))
      return
    } catch (err) {
      // Someone deleted it in the room: make it again.
      log('warn', `Couldn't update the ${name} (${(err as Error).message}), making a new one`)
    }
  }
  const doc = {
    description: `What earlier jobs here changed and what was decided, newest first`,
    instructions: `Read this before a job that builds on earlier work in this room: it lists what was changed, why, the tests, and whether ${config.owner.name} kept it, undid it or asked for a change. Don't redo work it lists as kept.`,
    content
  }
  const made = await inRoom(roomId, () =>
    call<{ result?: { document_id?: string } }>('/ops/create_room_document', { name, ...doc }, true).catch(() =>
      // The name is taken (an old log Oggy lost track of): a dated one instead.
      call<{ result?: { document_id?: string } }>('/ops/create_room_document', { name: `${name} ${new Date().toISOString().slice(0, 10)}`, ...doc }, true)
    )
  )
  if (made.result?.document_id) memory.set(logDocKey(roomId), made.result.document_id)
}

const WORKFLOWS_DOC = 'room.workflows.doc'

/** The saved workflows as a document in #team, so agents and teammates can read what exists. */
export async function writeWorkflowsDoc(content: string): Promise<void> {
  const roomId = sw.rooms.team
  const existing = memory.get(WORKFLOWS_DOC)
  if (existing) {
    try {
      await inRoom(roomId, () => call('/ops/update_room_document', { document_id: existing, content }, true))
      return
    } catch (err) {
      log('warn', `Couldn't update the Workflows document (${(err as Error).message}), making a new one`)
    }
  }
  const doc = { description: 'The workflows saved with Oggy, step by step', instructions: `Read this to see what a workflow will ask of you. Only ${config.owner.name} can start one.`, content }
  const made = await inRoom(roomId, () =>
    call<{ result?: { document_id?: string } }>('/ops/create_room_document', { name: 'Workflows', ...doc }, true).catch(() =>
      call<{ result?: { document_id?: string } }>('/ops/create_room_document', { name: `Workflows ${new Date().toISOString().slice(0, 10)}`, ...doc }, true)
    )
  )
  if (made.result?.document_id) memory.set(WORKFLOWS_DOC, made.result.document_id)
}

/* ---------- a room per project ---------- */

/** Rooms Oggy makes are filed under this group in Switch, so the projects sit together. */
const PROJECTS_GROUP = 'Projects'

const teamUsers = (inRoom?: string[]) => {
  const all = [...new Set([...(inRoom ?? []), ...config.team.map((p) => p.username).filter(Boolean)])]
  return all.length ? all : null
}

async function ensureGroup(): Promise<string | undefined> {
  try {
    const groups = await call<{ result?: { name: string }[] }>('/ops/list_room_groups', {}, true)
    if (!groups.result?.some((g) => g.name === PROJECTS_GROUP)) {
      await call('/ops/create_room_group', { name: PROJECTS_GROUP, description: 'One room per project, made by Oggy' }, true)
    }
    return PROJECTS_GROUP
  } catch (err) {
    log('warn', `No Projects group (${(err as Error).message}); the room is made without one`)
    return undefined
  }
}

/* A project's GitHub repository is a Switch reference on its room: agents read the repo itself
 * (history, issues, pull requests) instead of a copy of it in the instructions. */

/** "<url> <reference id>": the reference made for the project, and which repo it points at. */
const refKey = (project: string) => `project.ref.${project.toLowerCase()}`
/** The room that reference is attached to. */
const refRoomKey = (project: string) => `project.ref-room.${project.toLowerCase()}`

/** The project's GitHub reference (made the first time, or again when the repo moved). Never in the way of the room. */
async function repoReference(project: string, url: string): Promise<string | undefined> {
  const known = memory.get(refKey(project))
  if (known?.startsWith(`${url} `)) return known.slice(url.length + 1)
  try {
    const r = await call<{ result?: { id?: string } }>(
      '/ops/create_reference',
      {
        type: 'github',
        name: `${project} on GitHub`,
        description: `The ${project} repository`,
        instructions: `The ${project} code on GitHub: read it for the project's history, issues and pull requests. Work in the folder the room instructions give, never a fresh clone, and push only when a job from @${sw.agentName} says so.`,
        value: { urls: [url] }
      },
      true
    )
    const id = r.result?.id
    if (id) memory.set(refKey(project), `${url} ${id}`)
    return id
  } catch (err) {
    log('warn', `Couldn't make ${project}'s GitHub reference: ${(err as Error).message}`)
    return undefined
  }
}

/** Attach the repo to a room that doesn't have it yet (one made before references, say). */
async function attachRepo(project: string, roomId: string, url: string): Promise<void> {
  if (memory.get(refRoomKey(project)) === roomId && memory.get(refKey(project))?.startsWith(`${url} `)) return
  const ref = await repoReference(project, url)
  if (!ref) return
  await call('/ops/attach_reference_to_room', { room_id: roomId, reference_id: ref }, true)
    .then(() => memory.set(refRoomKey(project), roomId))
    .catch((err) => log('warn', `Couldn't attach ${project}'s GitHub repo to its room: ${(err as Error).message}`))
}

/**
 * Give a project its own room, set up like #team: same chat app, you and every agent in it, the
 * project's own facts as instructions, its GitHub repo as a reference, linked both ways with #team.
 * The team's rules come from the configured packages, or are copied from #team without one.
 * From then on its jobs open their threads there.
 */
export async function createProjectRoom(project: string, facts: string, repoUrl?: string): Promise<{ id: string; made: boolean }> {
  const known = projectRoomOf(project)
  if (known) {
    const rooms = await liveRooms()
    if (!rooms || rooms.some((r) => r.room_id === known)) {
      if (repoUrl) await attachRepo(project, known, repoUrl)
      return { id: known, made: false }
    }
    log('info', `#${project}'s room is gone, making a new one`)
    memory.set(roomKey(project), '')
  }
  const team = (await call<{ result: { bridge_id?: string; channel_type?: string; instructions?: string; connected_user_names?: string[]; aliases?: Record<string, string> } }>('/ops/get_room_detail', { room_id: sw.rooms.team }, true)).result
  // The team. The owner's own Claude stays out of project rooms.
  const agents = [...new Set([sw.agentName, ...Object.values(sw.agents).filter((a) => !a.isDefault).map((a) => a.name)])]
  const group = await ensureGroup()
  const ref = repoUrl ? await repoReference(project, repoUrl) : undefined
  const rules = sw.packages.length || !team.instructions ? '' : `\n\n${team.instructions}`
  const created = await call<{ result: { id: string } }>(
    '/ops/create_room',
    {
      name: project,
      description: `The ${project} project: its jobs, one thread each`,
      agent_names: agents,
      // The people on the team, as well as whoever is in the team room.
      user_names: teamUsers(team.connected_user_names),
      bridge_id: team.bridge_id ?? null,
      channel_type: team.bridge_id ? team.channel_type || 'channel_public' : null,
      instructions: `This is the room for the ${project} project. Every job here is about ${project} only.\n\n${facts}${rules}`,
      reference_ids: ref ? [ref] : null,
      package_ids: sw.packages.length ? sw.packages : null,
      linked_rooms: [{ target_room_id: sw.rooms.team, label: 'the team room' }],
      aliases: team.aliases ? Object.fromEntries(Object.entries(team.aliases).filter(([name]) => agents.includes(name))) : null,
      group_name: group ?? null
    },
    true
  )
  const id = created.result.id
  memory.set(roomKey(project), id)
  if (ref) memory.set(refRoomKey(project), id)
  // #team points at every project room, so agents (and you) can find them from there.
  await call('/ops/link_rooms', { source_room_id: sw.rooms.team, target_room_id: id, label: `project: ${project}` }, true).catch((err) =>
    log('warn', `Couldn't link #team to #${project}: ${(err as Error).message}`)
  )
  log('info', `Made #${project} (${id}) for the ${project} project`)
  return { id, made: true }
}

/**
 * Put a project's room away: archived in Switch (hidden, kept whole, and unarchive brings it back),
 * #team no longer points at it, and its jobs go back to #team.
 */
export async function archiveProjectRoom(project: string): Promise<string | undefined> {
  const id = projectRoomOf(project)
  if (!id) return undefined
  await call('/ops/unlink_rooms', { source_room_id: sw.rooms.team, target_room_id: id }, true).catch((err) =>
    log('warn', `Couldn't unlink #${project} from #team: ${(err as Error).message}`)
  )
  await call('/ops/archive_room', { room_id: id }, true)
  memory.set(roomKey(project), '')
  memory.set(refRoomKey(project), '')
  log('info', `Archived #${project} (${id})`)
  return id
}

/**
 * Classify a reply by its last marker line: "DONE: …" or "LOOKS GOOD" finish the job,
 * "BLOCKED: …" or "CHANGES NEEDED" mean it's stuck (the reviewer's "no" is a stop too).
 */
export function outcomeOf(body: string): Omit<AgentReply, 'body'> | { outcome: 'ask'; line: string } | undefined {
  const lines = body.split('\n').map((l) => l.trim().replace(/^[*_`>\s]+|[*_`\s]+$/g, '')).filter(Boolean).reverse()
  const starts = (line: string, marker: string) => line.toUpperCase().startsWith(marker.toUpperCase())
  for (const line of lines) {
    if (starts(line, sw.markers.ask)) return { outcome: 'ask', line: line.slice(sw.markers.ask.length).trim() }
    if (starts(line, sw.markers.blocked) || starts(line, sw.markers.changesNeeded)) return { outcome: 'blocked', line }
    if (starts(line, sw.markers.done) || starts(line, sw.markers.looksGood)) return { outcome: 'done', line }
  }
  return undefined
}

/** Send an agent a message addressed to it (an answer to its question, say), in the job's thread. */
export async function tellAgent(agent: Agent, text: string, threadId?: string, roomId = sw.rooms.team) {
  await inRoom(roomId, () => call('/ops/send_targeted_message', { body: text, target_names: [agent.name], thread_id: threadId ?? null }, true))
}

export interface AskOptions {
  /** Live lines for the voice box ("@claude has the job"). */
  onProgress?: (text: string) => void
  /** The agent's "ASK: npm ci — …": your answer goes back to it. */
  onAsk?: (what: string) => Promise<string>
  /** The job's thread: the job goes in it, and only replies there (or outside any thread) count. */
  threadId?: string
  /** The room the job happens in: its project's room, else #team. */
  roomId?: string
  timeoutMs?: number
  /** How long to wait for any word from the agent before nudging it once. */
  nudgeMs?: number
  /** The answer arriving some other way: the agent stopped, and its session says how it ended. */
  outside?: Promise<AgentReply>
  /** Its session shows it working, so there's nothing to nudge it about. */
  working?: () => boolean
}

/**
 * Give an agent a job in #team and wait for its reply that ends with DONE / LOOKS GOOD or
 * BLOCKED / CHANGES NEEDED. Replies without a marker are progress and are logged.
 * "ASK: …" is the agent wanting your OK for a heavy step: `onAsk` gets your answer to it, Oggy
 * sends that back, and the wait goes on (the clock restarts, since you may take a while).
 * Several agents can work at once: each call only listens to its own agent, in its own thread.
 */
export async function askAgent(agent: Agent, job: string, opts: AskOptions = {}): Promise<AgentReply> {
  const { onProgress = () => {}, onAsk, threadId, roomId = sw.rooms.team, timeoutMs = JOB_TIMEOUT_MS, nudgeMs = NUDGE_MS } = opts
  const names = [agent.name, agent.alias].map((n) => n.toLowerCase())
  const alias = agent.alias
  const since = Date.now() - 1000
  let toldOutside = false
  /** Who the job went to (the seat's holder, else the agent), for the nudge. */
  let sentTo = agent.name
  let heard = false

  let stop = () => {}
  const reply = new Promise<AgentReply>((resolve) => {
    let timer: NodeJS.Timeout
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const line = `No DONE or BLOCKED from @${alias} after ${Math.round(timeoutMs / 60_000)} min.`
        resolve({ outcome: 'timeout', line, body: line })
      }, timeoutMs)
    }
    arm()
    opts.outside?.then(resolve)
    // Not a word since the job went out: ping it once, by name (a name always wakes an agent up).
    const nudge = setTimeout(() => {
      if (heard || opts.working?.()) return
      log('warn', `@${alias} hasn't answered the job yet, nudging it`)
      onProgress(`@${alias} hasn't answered yet, nudging it…`)
      void tellAgent({ ...agent, name: sentTo }, 'Did you get the job above? Start on it now and reply in this thread.', threadId, roomId).catch(() => {})
    }, nudgeMs)
    const off = onRoomMessage((m) => {
      if (m.roomId !== roomId || m.timestamp < since || !names.includes(m.senderName.toLowerCase())) return
      // Another job's thread: not ours. No thread at all: the agent answered top-level, still ours.
      if (threadId && m.threadId && m.threadId !== threadId) return
      if (threadId && !m.threadId && !toldOutside) {
        toldOutside = true
        log('info', `@${alias} replied outside the job's thread`)
      }
      heard = true
      const result = outcomeOf(m.body)
      if (result?.outcome === 'ask') {
        // It waits for you: ask, send back your answer (to whoever asked: the seat's holder), keep listening for its DONE.
        clearTimeout(timer)
        const asker = { ...agent, name: m.senderName || agent.name }
        if (!onAsk) return void tellAgent(asker, 'Yes, go ahead.', threadId, roomId).finally(arm)
        void onAsk(result.line)
          .then((answer) => tellAgent(asker, answer, threadId, roomId))
          .catch((err) => log('warn', `Couldn't answer @${alias}: ${(err as Error).message}`))
          .finally(arm)
        return
      }
      // Switch answering for an agent that can't run ("I couldn't start a session…"): no point waiting.
      if (!result && CANT_RUN.test(m.body)) {
        const why = m.body.replace(/^@\S+\s*/, '').split('\n').find((l) => l.trim()) ?? m.body
        return resolve({ outcome: 'blocked', line: `BLOCKED: Switch couldn't run @${alias}: ${why}`, body: m.body })
      }
      if (!result) {
        const first = m.body.split('\n').find((l) => l.trim()) ?? ''
        log('info', `@${alias}: ${first.slice(0, 160)}`)
        return onProgress(`@${alias}: ${first}`)
      }
      resolve({ ...result, body: m.body, posted: true })
    })
    stop = () => {
      clearTimeout(timer)
      clearTimeout(nudge)
      off()
    }
  })

  try {
    // Its seat in #team says who does this job: whoever holds it, else the agent, who's asked to take it.
    // Always addressed by name: a role reaches the session that took the seat, which may have gone to
    // sleep since; a name wakes the agent up in a fresh session.
    const seat = await addressFor(agent, roomId).catch((err) => {
      log('warn', `No roles in this room (${(err as Error).message}), sending to @${alias} by name`)
      return undefined
    })
    const holder = seat?.holders[0]
    if (holder) {
      sentTo = holder
      names.push(holder.toLowerCase())
    }
    const body = seat && !holder ? `(First take your seat in this room: assume_role "${seat.role}".)\n\n${job}` : job
    const sent = await inRoom(roomId, () =>
      call<{ result?: { target_statuses?: Record<string, string> } }>('/ops/send_targeted_message', { body, target_names: [sentTo], thread_id: threadId ?? null }, true)
    )
    const status = sent.result?.target_statuses?.[sentTo]
    const who = seat ? `@${alias} (${seat.role})` : `@${alias}`
    onProgress(status === 'live' ? `${who} has the job and is on it` : `${who} has the job (starting up…)`)
    log('info', `Asked ${who}: ${job}`)
  } catch (err) {
    stop()
    throw err
  }
  return reply.finally(stop)
}

/* ---------- the connection ----------
 * One WebSocket (the agent protocol's supported path; the SSE stream is legacy). The server pings
 * every 2s and Oggy answers each ping with its cursor (the last event it handled); a reconnect resumes
 * from there with the same connection id. Another Oggy opening this connection takes it over: that's
 * final, this one stops (two retrying would take it from each other forever).
 */

/** The last event handled, and the attach generation, for pongs and resuming. */
let cursor: number | undefined
let generation: number | undefined
/** Taken over or refused for good: no more reconnects. */
let stopped = false
/** The open socket, so a room joined while running can make it reconnect. */
let socket: WebSocket | undefined
/** The rooms this connection said it listens to (connection_state), when it said. */
const listening = new Set<string>()

/** Room ids from a connection_state frame's `rooms`, whichever shape they come in. */
function roomIds(rooms: unknown): string[] {
  if (!Array.isArray(rooms)) return []
  return rooms.map((r) => (typeof r === 'string' ? r : String((r as { room_id?: string; id?: string })?.room_id ?? (r as { id?: string })?.id ?? ''))).filter(Boolean)
}

/** A room_join about Oggy itself (or one that doesn't say who): its rooms may have changed. */
function aboutMe(data: any): boolean {
  const p = data?.payload ?? data ?? {}
  const who = String(p.member_name ?? p.member ?? '').toLowerCase()
  return !who || who === sw.agentName.toLowerCase() || who === sw.agentId.toLowerCase()
}

/** A frame as the docs show it ({ type, … }) or as servers send it ({ event, data: { … } }). */
function unwrap(raw: string): { kind: string; data: any } | undefined {
  try {
    const f = JSON.parse(raw)
    return { kind: String(f.type ?? f.event ?? ''), data: f.data ?? f }
  } catch {
    return undefined
  }
}

/** A room message from the socket, to everyone listening (never Oggy's own posts). */
function dispatch(event: any) {
  const p = event?.payload
  if (!p || p.sender_name === sw.agentName) return
  const m: RoomMessage = {
    roomId: event.room_id,
    id: p.message_id,
    threadId: p.thread_id ?? null,
    sender: p.sender,
    senderName: p.sender_name ?? '',
    body: p.body ?? '',
    addressed: Boolean(p.addressed),
    timestamp: p.timestamp ?? Date.now()
  }
  for (const cb of listeners) cb(m)
}

/** Once connected: the team's seats in #team (so `!roles` shows them), and no stale seats in project rooms. */
function onConnected() {
  void ensureRoles(sw.rooms.team).catch((err) => log('warn', `Couldn't set up the roles in #team: ${(err as Error).message}`))
  for (const m of memory.list().filter((x) => x.key.startsWith('project.room.'))) {
    void clearProjectSeats(m.value).catch((err) => log('warn', `Couldn't tidy the roles in a project room: ${(err as Error).message}`))
  }
}

/** Open the socket and handle it until it closes. Rejects if it never opened. */
function openSocket(): Promise<void> {
  const q = new URLSearchParams({ connection_id: connectionId, scope: 'all', filter: 'all', client: 'oggy', start_from: cursor === undefined ? 'head' : String(cursor) })
  if (generation !== undefined) q.set('expected_generation', String(generation))
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/connection/ws?${q}`, { headers: { authorization: `Bearer ${sw.apiKey}` } } as never)
  socket = ws

  return new Promise((done, fail) => {
    let opened = false
    ws.onopen = () => (opened = true)
    ws.onerror = () => {
      if (!opened) fail(new Error(`can't open ${sw.apiUrl}`))
    }
    ws.onclose = (e) => {
      online = false
      if (socket === ws) socket = undefined
      if (opened) done()
      else fail(new Error(`closed before it opened (${e.code}${e.reason ? ` ${e.reason}` : ''})`))
    }
    ws.onmessage = (e) => {
      const f = unwrap(String(e.data))
      if (!f) return
      switch (f.kind) {
        case 'ping':
          // First, before anything else: three missed pings and the server lets the connection go.
          return ws.send(JSON.stringify({ type: 'pong', cursor: cursor ?? 0 }))
        case 'connection_state':
          generation = f.data.generation
          if (cursor === undefined && typeof f.data.cursor === 'number') cursor = f.data.cursor
          online = true
          connectedRoom = undefined
          listening.clear()
          for (const id of roomIds(f.data.rooms)) listening.add(id)
          log('info', `Connected to Switch as ${sw.agentName}`)
          onConnected()
          // Invited while the connection was down: catch up now.
          return void roomsChanged('reconnected')
        case 'subscription_changed':
          for (const id of roomIds(f.data.rooms)) listening.add(id)
          return void roomsChanged('subscription changed')
        case 'gap':
          // Missed events too old to replay: carry on from where the server resumed.
          if (typeof f.data.resumed_at === 'number') cursor = f.data.resumed_at
          return log('warn', `Switch skipped some old events (${f.data.reason ?? 'gap'})`)
        case 'evicted':
          if (f.data.code === 'taken_over') {
            stopped = true
            log('error', 'Another Oggy took over the Switch connection, so this one stopped listening. Close the other one and restart this one.')
          } else log('warn', `Switch dropped the connection (${f.data.code ?? 'evicted'}), reconnecting`)
          return
        case 'refused':
          // A conflict means someone else holds the connection now: same as taken over.
          if (f.data.status === 409) stopped = true
          return log(stopped ? 'error' : 'warn', `Switch refused the connection (${f.data.status ?? '?'}: ${f.data.detail ?? ''})${stopped ? '. Not retrying.' : ''}`)
        default: {
          const seq = Number(f.data.sequence ?? f.data.id)
          if (Number.isFinite(seq) && seq > (cursor ?? -1)) cursor = seq
          if (f.kind === 'message') dispatch(f.data)
          else if (f.kind === 'room_join' && aboutMe(f.data)) void roomsChanged('invited')
        }
      }
    }
  })
}

/** Start listening to Oggy's rooms. Safe to call once at startup; reconnects by itself until taken over. */
export function startSwitch() {
  if (started || !switchConfigured()) return
  started = true
  setInterval(() => void roomsChanged('checked'), ROOM_CHECK_MS).unref()
  void (async () => {
    let warned = false
    let found = false
    while (!stopped) {
      try {
        if (!found) {
          // Never in the way of listening: without it, the config's names and ids still work.
          await findMyself().catch((err) => log('warn', `Couldn't look up Oggy's rooms (${(err as Error).message}); using the config`))
          found = true
        }
        await openSocket()
        warned = false
        if (!stopped) log('warn', 'Switch connection dropped, reconnecting')
      } catch (err) {
        if (!warned) log('warn', `Switch unreachable (${(err as Error).message}), retrying every ${RECONNECT_MS / 1000}s`)
        warned = true
      }
      if (!stopped) await new Promise((r) => setTimeout(r, RECONNECT_MS))
    }
  })()
}
