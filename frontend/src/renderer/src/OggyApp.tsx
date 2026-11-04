import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentLive, Approval, FileChange, PlanStep, Review, ReviewSection, Run, TeamVote, TraceEntry, Workflow } from '@shared/types'
import { LiveSteps, StepIcon } from './AgentStream'
import { DiffView } from './DiffView'
import { clock, describe, projectOf, spaceOf, StepNode, tidy, useNow, whoWhat, type Space } from './JobCard'
import { EverydayRun } from './Everyday'
import { Pet, RoamingPet, type Look, type Mood } from './Pet'
import { moodOf, narrate, youVoted } from './scene'
import { EMPTY_LIVE, useOggy, type FeedLine, type OggyStore, type RunLive } from './store'
import { Crew, I, Icon, Spinner, Who } from './ui'
import { asWorkflowCommand, designRun, inWorkflows, kindOf as flowKindOf, Workflows, type FlowKind } from './Workflows'
import './app.css'

export interface QA {
  id: number
  q: string
  a?: { text: string; ref?: { path: string; line: number } }
}

/** 'home' is whichever of the board and the daily log you were on last. */
export type AppView = 'home' | 'board' | 'daily' | 'workflows' | 'task' | 'team'

const FULL_KEY = 'oggy.full'
const SPACE_KEY = 'oggy.space'

const savedSpace = (): Space => {
  try {
    return localStorage.getItem(SPACE_KEY) === 'daily' ? 'daily' : 'code'
  } catch {
    return 'code'
  }
}

/** The job the bar is following, whose questions and follow-ups live there. */
export interface Followed {
  runId: string
  qa: QA[]
  prevReview: Review | null
  onSend: (text: string) => void
  onOpenCode: () => void
}

const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const fileName = (p: string) => p.split('/').pop() ?? p
const fileDir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')
const CHAPTER: Record<ReviewSection['key'], string> = { wrong: 'Before', why: 'Why', changed: 'What changed', tested: 'Proof' }
const isOver = (r: Run) => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled'
const pendingFor = (approvals: Approval[], runId: string) => approvals.find((a) => a.runId === runId && a.status === 'pending') ?? null

/** Where a run stands on the board. */
type Column = 'queued' | 'working' | 'you' | 'done'
function columnOf(run: Run, live: RunLive, approval: Approval | null): Column {
  if (youVoted(approval)) return 'working'
  if (approval || run.status === 'waiting_approval' || run.status === 'failed' || live.review?.status === 'ready' || live.review?.status === 'explaining' || run.label === 'Question') return 'you'
  if (isOver(run)) return 'done'
  return run.status === 'planned' && !run.steps.some((s) => s.status === 'running') ? 'queued' : 'working'
}
const COLUMNS: { key: Column; title: string }[] = [
  { key: 'queued', title: 'Queued' },
  { key: 'working', title: 'Working' },
  { key: 'you', title: 'Needs you' },
  { key: 'done', title: 'Done' }
]

/** The two sides of the app. */
const SPACES: Record<Space, { title: string; view: AppView; icon: string }> = {
  code: { title: 'Coding', view: 'board', icon: I.code },
  daily: { title: 'Daily', view: 'daily', icon: I.sun }
}
const landing = (v: AppView) => (v === 'home' ? SPACES[savedSpace()].view : v)

/** What an everyday job touched, from its first real step. */
const DAILY_KINDS = [
  { title: 'Apps & screen', icon: I.screen, kinds: /^(app\.|screen\.|system\.|keys\.)/ },
  { title: 'Files', icon: I.folder, kinds: /^(file\.|folder\.|undo)/ },
  { title: 'Messages & calendar', icon: I.calendar, kinds: /^(room\.|calendar\.)/ }
]
const OTHER_KIND = { title: 'Notes & other', icon: I.note }
function kindOf(run: Run) {
  const first = run.steps.find((s) => !s.args?.plan)
  return (first && DAILY_KINDS.find((k) => k.kinds.test(first.kind))) ?? OTHER_KIND
}

/** One tap, nothing risky: each is a single quick action in the planner. */
const QUICK = [
  { label: 'Screenshot', say: 'take a screenshot', icon: I.camera },
  { label: 'Downloads', say: 'open my downloads', icon: I.download },
  { label: 'Documents', say: 'open my documents', icon: I.folder },
  { label: 'Desktop', say: 'open my desktop', icon: I.screen },
  { label: 'Mute', say: 'mute', icon: I.mute }
]

/** How long the backend waits for the answer to a question (plan.pending in the planner). */
const QUESTION_MS = 10 * 60_000

/** A log row asks for you while an approval waits or a question can still be answered. A stale one is history. */
const wantsYou = (run: Run, approval: Approval | null) =>
  (approval !== null && !youVoted(approval)) || run.status === 'waiting_approval' || (run.label === 'Question' && Date.now() - run.updatedAt < QUESTION_MS)

