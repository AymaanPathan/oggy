import assert from 'node:assert/strict'
import { test } from 'node:test'
import { devUrlOf } from './vscode.js'

/** Where a project's dev server will answer, from its dev script. */

test('a port in the script wins', () => {
  assert.equal(devUrlOf('next dev -p 5000'), 'http://localhost:5000')
  assert.equal(devUrlOf('vite --port 4000'), 'http://localhost:4000')
  assert.equal(devUrlOf('vite --port=4001'), 'http://localhost:4001')
  assert.equal(devUrlOf('cross-env PORT=8080 react-scripts start'), 'http://localhost:8080')
})

test('else the tool’s own default', () => {
  assert.equal(devUrlOf('next dev'), 'http://localhost:3000')
  assert.equal(devUrlOf('vite'), 'http://localhost:5173')
  assert.equal(devUrlOf('ng serve'), 'http://localhost:4200')
  assert.equal(devUrlOf('astro dev'), 'http://localhost:4321')
})

test('a server it can’t place (tsx watch src/index.ts) has no address', () => {
  assert.equal(devUrlOf('tsx watch src/index.ts'), undefined)
  assert.equal(devUrlOf(''), undefined)
})

test('a server counts as up when it takes connections, even if its pages are slow to build', async () => {
  const { createServer } = await import('node:net')
  const { answers } = await import('./vscode.js')
  // Accepts connections and never replies: like next dev building its first page.
  const slow = createServer(() => {})
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r))
  const port = (slow.address() as import('node:net').AddressInfo).port
  assert.equal(await answers(`http://localhost:${port}`), true)
  await new Promise((r) => slow.close(r))
  assert.equal(await answers(`http://localhost:${port}`), false)
})

/* ---------- a VS Code window taking jobs (as Oggy Bridge does) ---------- */

const portfolio = 'C:/code/portfolio'
const job = (over: Partial<Parameters<typeof import('./vscode.js').startServer>[0]> = {}) => ({ root: portfolio, cwd: portfolio, name: 'Oggy: portfolio', pm: 'npm', script: 'dev', ...over })
const noVsCode = (claimMs = 2000) => ({ ready: () => ({ ok: true }), open: () => {}, claimMs })

test('only a window with the project (or a folder above it) open takes its job', async () => {
  const { startServer, takeJob, jobReport } = await import('./vscode.js')
  const watching = startServer(job(), undefined, 3000, noVsCode())
  assert.equal(await takeJob(['C:/code/react-flow'], 300), undefined)
  const taken = await takeJob(['c:/CODE/'], 300)
  assert.equal(taken?.type, 'run')
  assert.equal(taken?.pm, 'npm')
  assert.equal(taken?.script, 'dev')
  // Taken once: nobody else gets it.
  assert.equal(await takeJob([portfolio], 200), undefined)
  jobReport(taken!.id, { event: 'exited', code: 1 })
  await watching
})

test('a server that crashes comes back with its own last lines', async () => {
  const { startServer, takeJob, jobReport } = await import('./vscode.js')
  const seen: string[] = []
  const watching = startServer(job(), (l) => seen.push(l), 5000, noVsCode())
  const j = (await takeJob([portfolio], 1000))!
  jobReport(j.id, { event: 'started', streaming: true })
  jobReport(j.id, { event: 'output', lines: ['\x1b[32m> next dev -p 5000\x1b[0m', '', 'Error: Cannot find module "next.config.ts"'] })
  jobReport(j.id, { event: 'exited', code: 1 })
  const r = await watching
  assert.ok(r.ok && r.state === 'exited')
  assert.equal(r.ok && r.state === 'exited' && r.code, 1)
  assert.deepEqual(r.ok && r.state === 'exited' && r.tail, ['> next dev -p 5000', 'Error: Cannot find module "next.config.ts"'])
  // Live, without colours or blank lines.
  assert.deepEqual(seen, ['> next dev -p 5000', 'Error: Cannot find module "next.config.ts"'])
})

test('it reads the address the server prints, and it’s up once that port takes connections', async () => {
  const { createServer } = await import('node:net')
  const { startServer, takeJob, jobReport } = await import('./vscode.js')
  const srv = createServer(() => {})
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as import('node:net').AddressInfo).port
  // The script's guess is wrong; the printed address wins.
  const watching = startServer(job({ guessUrl: 'http://localhost:1' }), undefined, 5000, noVsCode())
  const j = (await takeJob([portfolio], 1000))!
  jobReport(j.id, { event: 'started', streaming: true })
  jobReport(j.id, { event: 'output', lines: ['  ▲ Next.js 16', `  - Local:   http://localhost:${port}`] })
  const r = await watching
  assert.ok(r.ok && r.state === 'up')
  assert.equal(r.ok && r.state === 'up' && r.url, `http://localhost:${port}`)
  await new Promise((r) => srv.close(r))
})

test('no window takes the job: Oggy says so instead of waiting forever', async () => {
  const { startServer, takeJob } = await import('./vscode.js')
  const r = await startServer(job({ root: 'C:/code/nobody-has-this-open' }), undefined, 3000, noVsCode(400))
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.why : '', /didn't pick up the job/)
  // And no window picks it up later out of the blue.
  assert.equal(await takeJob(['C:/code/nobody-has-this-open'], 200), undefined)
})

test('the printed address is found in normal dev server output', async () => {
  const { printedUrl } = await import('./vscode.js')
  assert.equal(printedUrl(['VITE v6 ready in 300 ms', '  ➜  Local:   http://localhost:5173/']), 'http://localhost:5173')
  assert.equal(printedUrl(['Server listening on http://0.0.0.0:8080']), 'http://localhost:8080')
  assert.equal(printedUrl(['compiling…']), undefined)
  // An API that only says its port.
  assert.equal(printedUrl(['> tsx watch src/index.ts', 'paytrack API listening on port 4000']), 'http://localhost:4000')
  assert.equal(printedUrl(['Server running on port: 3001']), 'http://localhost:3001')
  assert.equal(printedUrl(['port 4000 is busy, trying another']), undefined)
})

/* ---------- showing what Oggy changed ---------- */

const diff = { root: portfolio, title: 'Oggy changes', files: [{ file: 'C:/code/portfolio/a.ts', path: 'a.ts', status: 'modified', before: 'old' }] }

test('a window on an older bridge never takes a diff it would only drop', async () => {
  const { showChanges, takeJob, jobReport } = await import('./vscode.js')
  const shown = showChanges(diff, { ready: () => ({ ok: true }), claimMs: 2000 })
  assert.equal(await takeJob([portfolio], 200), undefined)
  const taken = await takeJob([portfolio], 300, ['changes'])
  assert.equal(taken?.type, 'changes')
  assert.equal(taken?.files?.[0].before, 'old')
  jobReport(taken!.id, { event: 'started' })
  assert.equal(await shown, true)
})

test('no window took it: Oggy knows, and nobody picks it up later', async () => {
  const { showChanges, takeJob } = await import('./vscode.js')
  assert.equal(await showChanges(diff, { ready: () => ({ ok: true }), claimMs: 200 }), false)
  assert.equal(await takeJob([portfolio], 100, ['changes']), undefined)
})

test('a window that failed to show it counts as not shown', async () => {
  const { showChanges, takeJob, jobReport } = await import('./vscode.js')
  const shown = showChanges(diff, { ready: () => ({ ok: true }), claimMs: 2000 })
  const taken = await takeJob([portfolio], 300, ['changes'])
  jobReport(taken!.id, { event: 'exited', code: -1 })
  assert.equal(await shown, false)
})
