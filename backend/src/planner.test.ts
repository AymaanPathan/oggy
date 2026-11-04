import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { StepKind, StepTemplate } from './shared/types.js'

/**
 * What Oggy plans for what you say, single and several commands in one sentence.
 * Runs against a throwaway data folder and fake projects, never your real ~/.oggy or code folder.
 */

const root = mkdtempSync(join(tmpdir(), 'oggy-plan-'))
const code = join(root, 'code')
const pkg = (dir: string, scripts: Record<string, string>) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
}
pkg(join(code, 'portfolio'), { dev: 'vite', build: 'vite build', test: 'vitest' })
pkg(join(code, 'react-flow'), { dev: 'vite', build: 'vite build' })
pkg(join(code, 'dashboard-crm', 'frontend'), { dev: 'vite', build: 'vite build' })
pkg(join(code, 'dashboard-crm', 'backend'), { dev: 'tsx watch src/index.ts', test: 'vitest' })
process.env.OGGY_DATA_DIR = join(root, 'data')
process.env.OGGY_PROJECTS_DIR = code

const { handOut, planAll, PLANNABLE, realFile } = await import('./planner.js')
const { opensSafely } = await import('./desktop.js')
const { memory, db } = await import('./db.js')

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

/** Anything the keyword planner can't do goes to Claude; here that's a marker instead. */
const LLM = 'LLM'
const llm = async () => ({ cannot: LLM }) as never

/** "project.dev(dashboard-crm/frontend)", "app.open(chrome)", "agent.job(portfolio:reviewer)". */
async function steps(command: string, current = 'react-flow'): Promise<string[]> {
  memory.set('current_project', current)
  memory.set('plan.pending', '')
  const p = await planAll(command, llm)
  return p.steps.map((s) => {
    const a = s.args ?? {}
    if (s.kind === 'note') return a.message === LLM ? LLM : 'note'
    const target = a.project ? `${a.project}${a.part ? `/${a.part}` : ''}${s.kind === 'agent.job' && a.agent !== 'builder' ? `:${a.agent}` : ''}` : (a.app as string | undefined)
    return `${s.kind}${target ? `(${target})` : ''}`
  })
}

const cases = (title: string, list: [command: string, expected: string[]][]) =>
  describe(title, () => {
    for (const [command, expected] of list) test(command, async () => assert.deepEqual(await steps(command), expected))
  })

cases('one command', [
  ['open my portfolio in vs code', ['project.code(portfolio)']],
  ['open it in vs code', ['project.code(react-flow)']],
  ['open in vs', ['project.code(react-flow)']],
  ['open vs code', ['app.open(vs code)']],
  ['start the dev server for my portfolio', ['project.dev(portfolio)']],
  ['build my portfolio', ['agent.job(portfolio:tester)']],
  ['run the tests in my portfolio', ['agent.job(portfolio:tester)']],
  ['install packages for my portfolio', ['agent.job(portfolio:tester)']],
  ['stop the server for my portfolio', ['project.stop(portfolio)']],
  ['start the frontend of my dashboard-crm', ['project.dev(dashboard-crm/frontend)']],
  ['start the dev server for my dashboard-crm frontend', ['project.dev(dashboard-crm/frontend)']],
  ['take a screenshot', ['screen.shot']],
  ['open chrome', ['app.open(chrome)']],
  ['open my downloads', ['folder.open']],
  ['deploy my portfolio', ['agent.job(portfolio:tester)', 'agent.job(portfolio:release)', 'deploy(portfolio)']]
])

