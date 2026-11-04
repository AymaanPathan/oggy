import { stopWatch } from './codeWatch.js'
import { agentFor, config } from './config.js'
import { approvals, memory, newId, runs } from './db.js'
import { activity, emit, log, show } from './events.js'
import { gate } from './gate.js'
import { designWorkflow, planWithClaude } from './integrations/claudeCode.js'
import { castVote, openVote, outcome, voteOf } from './team.js'
import { recordTrace } from './trace.js'
import { homeRoom, isCoding, openThread, postInThread, postToRoom, projectOfRoom, switchConfigured, threadOf, threadRoomOf } from './integrations/switch.js'
import { notifyOwner, requestApprovalOnPhone } from './integrations/telegram.js'
import { findWorkflow, labelFor, planAll, PLANNABLE, workflowRunSteps } from './planner.js'
import { startReview } from './review.js'
import type { Approval, CommandSource, PlanStep, Run, StepTemplate } from './shared/types.js'
import { describeToolbox, TOOLBOX, upgradeStep, type ToolOutcome } from './toolbox.js'
import { outline, touchWorkflow } from './workflow.js'

/**
 * The runner: plans a command, then runs its steps one by one.
 * Each step goes through the safety gate (gate.ts) and then its toolbox tool (toolbox.ts).
 */

/** Fresh steps for a run. Each gets a new id, and "after" links follow them. */
function fromTemplates(templates: StepTemplate[]): PlanStep[] {
  const ids = new Map<string, string>(templates.map((t) => [t.id, newId()]))
  return templates.map((t) => ({
    ...upgradeStep(t),
    id: ids.get(t.id)!,
    from: t.id,
    after: t.after?.map((a) => ids.get(a)).filter((a): a is string => Boolean(a)),
    when: t.when && { ...t.when, step: ids.get(t.when.step) ?? t.when.step },
    status: 'pending'
  }))
}

function save(run: Run) {
  runs.save(run)
  emit({ type: 'run.updated', run })
}

/** Record the command right away (so the voice box can show "Sent"), then plan and execute it. */
export function submitCommand(command: string, source: CommandSource, requestedBy?: string): Run {
  const now = Date.now()
  const run: Run = { id: newId(), command, source, requestedBy, intent: 'unknown', status: 'planned', steps: [], createdAt: now, updatedAt: now }
  save(run)
  start(run).catch((err) => finish(run, 'failed', `Oggy error: ${(err as Error).message}`))
  return run
}

/**
 * Your words go into the job's home room, so the room sees what you asked for: coding opens the job's
 * thread in its project's room or #team (everything about it goes there), everyday things go in #oggy-daily.
 * From a room, your own message already is that.
 */
async function announce(run: Run) {
  if (!switchConfigured() || run.source === 'switch') return
  const via = run.source === 'desktop' ? 'voice' : run.source === 'schedule' ? 'on schedule' : run.source
  const text = `${config.owner.name} (${via}): ${run.command}`
  try {
    if (isCoding(run) || run.steps.some((s) => s.kind === 'agent.job')) {
      // Its project's room once it has one, else #team; the assistant's work in #oggy-daily.
      const room = homeRoom(run)
      const where = room === config.switch.rooms.team ? '#team' : room === config.switch.rooms.oggyDaily ? '#oggy-daily' : `#${projectOfRoom(room) ?? 'its room'}`
      const thread = await openThread(run.id, text, room)
      activity(run.id, thread ? `Opened a thread in ${where}` : `Posted in ${where}`)
    } else if (config.switch.rooms.oggyDaily) {
      await postToRoom(text, config.switch.rooms.oggyDaily)
      activity(run.id, 'Posted in #oggy-daily')
    }
  } catch (err) {
    log('warn', `Could not post your command to the room: ${(err as Error).message}`)
  }
}

