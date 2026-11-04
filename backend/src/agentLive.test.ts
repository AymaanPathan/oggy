import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { TraceEntry } from './shared/types.js'

/** Reading an agent's session as it works. Real transcript lines, in a throwaway folder. */

const root = mkdtempSync(join(tmpdir(), 'oggy-live-'))
const code = join(root, 'code')
const projects = join(root, 'projects')
process.env.OGGY_DATA_DIR = join(root, 'data')
process.env.OGGY_PROJECTS_DIR = code
process.env.OGGY_CLAUDE_PROJECTS = projects
const dir = join(projects, code.replace(/[:\\/.]/g, '-'))
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'seed.jsonl'), '')

const { followAgent, startTeamWatch } = await import('./agentLive.js')
const { db } = await import('./db.js')
startTeamWatch()

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
  setTimeout(() => process.exit(0), 50).unref()
})

const at = () => new Date().toISOString()
const job = (text: string) => ({ type: 'user', timestamp: at(), message: { content: `[Switch] oggy addressed you\nBEGIN SWITCH MESSAGE x\n@scout ${text}\nEND SWITCH MESSAGE x` } })
const use = (id: string, name: string, input: unknown) => ({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string, is_error = false) => ({ type: 'user', timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })
const says = (text: string, stop_reason = 'end_turn') => ({ type: 'assistant', timestamp: at(), message: { stop_reason, content: [{ type: 'text', text }] } })

let n = 0
function session(text: string) {
  const file = join(dir, `s${++n}.jsonl`)
  writeFileSync(file, '')
  const write = (...lines: unknown[]) => appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  write(job(text))
  return write
}

const settle = () => new Promise((r) => setTimeout(r, 1000))
const noop = () => {}

test('every action shows up, with how it ended', async () => {
  const seen = new Map<string, TraceEntry>()
  const text = 'explain the payments page please'
  const live = followAgent(text, { onAction: noop, onTrace: (e) => seen.set(e.id, e) })
  const write = session(text)
  await settle()
  write(use('t1', 'Read', { file_path: 'a.ts' }))
  write(result('t1', 'file contents'))
  write(use('t2', 'Bash', { command: 'pnpm test', description: 'Run the tests' }))
  write(result('t2', 'Exit code 1: two failed', true))
  write(says('Looking at why those two failed.', 'tool_use'))
  await settle()
  live.stop()
  const list = [...seen.values()]
  assert.equal(list[0].text, 'Reading')
  assert.equal(list[0].ok, true)
  assert.equal(typeof list[0].endedAt, 'number')
  assert.equal(list[1].ok, false)
  assert.match(list[1].output ?? '', /two failed/)
  assert.equal(list[2].kind, 'say')
  assert.equal(list[2].text, 'Looking at why those two failed.')
})

test('your apps show as what they are: mail read, the calendar, and the to-dos written in Notion', async () => {
  const seen = new Map<string, TraceEntry>()
  const text = 'read my mail and add the to-dos to Notion'
  const live = followAgent(text, { onAction: noop, onTrace: (e) => seen.set(e.id, e) })
  const write = session(text)
  await settle()
  write(use('g1', 'mcp__claude_ai_Gmail__search_threads', { query: 'is:unread newer_than:1d' }))
  write(use('g2', 'mcp__claude_ai_Gmail__get_thread', { threadId: 'x' }))
  write(use('c1', 'mcp__claude_ai_Google_Calendar__list_events', {}))
  write(use('n1', 'mcp__claude_ai_Notion__notion-search', { query: 'To-do' }))
  write(use('n2', 'mcp__claude_ai_Notion__notion-create-pages', { pages: [{ properties: { title: 'To-do' }, content: '## From email\n- [ ] Reply to Maaz\n- [ ] Review Groww pledge policy\n- [x] Check the security alert' }] }))
  write(use('d1', 'mcp__claude_ai_Gmail__create_draft', { subject: 'Following up on Thursday' }))
  write(use('t1', 'ToolSearch', { query: 'select:x' }))
  await settle()
  live.stop()
  const list = [...seen.values()]
  assert.deepEqual(list.map((e) => e.kind), ['mail', 'mail', 'calendar', 'notes', 'todo', 'draft'])
  assert.equal(list[0].text, 'Reading your mail')
  assert.equal(list[0].detail, 'is:unread newer_than:1d')
  assert.equal(list[3].detail, 'To-do')
  assert.equal(list[4].text, 'Adding 3 to-dos')
  assert.equal(list[4].detail, 'To-do')
  assert.deepEqual(list[4].items, ['Reply to Maaz', 'Review Groww pledge policy', 'Check the security alert'])
  assert.equal(list[5].text, 'Drafting an email')
  assert.equal(list[5].detail, 'Following up on Thursday')
})

test('stopping with a report the room refused hands that report back', async () => {
  let got: { report?: string; failed: number } | undefined
  const text = 'look at the invoice page for me'
  const live = followAgent(text, { onAction: noop, onStopped: (s) => (got = s) }, 100)
  const write = session(text)
  await settle()
  write(use('p1', 'mcp__switch__post_message', { body: 'All clear.\nDONE: the invoice page is fine' }))
  write(result('p1', 'Not connected to a room. Call connect_to_room first.'))
  write(says('I could not post that.'))
  await settle()
  live.stop()
  assert.match(got?.report ?? '', /DONE: the invoice page is fine/)
  assert.equal(got?.failed, 1)
})

test('an answer the room refused is kept, marker or not', async () => {
  let got: { refused?: string } | undefined
  const text = 'explain the orders page for me'
  const live = followAgent(text, { onAction: noop, onStopped: (s) => (got = s) }, 100)
  const write = session(text)
  await settle()
  write(use('p3', 'mcp__switch__post_message', { body: 'The orders page lists orders.' }))
  write(result('p3', '400: Not connected to a room', true))
  write(says('BLOCKED: it could not be posted'))
  await settle()
  live.stop()
  assert.equal(got?.refused, 'The orders page lists orders.')
})

test('a report in its last words needs no minute of waiting', async () => {
  let got: { report?: string } | undefined
  const text = 'check the billing page for me'
  const live = followAgent(text, { onAction: noop, onStopped: (s) => (got = s) })
  const write = session(text)
  await settle()
  write(says('All checked.\nDONE: billing looks fine'))
  await new Promise((r) => setTimeout(r, 4500))
  live.stop()
  assert.match(got?.report ?? '', /DONE: billing looks fine/)
})

test('a report that landed is left to the room', async () => {
  let got: { report?: string } | undefined
  const text = 'check the settings page for me'
  const live = followAgent(text, { onAction: noop, onStopped: (s) => (got = s) }, 100)
  const write = session(text)
  await settle()
  write(use('p2', 'mcp__switch__post_message', { body: 'DONE: settings look fine' }))
  write(result('p2', '{"ok":true}'))
  write(says('Posted.'))
  await settle()
  live.stop()
  assert.equal(got?.report, undefined)
})

test('working again calls off the alarm, and so does waiting for you', async () => {
  let stopped = 0
  const text = 'tidy the orders page for me'
  const live = followAgent(text, { onAction: noop, onStopped: () => stopped++ }, 1500)
  const write = session(text)
  await settle()
  write(says('Thinking out loud.'))
  write(use('r1', 'Read', { file_path: 'b.ts' }))
  await new Promise((r) => setTimeout(r, 2400))
  assert.equal(stopped, 0)
  live.hold(true)
  write(says('Waiting for your answer.'))
  await new Promise((r) => setTimeout(r, 2400))
  assert.equal(stopped, 0)
  live.stop()
})
