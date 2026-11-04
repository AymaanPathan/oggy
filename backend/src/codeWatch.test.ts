import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/** What opening a project in VS Code shows. Real git, in throwaway repos. */

const root = mkdtempSync(join(tmpdir(), 'oggy-watch-'))
process.env.OGGY_DATA_DIR = join(root, 'data')

const { branchForJob, changesIn, stopWatch, undoChanges, watchCode } = await import('./codeWatch.js')
const { db } = await import('./db.js')

after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

let n = 0
function repo() {
  const dir = mkdtempSync(join(root, 'repo-'))
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-b', 'main')
  writeFileSync(join(dir, 'app.ts'), 'old\n')
  writeFileSync(join(dir, 'gone.ts'), 'bye\n')
  git('add', '.')
  git('commit', '-m', 'start')
  return { dir, git, run: `run-${++n}` }
}

test('a job shows each file as it found it, new and deleted ones too', async () => {
  const { dir, run } = repo()
  await branchForJob(run, dir, 'add a thing')
  await watchCode(run, dir)
  writeFileSync(join(dir, 'app.ts'), 'new\n')
  writeFileSync(join(dir, 'fresh.ts'), 'hello\n')
  rmSync(join(dir, 'gone.ts'))
  await stopWatch(run)
  const c = await changesIn(dir)
  assert.equal(c?.branch, 'oggy/add-a-thing')
  assert.deepEqual(c?.files.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'app.ts', status: 'modified', before: 'old\n' },
    { path: 'fresh.ts', status: 'added', before: '' },
    { path: 'gone.ts', status: 'deleted', before: 'bye\n' }
  ])
})

test('your own unsaved edits are part of the before, not the change', async () => {
  const { dir, run } = repo()
  writeFileSync(join(dir, 'app.ts'), 'mine\n')
  await watchCode(run, dir)
  writeFileSync(join(dir, 'app.ts'), 'mine and agent\n')
  await stopWatch(run)
  assert.equal((await changesIn(dir))?.files[0].before, 'mine\n')
})

test('undone work has nothing to show', async () => {
  const { dir, run } = repo()
  await watchCode(run, dir)
  writeFileSync(join(dir, 'app.ts'), 'new\n')
  await stopWatch(run)
  await undoChanges(run)
  assert.deepEqual((await changesIn(dir))?.files, [])
})

test('work left on its branch is pointed at, not shown as nothing', async () => {
  const { dir, git, run } = repo()
  await branchForJob(run, dir, 'side work')
  await watchCode(run, dir)
  writeFileSync(join(dir, 'app.ts'), 'new\n')
  await stopWatch(run)
  git('add', '.')
  git('commit', '-m', 'work')
  git('checkout', 'main')
  const c = await changesIn(dir)
  assert.deepEqual(c?.files, [])
  assert.equal(c?.elsewhere, 'oggy/side-work')
})

test('after a restart, an oggy branch still shows what it adds to main', async () => {
  const { dir, git } = repo()
  git('checkout', '-b', 'oggy/earlier-job')
  writeFileSync(join(dir, 'app.ts'), 'committed\n')
  git('add', '.')
  git('commit', '-m', 'work')
  writeFileSync(join(dir, 'later.ts'), 'not committed\n')
  const c = await changesIn(dir)
  assert.deepEqual(c?.files.map((f) => [f.path, f.before]).sort(), [['app.ts', 'old\n'], ['later.ts', '']])
})

test('main with no job: nothing to show', async () => {
  const { dir } = repo()
  assert.deepEqual((await changesIn(dir))?.files, [])
})

test('images are counted, not diffed', async () => {
  const { dir, run } = repo()
  await watchCode(run, dir)
  writeFileSync(join(dir, 'pic.png'), Buffer.from([0, 1, 2, 0]))
  await stopWatch(run)
  const c = await changesIn(dir)
  assert.deepEqual(c?.files, [])
  assert.equal(c?.notShown, 1)
})
