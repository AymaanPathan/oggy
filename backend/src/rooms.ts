import { config, OWNER_CANDIDATE } from './config.js'
import { approvals, memory, runs } from './db.js'
import { log, subscribe } from './events.js'
import { decideApproval, submitCommand } from './executor.js'
import { isOwner, requesterOf } from './gate.js'
import { people, personOf, voteOf } from './team.js'
import {
  homeRoom,
  onRoomMessage,
  postInThread,
  postToRoom,
  projectOfRoom,
  setThread,
  switchConfigured,
  threadOf,
  threadRoomOf,
  type RoomMessage
} from './integrations/switch.js'
import type { Approval, Run } from './shared/types.js'

/**
 * Oggy in the rooms: phone control and the daily log.
 *  - "@oggy …" from you in any of Oggy's rooms runs the same flow as the voice box, and the
 *    answer (plan question, approval, result) comes back to that room, so it works from your phone.
 *  - A "yes" / "no" from you answers what Oggy is waiting on: inside a job's thread, that job.
 *  - Every job lands in its home room: coding (agents, projects) in #team, in the job's own thread,
 *    everyday things (screenshots, apps, files, volume) in #oggy-daily, whether you asked by voice or in a room.
 * Anyone else gets a polite no; the safety gate checks it again before anything runs.
 */

