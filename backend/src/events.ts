import { EventEmitter } from 'node:events'
import type { OggyEvent, ShowEffect } from './shared/types.js'

const bus = new EventEmitter()
bus.setMaxListeners(50)

export function emit(e: OggyEvent) {
  bus.emit('event', e)
}

export function log(level: 'info' | 'warn' | 'error', message: string) {
  console[level === 'info' ? 'log' : level](`[oggy] ${message}`)
  emit({ type: 'log', level, message, at: Date.now() })
}

/** A live line for one run ("Opening portfolio in VS Code…", "@claude: reading the files"), and the step it's about. */
export function activity(runId: string, text: string, stepId?: string) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean) emit({ type: 'run.activity', runId, stepId, text: clean.slice(0, 200), at: Date.now() })
}

/** Something for the desktop app to animate on screen (show mode). */
export function show(runId: string, effect: ShowEffect) {
  emit({ type: 'show', runId, effect })
}

export function subscribe(cb: (e: OggyEvent) => void): () => void {
  bus.on('event', cb)
  return () => bus.off('event', cb)
}
