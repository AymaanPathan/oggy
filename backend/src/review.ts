import { branchOf, changesOf, undoChanges } from './codeWatch.js'
import { agentFor, config } from './config.js'
import { emit, log } from './events.js'
import { askAboutChanges, explainChanges } from './integrations/claudeCode.js'
import { addToRoomLog, homeRoom, logNameFor, postInThread, projectOfRoom, switchConfigured, threadOf, threadRoomOf } from './integrations/switch.js'
import type { CommandSource, FileChange, Review, ReviewAnswer, ReviewSection, Run, StepTemplate } from './shared/types.js'

/**
 * The review: after the agents finish, Oggy explains what they changed in plain words (what was
 * wrong, why, what changed, how it's tested) and waits for you. You decide by saying it ("looks
 * good", "undo", "make the message friendlier") or with a click, and can ask about any line.
 * Keep leaves the changes, undo puts the project back, a change is a follow-up job whose review
 * shows the whole change again.
 */

const reviews = new Map<string, Review>()
/** Diff text Claude reads, at most this many characters (enough for a normal fix). */
const DIFF_BUDGET = 24_000

const SECTION_TITLES: Record<ReviewSection['key'], string> = {
  wrong: 'What was wrong',
  why: 'Why it happened',
  changed: 'What changed',
  tested: "How it's tested"
}

function publish(r: Review) {
  reviews.set(r.runId, r)
  emit({ type: 'run.review', review: { ...r } })
}

/**
 * A run finished: if the agents worked on a project, explain what happened and ask. That includes
 * jobs that changed nothing ("it already exists", "here's how auth works"): you still get the
 * explanation, and can answer them.
 */
export async function startReview(run: Run) {
  const files = changesOf(run.id)
  const coded = run.steps.some((s) => s.kind === 'agent.job' && s.args?.project && s.output)
  // A workflow says what it found in its own report: with nothing to keep or undo, there's nothing to ask you.
  if ((!files.length && (!coded || run.workflowId)) || reviews.has(run.id)) return
  const continues = run.steps.map((s) => s.args?.continues).find((c): c is string => typeof c === 'string')
  const r: Review = { runId: run.id, status: 'explaining', sections: [], files: [], risks: [], continues }
  r.branch = await branchOf(run.id)
  publish(r)

  // The agents' own words: what they found, did and tested (the reply after Oggy's headline line).
  const reports = run.steps
    .filter((s) => s.kind === 'agent.job' && s.output)
    .map((s) => `${s.title}:\n${said(s.output!).slice(0, 1500)}`)
  // A change you asked for: explain the request as a whole, with your tweak.
  const original = commandOf(run.id)
  const asked = original ? `${original} — then, after reviewing it: "${run.command}"` : run.command
  try {
    const e = await explainChanges(asked, reports, diffText(files), files.map((f) => f.path))
    r.title = e.title
    r.summary = e.summary || run.summary
    r.sections = e.sections.map((s) => ({ ...s, title: SECTION_TITLES[s.key] }))
    r.files = e.files
    r.risks = e.risks
    r.tests = e.tests
  } catch (err) {
    log('warn', `Couldn't explain the changes: ${(err as Error).message}`)
    r.summary = run.summary
  }
  r.status = 'ready'
  publish(r)
}

/** A follow-up job's original request ("add a health route"), so its review explains the whole thing. */
const commands = new Map<string, string>()
const commandOf = (runId: string) => commands.get(runId)

const said = (output: string) => {
  const cut = output.indexOf('\n\n')
  return (cut >= 0 ? output.slice(cut + 2) : output).trim()
}