const sw = config.switch
const YES = /^(yes|yep|yeah|y|go|go ahead|do it|approve|approved|ok|okay|sure|ship it)[.!]*$/i
const NO = /^(no|nope|n|stop|cancel|reject|don'?t|not now)[.!]*$/i

/** Which room a run was asked from, so replies go back there. */
const roomFor = (runId: string) => memory.get(`run.room.${runId}`) || undefined

const say = (text: string, roomId: string) =>
  postToRoom(text, roomId).catch((err) => log('warn', `Could not post to room: ${(err as Error).message}`))

/** A message about a job: in the room its thread is in, it goes in the thread; anywhere else as a plain post. */
const sayAbout = (runId: string, text: string, roomId: string) =>
  threadOf(runId) && threadRoomOf(runId) === roomId
    ? postInThread(text, threadOf(runId), roomId).catch((err) => log('warn', `Could not post in the job's thread: ${(err as Error).message}`))
    : say(text, roomId)

/** Where a job's news goes: the room its thread is in, else where it belongs. */
const jobRoom = (run: Run) => threadRoomOf(run.id) ?? homeRoom(run)

/** Rooms where coding happens: #team and every project's own room. */
const isWorkRoom = (roomId: string) => roomId === sw.rooms.team || Boolean(projectOfRoom(roomId))

/** A greeting before the name: "hey oggy", "hi, oggy". */
const GREETING = '(?:(?:hey|hi|hello|yo|ok|okay)[\\s,]+)?'

/** "@oggy open notion" -> "open notion". Also "oggy, open notion" and "hey oggy open notion". */
function stripMention(body: string): string {
  return body
    .trim()
    .replace(new RegExp(`^${GREETING}@?(?:${sw.agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|oggy)\\b[\\s,:]*`, 'i'), '')
    .trim()
}

const mentionsOggy = (m: RoomMessage) => m.addressed || new RegExp(`^\\s*${GREETING}@?oggy\\b`, 'i').test(m.body)

const isAgent = (who: string) =>
  Object.values(sw.agents).some((a) => [a.name, a.alias].filter(Boolean).some((n) => n.toLowerCase() === who.toLowerCase()))

/** What a "yes" answers: inside a job's thread, that job's approval; elsewhere the newest one waiting. */
function waitingFor(m: RoomMessage): Approval | undefined {
  const pending = approvals.list(true)
  return (m.threadId && pending.find((a) => threadOf(a.runId) === m.threadId)) || pending[0]
}

/** Name-only owner check in use: remember the account, and say once how to lock Oggy to it. */
let toldId = false
function ownerFromMessage(m: RoomMessage): boolean {
  const you = isOwner({ id: m.sender, name: m.senderName })
  if (you && !config.owner.switchUserId) {
    memory.set(OWNER_CANDIDATE, m.sender)
    if (!toldId) {
      toldId = true
      log('warn', `Oggy knows you by name only. Type "lock oggy to me" in the Oggy bar on your computer to lock it to ${m.sender}.`)
      // Only from the desktop: someone else with your name in the room can't lock it to themselves.
      void say(`🔒 One more step: type **lock oggy to me** in the Oggy bar on your computer, so only this account can give me orders.`, m.roomId)
    }
  }
  return you
}

export function onMessage(m: RoomMessage) {
  const who = m.senderName || m.sender
  const text = stripMention(m.body)
  const addressed = mentionsOggy(m)
  const pending = waitingFor(m)

  // A bare "yes"/"no" answers a waiting approval, even without @oggy, but only from you.
  if (pending && (YES.test(text) || NO.test(text)) && (addressed || text.split(/\s+/).length <= 3)) {
    // A team vote: anyone on the team answers for themselves.
    if (voteOf(pending.id)) {
      if (isAgent(who)) return
      const person = personOf({ id: m.sender, name: m.senderName })
      if (!person) return void say(`Sorry ${who}, only the team votes on this: ${people().map((p) => p.name).join(', ')}.`, m.roomId)
      const r = decideApproval(pending.id, YES.test(text), 'switch', person.name)
      if ('error' in r) void sayAbout(pending.runId, r.error, m.roomId)
      return
    }
    if (!ownerFromMessage(m)) {
      if (addressed) void say(`Only ${config.owner.name} can approve that.`, m.roomId)
      return
    }
    const r = decideApproval(pending.id, YES.test(text), 'switch')
    if (!('error' in r)) void sayAbout(pending.runId, r.status === 'approved' ? `👍 Going ahead: ${pending.action}` : `Okay, stopped. (${pending.action})`, m.roomId)
    return
  }

  if (!addressed || !text) return
  // The agents talk to Oggy as part of their jobs (DONE / BLOCKED); that's handled in switch.ts.
  if (isAgent(who)) return
  if (!ownerFromMessage(m)) {
    // The id too, so you can tell a lookalike from yourself.
    log('info', `Ignored "@oggy ${text.slice(0, 80)}" from ${who} (${m.sender}): only ${config.owner.name} can command Oggy`)
    void say(`Sorry ${who}, I only take instructions from ${config.owner.name}.`, m.roomId)
    return
  }

  // In a project's room, that's the project you mean ("@oggy start the dev server" in #react-flow).
  const project = projectOfRoom(m.roomId)
  if (project) memory.set('current_project', project)
  const run = submitCommand(text.slice(0, 2000), 'switch', requesterOf(m))
  memory.set(`run.room.${run.id}`, m.roomId)
  // Asked where coding happens: your message is the job's thread (or the thread you asked in).
  if (isWorkRoom(m.roomId)) setThread(run.id, m.threadId ?? m.id, m.roomId)
  void sayAbout(run.id, `On it: ${text}`, m.roomId)
}

/* ---------- replies and the daily log ---------- */

const finished = (r: Run) => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled'
const icon = (r: Run) => (r.status === 'done' && !r.steps?.some((s) => s.status === 'stubbed') ? '✅' : r.status === 'cancelled' ? '⏹️' : '⚠️')
const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const via = (r: Run) => (r.source === 'desktop' ? 'voice' : r.source === 'switch' ? 'Discord' : r.source)

/** A job's result, for people: its agents are named without an @, so posting it doesn't wake them. */
export const resultLine = (r: Run) => `${icon(r)} ${r.label ?? r.command}: ${r.summary ?? r.status}`.replace(/@(?=\w)/g, '')

/** The result back in the room that asked, and in the job's home room (once, if that's the same room). */
function onFinished(run: Run) {
  const steps = run.steps.filter((s) => s.kind !== 'note' || !s.args?.plan)
  const done = steps.filter((s) => s.status === 'done').length
  const line = resultLine(run)
  const asked = roomFor(run.id)
  const home = jobRoom(run)
  if (asked) void sayAbout(run.id, line, asked)
  if (home && home !== asked) {
    // In the job's thread, what you asked is right above: just the result. Elsewhere, both.
    const full = threadOf(run.id) && home === threadRoomOf(run.id) ? `${line} (${done}/${steps.length} steps)` : `${time()} · ${line}\n> "${run.command}" (${via(run)}, ${done}/${steps.length} steps)`
    void sayAbout(run.id, full, home)
  }
}

export function startRooms() {
  if (!switchConfigured()) return
  onRoomMessage(onMessage)

  const reported = new Set<string>()
  subscribe((e) => {
    if (e.type === 'run.updated' && finished(e.run) && !reported.has(e.run.id)) {
      reported.add(e.run.id)
      onFinished(e.run)
    }
    if (e.type === 'approval.requested') {
      // The question goes where you'll see it: the room that asked, else the job's home room (your phone).
      const run = runs.get(e.approval.runId)
      const room = roomFor(e.approval.runId) ?? (run ? jobRoom(run) : sw.rooms.oggyDaily)
      if (room && e.approval.vote?.notYou) {
        const mention = e.approval.vote.voters.map((n) => { const p = people().find((x) => x.name === n); return p?.username ? `@${p.username}` : n }).join(' and ')
        void sayAbout(e.approval.runId, `🗳️ **${mention}, this one is yours: ${e.approval.action}**\nReply **yes** or **no**.`, room)
      } else if (room && e.approval.vote) {
        const names = e.approval.vote.voters.join(' and ')
        void sayAbout(e.approval.runId, `🗳️ **Team vote: ${e.approval.action}**\nThe work is finished and reviewed. This can't be taken back, so we go only if everyone agrees: ${names}.\nReply **yes** or **no**.`, room)
      } else if (room) void sayAbout(e.approval.runId, `🟡 Waiting for your OK: ${e.approval.action}\nReply **yes** or **no**.`, room)
    }
    // Everyone sees how the vote stands, however each person answered.
    if (e.type === 'approval.vote') {
      const run = runs.get(e.approval.runId)
      const room = run ? jobRoom(run) : undefined
      const v = e.approval.vote!
      const waiting = v.voters.filter((n) => !v.answers[n])
      const line = v.notYou
        ? `${e.yes ? '✅' : '🛑'} ${e.voter} said ${e.yes ? 'yes' : 'no'}: ${e.approval.action}`
        : !e.yes
        ? `🛑 ${e.voter} said no, so nothing ships.`
        : waiting.length
          ? `✋ ${e.voter} said yes. Waiting for ${waiting.join(' and ')}.`
          : `🙌 Everyone said yes. Shipping now.`
      if (room) void sayAbout(e.approval.runId, line, room)
    }
    // You stopped something that was someone else's call: they should hear it from Oggy.
    if (e.type === 'approval.decided' && e.approval.status === 'rejected' && e.approval.vote?.notYou && !Object.values(e.approval.vote.answers).includes('no')) {
      const run = runs.get(e.approval.runId)
      const room = run ? jobRoom(run) : undefined
      if (room) void sayAbout(e.approval.runId, `🛑 ${config.owner.name} stopped this: ${e.approval.action}`, room)
    }
    // Decided in a room: "👍 Going ahead" already said so there. Decided on the desktop: tell the room.
    if (e.type === 'approval.decided' && e.approval.decidedVia !== 'switch' && !e.approval.vote) {
      const run = runs.get(e.approval.runId)
      const room = roomFor(e.approval.runId) ?? (run ? jobRoom(run) : sw.rooms.oggyDaily)
      if (room) {
        void sayAbout(e.approval.runId, `${e.approval.status === 'approved' ? '✔️ Approved' : '✖️ Rejected'} (${e.approval.decidedVia ?? 'desktop'}): ${e.approval.action}`, room)
      }
    }
  })
  log('info', `Listening for @${sw.agentName} in rooms: coding in #team (a thread per job)${sw.rooms.oggyDaily ? ', everyday tasks in #oggy-daily' : ' (no oggyDaily room set, so everyday tasks only reply where asked)'}`)
}
