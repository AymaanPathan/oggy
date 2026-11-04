import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Oggy's Switch layer against a fake Switch server that speaks the same protocol: the WebSocket
 * (connection_state, pings, messages, evictions) and the ops. Never touches your real Switch.
 */

const ROOM = 'room-team'
const OGGY = 'oggy.test'
const agent = { alias: 'claude', name: 'claude-code.test', does: 'codes', isDefault: true }

/** What Oggy sent: [op, body]. */
const sent: [string, Record<string, unknown>][] = []
/** Oggy's open sockets, every connection it opened (its query), and the pongs it sent. */
const sockets = new Set<WebSocket>()
const opens: URLSearchParams[] = []
const pongs: { cursor: number }[] = []
let seq = 100
let nextId = 0
/** The fake's rooms: which one the session is in, and each room's roles and their holders. */
let connected = ''
const roles: Record<string, { name: string; held_by: { name: string }[] }[]> = {}
const deletedDocs = new Set<string>()

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const path = req.url!.split('?')[0]
    const op = path.split('/').pop()!
    const body = raw ? JSON.parse(raw) : {}
    sent.push([op, body])
    if (op === 'connect_to_room') connected = body.room_id
    if (op === 'define_role') (roles[connected] ??= []).push({ name: body.name, held_by: [] })
    if (op === 'list_roles') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ result: roles[connected] ?? [] }))
    }
    // A room document someone deleted from the room: updating it fails.
    if (op === 'update_room_document' && deletedDocs.has(body.document_id)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ detail: 'document not found' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const id = `sw_${++nextId}`
    const replies: Record<string, unknown> = {
      send_targeted_message: { result: { event_id: id, target_statuses: { [agent.name]: 'live' } } },
      get_room_detail: { result: { bridge_id: 'bridge-discord', channel_type: 'channel_public', instructions: 'TEAM RULES', connected_user_names: ['aymaan2218'], aliases: { [agent.name]: 'claude', stranger: 'x' } } },
      list_room_groups: { result: [] },
      create_room: { result: { id: 'room-react-flow', name: 'react-flow' } },
      create_reference: { result: { id: `ref_${id}`, type: body.type } },
      create_room_document: { result: { document_id: `doc_${id}` } },
      get_my_context: { result: { you: { name: OGGY } } },
      list_rooms: { result: [{ room_id: 'room-old-daily', name: 'oggy-daily', archived: true }, { room_id: 'room-daily', name: 'oggy-daily' }, { room_id: ROOM, name: 'team' }, { room_id: 'room-react-flow', name: 'react-flow' }] }
    }
    res.end(JSON.stringify(replies[op] ?? { result: { event_id: id, ok: true } }))
  })
})

/** The socket, as this Switch server speaks it: { event, data }. Every connection starts with its state. */
const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
  opens.push(new URL(req.url!, 'http://x').searchParams)
  sockets.add(ws)
  ws.on('close', () => sockets.delete(ws))
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw))
    if (f.type === 'pong') pongs.push(f)
  })
  ws.send(JSON.stringify({ event: 'connection_state', data: { connection_id: 'x', generation: 7, cursor: seq, rooms: [], scope: 'all', filter: 'all' } }))
})
const send = (frame: object) => {
  for (const s of sockets) s.send(JSON.stringify(frame))
}

/** A message arriving in a room (#team unless said), as Switch sends it. */
function arrive(from: string, body: string, threadId: string | null = null, roomId = ROOM) {
  send({ event: 'message', data: { type: 'message', room_id: roomId, sequence: ++seq, payload: { message_id: `m_${++nextId}`, thread_id: threadId, sender: `@${from}:x`, sender_name: from, body, addressed: true, timestamp: Date.now() } } })
}

const root = mkdtempSync(join(tmpdir(), 'oggy-switch-'))
let sw: typeof import('./integrations/switch.js')
let db: typeof import('./db.js').db

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  Object.assign(process.env, {
    OGGY_DATA_DIR: root,
    SWITCH_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    SWITCH_AGENT_ID: 'oggy-id',
    SWITCH_API_KEY: 'test-key',
    SWITCH_ROOM_ID: ROOM
  })
  const { config } = await import('./config.js')
  config.switch.agentName = 'oggy-before-lookup'
  ;({ db } = await import('./db.js'))
  sw = await import('./integrations/switch.js')
  sw.startSwitch()
  for (let i = 0; i < 50 && !sw.switchOnline(); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(sw.switchOnline(), 'connected to the fake Switch')
})

after(() => {
  for (const s of sockets) s.terminate()
  wss.close()
  server.closeAllConnections()
  server.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
  // startSwitch reconnects forever by design; the test is over.
  setTimeout(() => process.exit(0), 50).unref()
})