async function start(run: Run) {
  // Keywords first, part by part ("… and start the server"); anything new goes to Claude's plan lane.
  const toolbox = describeToolbox().filter((t) => PLANNABLE.includes(t.name))
  const p = await planAll(run.command, (command, catalog, help) => planWithClaude(command, toolbox, catalog, help), (text) => activity(run.id, text), designWorkflow)
  if (p.intent === 'plan') log('info', `Claude planned “${run.command}” in ${p.steps.length} step(s)`)

  let steps = fromTemplates(p.steps)
  if (p.intent === 'workflow.run') {
    const wf = findWorkflow(p.workflowName)
    if (wf) {
      steps = fromTemplates(workflowRunSteps(wf, run.command, p.workflowProject))
      touchWorkflow(wf.id)
      run.workflowId = wf.id
      p.label = wf.name
    } else {
      steps = fromTemplates([{ id: 'missing', kind: 'note', title: 'Workflow not found', args: { message: `No saved workflow named “${p.workflowName}”.`, fail: true } }])
    }
  }

  run.intent = p.intent
  run.label = labelFor(p)
  run.steps = steps
  save(run)
  log('info', `Planned ${run.intent} with ${steps.length} step(s): ${run.command}`)
  // Once the plan says where it belongs, and before any agent starts (they work in its thread).
  await announce(run)
  if (run.workflowId) await tellThread(run, `▶️ **${run.label}**\n${outline(run.steps)}`)
  void execute(run.id)
}

/** A line in the job's thread, for the people following it there. */
async function tellThread(run: Run, text: string) {
  if (!switchConfigured()) return
  await postInThread(text, threadOf(run.id), threadRoomOf(run.id) ?? homeRoom(run)).catch((err) => log('warn', `Could not post in the job's thread: ${(err as Error).message}`))
}

/** A job whose steps are already known (a change you asked for in a review): no planning, straight to work. */
export function runPlanned(command: string, label: string, templates: StepTemplate[], source: CommandSource): Run {
  const now = Date.now()
  const run: Run = { id: newId(), command, source, intent: 'plan', label, status: 'planned', steps: fromTemplates(templates), createdAt: now, updatedAt: now }
  save(run)
  void execute(run.id)
  return run
}

/** Yes or no to a waiting approval (desktop, voice, or a reply in a room), then carry on. */
export function decideApproval(id: string, approve: boolean, via: CommandSource, voter = config.owner.name): Approval | { error: string; code: number } {
  const current = approvals.get(id)
  if (!current) return { error: 'not found', code: 404 }
  if (current.status !== 'pending') return { error: `already ${current.status}`, code: 409 }
  // A team vote: this is one person's answer, and it's decided once everyone agrees or someone says no.
  if (voteOf(id)) {
    // Saying the same thing twice changes nothing, so the room doesn't hear it twice.
    const earlier = voteOf(id)!
    if (earlier.answers[voter] === (approve ? 'yes' : 'no')) return { ...current, vote: earlier }
    // Asked of someone else: you can't say yes for them, but it's your job, so you can always stop it.
    const yours = voter === config.owner.name && !approve && !earlier.voters.includes(voter)
    if (!yours) {
      const vote = castVote(id, voter, approve)
      if (!vote) return { error: `Only ${earlier.voters.join(' and ')} can answer this.`, code: 403 }
      emit({ type: 'approval.vote', approval: { ...current, vote }, voter, yes: approve })
      const result = outcome(vote)
      if (!result) return { ...current, vote }
      approve = result === 'approved'
    }
  }
  const decided = { ...approvals.decide(current.id, approve, via)!, vote: voteOf(id) }
  emit({ type: 'approval.decided', approval: decided })
  log('info', `${decided.status === 'approved' ? 'Approved' : 'Rejected'} via ${via}: ${decided.action}`)
  void execute(decided.runId)
  return decided
}

/** Runs whose loop is active, and how to wake each one early (an approval came in mid-run). */
const running = new Set<string>()
const kicks = new Map<string, () => void>()

