import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isEveryday, nextRun, scheduleText } from '@shared/everyday'
import type { Run, StepTemplate, Workflow } from '@shared/types'
import { clock, whoWhat } from './JobCard'
import { ago, EverydayHome, isOver, runWords, when } from './Everyday'
import { Pet } from './Pet'
import { Crew, I, Icon, Spinner, Who } from './ui'

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
/** Coding workflows or everyday ones: managed apart, each on its own tab. */
export type FlowKind = 'code' | 'everyday'
export const kindOf = (steps: Pick<StepTemplate, 'kind' | 'args'>[]): FlowKind => (isEveryday(steps) ? 'everyday' : 'code')

/** Starting points for a first workflow of each kind: what a description sounds like. */
const EXAMPLES = [
  'Create a workflow called Bug Bash where scout finds the cause in my portfolio, frontend fixes it, tester proves it, and reviewer checks it before anyone ships',
  'Create a workflow called Release Day where tester runs everything in paytrack while reviewer reads the changes, then ask me before release deploys it',
  'Create a workflow called Inbox Zero where assistant reads my unread mail, skips newsletters, and adds the real tasks to my Notion page To-do, then tells me how many. Run it every weekday at 9am',
  'Create a workflow called Morning Brief where assistant sums up today’s meetings, emails that need a reply and overdue Notion tasks, and posts it in oggy-daily every day at 8:30'
]
const EXAMPLES_OF: Record<FlowKind, string[]> = { code: EXAMPLES.slice(0, 2), everyday: EXAMPLES.slice(2) }

/** What each tab's empty page says. */
const FIRST: Record<FlowKind, { title: string; text: string; how: [string, string][] }> = {
  code: {
    title: 'Teach Oggy a coding workflow',
    text: 'Describe what your team should do, in your own words. Oggy draws it, saves it, and runs it whenever you say its name.',
    how: [['Describe it', 'Who does what, and who approves'], ['Check the drawing', 'Every step, agent and approval'], ['Say its name', 'It runs here, and in Switch']]
  },
  everyday: {
    title: 'Give your day a routine',
    text: 'Tell Oggy what your assistant should read, what to do with it, and when. It reads your mail and calendar, writes in Notion, and tells you what it found in #oggy-daily.',
    how: [['Say what and when', '“Every weekday at 9am”'], ['It runs by itself', 'Or when you say its name'], ['Read what it found', 'Here, and in #oggy-daily']]
  }
}

/** How long a design's outcome stays on screen: Oggy keeps a question open this long too. */
const DESIGN_MS = 10 * 60_000

/** Describing a workflow, or being asked about one. */
const isDesign = (r: Run) => r.intent === 'workflow.create' || (/\bworkflow\b/i.test(r.command) && (r.label === 'Question' || r.steps.some((s) => /build that workflow/i.test(s.title))))

/** The workflow being described right now, or the question or problem it came back with. */
export function designRun(runs: Run[]): Run | undefined {
  return runs.find((r) => {
    if (Date.now() - r.updatedAt > DESIGN_MS) return false
    if (isDesign(r)) return !isOver(r) || r.status === 'failed' || r.intent !== 'workflow.create'
    return /\bworkflow\b/i.test(r.command) && !isOver(r) && !r.steps.length
  })
}

/** Workflow jobs live in Workflows, not with coding. A run of a deleted workflow has nowhere to be drawn, so it stays a plain task. */
export const inWorkflows = (run: Run, workflows: Workflow[]) => isDesign(run) || workflows.some((w) => w.id === run.workflowId)

/** What you typed in the Workflows view, as a command: a description unless it's clearly something else. */
export function asWorkflowCommand(text: string, answering: boolean) {
  return answering || /^(?:run|start|replay|show|list)\b/i.test(text) || /\b(?:create|make|build|design|new)\b.*\bworkflow\b/i.test(text) ? text : `create a workflow: ${text}`
}

/* ---------- the drawing ---------- */

const NODE_H = 64
const NODE_W = 252
const GAP_Y = 46
const GAP_X = 14
/** The line that starts it, above the first row. */
const START_H = 30
const TOP = START_H + GAP_Y - 8

interface Placed {
  step: StepTemplate
  x: number
  y: number
  width: number
  rank: number
}