const tick = () => new Promise((r) => setTimeout(r, 30))
/** How many jobs and answers Oggy has sent so far, and waiting for the next one (roles are looked up first). */
const jobsSent = () => sent.filter(([op]) => op === "send_targeted_message").length
async function jobSent(before: number) {
  for (let i = 0; i < 200 && jobsSent() <= before; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(jobsSent() > before, "the job was sent")
}
const lastOp = (op: string) => [...sent].reverse().find(([o]) => o === op)?.[1]

test('rooms the config leaves out are found by name (not archived ones), and Oggy learns its own name', async () => {
  const { config } = await import('./config.js')
  assert.equal(config.switch.rooms.oggyDaily, 'room-daily')
  assert.equal(config.switch.rooms.team, ROOM)
  assert.equal(config.switch.agentName, OGGY)
})

test('opening a thread posts your words and remembers the thread for the job', async () => {
  const id = await sw.openThread('run-1', 'Aymaan (voice): create react-flow')
  assert.ok(id)
  assert.equal(lastOp('post_message')?.body, 'Aymaan (voice): create react-flow')
  assert.equal(sw.threadOf('run-1'), id)
})

test('the job goes into its thread, and only replies in that thread count', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'build it', { threadId: 'T1' })
  await jobSent(jobsBefore)
  const job = lastOp('send_targeted_message')
  assert.equal(job?.thread_id, 'T1')
  assert.deepEqual(job?.target_names, [agent.name])
  // Another job's thread: ignored, even with DONE.
  arrive(agent.name, 'DONE: the other job', 'T2')
  await tick()
  arrive(agent.name, 'DONE: built it', 'T1')
  const r = await reply
  assert.equal(r.outcome, 'done')
  assert.equal(r.line, 'DONE: built it')
})

test('an ASK is answered in the same thread, then the job carries on', async () => {
  const asked: string[] = []
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'install and check', {
    threadId: 'T3',
    onAsk: async (what) => {
      asked.push(what)
      return 'Yes, go ahead: npm ci'
    }
  })
  await jobSent(jobsBefore)
  arrive(agent.name, 'Ready.\nASK: npm ci — install the packages', 'T3')
  await tick()
  assert.deepEqual(asked, ['npm ci — install the packages'])
  const answer = lastOp('send_targeted_message')
  assert.equal(answer?.body, 'Yes, go ahead: npm ci')
  assert.equal(answer?.thread_id, 'T3')
  arrive(agent.name, 'DONE: installed, types pass', 'T3')
  assert.equal((await reply).line, 'DONE: installed, types pass')
})

test('an agent answering outside any thread is still heard', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'quick one', { threadId: 'T4' })
  await jobSent(jobsBefore)
  arrive(agent.name, 'BLOCKED: no such folder', null)
  const r = await reply
  assert.equal(r.outcome, 'blocked')
})

test('without a thread the job goes top-level, as before', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'legacy job')
  await jobSent(jobsBefore)
  assert.equal(lastOp('send_targeted_message')?.thread_id, null)
  arrive(agent.name, 'DONE: ok')
  assert.equal((await reply).outcome, 'done')
})

test('other senders never finish a job', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'mine', { threadId: 'T5', timeoutMs: 400 })
  await jobSent(jobsBefore)
  arrive('someone-else', 'DONE: not yours', 'T5')
  const r = await reply
  assert.equal(r.outcome, 'timeout')
})

test('a project room is set up like #team, filed under Projects, and linked both ways', async () => {
  const { config } = await import('./config.js')
  config.switch.agents = { claude: agent, reviewer: { alias: 'reviewer', name: 'reviewer.test', does: 'reviews', isDefault: false } }
  const r = await sw.createProjectRoom('react-flow', 'Project: react-flow\nFolder: C:/code/react-flow')
  assert.deepEqual(r, { id: 'room-react-flow', made: true })
  assert.equal(lastOp('create_room_group')?.name, 'Projects')
  const room = lastOp('create_room')!
  assert.equal(room.name, 'react-flow')
  assert.deepEqual(room.agent_names, [OGGY, 'reviewer.test']) // the owner's own Claude stays out
  assert.deepEqual(room.user_names, ['aymaan2218'])
  assert.equal(room.bridge_id, 'bridge-discord')
  assert.equal(room.group_name, 'Projects')
  assert.match(String(room.instructions), /react-flow project[\s\S]*Folder: C:\/code\/react-flow[\s\S]*TEAM RULES/)
  assert.deepEqual(room.linked_rooms, [{ target_room_id: ROOM, label: 'the team room' }])
  // Only aliases of agents that are in the room.
  assert.deepEqual(room.aliases, {})
  assert.deepEqual(lastOp('link_rooms'), { source_room_id: ROOM, target_room_id: 'room-react-flow', label: 'project: react-flow' })
  assert.equal(sw.projectRoomOf('react-flow'), 'room-react-flow')
  assert.equal(sw.projectOfRoom('room-react-flow'), 'react-flow')
})

