import { memory, workflows } from './db.js'
import { log } from './events.js'
import { lastDue } from './shared/everyday.js'
import type { Workflow } from './shared/types.js'

/**
 * Workflows that run by themselves ("every weekday at 9"). Oggy checks the clock while it's open:
 * a run missed while the computer was off still happens when Oggy opens, unless it's hours late.
 */

/** Later than this (the laptop was off all morning), a run is skipped, not run late. */
const LATE_MS = 3 * 60 * 60_000
const TICK_MS = 30_000

const firedKey = (id: string) => `schedule.fired.${id}`

/** From now on: a schedule saved at 10:00 doesn't run for 9:00 today. */
export const armSchedule = (id: string, now = Date.now()) => memory.set(firedKey(id), String(now))

/** The workflows due now. Each is marked handled as it's returned, so it never runs twice for one time. */
export function dueNow(now = Date.now()): Workflow[] {
  const due: Workflow[] = []
  for (const w of workflows.list()) {
    if (!w.schedule) continue
    const when = lastDue(w.schedule, now)
    if (!when || when <= Number(memory.get(firedKey(w.id)) || 0)) continue
    armSchedule(w.id, now)
    if (now - when > LATE_MS) {
      log('info', `Skipped ${w.name}: it was due at ${new Date(when).toLocaleTimeString()}, while Oggy was off`)
      continue
    }
    due.push(w)
  }
  return due
}

let timer: NodeJS.Timeout | undefined

/** Check now (a run missed while Oggy was closed), then every half minute. */
export function startSchedules(run: (w: Workflow) => void) {
  if (timer) return
  const tick = () => {
    for (const w of dueNow()) {
      log('info', `${w.name} is due: running it`)
      run(w)
    }
  }
  tick()
  timer = setInterval(tick, TICK_MS)
  timer.unref()
}