const settled = (s: PlanStep) => s.status === 'done' || s.status === 'stubbed' || s.status === 'skipped'

/** What a step waits for: its `after` ids, else the step before it (plain one-after-another). */
function waitsFor(run: Run, step: PlanStep): string[] {
  if (step.after) return step.after
  const i = run.steps.indexOf(step)
  return i > 0 ? [run.steps[i - 1].id] : []
}

type Stop = { status: Run['status']; summary: string }

/** Does a step's `when` hold? An agent that didn't say goes to whoever is asked next; with nobody to ask, it doesn't run. */
function wanted(run: Run, step: PlanStep): boolean {
  if (!step.when) return true
  const dep = run.steps.find((s) => s.id === step.when!.step)
  return dep?.answer ? dep.answer === step.when.is : Boolean(step.ask && dep?.status === 'done')
}

/**
 * The safety gate for one step that's ready: 'run' it, 'wait' for your yes, or stop the run.
 * Checked again after a yes, because files can change while the question waits.
 */
function admit(run: Run, step: PlanStep): 'run' | 'wait' | 'skipped' | Stop {
  if (step.status === 'pending' && !wanted(run, step)) {
    const dep = run.steps.find((s) => s.id === step.when!.step)
    step.status = 'skipped'
    step.output = `Not needed. ${dep?.question ?? ''} ${dep?.answer ?? 'No answer'}.`.trim()
    activity(run.id, `Skipped: ${step.title}`, step.id)
    void tellThread(run, `⏭️ Skipped: ${step.title.replace(/^@\w+:\s*/, '')}. ${step.output}`.replace(/@(?=\w)/g, ''))
    return 'skipped'
  }
  const verdict = gate(run, step)
  if (!verdict.allowed) {
    step.status = 'failed'
    step.output = `Safety gate: ${verdict.reason}`
    log('warn', `Safety gate stopped “${step.title}”: ${verdict.reason}`)
    return { status: 'failed', summary: `Stopped before “${step.title}”: ${verdict.reason}` }
  }
  // You already saw this step in the plan and said go: one yes covers the whole plan.
  // Never one that needs the whole team: that vote happens when the work is done.
  // A workflow says who decides this step, and that replaces the whole team's vote.
  const ask = step.ask
  const teamVote = !ask && Boolean(TOOLBOX[step.kind].teamVote)
  const coveredByPlan = !ask && !teamVote && !step.args?.plan && run.steps.some((s) => s.args?.plan === true && s.status === 'done')
  if ((!verdict.risky && !ask) || coveredByPlan) return 'run'

  const existing = approvals.forStep(run.id, step.id)
  if (!existing) {
    const action = ask?.question ?? verdict.preview
    const a = approvals.create(run.id, step.id, action)
    const vote = ask?.who.length ? openVote(a.id, ask.who) : teamVote ? openVote(a.id) : undefined
    step.status = 'waiting_approval'
    run.status = 'waiting_approval'
    save(run)
    emit({ type: 'approval.requested', approval: { ...a, vote } })
    activity(run.id, ask?.who.length ? `Waiting for ${ask.who.join(' and ')}: ${action}` : vote ? `Waiting for the team's vote: ${action}` : `Waiting for your OK: ${action}`)
    spoken(run, `${(ask?.question ?? (step.args?.plan ? run.label ?? 'Go' : step.title)).replace(/[.?!]+$/, '')}?`)
    void requestApprovalOnPhone(a)
    return 'wait'
  }
  if (existing.status === 'pending') return 'wait'
  if (existing.status === 'rejected') {
    step.status = 'skipped'
    const no = Object.entries(voteOf(existing.id)?.answers ?? {}).find(([, a]) => a === 'no')?.[0]
    step.output = no ? `${no} said no.` : 'Rejected by you.'
    if (step.ask?.ifNo === 'continue') {
      void tellThread(run, `⏭️ Going on without it: ${step.ask.question} ${step.output}`.replace(/@(?=\w)/g, ''))
      return 'skipped'
    }
    return { status: 'cancelled', summary: no ? `Stopped: ${no} said no to “${step.title}”.` : `Stopped: you rejected “${step.title}”.` }
  }
  return 'run'
}