cases('several commands in one sentence', [
  ['open my portfolio in vs code and start the dev server', ['project.code(portfolio)', 'project.dev(portfolio)']],
  ['install packages for my react-flow then run the build', ['agent.job(react-flow:tester)', 'agent.job(react-flow:tester)']],
  ['open chrome and spotify', ['app.open(chrome)', 'app.open(spotify)']],
  ['open chrome, spotify and notepad', ['app.open(chrome)', 'app.open(spotify)', 'app.open(notepad)']],
  ['close chrome and notepad', ['app.close(chrome)', 'app.close(notepad)']],
  ['take a screenshot and open my downloads', ['screen.shot', 'folder.open']],
  ['turn the volume down and open spotify', ['system.volume', 'app.open(spotify)']],
  ['open my dashboard-crm in vs code, start the frontend and take a screenshot', ['project.code(dashboard-crm)', 'project.dev(dashboard-crm/frontend)', 'screen.shot']],
  ['start the backend of my dashboard-crm and open it in vs code', ['project.dev(dashboard-crm/backend)', 'project.code(dashboard-crm)']],
  ['start the dev server for my react-flow and open it in vs code', ['project.dev(react-flow)', 'project.code(react-flow)']],
  ['build my portfolio and start the dev server for my react-flow', ['agent.job(portfolio:tester)', 'project.dev(react-flow)']],
  ['open my portfolio in vs code and then open my react-flow in vs code', ['project.code(portfolio)', 'project.code(react-flow)']],
  ['build my portfolio, run the tests and then deploy it', ['agent.job(portfolio:tester)', 'agent.job(portfolio:tester)', 'agent.job(portfolio:release)', 'deploy(portfolio)']],
  ['add a dark mode toggle to my portfolio and deploy it', ['agent.job(portfolio:frontend)', 'agent.job(portfolio:tester)', 'agent.job(portfolio:reviewer)', 'agent.job(portfolio:release)', 'deploy(portfolio)']],
  ['add a contact page to my react-flow and run the build', ['agent.job(react-flow:frontend)', 'agent.job(react-flow:tester)', 'agent.job(react-flow:tester)']],
  ['fix the failing tests in my portfolio and then open it in vs code', ['agent.job(portfolio:scout)', 'agent.job(portfolio:tester)', 'agent.job(portfolio:frontend)', 'agent.job(portfolio:tester)', 'project.code(portfolio)']],
  ['stop the server for my portfolio and close chrome', ['project.stop(portfolio)', 'app.close(chrome)']]
])

cases('creating a project', [
  ['create a new project with react called demo-app', ['project.room(demo-app)', 'agent.job(demo-app:frontend)', 'agent.job(demo-app:tester)', 'agent.job(demo-app:scout)']],
  ['create a full-stack project called paytrack', ['project.room(paytrack)', 'agent.job(paytrack:backend)', 'agent.job(paytrack:frontend)', 'agent.job(paytrack:tester)', 'agent.job(paytrack:scout)']],
  [
    'create a new project with react with typescript and tailwind enabled called demo-app make a simple initial react project and open this project in vs code for me after setup',
    ['project.room(demo-app)', 'agent.job(demo-app:frontend)', 'agent.job(demo-app:tester)', 'agent.job(demo-app:scout)', 'project.code(demo-app)']
  ],
  ['create a react project called demo-app and start the dev server', ['project.room(demo-app)', 'agent.job(demo-app:frontend)', 'agent.job(demo-app:tester)', 'agent.job(demo-app:scout)', 'project.dev(demo-app)']],
  [
    'make a project called demo-app with react and typescript, then open it in vs code and start the dev server',
    ['project.room(demo-app)', 'agent.job(demo-app:frontend)', 'agent.job(demo-app:tester)', 'agent.job(demo-app:scout)', 'project.code(demo-app)', 'project.dev(demo-app)']
  ],
  // No name: ask, never reuse the last project.
  ['create a new project with react and typescript', ['note']]
])

cases('opening a project and its server', [
  ['open my portfolio project', ['project.code(portfolio)']],
  ['open react-flow', ['project.code(react-flow)']],
  ['open my portfolio project server', ['project.dev(portfolio)']],
  ['open my portfolio project and start the server and open in vs code', ['project.code(portfolio)', 'project.dev(portfolio)']],
  ['open chrome', ['app.open(chrome)']]
])

cases('project rooms', [
  ['give my portfolio its own room', ['project.room(portfolio)']],
  ['make a room for my dashboard-crm', ['project.room(dashboard-crm)']],
  ['create a channel for my portfolio project', ['project.room(portfolio)']],
  ['give it its own room', ['project.room(react-flow)']],
  ['give my portfolio its own room and open it in vs code', ['project.room(portfolio)', 'project.code(portfolio)']],
  ['archive my portfolio room', ['project.room.archive(portfolio)']],
  ["I'm done with the react-flow channel", ['project.room.archive(react-flow)']]
])