test('asking again for the same project makes no second room', async () => {
  const before = sent.filter(([op]) => op === 'create_room').length
  assert.deepEqual(await sw.createProjectRoom('react-flow', 'x'), { id: 'room-react-flow', made: false })
  assert.equal(sent.filter(([op]) => op === 'create_room').length, before)
})

test("asking again for a room made before references attaches the project's GitHub repo, once", async () => {
  const url = 'https://github.com/aymaan/react-flow'
  assert.deepEqual(await sw.createProjectRoom('react-flow', 'x', url), { id: 'room-react-flow', made: false })
  const ref = lastOp('create_reference')!
  assert.equal(ref.type, 'github')
  assert.deepEqual(ref.value, { urls: [url] })
  const attach = lastOp('attach_reference_to_room')!
  assert.equal(attach.room_id, 'room-react-flow')
  assert.match(String(attach.reference_id), /^ref_/)
  const before = sent.length
  await sw.createProjectRoom('react-flow', 'x', url)
  assert.ok(!sent.slice(before).some(([op]) => op === 'create_reference' || op === 'attach_reference_to_room'))
})

test('a new room gets the repo and the packages at creation, and the package carries the rules', async () => {
  const { config } = await import('./config.js')
  config.switch.packages = ['pkg-team-rules']
  try {
    await sw.createProjectRoom('with-repo', 'Project: with-repo', 'https://github.com/aymaan/with-repo')
    const room = lastOp('create_room')!
    assert.deepEqual(room.package_ids, ['pkg-team-rules'])
    assert.equal((room.reference_ids as string[]).length, 1)
    assert.doesNotMatch(String(room.instructions), /TEAM RULES/)
  } finally {
    config.switch.packages = []
  }
})

test('archiving a project room unlinks it from #team, archives it, and sends its jobs back to #team', async () => {
  const { memory } = await import('./db.js')
  memory.set('project.room.old-thing', 'room-old-thing')
  assert.equal(await sw.archiveProjectRoom('old-thing'), 'room-old-thing')
  assert.deepEqual(lastOp('unlink_rooms'), { source_room_id: ROOM, target_room_id: 'room-old-thing' })
  assert.deepEqual(lastOp('archive_room'), { room_id: 'room-old-thing' })
  assert.equal(sw.projectRoomOf('old-thing'), undefined)
  assert.equal(await sw.archiveProjectRoom('old-thing'), undefined)
})

test('a job in a project room switches the session to that room before it is sent', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'in the project room', { threadId: 'T9', roomId: 'room-react-flow' })
  await jobSent(jobsBefore)
  const ops = sent.map(([op]) => op)
  const job = ops.lastIndexOf('send_targeted_message')
  const connect = ops.slice(0, job).lastIndexOf('connect_to_room')
  assert.equal(sent[connect]?.[1].room_id, 'room-react-flow')
  // Replies count only from that room.
  arrive(agent.name, 'DONE: wrong room', 'T9', ROOM)
  await tick()
  arrive(agent.name, 'DONE: right room', 'T9', 'room-react-flow')
  assert.equal((await reply).line, 'DONE: right room')
})

/* ---------- roles ---------- */

const seat = (room: string, role: string) => roles[room]?.find((r) => r.name === role)

test('a room gets the team’s roles, and a first job asks the agent to take its seat', async () => {
  const { config } = await import('./config.js')
  config.switch.agents = { claude: agent, reviewer: { alias: 'reviewer', name: 'reviewer.test', does: 'reviews', isDefault: false } }
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'first job here', { threadId: 'R1', roomId: ROOM })
  await jobSent(jobsBefore)
  assert.deepEqual(roles[ROOM].map((r) => r.name).sort(), ['builder', 'code-reviewer'])
  const job = lastOp('send_targeted_message')!
  assert.deepEqual(job.target_names, [agent.name])
  assert.equal(job.target_roles, undefined)
  assert.match(String(job.body), /^\(First take your seat in this room: assume_role "builder"/)
  arrive(agent.name, 'DONE: seated and done', 'R1', ROOM)
  assert.equal((await reply).outcome, 'done')
})

