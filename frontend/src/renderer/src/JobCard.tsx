import { useEffect, useState } from 'react'
import { isEveryday } from '@shared/everyday'
import type { Approval, FileChange, PlanStep, Review, Run } from '@shared/types'
import { youVoted } from './scene'

export interface ActivityLine {
  id: number
  text: string
}

const isFinished = (run: Run) => run.status === 'done' || run.status === 'failed' || run.status === 'cancelled'

export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One second ticks while a job runs. */
export function useNow(running: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  return now
}

export function headline(run: Run): string {
  switch (run.status) {
    case 'done':
      // The plan lane asked something back; your next words answer it.
      return run.label === 'Question' ? 'Quick question' : 'Done'
    case 'failed':
    case 'cancelled':
      return 'Stuck'
    case 'waiting_approval':
      return 'Needs your OK'
    default:
      return run.steps.length ? 'Working' : 'Understanding…'
  }
}

/** What this job is, e.g. "Open in VS Code + Start dev server". */
export const describe = (run: Run) => (run.label && !['Not understood', 'Question'].includes(run.label) ? run.label : run.command)

/** The kind of job, as a word in the island: Quick, Quick fix, Team job, Ship, Question. */
export function modeOf(run: Run): { label: string; tone: string } {
  if (run.label === 'Question') return { label: 'Question', tone: 'blue' }
  if (run.steps.some((s) => s.kind === 'deploy')) return { label: 'Ship', tone: 'violet' }
  const agents = new Set(run.steps.filter((s) => s.kind === 'agent.job').map((s) => String(s.args?.agent ?? '')))
  if (agents.size > 1) return { label: 'Team job', tone: 'amber' }
  if (agents.size === 1) return { label: 'Quick fix', tone: 'green' }
  if (run.intent === 'plan') return { label: 'Plan', tone: 'blue' }
  return { label: 'Quick', tone: 'muted' }
}

/** The project a job worked on ("react-flow"), if any. */
export const projectOf = (run: Run) => run.steps.map((s) => s.args?.project).find((p): p is string => typeof p === 'string' && p !== '')

/** The two kinds of work: coding, and everyday things on your computer. */
export type Space = 'code' | 'daily'

/**
 * Which one a job is, by the rule that picks its room (isCoding in the backend's switch.ts), plus a
 * coding job that stopped to ask which project. Null while it's still being planned: it could be either.
 */
export function spaceOf(run: Run): Space | null {
  if (!run.steps.length && !isFinished(run)) return null
  // The assistant's work on your day is everyday, like the backend's rule.
  if (isEveryday(run.steps)) return 'daily'
  const coding = /^(project|code|delegate|deploy)/.test(run.intent) || run.steps.some((s) => s.kind === 'agent.job' || s.kind === 'deploy' || typeof s.args?.project === 'string')
  return coding ? 'code' : 'daily'
}

/** "@backend: add GET /health route" -> who "backend", what "add GET /health route". */
export function whoWhat(s: PlanStep): { who?: string; what: string } {
  const m = s.title.match(/^@(\w+):?\s*(.*)$/)
  return m ? { who: m[1], what: m[2] || 'on it' } : { what: s.title }
}

/** A step's live line, without repeating who it is ("@backend: running tests" -> "running tests"). */
export const tidy = (line: string | undefined, who?: string) => (line ? line.replace(who ? new RegExp(`^@?${who}:?\\s*`, 'i') : /^@\w+:?\s*/, '').replace(/^›\s*/, '') : '')

/** An agent's own reply, without Oggy's one-line headline above it (see agent.job in the backend). */
export function agentSaid(output = '') {
  const cut = output.indexOf('\n\n')
  return (cut >= 0 ? output.slice(cut + 2) : output).trim()
}

/** The job has a workspace to open: anything with steps can be shown. */
export const hasWorkspace = (run: Run, changes: FileChange[]) => changes.length > 0 || run.steps.length > 0

/** A step on the rail: a dot that's empty, lit, or finished. */
export function StepNode({ status }: { status: PlanStep['status'] }) {
  if (status === 'done' || status === 'failed')
    return (
      <span className={`nd is-${status === 'failed' ? 'bad' : 'ok'}`}>
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d={status === 'failed' ? 'M5.5 5.5l5 5M10.5 5.5l-5 5' : 'M4.5 8.3l2.4 2.4 4.6-5.2'} />
        </svg>
      </span>
    )
  return <span className={`nd is-${status === 'running' ? 'now' : status === 'waiting_approval' ? 'wait' : status === 'skipped' ? 'skip' : 'next'}`} />
}

/** What the island shows when it's small: what this is, and what's happening this second. */
export function JobLine({ run, live, project, title }: { run: Run; live?: string; project?: string; title?: string }) {
  const sub = live ? `${headline(run) === 'Working' ? '' : `${headline(run)} · `}${live}` : headline(run)
  return (
    <span className="jl">
      <span className="jl-what">
        {project && <span className="jl-project">{project}</span>}
        {title || describe(run)}
      </span>
      <span key={sub} className="jl-live settle">
        {sub}
      </span>
    </span>
  )
}