cases('locking Oggy to you', [
  ['lock oggy to me', ['owner.lock']],
  ['Lock to my account', ['owner.lock']]
])

cases('not keyword commands (go to the plan lane)', [
  ['put my resume and offer letter in a folder called jobs', [LLM]],
  ['open chrome and do my taxes', [LLM]]
])

cases('how people really say it', [
  ['open my download folder', ['folder.open']],
  ['open my document folder', ['folder.open']],
  ['open the screenshot folder', ['folder.open']],
  ['open up my desktop', ['folder.open']],
  ['build my portfolo', ['agent.job(portfolio:tester)']],
  ['build my dashboard crm', ['agent.job(dashboard-crm:tester)']],
  // A real code change still reads as one.
  ['build a login page in my portfolio', ['agent.job(portfolio:backend)', 'agent.job(portfolio:frontend)', 'agent.job(portfolio:tester)']],
  ['open my dashboard crm in vs code', ['project.code(dashboard-crm)']],
  ['start the dev server for react flow', ['project.dev(react-flow)']],
  // Not a project, however it's phrased: it goes to Claude.
  ['open my latest file', [LLM]],
  ['play my first video', [LLM]],
  // Two projects fit, so nobody guesses.
  ['build my portfolio and start the dev server for my react-flow', ['agent.job(portfolio:tester)', 'project.dev(react-flow)']]
])

describe('the plan lane looks twice', () => {
  const app = { label: 'Open Chrome', steps: [{ id: 's1', tool: 'app.open', title: 'Open Chrome', args: { app: 'chrome' } }] }
  const seen: { correction?: string; careful?: boolean; recent: string[] }[] = []
  const answers = (...list: unknown[]) => {
    seen.length = 0
    return (async (_c: string, _f: unknown, help: (typeof seen)[number]) => (seen.push(help), list.shift())) as never
  }

  test('a rejected plan gets a second look, with the reason', async () => {
    memory.set('plan.pending', '')
    const p = await planAll('do the thing with chrome', answers({ label: 'x', steps: [{ tool: 'rm.everything', title: 'x', args: {} }] }, app))
    assert.deepEqual(p.steps.map((s) => s.kind), ['app.open'])
    assert.equal(seen.length, 2)
    assert.equal(seen[0].careful, false)
    assert.equal(seen[1].careful, true)
    assert.match(seen[1].correction ?? '', /rm\.everything/)
  })

  test('a "can\'t" gets a second look before you hear it', async () => {
    memory.set('plan.pending', '')
    const p = await planAll('do the thing with chrome', answers({ cannot: 'no' }, app))
    assert.deepEqual(p.steps.map((s) => s.kind), ['app.open'])
  })

  test('still wrong after that: it says so and runs nothing', async () => {
    memory.set('plan.pending', '')
    const p = await planAll('do the thing with chrome', answers({ cannot: 'no' }, { cannot: 'really no' }))
    assert.equal(p.steps[0].args?.message, 'really no')
    assert.equal(p.steps[0].args?.fail, true)
  })

  test('what it couldn\'t do is said at the end, not dropped', async () => {
    memory.set('plan.pending', '')
    const p = await planAll('do the thing with chrome', answers({ ...app, skipped: 'The image could not be attached.' }))
    assert.deepEqual(p.steps.map((s) => s.kind), ['app.open', 'note'])
    assert.equal(p.steps[1].args?.message, 'The image could not be attached.')
  })
})

test('a dropped folder is put back, only when one file fits', () => {
  const video = join('C:', 'Users', 'me', 'Downloads', 'Video Project 29.mp4')
  const twin = join('C:', 'Users', 'me', 'Desktop', 'notes.txt')
  const files = [video, twin, join('C:', 'Users', 'me', 'Documents', 'notes.txt')]
  assert.equal(realFile(join('C:', 'Users', 'me', 'Video Project 29.mp4'), files), video)
  assert.equal(realFile(twin, files), twin)
  assert.equal(realFile(join('C:', 'Users', 'me', 'notes.txt'), files), undefined)
  assert.equal(realFile(join('C:', 'Users', 'me', 'nothing.pdf'), files), undefined)
})