test('once it holds the seat, the job goes to it by name (a name wakes a sleeping agent; a role may not)', async () => {
  seat(ROOM, 'builder')!.held_by = [{ name: agent.name }]
  const definedBefore = sent.filter(([op]) => op === 'define_role').length
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'second job', { threadId: 'R2', roomId: ROOM })
  await jobSent(jobsBefore)
  const job = lastOp('send_targeted_message')!
  assert.deepEqual(job.target_names, [agent.name])
  assert.equal(job.target_roles, undefined)
  assert.equal(job.body, 'second job')
  // Roles are defined once per room.
  assert.equal(sent.filter(([op]) => op === 'define_role').length, definedBefore)
  arrive(agent.name, 'DONE: by role', 'R2', ROOM)
  assert.equal((await reply).line, 'DONE: by role')
})

test('another agent in the seat does the job, and its ASK is answered to it', async () => {
  seat(ROOM, 'builder')!.held_by = [{ name: 'claude-two.test' }]
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'third job', { threadId: 'R3', roomId: ROOM, onAsk: async () => 'Yes, go ahead' })
  await jobSent(jobsBefore)
  assert.deepEqual(lastOp('send_targeted_message')!.target_names, ['claude-two.test'])
  arrive('claude-two.test', 'ASK: npm ci — install', 'R3', ROOM)
  await tick()
  const answer = lastOp('send_targeted_message')!
  assert.deepEqual(answer.target_names, ['claude-two.test'])
  assert.equal(answer.thread_id, 'R3')
  arrive('claude-two.test', 'DONE: the stand-in did it', 'R3', ROOM)
  assert.equal((await reply).line, 'DONE: the stand-in did it')
})

test('an agent that says nothing gets one nudge, by name, in the thread', async () => {
  seat(ROOM, 'builder')!.held_by = [{ name: agent.name }]
  const lines: string[] = []
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'quiet job', { threadId: 'N1', roomId: ROOM, nudgeMs: 150, onProgress: (l) => lines.push(l) })
  await jobSent(jobsBefore)
  await jobSent(jobsBefore + 1)
  const nudge = lastOp('send_targeted_message')!
  assert.deepEqual(nudge.target_names, [agent.name])
  assert.equal(nudge.thread_id, 'N1')
  assert.match(String(nudge.body), /Did you get the job above/)
  assert.ok(lines.some((l) => /nudging/.test(l)))
  arrive(agent.name, 'DONE: woke up and did it', 'N1', ROOM)
  assert.equal((await reply).outcome, 'done')
})

test('when Switch says it can’t run the agent, the job stops at once with that reason', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'doomed job', { threadId: 'F1', roomId: ROOM })
  await jobSent(jobsBefore)
  arrive(agent.name, "@oggy.test I couldn't start a session, and my owner (Admin) needs to fix it: The session did not take a message after being started 5 times (The session host is not running.). Then address me again.", 'F1', ROOM)
  const r = await reply
  assert.equal(r.outcome, 'blocked')
  assert.match(r.line, /^BLOCKED: Switch couldn't run @claude: I couldn't start a session.*session host is not running/)
})

test('an agent that answers in time is not nudged', async () => {
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'chatty job', { threadId: 'N2', roomId: ROOM, nudgeMs: 300 })
  await jobSent(jobsBefore)
  arrive(agent.name, 'On it, reading the files.', 'N2', ROOM)
  await new Promise((r) => setTimeout(r, 450))
  assert.equal(jobsSent(), jobsBefore + 1, 'no nudge')
  arrive(agent.name, 'DONE: done', 'N2', ROOM)
  assert.equal((await reply).outcome, 'done')
})

test('project rooms have no seats: an agent holds one role at a time, and its seat is in #team', async () => {
  const room = [...sent].reverse().find(([op]) => op === 'create_room')![1]
  assert.equal(room.roles, undefined)
  const definedBefore = sent.filter(([op]) => op === 'define_role').length
  const jobsBefore = jobsSent()
  const reply = sw.askAgent(agent, 'a project job', { threadId: 'P1', roomId: 'room-react-flow' })
  await jobSent(jobsBefore)
  const job = lastOp('send_targeted_message')!
  assert.deepEqual(job.target_names, [agent.name])
  assert.equal(job.body, 'a project job')
  assert.equal(sent.filter(([op]) => op === 'define_role').length, definedBefore)
  arrive(agent.name, 'DONE: by name in the project room', 'P1', 'room-react-flow')
  assert.equal((await reply).line, 'DONE: by name in the project room')
})

/* ---------- room memory ---------- */

const entry = (title: string, extra: Partial<import('./integrations/switch.js').LogEntry> = {}) => ({
  at: Date.UTC(2026, 9, 27, 14, 5),
  title,
  asked: `do ${title}`,
  who: 'Aymaan (voice), decided via voice',
  decision: '✅ kept',
  files: [],
  risks: [],
  ...extra
})

