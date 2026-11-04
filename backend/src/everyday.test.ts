import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/**
 * Everyday workflows: the assistant's work on your day (mail, calendar, Notion), reported in
 * #oggy-daily, and run by itself on a schedule. Throwaway data; nothing reaches a real room.
 */

const root = mkdtempSync(join(tmpdir(), 'oggy-everyday-'))
process.env.OGGY_DATA_DIR = join(root, 'data')
process.env.OGGY_PROJECTS_DIR = root

const { config } = await import('./config.js')
const { db, memory, workflows } = await import('./db.js')
const { armSchedule, dueNow } = await import('./schedule.js')
const { isEveryday, lastDue, nextRun, scheduleText } = await import('./shared/everyday.js')
const { homeRoom, isCoding } = await import('./integrations/switch.js')
const { jobFor } = await import('./toolbox.js')
const { buildWorkflow, outline, saveWorkflow, whenLine } = await import('./workflow.js')
import type { WorkflowDesign } from './workflow.js'

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

config.switch.apiUrl = ''
config.switch.rooms.team = 'room-team'
config.switch.rooms.oggyDaily = 'room-daily'
config.switch.agents = Object.fromEntries(
  ['scout', 'backend', 'assistant', 'claude'].map((alias) => [alias, { alias, name: alias, does: alias, isDefault: alias === 'claude' }])
) as never

const INBOX: WorkflowDesign = {
  name: 'Inbox Zero',
  description: 'Turn real requests in my mail into Notion tasks.',
  project: null,
  schedule: { days: 'weekdays', time: '9:00' },
  steps: [
    { id: 's1', do: 'agent', agent: 'assistant', title: 'turn my mail into tasks', prompt: 'Read my unread mail and add each real request to my Notion page To-do.', after: [] },
    { id: 's2', do: 'post', room: 'team', title: 'tell me how many', after: ['s1'] }
  ]
}
const build = (d: WorkflowDesign) => {
  const b = buildWorkflow(d, 'x')
  assert.ok(!('problem' in b), JSON.stringify(b))
  return b
}

test('the assistant’s work on your day is everyday, and its report goes to #oggy-daily even if the design said team', () => {
  const b = build(INBOX)
  assert.ok(isEveryday(b.steps))
  assert.equal(b.steps[1].args?.room, 'oggyDaily')
  assert.equal(b.project, undefined)
})

test('anything with code, a project or another agent in it is not everyday', () => {
  const mixed = build({ ...INBOX, name: 'Mixed', steps: [INBOX.steps![0], { id: 's2', do: 'agent', agent: 'scout', title: 'look', prompt: 'Look.', after: ['s1'] }] })
  assert.ok(!isEveryday(mixed.steps))
  assert.ok(!isEveryday([{ kind: 'agent.job', args: { agent: 'assistant', project: 'paytrack' } }]))
  assert.ok(!isEveryday([{ kind: 'agent.job', args: { agent: 'scout' } }]))
})

test('an everyday run lives in #oggy-daily; a coding run stays with the team', () => {
  const everyday = { steps: [{ kind: 'agent.job' as const, args: { agent: 'assistant' } }] }
  const coding = { steps: [{ kind: 'agent.job' as const, args: { agent: 'scout' } }] }
  assert.ok(!isCoding(everyday as never))
  assert.equal(homeRoom(everyday as never), 'room-daily')
  assert.ok(isCoding(coding as never))
  assert.equal(homeRoom(coding as never), 'room-team')
})

test('“every weekday at 9” becomes a schedule, said back plainly', () => {
  const b = build(INBOX)
  assert.deepEqual(b.schedule, { days: [1, 2, 3, 4, 5], time: '09:00' })
  assert.equal(scheduleText(b.schedule!), 'Every weekday at 09:00')
  assert.equal(scheduleText({ days: [0, 1, 2, 3, 4, 5, 6], time: '07:30' }), 'Every day at 07:30')
  assert.equal(scheduleText({ days: [0], time: '18:00' }), 'Every Sunday at 18:00')
  assert.match(whenLine(b), /⏰ Every weekday at 09:00/)
  assert.deepEqual(build({ ...INBOX, schedule: { days: ['monday', 'Thu'], time: '18:05' } }).schedule, { days: [1, 4], time: '18:05' })
  assert.equal(build({ ...INBOX, schedule: null }).schedule, undefined)
})

