import type { StepTemplate, WorkflowSchedule } from './types.js'

/** The agent that works on your day (mail, calendar, notes), not on code. */
export const EVERYDAY_AGENT = 'assistant'

/** A workflow about your day: the assistant's work, with no project and nothing deployed. Its news goes to #oggy-daily. */
export const isEveryday = (steps: Pick<StepTemplate, 'kind' | 'args'>[]) =>
  steps.some((s) => s.kind === 'agent.job' && s.args?.agent === EVERYDAY_AGENT) &&
  steps.every((s) => s.kind !== 'deploy' && !s.args?.project && (s.kind !== 'agent.job' || s.args?.agent === EVERYDAY_AGENT))

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "Every weekday at 09:00". */
export function scheduleText(s: WorkflowSchedule): string {
  const d = [...s.days].sort().join()
  const days = d === '0,1,2,3,4,5,6' ? 'Every day' : d === '1,2,3,4,5' ? 'Every weekday' : d === '0,6' ? 'Weekends' : s.days.length === 1 ? `Every ${DAYS[s.days[0]]}` : `Every ${[...s.days].sort().map((x) => DAYS[x].slice(0, 3)).join(', ')}`
  return `${days} at ${s.time}`
}

/** The schedule's time on the day `offset` days from `now`, in local time. */
function at(s: WorkflowSchedule, now: number, offset: number): Date {
  const [h, m] = s.time.split(':').map(Number)
  const d = new Date(now)
  d.setDate(d.getDate() + offset)
  d.setHours(h, m, 0, 0)
  return d
}

/** When it's next due after `now`. */
export function nextRun(s: WorkflowSchedule, now: number): number | undefined {
  for (let i = 0; i <= 7; i++) {
    const d = at(s, now, i)
    if (s.days.includes(d.getDay()) && d.getTime() > now) return d.getTime()
  }
  return undefined
}

/** When it was last due, at or before `now`. */
export function lastDue(s: WorkflowSchedule, now: number): number | undefined {
  for (let i = 0; i <= 7; i++) {
    const d = at(s, now, -i)
    if (s.days.includes(d.getDay()) && d.getTime() <= now) return d.getTime()
  }
  return undefined
}
