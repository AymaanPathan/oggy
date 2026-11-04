import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/** The team's vote, and who ships. Real git, a throwaway "GitHub" and a throwaway site. */

const root = mkdtempSync(join(tmpdir(), 'oggy-ship-'))
process.env.OGGY_DATA_DIR = join(root, 'data')

const { config } = await import('./config.js')
const { seenLive, shipJob } = await import('./ship.js')
const { castVote, openVote, outcome, people, personOf } = await import('./team.js')
const { approvals, db, runs } = await import('./db.js')
const { runPlanned } = await import('./executor.js')
const { onMessage } = await import('./rooms.js')
const { TOOLBOX } = await import('./toolbox.js')

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

config.owner.name = 'Aymaan'
config.owner.username = 'aymaan2218'
config.owner.switchUserId = ''
config.team = [{ name: 'Rahul', username: 'rahul065935', switchUserId: '@rahul:localhost' }]
config.projectsDir = root
config.switch.agents.release = { alias: 'release', name: 'release-agent', does: 'Ships', isDefault: false } as never

test('the team is you first, then everyone else, and only they count', () => {
  assert.deepEqual(people().map((p) => p.name), ['Aymaan', 'Rahul'])
  assert.equal(personOf({ name: 'aymaan2218' })?.name, 'Aymaan')
  assert.equal(personOf({ id: '@rahul:localhost', name: 'whoever' })?.name, 'Rahul')
  // The name alone isn't enough once there's an id on file.
  assert.equal(personOf({ id: '@fake:localhost', name: 'rahul065935' }), undefined)
  assert.equal(personOf({ id: 'x', name: 'stranger' }), undefined)
})

test('it takes everyone to go, and one no to stop', () => {
  openVote('v1')
  assert.equal(outcome(castVote('v1', 'Aymaan', true)!), undefined)
  assert.equal(outcome(castVote('v1', 'Rahul', true)!), 'approved')
  openVote('v2')
  assert.equal(outcome(castVote('v2', 'Aymaan', true)!), undefined)
  assert.equal(outcome(castVote('v2', 'Rahul', false)!), 'rejected')
  assert.equal(castVote('v2', 'Someone else', true), undefined)
})

const until = async <T>(what: () => T | undefined): Promise<T> => {
  for (let i = 0; i < 300; i++) {
    const got = what()
    if (got) return got
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out')
}
const says = (senderName: string, sender: string, body: string) =>
  onMessage({ id: body, roomId: 'ROOM', threadId: null, sender, senderName, body, addressed: false, timestamp: Date.now() })

let n = 0
function project() {
  const name = `p${++n}`
  const dir = join(root, name)
  mkdirSync(dir)
  const remote = `${dir}-github.git`
  spawnSync('git', ['init', '--bare', '-b', 'main', remote])
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('remote', 'add', 'origin', remote)
  writeFileSync(join(dir, 'app.ts'), 'one\n')
  git('add', '.')
  git('commit', '-m', 'start')
  git('push', 'origin', 'main')
  return { name, dir, git }
}

async function site(status: number, body: () => string) {
  const server = createServer((_q, s) => {
    s.statusCode = status
    s.end(body())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => new Promise((r) => server.close(r)) }
}

/** Stands in for the release agent: records its job and reports as told. */
function releaseAgent(reply: { status: 'done' | 'failed'; output: string } = { status: 'done', output: 'DONE: shipped' }) {
  const jobs: Record<string, unknown>[] = []
  TOOLBOX['agent.job'].run = async (a) => {
    jobs.push(a)
    return reply
  }
  return jobs
}

const voteOn = async (project: string) => {
  config.deploy[project] = { branch: 'main', url: undefined }
  const run = runPlanned('deploy it', 'Ship', [{ id: 'd', kind: 'deploy', title: '@release: ship it', args: { project } }], 'desktop')
  await until(() => approvals.list(true).find((a) => a.runId === run.id))
  return run
}

test('from the room: the release agent gets the job only after everyone says yes', async () => {
  const { name } = project()
  const jobs = releaseAgent()
  const run = await voteOn(name)
  says('stranger', '@stranger:localhost', 'yes')
  says('rahul065935', '@rahul:localhost', 'yes')
  await new Promise((d) => setTimeout(d, 150))
  assert.equal(runs.get(run.id)?.status, 'waiting_approval')
  assert.equal(jobs.length, 0) // one yes isn't enough
  says('aymaan2218', '@aymaan:localhost', 'yes')
  await until(() => runs.get(run.id)?.status === 'done')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].agent, 'release')
  assert.match(String(jobs[0].prompt), /Aymaan, Rahul/)
})

test('from the room: one no stops it, the agent never hears of it, and it names who said it', async () => {
  const { name } = project()
  const jobs = releaseAgent()
  const run = await voteOn(name)
  says('aymaan2218', '@aymaan:localhost', 'yes')
  says('rahul065935', '@rahul:localhost', 'no')
  await until(() => runs.get(run.id)?.status === 'cancelled')
  assert.match(runs.get(run.id)?.summary ?? '', /Rahul said no/)
  assert.equal(jobs.length, 0)
})

test('a stuck release agent stops the job and nobody else ships', async () => {
  const { name } = project()
  const jobs = releaseAgent({ status: 'failed', output: '@release is stuck: the merge conflicts' })
  const run = await voteOn(name)
  says('aymaan2218', '@aymaan:localhost', 'yes')
  says('rahul065935', '@rahul:localhost', 'yes')
  await until(() => runs.get(run.id)?.status === 'failed')
  assert.equal(jobs.length, 1)
})

test('the agent saying it shipped isn’t enough: Oggy looks at the site', async () => {
  const { name } = project()
  releaseAgent()
  const old = await site(200, () => '{"commit":"0000000000"}')
  const run = await voteOn(name)
  config.deploy[name].url = old.url
  says('aymaan2218', '@aymaan:localhost', 'yes')
  says('rahul065935', '@rahul:localhost', 'yes')
  await until(() => runs.get(run.id)?.status === 'failed')
  await old.close()
  assert.match(runs.get(run.id)?.summary ?? '', /older version/)
})

test('what the site shows decides what Oggy says', async () => {
  const { dir, git } = project()
  const head = git('rev-parse', 'main').stdout.trim()
  const target = { branch: 'main' }
  const check = async (status: number, body: string) => {
    const s = await site(status, () => body)
    const seen = await seenLive(dir, { ...target, url: s.url })
    await s.close()
    return seen
  }
  assert.equal(await check(200, `{"commit":"${head}"}`), 'proved')
  assert.equal(await check(200, '{"commit":"0000000"}'), 'old')
  assert.equal(await check(200, '{"status":"ok"}'), 'answering')
  assert.equal(await check(503, 'down'), 'down')
})

test('the job names the voters and how to treat a site that shows no version', () => {
  const job = shipJob('paytrack', { branch: 'main', url: 'https://x/health' }, ['Aymaan', 'Rahul'])
  assert.match(job, /Aymaan, Rahul/)
  assert.match(job, /https:\/\/x\/health/)
  assert.match(job, /couldn't be confirmed/)
})
