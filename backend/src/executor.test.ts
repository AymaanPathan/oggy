import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PlanStep, Run } from './shared/types.js'

/** What happens to jobs a restart cut off. Throwaway data folder, never your real ~/.oggy. */

const root = mkdtempSync(join(tmpdir(), 'oggy-exec-'))
process.env.OGGY_DATA_DIR = root

const { approvals, db, runs } = await import('./db.js')
const { closeInterrupted } = await import('./executor.js')

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const step = (id: string, status: PlanStep['status']): PlanStep => ({ id, kind: 'note', title: id, status })
const run = (id: string, status: Run['status'], steps: PlanStep[]): Run => {
  const r: Run = { id, command: id, source: 'desktop', intent: 'quick', status, steps, createdAt: Date.now(), updatedAt: Date.now() }
  runs.save(r)
  return r
}

test('jobs cut off by a restart are marked stopped, their questions closed; finished ones are left alone', () => {
  run('mid-way', 'running', [step('a', 'done'), step('b', 'running'), step('c', 'pending')])
  run('asking', 'waiting_approval', [step('d', 'waiting_approval')])
  run('finished', 'done', [step('e', 'done')])
  const q = approvals.create('asking', 'd', 'Install packages')

  assert.equal(closeInterrupted(), 2)

  const midway = runs.get('mid-way')!
  assert.equal(midway.status, 'failed')
  assert.match(midway.summary!, /Oggy restarted/)
  assert.deepEqual(midway.steps.map((s) => s.status), ['done', 'failed', 'skipped'])
  assert.equal(runs.get('asking')!.status, 'failed')
  assert.equal(approvals.get(q.id)!.status, 'rejected')
  assert.equal(runs.get('finished')!.status, 'done')

  // Nothing left to close the next time.
  assert.equal(closeInterrupted(), 0)
})