/**
 * Run a plan. Every step whose waits are done starts right away, so independent jobs
 * (@frontend and @backend after @scout) work at the same time. A step that fails stops new
 * ones from starting; the ones already working finish, then the run reports who got stuck.
 */
export async function execute(runId: string) {
  if (running.has(runId)) return kicks.get(runId)?.()
  running.add(runId)
  try {
    const run = runs.get(runId)
    if (!run || run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') return
    run.steps = run.steps.map(upgradeStep) // runs saved before the toolbox
    run.status = 'running'
    save(run)

    const working = new Map<string, Promise<void>>()
    let stop: Stop | undefined
    for (;;) {
      // A skipped step may free the ones waiting on it: look again before deciding nothing's left.
      let moved = false
      if (!stop) {
        for (const step of run.steps) {
          if ((step.status !== 'pending' && step.status !== 'waiting_approval') || working.has(step.id)) continue
          const ready = waitsFor(run, step).every((id) => {
            const dep = run.steps.find((s) => s.id === id)
            return !dep || settled(dep)
          })
          if (!ready) continue
          const decision = admit(run, step)
          if (decision === 'wait') continue
          if (decision === 'skipped') {
            moved = true
            save(run)
            continue
          }
          if (decision !== 'run') {
            stop = decision
            break
          }
          step.status = 'running'
          step.startedAt = Date.now()
          run.status = 'running'
          save(run)
          activity(run.id, TOOLBOX[step.kind].line?.(step.args ?? {}) ?? step.title, step.id)
          working.set(
            step.id,
            runStep(run, step).then((result) => {
              step.status = result.status
              step.output = result.output
              step.endedAt = Date.now()
              save(run)
              if (result.undo?.length) memory.set('undo.last', JSON.stringify({ title: step.title, ops: result.undo, at: Date.now() }))
              if (result.status === 'failed') {
                // Tell you straight away, even while other agents are still working.
                activity(run.id, firstLine(result.output), step.id)
                if (step.kind === 'agent.job') spoken(run, firstLine(result.output).split(/[.:]/)[0])
                stop ??= { status: 'failed', summary: `Failed at “${step.title}”. ${firstLine(result.output)}` }
              }
              working.delete(step.id)
            })
          )
        }
      }
      if (moved) continue
      if (!working.size) break
      await Promise.race([...working.values(), new Promise<void>((wake) => kicks.set(runId, wake))])
    }
    kicks.delete(runId)

    if (stop) return finish(run, stop.status, stop.summary)
    if (run.steps.some((s) => s.status === 'waiting_approval')) {
      run.status = 'waiting_approval'
      return save(run)
    }
    const stranded = run.steps.filter((s) => s.status === 'pending')
    if (stranded.length) return finish(run, 'failed', `“${stranded[0].title}” waits for a step that never ran.`)

    const stubbed = run.steps.filter((s) => s.status === 'stubbed').length
    // Lead with what the last coder says it did ("DONE: added a dark mode toggle").
    const coded = run.steps.filter((s) => s.kind === 'agent.job' && agentFor(s.args?.agent)?.alias !== 'reviewer' && s.status === 'done').pop()
    const did = firstLine(coded?.output).replace(/^DONE:\s*/i, '').replace(/[.!\s]+$/, '')
    // What the planner couldn't do is a footnote, never the headline over what it did.
    const leftOut = run.steps.find((s) => s.kind === 'note' && s.title === "Couldn't do all of it")
    const lastDone = run.steps.filter((s) => s.status === 'done' && s !== leftOut).pop()
    // A few short lines (one per server, say) are all the news; a long output gets its first line.
    const lines = (lastDone?.output ?? '').split('\n').filter(Boolean)
    const news = lines.length <= 3 ? lines.join(' ') : firstLine(lastDone?.output)
    const done = did ? `${did.charAt(0).toUpperCase()}${did.slice(1)}.` : news || 'All steps finished.'
    const base = leftOut?.output ? `${done} Couldn't do: ${leftOut.output}` : done
    // A step someone turned down is part of the outcome, whatever came after it.
    const refused = run.steps.filter((s) => s.ask && s.status === 'skipped' && s.output && !s.output.startsWith('Not needed')).map((s) => `Not done: ${s.ask!.question} ${s.output}`).join(' ')
    const told = refused ? `${refused} ${base}` : base
    finish(run, 'done', stubbed ? `Not deployed: ${run.steps.filter((s) => s.status === 'stubbed').map((s) => s.title).join(', ')} isn't connected yet, so that step did nothing. ${told}` : told)
  } catch (err) {
    const run = runs.get(runId)
    if (run) finish(run, 'failed', `Oggy error: ${(err as Error).message}`)
  } finally {
    kicks.delete(runId)
    running.delete(runId)
  }
}

/**
 * At startup: jobs the last backend was in the middle of can't carry on (whatever they were waiting
 * for, an agent's DONE or your yes, was only in that backend's memory). Say so, instead of "running"
 * forever, and close their questions so a later "yes" can't approve a job that's gone.
 */
export function closeInterrupted(): number {
  const cut = runs.list(200).filter((r) => r.status === 'planned' || r.status === 'running' || r.status === 'waiting_approval')
  for (const run of cut) {
    for (const a of approvals.list(true).filter((a) => a.runId === run.id)) approvals.decide(a.id, false, 'desktop')
    for (const s of run.steps) if (s.status === 'running' || s.status === 'waiting_approval') s.status = 'failed'
    finish(run, 'failed', 'Stopped: Oggy restarted while this was running. Ask again to redo it.', { review: false })
  }
  if (cut.length) log('warn', `Oggy restarted mid-way through ${cut.length} job(s); marked them stopped`)
  return cut.length
}

function finish(run: Run, status: Run['status'], summary: string, { review = true } = {}) {
  // The agents changed code: show it, explain it, and let you decide (not for a job cut off by a restart).
  void stopWatch(run.id).then(() => (review ? startReview(run) : undefined))
  for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
  run.status = status
  run.summary = summary
  save(run)
  log(status === 'done' ? 'info' : 'warn', summary)
  void notifyOwner(summary)
}

const firstLine = (s = '') => s.split('\n').find((l) => l.trim()) ?? ''

/**
 * A short caption when Oggy needs you,
 * never when a task finishes (the bar already shows that), and only for commands from this computer.
 */
function spoken(run: Run, text: string) {
  if (!text || run.source !== 'desktop') return
  show(run.id, { kind: 'say', text })
}

/** Output lines for the live view, at most ~4 a second so a noisy build doesn't flood it. */
function liveLines(runId: string, stepId?: string) {
  let last = 0
  let pending: string | undefined
  let timer: NodeJS.Timeout | undefined
  return (line: string) => {
    pending = line
    const wait = 250 - (Date.now() - last)
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      last = Date.now()
      if (pending) activity(runId, pending, stepId)
    }, Math.max(0, wait))
  }
}

async function runStep(run: Run, step: PlanStep): Promise<ToolOutcome> {
  try {
    return await TOOLBOX[step.kind].run(step.args ?? {}, {
      run,
      step,
      say: (text) => activity(run.id, text, step.id),
      stream: liveLines(run.id, step.id),
      show: (effect) => show(run.id, effect),
      trace: (entry) => recordTrace(run.id, { ...entry, stepId: step.id })
    })
  } catch (err) {
    return { status: 'failed', output: (err as Error).message }
  }
}
