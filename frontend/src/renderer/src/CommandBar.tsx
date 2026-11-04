import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { AgentLive, Approval, FileChange, Review, Run } from '@shared/types'
import { clock, JobLine, JobPanel, projectOf, tidy, useNow, whoWhat, type ActivityLine } from './JobCard'
import { loadCorner, saveCorner, useIslandDrag, type Corner } from './island'
import { OggyApp, type AppView, type QA } from './OggyApp'
import { Pet, type Mood } from './Pet'
import { moodOf, opensItself } from './scene'
import { useOggy, type FeedLine } from './store'

type Status = 'idle' | 'sending' | 'sent' | 'error'

/** The command you last sent, followed live until it's done. */
interface Job {
  run: Run
  lines: ActivityLine[]
  approval: Approval | null
  /** Files the agents changed so far (live, from git). */
  changes: FileChange[]
  /** Oggy's explanation of those changes, and your decision on them. */
  review: Review | null
  /** While a change you asked for is being made: the review it came from (the screen keeps showing it). */
  prevReview: Review | null
  /** The latest live line of each step ("@backend: running the tests"). */
  stepLines: Record<string, string>
  /** The last few things each step did, newest last (the live feed in the workspace). */
  stepFeed: Record<string, FeedLine[]>
  /** Oggy's last spoken line, shown in italics. */
  said?: string
  /** Your questions in the workspace and Oggy's answers. */
  qa: QA[]
}

