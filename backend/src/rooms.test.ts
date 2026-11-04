import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PlanStep } from './shared/types.js'

/** Which room a job's result goes to. Throwaway data folder, never your real ~/.oggy. */

const root = mkdtempSync(join(tmpdir(), 'oggy-rooms-'))
process.env.OGGY_DATA_DIR = root

const { config } = await import('./config.js')
const { homeRoom, projectOfRoom } = await import('./integrations/switch.js')
const { db, memory } = await import('./db.js')
Object.assign(config.switch.rooms, { team: 'TEAM', oggyDaily: 'DAILY' })

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const run = (...steps: Partial<PlanStep>[]) => ({ steps: steps.map((s, i) => ({ id: String(i), title: '', status: 'done', ...s }) as PlanStep) })

test('everyday tasks go to #oggy-daily', () => {
  assert.equal(homeRoom(run({ kind: 'screen.shot' })), 'DAILY')
  assert.equal(homeRoom(run({ kind: 'app.open', args: { app: 'chrome' } }, { kind: 'system.volume', args: { action: 'down' } })), 'DAILY')
  assert.equal(homeRoom(run({ kind: 'file.move', args: { find: ['resume'], to: 'Jobs' } })), 'DAILY')
})

test('coding goes to #team', () => {
  assert.equal(homeRoom(run({ kind: 'agent.job', args: { agent: 'builder', prompt: 'x' } })), 'TEAM')
  assert.equal(homeRoom(run({ kind: 'project.dev', args: { project: 'portfolio' } })), 'TEAM')
  assert.equal(homeRoom(run({ kind: 'project.code', args: { project: 'react-flow' } })), 'TEAM')
})

test('a mix with any coding goes to #team', () => {
  assert.equal(homeRoom(run({ kind: 'project.dev', args: { project: 'portfolio' } }, { kind: 'screen.shot' })), 'TEAM')
})

test('a project with its own room: its jobs go there, others still to #team', () => {
  memory.set('project.room.react-flow', 'ROOM-RF')
  assert.equal(homeRoom(run({ kind: 'project.dev', args: { project: 'react-flow' } })), 'ROOM-RF')
  assert.equal(homeRoom(run({ kind: 'agent.job', args: { agent: 'builder', project: 'React-Flow' } })), 'ROOM-RF')
  assert.equal(homeRoom(run({ kind: 'project.dev', args: { project: 'portfolio' } })), 'TEAM')
  assert.equal(projectOfRoom('ROOM-RF'), 'react-flow')
  assert.equal(projectOfRoom('TEAM'), undefined)
})

test('a job with a step that did nothing doesn\'t get a tick', async () => {
  const { resultLine } = await import('./rooms.js')
  const run = (steps: { status: string }[]) => resultLine({ status: 'done', command: 'x', label: 'Ship', summary: 's', steps } as never)
  assert.match(run([{ status: 'done' }]), /^✅/)
  assert.match(run([{ status: 'done' }, { status: 'stubbed' }]), /^⚠️/)
})

test('a failed job\'s result names its agent without waking it', async () => {
  const { resultLine } = await import('./rooms.js')
  const line = resultLine({ status: 'failed', command: 'x', label: 'Fix payments', summary: '@frontend is stuck: tsc fails' } as never)
  assert.equal(line, '⚠️ Fix payments: frontend is stuck: tsc fails')
})
