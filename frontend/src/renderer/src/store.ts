import { useCallback, useEffect, useState } from 'react'
import type { AgentLive, Approval, FileChange, IntegrationStatus, Review, Run, TraceEntry, Workflow } from '@shared/types'

export interface FeedLine {
  id: number
  text: string
  /** When it came in, for "how long on this". */
  at: number
}

/** What Oggy knows about one run beyond the run itself. */
export interface RunLive {
  changes: FileChange[]
  review: Review | null
  stepLines: Record<string, string>
  stepFeed: Record<string, FeedLine[]>
  /** Everything its agents did, in order, live. */
  trace: TraceEntry[]
  /** The job's own latest line ("Planning…"), when no step is running. */
  line?: string
}

export const EMPTY_LIVE: RunLive = { changes: [], review: null, stepLines: {}, stepFeed: {}, trace: [] }
const FEED_PER_STEP = 8
let feedId = 0

export type OggyStore = ReturnType<typeof useOggy>

/**
 * Everything happening in Oggy, live: every run, the team, what's waiting for you. Loaded once and
 * kept fresh by the backend's events, so a screen is never empty while Oggy has something to show.
 */
export function useOggy(enabled = true) {
  const [online, setOnline] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [team, setTeam] = useState<AgentLive[]>([])
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [live, setLive] = useState<Record<string, RunLive>>({})
  const [workflows, setWorkflows] = useState<Workflow[]>([])

  const patch = useCallback((runId: string, make: (l: RunLive) => RunLive) => {
    setLive((all) => ({ ...all, [runId]: make(all[runId] ?? EMPTY_LIVE) }))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [r, a, t, i, w] = await Promise.all([window.oggy.listRuns(), window.oggy.listApprovals(), window.oggy.getTeam(), window.oggy.integrations(), window.oggy.listWorkflows()])
      setRuns(r)
      setApprovals(a)
      setTeam(t)
      setIntegrations(i)
      setWorkflows(w)
    } catch {
      /* backend offline; the sidebar says so */
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const offStatus = window.oggy.onBackendStatus((o) => {
      setOnline(o)
      if (o) void refresh()
    })
    const offEvent = window.oggy.onEvent((e) => {
      switch (e.type) {
        case 'team':
          return setTeam(e.agents)
        case 'workflows':
          return setWorkflows(e.workflows)
        case 'run.updated':
          return setRuns((all) => [e.run, ...all.filter((r) => r.id !== e.run.id)].sort((a, b) => b.createdAt - a.createdAt))
        case 'run.changes':
          return patch(e.runId, (l) => ({ ...l, changes: e.files }))
        case 'run.trace':
          return patch(e.runId, (l) => {
            const i = l.trace.findIndex((t) => t.id === e.entry.id)
            return { ...l, trace: i < 0 ? [...l.trace, e.entry] : l.trace.map((t, n) => (n === i ? e.entry : t)) }
          })
        case 'run.review':
          return patch(e.review.runId, (l) => ({ ...l, review: e.review }))
        case 'run.activity':
          return patch(e.runId, (l) => {
            if (!e.stepId) return { ...l, line: e.text }
            if (l.stepLines[e.stepId] === e.text) return l
            const feed = [...(l.stepFeed[e.stepId] ?? []), { id: ++feedId, text: e.text, at: e.at }].slice(-FEED_PER_STEP)
            return { ...l, stepLines: { ...l.stepLines, [e.stepId]: e.text }, stepFeed: { ...l.stepFeed, [e.stepId]: feed } }
          })
        case 'approval.requested':
        case 'approval.decided':
        case 'approval.vote':
          return setApprovals((all) => [e.approval, ...all.filter((a) => a.id !== e.approval.id)])
      }
    })
    return () => {
      offStatus()
      offEvent()
    }
  }, [enabled, refresh, patch])

  /** Opening a task that ran before this window was watching: fetch what the backend still has. */
  const load = useCallback(
    (runId: string) => {
      void window.oggy
        .runDetail(runId)
        .then((d) => patch(runId, (l) => ({ ...l, changes: l.changes.length ? l.changes : d.changes, review: l.review ?? d.review, trace: l.trace.length ? l.trace : (d.trace ?? []) })))
        .catch(() => {})
    },
    [patch]
  )

  return { online, runs, approvals, team, integrations, live, workflows, load }
}
