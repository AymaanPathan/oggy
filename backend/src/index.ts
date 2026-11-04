import Fastify from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { startTeamWatch, teamNow } from './agentLive.js'
import { changesOf, openInEditor } from './codeWatch.js'
import { config } from './config.js'
import { approvals, memory, runs, workflows } from './db.js'
import { emit, log, subscribe } from './events.js'
import { closeInterrupted, decideApproval, runPlanned, submitCommand } from './executor.js'
import { codexStatus } from './integrations/codex.js'
import { startSwitch, switchStatus } from './integrations/switch.js'
import { telegramStatus } from './integrations/telegram.js'
import { decideReview, reviewOf } from './review.js'
import { deleteWorkflow } from './workflow.js'
import { startRooms } from './rooms.js'
import { startSchedules } from './schedule.js'
import { cleanupOrphans } from './tools.js'
import { voteOf } from './team.js'
import { traceOf } from './trace.js'
import { describeToolbox } from './toolbox.js'
import { jobReport, takeJob } from './vscode.js'
import type { CommandSource } from './shared/types.js'

const app = Fastify({ logger: false })
const SOURCES: CommandSource[] = ['desktop', 'telegram', 'switch']

function tokenOk(header: string | undefined): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const want = Buffer.from(config.token)
  return given.length === want.length && timingSafeEqual(given, want)
}

// Only the owner (holder of ~/.oggy/token) can run actions.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return
  if (!tokenOk(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' })
})

app.get('/health', async () => ({ ok: true, name: 'oggy-backend', version: '0.1.0' }))

app.post<{ Body: { text?: string; source?: CommandSource } }>('/commands', async (req, reply) => {
  const text = req.body?.text?.trim()
  if (!text) return reply.code(400).send({ error: 'text is required' })
  const source = SOURCES.includes(req.body.source as CommandSource) ? (req.body.source as CommandSource) : 'desktop'
  return submitCommand(text.slice(0, 2000), source)
})

app.get('/runs', async () => runs.list())
app.get<{ Params: { id: string } }>('/runs/:id/detail', async (req) => ({ changes: changesOf(req.params.id), review: reviewOf(req.params.id) ?? null, trace: traceOf(req.params.id) }))
app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => runs.get(req.params.id) ?? reply.code(404).send({ error: 'not found' }))

app.get<{ Querystring: { pending?: string } }>('/approvals', async (req) => approvals.list(req.query.pending === '1').map((a) => ({ ...a, vote: voteOf(a.id) })))
app.post<{ Params: { id: string }; Body: { approve?: boolean; via?: CommandSource } }>('/approvals/:id', async (req, reply) => {
  const via = SOURCES.includes(req.body?.via as CommandSource) ? req.body.via! : 'desktop'
  const r = decideApproval(req.params.id, req.body?.approve === true, via)
  return 'error' in r ? reply.code(r.code).send({ error: r.error }) : r
})

// The review panel: your decision ("keep it", "undo it", "make the message friendlier").
// `ask`: from the review screen, where anything that isn't a decision is a question about the changes.
app.post<{ Params: { id: string }; Body: { text?: string; via?: CommandSource; ask?: boolean } }>('/runs/:id/review', async (req, reply) => {
  const run = runs.get(req.params.id)
  if (!run) return reply.code(404).send({ error: 'not found' })
  const via = SOURCES.includes(req.body?.via as CommandSource) ? req.body.via! : 'desktop'
  return decideReview(run, String(req.body?.text ?? ''), via, runPlanned, req.body?.ask === true)
})
app.get<{ Params: { id: string } }>('/runs/:id/review', async (req, reply) => reviewOf(req.params.id) ?? reply.code(404).send({ error: 'no review' }))
// One changed file in VS Code, for when you want the full editor.
app.post<{ Params: { id: string }; Body: { path?: string } }>('/runs/:id/changes/open', async (req, reply) => {
  const problem = openInEditor(req.params.id, String(req.body?.path ?? ''))
  return problem ? reply.code(404).send({ error: problem }) : { ok: true }
})

// Oggy Bridge (vscode-bridge/): each VS Code window asks for work on its open folders, then reports how it went.
app.get<{ Querystring: { folders?: string; can?: string } }>('/vscode/jobs', async (req, reply) => {
  let folders: string[] = []
  try {
    folders = (JSON.parse(req.query.folders ?? '[]') as unknown[]).filter((f): f is string => typeof f === 'string')
  } catch {
    return reply.code(400).send({ error: 'folders must be a JSON list' })
  }
  const job = await takeJob(folders, undefined, (req.query.can ?? '').split(',').filter(Boolean))
  return job ?? reply.code(204).send()
})
app.post<{ Body: { job?: string; event?: string; streaming?: boolean; lines?: unknown; code?: number | null } }>('/vscode/report', async (req, reply) =>
  jobReport(String(req.body?.job ?? ''), req.body ?? {}) ? { ok: true } : reply.code(404).send({ error: 'no such job' })
)

// The team, live: who's working on what (see agentLive.ts).
app.get('/team', async () => teamNow())
app.get('/toolbox', async () => describeToolbox())
app.get('/workflows', async () => workflows.list())
app.delete<{ Params: { id: string } }>('/workflows/:id', async (req, reply) => (deleteWorkflow(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'not found' })))
app.get('/memory', async () => memory.list())
app.get('/integrations', async () => [codexStatus(), switchStatus(), telegramStatus()])

// Server-sent events: run updates, approval requests, logs.
app.get('/events', (req, reply) => {
  reply.hijack() // we own the raw stream from here
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  reply.raw.write(': connected\n\n')
  const unsubscribe = subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`))
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
  req.raw.on('close', () => {
    clearInterval(ping)
    unsubscribe()
  })
})

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    console.log(`[oggy] backend on http://${config.host}:${config.port}`)
    console.log(`[oggy] data: ${config.dataDir}  projects: ${config.projectsDir}`)
    // Before the rooms listen: jobs the last backend was in the middle of (none of their waiting carried over).
    closeInterrupted()
    startSwitch()
    startRooms()
    startSchedules((w) => submitCommand(`run ${w.name} workflow`, 'schedule'))
    cleanupOrphans()
    startTeamWatch()
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
