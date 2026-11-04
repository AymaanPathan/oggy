import { useMemo } from 'react'
import { nextRun, scheduleText } from '@shared/everyday'
import type { Approval, Run, TraceEntry, Workflow } from '@shared/types'
import { agentSaid, clock, StepNode, tidy, whoWhat } from './JobCard'
import { Pet } from './Pet'
import type { RunLive } from './store'
import { I, Icon, Spinner } from './ui'

/**
 * Everyday workflows: routines the assistant runs on your day (mail, calendar, Notion). They're
 * managed apart from coding: what's coming up and what each one found, not branches and diffs.
 */

export const isOver = (r: Run) => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled'

export function runWords(run: Run) {
  if (run.status === 'done') return { cls: 'is-ok', text: 'Done' }
  if (run.status === 'failed') return { cls: 'is-bad', text: 'Failed' }
  if (run.status === 'cancelled') return { cls: '', text: 'Stopped' }
  return run.status === 'waiting_approval' ? { cls: 'is-you', text: 'Waiting' } : { cls: 'is-working', text: 'Running' }
}

export const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** "14:05" today, "Nov 2, 14:05" before. */
export const when = (t: number) => {
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString() ? hhmm(t) : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hhmm(t)}`
}

/** "Today", "Tomorrow", or the weekday. */
function dayWord(t: number, now: number) {
  const d = new Date(t)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(today.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'long' })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** What the assistant found: its report, without the lines meant for Oggy. */
function reportOf(run: Run, live: RunLive): string {
  const said = live.trace.filter((e) => e.id.startsWith('answer-')).at(-1)?.text
  const job = [...run.steps].reverse().find((s) => s.kind === 'agent.job' && s.output)
  const text = said ?? agentSaid(job?.output)
  return text
    .split('\n')
    .filter((l) => !/^[\s*_`>]*(DONE|BLOCKED|ANSWER)\b:?/i.test(l))
    .join('\n')
    .trim()
}

/** What a routine made, from what it did (live) or from its report (any time later). */
interface Made {
  todos: string[]
  page?: string
  drafts: string[]
  events: string[]
  /** The rest of the report, in its own words. */
  note: string
}

const LINE = { todo: /^\s*[-*]\s*\[[ xX]?\]\s+(.+)$/, draft: /^\s*[-*]\s*✉️?\s*(?:Draft:\s*)?(.+)$/u, event: /^\s*[-*]\s*📅\s*(.+)$/u }

