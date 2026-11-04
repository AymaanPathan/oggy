import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

/**
 * A live server's logs are on Render, where the agents have no login. Oggy fetches them with your key
 * and leaves them in a file beside the projects. A file, not the job's text: jobs are posted in rooms,
 * and logs can hold customers' data.
 */

const API = 'https://api.render.com/v1'
const PAGE = 100
const MOST = 500
const WINDOW = 24 * 60 * 60 * 1000

interface LogLine {
  message: string
  timestamp: string
  labels: { name: string; value: string }[]
}

async function render<T>(path: string, again = true): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${config.render.apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(45_000) }).catch((err) => {
    // Render's API can stall for a moment: once more before calling it down.
    if (again && (err as Error).name === 'TimeoutError') return undefined
    throw err
  })
  if (!r) return render(path, false)
  if (r.status === 401 || r.status === 403) throw new Error('Render turned down RENDER_API_KEY')
  if (!r.ok) throw new Error(`Render answered ${r.status}`)
  return (await r.json()) as T
}

/** The newest lines of the last day, oldest first. A page that fails after the first keeps what came back. */
async function fetchLines(service: string): Promise<LogLine[]> {
  const { ownerId } = await render<{ ownerId: string }>(`/services/${service}`)
  const lines: LogLine[] = []
  let endTime = new Date().toISOString()
  let startTime = new Date(Date.now() - WINDOW).toISOString()
  while (lines.length < MOST) {
    const query = new URLSearchParams({ ownerId, resource: service, startTime, endTime, direction: 'backward', limit: String(PAGE) })
    const page = await render<{ logs: LogLine[]; hasMore: boolean; nextStartTime: string; nextEndTime: string }>(`/logs?${query}`).catch((err) => {
      if (!lines.length) throw err
      return undefined
    })
    if (!page) break
    lines.push(...page.logs)
    if (!page.hasMore) break
    startTime = page.nextStartTime
    endTime = page.nextEndTime
  }
  return lines.slice(0, MOST).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

const label = (l: LogLine, name: string) => l.labels?.find((x) => x.name === name)?.value
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b(\[[0-9;?]*[A-Za-z]|\([0-9A-Z])/g, '')
const asText = (l: LogLine) => [l.timestamp, label(l, 'type'), label(l, 'level'), plain(l.message)].filter(Boolean).join(' ')

/** The connected project a job is about: the one it names, or the one its words mention. */
function logProject(project: string, text: string): string | undefined {
  const named = project.toLowerCase()
  if (config.deploy[named]?.service) return named
  const words = text.toLowerCase()
  return Object.keys(config.deploy).find((p) => config.deploy[p].service && new RegExp(`\\b${p.replace(/\W/g, '\\$&')}\\b`).test(words))
}

/**
 * For a job about logs on a project connected to Render: fetches them, and returns what to tell the
 * agent and what to show you. Nothing for any other job. A failed fetch still tells the agent, so it
 * reports the gap rather than calling the server clean.
 */
export async function logsForJob(project: string, text: string): Promise<{ note: string; said: string } | undefined> {
  if (!/\blogs\b/i.test(text)) return undefined
  const name = logProject(project, text)
  if (!name) return undefined
  const failed = (why: string) => ({
    note: `\nOggy couldn't get ${name}'s logs from Render: ${why}. Say so in your report, and don't treat the logs as clean.`,
    said: `Couldn't get ${name}'s Render logs: ${why}`
  })
  if (!config.render.apiKey) return failed('RENDER_API_KEY isn’t set where Oggy runs')
  let lines: LogLine[]
  try {
    lines = await fetchLines(config.deploy[name].service!)
  } catch (err) {
    return failed((err as Error).message)
  }
  if (!lines.length) return { note: `\nOggy checked Render: ${name} has no logs from the last 24 hours.`, said: `Render has no ${name} logs from the last 24 hours` }
  const folder = join(config.projectsDir, '.oggy-logs')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${name}-render.log`)
  writeFileSync(file, lines.map(asText).join('\n') + '\n')
  const span = `${lines[0].timestamp} to ${lines[lines.length - 1].timestamp}`
  return {
    note: `\nOggy fetched ${name}'s live logs from Render for you: ${file} (${lines.length} lines, ${span}, the newest of the last 24 hours). Read that file: it's the real server output. Quote only what you need in the room, and never customer data or secrets.`,
    said: `Fetched ${lines.length} lines of ${name}'s Render logs`
  }
}