/** Its row: one below the last thing it waits for, so parallel steps sit side by side. */
function ranksOf(steps: StepTemplate[]): Map<string, number> {
  const ranks = new Map<string, number>()
  const rank = (s: StepTemplate, seen: string[]): number => {
    const known = ranks.get(s.id)
    if (known !== undefined) return known
    const parents = (s.after ?? []).filter((a) => !seen.includes(a)).map((a) => steps.find((x) => x.id === a)).filter((p): p is StepTemplate => Boolean(p))
    const r = parents.length ? 1 + Math.max(...parents.map((p) => rank(p, [...seen, s.id]))) : 0
    ranks.set(s.id, r)
    return r
  }
  for (const s of steps) rank(s, [])
  return ranks
}

/** Lines to draw: every wait, minus the ones already implied by a longer path. */
function edgesOf(steps: StepTemplate[]): { from: string; to: string }[] {
  const reaches = (a: string, b: string, seen = new Set<string>()): boolean => {
    if (a === b) return true
    if (seen.has(a)) return false
    seen.add(a)
    return steps.filter((s) => s.after?.includes(a)).some((s) => reaches(s.id, b, seen))
  }
  return steps.flatMap((s) =>
    (s.after ?? [])
      .filter((a) => !(s.after ?? []).some((other) => other !== a && reaches(a, other)))
      .map((a) => ({ from: a, to: s.id }))
  )
}

function place(steps: StepTemplate[], width: number): { nodes: Placed[]; height: number; rows: number[] } {
  const ranks = ranksOf(steps)
  const rows = Math.max(0, ...ranks.values()) + 1
  const counts = Array.from({ length: rows }, (_, r) => steps.filter((s) => ranks.get(s.id) === r).length)
  const widest = Math.max(1, ...counts)
  const w = Math.min(NODE_W, (width - GAP_X * (widest - 1)) / widest)
  const seen = new Array(rows).fill(0)
  const nodes = steps.map((step) => {
    const rank = ranks.get(step.id) ?? 0
    const row = (width - (counts[rank] * w + (counts[rank] - 1) * GAP_X)) / 2
    return { step, rank, width: w, x: row + seen[rank]++ * (w + GAP_X), y: TOP + rank * (NODE_H + GAP_Y) }
  })
  return { nodes, height: TOP + rows * NODE_H + (rows - 1) * GAP_Y, rows: counts }
}

const who = (s: StepTemplate) => whoWhat({ ...s, status: 'pending' }).who
const what = (s: StepTemplate) => cap(whoWhat({ ...s, status: 'pending' }).what)
const asksWord = (s: StepTemplate) => (s.ask ? (s.ask.who.length ? `${s.ask.who.join(' & ')} approves` : 'You approve') : '')
const tagOf = (s: StepTemplate) => (s.kind === 'deploy' ? (s.args?.rollback ? 'Rollback' : 'Deploy') : s.kind === 'room.post' ? 'Posts' : '')
const nameOf = (s: StepTemplate) => cap(who(s) ?? 'Oggy')

function FlowNode({ node, picked, onPick }: { node: Placed; picked: boolean; onPick: () => void }) {
  const s = node.step
  const name = who(s)
  const tag = tagOf(s)
  return (
    <button
      className={`fn ${s.when ? 'is-maybe' : ''} ${picked ? 'is-picked' : ''}`}
      style={{ left: node.x, top: node.y, width: node.width, height: NODE_H }}
      title={briefOf(s) === what(s) ? what(s) : `${what(s)}

${briefOf(s)}`}
      onClick={onPick}
    >
      {name ? <Who name={name} size={30} /> : <span className="who is-oggy fn-oggy"><Pet size={18} /></span>}
      <span className="fn-text">
        <b className="clip">{what(s)}</b>
        <small className="clip">
          {nameOf(s)}
          {tag && <em>{tag}</em>}
          {s.question && <em>Decides</em>}
        </small>
      </span>
    </button>
  )
}

