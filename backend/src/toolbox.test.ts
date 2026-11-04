import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/** Who covers an agent Switch can't run. Throwaway data folder, never your real ~/.oggy. */

const root = mkdtempSync(join(tmpdir(), 'oggy-toolbox-'))
process.env.OGGY_DATA_DIR = root

const { config } = await import('./config.js')
const { standIn } = await import('./toolbox.js')
const { db } = await import('./db.js')

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const a = (alias: string) => ({ alias, name: `${alias}.test`, does: alias, isDefault: alias === 'claude' })
config.switch.agents = Object.fromEntries(['claude', 'scout', 'frontend', 'backend', 'tester', 'reviewer'].map((x) => [x, a(x)]))

test('a builder Switch can’t run is covered by the other builder, never the owner’s own Claude', () => {
  assert.equal(standIn(a('claude'))?.alias, 'backend')
  assert.equal(standIn(a('backend'))?.alias, 'frontend')
  assert.equal(standIn(a('frontend'))?.alias, 'backend')
})

test('agents that only read or check are never covered for (and never cover)', () => {
  for (const alias of ['scout', 'tester', 'reviewer']) assert.equal(standIn(a(alias)), undefined)
})

test('with no other builder on the team, nobody covers', () => {
  config.switch.agents = { backend: a('backend'), reviewer: a('reviewer') }
  assert.equal(standIn(a('backend')), undefined)
})
