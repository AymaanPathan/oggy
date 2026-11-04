import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { OggyEvent } from '@shared/types'

const BASE = process.env.OGGY_BACKEND_URL || `http://127.0.0.1:${process.env.OGGY_PORT || 4317}`
const DATA_DIR = process.env.OGGY_DATA_DIR || join(homedir(), '.oggy')

/** Owner token written by the backend on first start (~/.oggy/token). Read fresh so a backend restart is fine. */
function token(): string {
  if (process.env.OGGY_TOKEN) return process.env.OGGY_TOKEN
  const file = join(DATA_DIR, 'token')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token()}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Backend ${res.status} on ${path}: ${detail}`)
  }
  return (await res.json()) as T
}

/**
 * Subscribe to the backend's SSE stream and keep reconnecting.
 * Calls onStatus(true/false) as the backend comes and goes.
 */
export function streamEvents(onEvent: (e: OggyEvent) => void, onStatus: (online: boolean) => void): () => void {
  let stopped = false
  let controller: AbortController | undefined

  const loop = async () => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const res = await fetch(BASE + '/events', {
          headers: { authorization: `Bearer ${token()}` },
          signal: controller.signal
        })
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        onStatus(true)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n')
            if (data) {
              try {
                onEvent(JSON.parse(data) as OggyEvent)
              } catch {
                /* ignore malformed event */
              }
            }
          }
        }
      } catch {
        /* backend offline or stream dropped */
      }
      if (stopped) break
      onStatus(false)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  void loop()

  return () => {
    stopped = true
    controller?.abort()
  }
}