test('open starts what you look at, never what runs', () => {
  for (const f of ['a.pdf', 'Video Project 29.MP4', 'cv.docx', 'photo.png', 'song.mp3']) assert.equal(opensSafely(f), true, f)
  for (const f of ['setup.exe', 'run.bat', 'x.ps1', 'y.cmd', 'z.lnk', 'a.vbs', 'm.docm', 'b.xlsm', 'noextension', 'a.pdf.exe']) assert.equal(opensSafely(f), false, f)
})

test('a create job tells the agent what to build, not the commands after it', async () => {
  memory.set('plan.pending', '')
  const p = await planAll('create a react project called demo-app with tailwind and open it in vs code', llm)
  const job = p.steps.find((s) => s.kind === 'agent.job')
  assert.match(String(job?.args?.prompt), /^create a react project called demo-app with tailwind\n\nYou build the frontend only/)
  assert.equal(job?.args?.create, true)
})

test('a problem and a deploy in one sentence gets planned: the fix is never dropped', async () => {
  let asked = 0
  const llm = async () => {
    asked++
    return { cannot: 'stop here' } as never
  }
  await planAll('Oggy, a rejected payment still shows as paid in my portfolio. Fix it and deploy.', llm)
  assert.ok(asked > 0)
  asked = 0
  // Nothing wrong before the deploy: nothing to plan.
  const p = await planAll('deploy the fix to my portfolio', llm)
  assert.equal(asked, 0)
  assert.equal(p.steps.at(-1)?.kind, 'deploy')
})

test('Oggy coordinates: project work always goes to an agent, whoever planned it', () => {
  const steps = (kind: StepKind, args = { project: 'portfolio' }) => [{ id: 'a', kind, title: 'x', args }]
  for (const [kind, agent] of [['project.test', 'tester'], ['project.build', 'tester'], ['project.install', 'tester'], ['git.status', 'scout']] as const) {
    const [s] = handOut(steps(kind), 'do it')
    assert.equal(s.kind, 'agent.job')
    assert.equal(s.args?.agent, agent)
    assert.match(s.title, new RegExp(`^@${agent}:`))
    assert.equal(PLANNABLE.includes(kind), false)
  }
})

test('a part stays a part when it goes to the agent', () => {
  const [s] = handOut([{ id: 'a', kind: 'project.test', title: 'x', args: { project: 'p', part: 'backend' } }], 'run the tests')
  assert.match(String(s.args?.prompt), /Only the backend part/)
})

test('a bug starts with the scout, and everything waits for it', () => {
  const go = { id: 'go', kind: 'note', title: 'Check the plan', args: { plan: true } } as StepTemplate
  const fix = { id: 'b', kind: 'agent.job', title: '@backend: fix it', args: { project: 'p', agent: 'backend' }, after: ['go'] } as StepTemplate
  const out = handOut([go, fix], 'a rejected payment still shows as paid')
  assert.deepEqual(out.map((s) => s.args?.agent ?? 'oggy'), ['oggy', 'scout', 'backend'])
  assert.deepEqual(out[2].after, ['go', out[1].id])
  // New work has no cause to find.
  assert.equal(handOut([{ ...fix, title: '@backend: add a route' }], 'add a route').length, 1)
})

test('nothing reaches the vote before it is tested, reviewed and written up, and the release agent ships', () => {
  const build = { id: 'b', kind: 'agent.job', title: '@backend: add it', args: { project: 'p', agent: 'backend' } } as StepTemplate
  const ship = { id: 'd', kind: 'deploy', title: 'Deploy', args: { project: 'p' } } as StepTemplate
  const out = handOut([build, ship], 'add it and deploy')
  assert.deepEqual(out.map((s) => s.args?.agent ?? s.kind), ['backend', 'tester', 'reviewer', 'release', 'deploy'])
  assert.equal(out[4].title, '@release: ship p')
})