const FEED_LINES = 4
const DONE_LINGER_MS = 9000
const isFinished = (run: Run) => run.status === 'done' || run.status === 'failed' || run.status === 'cancelled'
/** The changes are being explained or wait for your decision: the panel stays until you decide. */
const awaitsYou = (j: Job | null) => j?.review?.status === 'explaining' || j?.review?.status === 'ready'
const fresh = (run: Run, first = 'Sent'): Job => ({ run, lines: [{ id: Date.now(), text: first }], approval: null, changes: [], review: null, prevReview: null, stepLines: {}, stepFeed: {}, qa: [] })
const FEED_PER_STEP = 6
/** "show me", "show the changes", "open the review": the workspace. */
/** "show the team", "who's working", "what is everyone doing": the Team view. */
const TEAM = /^(?:show (?:me )?(?:the )?team|(?:the )?team|open (?:the )?team|who(?:'s| is) (?:working|busy|free)|what(?:'s| is) (?:everyone|the team) (?:doing|working on))\W*$/i
const SHOW_ME = /^(?:show(?: me)?(?: (?:it|them|the (?:changes|code|review|diff)))?|open (?:the )?review|let me see|review it)\W*$/i
/** A spoken answer to "Frontend wants to run npm ci. OK?" */
const YES = /^(?:yes|yeah|yep|yup|ok|okay|sure|go ahead|go|do it|allow|run it|fine)\b/i
const NO = /^(?:no|nope|skip|don'?t|do not|stop|cancel|not now)\b/i
/** "open it in vs code", "open this project in vs": a command, never a question about the review. */
const OPEN_IN_CODE = /^open\b.*\b(?:in|with)\s+(?:vs\s?code|vs|visual\s+studio(?:\s+code)?|code|(?:the\s+)?editor)\W*$/i
/** Decisions are answered by the panel itself, not as questions. */
const DECISION = /^(?:keep|undo|change\b|looks good|lgtm|yes|no\b)/i

/** A chunk of text that arrived at once (Wispr Flow dictation, paste) and is being revealed word by word. */
interface Reveal {
  id: number
  start: number
  end: number
}

/** Matches .ws leaving in workspace.css. */
const SCREEN_LEAVE_MS = 200
/** The island waits a moment before closing, so brushing past it doesn't make it flap. */
const COLLAPSE_MS = 380
const RECENTS = 3
/** Matches BAR_LEAVE_MS in the main process, plus a frame. */
const HIDE_MS = 170

const MAX_HEIGHT = 168 // ~6 lines, then the field scrolls
const WORD_STAGGER_MS = 38
const MAX_STAGGER_MS = 720
const WORD_IN_MS = 520

function changedRange(prev: string, next: string) {
  let start = 0
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++
  let tail = 0
  while (tail < prev.length - start && tail < next.length - start && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  return { start, end: next.length - tail }
}

/**
 * Ctrl+Space. One surface with two shapes: the bar you speak into, and the island that carries on
 * with the job in a corner. Speak with Wispr Flow (it types here) or type, then Enter.
 */
export function CommandBar() {
  const store = useOggy()
  const field = useRef<HTMLTextAreaElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const revealId = useRef(0)
  const [visible, setVisible] = useState(true)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [height, setHeight] = useState(28)
  const [job, setJob] = useState<Job | null>(null)
  const jobRef = useRef(job)
  jobRef.current = job
  const lineId = useRef(0)
  const qaId = useRef(0)
  const hovering = useRef(false)
  const collapse = useRef<number>()
  /** The pointer is over the island, or was a moment ago. */
  const [over, setOver] = useState(false)
  const [focused, setFocused] = useState(false)
  /** The corner the island lives in (kept for next time). */
  const [corner, setCorner] = useState<Corner>(loadCorner)
  const stage = useRef<HTMLDivElement>(null)
  const isle = useRef<HTMLDivElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  /** Held or still landing: the window must keep taking the mouse even if the pointer outruns the island. */
  const [held, setHeld] = useState(false)
  const heldNow = useRef(false)
  /** In your hand right now. */
  const [lifted, setLifted] = useState(false)
  /** What you asked for lately, under the empty bar. */
  const [recents, setRecents] = useState<string[]>([])
  const [pick, setPick] = useState(-1)
  /** The app is open over the desktop ("show me", "show the team"), and which view of it. */
  const [screen, setScreen] = useState(false)
  const [appView, setAppView] = useState<AppView>('task')
  const screenOpen = useRef(false)
  /** The big screen is on its way out. */
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef<number>()
  /** Everyone on the team, live (from the backend's watch on their sessions). */
  const [team, setTeam] = useState<AgentLive[]>([])

  useEffect(() => {
    void window.oggy.getTeam().then(setTeam).catch(() => {})
    return window.oggy.onEvent((e) => {
      if (e.type === 'team') setTeam(e.agents)
    })
  }, [])

  // While a job is on screen the bar becomes the island, out of the way of the work it's doing.
  const docked = Boolean(job)
  /** It opens when you reach for it, and by itself when it has something to tell you. */
  const open = docked && (over || focused || lifted || status === 'error' || Boolean(job?.approval) || awaitsYou(job) || Boolean(job && isFinished(job.run)))
  const jobRunId = job?.run.id
  const jobStatus = job?.run.status
  const reviewStatus = job?.review?.status
  /** A finished job with a project has a next step (open it, see the workspace): it stays until you dismiss it. */
  const keepsCard = Boolean(job && projectOf(job.run))

  useEffect(
    () =>
      window.oggy.onEvent((e) => {
        setJob((j) => {
          if (!j) return j
          if (e.type === 'run.updated' && e.run.id === j.run.id) return { ...j, run: e.run }
          if (e.type === 'run.activity' && e.runId === j.run.id) {
            // A step's line goes next to that step; the rest ("Planning…") is the job's own.
            if (e.stepId) {
              if (j.stepLines[e.stepId] === e.text) return j
              const feed = [...(j.stepFeed[e.stepId] ?? []), { id: ++lineId.current, text: e.text, at: Date.now() }].slice(-FEED_PER_STEP)
              return { ...j, stepLines: { ...j.stepLines, [e.stepId]: e.text }, stepFeed: { ...j.stepFeed, [e.stepId]: feed } }
            }
            if (j.lines.at(-1)?.text === e.text) return j
            return { ...j, lines: [...j.lines, { id: ++lineId.current, text: e.text }].slice(-FEED_LINES) }
          }
          if (e.type === 'show' && e.runId === j.run.id && e.effect.kind === 'say') return { ...j, said: e.effect.text }
          if (e.type === 'run.changes' && e.runId === j.run.id) return { ...j, changes: e.files }
          if (e.type === 'run.review' && e.review.runId === j.run.id) return { ...j, review: e.review }
          if (e.type === 'approval.requested' && e.approval.runId === j.run.id) return { ...j, approval: e.approval }
          if (e.type === 'approval.decided' && e.approval.id === j.approval?.id) return { ...j, approval: null }
          return j
        })
      }),
    []
  )

  // While a job runs the island stays up; when it finishes or needs you, it pops back into view.
  useEffect(() => {
    if (!jobRunId || !jobStatus) return
    const finished = jobStatus === 'done' || jobStatus === 'failed' || jobStatus === 'cancelled'
    const deciding = reviewStatus === 'explaining' || reviewStatus === 'ready'
    window.oggy.setBarPinned(!finished || deciding)
    if (jobStatus === 'waiting_approval' || reviewStatus === 'ready') window.oggy.peekCommandBar()
    if (!finished) return
    window.oggy.peekCommandBar()
    // Keep "Stuck" up until you dismiss it, and changes until you decide.
    if (jobStatus !== 'done' || deciding || keepsCard) return
    const t = setTimeout(() => {
      if (!hovering.current && !field.current?.value) window.oggy.hideCommandBar()
    }, DONE_LINGER_MS)
    return () => clearTimeout(t)
  }, [jobRunId, jobStatus, reviewStatus, keepsCard])

  const dragHandlers = useIslandDrag({
    stage,
    isle,
    enabled: docked,
    onHold: (h) => {
      heldNow.current = h
      if (h) window.oggy.setBarInteractive(true)
      else if (!hovering.current) window.oggy.setBarInteractive(false)
      setHeld(h)
    },
    onLift: setLifted,
    onCorner: (c) => flushSync(() => setCorner(c))
  })

  /* Double-click puts it back in the top-right corner. */
  function resetDock(e: ReactMouseEvent) {
    const target = e.target as HTMLElement
    if (!job || !target.closest('[data-drag]') || target.closest('button')) return
    setCorner('tr')
    saveCorner('tr')
  }

  /** Close everything on screen. The job itself carries on, and it's on the board. */
  function dismissJob() {
    closeScreen()
    window.oggy.setBarPinned(false)
    window.oggy.hideCommandBar()
    // Once it has faded: clearing the job now would slide the island to the centre on its way out.
    const id = job?.run.id
    setTimeout(() => setJob((j) => (j?.run.id === id ? null : j)), HIDE_MS)
  }

  /** Put the big window away: back to the island with a job on, off the screen without one. */
  function tuckAway() {
    closeScreen()
    if (!jobRef.current) window.oggy.hideCommandBar()
  }

  function openScreen(focus = true, view: AppView = 'task') {
    window.clearTimeout(leaveTimer.current)
    setLeaving(false)
    screenOpen.current = true
    setAppView(view)
    setScreen(true)
    window.oggy.setReviewOpen(true, focus)
  }

  // Oggy starts on something big: the workspace opens by itself and follows along live
  // (without taking your keyboard). Esc or × tucks it back into the island.
  const autoOpened = useRef(new Set<string>())
  const bigJob = Boolean(job && opensItself(job.run))
  useEffect(() => {
    if (!jobRunId || !bigJob || autoOpened.current.has(jobRunId)) return
    autoOpened.current.add(jobRunId)
    if (!screenOpen.current) openScreen(false)
  }, [jobRunId, bigJob]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Plays the way out, then lets the window go back to being small. */
  function closeScreen() {
    if (!screenOpen.current) return
    screenOpen.current = false
    setLeaving(true)
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => {
      setScreen(false)
      setLeaving(false)
      window.oggy.setReviewOpen(false)
      requestAnimationFrame(() => field.current?.focus())
    }, SCREEN_LEAVE_MS)
  }

  const openTeam = () => openScreen(true, 'team')

  /** A command from a button (the Team view, "Open in VS Code"): it runs like any command you typed. */
  function send(text: string) {
    void window.oggy
      .submitCommand(text)
      .then((run) => {
        setJob(fresh(run))
        window.oggy.setBarPinned(true)
      })
      .catch(() => setStatus('error'))
  }

  /**
   * "open it in vs code" while a job is on screen: open its project and keep the job (and its review)
   * where it is. Oggy's reply shows up with your questions.
   */
  function openInCode(said = 'Open in VS Code') {
    const project = job ? projectOf(job.run) : undefined
    void window.oggy.submitCommand(project ? `open my ${project} in vs code` : said).catch(() => setStatus('error'))
    setJob((j) => (j ? { ...j, qa: [...j.qa, { id: ++qaId.current, q: said, a: { text: `Opening ${project ?? 'it'} in VS Code.` } }] } : j))
  }

  /** You asked for a change: follow the new job, keeping the review it came from on screen. */
  function follow(next: Run) {
    setJob((j) => ({ ...fresh(next, 'On it'), prevReview: j?.review ?? j?.prevReview ?? null }))
  }

  /** A click in the panel: the same as saying it. */
  async function decideReview(text: string) {
    if (!job) return
    const r = await window.oggy.decideReview(job.run.id, text).catch(() => null)
    if (r?.followUp) follow(r.followUp)
    else if (r?.review) setJob((j) => (j ? { ...j, review: r.review! } : j))
  }

  /** "yes" / "no" while something waits for your OK (an agent wants to install, build…). */
  function answerApproval(text: string): boolean {
    if (!job?.approval) return false
    if (YES.test(text)) void decide(true)
    else if (NO.test(text)) void decide(false)
    else return false
    return true
  }

  /** What you said or typed in the workspace: a decision, a change, or a question about the code. */
  async function sendFromScreen(text: string) {
    if (!job) return
    if (/^(?:close|hide|done|exit)\W*$/i.test(text)) return closeScreen()
    if (answerApproval(text)) return
    if (OPEN_IN_CODE.test(text)) return openInCode(text)
    const runId = job.run.id
    const id = ++qaId.current
    // Finished with nothing to review: this is the next job, and the room recomposes around it.
    if (!job.review && isFinished(job.run)) return send(text)
    // Still working: say where they are, from what Oggy can see right now.
    if (!job.review) return setJob((j) => (j ? { ...j, qa: [...j.qa, { id, q: text, a: { text: whereThingsStand(j) } }] } : j))
    const asking = !DECISION.test(text)
    if (asking) setJob((j) => (j ? { ...j, qa: [...j.qa, { id, q: text }] } : j))
    const r = await window.oggy.decideReview(runId, text, true).catch(() => null)
    if (r?.followUp) return follow(r.followUp)
    setJob((j) => {
      if (!j || j.run.id !== runId) return j
      const qa = r?.answer ? j.qa.map((x) => (x.id === id ? { ...x, a: r.answer } : x)) : j.qa.filter((x) => x.id !== id)
      return { ...j, qa, review: r?.review ?? j.review }
    })
  }

  async function decide(approve: boolean) {
    if (!job?.approval) return
    const id = job.approval.id
    setJob((j) => (j ? { ...j, approval: null } : j))
    await window.oggy.decideApproval(id, approve).catch(() => {})
  }

  useEffect(() => {
    const focus = () => {
      // The workspace is up: its voice box gets the words (Wispr types where the focus is).
      if (screenOpen.current) return document.querySelector<HTMLInputElement>('.ws-input')?.focus()
      field.current?.focus()
      field.current?.select()
    }
    focus()
    const off = window.oggy.onBarVisible((v, summoned) => {
      setVisible(v)
      // Ctrl+Space after a job finished: a fresh start in the centre, not the old job in the corner.
      if (v && summoned) setJob((j) => (j && isFinished(j.run) && !awaitsYou(j) ? null : j))
      if (v) {
        setStatus((s) => (s === 'sending' ? s : 'idle'))
        requestAnimationFrame(focus)
      } else {
        // Nothing you were doing carries over to the next time it opens.
        window.clearTimeout(collapse.current)
        hovering.current = false
        setOver(false)
        setFocused(false)
        window.oggy.setBarInteractive(false)
      }
    })
    const onFocus = () => focus()
    window.addEventListener('focus', onFocus)
    const offClose = window.oggy.onCloseRequested(() => tuckAwayRef.current())
    return () => {
      off()
      offClose()
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // The ghost mirrors the field's text, so its height drives the field's.
  useLayoutEffect(() => {
    if (ghost.current) setHeight(Math.min(MAX_HEIGHT, ghost.current.scrollHeight))
  }, [text, docked])

  // The island's height follows what's in it, or its head alone when it's closed. Only the shell
  // animates: what's inside keeps its size, so nothing reflows on the way.
  useLayoutEffect(() => {
    const measure = () => {
      if (!shell.current || !inner.current || !top.current) return
      shell.current.style.height = `${!docked || open ? inner.current.offsetHeight : top.current.offsetHeight}px`
    }
    measure()
    const watch = new ResizeObserver(measure)
    if (inner.current) watch.observe(inner.current)
    return () => watch.disconnect()
  }, [docked, open])

  // The empty bar offers what you asked for lately.
  useEffect(() => {
    if (!visible || job) return
    let live = true
    void window.oggy
      .listRuns()
      .then((runs) => {
        if (!live) return
        const mine = runs.filter((r) => r.source === 'desktop').map((r) => r.command)
        setRecents([...new Set(mine)].slice(0, RECENTS))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [visible, job])

  useEffect(() => {
    if (!reveal) return
    const words = text.slice(reveal.start, reveal.end).split(/\s+/).length
    const total = Math.min(MAX_STAGGER_MS, words * WORD_STAGGER_MS) + WORD_IN_MS
    const t = setTimeout(() => setReveal((r) => (r?.id === reveal.id ? null : r)), total)
    return () => clearTimeout(t)
  }, [reveal, text])

  function onChange(next: string) {
    const { start, end } = changedRange(text, next)
    // Typed characters appear as usual; a whole phrase landing at once gets the soft reveal.
    const inserted = next.slice(start, end)
    if (inserted.trim().length >= 3 && end - start > 2) setReveal({ id: ++revealId.current, start, end })
    else setReveal(null)
    setText(next)
    setPick(-1)
    if (status === 'error') setStatus('idle')
  }

  /** The words float away; a tick says they landed. */
  function clearSent() {
    setStatus('sent')
    setTimeout(() => {
      setText('')
      setStatus('idle')
    }, 320)
  }

  async function submit() {
    const value = text.trim()
    if (!value || status === 'sending') return
    setReveal(null)
    setStatus('sending')
    try {
      // Something waits for your OK: "yes" / "no" answers it.
      if (answerApproval(value)) return clearSent()
      // "show the team": the Team view.
      if (TEAM.test(value)) {
        openTeam()
        setText('')
        setStatus('idle')
        return
      }
      // "show me": the workspace.
      if (SHOW_ME.test(value)) {
        openScreen(true, job ? 'task' : 'home')
        setText('')
        setStatus('idle')
        return
      }
      // Changes waiting for you: "open it in vs code" opens the project and leaves the review be.
      if (job?.review?.status === 'ready' && OPEN_IN_CODE.test(value)) {
        openInCode(value)
        return clearSent()
      }
      // "keep it", "undo it", what to change, or a question, goes to the review.
      if (job?.review?.status === 'ready') {
        const r = await window.oggy.decideReview(job.run.id, value)
        if (r.handled) {
          if (r.followUp) follow(r.followUp)
          else if (r.answer) {
            // A question: the answer is in the workspace, next to the code.
            setJob((j) => (j ? { ...j, qa: [...j.qa, { id: ++qaId.current, q: value, a: r.answer }] } : j))
            openScreen()
          } else if (r.review) setJob((j) => (j ? { ...j, review: r.review! } : j))
          return clearSent()
        }
      }
      const run = await window.oggy.submitCommand(value)
      setJob(fresh(run))
      window.oggy.setBarPinned(true)
      // Your words become the island's title as it moves away: nothing left to clear up.
      setText('')
      setPick(-1)
      setStatus('idle')
    } catch {
      setStatus('error')
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
    if (e.key === 'Escape') window.oggy.hideCommandBar()
    // ↑ ↓ walk through what you asked for lately, like a shell's history.
    if (!docked && recents.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!text || pick >= 0)) {
      e.preventDefault()
      const next = pick + (e.key === 'ArrowDown' ? 1 : -1)
      const at = next < -1 ? recents.length - 1 : next >= recents.length ? -1 : next
      setPick(at)
      setText(at < 0 ? '' : recents[at])
    }
  }

  const tuckAwayRef = useRef(tuckAway)
  tuckAwayRef.current = tuckAway

  function chooseRecent(i: number) {
    setPick(i)
    setText(recents[i])
    field.current?.focus()
  }

  function enterIsle() {
    window.clearTimeout(collapse.current)
    hovering.current = true
    window.oggy.setBarInteractive(true)
    setOver(true)
  }

  function leaveIsle() {
    hovering.current = false
    if (!heldNow.current) window.oggy.setBarInteractive(false)
    collapse.current = window.setTimeout(() => setOver(false), COLLAPSE_MS)
  }

  /** A click on the empty bar goes to the field; buttons and the island's handle keep theirs. */
  function aimAtField(e: ReactMouseEvent) {
    const target = e.target as HTMLElement
    if (docked || target === field.current || target.closest('button')) return
    e.preventDefault()
    field.current?.focus()
  }

  function ghostContent(): ReactNode {
    if (!reveal) return text + '​'
    const words = text.slice(reveal.start, reveal.end).split(/(\s+)/)
    const step = Math.min(WORD_STAGGER_MS, MAX_STAGGER_MS / Math.max(1, words.length / 2))
    let n = 0
    return (
      <>
        {text.slice(0, reveal.start)}
        {words.map((w, i) =>
          /^\s*$/.test(w) ? (
            w
          ) : (
            <span key={`${reveal.id}-${i}`} className="word" style={{ animationDelay: `${n++ * step}ms` }}>
              {w}
            </span>
          )
        )}
        {text.slice(reveal.end)}
        {'​'}
      </>
    )
  }

  const mood: Mood = job
    ? moodOf(job.run, job.approval, job.review)
    : status === 'error'
      ? 'stuck'
      : status === 'sending'
        ? 'working'
        : status === 'sent'
          ? 'done'
          : reveal
            ? 'hearing'
            : 'idle'
  const behind = screen && !leaving
  const busy = team.filter((a) => a.status !== 'idle')
  const showRecents = !docked && status !== 'error' && recents.length > 0 && (!text.trim() || pick >= 0)

  return (
    <>
      <div
        ref={stage}
        className={`stage ${visible ? 'is-in' : 'is-out is-asleep'} ${docked ? `is-docked at-${corner}` : ''} ${open ? 'is-open' : ''} ${behind ? 'is-behind is-asleep' : ''} ${held ? 'is-held' : ''} ${lifted ? 'is-lifted' : ''}`}
        {...dragHandlers}
        onDoubleClick={resetDock}
      >
        <div ref={isle} className={`isle is-${status}`} onMouseEnter={enterIsle} onMouseLeave={leaveIsle}>
          <div ref={shell} className="isle-shell oggy-surface">
            <div ref={inner} className="isle-inner" onMouseDown={aimAtField}>
              <div ref={top} className="isle-top" data-drag={docked ? '' : undefined}>
                <Pet key={reveal?.id ?? 'rest'} mood={mood} size={26} />
                {job && <JobLine run={job.run} project={projectOf(job.run)} title={job.review?.title} live={lineOf(job)} />}
                <span className="isle-trail">
                  {job ? (
                    <>
                      <Elapsed run={job.run} />
                      <button className="icon-btn" onClick={dismissJob} aria-label="Dismiss" title="Dismiss">
                        <svg viewBox="0 0 16 16" aria-hidden>
                          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                        </svg>
                      </button>
                    </>
                  ) : !text.trim() ? (
                    // Everything Oggy is doing, one click away.
                    <button className="btn is-quiet isle-board" onClick={() => openScreen(true, busy.length ? 'team' : 'home')} title={busy.length ? 'Show the team' : 'Open the workspace'}>
                      {busy.length ? `${busy.length} working` : 'Workspace'}
                    </button>
                  ) : (
                    <kbd className="is-ready">↵</kbd>
                  )}
                </span>
              </div>

              {job && (
                <div className="isle-body">
                  <JobPanel
                    key={job.run.id}
                    run={job.run}
                    approval={job.approval}
                    changes={job.changes}
                    review={job.review}
                    stepLines={job.stepLines}
                    said={job.said}
                    general={!isFinished(job.run) && !job.run.steps.some((s) => s.status === 'running') ? job.lines.at(-1)?.text : undefined}
                    onDecide={decide}
                    onReview={(text) => void decideReview(text)}
                    onShowMe={() => openScreen()}
                    onCommand={send}
                  />
                </div>
              )}

              <div className={`field ${reveal ? 'is-revealing' : ''}`}>
                <textarea
                  ref={field}
                  rows={1}
                  value={text}
                  style={{ height }}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={onKey}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onScroll={(e) => ghost.current && (ghost.current.scrollTop = e.currentTarget.scrollTop)}
                  placeholder={
                    job?.review?.status === 'ready'
                      ? job.changes.length
                        ? 'Say “looks good”, “undo”, or what to change'
                        : 'Say “show me” or “open it in VS Code”'
                      : job
                        ? 'Tell Oggy anything'
                        : 'What should Oggy do?'
                  }
                  aria-label="Ask Oggy"
                  spellCheck={false}
                  readOnly={status === 'sending' || status === 'sent'}
                />
                <div ref={ghost} className="ghost" aria-hidden>
                  {ghostContent()}
                </div>
              </div>

              {status === 'error' && (
                <p className="isle-note" role="status">
                  Oggy can't reach its backend. Start it with <code>cd backend &amp;&amp; pnpm dev</code>
                </p>
              )}

              {showRecents && (
                <ul className="isle-recents" aria-label="Asked lately">
                  {recents.map((r, i) => (
                    <li key={r} style={{ animationDelay: `${40 + i * 35}ms` }}>
                      <button className={i === pick ? 'is-on' : ''} onClick={() => chooseRecent(i)}>
                        {r}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
      {screen && (
        <OggyApp
          store={store}
          view={appView}
          focus={job?.run.id}
          followed={job ? { runId: job.run.id, qa: job.qa, prevReview: job.prevReview, onSend: (t) => void sendFromScreen(t), onOpenCode: () => openInCode() } : undefined}
          onNew={send}
          onClose={dismissJob}
          onMinimize={() => window.oggy.minimizeWindow()}
          onTuck={tuckAway}
          leaving={leaving}
        />
      )}
    </>
  )
}

/** The job's running time. Its own component, so a second ticking repaints only this. */
function Elapsed({ run }: { run: Run }) {
  const running = !isFinished(run)
  const now = useNow(running)
  return <span className="isle-time">{clock((running ? now : run.updatedAt) - run.createdAt)}</span>
}

/** "is it done?" while the team works: who's on it, for how long, what they're doing, what changed so far. */
function whereThingsStand(job: Job): string {
  const step = job.run.steps.find((s) => s.status === 'running')
  if (!step) return "Not yet. I'm about to read what the team did, then I'll explain it here."
  const { who, what } = whoWhat(step)
  const name = who ? who[0].toUpperCase() + who.slice(1) : 'The team'
  const last = job.stepFeed[step.id]?.at(-1)
  const doing = last ? tidy(last.text, who).replace(/\.$/, '') : ''
  const changed = job.changes.length ? ` ${job.changes.length} file${job.changes.length === 1 ? '' : 's'} changed so far.` : ''
  const since = step.startedAt ? ` (${clock(Date.now() - step.startedAt)} in)` : ''
  return `Not yet. ${name} is on “${what}”${since}.${doing ? ` Right now: ${doing[0].toLowerCase()}${doing.slice(1)}${last ? ` (${clock(Date.now() - last.at)} on this)` : ''}.` : ''}${changed}`
}

/** What's happening this second, for the island's small line. */
function lineOf(job: Job): string | undefined {
  const step = job.run.steps.find((s) => s.status === 'running')
  if (!step) return isFinished(job.run) ? undefined : job.lines.at(-1)?.text
  const { who } = whoWhat(step)
  const line = tidy(job.stepLines[step.id], who)
  return who ? `${who[0].toUpperCase()}${who.slice(1)} · ${line || 'on it'}` : line || step.title
}