const dayName = (t: number, now: number) => {
  const day = new Date(t).toDateString()
  if (day === new Date(now).toDateString()) return 'Today'
  if (day === new Date(now - 86_400_000).toDateString()) return 'Yesterday'
  return new Date(t).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

/** Oggy, the app: coding on a board, everyday things in a log, each task as a live thread, and the team. */
export function OggyApp(props: {
  /** Opened over the desktop from the bar; without this it's the plain dashboard window. */
  onClose?: () => void
  /** Yellow: down to the taskbar. */
  onMinimize?: () => void
  /** Esc: put it away, with the job still in the island. */
  onTuck?: () => void
  leaving?: boolean
  view?: AppView
  /** The task to open. */
  focus?: string
  followed?: Followed
  /** A new job from here. */
  onNew?: (text: string) => void
  /** Already listening (the bar listens from launch, so nothing is missed before this opens). */
  store?: OggyStore
}) {
  const own = useOggy(!props.store)
  const oggy = props.store ?? own
  const { runs, approvals, team, live, online, integrations, workflows } = oggy
  const [view, setView] = useState<AppView>(() => landing(props.view ?? (props.focus ? 'task' : 'home')))
  const [taskId, setTaskId] = useState<string | undefined>(props.focus)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [full, setFull] = useState(() => {
    try {
      return localStorage.getItem(FULL_KEY) === '1'
    } catch {
      return false
    }
  })
  const composer = useRef<HTMLInputElement>(null)
  const lastSpace = useRef(savedSpace())
  const [flowId, setFlowId] = useState<string>()
  const [flowRunId, setFlowRunId] = useState<string>()
  const [flowKind, setFlowKind] = useState<FlowKind>('code')
  const [dismissed, setDismissed] = useState<string>()
  const anyRunning = runs.some((r) => !isOver(r))
  const now = useNow(anyRunning || team.some((a) => a.status !== 'idle'))

  useEffect(() => {
    if (props.view) setView(landing(props.view))
  }, [props.view])
  useEffect(() => {
    if (!props.focus) return
    setTaskId(props.focus)
    // A job started from the daily log runs in the log, in its own row; a workflow in Workflows.
    setView((v) => (v === 'daily' || v === 'workflows' ? v : 'task'))
  }, [props.focus])
  useEffect(() => {
    if (taskId) oggy.load(taskId)
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (flowRunId) oggy.load(flowRunId)
  }, [flowRunId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') props.onTuck?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function open(id: string) {
    const run = runs.find((r) => r.id === id)
    if (run && inWorkflows(run, workflows)) return showFlow(run)
    setTaskId(id)
    setView('task')
  }

  /** Workflows, on this run if it's a workflow's. */
  function showFlow(run?: Run) {
    setView('workflows')
    if (run?.workflowId) setFlowKind(flowKindOf(workflows.find((w) => w.id === run.workflowId)?.steps ?? run.steps))
    setFlowId(run?.workflowId)
    setFlowRunId(run?.workflowId ? run.id : undefined)
  }

  /** Picking a workflow that's running opens the run. */
  function pickFlow(id?: string) {
    const picked = workflows.find((w) => w.id === id)
    if (picked) setFlowKind(flowKindOf(picked.steps))
    setFlowId(id)
    setFlowRunId(id ? runs.find((r) => r.workflowId === id && !isOver(r))?.id : undefined)
  }

  async function startJob(text: string, follow = view !== 'daily' && view !== 'workflows') {
    if (props.onNew) return props.onNew(text)
    const run = await window.oggy.submitCommand(text)
    if (follow) open(run.id)
    else setTaskId(run.id)
  }

  // A new workflow is the one you want to see.
  const known = useRef<Set<string>>()
  useEffect(() => {
    const fresh = known.current ? workflows.find((w) => !known.current!.has(w.id)) : undefined
    known.current = new Set(workflows.map((w) => w.id))
    if (fresh) return setFlowId(fresh.id)
    setFlowId((id) => (id && workflows.some((w) => w.id === id) ? id : undefined))
  }, [workflows])
  const flow = workflows.find((w) => w.id === flowId)
  const found = designRun(runs)
  const designing = found?.id === dismissed ? undefined : found
  const answering = designing?.label === 'Question'

  const task = runs.find((r) => r.id === taskId)
  const flowTask = Boolean(task && inWorkflows(task, workflows))
  // However it started (the bar, your voice, the Coding box), a workflow runs in Workflows. A job
  // that's still being planned only says it's one a moment later.
  useEffect(() => {
    if (flowTask) showFlow(task)
  }, [taskId, flowTask, view === 'task']) // eslint-disable-line react-hooks/exhaustive-deps
  const flowRun = runs.find((r) => r.id === flowRunId && r.workflowId === flowId)
  const space: Space = (view === 'task' && task && spaceOf(task)) || (view === 'daily' ? 'daily' : view === 'board' ? 'code' : lastSpace.current)
  useEffect(() => {
    lastSpace.current = space
    try {
      localStorage.setItem(SPACE_KEY, space)
    } catch {
      /* only a convenience */
    }
  }, [space])

  function go(s: Space) {
    setView(SPACES[s].view)
  }

  const shownRuns = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? runs.filter((r) => `${r.command} ${r.label ?? ''} ${projectOf(r) ?? ''}`.toLowerCase().includes(q)) : runs
  }, [runs, query])
  // A job still being planned could be either, so it shows in both until the plan says.
  const plainRuns = useMemo(() => shownRuns.filter((r) => !inWorkflows(r, workflows)), [shownRuns, workflows])
  const codeRuns = useMemo(() => plainRuns.filter((r) => spaceOf(r) !== 'daily'), [plainRuns])
  const dailyRuns = useMemo(() => plainRuns.filter((r) => spaceOf(r) !== 'code'), [plainRuns])

  const asks: Record<Space, number> = { code: 0, daily: 0 }
  const busy: Record<Space, number> = { code: 0, daily: 0 }
  const flowAsks: Run[] = []
  const flowBusy: Run[] = []
  for (const r of runs) {
    const s = spaceOf(r)
    const approval = pendingFor(approvals, r.id)
    if (inWorkflows(r, workflows)) {
      if (r.workflowId && !isOver(r)) flowBusy.push(r)
      if ((approval && !youVoted(approval)) || live[r.id]?.review?.status === 'ready') flowAsks.push(r)
      continue
    }
    if (s && !isOver(r)) busy[s]++
    if (s === 'daily' ? wantsYou(r, approval) : (approval && !youVoted(approval)) || live[r.id]?.review?.status === 'ready') asks[s ?? 'code']++
  }
  const needs = asks.code + asks.daily + flowAsks.length

  // The pet tells what's going on right now, wherever you are in the app.
  const hot = runs.find((r) => r.status === 'running' || r.status === 'waiting_approval')
  const hotLive = hot ? (live[hot.id] ?? EMPTY_LIVE) : EMPTY_LIVE
  const hotApproval = hot ? pendingFor(approvals, hot.id) : null
  const said = hot ? narrate({ run: hot, team, stepLines: hotLive.stepLines, approval: hotApproval, review: hotLive.review, changing: false, general: hotLive.line }).line : undefined
  const mood: Mood = hot ? moodOf(hot, hotApproval, hotLive.review) : needs ? 'waiting' : 'idle'
  // Oggy dresses for what you're looking at: a hoodie for code, shades in a beach chair for your day.
  const openFlow = view === 'workflows' ? (flowRun ?? flow) : undefined
  const everydayNow =
    view === 'daily' || (view === 'task' && Boolean(task) && spaceOf(task!) === 'daily') || (view === 'workflows' && (openFlow ? flowKindOf(openFlow.steps) === 'everyday' : flowKind === 'everyday'))
  const look: Look = everydayNow ? 'beach' : 'coder'

  return (
    <div className={`oggy-app ${props.onClose ? 'is-over' : ''} ${full ? 'is-full' : ''} ${props.leaving ? 'is-leaving' : ''}`} role="dialog" aria-label="Oggy">
      <aside className="side">
        <div className="side-brand">
          {props.onClose && (
            <span className="lights">
              <button className="light is-close" onClick={props.onClose} aria-label="Close" title="Close (the job keeps running)">
                <svg viewBox="0 0 12 12" aria-hidden>
                  <path d="M3.8 3.8l4.4 4.4M8.2 3.8L3.8 8.2" />
                </svg>
              </button>
              <button className="light is-min" onClick={props.onMinimize} aria-label="Minimize" title="Minimize to the taskbar">
                <svg viewBox="0 0 12 12" aria-hidden>
                  <path d="M3.2 6h5.6" />
                </svg>
              </button>
              <button
                className="light is-zoom"
                onClick={() =>
                  setFull((on) => {
                    try {
                      localStorage.setItem(FULL_KEY, on ? '0' : '1')
                    } catch {
                      /* only a convenience */
                    }
                    return !on
                  })
                }
                aria-label={full ? 'Exit full size' : 'Full size'}
                title={full ? 'Exit full size' : 'Full size'}
              >
                <svg viewBox="0 0 12 12" aria-hidden>
                  <path d={full ? 'M6 6L3 3M6 6h-2.6M6 6V3.4M6 6l3 3M6 6h2.6M6 6v2.6' : 'M3.4 8.6L8.6 3.4M4.8 3.4h3.8v3.8M7.2 8.6H3.4V4.8'} />
                </svg>
              </button>
            </span>
          )}
          <Pet mood="idle" size={24} />
          <b>Oggy</b>
        </div>
        <label className="side-search">
          <Icon d={I.search} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" spellCheck={false} />
        </label>
        <nav className="side-nav">
          {(['code', 'daily'] as const).map((s) => (
            <button key={s} className={view === SPACES[s].view || (view === 'task' && space === s) ? 'is-on' : ''} onClick={() => go(s)}>
              <Icon d={SPACES[s].icon} />
              {SPACES[s].title}
              {asks[s] > 0 ? <em>{asks[s]}</em> : busy[s] > 0 && <em className="is-live">{busy[s]}</em>}
            </button>
          ))}
          <button className={view === 'workflows' ? 'is-on' : ''} onClick={() => (view === 'workflows' ? pickFlow(undefined) : showFlow(flowAsks[0] ?? flowBusy[0]))}>
            <Icon d={I.flow} />
            Workflows
            {flowAsks.length > 0 ? <em>{flowAsks.length}</em> : flowBusy.length > 0 ? <em className="is-live">{flowBusy.length}</em> : workflows.length > 0 && <em className="is-quiet">{workflows.length}</em>}
          </button>
          <button className={view === 'team' ? 'is-on' : ''} onClick={() => setView('team')}>
            <Icon d={I.team} />
            Team
            {team.some((a) => a.status !== 'idle') && <em className="is-live">{team.filter((a) => a.status !== 'idle').length}</em>}
          </button>
        </nav>

        <div className="side-scroll">
          {view === 'workflows' ? (
            <WorkflowList workflows={workflows} runs={runs} query={query} approvals={approvals} current={flowId} onPick={pickFlow} />
          ) : (
            <TaskGroups space={space} runs={space === 'daily' ? dailyRuns : codeRuns} searching={Boolean(query.trim())} live={live} approvals={approvals} current={view === 'task' ? taskId : undefined} onOpen={open} />
          )}
        </div>

        <footer className="side-foot">
          <span className={`dot ${online ? 'is-ok' : 'is-bad'}`} />
          {online ? 'Connected' : 'Backend offline'}
          <span className="side-int">
            {integrations.map((i) => (
              <i key={i.name} className={i.ready ? 'is-ok' : ''} title={`${i.name}: ${i.detail}`} />
            ))}
          </span>
          <button className="side-quit" onClick={() => window.oggy.quit()} title="Quit Oggy completely">
            Quit
          </button>
        </footer>
      </aside>

      <section className="main">
        <header className="bar">
          <p className="crumbs">
            {view === 'task' && task ? (
              <>
                <button className="crumb-back" onClick={() => go(space)}>
                  {SPACES[space].title}
                </button>
                <Icon d={I.chevron} />
                <b>{describe(task)}</b>
                {projectOf(task) && <span>{projectOf(task)}</span>}
              </>
            ) : view === 'workflows' ? (
              <>
                <b>Workflows</b>
                {flow && <span>{flow.name}</span>}
              </>
            ) : (
              <b>{view === 'team' ? 'Team' : SPACES[space].title}</b>
            )}
          </p>
          <span className="grow" />
          <button
            className="btn is-primary"
            onClick={() => {
              if (view === 'workflows') setFlowRunId(undefined)
              requestAnimationFrame(() => composer.current?.focus())
            }}
          >
            <Icon d={I.plus} />
            {view === 'workflows' ? 'Workflow' : 'Task'}
          </button>
          <button className="btn" onClick={() => (view === 'team' ? go(space) : setView('team'))}>
            <Icon d={view === 'team' ? SPACES[space].icon : I.team} />
            {view === 'team' ? SPACES[space].title : 'Team'}
          </button>
          <button className="icon-btn" aria-label="Needs you" title="Needs you" onClick={() => (!asks[space] && flowAsks.length ? showFlow(flowAsks[0]) : go(asks[space] > 0 || !needs ? space : asks.code > 0 ? 'code' : 'daily'))}>
            <Icon d={I.bell} />
            {needs > 0 && <i className="bell-dot" />}
          </button>
        </header>

        <div className="pet-rail">
          <RoamingPet mood={mood} line={said} look={look} onClick={() => hot && open(hot.id)} />
        </div>

        {view === 'board' && <Board runs={codeRuns} live={live} approvals={approvals} team={team} now={now} onOpen={open} />}
        {view === 'daily' && <Daily runs={dailyRuns} searching={Boolean(query.trim())} live={live} approvals={approvals} team={team} now={now} online={online} onOpen={open} onSend={startJob} />}
        {view === 'workflows' && (
          <Workflows
            workflows={workflows}
            selected={flowId}
            runs={runs}
            now={now}
            online={online}
            design={designing}
            open={flowRun}
            onDismiss={setDismissed}
            onOpen={setFlowRunId}
            onPick={pickFlow}
            kind={flowKind}
            onKind={(k) => {
              setFlowKind(k)
              pickFlow(undefined)
            }}
            onView={open}
            onRun={(w) => void startJob(`run ${w.name} workflow`)}
            onExample={(text) => {
              setDraft(text)
              composer.current?.focus()
            }}
            renderRun={(run) => flowKindOf(run.steps) === 'everyday' ? <EverydayRun key={run.id} run={run} live={live[run.id] ?? EMPTY_LIVE} approval={pendingFor(approvals, run.id)} now={now} /> : <Task key={run.id} run={run} live={live[run.id] ?? EMPTY_LIVE} approval={pendingFor(approvals, run.id)} team={team} now={now} followed={props.followed?.runId === run.id ? props.followed : undefined} onNew={(text) => void startJob(text, true)} />}
          />
        )}
        {view === 'team' && <Team team={team} now={now} />}
        {view === 'task' && task && !flowTask && (
          <Task key={task.id} run={task} live={live[task.id] ?? EMPTY_LIVE} approval={pendingFor(approvals, task.id)} team={team} now={now} followed={props.followed?.runId === task.id ? props.followed : undefined} onNew={(text) => void startJob(text)} />
        )}
        {view === 'task' && !task && <p className="none">That task isn’t here any more.</p>}

        {view !== 'task' && !(view === 'workflows' && flowRun) && (
          <div className="dock">
            <div className="composer">
              <Pet mood={draft.trim() ? 'hearing' : 'idle'} look={look} size={22} />
              <input
                ref={composer}
                className="ws-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !draft.trim()) return
                  void startJob(view === 'workflows' ? asWorkflowCommand(draft.trim(), answering) : draft.trim())
                  setDraft('')
                }}
                placeholder={view === 'workflows' ? (answering ? 'Answer Oggy' : flowKind === 'everyday' ? 'Describe a routine: what to read, what to do with it, and when' : 'Describe a workflow: name it, then say who does what') : view === 'team' ? 'Give the team a job' : view === 'daily' ? 'What do you need done?' : 'What should the team build or fix?'}
                spellCheck={false}
                disabled={!online}
              />
              <kbd className={draft.trim() ? 'is-ready' : ''}>Enter</kbd>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

/* ---------- sidebar ---------- */

/** The saved workflows, with the one that's running marked. */
function WorkflowList(props: { workflows: Workflow[]; runs: Run[]; approvals: Approval[]; query: string; current?: string; onPick: (id?: string) => void }) {
  const q = props.query.trim().toLowerCase()
  const shown = q ? props.workflows.filter((w) => `${w.name} ${w.description} ${w.project ?? ''}`.toLowerCase().includes(q)) : props.workflows
  if (!shown.length) return <p className="side-empty">{q ? 'Nothing matches here.' : 'Your workflows show up here.'}</p>
  return (
    <section className="side-group">
      <button className={`side-task is-all ${props.current ? '' : 'is-on'}`} onClick={() => props.onPick(undefined)}>
        <Icon d={I.flow} />
        <span className="clip">All workflows</span>
      </button>
      {(['code', 'everyday'] as FlowKind[]).map((k) => {
        const theirs = shown.filter((w) => flowKindOf(w.steps) === k)
        if (!theirs.length) return null
        return (
          <div key={k} className="side-sub">
            <h2>
              <Icon d={k === 'code' ? I.code : I.sun} />
              <span className="clip">{k === 'code' ? 'Coding' : 'Everyday'}</span>
            </h2>
            {theirs.map((w) => {
              const going = props.runs.find((r) => r.workflowId === w.id && !isOver(r))
              const held = going && going.status === 'waiting_approval'
              return (
                <button key={w.id} className={`side-task ${w.id === props.current ? 'is-on' : ''}`} onClick={() => props.onPick(w.id)} title={w.description}>
                  <span className={`state ${held ? 'is-you' : going ? 'is-working' : ''}`}>{going && !held && <Spinner />}</span>
                  <span className="clip">{w.name}</span>
                  <small className="side-count">{w.steps.length}</small>
                </button>
              )
            })}
          </div>
        )
      })}
    </section>
  )
}

/** Coding by project, everyday things by what they touched. */
function TaskGroups(props: { space: Space; runs: Run[]; searching: boolean; live: Record<string, RunLive>; approvals: Approval[]; current?: string; onOpen: (id: string) => void }) {
  const { space, runs, live, approvals } = props
  const groups = useMemo(() => {
    const by = new Map<string, Run[]>()
    for (const r of runs) {
      const k = space === 'daily' ? kindOf(r).title : (projectOf(r) ?? '')
      by.set(k, [...(by.get(k) ?? []), r])
    }
    const kinds = [...DAILY_KINDS, OTHER_KIND].map((k) => k.title)
    return [...by.entries()].sort((a, b) => (space === 'daily' ? kinds.indexOf(a[0]) - kinds.indexOf(b[0]) : a[0] === '' ? 1 : b[0] === '' ? -1 : b[1][0].createdAt - a[1][0].createdAt))
  }, [runs, space])
  if (!runs.length) return <p className="side-empty">{props.searching ? 'Nothing matches here.' : space === 'daily' ? 'Your everyday tasks show up here.' : 'Your coding tasks show up here.'}</p>
  return (
    <>
      {groups.map(([group, list]) => (
        <section key={group} className="side-group">
          <h2>
            <Icon d={space === 'daily' ? kindOf(list[0]).icon : I.folder} />
            <span className="clip">{group || 'No project yet'}</span>
          </h2>
          {list.slice(0, 7).map((r) => {
            const col = columnOf(r, live[r.id] ?? EMPTY_LIVE, pendingFor(approvals, r.id))
            return (
              <button key={r.id} className={`side-task ${r.id === props.current ? 'is-on' : ''}`} onClick={() => props.onOpen(r.id)} title={r.command}>
                <span className={`state is-${col}`}>{col === 'working' && <Spinner />}</span>
                <span className="clip">{describe(r)}</span>
              </button>
            )
          })}
        </section>
      ))}
    </>
  )
}

/* ---------- the board ---------- */

function Board(props: { runs: Run[]; live: Record<string, RunLive>; approvals: Approval[]; team: AgentLive[]; now: number; onOpen: (id: string) => void }) {
  const { runs, live, approvals, now } = props
  const cols = useMemo(() => {
    const out: Record<Column, Run[]> = { queued: [], working: [], you: [], done: [] }
    for (const r of runs) out[columnOf(r, live[r.id] ?? EMPTY_LIVE, pendingFor(approvals, r.id))].push(r)
    return out
  }, [runs, live, approvals])
  return (
    <main className="board">
      {COLUMNS.map((c) => (
        <section key={c.key} className="col">
          <h2>
            <span className={`state is-${c.key}`} />
            {c.title}
            <span>{cols[c.key].length}</span>
          </h2>
          <div className="col-list">
            {cols[c.key].slice(0, c.key === 'done' ? 20 : undefined).map((r) => (
              <RunCard key={r.id} run={r} live={live[r.id] ?? EMPTY_LIVE} approval={pendingFor(approvals, r.id)} team={props.team} now={now} onOpen={() => props.onOpen(r.id)} />
            ))}
            {cols[c.key].length === 0 && <p className="col-empty">{c.key === 'working' ? 'Nothing running' : c.key === 'you' ? 'Nothing waiting for you' : 'None'}</p>}
          </div>
        </section>
      ))}
    </main>
  )
}

function RunCard({ run, live, approval, team, now, onOpen }: { run: Run; live: RunLive; approval: Approval | null; team: AgentLive[]; now: number; onOpen: () => void }) {
  const agents = run.steps.map((s) => whoWhat(s).who).filter((w): w is string => Boolean(w))
  const lead = agents[0]
  const added = live.changes.reduce((n, f) => n + f.added, 0)
  const removed = live.changes.reduce((n, f) => n + f.removed, 0)
  const told = narrate({ run, team, stepLines: live.stepLines, approval, review: live.review, changing: false, general: live.line })
  const running = !isOver(run)
  const done = run.steps.filter((s) => s.status === 'done').length
  return (
    <article className="card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <header>
        {lead ? <Crew names={[...new Set(agents)]} /> : <span className="who is-oggy"><Pet size={15} /></span>}
        <p>{live.review?.title || describe(run)}</p>
      </header>
      {(projectOf(run) || live.review?.branch) && (
        <p className="card-ref">
          <Icon d={I.branch} />
          <span className="clip">{live.review?.branch ?? projectOf(run)}</span>
        </p>
      )}
      {(live.changes.length > 0 || live.review?.tests) && (
        <p className="card-facts">
          {live.changes.length > 0 && (
            <span>
              {live.changes.length} file{live.changes.length === 1 ? '' : 's'} <span className="n-add">+{added}</span> <span className="n-del">−{removed}</span>
            </span>
          )}
          {live.review?.tests && <span className={live.review.tests.ok ? 'is-ok' : 'is-bad'}>{live.review.tests.text}</span>}
        </p>
      )}
      <footer>
        {running && <Spinner />}
        <span key={told.line} className="card-now clip">
          {told.line}
        </span>
        <span className="card-time">{running && run.steps.length > 1 ? `${done}/${run.steps.length}` : ago(run.updatedAt, now)}</span>
      </footer>
      {approval?.vote && <VoteRow vote={approval.vote} />}
      {approval && !youVoted(approval) && (
        <div className="card-acts" onClick={(e) => e.stopPropagation()}>
          <button className="btn is-primary" onClick={() => void window.oggy.decideApproval(approval.id, true)}>
            {approval.vote ? 'Yes' : 'Allow'}
          </button>
          <button className="btn is-quiet" onClick={() => void window.oggy.decideApproval(approval.id, false)}>
            {approval.vote ? 'No' : 'Skip'}
          </button>
        </div>
      )}
    </article>
  )
}

/* ---------- the daily log ---------- */

/**
 * Everyday jobs are done in seconds, so a board would be one long Done column. This is a log instead:
 * what needs you, what's going, then what got done, day by day.
 */
function Daily(props: { runs: Run[]; searching: boolean; live: Record<string, RunLive>; approvals: Approval[]; team: AgentLive[]; now: number; online: boolean; onOpen: (id: string) => void; onSend: (text: string) => void }) {
  const { runs, live, approvals, now } = props
  const { asking, going, days, doneToday, failedToday } = useMemo(() => {
    const out = { asking: [] as Run[], going: [] as Run[], days: new Map<string, Run[]>(), doneToday: 0, failedToday: 0 }
    for (const r of runs) {
      const today = dayName(r.createdAt, now) === 'Today'
      if (today && r.status === 'done' && r.label !== 'Question') out.doneToday++
      if (today && r.status === 'failed') out.failedToday++
      if (wantsYou(r, pendingFor(approvals, r.id))) out.asking.push(r)
      else if (!isOver(r)) out.going.push(r)
      else {
        const d = dayName(r.createdAt, now)
        out.days.set(d, [...(out.days.get(d) ?? []), r])
      }
    }
    return out
  }, [runs, approvals, now])
  const row = (r: Run, asks = false) => <DailyRow key={r.id} run={r} asks={asks} live={live[r.id] ?? EMPTY_LIVE} approval={pendingFor(approvals, r.id)} team={props.team} now={now} onOpen={() => props.onOpen(r.id)} />
  return (
    <main className="daily">
      <header className="daily-head">
        <h1>{new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
        <p>
          {doneToday} done today
          {failedToday > 0 && <em>{failedToday} failed</em>}
        </p>
      </header>
      <div className="daily-quick">
        {QUICK.map((q) => (
          <button key={q.say} className="btn" disabled={!props.online} onClick={() => props.onSend(q.say)} title={`“${q.say}”`}>
            <Icon d={q.icon} />
            {q.label}
          </button>
        ))}
      </div>

      {asking.length > 0 && (
        <section className="table">
          <header>
            <span className="state is-you" />
            <b>Needs you</b>
            <span>{asking.length}</span>
          </header>
          {asking.map((r) => row(r, true))}
        </section>
      )}
      {going.length > 0 && (
        <section className="table">
          <header>
            <span className="state is-working" />
            <b>Now</b>
            <span>{going.length}</span>
          </header>
          {going.map((r) => row(r))}
        </section>
      )}
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className="table">
          <header>
            <b>{day}</b>
            <span>{list.length}</span>
          </header>
          {list.map((r) => row(r))}
        </section>
      ))}

      {runs.length === 0 && (
        <div className="daily-empty">
          <Pet mood="idle" size={32} />
          <p>{props.searching ? 'Nothing matches that search' : 'Nothing yet. Tap one above, or ask below.'}</p>
        </div>
      )}
    </main>
  )
}