test('the log reads as a document: newest first, each job with what changed and the decision', () => {
  const text = sw.renderLog('portfolio', [
    entry('Dark mode toggle', { summary: 'Added a toggle in the header.', files: ['src/Header.tsx', 'src/theme.css'], tests: '✓ 13 passing', branch: 'oggy/dark-mode (not pushed)', risks: ['No test for the saved choice'] }),
    entry('Contact page', { decision: '↩️ undone' })
  ])
  assert.match(text, /^# Project log: portfolio\n/)
  assert.ok(text.indexOf('Dark mode toggle') < text.indexOf('Contact page'))
  assert.match(text, /## .* · Dark mode toggle · ✅ kept\n- Asked: "do Dark mode toggle" \(Aymaan \(voice\), decided via voice\)\n- What happened: Added a toggle in the header\.\n- Files: src\/Header\.tsx, src\/theme\.css\n- Tests: ✓ 13 passing\n- Branch: oggy\/dark-mode \(not pushed\)\n- Watch out: No test for the saved choice/)
  assert.match(text, /## .* · Contact page · ↩️ undone\n- Asked: "do Contact page"/)
})

test('the first entry makes the room’s log document; later ones update it, newest first', async () => {
  await sw.addToRoomLog('room-log', 'portfolio', entry('First job'))
  const made = lastOp('create_room_document')!
  assert.equal(connected, 'room-log')
  assert.equal(made.name, 'Project log')
  assert.match(String(made.instructions), /builds on earlier work/)
  assert.match(String(made.content), /First job/)
  const docId = sw.roomLogOf('room-log')
  assert.ok(docId)

  const madeBefore = sent.filter(([op]) => op === 'create_room_document').length
  await sw.addToRoomLog('room-log', 'portfolio', entry('Second job', { decision: '✏️ change asked: friendlier text' }))
  assert.equal(sent.filter(([op]) => op === 'create_room_document').length, madeBefore)
  const update = lastOp('update_room_document')!
  assert.equal(update.document_id, docId)
  const content = String(update.content)
  assert.ok(content.indexOf('Second job') < content.indexOf('First job'), 'newest first')
  assert.match(content, /✏️ change asked: friendlier text/)
})

test('#team keeps a Team log, and a log keeps only the last 40 jobs', async () => {
  for (let i = 1; i <= 42; i++) await sw.addToRoomLog(ROOM, 'team', entry(`Job ${i}`))
  const content = String(lastOp('update_room_document')!.content)
  assert.match(content, /^# Team log: team/)
  assert.equal((content.match(/^## /gm) ?? []).length, 40)
  assert.match(content, /Job 42/)
  assert.doesNotMatch(content, /Job 2 ·/)
})

test('a log someone deleted in the room is made again', async () => {
  deletedDocs.add(sw.roomLogOf('room-log')!)
  await sw.addToRoomLog('room-log', 'portfolio', entry('After the delete'))
  const remade = lastOp('create_room_document')!
  assert.match(String(remade.content), /After the delete[\s\S]*Second job[\s\S]*First job/)
  assert.notEqual(sw.roomLogOf('room-log'), [...deletedDocs][0])
})

/* ---------- the connection (last: the final test ends it for good) ---------- */

const until = async (ok: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  return ok()
}

/* ---------- workflows ---------- */

const waitFor = async <T>(what: () => T | undefined | false): Promise<T> => {
  for (let i = 0; i < 1000; i++) {
    const got = what()
    if (got) return got
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timed out')
}
const jobFor = (name: string, from: number) => sent.slice(from).find(([op, b]) => op === 'send_targeted_message' && (b.target_names as string[])[0] === name)?.[1]

test('a saved workflow is announced in #team and kept as a room document', async () => {
  const { buildWorkflow, saveWorkflow, deleteWorkflow } = await import('./workflow.js')
  const { config } = await import('./config.js')
  config.switch.agents.scout = { alias: 'scout', name: 'scout', does: 'looks', isDefault: false }
  const built = buildWorkflow({ name: 'Doc Test', project: null, steps: [{ id: 'a', agent: 'scout', title: 'look around', prompt: 'Look.', after: [] }] }, 'x')
  assert.ok(!('problem' in built))
  const from = sent.length
  const { workflow } = saveWorkflow(built, 'x')
  const made = await waitFor(() => sent.slice(from).find(([op]) => op === 'create_room_document')?.[1])
  assert.equal(made.name, 'Workflows')
  assert.match(String(made.content), /## Doc Test/)
  assert.match(String(made.content), /run Doc Test workflow/)
  const said = sent.slice(from).find(([op]) => op === 'message')?.[1]
  assert.equal(said?.room_id, ROOM)
  assert.match(String(said?.content), /New workflow: \*\*Doc Test\*\*/)
  // No @ in what's posted: an announcement shouldn't wake the agents.
  assert.doesNotMatch(String(said?.content), /@/)

  const next = sent.length
  deleteWorkflow(workflow.id)
  const updated = await waitFor(() => sent.slice(next).find(([op]) => op === 'update_room_document')?.[1])
  assert.doesNotMatch(String(updated.content), /Doc Test/)
})

test('a workflow in Switch: its thread, the agent’s real answer, Rahul’s yes in the room, the report in #team', async () => {
  const { mkdirSync } = await import('node:fs')
  const { config } = await import('./config.js')
  const { runs } = await import('./db.js')
  const { startRooms } = await import('./rooms.js')
  const { submitCommand } = await import('./executor.js')
  const { buildWorkflow, saveWorkflow } = await import('./workflow.js')

  config.projectsDir = root
  mkdirSync(join(root, 'paytrack'), { recursive: true })
  config.deploy.paytrack = { branch: 'main', url: undefined }
  config.owner.name = 'Aymaan'
  config.owner.username = 'aymaan2218'
  config.owner.switchUserId = ''
  config.team = [{ name: 'Rahul', username: 'rahul065935', switchUserId: '' }]
  config.claudeBin = 'oggy-test-no-claude'
  for (const [alias, name] of [['backend', 'backend'], ['release', 'release-agent']]) config.switch.agents[alias] = { alias, name, does: alias, isDefault: false }
  startRooms()

  const built = buildWorkflow(
    {
      name: 'Red Test',
      project: 'paytrack',
      steps: [
        { id: 's1', do: 'agent', agent: 'backend', title: 'find what broke', prompt: 'Find what broke.', after: [], question: 'Did a deploy cause it?' },
        { id: 's2', do: 'rollback', title: 'roll it back', after: ['s1'], when: { step: 's1', is: 'yes' }, ask: { who: ['me'], question: 'Roll back?', ifNo: 'continue' } },
        { id: 's3', do: 'deploy', title: 'redeploy', after: ['s2'], ask: { who: ['Rahul'], question: 'Redeploy paytrack?', ifNo: 'continue' } },
        { id: 's4', do: 'agent', agent: 'scout', title: 'write the report', prompt: 'Write the incident report.', after: ['s3'] },
        { id: 's5', do: 'post', room: 'team', title: 'post it', after: ['s4'] }
      ]
    },
    'x'
  )
  assert.ok(!('problem' in built), JSON.stringify(built))
  saveWorkflow(built, 'x')

  const from = sent.length
  const run = submitCommand('run Red Test workflow', 'desktop')

  // The job's thread opens with what you said, then the whole plan.
  const thread = await waitFor(() => sw.threadOf(run.id))
  const outline = await waitFor(() => sent.slice(from).find(([op, b]) => op === 'post_message' && /▶️ \*\*Red Test\*\*/.test(String(b.body)))?.[1])
  assert.equal(outline.thread_id, thread)
  assert.match(String(outline.body), /Rahul must approve/)

  // Backend gets the job in the thread, with the question, and answers it in plain words.
  const job = await waitFor(() => jobFor('backend', from))
  assert.equal(job.thread_id, thread)
  assert.match(String(job.body), /Did a deploy cause it\?/)
  assert.match(String(job.body), /ANSWER: yes or ANSWER: no/)
  arrive('backend', 'The cron job died.\n**ANSWER: no**\nDONE: found it', thread)

  // No deploy caused it: the rollback is skipped, and the room is told.
  await waitFor(() => sent.slice(from).find(([op, b]) => op === 'post_message' && /⏭️ Skipped: roll it back/.test(String(b.body))))
  assert.equal(jobFor('release-agent', from), undefined)

  // Rahul's call, asked of Rahul, by chat-app username, in the thread.
  const ask = await waitFor(() => sent.slice(from).find(([op, b]) => op === 'post_message' && /this one is yours/.test(String(b.body)))?.[1])
  assert.match(String(ask.body), /@rahul065935/)
  assert.match(String(ask.body), /Redeploy paytrack\?/)
  assert.equal(ask.thread_id, thread)

  // You can't say yes on Rahul's behalf: the room says so, and nothing ships.
  arrive('aymaan2218', 'yes', thread)
  await waitFor(() => sent.slice(from).find(([op, b]) => op === 'post_message' && /Only Rahul can answer this/.test(String(b.body))))
  assert.equal(jobFor('release-agent', from), undefined)

  arrive('rahul065935', 'yes', thread)
  await waitFor(() => sent.slice(from).find(([op, b]) => op === 'post_message' && /✅ Rahul said yes/.test(String(b.body))))
  const ship = await waitFor(() => jobFor('release-agent', from))
  assert.match(String(ship.body), /Approved by Rahul/)
  arrive('release-agent', 'DONE: shipped', thread)

  // The report writer hears everything that happened, including what didn't.
  const report = await waitFor(() => jobFor('scout', from))
  assert.match(String(report.body), /The cron job died/)
  assert.match(String(report.body), /Not done: release: roll it back/)
  assert.doesNotMatch(String(report.body), /@backend/)
  arrive('scout', '# Incident\nThe cron job died, and is back.\nDONE: wrote the report', thread)

  // The writer said it in the room itself, so Oggy doesn't say it again.
  assert.match(String(report.body), /post_message/)
  await waitFor(() => runs.get(run.id)?.status === 'done')
  assert.equal(sent.slice(from).find(([, b]) => /📋/.test(String(b.body ?? b.content))), undefined)
  assert.deepEqual(runs.get(run.id)!.steps.map((s) => s.status), ['done', 'skipped', 'done', 'done', 'done'])
})

test('a workflow step about logs gets Render’s logs as a file, and none of them land in the room', async () => {
  const { existsSync, mkdirSync, readFileSync } = await import('node:fs')
  const { config } = await import('./config.js')
  const { runs } = await import('./db.js')
  const { submitCommand } = await import('./executor.js')
  const { buildWorkflow, saveWorkflow } = await import('./workflow.js')

  config.projectsDir = root
  mkdirSync(join(root, 'paytrack'), { recursive: true })
  config.deploy.paytrack = { branch: 'main', service: 'srv-test' }
  config.render.apiKey = 'test-key'
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (!u.startsWith('https://api.render.com/')) return real(url, init)
    const body = u.includes('/logs?') ? { hasMore: false, logs: [{ message: 'SECRET-LOOKING LINE', timestamp: '2026-11-01T07:00:00Z', labels: [{ name: 'type', value: 'app' }] }] } : { ownerId: 'tea-1' }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  try {
    const built = buildWorkflow({ name: 'Log Test', project: 'paytrack', steps: [{ id: 's1', agent: 'scout', title: 'read the logs', prompt: 'Find what broke from the logs.', after: [] }] }, 'x')
    assert.ok(!('problem' in built), JSON.stringify(built))
    saveWorkflow(built, 'x')

    const from = sent.length
    const run = submitCommand('run Log Test workflow', 'desktop')
    const thread = await waitFor(() => sw.threadOf(run.id))
    const job = await waitFor(() => jobFor('scout', from))
    const file = join(root, '.oggy-logs', 'paytrack-render.log')
    assert.ok(String(job.body).includes(file))
    assert.ok(existsSync(file))
    assert.match(readFileSync(file, 'utf8'), /SECRET-LOOKING LINE/)
    assert.doesNotMatch(JSON.stringify(sent.slice(from)), /SECRET-LOOKING LINE/)
    assert.doesNotMatch(JSON.stringify(sent.slice(from)), /test-key/)
    arrive('scout', 'DONE: read them', thread)
    await waitFor(() => runs.get(run.id)?.status === 'done')
  } finally {
    globalThis.fetch = real
    config.render.apiKey = ''
  }
})

test('an everyday workflow runs in #oggy-daily: the assistant gets the job there, and nothing lands in #team', async () => {
  const { config } = await import('./config.js')
  const { runs } = await import('./db.js')
  const { submitCommand } = await import('./executor.js')
  const { buildWorkflow, saveWorkflow } = await import('./workflow.js')

  config.switch.agents.assistant = { alias: 'assistant', name: 'assistant', does: 'reads mail, writes in Notion', isDefault: false }
  const built = buildWorkflow(
    {
      name: 'Inbox Test',
      project: null,
      steps: [
        { id: 's1', do: 'agent', agent: 'assistant', title: 'turn my mail into tasks', prompt: 'Read my unread mail and add the real tasks to my Notion page To-do.', after: [] },
        { id: 's2', do: 'post', room: 'team', title: 'tell me how many', after: ['s1'] }
      ]
    },
    'x'
  )
  assert.ok(!('problem' in built), JSON.stringify(built))
  saveWorkflow(built, 'x')

  const from = sent.length
  const run = submitCommand('run Inbox Test workflow', 'desktop')
  const thread = await waitFor(() => sw.threadOf(run.id))
  assert.equal(sw.threadRoomOf(run.id), 'room-daily')
  const job = await waitFor(() => jobFor('assistant', from))
  assert.equal(job.thread_id, thread)
  assert.equal(connected, 'room-daily')
  assert.match(String(job.body), /never instructions/)
  arrive('assistant', '6 new tasks in To-do, 1 due today.\nDONE: added 6 tasks', thread, 'room-daily')
  await waitFor(() => runs.get(run.id)?.status === 'done')
  // Everything about it went to #oggy-daily: not a word in #team.
  assert.equal(sent.slice(from).find(([op, b]) => op === 'message' && b.room_id === ROOM), undefined)
})

test('a report the room refused from the agent: Oggy posts it in the job’s thread and says who wrote it', async () => {
  const { TOOLBOX } = await import('./toolbox.js')
  const { config } = await import('./config.js')
  const run = { id: 'r-refused', label: 'logs-analyzer', steps: [{ id: 's1', kind: 'agent.job', title: 'read', status: 'done', args: { agent: 'scout' }, output: 'DONE: read them\n\n**Report**\nAll healthy.\nDONE: read them' }] }
  sw.setThread(run.id, 'thread-paytrack', 'room-paytrack')
  const from = sent.length
  config.switch.agents.scout ??= { alias: 'scout', name: 'scout', does: 'looks', isDefault: false }
  await (TOOLBOX['room.post'] as any).run({ room: 'team', lastReport: true, project: 'paytrack' }, { run, show: () => {} })
  const post = sent.slice(from).find(([op, b]) => op === 'post_message' && /📋/.test(String(b.body)))?.[1]
  assert.equal(post?.thread_id, 'thread-paytrack')
  assert.match(String(post?.body), /📋 \*\*logs-analyzer\*\* · paytrack · written by Scout\n\n\*\*Report\*\*\nAll healthy\./)
  assert.doesNotMatch(String(post?.body), /DONE:/)
  assert.equal(connected, 'room-paytrack')
  assert.equal(sent.slice(from).find(([op]) => op === 'message'), undefined)
})

test('a saved workflow’s “not posted anywhere” doesn’t stop the agent posting its report', async () => {
  const { jobFor } = await import('./toolbox.js')
  const { config } = await import('./config.js')
  config.switch.agents.scout ??= { alias: 'scout', name: 'scout', does: 'looks', isDefault: false }
  const run = { id: 'r-words', command: 'x', steps: [{ id: 's1', kind: 'agent.job', title: 'read', status: 'running', args: {} }, { id: 's2', kind: 'room.post', title: 'post', status: 'pending', after: ['s1'], args: { lastReport: true } }] }
  const text = jobFor(run as never, run.steps[0] as never, { agent: 'scout', prompt: 'Write a report. Done means your final message is the report itself, not posted anywhere.' })
  assert.doesNotMatch(text, /not posted anywhere/)
  assert.match(text, /connect_to_room/)
})

test('it opens the socket with the agent protocol’s query and the key in the header', () => {
  const q = opens[0]
  assert.equal(q.get('scope'), 'all')
  assert.equal(q.get('filter'), 'all')
  assert.equal(q.get('start_from'), 'head')
  assert.match(q.get('connection_id') ?? '', /^[0-9a-f-]{36}$/)
})

test('every ping gets a pong with the last event it handled', async () => {
  arrive('someone', 'just chatting')
  const last = seq
  const before = pongs.length
  send({ event: 'ping', data: {} })
  assert.ok(await until(() => pongs.length > before), 'pong sent')
  assert.equal(pongs.at(-1)!.cursor, last)
})

test('a dropped connection comes back with the same id, resuming from its cursor', async () => {
  const before = opens.length
  const last = seq
  for (const s of sockets) s.close(1001, 'going away')
  assert.ok(await until(() => opens.length > before && sw.switchOnline(), 5000), 'reconnected')
  const again = opens.at(-1)!
  assert.equal(again.get('connection_id'), opens[0].get('connection_id'))
  assert.equal(again.get('start_from'), String(last))
  assert.equal(again.get('expected_generation'), '7')
})

test('taken over by another Oggy is final: it stops and never reconnects', async () => {
  const before = opens.length
  send({ event: 'evicted', data: { code: 'taken_over', reason: 'another connection opened' } })
  for (const s of sockets) s.close(4000, 'taken over')
  await until(() => !sw.switchOnline())
  assert.equal(sw.switchOnline(), false)
  // Longer than the reconnect wait (2s): no new connection.
  await new Promise((r) => setTimeout(r, 2600))
  assert.equal(opens.length, before)
})

test('a project room deleted in Switch gets a new one, with the team in it', async () => {
  const { memory } = await import('./db.js')
  memory.set('project.room.old-project', 'room-that-was-deleted')
  const r = await sw.createProjectRoom('old-project', 'Project: old-project')
  assert.deepEqual(r, { id: 'room-react-flow', made: true })
  assert.equal(memory.get('project.room.old-project'), 'room-react-flow')
})