/** The workflow, top to bottom from what starts it: what happens at once side by side, what stands in the way on the line. */
export function Flow({ steps, say, picked, onPick }: { steps: StepTemplate[]; say: string; picked?: string; onPick: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!box.current) return
    const read = () => setWidth(box.current?.clientWidth ?? 0)
    read()
    const watch = new ResizeObserver(read)
    watch.observe(box.current)
    return () => watch.disconnect()
  }, [])
  const { nodes, height, rows } = useMemo(() => place(steps, Math.max(width, 240)), [steps, width])
  const edges = useMemo(() => edgesOf(steps), [steps])
  const at = (id: string) => nodes.find((n) => n.step.id === id)!
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const bend = Math.max(16, (y2 - y1) / 2)
    return `M${x1} ${y1} C${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
  }
  return (
    <div ref={box} className="flow" style={{ height }}>
      {width > 0 && (
        <>
          <svg className="flow-lines" width={width} height={height} aria-hidden>
            <defs>
              <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M1 1l6 3-6 3" className="flow-head" />
              </marker>
            </defs>
            {nodes
              .filter((n) => n.rank === 0)
              .map((n) => (
                <path key={n.step.id} d={curve(width / 2, START_H, n.x + n.width / 2, n.y - 2)} className="flow-line is-start" markerEnd="url(#flow-arrow)" />
              ))}
            {edges.map((e) => {
              const a = at(e.from)
              const b = at(e.to)
              return <path key={`${e.from}${e.to}`} d={curve(a.x + a.width / 2, a.y + NODE_H, b.x + b.width / 2, b.y - 2)} className={`flow-line ${b.step.when?.step === e.from ? 'is-maybe' : ''}`} markerEnd="url(#flow-arrow)" />
            })}
          </svg>
          <span className="flow-start">
            <Icon d={I.play} />
            {say}
          </span>
          {rows.map((n, r) => {
            if (n < 2) return null
            const row = nodes.filter((p) => p.rank === r)
            const left = Math.min(...row.map((p) => p.x)) - 8
            return (
              <span key={r} className="flow-lane" style={{ left, top: row[0].y - 8, width: Math.max(...row.map((p) => p.x + p.width)) + 8 - left, height: NODE_H + 16 }}>
                <span className="flow-note">At the same time</span>
              </span>
            )
          })}
          {nodes.map((n) => (
            <span key={n.step.id}>
              {(n.step.when || n.step.ask) && (
                <span className="flow-gate" style={{ left: n.x + n.width / 2, top: n.y - GAP_Y / 2 - 1 }}>
                  {n.step.when && <span className="flow-if">Only if {n.step.when.is}</span>}
                  {n.step.ask && <span className="flow-ask"><Icon d={I.person} />{asksWord(n.step)}</span>}
                </span>
              )}
              <FlowNode node={n} picked={picked === n.step.id} onPick={() => onPick(n.step.id)} />
            </span>
          ))}
        </>
      )}
    </div>
  )
}

/* ---------- the page ---------- */

/** What this step would do with nothing to say for itself. */
function briefOf(s: StepTemplate) {
  if (typeof s.args?.prompt === 'string') return s.args.prompt
  if (s.args?.rollback) return 'Reverts the last deploy on the live branch, then checks the site.'
  if (s.kind === 'deploy') return 'Ships the project, then checks the site.'
  return s.kind === 'room.post' ? `Posts the last report in #${s.args?.room ?? 'team'}.` : s.title
}

