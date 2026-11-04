import type { AgentLive, AgentStep, Approval, Review, Run } from '@shared/types'
import { tidy, whoWhat } from './JobCard'
import type { Mood } from './Pet'

/** Worth taking over the screen for by itself. Everything else stays in the island until you ask. */
export const opensItself = (run: Run) =>
  run.steps.some((s) => s.status !== 'pending' && ((s.kind === 'agent.job' && Boolean(s.args?.project)) || s.kind === 'deploy'))

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const base = (p: string) => p.split(/[\\/]/).pop() ?? p
/** "Installing the project's packages…" reads as part of a sentence. */
const inSentence = (s: string) => {
  const t = s.replace(/[.…]+$/, '')
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t
}

/** You answered a team vote (you're first on it, if you're on it at all), and it's in the others' hands now. */
export const youVoted = (a: Approval | null) => Boolean(a?.vote && (a.vote.notYou || a.vote.answers[a.vote.voters[0]] === 'yes'))

export function moodOf(run: Run, approval: Approval | null, review: Review | null): Mood {
  if (approval || run.status === 'waiting_approval' || review?.status === 'ready' || run.label === 'Question') return 'waiting'
  if (run.status === 'done') return run.steps.some((s) => s.status === 'stubbed') ? 'waiting' : 'done'
  if (run.status === 'failed' || run.status === 'cancelled') return 'stuck'
  return 'working'
}

/** An agent's latest step as a sentence: "Frontend is editing Navbar.tsx". */
function agentSentence(name: string, step: AgentStep | undefined): { line: string; sub?: string } | undefined {
  if (!step) return undefined
  if (step.kind === 'think') return { line: `${name} is thinking it through`, sub: step.text }
  if (step.kind === 'ask') return { line: `${name} has a question for you`, sub: step.detail }
  if (step.kind === 'job') return { line: `${name} picked up the job` }
  if (step.kind === 'run') return { line: `${name} is ${inSentence(step.text)}`, sub: step.slow ?? step.detail }
  const what = step.detail ? ` ${step.kind === 'search' ? step.detail : base(step.detail)}` : ''
  return { line: `${name} is ${inSentence(step.text)}${what}`, sub: step.slow }
}

const andList = (names: string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** What's happening right now on a run, in plain words. */
export function narrate(args: {
  run: Run
  team: AgentLive[]
  stepLines: Record<string, string>
  approval: Approval | null
  review: Review | null
  changing: boolean
  /** The job's own latest line, when no step is running. */
  general?: string
}): { line: string; sub?: string } {
  const { run, team, stepLines, approval, review, changing } = args
  if (approval?.vote) {
    const waiting = approval.vote.voters.filter((n) => !approval.vote!.answers[n])
    return { line: youVoted(approval) ? `Waiting for ${waiting.join(' and ')} to say yes` : 'The team needs your vote', sub: approval.action }
  }
  if (approval) {
    const ask = approval.action.match(/^@?(\w+) wants to run: (.+?)(?:\s[—-]\s(.+))?$/)
    if (ask) return { line: `${cap(ask[1])} wants to ${inSentence(ask[3] ?? 'run a command')}`, sub: ask[2] }
    return { line: 'This one needs your OK', sub: approval.action }
  }
  if (changing) return { line: 'Making the change you asked for' }
  if (review?.status === 'explaining') return { line: 'Reading what the team did' }
  if (run.status === 'failed') return { line: 'This hit a problem', sub: run.summary }
  if (run.status === 'cancelled') return { line: 'Stopped', sub: run.summary }
  if (run.status === 'done') return { line: run.steps.some((s) => s.status === 'stubbed') ? 'Finished, but not deployed' : run.label === 'Question' ? 'One quick question' : 'All done', sub: run.summary }

  const running = run.steps.filter((s) => s.status === 'running')
  const agents = running.filter((s) => s.kind === 'agent.job')
  if (agents.length > 1) return { line: `${andList(agents.map((s) => cap(whoWhat(s).who ?? 'Someone')))} are working side by side` }
  const step = running[0]
  if (!step) return { line: args.general?.replace(/[.…]+$/, '') || (run.steps.length ? 'Getting the next step ready' : 'Working out what you need') }
  const { who, what } = whoWhat(step)
  if (who) {
    const live = team.find((a) => a.alias === who && (a.since ?? 0) >= run.createdAt - 5000)
    return agentSentence(cap(who), live?.steps.at(-1)) ?? { line: `${cap(who)} is on it`, sub: cap(what) }
  }
  const said = tidy(stepLines[step.id], who).replace(/[.…]+$/, '')
  return { line: said || step.title }
}