/** The diff for Claude, each line with its number in the file now (old number for removed lines). */
function diffText(files: FileChange[]): string {
  let text = ''
  for (const f of files) {
    const head = `\n### ${f.path} (${f.status}, +${f.added} -${f.removed})\n`
    const body = (f.hunks ?? [])
      .map((h) => {
        let a = h.oldStart
        let b = h.newStart
        return h.lines
          .map((l) => {
            const n = l.t === '-' ? a : b
            if (l.t !== '+') a++
            if (l.t !== '-') b++
            return `${String(n).padStart(4)} ${l.t} ${l.text}`
          })
          .join('\n')
      })
      .join('\n   ...\n')
    if (text.length + head.length + body.length > DIFF_BUDGET) {
      text += head + '(too long to include)\n'
      continue
    }
    text += head + body + '\n'
  }
  return text
}

/* ---------- your decision ---------- */

type Decision = { kind: 'keep' } | { kind: 'undo' } | { kind: 'change'; note: string }

/** What you said, as a decision, or nothing when it isn't one (a question, or a new command). */
export function parseDecision(text: string): Decision | undefined {
  const t = text.trim().replace(/[.!?]+$/, '')
  if (!t) return undefined
  // "no, make it red" is a change, not an undo.
  const but = t.match(/^(?:no|nope|nah)[,\s]+(?:but\s+|instead\s+)?(.{6,})$/i)
  if (but) return { kind: 'change', note: but[1] }
  if (/^(?:keep|looks good|lgtm|good|great|perfect|nice|ship it|accept|approve|yes|yeah|yep|yup|ok|okay|sure|fine|cool|do it|merge it|that'?s (?:good|great|fine|perfect))\b/i.test(t)) return { kind: 'keep' }
  if (/^(?:undo|revert|discard|reject|throw (?:it|them|this|that) (?:away|out)|roll ?back|no|nope|nah|remove (?:it|them|the changes)|cancel|put it back|go back|scrap)\b/i.test(t)) return { kind: 'undo' }
  const note = t.replace(/^change\s*:?\s*/i, '')
  if (/^(?:change|make|instead|but|also|can you|could you|please|rename|use|don'?t|do not|add|remove|fix|move|try|keep .+ but|why not|i want|it should|should)\b/i.test(t) && note) {
    return { kind: 'change', note }
  }
  return undefined
}

/** Looks like a question about the changes ("explain line 22", "why 401?", "what does this do"). */
const isQuestion = (t: string) => /\?\s*$|^(?:explain|why|what|how|where|which|is|does|did|can|could|tell me|walk me|show me why)\b/i.test(t.trim())

export interface DecideResult {
  handled: boolean
  review?: Review
  /** The follow-up job, when you asked for a change. */
  followUp?: Run
  /** The answer, when it was a question. */
  answer?: ReviewAnswer
}

/**
 * What you said (or clicked) on a review: keep, undo, a change, or (from the review screen,
 * `ask`) a question. `startFollowUp` runs a change as a new job (passed in by the runner, which owns jobs).
 */
export async function decideReview(
  run: Run,
  text: string,
  source: CommandSource,
  startFollowUp: (command: string, label: string, steps: StepTemplate[], source: CommandSource) => Run,
  ask = false
): Promise<DecideResult> {
  const r = reviews.get(run.id)
  if (!r || (r.status !== 'ready' && r.status !== 'explaining')) return { handled: false }
  const d = parseDecision(text)

  // A question (from the review screen, or anything that sounds like one): answer it, decide nothing.
  if ((!d || d.kind === 'change') && (isQuestion(text) || (ask && !d))) {
    const files = changesOf(run.id)
    const told = [r.summary, ...r.sections.map((s) => `${s.title}: ${s.text}`)].filter(Boolean).join(' ')
    try {
      const answer = await askAboutChanges(text, run.command, told, diffText(files), files.map((f) => f.path))
      return { handled: true, review: r, answer }
    } catch (err) {
      return { handled: true, review: r, answer: { text: `I couldn't answer that: ${(err as Error).message}` } }
    }
  }
  if (!d || r.status !== 'ready') return { handled: false }

  if (d.kind === 'keep') {
    r.status = 'kept'
    r.outcome = !changesOf(run.id).length
      ? 'Got it.'
      : r.branch
        ? `Kept. The changes are in your project, on ${r.branch}.`
        : 'Kept. The changes are in your project.'
    publish(r)
    log('info', `Kept the changes from “${run.command}”`)
    void remember(run, r, '✅ kept', source)
    return { handled: true, review: r }
  }

  if (d.kind === 'undo') {
    if (!changesOf(run.id).length) {
      r.outcome = 'Nothing to undo: this job changed no files.'
      publish(r)
      return { handled: true, review: r }
    }
    const u = await undoChanges(run.id)
    r.status = 'undone'
    r.outcome = u.message
    publish(r)
    void remember(run, r, '↩️ undone', source)
    return { handled: true, review: r }
  }

  // A change: the agent who wrote the code makes it, the reviewer checks it again.
  const coder = [...run.steps].reverse().find((s) => s.kind === 'agent.job' && !['reviewer', 'scout', 'tester'].includes(agentFor(s.args?.agent)?.alias ?? ''))
  const project = coder?.args?.project ?? run.steps.find((s) => s.args?.project)?.args?.project
  const agent = agentFor(coder?.args?.agent) ?? agentFor(undefined)
  if (!agent) return { handled: false }
  const prompt = [
    `Follow-up on the change you just made${project ? ` in the ${project} project` : ''} (the request was: "${commandOf(run.id) ?? run.command}").`,
    `The user reviewed it and wants: ${d.note}`,
    'Change only what this needs; keep the rest of your earlier change.'
  ].join('\n')
  // `continues`: the new job starts from the same snapshot, so its review shows the whole change.
  const steps: StepTemplate[] = [{ id: 'fix', kind: 'agent.job', title: `@${agent.alias}: ${d.note}`.slice(0, 120), args: { agent: agent.alias, project, prompt, continues: run.id } }]
  if (agentFor('reviewer')) steps.push({ id: 'check', kind: 'agent.job', title: '@reviewer: check it again', args: { agent: 'reviewer', project, continues: run.id }, after: ['fix'] })
  const next = startFollowUp(d.note, r.title ? `${r.title}: ${d.note}` : 'Change it', steps, source)
  commands.set(next.id, commandOf(run.id) ?? run.command)
  r.status = 'changing'
  r.outcome = `@${agent.alias} is updating it: ${d.note}`
  r.nextRunId = next.id
  publish(r)
  void remember(run, r, `✏️ change asked: ${d.note}`, source)
  return { handled: true, review: r, followUp: next }
}

export const reviewOf = (runId: string) => reviews.get(runId)

const VIA: Record<CommandSource, string> = { desktop: 'voice', switch: 'Discord', telegram: 'Telegram', schedule: 'its schedule' }

/**
 * Your decision goes into the room's log (see switch.ts), with what the job did, so the next job
 * there starts from it; the job's thread says so.
 */
async function remember(run: Run, r: Review, decision: string, source: CommandSource) {
  if (!switchConfigured()) return
  const roomId = threadRoomOf(run.id) ?? homeRoom(run)
  if (!roomId) return
  const name = projectOfRoom(roomId) ?? 'team'
  try {
    await addToRoomLog(roomId, name, {
      at: Date.now(),
      title: r.title || run.label || run.command,
      asked: commandOf(run.id) ? `${commandOf(run.id)}, then: ${run.command}` : run.command,
      who: `${config.owner.name} (${VIA[run.source]}), decided via ${VIA[source]}`,
      decision,
      summary: r.summary,
      files: changesOf(run.id).map((f) => f.path),
      tests: r.tests ? `${r.tests.ok ? '✓' : '✗'} ${r.tests.text}` : undefined,
      branch: r.branch ? `${r.branch} (not pushed)` : undefined,
      risks: r.risks
    })
    void postInThread(`📝 Added to ${name === 'team' ? '#team' : `#${name}`}'s ${logNameFor(roomId)}: ${decision}`, threadOf(run.id), roomId).catch(() => {})
  } catch (err) {
    log('warn', `Couldn't add the job to the room's log: ${(err as Error).message}`)
  }
}