function DailyRow({ run, asks, live, approval, team, now, onOpen }: { run: Run; asks: boolean; live: RunLive; approval: Approval | null; team: AgentLive[]; now: number; onOpen: () => void }) {
  const kind = kindOf(run)
  const told = narrate({ run, team, stepLines: live.stepLines, approval, review: live.review, changing: false, general: live.line })
  const title = describe(run)
  const sub = isOver(run) && !asks ? (run.summary ?? (title !== run.command ? run.command : told.line)) : (told.sub ?? told.line)
  return (
    <div className="row is-day">
      <button className="row-head" onClick={onOpen} title={run.command}>
        <span className="day-ico">
          <Icon d={kind.icon} />
        </span>
        <span className="row-what">
          <b className="clip">{title}</b>
          <small className="clip">{sub}</small>
        </span>
        <span className="row-who day-kind clip">{kind.title}</span>
        <time className="row-time">{new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
        <DailyStatus run={run} asks={asks} />
      </button>
      {approval && !youVoted(approval) && (
        <div className="card-acts day-acts">
          <button className="btn is-primary" onClick={() => void window.oggy.decideApproval(approval.id, true)}>
            Allow
          </button>
          <button className="btn is-quiet" onClick={() => void window.oggy.decideApproval(approval.id, false)}>
            Skip
          </button>
        </div>
      )}
    </div>
  )
}

function DailyStatus({ run, asks }: { run: Run; asks: boolean }) {
  if (asks) return <span className="status is-you">Needs you</span>
  if (!isOver(run))
    return (
      <span className="status is-working">
        <Spinner />
        {run.steps.length ? 'Working' : 'Planning'}
      </span>
    )
  if (run.status === 'failed') return <span className="status is-bad">Failed</span>
  if (run.status === 'cancelled') return <span className="status">Stopped</span>
  if (run.label === 'Question') return <span className="status">Asked</span>
  if (run.steps.some((s) => s.status === 'stubbed')) return <span className="status">Not run</span>
  return (
    <span className="status is-ok">
      <StepNode status="done" />
      Done
    </span>
  )
}

/* ---------- a task ---------- */

function Task(props: { run: Run; live: RunLive; approval: Approval | null; team: AgentLive[]; now: number; followed?: Followed; onNew: (text: string) => void }) {
  const { run, live, approval, team, now, followed } = props
  const files = live.changes
  const review = live.review
  const shown = review ?? followed?.prevReview ?? null
  const changing = !review && Boolean(followed?.prevReview)
  const running = !isOver(run)
  const everyday = spaceOf(run) === 'daily'
  const [tab, setTab] = useState<string | null>(null)
  const [paneOpen, setPaneOpen] = useState(false)
  const [active, setActive] = useState<ReviewSection['key'] | null>(null)
  const [walking, setWalking] = useState(false)
  const [scrollKey, setScrollKey] = useState('')
  const [text, setText] = useState('')
  const [changeMode, setChangeMode] = useState(false)
  const [localQa, setLocalQa] = useState<QA[]>([])
  /** Following the newest activity; scrolling up stops that until you come back down. */
  const [following, setFollowing] = useState(true)
  const [opened, setOpened] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const feedBox = useRef<HTMLDivElement>(null)
  const picked = useRef(false)
  const counts = useRef(new Map<string, string>())
  const walk = useRef(0)
  const walked = useRef(false)

  const qa = followed?.qa ?? localQa
  const file = files.find((f) => f.path === tab) ?? files[0]
  const sections = shown?.sections ?? []
  const section = sections.find((s) => s.key === active)
  const ready = review?.status === 'ready'

  useEffect(() => input.current?.focus(), [])
  useEffect(() => () => stopWalk(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // A file just changed: the code follows it, until you pick one yourself.
  useEffect(() => {
    let latest: string | undefined
    for (const f of files) {
      const k = `${f.added}/${f.removed}`
      if (counts.current.get(f.path) !== k) {
        counts.current.set(f.path, k)
        latest = f.path
      }
    }
    if (latest && running && !picked.current && !active) {
      setTab(latest)
      setPaneOpen(true)
      setScrollKey(`live${Date.now()}`)
    }
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  // A fresh explanation: walk through it once, part by part.
  useEffect(() => {
    if (review?.status !== 'ready' || !review.sections.length || walked.current) return
    walked.current = true
    startWalk(review)
  }, [review?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // The window stays on the newest thing, unless you've scrolled up to read.
  useEffect(() => {
    if (following && feedBox.current) feedBox.current.scrollTop = feedBox.current.scrollHeight
  }, [following, live.trace, live.stepFeed, review?.status, qa.length, run.status])

  // An answer about a line: go to that line.
  const lastQa = qa.at(-1)
  useEffect(() => {
    const ref = lastQa?.a?.ref
    if (!ref) return
    stopWalk()
    setActive(null)
    setTab(ref.path)
    setPaneOpen(true)
    setScrollKey(`qa${lastQa!.id}`)
  }, [lastQa?.a]) // eslint-disable-line react-hooks/exhaustive-deps

  function look(s: ReviewSection) {
    setActive(s.key)
    const first = s.refs[0]
    if (first) {
      setTab(first.path)
      setPaneOpen(true)
      setScrollKey(`${s.key}${Date.now()}`)
    }
  }

  function startWalk(r: Review) {
    const token = ++walk.current
    setWalking(true)
    const step = (i: number) => {
      if (walk.current !== token) return
      const s = r.sections[i]
      if (!s) {
        setWalking(false)
        return
      }
      look(s)
      setTimeout(() => step(i + 1), Math.min(9000, Math.max(3600, s.text.length * 55)))
    }
    step(0)
  }

  function stopWalk() {
    walk.current++
    setWalking(false)
  }

  async function send(value = text) {
    const v = value.trim()
    if (!v) return
    stopWalk()
    const said = changeMode && !/^change\b/i.test(v) ? `change: ${v}` : v
    setText('')
    setChangeMode(false)
    if (followed) return followed.onSend(said)
    // A task from earlier: its review still takes decisions; anything else is a new job.
    if (review?.status !== 'ready') return props.onNew(said)
    const id = Date.now()
    setLocalQa((all) => [...all, { id, q: said }])
    const r = await window.oggy.decideReview(run.id, said, true).catch(() => null)
    setLocalQa((all) => (r?.answer ? all.map((x) => (x.id === id ? { ...x, a: r.answer } : x)) : all.filter((x) => x.id !== id)))
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void send()
  }

  function pick(path: string) {
    stopWalk()
    picked.current = true
    setTab(path)
    setPaneOpen(true)
  }

  const told = narrate({ run, team, stepLines: live.stepLines, approval, review, changing, general: live.line })
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const focus = section?.refs.filter((r) => r.path === file?.path) ?? []
  const notes = qa.filter((x) => x.a?.ref && x.a.ref.path === file?.path).map((x) => ({ line: x.a!.ref!.line, text: x.a!.text }))
  const why = shown?.files.find((f) => f.path === file?.path)?.why
  const project = projectOf(run)
  const ask = approval?.action.match(/^@?(\w+) wants to run: (.+?)(?:\s[—-]\s(.+))?$/)
  // Agents' actions, plus the live lines of steps Oggy runs itself (installs, builds, deploys).
  const feed = useMemo(() => {
    const own: TraceEntry[] = run.steps
      .filter((s) => s.kind !== 'agent.job')
      .flatMap((s) => (live.stepFeed[s.id] ?? []).map((l) => ({ id: `f${l.id}`, at: l.at, agent: 'oggy', stepId: s.id, kind: 'other' as const, text: tidy(l.text) })))
    return [...live.trace, ...own].sort((a, b) => a.at - b.at)
  }, [live.trace, live.stepFeed, run.steps])
  const lastAt = Math.max(run.createdAt, ...feed.map((e) => e.endedAt ?? e.at))
  const silent = now - lastAt
  const slips = feed.filter((e) => e.ok === false)
  // An agent that finished its turn got past what went wrong in it, so that's a fix, not a failure.
  const fixedSteps = slips.filter((e) => run.steps.find((s) => e.stepId === s.id || (!e.stepId && e.agent === whoWhat(s).who))?.status === 'done').length
  const failedSteps = slips.length - fixedSteps
  const started = run.steps.find((s) => s.startedAt)?.startedAt ?? run.createdAt
  const finishedAt = isOver(run) ? run.updatedAt : now
  const decided = review?.outcome && (review.status === 'kept' || review.status === 'undone')
  const changes = (
    <section>
      <h2>
        Changes
        {files.length > 0 && (
          <span>
            <span className="n-add">+{added}</span> <span className="n-del">−{removed}</span>
          </span>
        )}
      </h2>
      {files.length === 0 && <p className="exec-none">{running ? 'No files changed yet' : 'No files changed'}</p>}
      {files.map((f) => (
        <button key={f.path} className="row-file" onClick={() => pick(f.path)} title={f.path}>
          <span className="clip mono">
            <i>{fileDir(f.path)}</i>
            {fileName(f.path)}
          </span>
          {f.status === 'added' && <em>new</em>}
          {f.status === 'deleted' && <em className="is-gone">deleted</em>}
          <span className="n-add">+{f.added}</span>
          {f.removed > 0 && <span className="n-del">−{f.removed}</span>}
        </button>
      ))}
    </section>
  )

  return (
    <div className="exec">
      <div className="exec-main">
        <header className="exec-head">
          <p className="exec-ask" title={run.command}>
            {run.command}
          </p>
          <div className="exec-now">
            {running && !approval ? <Spinner /> : <span className={`state is-${approval ? 'you' : run.status === 'done' && !run.steps.some((s) => s.status === 'stubbed') ? 'done' : 'you'}`} />}
            <b key={told.line}>{told.line}</b>
            <span className="exec-clock">{clock(finishedAt - started)}</span>
            {running && <span className={`exec-beat ${silent > 45_000 ? 'is-late' : ''}`}>{silent < 3000 ? 'active now' : `last action ${clock(silent)} ago`}</span>}
            {failedSteps > 0 && <span className="exec-fails">{failedSteps} failed</span>}
            {fixedSteps > 0 && <span className="exec-fixed">{fixedSteps} fixed</span>}
          </div>
          {told.sub && <p className="exec-sub">{told.sub}</p>}
        </header>

        <div
          ref={feedBox}
          className="exec-feed"
          onScroll={(e) => {
            const b = e.currentTarget
            setFollowing(b.scrollHeight - b.scrollTop - b.clientHeight < 60)
          }}
        >
          {feed.length === 0 && (
            <div className="exec-empty">
              {running ? <Spinner /> : null}
              <p>{running ? 'Waiting for the first action' : 'No activity was recorded for this job'}</p>
            </div>
          )}
          {run.steps
            .filter((s) => !s.args?.plan)
            .map((s, i, all) => (
              <Turn key={s.id} step={s} next={all[i + 1]} entries={feed.filter((e) => e.stepId === s.id || (!e.stepId && e.agent === whoWhat(s).who))} now={now} live={running} opened={opened} onOpen={(id) => setOpened((o) => (o === id ? null : id))} />
            ))}

          {shown && shown.status !== 'explaining' && (
            <section className="story">
              <h2>{shown.title}</h2>
              {shown.summary && <p>{shown.summary}</p>}
              {shown.tests && <p className={shown.tests.ok ? 'is-ok' : 'is-bad'}>{shown.tests.text}</p>}
              {sections.length > 0 && (
                <button className="btn is-quiet story-walk" onClick={() => (walking ? stopWalk() : startWalk(shown))}>
                  {walking ? 'Stop' : 'Walk me through it'}
                </button>
              )}
              <ol>
                {sections.map((s) => (
                  <li key={s.key} className={active === s.key ? 'is-on' : ''}>
                    <button
                      onClick={() => {
                        stopWalk()
                        look(s)
                      }}
                    >
                      <b>{CHAPTER[s.key]}</b>
                      <span>{s.text}</span>
                    </button>
                  </li>
                ))}
              </ol>
              {shown.risks.length > 0 && (
                <ul className="risks">
                  {shown.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {!running && run.summary && !shown && <p className="exec-result">{run.summary}</p>}

          {qa.filter((x) => !x.a?.ref).map((x) => (
            <div key={x.id} className="exec-qa">
              <p className="exec-q">{x.q}</p>
              <p className={x.a ? '' : 'is-thinking'}>{x.a ? x.a.text : 'Thinking…'}</p>
            </div>
          ))}
        </div>

        {!following && (
          <button
            className="exec-latest"
            onClick={() => setFollowing(true)}
          >
            Jump to latest
          </button>
        )}

        <div className="dock">
          <div className="composer is-tall">
            {approval?.vote && (
              <div className="permit is-vote">
                <div>
                  <p>{approval.vote.notYou ? `Waiting for ${approval.vote.voters.join(' and ')}: ` : 'Team vote: '}{approval.action}</p>
                  <VoteRow vote={approval.vote} />
                </div>
                <button className="btn is-quiet is-danger" onClick={() => void window.oggy.decideApproval(approval.id, false)}>
                  {approval.vote.notYou ? 'Stop it' : 'No'}
                </button>
                {!youVoted(approval) && (
                  <button className="btn is-primary" onClick={() => void window.oggy.decideApproval(approval.id, true)}>
                    Yes, ship it
                  </button>
                )}
              </div>
            )}
            {approval && !approval.vote && (
              <div className="permit">
                <div>
                  <p>{ask ? `${ask[1][0].toUpperCase()}${ask[1].slice(1)} needs your OK` : approval.action}</p>
                  {ask && <code>{ask[2]}</code>}
                </div>
                <button className="btn is-quiet" onClick={() => void window.oggy.decideApproval(approval.id, false)}>
                  Skip
                </button>
                <button className="btn is-primary" onClick={() => void window.oggy.decideApproval(approval.id, true)}>
                  Allow
                </button>
              </div>
            )}
            {decided ? (
              <p className={`outcome is-${review.status}`}>{review.outcome}</p>
            ) : (
              <div className="composer-row">
                {changeMode && <span className="mode">Change</span>}
                <input
                  ref={input}
                  className="ws-input"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    if (walking) stopWalk()
                  }}
                  onKeyDown={onKey}
                  placeholder={approval?.vote?.notYou ? `It’s ${approval.vote.voters.join(' and ')}’s call` : approval ? 'Say “yes” or “no”' : changeMode ? 'What should change?' : shown && files.length ? 'Ask about any line, or say what to change' : running ? 'Ask how it’s going' : run.label === 'Question' ? 'Answer Oggy' : 'What next?'}
                  spellCheck={false}
                />
                {project && !running && (
                  <button className="btn is-quiet" onClick={() => (followed ? followed.onOpenCode() : props.onNew(`open my ${project} in vs code`))}>
                    Open in VS Code
                  </button>
                )}
                {ready && files.length > 0 && (
                  <>
                    <button className="btn is-quiet is-danger" onClick={() => void send('undo')}>
                      Undo
                    </button>
                    <button
                      className={`btn is-quiet ${changeMode ? 'is-on' : ''}`}
                      onClick={() => {
                        setChangeMode((m) => !m)
                        input.current?.focus()
                      }}
                    >
                      Change
                    </button>
                    <button className="btn is-primary" onClick={() => void send('keep')}>
                      Looks good
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <aside className="exec-side">
        {paneOpen && file ? (
          <div className="pane">
            <header>
              <button className="icon-btn" aria-label="Back to the steps" title="Back to the steps" onClick={() => setPaneOpen(false)}>
                <Icon d="M10 4L6 8l4 4" />
              </button>
              <p className="mono clip">
                <i>{fileDir(file.path)}</i>
                {fileName(file.path)}
              </p>
              <button className="btn is-quiet" disabled={file.status === 'deleted'} onClick={() => void window.oggy.openChange(run.id, file.path).catch(() => {})}>
                Open file
              </button>
            </header>
            {why && <p className="pane-why">{why}</p>}
            <DiffView key={file.path} file={file} focus={focus} notes={notes} scrollKey={`${file.path}${scrollKey}`} />
          </div>
        ) : (
          <div className="exec-panel">
            <section>
              <h2>
                {everyday ? 'Steps' : 'The team'}
                <span>
                  {run.steps.filter((s) => s.status === 'done').length}/{run.steps.length}
                </span>
              </h2>
              {run.steps.length === 0 && <p className="exec-none">Working out the plan</p>}
              {run.steps.map((s) => {
                const { who, what } = whoWhat(s)
                const t = s.startedAt ? (s.endedAt ?? (running ? now : run.updatedAt)) - s.startedAt : 0
                const line = s.status === 'running' ? tidy(live.stepLines[s.id], who) : ''
                return (
                  <div key={s.id} className={`exec-step is-${s.status}`}>
                    {who ? <Who name={who} /> : <span className="who is-oggy"><Pet size={15} /></span>}
                    <div>
                      <p className="clip" title={what}>
                        {what[0].toUpperCase() + what.slice(1)}
                      </p>
                      <small className="clip">{s.status === 'stubbed' ? 'Not connected yet, so it did nothing' : line || (who ? who[0].toUpperCase() + who.slice(1) : 'Oggy')}</small>
                    </div>
                    {s.status === 'running' ? <Spinner /> : <StepNode status={s.status} />}
                  </div>
                )
              })}
            </section>
            {(!everyday || files.length > 0) && changes}
            {shown?.branch && (
              <section>
                <h2>Branch</h2>
                <p className="mono exec-branch">{shown.branch}</p>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}

/** How a team vote stands: who said what, who it's waiting for. */
function VoteRow({ vote }: { vote: TeamVote }) {
  return (
    <span className="votes">
      {vote.voters.map((n) => (
        <span key={n} className={`vote is-${vote.answers[n] ?? 'wait'}`}>
          <Who name={n} />
          {n}
          <em>{vote.answers[n] === 'yes' ? 'yes' : vote.answers[n] === 'no' ? 'no' : 'waiting'}</em>
        </span>
      ))}
    </span>
  )
}

/** One team member's turn: who, on what, what they did, what they said, and who it passes to. */
function Turn(props: { step: PlanStep; next?: PlanStep; entries: TraceEntry[]; now: number; live: boolean; opened: string | null; onOpen: (id: string) => void }) {
  const { step: s, entries, now, live, opened } = props
  const { who, what } = whoWhat(s)
  const name = who ? who[0].toUpperCase() + who.slice(1) : 'Oggy'
  const going = s.status === 'running' || s.status === 'waiting_approval'
  const answer = entries.find((e) => e.id.startsWith('answer-'))
  const actions = entries.filter((e) => e !== answer)
  const fails = actions.filter((e) => e.ok === false).length
  const fixed = s.status === 'done'
  const key = `turn:${s.id}`
  const open = going || opened === key
  const t = s.startedAt ? (s.endedAt ?? (live ? now : s.startedAt)) - s.startedAt : 0
  const nextWho = props.next ? whoWhat(props.next).who : undefined
  if (s.status === 'pending') {
    return (
      <section className="turn is-pending">
        <header>
          {who ? <Who name={who} /> : <span className="who is-oggy"><Pet size={15} /></span>}
          <b>{name}</b>
          <span className="clip">{what[0].toUpperCase() + what.slice(1)}</span>
          <StatusText status={s.status} />
        </header>
      </section>
    )
  }
  return (
    <section className={`turn is-${s.status}`}>
      <header>
        {who ? <Who name={who} /> : <span className="who is-oggy"><Pet size={15} /></span>}
        <b>{name}</b>
        <span className="clip">{what[0].toUpperCase() + what.slice(1)}</span>
        {t >= 1000 && <time>{clock(t)}</time>}
        {s.status === 'waiting_approval' && s.ask?.who.length ? <span className="status is-you">{s.ask.who.join(' and ')}</span> : s.kind === 'deploy' && s.status === 'waiting_approval' && !s.ask ? <span className="status is-you">Team vote</span> : <StatusText status={s.status} />}
      </header>
      {actions.length > 0 && !going && (
        <button className="turn-more" onClick={() => props.onOpen(key)} aria-expanded={open}>
          {actions.length} action{actions.length === 1 ? '' : 's'}
          {fails > 0 && <em className={fixed ? 'is-fixed' : undefined}>{fails} {fixed ? 'fixed' : 'failed'}</em>}
        </button>
      )}
      {open && actions.map((e) => <Action key={e.id} entry={e} fixed={fixed} now={now} live={live} open={opened === e.id} onToggle={() => props.onOpen(e.id)} />)}
      {answer && <p className="turn-said">{answer.text.replace(/\*\*/g, '')}</p>}
      {s.status === 'done' && nextWho && <p className="turn-pass">Handed to {nextWho[0].toUpperCase() + nextWho.slice(1)}</p>}
    </section>
  )
}

/** One thing an agent did: what, on what, how long, how it ended, and what came back if you open it. */
function Action({ entry: e, fixed, now, live, open, onToggle }: { entry: TraceEntry; fixed: boolean; now: number; live: boolean; open: boolean; onToggle: () => void }) {
  const time = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  if (e.kind === 'say') {
    return (
      <div className="act is-say">
        <span className="act-time">{time}</span>
        <p>{e.text.replace(/\*\*/g, '')}</p>
      </div>
    )
  }
  const going = e.ok === undefined && e.endedAt === undefined && live && e.agent !== 'oggy'
  // A failure's output is what you came for, so it starts open. One the agent fixed is history.
  const bad = e.ok === false && !fixed
  const showing = open !== bad
  const ms = e.endedAt ? e.endedAt - e.at : going ? now - e.at : 0
  const body = (
    <>
      <span className="act-time">{time}</span>
      {e.agent !== 'oggy' && <span className="act-who">{e.agent}</span>}
      <span className="act-ico">{going ? <Spinner /> : <StepIcon kind={e.kind} />}</span>
      <span className="act-text">{e.text}</span>
      {e.detail && <span className="act-detail clip">{e.detail}</span>}
      <span className="act-end">
        {ms >= 1000 && <span>{clock(ms)}</span>}
        {e.ok === false && <b className={fixed ? 'is-fixed' : undefined}>{fixed ? 'Fixed' : 'Failed'}</b>}
      </span>
    </>
  )
  return (
    <div className={`act ${bad ? 'is-bad' : ''} ${going ? 'is-going' : ''}`}>
      {e.output ? (
        <button className="act-row" onClick={onToggle} aria-expanded={showing}>
          {body}
        </button>
      ) : (
        <div className="act-row">{body}</div>
      )}
      {showing && e.output && <pre>{e.output}</pre>}
    </div>
  )
}

function StatusText({ status }: { status: Run['steps'][number]['status'] }): ReactNode {
  if (status === 'running')
    return (
      <span className="status is-working">
        <Spinner />
        Working
      </span>
    )
  if (status === 'waiting_approval') return <span className="status is-you">Needs you</span>
  if (status === 'pending') return <span className="status">Up next</span>
  if (status === 'skipped') return <span className="status">Skipped</span>
  if (status === 'stubbed') return <span className="status is-you">Not run</span>
  return (
    <span className={`status ${status === 'failed' ? 'is-bad' : 'is-ok'}`}>
      <StepNode status={status} />
      {status === 'failed' ? 'Failed' : 'Done'}
    </span>
  )
}

/* ---------- the team ---------- */

function Team({ team, now }: { team: AgentLive[]; now: number }) {
  const sorted = [...team].sort((a, b) => Number(b.status !== 'idle') - Number(a.status !== 'idle'))
  return (
    <main className="team">
      <section className="table">
        <header>
          <Icon d={I.team} />
          <b>{team.length} agents</b>
          <span>{team.filter((a) => a.status !== 'idle').length} active</span>
        </header>
        {sorted.length === 0 && <p className="table-empty">The team shows up here once Oggy reaches Switch.</p>}
        {sorted.map((a) => {
          const last = a.steps.at(-1)
          return (
            <div key={a.alias} className={`row is-${a.status}`} style={{ '--agent': a.alias } as CSSProperties}>
              <div className="row-head">
                <Who name={a.alias} />
                <span className="row-what">
                  <b className="clip">{a.alias[0].toUpperCase() + a.alias.slice(1)}</b>
                  <small className="clip">{a.status === 'idle' ? a.does : (a.task ?? a.does)}</small>
                </span>
                <span className="row-who clip">{a.status !== 'idle' && last ? `${last.text} ${last.detail ?? ''}` : (a.project ?? '')}</span>
                <span className="row-time">{a.since && a.status !== 'idle' ? clock(now - a.since) : a.lastAt ? ago(a.lastAt, now) : ''}</span>
                {a.status === 'working' ? (
                  <span className="status is-working">
                    <Spinner />
                    Working
                  </span>
                ) : a.status === 'waiting' ? (
                  <span className="status is-you">Needs you</span>
                ) : (
                  <span className="status">Free</span>
                )}
              </div>
              {a.status !== 'idle' && a.steps.length > 0 && (
                <div className="row-body">
                  <LiveSteps agent={a} now={now} max={4} />
                </div>
              )}
            </div>
          )
        })}
      </section>
    </main>
  )
}