/** What the island shows when it opens: the steps, the result, and whatever needs you. */
export function JobPanel(props: {
  run: Run
  approval: Approval | null
  changes: FileChange[]
  review: Review | null
  stepLines: Record<string, string>
  said?: string
  general?: string
  onDecide: (approve: boolean) => void
  /** Your decision on the changes, as you'd say it ("keep", "undo"). */
  onReview: (text: string) => void
  onShowMe: () => void
  /** A next step from a button, sent as if you'd said it ("open my react-flow in vs code"). */
  onCommand: (text: string) => void
}) {
  const { run, approval, changes, review } = props
  const finished = isFinished(run)
  // Done with a project (made it, changed it): one click opens it in VS Code, unless that's what this job did.
  const project = projectOf(run)
  const canOpen = run.status === 'done' && Boolean(project) && !run.steps.some((s) => s.kind === 'project.code')
  /** The agent step whose report is open. */
  const [reading, setReading] = useState<string | null>(null)

  const added = changes.reduce((n, f) => n + f.added, 0)
  const removed = changes.reduce((n, f) => n + f.removed, 0)
  const files = `${changes.length} file${changes.length === 1 ? '' : 's'}`
  const deciding = finished && changes.length > 0 && (!review || review.status === 'explaining' || review.status === 'ready')
  const hint =
    review?.status !== 'ready'
      ? props.said
      : run.status === 'failed'
        ? 'Answer by voice, like “use the branch feat/ping”.'
        : undefined

  return (
    <div className="jp" role="status" aria-live="polite">
      {run.steps.length > 0 && (
        <ol className="jp-steps">
          {run.steps.map((s) => {
            const { who, what } = whoWhat(s)
            const said = s.kind === 'agent.job' && s.status !== 'running' ? agentSaid(s.output) : ''
            const live = s.status === 'running' || s.status === 'failed' ? tidy(props.stepLines[s.id], who) : ''
            const row = (
              <>
                <StepNode status={s.status} />
                <span className="jp-step-text">
                  {who && <b>{who}</b>}
                  {what}
                </span>
                {said && <span className="jp-more">{reading === s.id ? 'Hide' : 'Why?'}</span>}
              </>
            )
            return (
              <li key={s.id} className={`jp-step is-${s.status}`}>
                {said ? (
                  <button className="jp-step-row" onClick={() => setReading((r) => (r === s.id ? null : s.id))} aria-expanded={reading === s.id}>
                    {row}
                  </button>
                ) : (
                  <span className="jp-step-row">{row}</span>
                )}
                {live && (
                  <p key={live} className="jp-live settle">
                    {live}
                  </p>
                )}
                {reading === s.id && said && <p className="jp-said settle">{said}</p>}
              </li>
            )
          })}
        </ol>
      )}

      {props.general && (
        <p key={props.general} className="jp-general settle">
          {props.general}
        </p>
      )}

      {/* While they work: what's changing, one line. */}
      {changes.length > 0 && !finished && (
        <button className="jp-changing" onClick={props.onShowMe}>
          <span>
            Changing {files} <span className="n-add">+{added}</span> <span className="n-del">−{removed}</span>
          </span>
          <span className="jp-link">Show me</span>
        </button>
      )}

      {/* Done: the result, and your call. */}
      {finished && changes.length > 0 && (
        <div className="jp-result settle">
          <p className="jp-facts">
            {files} <span className="n-add">+{added}</span> <span className="n-del">−{removed}</span>
            {review?.tests && <span className={review.tests.ok ? 'is-ok' : 'is-bad'}> · {review.tests.text}</span>}
            {review && review.risks.length > 0 && review.status === 'ready' && (
              <span className="is-warn">
                {' '}
                · {review.risks.length} to check
              </span>
            )}
          </p>
          {review?.status === 'explaining' && <p className="jp-sum is-loading">Reading the changes…</p>}
          {review?.summary && review.status !== 'kept' && review.status !== 'undone' && <p className="jp-sum">{review.summary}</p>}
          {review?.outcome && <p className={`jp-outcome is-${review.status}`}>{review.outcome}</p>}
          {deciding && (
            <div className="jp-actions">
              <button className="btn is-primary" disabled={review?.status !== 'ready'} onClick={() => props.onReview('keep')}>
                Looks good
              </button>
              <button className="btn" onClick={props.onShowMe}>
                Show me
              </button>
              <button className="btn is-quiet is-danger" disabled={review?.status !== 'ready'} onClick={() => props.onReview('undo')}>
                Undo
              </button>
            </div>
          )}
        </div>
      )}

      {approval && !youVoted(approval) && (
        <div className="jp-ask settle">
          <p>{approval.action}?</p>
          <div className="jp-actions">
            <button className="btn is-primary" onClick={() => props.onDecide(true)}>
              {approval.vote ? 'Yes' : 'Allow'}
            </button>
            <button className="btn is-quiet" onClick={() => props.onDecide(false)}>
              Not now
            </button>
          </div>
        </div>
      )}

      {finished && run.summary && !changes.length && <p className="jp-sum">{run.summary}</p>}
      {hint && <p className="jp-voice">{hint}</p>}

      {!deciding && !approval && (hasWorkspace(run, changes) || canOpen) && (
        <div className="jp-actions is-foot">
          {canOpen && (
            <button className="btn is-primary" onClick={() => props.onCommand(`open my ${project} in vs code`)}>
              Open in VS Code
            </button>
          )}
          {hasWorkspace(run, changes) && (
            <button className="btn" onClick={props.onShowMe} title="Open the workspace (or say “show me”)">
              Workspace
            </button>
          )}
        </div>
      )}
    </div>
  )
}