export function madeOf(report: string, trace: TraceEntry[] = []): Made {
  const lines = report.split('\n')
  const pick = (re: RegExp) => lines.map((l) => l.match(re)?.[1]?.trim()).filter((x): x is string => Boolean(x))
  const fromTrace = (kind: TraceEntry['kind'], text?: RegExp) => trace.filter((t) => t.kind === kind && (!text || text.test(t.text)))
  const wrote = fromTrace('todo')
  const todos = wrote.length ? [...new Set(wrote.flatMap((t) => t.items ?? []))] : pick(LINE.todo)
  const drafts = pick(/^\s*[-*]\s*✉️\s*(.+)$/u)
  const events = pick(LINE.event)
  const page = wrote.find((t) => t.detail)?.detail ?? report.match(/\*\*([^*\n]{1,60})\*\*/)?.[1]
  const note = lines
    .filter((l) => !LINE.todo.test(l) && !/^\s*[-*]\s*(✉️|📅)/u.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return {
    todos,
    page,
    drafts: drafts.length ? drafts : fromTrace('draft').map((t) => t.detail ?? 'A draft'),
    events: events.length ? events : fromTrace('calendar', /^Adding/).map((t) => t.detail ?? 'An event'),
    note
  }
}

/** "3 to-dos · 1 draft", for a run in a list. */
const madeOfRun = (r: Run) => madeOf(agentSaid([...r.steps].reverse().find((s) => s.kind === 'agent.job' && s.output)?.output))

export function madeLine(m: Made): string {
  return [m.todos.length && plural(m.todos.length, 'to-do'), m.drafts.length && plural(m.drafts.length, 'draft'), m.events.length && plural(m.events.length, 'event')].filter(Boolean).join(' · ')
}

/* ---------- what it's doing right now: a scene per kind of work ---------- */

type Scene = 'mail' | 'notes' | 'todo' | 'calendar' | 'draft' | 'post' | 'think'
const SCENES: Record<string, Scene> = { mail: 'mail', notes: 'notes', todo: 'todo', calendar: 'calendar', draft: 'draft', post: 'post' }

const ENVELOPE = 'M2.5 4h11v8h-11zM2.5 4.5L8 8.5l5.5-4'

/** Reading mail looks like mail coming in; writing to-dos looks like a list filling up. Calm, and never flashing. */
function Stage({ trace }: { trace: TraceEntry[] }) {
  const work = trace.filter((t) => t.kind !== 'say')
  const now = work.at(-1)
  const scene: Scene = (now && SCENES[now.kind]) || 'think'
  const opened = work.filter((t) => t.kind === 'mail' && /^Opening/.test(t.text)).length
  const items = scene === 'todo' ? (now?.items ?? []) : []
  const caption =
    scene === 'mail'
      ? opened
        ? `Reading your mail · ${plural(opened, 'email')} opened`
        : 'Reading your mail'
      : scene === 'think'
        ? 'Thinking it through'
        : (now?.text ?? '')
  return (
    <section className={`ev-stage is-${scene}`} aria-live="polite">
      <div className="ev-stage-art" key={scene + (now?.id ?? '')}>
        {scene === 'mail' && (
          <div className="sc-mail">
            {[0, 1, 2].map((i) => (
              <svg key={i} viewBox="0 0 16 16" style={{ animationDelay: `${i * 0.9}s` }} aria-hidden>
                <path d={ENVELOPE} />
              </svg>
            ))}
            <span className="sc-tray" />
          </div>
        )}
        {scene === 'notes' && (
          <div className="sc-notes">
            <span className="sc-page">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="sc-lens" />
          </div>
        )}
        {scene === 'todo' && (
          <ul className="sc-todo">
            {(items.length ? items : ['', '', '']).slice(0, 5).map((t, i) => (
              <li key={i} style={{ animationDelay: `${i * 0.35}s` }}>
                <span className="sc-box" style={{ animationDelay: `${i * 0.35 + 0.25}s` }} />
                {t ? <span className="clip">{t}</span> : <i />}
              </li>
            ))}
          </ul>
        )}
        {scene === 'calendar' && (
          <div className="sc-cal">
            {Array.from({ length: 21 }, (_, i) => (
              <i key={i} style={{ animationDelay: `${(i % 7) * 0.18 + Math.floor(i / 7) * 1.26}s` }} />
            ))}
          </div>
        )}
        {scene === 'draft' && (
          <div className="sc-draft">
            <i />
            <i />
            <i />
          </div>
        )}
        {scene === 'post' && (
          <div className="sc-post">
            <span>
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        {scene === 'think' && (
          <div className="sc-think">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <p>
        <b>{caption}</b>
        {now?.detail && scene !== 'todo' && <small className="clip">{now.detail}</small>}
        {scene === 'todo' && now?.detail && <small className="clip">in {now.detail}</small>}
      </p>
    </section>
  )
}

/* ---------- what it made, shown as what it is ---------- */

const cap = (s?: string) => (s ? s[0].toUpperCase() + s.slice(1) : '')

/** The report's **bold**, as bold, and nothing else from markdown. */
const bold = (text: string) => text.split(/\*\*([^*\n]+)\*\*/).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))

function Results({ made, shared }: { made: Made; shared: boolean }) {
  return (
    <>
      {made.todos.length > 0 && (
        <section className="res res-todo">
          <header>
            <Icon d="M3 4.5l1 1 2-2M3 9.5l1 1 2-2M8.5 4.5H13M8.5 9.5H13" />
            <b>{plural(made.todos.length, 'to-do')} added</b>
            {made.page && <span className="clip">in {made.page} · Notion</span>}
          </header>
          <ul>
            {made.todos.map((t, i) => (
              <li key={t + i} style={{ animationDelay: `${i * 60}ms` }}>
                <span className="res-box" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {made.drafts.length > 0 && (
        <section className="res res-drafts">
          <header>
            <Icon d={ENVELOPE} />
            <b>{plural(made.drafts.length, 'draft')} waiting in Gmail</b>
            <span>Nothing was sent</span>
          </header>
          <ul>
            {made.drafts.map((d, i) => (
              <li key={d + i}>
                <Icon d={ENVELOPE} />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {made.events.length > 0 && (
        <section className="res res-events">
          <header>
            <Icon d={I.calendar} />
            <b>{plural(made.events.length, 'event')}</b>
          </header>
          <ul>
            {made.events.map((ev, i) => {
              const [when2, what] = ev.includes('·') ? ev.split('·').map((x) => x.trim()) : ['', ev]
              return (
                <li key={ev + i}>
                  {when2 && <time>{when2}</time>}
                  <span>{what}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {made.note && (
        <section className="ev-found">
          <header>
            <b>{made.todos.length || made.drafts.length || made.events.length ? 'From your assistant' : 'What it found'}</b>
            {shared && <span>Shared in #oggy-daily</span>}
          </header>
          <p>{bold(made.note)}</p>
        </section>
      )}
    </>
  )
}

/* ---------- the home page ---------- */

export function EverydayHome(props: { workflows: Workflow[]; runs: Run[]; now: number; online: boolean; onPick: (id: string) => void; onRun: (w: Workflow) => void; onView: (runId: string) => void }) {
  const { workflows, runs, now } = props
  const going = runs.filter((r) => !isOver(r))
  const past = runs.filter(isOver)
  const nameOf = (r: Run) => workflows.find((w) => w.id === r.workflowId)?.name ?? r.label ?? r.command
  const upcoming = useMemo(
    () =>
      workflows
        .map((w) => ({ w, at: w.schedule ? nextRun(w.schedule, now) : undefined }))
        .filter((x): x is { w: Workflow; at: number } => Boolean(x.at))
        .sort((a, b) => a.at - b.at),
    [workflows, now]
  )
  const next = upcoming[0]
  const busy = (w: Workflow) => going.some((r) => r.workflowId === w.id)

  return (
    <div className="daily wf-home ev-home">
      <header className="daily-head">
        <h1>Your routines</h1>
        <p>
          <span>{plural(workflows.length, 'routine')}</span>
          {next && <span>Next: {next.w.name}, {dayWord(next.at, now).toLowerCase()} {hhmm(next.at)}</span>}
        </p>
      </header>

      {going.length > 0 && (
        <section className="table">
          <header>
            <b>Running now</b>
            <span>{going.length}</span>
          </header>
          {going.map((r) => (
            <button key={r.id} className="ev-going" onClick={() => props.onView(r.id)}>
              <Pet look="beach" mood="working" pose="walk" size={26} />
              <b>{nameOf(r)}</b>
              <span className={`status ${runWords(r).cls}`}>{runWords(r).text}</span>
              <time>{clock(now - r.createdAt)}</time>
            </button>
          ))}
        </section>
      )}

      <div className="wf-cols">
        <div className="ev-col">
          <section className="table">
            <header>
              <b>Up next</b>
              <span>{upcoming.length}</span>
            </header>
            {upcoming.length === 0 && <p className="table-empty">Nothing runs by itself yet. Say when, like “every weekday at 9am”, and it will.</p>}
            {upcoming.map(({ w, at }) => (
              <div key={w.id} className="ev-next">
                <button className="ev-when" onClick={() => props.onPick(w.id)}>
                  <b>{hhmm(at)}</b>
                  <small>{dayWord(at, now)}</small>
                </button>
                <button className="ev-what" onClick={() => props.onPick(w.id)}>
                  <b className="clip">{w.name}</b>
                  <small className="clip">{scheduleText(w.schedule!)}</small>
                </button>
                <button className="btn is-quiet" disabled={!props.online || busy(w)} onClick={() => props.onRun(w)}>
                  <Icon d={I.play} />
                  Run now
                </button>
              </div>
            ))}
          </section>

          <section className="table">
            <header>
              <b>Routines</b>
              <span>{workflows.length}</span>
            </header>
            <div className="ev-cards">
              {workflows.map((w) => (
                <article key={w.id} className="ev-card">
                  <button className="ev-card-body" onClick={() => props.onPick(w.id)} title={w.description}>
                    <span className="day-ico"><Icon d={I.sun} /></span>
                    <b className="clip">{w.name}</b>
                    <p>{w.description}</p>
                  </button>
                  <footer>
                    <span className="clip">{w.schedule ? scheduleText(w.schedule) : 'When you say its name'}</span>
                    <span>{w.lastRunAt ? ago(w.lastRunAt, now) : 'Never run'}</span>
                    <button className="btn is-quiet" disabled={!props.online || busy(w)} onClick={() => props.onRun(w)} title={`Run ${w.name}`}>
                      <Icon d={I.play} />
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        </div>

        <section className="table">
          <header>
            <b>Recent results</b>
            <span>{past.length}</span>
          </header>
          {past.length === 0 && <p className="table-empty">What your routines find shows up here.</p>}
          {past.map((r) => (
            <button key={r.id} className="ev-result-row" onClick={() => props.onView(r.id)} title={r.summary ?? r.command}>
              <span className="ev-result-top">
                <b className="clip">{nameOf(r)}</b>
                <span className={`status ${runWords(r).cls}`}>{runWords(r).text}</span>
                <time>{when(r.createdAt)}</time>
              </span>
              {madeLine(madeOfRun(r)) && <span className="ev-made">{madeLine(madeOfRun(r))}</span>}
              <span className="ev-result-text">{r.summary ?? r.command}</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  )
}

/* ---------- a run ---------- */

/** A routine running: Oggy in the chair, the steps as a checklist, what was found, and what it's doing right now. */
export function EverydayRun(props: { run: Run; live: RunLive; approval: Approval | null; now: number }) {
  const { run, live, approval, now } = props
  const running = !isOver(run)
  const steps = run.steps.filter((s) => !s.args?.plan)
  const doing = steps.find((s) => s.status === 'running' || s.status === 'waiting_approval')
  const line = doing ? tidy(live.stepLines[doing.id], whoWhat(doing).who) || whoWhat(doing).what : live.line
  const found = reportOf(run, live)
  const made = useMemo(() => madeOf(found, live.trace), [found, live.trace])
  const shared = steps.find((s) => s.kind === 'room.post' && s.status === 'done')
  const started = steps.find((s) => s.startedAt)?.startedAt ?? run.createdAt
  const took = (isOver(run) ? run.updatedAt : now) - started
  const activity: TraceEntry[] = useMemo(() => {
    const own = steps
      .filter((s) => s.kind !== 'agent.job')
      .flatMap((s) => (live.stepFeed[s.id] ?? []).map((l) => ({ id: `f${l.id}`, at: l.at, agent: 'oggy', stepId: s.id, kind: 'other' as const, text: tidy(l.text) })))
    return [...live.trace.filter((e) => !e.id.startsWith('answer-')), ...own].sort((a, b) => a.at - b.at)
  }, [live.trace, live.stepFeed, steps])
  const headline = running ? (approval ? 'Waiting for your OK' : cap(line) || 'Getting started') : run.status === 'done' ? 'All done' : run.status === 'failed' ? 'It didn’t finish' : 'Stopped'
  const someoneElse = approval?.vote?.notYou

  return (
    <div className="ev-run">
      <div className="ev-main">
        <header className="ev-hero">
          <Pet look="beach" mood={running ? (approval ? 'waiting' : 'working') : run.status === 'done' ? 'done' : 'stuck'} pose={running && !approval ? 'walk' : 'sit'} size={52} />
          <div>
            <h2>{headline}</h2>
            <p>
              {run.source === 'schedule' ? 'Ran on its schedule' : 'You started it'} · {when(run.createdAt)} · {clock(took)}
            </p>
          </div>
        </header>

        {approval && (
          <section className="ev-ask">
            <p>{someoneElse ? `Waiting for ${approval.vote!.voters.join(' and ')}: ${approval.action}` : approval.action}</p>
            <div>
              <button className="btn is-quiet is-danger" onClick={() => void window.oggy.decideApproval(approval.id, false)}>
                {someoneElse ? 'Stop it' : 'No'}
              </button>
              {!someoneElse && (
                <button className="btn is-primary" onClick={() => void window.oggy.decideApproval(approval.id, true)}>
                  Yes
                </button>
              )}
            </div>
          </section>
        )}

        <ol className="ev-steps">
          {steps.map((s) => {
            const { who, what } = whoWhat(s)
            const t = s.startedAt ? (s.endedAt ?? (running ? now : run.updatedAt)) - s.startedAt : 0
            const sub = s.status === 'running' ? tidy(live.stepLines[s.id], who) : s.status === 'skipped' ? 'Skipped' : s.kind === 'room.post' ? 'Shares it in #oggy-daily' : who ? `${who[0].toUpperCase()}${who.slice(1)}` : 'Oggy'
            return (
              <li key={s.id} className={`is-${s.status}`}>
                {s.status === 'running' ? <Spinner /> : <StepNode status={s.status} />}
                <span className="ev-step">
                  <b>{what[0].toUpperCase() + what.slice(1)}</b>
                  <small className="clip">{sub}</small>
                </span>
                {t > 0 && <time>{clock(t)}</time>}
              </li>
            )
          })}
        </ol>

        {running && !approval && <Stage trace={live.trace} />}

        <Results made={made} shared={Boolean(shared)} />
        {!found && !made.todos.length && !running && run.summary && <p className="ev-summary">{run.summary}</p>}
      </div>

      <aside className="ev-side">
        <h2>
          Activity
          <span>{activity.length}</span>
        </h2>
        {activity.length === 0 && <p className="ev-none">{running ? 'Waiting for the first action' : 'Nothing was recorded'}</p>}
        <ol>
          {activity.map((e) => (
            <li key={e.id} className={e.ok === false ? 'is-bad' : e.endedAt || e.kind === 'say' ? '' : 'is-going'}>
              <time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time>
              <span>
                {e.text}
                {e.detail && <small className="clip">{e.detail}</small>}
              </span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  )
}
