import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/**
 * Workflows you describe: what Oggy accepts from Claude's design, and how a run behaves. Your exact
 * "Code Red" is the running example. Throwaway data and projects; the agents are stood in for.
 */

const root = mkdtempSync(join(tmpdir(), 'oggy-flow-'))
const code = join(root, 'code')
mkdirSync(join(code, 'paytrack'), { recursive: true })
mkdirSync(join(code, 'portfolio'), { recursive: true })
process.env.OGGY_DATA_DIR = join(root, 'data')
process.env.OGGY_PROJECTS_DIR = code

const { config } = await import('./config.js')
const { approvals, db, runs, workflows } = await import('./db.js')
const { decideApproval, submitCommand } = await import('./executor.js')
const { findWorkflow, planAll, workflowRunSteps } = await import('./planner.js')
const { onMessage } = await import('./rooms.js')
const { TOOLBOX } = await import('./toolbox.js')
const { buildWorkflow, outline, saveWorkflow } = await import('./workflow.js')
import type { WorkflowDesign } from './workflow.js'

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

config.owner.name = 'Aymaan'
config.owner.username = 'aymaan2218'
config.owner.switchUserId = ''
config.team = [{ name: 'Rahul', username: 'rahul065935', switchUserId: '@rahul:localhost' }]
config.deploy.paytrack = { branch: 'main', url: undefined }
config.switch.agents = Object.fromEntries(
  ['backend', 'frontend', 'tester', 'scout', 'reviewer', 'release', 'claude'].map((alias) => [alias, { alias, name: alias, does: alias, isDefault: alias === 'claude' }])
) as never
config.switch.apiUrl = ''
// The review after a run asks Claude to explain it: not in a test.
config.claudeBin = 'oggy-test-no-claude'

const asked = 'create a workflow called Code Red in paytrack'
const CODE_RED: WorkflowDesign = {
  name: 'Code Red',
  description: 'Find what broke, fix it, ship it, and write it up.',
  project: 'paytrack',
  steps: [
    { id: 's1', do: 'agent', agent: 'backend', title: 'find what broke in the logs', prompt: 'Find what broke from the logs. Change nothing.', after: [], question: 'Did a deploy cause it?' },
    { id: 's2', do: 'agent', agent: 'tester', title: 'check which features are down', prompt: 'Check which features are down. Change nothing.', after: [] },
    { id: 's3', do: 'rollback', title: 'roll back the deploy', after: ['s1', 's2'], when: { step: 's1', is: 'yes' }, ask: { who: ['me'], question: 'Roll back the deploy?', ifNo: 'continue' } },
    { id: 's4', do: 'agent', agent: 'backend', title: 'write the real fix', prompt: 'Write the fix for what was found.', after: ['s3'] },
    { id: 's5', do: 'agent', agent: 'tester', title: 'prove it works', prompt: 'Prove the fix works.', after: ['s4'] },
    { id: 's6', do: 'deploy', title: 'redeploy paytrack', after: ['s5'], ask: { who: ['Rahul'], question: 'Redeploy paytrack?', ifNo: 'continue' } },
    { id: 's7', do: 'agent', agent: 'scout', title: 'write the incident report', prompt: 'Write the incident report.', after: ['s6'] },
    { id: 's8', do: 'post', room: 'team', title: 'post it in #team', after: ['s7'] }
  ]
}

const built = (d: WorkflowDesign = CODE_RED) => {
  const b = buildWorkflow(d, asked)
  assert.ok(!('problem' in b), 'problem' in b ? b.problem : '')
  return b
}
const problemIn = (d: Partial<WorkflowDesign>) => {
  const b = buildWorkflow({ ...CODE_RED, ...d }, asked)
  return 'problem' in b ? b.problem : ''
}
const withStep = (patch: object) => ({ steps: [{ ...CODE_RED.steps![0], ...patch }] })