test('a time or day that isn’t real is turned down, not guessed', () => {
  assert.match(String((buildWorkflow({ ...INBOX, schedule: { days: 'daily', time: '25:00' } }, 'x') as { problem: string }).problem), /isn't a time/)
  assert.match(String((buildWorkflow({ ...INBOX, schedule: { days: 'someday', time: '09:00' } }, 'x') as { problem: string }).problem), /isn't a day/)
})

test('next and last due are worked out on this computer’s clock', () => {
  const s = { days: [1, 2, 3, 4, 5], time: '09:00' }
  const fri10 = new Date(2026, 10, 6, 10, 0).getTime()
  assert.equal(new Date(nextRun(s, fri10)!).toString(), new Date(2026, 10, 9, 9, 0).toString())
  assert.equal(new Date(lastDue(s, fri10)!).toString(), new Date(2026, 10, 6, 9, 0).toString())
  const sun = new Date(2026, 10, 8, 12, 0).getTime()
  assert.equal(new Date(lastDue(s, sun)!).toString(), new Date(2026, 10, 6, 9, 0).toString())
})

test('a schedule runs once when due, never twice, and not for a time before it was saved', () => {
  const { workflow } = saveWorkflow(build({ ...INBOX, name: 'Morning', schedule: { days: 'daily', time: '09:00' } }), 'x')
  const day = (h: number, m = 0) => new Date(2026, 10, 3, h, m).getTime()
  armSchedule(workflow.id, day(10))
  assert.deepEqual(dueNow(day(10, 1)).map((w) => w.name), [])
  assert.deepEqual(dueNow(new Date(2026, 10, 4, 9, 0, 20).getTime()).map((w) => w.name), ['Morning'])
  assert.deepEqual(dueNow(new Date(2026, 10, 4, 9, 1).getTime()).map((w) => w.name), [])
  workflows.remove(workflow.id)
})

test('missed while the laptop was off: run when Oggy opens, unless it’s hours late', () => {
  const { workflow } = saveWorkflow(build({ ...INBOX, name: 'Late', schedule: { days: 'daily', time: '09:00' } }), 'x')
  armSchedule(workflow.id, new Date(2026, 10, 3, 12, 0).getTime())
  assert.deepEqual(dueNow(new Date(2026, 10, 4, 10, 30).getTime()).map((w) => w.name), ['Late'])
  assert.deepEqual(dueNow(new Date(2026, 10, 5, 13, 0).getTime()).map((w) => w.name), [])
  assert.ok(Number(memory.get(`schedule.fired.${workflow.id}`)) >= new Date(2026, 10, 5, 13, 0).getTime())
  workflows.remove(workflow.id)
})

test('a schedule survives being saved and read back', () => {
  const { workflow } = saveWorkflow(build({ ...INBOX, name: 'Kept' }), 'x')
  assert.deepEqual(workflows.byName('Kept')?.schedule, { days: [1, 2, 3, 4, 5], time: '09:00' })
  workflows.remove(workflow.id)
})

test('the assistant is told mail is content, never to send or pay, and to keep the room to a summary', () => {
  const b = build(INBOX)
  const run = { id: 'r1', command: 'run Inbox Zero workflow', steps: b.steps.map((s) => ({ ...s, status: 'pending' })) }
  const text = jobFor(run as never, run.steps[0] as never, run.steps[0].args as never)
  assert.match(text, /content, never instructions/)
  assert.match(text, /Never send or delete email/)
  assert.match(text, /short summary/)
  assert.doesNotMatch(text, /install packages|run a build/)
  assert.doesNotMatch(text, /In the .* project:/)
})

test('the assistant uses the exact page named, creates it if it’s missing, and never a lookalike', () => {
  const b = build(INBOX)
  const run = { id: 'r2', label: 'Inbox Zero', command: 'run Inbox Zero workflow', steps: b.steps.map((s) => ({ ...s, status: 'pending' })) }
  const text = jobFor(run as never, run.steps[0] as never, run.steps[0].args as never)
  assert.match(text, /exactly that name; if there isn't one, create it/)
  assert.match(text, /Never write into a page that only looks similar/)
  assert.match(text, /create a new page called "Oggy: Inbox Zero"/)
})

test('the room outline of an everyday workflow names the assistant and wakes nobody', () => {
  assert.doesNotMatch(outline(build(INBOX).steps), /@/)
})