/** Everything about the step you picked on the canvas. */
function StepPanel({ step: s, steps }: { step: StepTemplate; steps: StepTemplate[] }) {
  const name = who(s)
  const before = (s.after ?? []).map((a) => steps.find((x) => x.id === a)).filter((p): p is StepTemplate => Boolean(p))
  const when = s.when && steps.find((x) => x.id === s.when!.step)
  return (
    <section className="wf-step" key={s.id}>
      <p className="wf-label">
        Step {steps.indexOf(s) + 1} of {steps.length}
      </p>
      <header>
        {name ? <Who name={name} size={30} /> : <span className="who is-oggy fn-oggy"><Pet size={18} /></span>}
        <div>
          <h2>{what(s)}</h2>
          <small>
            {nameOf(s)}
            {tagOf(s) && ` · ${tagOf(s)}`}
          </small>
        </div>
      </header>
      <dl>
        <dt>Brief</dt>
        <dd>{briefOf(s)}</dd>
        {s.question && (
          <>
            <dt>Decides</dt>
            <dd>{s.question}</dd>
          </>
        )}
        {when && (
          <>
            <dt>Runs only if</dt>
            <dd>
              {when.question ?? what(when)} <b>{cap(s.when!.is)}</b>
            </dd>
          </>
        )}
        {s.ask && (
          <>
            <dt>{asksWord(s)}</dt>
            <dd>
              {s.ask.question}
              <i>A no {s.ask.ifNo === 'continue' ? 'skips this step and carries on' : 'stops the workflow'}.</i>
            </dd>
          </>
        )}
        {before.length > 0 && (
          <>
            <dt>Waits for</dt>
            <dd>{before.map(what).join(', ')}</dd>
          </>
        )}
      </dl>
    </section>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const crewOf = (w: Workflow) => [...new Set(w.steps.map(who).filter((a): a is string => Boolean(a)))]

/** One run of a workflow, in the home page's lists. */
function RunRow({ run, name, now, onOpen }: { run: Run; name: string; now: number; onOpen: () => void }) {
  const words = runWords(run)
  return (
    <div className="row is-wf-run">
      <button className="row-head" onClick={onOpen} title={run.summary ?? run.command}>
        <span className={`state ${words.cls === 'is-ok' ? 'is-done' : words.cls === 'is-you' ? 'is-you' : words.cls === 'is-working' ? 'is-working' : ''}`}>{words.cls === 'is-working' && <Spinner />}</span>
        <span className="row-what">
          <b className="clip">{name}</b>
          <small className="clip">{run.summary ?? run.command}</small>
        </span>
        <span className={`status ${words.cls}`}>{words.text}</span>
        <span className="row-time">{clock((isOver(run) ? run.updatedAt : now) - run.createdAt)}</span>
        <time className="row-time">{when(run.createdAt)}</time>
      </button>
    </div>
  )
}

/** Every coding workflow you've saved, what each one does, and everything they've run. */
function Home(props: { workflows: Workflow[]; runs: Run[]; now: number; online: boolean; onPick: (id: string) => void; onRun: (w: Workflow) => void; onView: (runId: string) => void }) {
  const { workflows, now } = props
  const all = useMemo(() => props.runs.filter((r) => r.workflowId), [props.runs])
  const going = all.filter((r) => !isOver(r))
  const past = all.filter(isOver)
  const nameOf = (r: Run) => workflows.find((w) => w.id === r.workflowId)?.name ?? r.label ?? r.command
  const row = (r: Run) => <RunRow key={r.id} run={r} name={nameOf(r)} now={now} onOpen={() => props.onView(r.id)} />
  return (
    <div className="daily wf-home">
      <header className="daily-head">
        <h1>Coding workflows</h1>
        <p>
          <span>{plural(workflows.length, 'workflow')}</span>
          <span>{plural(past.length, 'past run')}</span>
        </p>
      </header>

      {going.length > 0 && (
        <section className="table">
          <header>
            <b>Running now</b>
            <span>{going.length}</span>
          </header>
          {going.map(row)}
        </section>
      )}

      <div className="wf-cols">
      <section className="table">
        <header>
          <b>Saved</b>
          <span>{workflows.length}</span>
        </header>
        {workflows.map((w) => {
          const crew = crewOf(w)
          const busy = going.some((r) => r.workflowId === w.id)
          return (
            <div key={w.id} className="row is-saved">
              <button className="row-head" onClick={() => props.onPick(w.id)} title={w.description}>
                <span className="day-ico"><Icon d={I.flow} /></span>
                <span className="row-what">
                  <b className="clip">{w.name}</b>
                  {w.description && <small className="wf-does">{w.description}</small>}
                  <small className="wf-meta clip">
                    {[w.project, w.schedule && scheduleText(w.schedule), plural(w.steps.length, 'step'), w.lastRunAt ? `Last run ${ago(w.lastRunAt, now)}` : 'Never run'].filter(Boolean).join(' · ')}
                  </small>
                </span>
                {crew.length > 0 ? <Crew names={crew} /> : <span />}
              </button>
              <button className="btn is-quiet" disabled={!props.online || busy} title={busy ? 'It’s running' : `Run ${w.name}`} onClick={() => props.onRun(w)}>
                <Icon d={I.play} />
                Run
              </button>
            </div>
          )
        })}
      </section>

      <section className="table">
        <header>
          <b>Past runs</b>
          <span>{past.length}</span>
        </header>
        {past.length === 0 && <p className="table-empty">Nothing has run yet.</p>}
        {past.map(row)}
      </section>
      </div>
    </div>
  )
}

export function Workflows(props: {
  workflows: Workflow[]
  selected?: string
  runs: Run[]
  now: number
  online: boolean
  /** The design the note is about, unless you dismissed it. */
  design?: Run
  /** The run you have open. */
  open?: Run
  onDismiss: (runId: string) => void
  onOpen: (runId?: string) => void
  onPick: (id?: string) => void
  /** Any workflow's run, even one whose workflow is gone. */
  onView: (runId: string) => void
  onRun: (w: Workflow) => void
  onExample: (text: string) => void
  /** Which tab you're on. */
  kind: FlowKind
  onKind: (kind: FlowKind) => void
  /** The running job: a coding one on the task screen, an everyday one on its own. */
  renderRun: (run: Run) => ReactNode
}) {
  const { workflows, runs, now, design, open } = props
  const wf = workflows.find((w) => w.id === props.selected)
  const [sure, setSure] = useState(false)
  const [picked, setPicked] = useState<string>()
  useEffect(() => {
    setSure(false)
    setPicked(undefined)
  }, [wf?.id])

  const theirs = useMemo(() => (wf ? runs.filter((r) => r.workflowId === wf.id) : []), [runs, wf])
  const active = theirs.find((r) => !isOver(r))
  const agents = wf ? crewOf(wf) : []
  const approvals = wf?.steps.filter((s) => s.ask).length ?? 0
  const step = wf?.steps.find((s) => s.id === picked) ?? wf?.steps[0]
  const say = wf ? `run ${wf.name} workflow` : ''
  const kindOfRun = (r: Run) => kindOf(workflows.find((w) => w.id === r.workflowId)?.steps ?? r.steps)
  const flowRuns = runs.filter((r) => r.workflowId)
  const count = (k: FlowKind) => workflows.filter((w) => kindOf(w.steps) === k).length
  const mine = workflows.filter((w) => kindOf(w.steps) === props.kind)
  const mineRuns = flowRuns.filter((r) => kindOfRun(r) === props.kind)
  const first = FIRST[props.kind]

  return (
    <main className="wf">
      {design && (
        <div className={`wf-note is-${design.status === 'failed' ? 'bad' : design.label === 'Question' ? 'ask' : 'busy'}`} role="status">
          {design.label !== 'Question' && design.status !== 'failed' && <Spinner />}
          <p>{design.status === 'failed' ? design.summary : design.label === 'Question' ? design.summary : 'Designing your workflow…'}</p>
          {isOver(design) && (
            <button className="icon-btn" aria-label="Dismiss" onClick={() => props.onDismiss(design.id)}>
              <Icon d={I.close} />
            </button>
          )}
        </div>
      )}

      {!wf && (
        <nav className="wf-tabs" aria-label="Kind of workflow">
          {(['code', 'everyday'] as FlowKind[]).map((k) => (
            <button key={k} className={props.kind === k ? 'is-on' : ''} onClick={() => props.onKind(k)}>
              <Icon d={k === 'code' ? I.code : I.sun} />
              {k === 'code' ? 'Coding' : 'Everyday'}
              <em>{count(k)}</em>
            </button>
          ))}
        </nav>
      )}

      {!wf && (mine.length > 0 || mineRuns.length > 0) &&
        (props.kind === 'everyday' ? (
          <EverydayHome workflows={mine} runs={mineRuns} now={now} online={props.online} onPick={props.onPick} onRun={props.onRun} onView={props.onView} />
        ) : (
          <Home workflows={mine} runs={mineRuns} now={now} online={props.online} onPick={props.onPick} onRun={props.onRun} onView={props.onView} />
        ))}

      {!wf && !mine.length && !mineRuns.length && (
        <div className={`wf-empty is-${props.kind}`}>
          <Pet mood="idle" look={props.kind === 'everyday' ? 'beach' : 'coder'} size={44} />
          <h1>{first.title}</h1>
          <p>{first.text}</p>
          <ol className="wf-how">
            {first.how.map(([b, t]) => (
              <li key={b}>
                <b>{b}</b>
                {t}
              </li>
            ))}
          </ol>
          <ul>
            {EXAMPLES_OF[props.kind].map((e) => (
              <li key={e}>
                <button onClick={() => props.onExample(e)}>{e}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {wf && open && (
        <>
          <header className="wf-head is-run">
            <button className="icon-btn wf-back" aria-label="Back to the workflow" title="Back to the workflow" onClick={() => props.onOpen(undefined)}>
              <Icon d="M10 4L6 8l4 4" />
            </button>
            <h1>{wf.name}</h1>
            <span className={`status ${runWords(open).cls}`}>{runWords(open).text}</span>
            <span className="grow" />
            {isOver(open) && !active && (
              <button className="btn" disabled={!props.online} onClick={() => props.onRun(wf)}>
                <Icon d={I.play} />
                Run again
              </button>
            )}
          </header>
          {props.renderRun(open)}
        </>
      )}

      {wf && !open && (
        <>
          <header className="wf-head">
            <button className="icon-btn wf-back" aria-label="All workflows" title="All workflows" onClick={() => props.onPick(undefined)}>
              <Icon d="M10 4L6 8l4 4" />
            </button>
            <div className="wf-title">
              <h1>{wf.name}</h1>
              {wf.description && <p title={wf.description}>{wf.description}</p>}
              <ul className="wf-facts">
                {isEveryday(wf.steps) && (
                  <li>
                    <Icon d={I.sun} />
                    Everyday
                  </li>
                )}
                {wf.schedule && (
                  <li title={`Next run ${when(nextRun(wf.schedule, now) ?? now)}`}>
                    <Icon d={I.calendar} />
                    {scheduleText(wf.schedule)}
                  </li>
                )}
                {wf.project && (
                  <li>
                    <Icon d={I.folder} />
                    {wf.project}
                  </li>
                )}
                {agents.length > 0 && (
                  <li>
                    <Crew names={agents} />
                    {agents.length} agent{agents.length === 1 ? '' : 's'}
                  </li>
                )}
                <li>
                  {wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}
                </li>
                {approvals > 0 && (
                  <li>
                    {approvals} approval{approvals === 1 ? '' : 's'}
                  </li>
                )}
                <li>{wf.lastRunAt ? `Last run ${ago(wf.lastRunAt, now)}` : 'Never run'}</li>
              </ul>
            </div>
            <button
              className={`btn is-quiet ${sure ? 'is-danger' : ''}`}
              disabled={Boolean(active)}
              title={active ? 'It’s running' : undefined}
              onClick={() => {
                if (sure) void window.oggy.deleteWorkflow(wf.id).catch(() => {})
                setSure(!sure)
              }}
              onBlur={() => setSure(false)}
            >
              {sure ? 'Delete it?' : 'Delete'}
            </button>
            {active ? (
              <button className="btn" onClick={() => props.onOpen(active.id)}>
                <Spinner />
                Open run
              </button>
            ) : (
              <button className="btn is-primary" disabled={!props.online} onClick={() => props.onRun(wf)} title={`Same as saying “${say}”`}>
                <Icon d={I.play} />
                Run
              </button>
            )}
          </header>

          <div className="wf-body">
            <div className="wf-canvas">
              <Flow steps={wf.steps} say={say} picked={step?.id} onPick={setPicked} />
            </div>
            <aside className="wf-side">
              {step && <StepPanel key={step.id} step={step} steps={wf.steps} />}
              <section className="wf-runs">
                <p className="wf-label">
                  Runs
                  <span>{theirs.length}</span>
                </p>
                {theirs.length === 0 && <p className="wf-none">Not run yet.</p>}
                {theirs.map((r) => (
                  <button key={r.id} className="wf-run" onClick={() => props.onOpen(r.id)} title={r.summary ?? r.command}>
                    <span className={`status ${runWords(r).cls}`}>{runWords(r).text}</span>
                    <span className="clip">{r.summary ?? r.command}</span>
                    <time>{isOver(r) ? clock(r.updatedAt - r.createdAt) : ago(r.createdAt, now)}</time>
                  </button>
                ))}
              </section>
            </aside>
          </div>
        </>
      )}
    </main>
  )
}