test('your Code Red becomes real steps: parallel, conditional, and approved by the right people', () => {
  const b = built()
  assert.equal(b.name, 'Code Red')
  assert.equal(b.steps.length, 8)
  const [logs, down, rollback, fix, proof, redeploy, report, post] = b.steps
  assert.deepEqual(logs.after, [])
  assert.deepEqual(down.after, [])
  assert.equal(rollback.kind, 'deploy')
  assert.equal(rollback.args?.rollback, true)
  assert.deepEqual(rollback.when, { step: logs.id, is: 'yes' })
  assert.deepEqual(rollback.ask, { who: [], question: 'Roll back the deploy?', ifNo: 'continue' })
  assert.deepEqual(redeploy.ask?.who, ['Rahul'])
  assert.equal(fix.title, '@backend: write the real fix')
  assert.deepEqual(proof.after, [fix.id])
  assert.deepEqual(post.after, [report.id])
  assert.equal(post.args?.lastReport, true)
})

test('nothing Claude makes up gets past the check', () => {
  assert.match(problemIn({ name: '' }), /no name/)
  assert.match(problemIn({ steps: [] }), /no steps/)
  assert.match(problemIn({ project: 'nope' }), /no nope project/)
  assert.match(problemIn(withStep({ agent: 'priya' })), /no agent called priya/)
  assert.match(problemIn(withStep({ prompt: '' })), /doesn't say what/)
  assert.match(problemIn(withStep({ agent: 'claude' })), /personal agent/)
  assert.match(problemIn(withStep({ ask: { who: ['Priya'] } })), /Priya isn't on the team/)
  assert.match(problemIn(withStep({ when: { step: 'gone', is: 'yes' } })), /isn't in the workflow/)
  assert.match(problemIn({ steps: [{ ...CODE_RED.steps![0], id: 'a', after: ['b'] }, { ...CODE_RED.steps![1], id: 'b', after: ['a'] }] }), /circle/)
  assert.match(problemIn({ project: 'portfolio', steps: [CODE_RED.steps![5]] }), /isn't connected/)
  assert.match(problemIn({ project: null, steps: [CODE_RED.steps![5]] }), /needs a project/)
})

test('a rollback nobody asked to approve still asks you; a deploy with no approver stays a team vote', () => {
  const b = built({ ...CODE_RED, steps: [{ id: 'r', do: 'rollback', after: [] }, { id: 'd', do: 'deploy', after: ['r'] }] })
  assert.deepEqual(b.steps[0].ask?.who, [])
  assert.equal(b.steps[1].ask, undefined)
})

test('a described workflow stays in one piece, whatever words it uses', async () => {
  const said = 'Oggy, create a workflow where backend finds what broke from the logs while tester checks which features are down. If a deploy caused it, ask me before rolling back. Then deploy, and when I say run Code Red workflow it should run this'
  let seen = ''
  const p = await planAll(said, async () => ({ cannot: 'not the plan lane' }), () => {}, async (text) => ((seen = text), CODE_RED))
  assert.equal(p.intent, 'workflow.create')
  assert.equal(seen, said)
  assert.equal(p.steps.length, 1)
  assert.equal(p.steps[0].kind, 'workflow.create')
})

test('a bad design gets one more look, with the reason', async () => {
  const notes: (string | undefined)[] = []
  const p = await planAll('create a workflow called Oops', async () => ({ cannot: '' }), () => {}, async (_t, help) => {
    notes.push(help.correction)
    return notes.length === 1 ? { ...CODE_RED, steps: [{ ...CODE_RED.steps![0], agent: 'priya' }] } : CODE_RED
  })
  assert.equal(notes.length, 2)
  assert.match(notes[1] ?? '', /no agent called priya/)
  assert.equal(p.intent, 'workflow.create')
})

test('no name: Oggy asks, and your answer finishes the same workflow', async () => {
  const seen: string[] = []
  const design = async (text: string) => {
    seen.push(text)
    return seen.length === 1 ? { ask: 'What should I call it?' } : CODE_RED
  }
  const first = await planAll('create a workflow where backend reads the logs', async () => ({ cannot: '' }), () => {}, design)
  assert.equal(first.label, 'Question')
  const next = await planAll('call it Code Red', async () => ({ cannot: 'should not be the plan lane' }), () => {}, design)
  assert.equal(next.intent, 'workflow.create')
  assert.match(seen[1], /backend reads the logs/)
  assert.match(seen[1], /call it Code Red/)
})

test('a new description starts fresh, even with an old question still open', async () => {
  const seen: string[] = []
  const design = async (text: string) => {
    seen.push(text)
    return seen.length === 1 ? { ask: 'What should I call it?' } : CODE_RED
  }
  await planAll('create a workflow where backend reads the logs', async () => ({ cannot: '' }), () => {}, design)
  await planAll('create a workflow called Fresh where tester runs everything', async () => ({ cannot: '' }), () => {}, design)
  assert.equal(seen[1], 'create a workflow called Fresh where tester runs everything')
})

test('other things with the word workflow are left alone', async () => {
  const lane = async () => ({ cannot: 'plan lane' })
  const never = async () => {
    throw new Error('should not design')
  }
  saveWorkflow(built(), asked)
  assert.equal((await planAll('add a github actions workflow to my paytrack', lane, () => {}, never)).intent === 'workflow.create', false)
  assert.equal((await planAll('show my workflows', lane, () => {}, never)).intent, 'workflow.list')
  const run = await planAll('run Code Red workflow', lane, () => {}, never)
  assert.equal(run.intent, 'workflow.run')
  assert.equal(run.workflowName, 'Code Red')
})

test('you can say its name however it comes out', async () => {
  const lane = async () => ({ cannot: 'plan lane' })
  for (const said of ['Code Red', 'code red', 'code-red', 'codered', 'coat red']) assert.equal(findWorkflow(said)?.name, 'Code Red', said)
  assert.equal(findWorkflow('payments'), undefined)
  for (const said of ['run code red', 'run the code red workflow', 'run workflow code red', 'start Code Red workflow']) {
    assert.equal((await planAll(said, lane)).intent, 'workflow.run', said)
  }
  assert.equal((await planAll('run Code Red workflow on my portfolio', lane)).workflowProject, 'portfolio')
})

test('a run on another project changes the project everywhere it appears', () => {
  const wf = findWorkflow('Code Red')!
  const steps = workflowRunSteps(wf, 'run it', 'portfolio')
  assert.ok(steps.filter((s) => s.args?.project).every((s) => s.args?.project === 'portfolio'))
  assert.equal(steps[5].title, '@release: redeploy portfolio')
  assert.equal(workflowRunSteps(wf, 'run it'), wf.steps)
})

test('the room outline says who approves what, and wakes nobody', () => {
  const text = outline(built().steps)
  assert.match(text, /1\. Backend: find what broke in the logs/)
  assert.match(text, /only if: Did a deploy cause it\?/)
  assert.match(text, /Aymaan is asked first/)
  assert.match(text, /Rahul must approve/)
  assert.doesNotMatch(text, /@/)
})

/* ---------- running it ---------- */

/** Stands in for the agents: each job answers as told, and what it was given is kept. */
function team(replies: Record<string, string> = {}) {
  const jobs: { agent: string; prompt: string; project?: string }[] = []
  let posted: string[] = []
  TOOLBOX['agent.job'].run = async (a, ctx) => {
    jobs.push({ agent: String(a.agent), prompt: String(a.prompt), project: a.project as string })
    const line = replies[String(a.agent)] ?? 'DONE: finished'
    const body = `${line}\nDONE: finished`
    const yes = ctx.step.question ? body.match(/ANSWER:\s*(yes|no)/i)?.[1].toLowerCase() : undefined
    if (yes === 'yes' || yes === 'no') ctx.step.answer = yes
    return { status: 'done', output: `DONE: finished\n\n${body}` }
  }
  TOOLBOX['agent.job'].check = () => undefined
  TOOLBOX['room.post'].check = () => undefined
  TOOLBOX['room.post'].run = async (_a, ctx) => {
    posted = [...posted, ctx.run.label ?? '']
    return { status: 'done', output: 'Posted' }
  }
  return { jobs, posts: () => posted }
}

const until = async <T>(what: () => T | undefined | false): Promise<T> => {
  for (let i = 0; i < 400; i++) {
    const got = what()
    if (got) return got
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timed out')
}
const start = async () => {
  const run = submitCommand('run Code Red workflow', 'desktop')
  await until(() => runs.get(run.id)?.steps.length)
  return run.id
}
const waiting = (runId: string, n = 1) => until(() => {
  const list = approvals.list(true).filter((a) => a.runId === runId)
  return list.length >= n ? list[0] : undefined
})
const says = (senderName: string, sender: string, body: string) =>
  onMessage({ id: body, roomId: 'ROOM', threadId: null, sender, senderName, body, addressed: false, timestamp: Date.now() })
const statusOf = (runId: string, i: number) => runs.get(runId)!.steps[i].status

test('a deploy caused it: you are asked, Rahul approves, and the report comes last', async () => {
  const { jobs, posts } = team({ backend: 'ANSWER: yes' })
  const id = await start()
  assert.equal(runs.get(id)?.workflowId, findWorkflow('Code Red')?.id)
  assert.equal(runs.get(id)?.label, 'Code Red')

  const rollback = await waiting(id)
  assert.equal(rollback.action, 'Roll back the deploy?')
  assert.equal(jobs.filter((j) => j.prompt.startsWith('Write the fix')).length, 0, 'nothing happens before your yes')
  decideApproval(rollback.id, true, 'desktop')

  await until(() => statusOf(id, 5) === 'waiting_approval')
  const redeploy = approvals.list(true).find((a) => a.runId === id)!
  assert.deepEqual(approvals.get(redeploy.id)?.action, 'Redeploy paytrack?')

  // Only Rahul can say yes: not you, not a stranger.
  assert.deepEqual('error' in decideApproval(redeploy.id, true, 'desktop') && decideApproval(redeploy.id, true, 'desktop'), { error: 'Only Rahul can answer this.', code: 403 })
  says('stranger', '@stranger:localhost', 'yes')
  says('aymaan2218', '@aymaan:localhost', 'yes')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(runs.get(id)?.status, 'waiting_approval')

  says('rahul065935', '@rahul:localhost', 'yes')
  await until(() => runs.get(id)?.status === 'done')
  assert.deepEqual(runs.get(id)!.steps.map((s) => s.status), Array(8).fill('done'))
  assert.deepEqual(jobs.map((j) => j.agent).slice(-1), ['scout'])
  assert.match(jobs.find((j) => j.agent === 'release' && /Roll paytrack back/.test(j.prompt))?.prompt ?? '', /git revert/)
  assert.match(jobs.find((j) => j.agent === 'release' && /Ship paytrack/.test(j.prompt))?.prompt ?? '', /Approved by Rahul/)
  assert.equal(posts().length, 1)
})

test('no deploy caused it: no rollback, nobody is asked about it, and the work goes straight on', async () => {
  const { jobs } = team({ backend: 'ANSWER: no' })
  const id = await start()
  await until(() => statusOf(id, 5) === 'waiting_approval')
  assert.equal(statusOf(id, 2), 'skipped')
  assert.match(runs.get(id)!.steps[2].output ?? '', /Not needed/)
  assert.equal(jobs.some((j) => /Roll paytrack back/.test(j.prompt)), false)
  says('rahul065935', '@rahul:localhost', 'no')
  await until(() => runs.get(id)?.status === 'done')
})

test('you say no to the rollback: the workflow carries on without it', async () => {
  const { jobs } = team({ backend: 'ANSWER: yes' })
  const id = await start()
  decideApproval((await waiting(id)).id, false, 'desktop')
  await until(() => statusOf(id, 5) === 'waiting_approval')
  assert.equal(statusOf(id, 2), 'skipped')
  assert.ok(jobs.some((j) => j.prompt.startsWith('Write the fix')))
  says('rahul065935', '@rahul:localhost', 'yes')
  await until(() => runs.get(id)?.status === 'done')
})

test('Rahul says no: nothing ships, the report still gets written, and the outcome says why', async () => {
  const { jobs, posts } = team({ backend: 'ANSWER: no' })
  const before = posts().length
  const id = await start()
  await until(() => statusOf(id, 5) === 'waiting_approval')
  says('rahul065935', '@rahul:localhost', 'no')
  await until(() => runs.get(id)?.status === 'done')
  assert.equal(statusOf(id, 5), 'skipped')
  assert.equal(jobs.some((j) => /Ship paytrack/.test(j.prompt)), false)
  assert.equal(posts().length, before + 1)
  assert.match(runs.get(id)?.summary ?? '', /Not done: Redeploy paytrack\? Rahul said no/)
})

test('you can always stop a step that is someone else’s call', async () => {
  const { jobs } = team({ backend: 'ANSWER: no' })
  const id = await start()
  await until(() => statusOf(id, 5) === 'waiting_approval')
  const a = approvals.list(true).find((x) => x.runId === id)!
  assert.ok(!('error' in decideApproval(a.id, false, 'desktop')))
  await until(() => runs.get(id)?.status === 'done')
  assert.equal(statusOf(id, 5), 'skipped')
  assert.equal(jobs.some((j) => /Ship paytrack/.test(j.prompt)), false)
})

test('an agent that never answers the question: you get asked anyway', async () => {
  team({ backend: 'Could not tell from the logs.' })
  const id = await start()
  const a = await waiting(id)
  assert.equal(a.action, 'Roll back the deploy?')
  decideApproval(a.id, false, 'desktop')
  await until(() => statusOf(id, 5) === 'waiting_approval')
  says('rahul065935', '@rahul:localhost', 'no')
  await until(() => runs.get(id)?.status === 'done')
})

test('a step that needs an answer and has nobody to ask is skipped, not run', async () => {
  team({ scout: 'Unclear.' })
  const wf = saveWorkflow(
    built({
      name: 'Check',
      project: 'paytrack',
      steps: [
        { id: 'a', do: 'agent', agent: 'scout', prompt: 'Look.', after: [], question: 'Is it bad?' },
        { id: 'b', do: 'agent', agent: 'backend', prompt: 'Fix.', after: ['a'], when: { step: 'a', is: 'yes' } },
        { id: 'c', do: 'agent', agent: 'tester', prompt: 'Check.', after: ['b'] }
      ]
    }),
    'create it'
  ).workflow
  const run = submitCommand(`run ${wf.name} workflow`, 'desktop')
  await until(() => runs.get(run.id)?.status === 'done')
  assert.deepEqual(runs.get(run.id)!.steps.map((s) => s.status), ['done', 'skipped', 'done'])
})

test('each run keeps the link back to its drawing', async () => {
  team({ backend: 'ANSWER: no' })
  const id = await start()
  const wf = findWorkflow('Code Red')!
  assert.deepEqual(runs.get(id)!.steps.map((s) => s.from), wf.steps.map((s) => s.id))
  assert.equal(runs.get(id)!.steps[2].when?.step, runs.get(id)!.steps[0].id)
  assert.ok(findWorkflow('Code Red')!.lastRunAt)
  await until(() => statusOf(id, 5) === 'waiting_approval')
  says('rahul065935', '@rahul:localhost', 'no')
  await until(() => runs.get(id)?.status === 'done')
})

test('an unknown workflow says so, and the agents never hear of it', async () => {
  const { jobs } = team()
  const run = submitCommand('run Nonexistent workflow', 'desktop')
  await until(() => runs.get(run.id)?.status === 'failed')
  assert.match(runs.get(run.id)?.summary ?? '', /No saved workflow/)
  assert.equal(jobs.length, 0)
})

test('saving again under the same name replaces it', () => {
  const before = workflows.list().length
  const { updated } = saveWorkflow(built({ ...CODE_RED, description: 'Newer' }), asked)
  assert.ok(updated)
  assert.equal(workflows.list().length, before)
  assert.equal(findWorkflow('Code Red')?.description, 'Newer')
  assert.equal(findWorkflow('Code Red')?.project, 'paytrack')
})

test('a workflow that changed no files doesn’t ask for a review', async () => {
  const { reviewOf, startReview } = await import('./review.js')
  const run = { id: 'r-nothing-changed', workflowId: 'w1', command: 'run it', steps: [{ id: 's1', kind: 'agent.job', title: 'read the logs', status: 'done', args: { project: 'paytrack' }, output: 'DONE: all healthy' }] }
  await startReview(run as never)
  assert.equal(reviewOf(run.id), undefined)
})
