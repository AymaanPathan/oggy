// Oggy Bridge: every VS Code window asks Oggy for work on the folders it has open, so a project's dev
// server starts in the window that has that project, in a terminal you can see. The bridge reads the
// terminal's output (VS Code's shell integration) and sends it back, so Oggy knows the real address,
// sees a crash and its error, and can show the output live.
// When you open a project Oggy changed, the bridge shows those changes in VS Code's changes view.
// It talks only to Oggy on this computer, with Oggy's owner key (~/.oggy/token), and never runs a command
// line it's given: only "<package manager> run <script>", both checked.
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun']
/** How long a job waits for VS Code's shell integration before running without output. */
const SHELL_WAIT_MS = 5000

const backend = () => vscode.workspace.getConfiguration('oggy').get('backendUrl') || 'http://127.0.0.1:4317'

function ownerKey() {
  try {
    return fs.readFileSync(path.join(process.env.OGGY_DATA_DIR || path.join(os.homedir(), '.oggy'), 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Tell Oggy how a job is going: started, output lines, exited (with its code), stopped. */
async function report(job, event) {
  try {
    await fetch(`${backend()}/vscode/report`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job, ...event })
    })
  } catch {
    // Oggy went away; the server keeps running in the terminal anyway.
  }
}

const terminalsNamed = (name) => vscode.window.terminals.filter((t) => t.name === name)

/** The terminal's shell integration, once VS Code has it (or undefined after a few seconds). */
function shellIntegration(terminal) {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose()
      resolve(undefined)
    }, SHELL_WAIT_MS)
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal !== terminal) return
      clearTimeout(timer)
      sub.dispose()
      resolve(e.shellIntegration)
    })
  })
}

async function run(job) {
  if (!PACKAGE_MANAGERS.includes(job.pm) || !/^[\w:.-]+$/.test(job.script || '') || !job.cwd || !fs.existsSync(job.cwd)) {
    return report(job.id, { event: 'exited', code: -1, lines: ['Oggy Bridge: the request was missing something, so nothing ran.'] })
  }
  // A terminal of this name is a leftover (Oggy only starts a server that isn't answering): start fresh.
  for (const t of terminalsNamed(job.name)) t.dispose()
  const terminal = vscode.window.createTerminal({ name: job.name, cwd: job.cwd, iconPath: new vscode.ThemeIcon('server-process') })
  terminal.show(true)
  const command = `${job.pm} run ${job.script}`
  const shell = await shellIntegration(terminal)
  if (!shell) {
    // No shell integration here: it still runs, Oggy just doesn't see the output.
    terminal.sendText(command)
    return report(job.id, { event: 'started', streaming: false })
  }
  const execution = shell.executeCommand(command)
  report(job.id, { event: 'started', streaming: true })
  const ended = vscode.window.onDidEndTerminalShellExecution((e) => {
    if (e.execution !== execution) return
    ended.dispose()
    // Let the last output go first.
    setTimeout(() => report(job.id, { event: 'exited', code: e.exitCode ?? null }), 300)
  })
  // Output goes to Oggy in small batches, a line at a time.
  let pending = ''
  let lines = []
  const flush = () => {
    if (lines.length) report(job.id, { event: 'output', lines: lines.splice(0) })
  }
  const timer = setInterval(flush, 400)
  try {
    for await (const data of execution.read()) {
      pending += data
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      lines.push(...parts)
      if (lines.length > 50) flush()
    }
  } finally {
    if (pending) lines.push(pending)
    clearInterval(timer)
    flush()
  }
}

function stop(job) {
  // Closing the terminal ends the server it runs (Oggy ends a lingering one itself).
  for (const t of terminalsNamed(job.name)) t.dispose()
  report(job.id, { event: 'stopped' })
}

/** The left side of each diff: the files as the job found them, kept here because they exist nowhere on disk. */
const BEFORE = 'oggy-before'
const before = new Map()

/** Every file Oggy changed, in one scrollable diff. A new file compares with nothing, a deleted one with nothing on the right. */
async function showChanges(job) {
  try {
    const side = (f, key, text) => {
      before.set(key, text)
      return vscode.Uri.from({ scheme: BEFORE, path: `/${f.path}`, query: key })
    }
    const list = job.files.map((f) => [
      vscode.Uri.file(f.file),
      side(f, `${job.id}:${f.path}`, f.before),
      f.status === 'deleted' ? side(f, `${job.id}:gone:${f.path}`, '') : vscode.Uri.file(f.file)
    ])
    await vscode.commands.executeCommand('vscode.changes', job.title, list)
    report(job.id, { event: 'started' })
  } catch (err) {
    report(job.id, { event: 'exited', code: -1, lines: [`Oggy Bridge: couldn't show the changes (${err.message}).`] })
  }
}

/** This window's folders, as Oggy matches them against a project's folder. */
const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)

exports.activate = (context) => {
  let active = true
  context.subscriptions.push({ dispose: () => (active = false) })
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BEFORE, { provideTextDocumentContent: (uri) => before.get(uri.query) ?? '' }))
  void (async () => {
    while (active) {
      const open = folders()
      const key = ownerKey()
      if (!open.length || !key) {
        await sleep(5000)
        continue
      }
      try {
        // Oggy holds this until there's a job for one of these folders (or ~25s pass).
        const res = await fetch(`${backend()}/vscode/jobs?can=changes&folders=${encodeURIComponent(JSON.stringify(open))}`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(35_000)
        })
        if (res.status !== 200) {
          if (res.status !== 204) await sleep(5000)
          continue
        }
        const job = await res.json()
        if (job.type === 'run') void run(job)
        else if (job.type === 'stop') stop(job)
        else if (job.type === 'changes') void showChanges(job)
      } catch {
        // Oggy isn't running: look again in a bit.
        await sleep(5000)
      }
    }
  })()
}

exports.deactivate = () => {}
