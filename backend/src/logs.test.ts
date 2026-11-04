import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { config } from './config.js'
import { logsForJob } from './logs.js'

const realFetch = globalThis.fetch
const line = (n: number, type = 'app') => ({ message: `\x1b[32mline ${n}\x1b[0m\x1b(B\x1b[K`, timestamp: `2026-11-01T07:00:${String(n % 60).padStart(2, '0')}Z`, labels: [{ name: 'type', value: type }, { name: 'level', value: 'info' }] })

let dir: string
let calls: { url: URL; auth: string | null }[]
/** Answers with these pages, in turn; a number is that HTTP status. */
function renderSays(...pages: (object | number)[]) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    if (url.pathname.startsWith('/v1/services/')) return new Response(JSON.stringify({ ownerId: 'tea-1' }), { status: 200 })
    const page = pages.shift() ?? { logs: [], hasMore: false }
    return typeof page === 'number' ? new Response('{}', { status: page }) : new Response(JSON.stringify(page), { status: 200 })
  }) as typeof fetch
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oggy-logs-'))
  calls = []
  config.projectsDir = dir
  config.render.apiKey = 'test-key'
  config.deploy.paytrack = { branch: 'main', service: 'srv-1' }
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete config.deploy.paytrack
  rmSync(dir, { recursive: true, force: true })
})

test('a job that isn’t about logs costs nothing', async () => {
  renderSays()
  assert.equal(await logsForJob('paytrack', 'add a daily log page'), undefined)
  assert.equal(calls.length, 0)
})

test('a project not connected to Render is left alone', async () => {
  renderSays()
  assert.equal(await logsForJob('portfolio', 'read the logs'), undefined)
  assert.equal(calls.length, 0)
})

test('it writes the logs to a file, oldest first, with your key sent only to Render', async () => {
  renderSays({ logs: [line(2), line(1, 'request')], hasMore: false })
  const got = await logsForJob('paytrack', 'analyze the backend logs')
  const file = join(dir, '.oggy-logs', 'paytrack-render.log')
  assert.ok(got?.note.includes(file))
  assert.doesNotMatch(got!.note, /line 1/)
  assert.equal(got?.said, "Fetched 2 lines of paytrack's Render logs")
  assert.equal(readFileSync(file, 'utf8'), '2026-11-01T07:00:01Z request info line 1\n2026-11-01T07:00:02Z app info line 2\n')
  assert.ok(calls.every((c) => c.url.hostname === 'api.render.com' && c.auth === 'Bearer test-key'))
  const logs = calls.find((c) => c.url.pathname === '/v1/logs')!.url.searchParams
  assert.equal(logs.get('ownerId'), 'tea-1')
  assert.equal(logs.get('resource'), 'srv-1')
})

test('a job that only names the project in its words still gets them', async () => {
  renderSays({ logs: [line(1)], hasMore: false })
  assert.ok((await logsForJob('', 'analyze the paytrack backend logs'))?.note.includes('paytrack-render.log'))
})

test('it follows the pages Render gives, and stops at 500 lines', async () => {
  const page = (from: number) => ({ logs: Array.from({ length: 100 }, (_, i) => line(from + i)), hasMore: true, nextStartTime: `s${from}`, nextEndTime: `e${from}` })
  renderSays(page(0), page(100), page(200), page(300), page(400), page(500))
  const got = await logsForJob('paytrack', 'read the logs')
  assert.match(got!.said, /Fetched 500 lines/)
  const pages = calls.filter((c) => c.url.pathname === '/v1/logs')
  assert.equal(pages.length, 5)
  assert.equal(pages[1].url.searchParams.get('endTime'), 'e0')
  assert.equal(pages[1].url.searchParams.get('startTime'), 's0')
})

test('a later page failing keeps what already came back', async () => {
  renderSays({ logs: [line(1)], hasMore: true, nextStartTime: 's', nextEndTime: 'e' }, 500)
  assert.match((await logsForJob('paytrack', 'read the logs'))!.said, /Fetched 1 lines/)
})

test('a stalled call to Render gets one more try', async () => {
  renderSays({ logs: [line(1)], hasMore: false })
  const answering = globalThis.fetch
  let stalled = false
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (stalled) return answering(...args)
    stalled = true
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  }) as typeof fetch
  assert.match((await logsForJob('paytrack', 'read the logs'))!.said, /Fetched 1 lines/)
})

test('no key, a refused key and no logs each tell the agent the truth', async () => {
  config.render.apiKey = ''
  assert.match((await logsForJob('paytrack', 'read the logs'))!.note, /couldn't get paytrack's logs.*RENDER_API_KEY.*don't treat the logs as clean/)

  config.render.apiKey = 'bad'
  renderSays(401)
  const refused = await logsForJob('paytrack', 'read the logs')
  assert.match(refused!.note, /turned down RENDER_API_KEY/)
  assert.doesNotMatch(refused!.note, /\bbad\b/)

  renderSays({ logs: [], hasMore: false })
  assert.match((await logsForJob('paytrack', 'read the logs'))!.note, /no logs from the last 24 hours/)
})
