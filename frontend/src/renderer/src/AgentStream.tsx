import type { AgentLive, AgentStep } from '@shared/types'

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** A small line icon per kind of step, so a glance tells reading from editing from running. */
export function StepIcon({ kind }: { kind: AgentStep['kind'] }) {
  const paths: Record<AgentStep['kind'], string> = {
    job: 'M3 8.5l2.5 2.5L13 4',
    read: 'M3 3.5h4.5l1 1H13v8H3z',
    edit: 'M10.5 3.5l2 2L6 12H4v-2z',
    run: 'M3.5 4.5L7 8l-3.5 3.5M8.5 12H13',
    search: 'M7 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zM10.5 10.5L13.5 13.5',
    think: 'M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M11.8 4.2l-1.6 1.6M5.8 10.2l-1.6 1.6',
    plan: 'M5.5 4.5H13M5.5 8H13M5.5 11.5H13M3 4.5h.5M3 8h.5M3 11.5h.5',
    post: 'M3 4h10v6.5H7l-3 2.5v-2.5H3z',
    ask: 'M8 2l4.5 1.8v3.5c0 2.8-1.9 4.7-4.5 5.7-2.6-1-4.5-2.9-4.5-5.7V3.8z',
    other: 'M8 8m-1 0a1 1 0 102 0 1 1 0 10-2 0',
    mail: 'M2.5 4h11v8h-11zM2.5 4.5L8 8.5l5.5-4',
    calendar: 'M3 3.5h10v9.5H3zM3 6.5h10M6 2v3M10 2v3',
    notes: 'M4 2.5h8v11H4zM6.5 6h3M6.5 8.5h3',
    todo: 'M3 4.5l1 1 2-2M3 9.5l1 1 2-2M8.5 4.5H13M8.5 9.5H13',
    draft: 'M10.5 3.5l2 2L6 12H4v-2zM3 14h10'
  }
  return (
    <svg className={`as-ico is-${kind}`} viewBox="0 0 16 16" aria-hidden>
      <path d={paths[kind]} />
    </svg>
  )
}

/** What an agent is doing, the way a coding session looks: a row per step, the current one shimmering. */
export function LiveSteps({ agent, now, max = 7 }: { agent: AgentLive; now: number; max?: number }) {
  const steps = agent.steps.filter((s) => s.kind !== 'job').slice(-max)
  const current = agent.status !== 'idle' ? steps.at(-1) : undefined
  if (!steps.length) return null
  return (
    <ol className="as-steps">
      {steps.map((s, i) => {
        const isNow = s === current
        return (
          <li key={`${s.at}-${i}`} className={`as-step is-${s.kind} ${isNow ? 'is-now' : ''}`}>
            <StepIcon kind={s.kind} />
            <span className="as-step-main">
              {s.kind === 'think' ? (
                <span className="as-thought">{s.text}</span>
              ) : (
                <>
                  <span className="as-step-text">{s.text}</span>
                  {s.detail && s.kind !== 'run' && <span className="as-step-detail">{s.detail}</span>}
                </>
              )}
              {isNow && s.kind === 'run' && s.detail && <code className="as-cmd">{s.detail}</code>}
              {isNow && s.slow && <span className="as-slow">{s.slow}</span>}
              {isNow && s.kind === 'ask' && agent.status === 'waiting' && <span className="as-slow">Say “yes” or “no” to answer it</span>}
            </span>
            {isNow && now - s.at >= 3000 && <span className="as-age">{clock(now - s.at)}</span>}
          </li>
        )
      })}
    </ol>
  )
}

