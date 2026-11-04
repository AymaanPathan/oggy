import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

/** Who Oggy obeys in a room. Throwaway data folder, never your real ~/.oggy. */

const root = mkdtempSync(join(tmpdir(), 'oggy-gate-'))
process.env.OGGY_DATA_DIR = root

const { config } = await import('./config.js')
const { fromOwner, isOwner, requesterOf } = await import('./gate.js')
const { db } = await import('./db.js')

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const ME = '@switch-discord-1f7cc6db-4af7-42ca-b731-4922430521b4-aymaan2218:localhost'
const me = { sender: ME, senderName: 'aymaan2218' }
// Same name, another app or an agent: not you.
const mattermostTwin = { sender: '@switch-mattermost-1edfb1ee-aymaan2218:localhost', senderName: 'aymaan2218' }
const agentTwin = { sender: '@switch-agent-1234abcd:localhost', senderName: 'aymaan2218' }
const stranger = { sender: '@switch-discord-1f7cc6db-4af7-42ca-b731-4922430521b4-sam:localhost', senderName: 'sam' }

const check = (m: { sender: string; senderName: string }) => isOwner({ id: m.sender, name: m.senderName })
const roomRun = (m: { sender: string; senderName: string }) => fromOwner({ source: 'switch', requestedBy: requesterOf(m) })

describe('with your Switch id set', () => {
  beforeEach(() => Object.assign(config.owner, { username: 'aymaan2218', switchUserId: ME }))

  test('you are obeyed', () => assert.equal(check(me), true))
  test('a Mattermost user with your name is not you', () => assert.equal(check(mattermostTwin), false))
  test('an agent with your name is not you', () => assert.equal(check(agentTwin), false))
  test('someone else is not you', () => assert.equal(check(stranger), false))
  test('your room runs pass the gate, a twin’s do not', () => {
    assert.equal(roomRun(me), true)
    assert.equal(roomRun(mattermostTwin), false)
    assert.equal(roomRun(agentTwin), false)
  })
  test('no sender at all is not you', () => assert.equal(isOwner({}), false))
})

describe('with only your username (fallback)', () => {
  beforeEach(() => Object.assign(config.owner, { username: 'aymaan2218', switchUserId: '' }))

  test('you are obeyed, any case', () => assert.equal(isOwner({ name: 'Aymaan2218' }), true))
  test('someone else is not you', () => assert.equal(check(stranger), false))
  test('your room runs pass the gate', () => assert.equal(roomRun(me), true))
})

describe('nothing set', () => {
  beforeEach(() => Object.assign(config.owner, { username: '', switchUserId: '' }))

  test('nobody in a room is obeyed', () => {
    assert.equal(check(me), false)
    assert.equal(roomRun(me), false)
  })
  test('the desktop always is (it holds your owner token)', () => assert.equal(fromOwner({ source: 'desktop' }), true))
})
