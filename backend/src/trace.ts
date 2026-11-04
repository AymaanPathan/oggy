import { emit } from './events.js'
import type { TraceEntry } from './shared/types.js'

/**
 * A job's full activity, for the live window: everything its agents did, in order. The events carry
 * it live; this keeps it for a window that opens late or reloads.
 */

const KEEP_RUNS = 30
const MAX_ENTRIES = 500

const traces = new Map<string, Map<string, TraceEntry>>()

/** Add an entry, or update one (a command that finished keeps its id). */
export function recordTrace(runId: string, entry: TraceEntry) {
  let t = traces.get(runId)
  if (!t) {
    traces.set(runId, (t = new Map()))
    for (const old of [...traces.keys()].slice(0, -KEEP_RUNS)) traces.delete(old)
  }
  t.set(entry.id, entry)
  if (t.size > MAX_ENTRIES) t.delete(t.keys().next().value as string)
  emit({ type: 'run.trace', runId, entry })
}

export const traceOf = (runId: string): TraceEntry[] => [...(traces.get(runId)?.values() ?? [])]
