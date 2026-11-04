import { memory, newId, runs, workflows } from './db.js'
import { buildWorkflow, type WorkflowAnswer } from './workflow.js'
import { fileCatalog, findApp, resolvePath } from './desktop.js'
import type { ClaudeAnswer, ClaudePlan, PlanHelp } from './integrations/claudeCode.js'
import type { Intent, StepKind, StepTemplate, Workflow } from './shared/types.js'
import { TOOLBOX } from './toolbox.js'
import { projectParts } from './tools.js'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { agentFor, config } from './config.js'

/**
 * Phase 1 planner: deterministic rules for the demo command groups
 * (project & code, delegating, workflows, approvals). Phase 2 can swap in an LLM
 * planner that returns the same { intent, steps } shape.
 */
export interface Plan {
  intent: Intent
  /** Overrides the intent's default label, e.g. "Add feature + deploy". */
  label?: string
  steps: StepTemplate[]
  /** Workflow to replay, for intent 'workflow.run'. */
  workflowName?: string
  /** "run Code Red on my portfolio": the project this run is for, instead of its own. */
  workflowProject?: string
  /** One rule built this from several parts on purpose ("add X and deploy it"): don't split it. */
  combo?: boolean
}

const LABELS: Record<Intent, string> = {
  'project.create': 'Create project',
  'code.change': 'Add feature',
  'code.fix_tests': 'Fix tests',
  'code.review': 'Review changes',
  'delegate.codex': 'Ask Codex',
  'delegate.claude': 'Ask Claude',
  'tool.run': 'Run tool',
  'workflow.create': 'Create workflow',
  'workflow.save': 'Save workflow',
  'workflow.run': 'Run workflow',
  'workflow.list': 'List workflows',
  deploy: 'Deploy',
  'memory.remember': 'Remember',
  quick: 'Quick action',
  chain: 'Several things',
  plan: 'Plan',
  unknown: 'Not understood'
}

/** What the voice box shows while Oggy works: "Working: Add feature + deploy". */
export const labelFor = (p: Plan) => p.label ?? LABELS[p.intent]

const step = (s: Omit<StepTemplate, 'id'>): StepTemplate => ({ id: newId(), ...s })

/** "my portfolio" -> portfolio, "called flowboard" -> flowboard. */
function namedProject(text: string): string | undefined {
  const called = text.match(/\bcalled\s+[`'"]?([\w.-]+)/i)
  if (called) return called[1]
  const mine = text.match(/\bmy\s+([\w.-]+?)(?:\s+project)?\b(?=[\s.,!?]|$)/i)
  if (mine && !NOT_PROJECTS.includes(mine[1].toLowerCase())) return heardProject(text, mine[1]) ?? mine[1]
  return undefined
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** How many letters apart two words are. */
function lettersApart(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/**
 * Speech never spells a project the way its folder does: "dashboard crm", "react flow", "portfolo".
 * The real folder, when exactly one fits what was said; otherwise nothing, and nobody guesses.
 */
function heardProject(text: string, said?: string): string | undefined {
  let folders: string[] = []
  try {
    folders = readdirSync(config.projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return undefined
  }
  const exact = said && folders.find((f) => f.toLowerCase() === said.toLowerCase())
  if (exact) return exact
  const whole = squash(text)
  const named = folders.filter((f) => squash(f).length >= 5 && whole.includes(squash(f)))
  if (named.length === 1) return named[0]
  if (named.length || !said) return undefined
  const near = folders.filter((f) => lettersApart(squash(f), squash(said)) <= (squash(said).length >= 6 ? 2 : 1))
  return near.length === 1 ? near[0] : undefined
}

/** "my downloads", "my tests": not project names. */
const NOT_PROJECTS = [
  'project', 'build', 'tests', 'code', 'site', 'app', 'phone', 'server',
  'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'screenshots', 'files', 'folder',
  'document', 'download', 'picture', 'video', 'screenshot', 'file', 'latest', 'last', 'first', 'newest', 'recent'
]

const UI_WORK = /\b(front-?end|ui|ux|page|screen|button|form|modal|navbar|header|footer|sidebar|styles?|css|tailwind|design|layout|theme|dark mode|toggle|components?|icon|react|full-?stack)\b/i
const API_WORK = /\b(back-?end|api|routes?|endpoints?|database|db|schema|migrations?|models?|auth|login|webhooks?|controllers?|redis|postgres|supabase|express|cron|queue|full-?stack)\b/i

/**
 * Who builds this. The team works like a factory: the work decides the worker, backend first so the
 * frontend gets its routes, and they take turns because they share one folder and one branch.
 */
function buildersFor(text: string, project?: string): ('frontend' | 'backend')[] {
  const ui = UI_WORK.test(text)
  const api = API_WORK.test(text)
  if (ui && api) return ['backend', 'frontend']
  if (ui) return ['frontend']
  if (api) return ['backend']
  const parts = project ? projectParts(join(config.projectsDir, project)).map((p) => p.name.toLowerCase()) : []
  return parts.some((p) => /back|api|server/.test(p)) ? ['backend'] : ['frontend']
}

/**
 * Oggy coordinates and never does a project's work. Whatever a plan says, these go to the agent whose
 * job they are. Opening things on your computer stays with Oggy: that's your desktop, not the project.
 */
const AGENT_WORK: Partial<Record<StepKind, { agent: string; title: string; prompt: string }>> = {
  'project.test': { agent: 'tester', title: 'run the tests', prompt: 'Run the tests and report what passed and what failed.' },
  'project.build': { agent: 'tester', title: 'check the build', prompt: "Run the build and report whether it passes. This job is your go-ahead for the build, so don't ask first." },
  // No go-ahead here: an install still asks you first, like any agent's.
  'project.install': { agent: 'tester', title: 'install the packages', prompt: 'Install the project packages and report how it went.' },
  'git.status': { agent: 'scout', title: 'check where the code stands', prompt: 'Report the branch, what is not committed, and how it compares with main. Do not change anything.' }
}

/** Something's wrong, as opposed to something new: find the cause before anyone changes code. */
const BUG = /\b(bug|broken|errors?|fix(?:es)?|fails?|failing|crash\w*|wrong|still|not working|(?:doesn|isn|won)['’]?t)\b/i
const BUILDERS = ['frontend', 'backend', 'builder', 'claude']

const job = (agent: string, title: string, prompt: string, args: Record<string, unknown>) =>
  step({ kind: 'agent.job', title: `@${agent}: ${title}`, args: { ...args, agent, ...(prompt ? { prompt } : {}) } })

/**
 * Every plan's last stop, however it was made: the work goes to the team. A bug starts with the scout,
 * and nothing reaches the team's vote before it's been tested, reviewed and written up for them.
 */
export function handOut(steps: StepTemplate[], request: string): StepTemplate[] {
  const out = steps.map((s): StepTemplate => {
    const work = AGENT_WORK[s.kind]
    if (!work) return { ...s }
    const part = typeof s.args?.part === 'string' ? ` Only the ${s.args.part} part.` : ''
    return { ...job(work.agent, work.title, work.prompt + part, s.args ?? {}), id: s.id, after: s.after }
  })
  const agents = (list: StepTemplate[]) => list.filter((s) => s.kind === 'agent.job').map((s) => String(s.args?.agent))
  const builds = (list: StepTemplate[]) => agents(list).some((a) => BUILDERS.includes(a))

  const fresh = out.some((s) => s.args?.create)
  if (BUG.test(request) && builds(out) && !fresh && !agents(out).includes('scout')) {
    const first = out.find((s) => s.kind === 'agent.job')!
    const scout = job('scout', 'find the cause', `Find the cause of this, with the file and line: ${request}\nSay which part it's in (frontend or backend). Do not edit anything.`, { project: first.args?.project })
    const at = out.findIndex((s) => !s.args?.plan)
    for (const s of out.slice(at)) if (s.after) s.after = [...s.after, scout.id]
    out.splice(at, 0, scout)
  }

  for (const ship of out.filter((s) => s.kind === 'deploy')) {
    const at = out.indexOf(ship)
    const before = out.slice(0, at)
    const args = { project: ship.args?.project }
    const extra = [
      ...(agents(before).includes('tester') ? [] : [job('tester', 'prove it builds and passes', "Run the tests and the build: both must pass before this ships. This job is your go-ahead for the build, so don't ask first. Report what passed and what failed.", args)]),
      ...(builds(before) && !agents(before).includes('reviewer') ? [job('reviewer', 'check the change', '', args)] : []),
      ...(agents(before).includes('release') ? [] : [job('release', 'write the release notes', 'Read the branch against main and post short release notes for the team: what changed, what was tested, what could go wrong. Keep it under 8 lines. Do not change anything.', args)])
    ]
    if (ship.after && extra.length) {
      extra[0].after = ship.after
      ship.after = [extra[extra.length - 1].id]
    }
    out.splice(at, 0, ...extra)
    ship.title = `@release: ship ${ship.args?.project}`
  }
  return out
}

const OWNS: Record<string, string> = {
  frontend: 'You build the frontend only. Never touch backend code.',
  backend: 'You build the backend only. Never touch frontend code. Report the routes you made, the frontend agent builds on them next.'
}

/** "in vs code", "in vscode", "in vs", "with visual studio code", "in the editor". */
const IN_EDITOR = /\b(?:in|with)\s+(?:vs\s?code|vs|visual\s+studio(?:\s+code)?|code|(?:the\s+)?editor)\b/i

/** Context carried between the parts of one command ("open my portfolio … and start the server"). */
export interface PlanContext {
  project?: string
}

const unquote = (s: string) => s.trim().replace(/^[`'"‘“]+|[`'"’”]+$/g, '').trim()

export function plan(command: string, ctx: PlanContext = {}): Plan {
  const text = command.trim()
  const named = namedProject(text)
  // Then the project an earlier part of the same command named, then the last project used.
  const project = named ?? heardProject(text) ?? ctx.project ?? memory.get('current_project')
  // "start the frontend of my dashboard-crm": just that part, if the project has it.
  // "the backend and the frontend" names no single part: that's all of them.
  const has = project ? projectParts(join(config.projectsDir, project)).map((x) => x.name) : []
  const said = [...text.matchAll(/\b(front-?end|back-?end|client|server|api|web|app)\b/gi)].map((m) => m[1].toLowerCase().replace('-', ''))
  const partWords = [...new Set(said.filter((w) => has.some((x) => x.toLowerCase() === w)))]
  const part = project && partWords.length === 1 ? has.find((x) => x.toLowerCase() === partWords[0]) : undefined
  const p = project ? { project, ...(part ? { part } : {}) } : {}
  const needsProject = (steps: StepTemplate[]): StepTemplate[] =>
    project
      ? steps
      : [step({ kind: 'note', title: 'Which project?', args: { message: 'No project named. Say "my <name>" or "called <name>".', fail: true } })]

  // "lock oggy to me": pin the chat account you last wrote from as the owner.
  if (/^lock\s+(?:oggy\s+)?(?:to\s+)?(?:me|my\s+account)[.!]*$/i.test(text)) {
    return { intent: 'tool.run', label: 'Lock Oggy to you', steps: [step({ kind: 'owner.lock', title: 'Lock Oggy to your chat account' })] }
  }

  // Memory (stubbed group, but cheap enough to support the pnpm preference)
  let m = text.match(/^remember\s+(?:that\s+)?(.+)$/i)
  if (m) {
    const pm = m[1].match(/\buse\s+(pnpm|npm|yarn|bun)\b/i)
    return {
      intent: 'memory.remember',
      steps: [
        pm
          ? step({ kind: 'memory.write', title: `Remember package manager: ${pm[1].toLowerCase()}`, args: { key: 'package_manager', value: pm[1].toLowerCase() } })
          : step({ kind: 'memory.write', title: 'Remember note', args: { key: `note.${Date.now()}`, value: m[1] } })
      ]
    }
  }

  // Workflows. A description comes first: it can say "… and when I say run Code Red workflow, run it".
  if (CREATING.test(text)) return { intent: 'workflow.create', steps: [] }
  m = text.match(/save\s+(?:this|that|it)?\s*as\s+(?:my\s+)?(.+?)\s+workflow/i)
  if (m) {
    const name = unquote(m[1])
    return { intent: 'workflow.save', steps: [step({ kind: 'workflow.save', title: `Save workflow “${name}”`, args: { name } })] }
  }
  if (/\b(show|list)\b.*\bworkflows?\b/i.test(text)) {
    return { intent: 'workflow.list', steps: [step({ kind: 'note', title: 'List saved workflows', args: { list: 'workflows' } })] }
  }
  m = text.match(/\b(?:run|replay|start)\s+(?:my\s+|the\s+)?(?:workflow\s+(.+?)|(.+?)\s+workflow)(?:\s+(?:on|in|for)\s+(?:my\s+|the\s+)?([\w.-]+?)(?:\s+project)?)?\W*$/i)
  if (m) return { intent: 'workflow.run', steps: [], workflowName: unquote(m[1] ?? m[2]), workflowProject: m[3] && (heardProject(text, m[3]) ?? m[3]) }

  // Coding jobs go to @claude in the Switch room; @reviewer checks them before anything ships.
  const claude = (title: string, prompt: string, extra: Record<string, unknown> = {}) =>
    step({ kind: 'agent.job', title: `@claude: ${title}`, args: { ...p, ...extra, agent: 'builder', prompt } })
  const agentJob = (agent: string, title: string, prompt: string, extra: Record<string, unknown> = {}) =>
    step({ kind: 'agent.job', title: `@${agent}: ${title}`, args: { ...p, ...extra, agent, prompt } })
  const tester = (args: Record<string, unknown> = p) =>
    step({ kind: 'agent.job', title: '@tester: prove it works', args: { ...args, agent: 'tester', prompt: 'Prove this job works: run the existing tests, and add tests for what was just built where they are missing. Only change test files. Report what passed and what failed.' } })
  const reviewer = () => step({ kind: 'agent.job', title: '@reviewer: check the change', args: { ...p, agent: 'reviewer' } })
  const verifyBuild = (title = 'Verify the build passes') => step({ kind: 'project.build', title, args: p })
  const deploySteps = () => [step({ kind: 'deploy', title: `Deploy ${project} to production`, args: p })]
  const isChange = (s: string) => /^(add|update|change|make|build|implement|refactor|remove)\b/i.test(s)
  // A change is one agent's job: it writes the code, tests it, and reports. The reviewer only checks before shipping.
  const changeSteps = (prompt: string, shipping = false) => [
    ...buildersFor(prompt, project).map((a) => agentJob(a, prompt, `${prompt}\n${OWNS[a]}\nDone when the files you changed have no type errors.`)),
    tester(),
    ...(shipping ? [reviewer()] : [])
  ]

  // Approvals: deploy is always gated
  if (/\bdeploy\b|\bship\b.*\b(live|prod)/i.test(text)) {
    // "Add dark mode to my portfolio and deploy it": do the change first, then deploy.
    const change = text.replace(/[,\s]*(?:and|then)?\s*(?:deploy|ship)\b.*$/i, '').trim()
    // Only a real code change: "build my portfolio, run the tests and deploy it" is three commands, not a job for @claude.
    if (named && change && isChange(change) && plan(change, ctx).intent === 'code.change') {
      return { intent: 'code.change', label: 'Add feature + deploy', combo: true, steps: needsProject([...changeSteps(change, true), ...deploySteps()]) }
    }
    return { intent: 'deploy', steps: needsProject(deploySteps()) }
  }

  // Delegating
  m = text.match(/\bask\s+(codex|claude(?:\s+code)?)\s+to\s+(.+)$/i)
  if (m) {
    if (/claude/i.test(m[1])) {
      // @claude works in the whole code folder, so only build when you named a project.
      return { intent: 'delegate.claude', steps: named ? [claude(m[2], m[2]), verifyBuild()] : [claude(m[2], m[2])] }
    }
    return {
      intent: 'delegate.codex',
      steps: needsProject([
        step({ kind: 'codex.job', title: `Codex: ${m[2]}`, args: { ...p, prompt: m[2] } }),
        verifyBuild()
      ])
    }
  }

  // Project & code
  // "archive my portfolio room", "I'm done with the react-flow channel" (before "… room" below).
  if (/\b(?:archive|close|remove|delete|done\s+with)\b.*\b(?:room|channel)\b/i.test(text)) {
    return { intent: 'tool.run', label: 'Archive project room', steps: needsProject([step({ kind: 'project.room.archive', title: `Archive ${project}'s room`, args: p })]) }
  }
  // "give my portfolio its own room", "make a room for my portfolio" (before "create … project" below).
  if (/\b(?:give|make|create|open|set\s*up)\b.*\b(?:room|channel)\b/i.test(text) && !/\b(?:new|called)\b/i.test(text)) {
    return { intent: 'tool.run', label: 'Project room', steps: needsProject([step({ kind: 'project.room', title: `Give ${project} its own room`, args: p })]) }
  }
  m = text.match(/\b(?:create|make|start|scaffold|set\s*up)\b.*\bproject\b/i)
  if (m) {
    // A new project needs its own name: never fall back to the last project you used.
    if (!named) {
      return { intent: 'project.create', steps: [step({ kind: 'note', title: 'What should I call it?', args: { message: 'Say what to call the new project, like "… called react-flow".', fail: true } })] }
    }
    const np = { project: named }
    // "… and open it in vs code (after setup)": the last step, once it's built. The agent doesn't need that part.
    const openAfter = /\bopen\b/i.test(text) && IN_EDITOR.test(text)
    const brief = openAfter ? text.replace(/[,\s]*(?:and\s+|then\s+)*open\b.*$/i, '').trim() : text
    return {
      intent: 'project.create',
      label: openAfter ? 'Create project + open in VS Code' : undefined,
      steps: [
        // Its own room first: the project is built there, and every later job for it happens there too.
        step({ kind: 'project.room', title: `Give ${named} its own room`, args: { ...np, create: true, brief } }),
        ...buildersFor(brief).map((a) => step({ kind: 'agent.job', title: `@${a}: build the ${a} of ${named}`, args: { ...np, create: true, agent: a, prompt: `${brief}\n\n${OWNS[a]}` } })),
        step({ kind: 'agent.job', title: '@tester: install, build and prove it works', args: { ...np, agent: 'tester', prompt: 'Prove the new project works: install its packages, run its build and its tests, and add tests where they are missing. This job is your go-ahead for the install and the build, so don\'t ask first. Only change test files. Report what passed and what failed.' } }),
        step({ kind: 'agent.job', title: `@scout: explain ${named}`, args: { ...np, agent: 'scout', prompt: `Explain ${named} in plain words: what it does, how its parts connect, and how to run it. Name the main files. Do not edit anything.` } }),
        ...(openAfter ? [step({ kind: 'project.code', title: `Open ${named} in VS Code`, args: np })] : [])
      ]
    }
  }
  if (/\bfix\b.*\b(failing\s+)?tests?\b/i.test(text)) {
    return {
      intent: 'code.fix_tests',
      steps: needsProject([
        step({ kind: 'project.test', title: 'Run tests to see failures', args: { ...p, allowFail: true } }),
        ...buildersFor(text, project).map((a) => agentJob(a, 'fix the failing tests', text)),
        step({ kind: 'project.test', title: 'Re-run tests', args: p })
      ])
    }
  }
  if (/\bchangelog\b/i.test(text)) {
    return {
      intent: 'code.review',
      label: 'Write changelog',
      steps: needsProject([
        step({ kind: 'git.status', title: 'Collect changes (git status)', args: p }),
        agentJob('scout', 'write a changelog', text)
      ])
    }
  }
  if (/\breview\b/i.test(text)) {
    return {
      intent: 'code.review',
      steps: needsProject([step({ kind: 'git.status', title: 'Collect changes (git status)', args: p }), reviewer()])
    }
  }

  // Apps & commands ("open VS Code" with no project is a quick action below).
  // "open it in vs code", "open in vs", "open react-flow in vscode": the project you named, else the last one used.
  if (/\bopen\b/i.test(text) && (IN_EDITOR.test(text) || (named && /\b(vs\s?code|code)\b/i.test(text)))) {
    const said = text.match(/^open\s+(?:up\s+)?(?:the\s+)?([\w.-]+)\s+(?:project\s+)?(?:in|with)\b/i)?.[1]
    const target = named ?? (said && existsSync(join(config.projectsDir, said)) ? said : project)
    return {
      intent: 'tool.run',
      label: 'Open in VS Code',
      steps: target ? [step({ kind: 'project.code', title: `Open ${target} in VS Code`, args: { project: target } })] : needsProject([])
    }
  }
  if (/\binstall\b.*\b(packages|dependencies|deps|node[_ ]modules)\b|^(npm|pnpm|yarn|bun)\s+(i|install)\b/i.test(text)) {
    return { intent: 'tool.run', label: 'Install packages', steps: needsProject([step({ kind: 'project.install', title: `Install packages for ${project}${part ? `/${part}` : ''}`, args: p })]) }
  }
  // "build my dashboard-crm" is the build itself; "build a login page in …" is a code change (below).
  const buildOnly =
    /^(?:run\s+(?:the\s+)?)?build\b/i.test(text) &&
    text
      .replace(/^(?:run\s+(?:the\s+)?)?build\b/i, '')
      // The project as you said it ("my portfolo", "my dashboard crm"), not as its folder spells it.
      .replace(named ? /\bmy\s+\S+/i : '', '')
      .replace(new RegExp(`\\b(?:${(named ?? '').split(/[-_ .]/).filter(Boolean).join('|') || '$^'})\\b`, 'gi'), '')
      .replace(/\b(the|my|of|for|in|project|app|it|front-?end|back-?end)\b/gi, '')
      .replace(/\W+/g, '') === ''
  if (buildOnly && project) {
    return { intent: 'tool.run', label: 'Run build', steps: needsProject([step({ kind: 'project.build', title: `Build ${project}${part ? `/${part}` : ''}`, args: p })]) }
  }
  if (/\b(stop|kill|shut\s+down|close)\b.*\b(dev\s+)?server\b/i.test(text)) {
    return { intent: 'tool.run', label: 'Stop dev server', steps: needsProject([step({ kind: 'project.stop', title: `Stop the ${project} dev server`, args: p })]) }
  }
  if (
    /\b(start|run|open|launch|boot|spin\s+up|fire\s+up)\b.*\b(dev\s+)?server\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/i.test(text) ||
    (part && /^(start|run|launch|boot|spin\s+up|fire\s+up)\b/i.test(text))
  ) {
    return { intent: 'tool.run', label: 'Start dev server', steps: needsProject([step({ kind: 'project.dev', title: `Start the ${project}${part ? `/${part}` : ''} dev server`, args: p })]) }
  }
  if (/\b(?:run|execute)\b.*\btests?\b|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^test\s+my\b/i.test(text)) {
    return { intent: 'tool.run', label: 'Run tests', steps: needsProject([step({ kind: 'project.test', title: `Run the ${project}${part ? `/${part}` : ''} tests`, args: p })]) }
  }
  if (/\brun\b.*\bbuild\b/i.test(text)) {
    return { intent: 'tool.run', label: 'Run build', steps: needsProject([step({ kind: 'project.build', title: `Build ${project}`, args: p })]) }
  }

  // Quick actions: one toolbox tool, no thinking needed
  const quick = (label: string, ...steps: StepTemplate[]): Plan => ({ intent: 'quick', label, steps })
  if (/^undo\b/i.test(text)) return quick('Undo', step({ kind: 'undo', title: 'Undo the last file change' }))
  if (/\b(take|grab|snap)\b.*\bscreenshot\b|^screenshot\W*$/i.test(text)) {
    return quick('Screenshot', step({ kind: 'screen.shot', title: 'Take a screenshot' }))
  }
  if (/\b(volume|mute|unmute)\b/i.test(text)) {
    const n = Number(text.match(/(\d{1,3})\s*%?/)?.[1] ?? 10)
    const action = /\b(un)?mute\b/i.test(text) ? 'mute' : /\b(up|louder|raise|increase)\b/i.test(text) ? 'up' : /\b(down|quieter|lower|decrease)\b/i.test(text) ? 'down' : 'set'
    return quick('Volume', step({ kind: 'system.volume', title: action === 'set' ? `Volume to ${n}%` : action === 'mute' ? 'Toggle mute' : `Volume ${action}`, args: { action, amount: n } }))
  }
  m = text.match(/^open\s+(?:up\s+)?(?:my\s+|the\s+)?(desktop|documents?|downloads?|pictures?|videos?|music|screenshots?)(?:\s+folder)?\W*$/i)
  if (m) {
    const word = m[1].toLowerCase().replace(/s$/, '')
    const folder = word === 'screenshot' ? 'Pictures\\Screenshots' : `${word[0].toUpperCase()}${word.slice(1)}${word === 'desktop' || word === 'music' ? '' : 's'}`
    return quick('Open folder', step({ kind: 'folder.open', title: `Open ${folder}`, args: { path: folder } }))
  }
  // "open my portfolio project", "open react-flow": one of your projects (not an app of that name), in VS Code.
  m = text.match(/^open\s+(?:up\s+)?(?:my\s+|the\s+)?([\w.-]+)(?:\s+project)?\W*$/i)
  if (m && !findApp(m[1]) && existsSync(join(config.projectsDir, m[1]))) {
    return { intent: 'tool.run', label: 'Open in VS Code', steps: [step({ kind: 'project.code', title: `Open ${m[1]} in VS Code`, args: { project: m[1] } })] }
  }
  m = text.match(/^(open|launch|start|close|quit|exit)\s+(.+?)\W*$/i)
  if (m) {
    const apps = m[2].split(/\s*(?:,|\band\b|&)\s*/i).map((a) => a.replace(/^(?:the|my)\s+/i, '').replace(/\s+app$/i, '').trim()).filter(Boolean)
    if (apps.length && apps.every((a) => findApp(a))) {
      const closing = /^(close|quit|exit)$/i.test(m[1])
      return quick(
        closing ? 'Close apps' : 'Open apps',
        ...apps.map((app) => step({ kind: closing ? 'app.close' : 'app.open', title: `${closing ? 'Close' : 'Open'} ${app}`, args: { app } }))
      )
    }
  }

  // "run code red": a saved workflow, even without the word.
  m = text.match(/^(?:run|start|trigger|kick off)\s+(?:my\s+|the\s+)?(.+?)\W*$/i)
  if (m && findWorkflow(unquote(m[1]))) return { intent: 'workflow.run', steps: [], workflowName: unquote(m[1]) }

  // Generic code change: "Add a dark mode toggle to my portfolio."
  if (named && isChange(text)) {
    return { intent: 'code.change', steps: needsProject(changeSteps(text)) }
  }

  return {
    intent: 'unknown',
    steps: [step({ kind: 'note', title: 'Not understood', args: { message: `I don't know how to do that yet: “${text}”`, fail: true } })]
  }
}

/* ---------- several commands in one sentence ---------- */

/** "open my portfolio in vs code and start the server" -> ["open my portfolio in vs code", "start the server"] */
export function splitClauses(text: string): string[] {
  return text
    .split(/\s*(?:[,;]\s*(?:and\s+)?(?:then\s+)?|\s+and\s+then\s+|\s+then\s+|\s+after\s+that\s+|\s+and\s+(?:also\s+)?|\.\s+)/i)
    .map((c) => c.trim().replace(/^(?:then|also|and)\s+/i, '').replace(/[.!?]+$/, ''))
    .filter(Boolean)
}

/**
 * The same step twice in a row (a build that ends one part and starts the next) only runs once, and
 * a project opens in VS Code once ("open my portfolio … and open it in vs code").
 */
function dedupe(steps: StepTemplate[]): StepTemplate[] {
  const same = (a: StepTemplate, b: StepTemplate) => a.kind === b.kind && JSON.stringify(a.args ?? {}) === JSON.stringify(b.args ?? {})
  return steps.filter((s, i) => (i === 0 || !same(s, steps[i - 1])) && !(s.kind === 'project.code' && steps.slice(0, i).some((e) => same(e, s))))
}

/** "create a workflow …", "make me a workflow where …", but not a GitHub Actions one in a project. */
const CREATING = /\b(?:create|make|build|design|set\s*up|add|new)\b(?:(?!\b(?:github|actions?|ci|cd|yaml)\b)[^.?!]){0,40}\bworkflow\b/i

/** The workflow you mean: its name, however it was said or heard ("code-red", "coat red"). Nobody guesses between two. */
export function findWorkflow(said?: string): Workflow | undefined {
  if (!said) return undefined
  const exact = workflows.byName(said)
  if (exact) return exact
  const all = workflows.list()
  const name = squash(said)
  const near = all.filter((w) => squash(w.name) === name)
  if (near.length === 1) return near[0]
  const close = name.length >= 5 ? all.filter((w) => lettersApart(squash(w.name), name) <= 2) : []
  return close.length === 1 ? close[0] : undefined
}

/**
 * The steps of a run of this workflow. One you described runs exactly as drawn, on its project or the
 * one this run names; one saved from an earlier job goes through the team's usual hand-outs.
 */
export function workflowRunSteps(wf: Workflow, command: string, project?: string): StepTemplate[] {
  if (!wf.asked) return handOut(wf.steps, command)
  if (!project || !wf.project || project === wf.project) return wf.steps
  const swap = (s: string) => s.split(wf.project!).join(project)
  return wf.steps.map((s) => ({
    ...s,
    title: swap(s.title),
    args: { ...s.args, ...(s.args?.project ? { project } : {}), ...(typeof s.args?.prompt === 'string' ? { prompt: swap(s.args.prompt) } : {}) }
  }))
}

/** Workflow steps for "run my <name> workflow" inside a longer command, or a step saying it doesn't exist. */
function workflowSteps(p: Plan): StepTemplate[] {
  const wf = findWorkflow(p.workflowName)
  if (!wf) return [step({ kind: 'note', title: 'Workflow not found', args: { message: `No saved workflow named “${p.workflowName}”.`, fail: true } })]
  workflows.touch(wf.id)
  return wf.asked ? workflowRunSteps(wf, p.workflowName!, p.workflowProject) : wf.steps // ids (and "after" links) get fresh ones when the run starts
}

const kinds = (p: Plan) => p.steps.map((s) => s.kind).join(',')

/** Asks Claude for a plan, given the command and the real file names it may use. */
export type LlmPlanner = (command: string, catalog: { files: string[]; dirs: string[] }, help: PlanHelp) => Promise<ClaudeAnswer>

/** Tools Claude may plan with: everything you could ask for, not Oggy's own bookkeeping. */
export const PLANNABLE = (Object.keys(TOOLBOX) as StepKind[]).filter((k) => !['note', 'workflow.create', 'workflow.save', 'memory.write', 'codex.job', ...(Object.keys(AGENT_WORK) as StepKind[])].includes(k))

/** Oggy's open question from the plan lane, answered by your next command (for 10 minutes). */
const PENDING = 'plan.pending'
function followUp(): { command: string; question: string } | undefined {
  try {
    const p = JSON.parse(memory.get(PENDING) || 'null') as { command: string; question: string; at: number } | null
    return p && Date.now() - p.at < 10 * 60_000 ? p : undefined
  } catch {
    return undefined
  }
}

const failPlan = (title: string, message: string): Plan => ({ intent: 'unknown', steps: [step({ kind: 'note', title, args: { message, fail: true } })] })

/**
 * The real file a path from Claude means. It sometimes drops a folder ("~\\Video.mp4" for
 * "~\\Downloads\\Video.mp4"): when exactly one file on the list has that name, that's the one.
 */
export function realFile(path: string, files: string[]): string | undefined {
  const full = resolvePath(path).toLowerCase()
  const exact = files.find((f) => f.toLowerCase() === full)
  if (exact) return exact
  const same = files.filter((f) => basename(f).toLowerCase() === basename(full))
  return same.length === 1 ? same[0] : undefined
}

/** Oggy's check of Claude's plan: the plan, ready to run, or what's wrong with it. */
function checked(answer: ClaudePlan, files: string[], request: string): Plan | { problem: string } {
  const steps: StepTemplate[] = []
  // Claude names its steps ("s1") and says which wait for which; those become our step ids.
  const idFor = new Map<string, string>()
  answer.steps.forEach((s, i) => idFor.set(String(s.id ?? `#${i}`), newId()))
  for (const [i, s] of answer.steps.entries()) {
    if (!PLANNABLE.includes(s.tool as StepKind)) return { problem: `“${s.tool}” isn't a tool in the toolbox.` }
    const args = s.args && typeof s.args === 'object' ? { ...s.args } : {}
    // The owner's own Claude isn't on the team: only when they ask for it by name.
    if (s.tool === 'agent.job' && agentFor(args.agent)?.isDefault && !/\bclaude\b/i.test(request)) return { problem: `${args.agent} isn't on the team: use frontend, backend, tester, scout or reviewer.` }
    // Files: only real ones, from the list. Claude can't invent a path.
    if (args.from !== undefined) {
      const said = (Array.isArray(args.from) ? args.from : [args.from]).map(String)
      const from = said.map((p) => realFile(p, files))
      const invented = said[from.indexOf(undefined)]
      if (invented !== undefined) return { problem: `${invented} isn't on the file list. Copy the path exactly.` }
      args.from = from
    }
    if (args.select !== undefined) {
      const file = realFile(String(args.select), files)
      if (!file) return { problem: `${args.select} isn't on the file list. Copy the path exactly.` }
      args.select = file
      args.path = dirname(file)
    }
    const kind = s.tool as StepKind
    const problem = TOOLBOX[kind].check?.(args)
    if (problem) return { problem }
    // No "after" from Claude: one after another, like a list. Unknown ids are dropped.
    const after = Array.isArray(s.after) ? s.after.map((a) => idFor.get(String(a))).filter((a): a is string => Boolean(a)) : undefined
    steps.push({ id: idFor.get(String(s.id ?? `#${i}`))!, kind, title: String(s.title || kind).slice(0, 120), args, after })
  }

  // What couldn't be done is said at the end, never dropped quietly.
  const left = answer.skipped ? [step({ kind: 'note', title: "Couldn't do all of it", args: { message: answer.skipped } })] : []
  const risky = steps.some((s) => {
    const r = TOOLBOX[s.kind].risky
    return typeof r === 'function' ? r(s.args ?? {}) : r
  })
  // One safe step (open an app) just runs; anything bigger or risky shows the plan and asks.
  if (steps.length === 1 && !risky) return { intent: 'plan', label: answer.label, steps: [...steps, ...left] }
  const list = steps.map((s, i) => `${steps.length > 1 ? `${i + 1}. ` : ''}${TOOLBOX[s.kind].preview?.(s.args ?? {}) || s.title}`).join('  ')
  const preview = answer.skipped ? `${list}  (Not this part: ${answer.skipped})` : list
  const go = step({ kind: 'note', title: 'Check the plan', risky: true, args: { plan: true, preview, message: 'You said go.' } })
  // Everything waits for your go, including steps that wait for nothing else.
  for (const s of steps) if (s.after) s.after = [go.id, ...s.after]
  return { intent: 'plan', label: answer.label, steps: [go, ...steps, ...left] }
}

/** What you asked for lately and how it went, oldest first: what "it" and "that" point at. */
function recentlyDone(): string[] {
  return runs
    .list(10)
    .filter((r) => r.status === 'done' || r.status === 'failed')
    .slice(0, 5)
    .reverse()
    .map((r) => `- "${r.command}" (${r.status}): ${(r.summary ?? '').slice(0, 200)}`)
}

/**
 * The plan lane, for anything the keywords don't know. Oggy collects the facts itself (real file
 * names, what you just did), Claude only decides, and Oggy checks the answer before anything runs:
 * every tool must be in the toolbox, every file must be on the list Claude was given, every step must
 * pass its tool's checks. A plan that fails that, or a "can't", gets one more careful look with the
 * reason in hand. Then you see the plan and say go (one yes covers the whole plan).
 */
async function planLane(command: string, llm: LlmPlanner, onNote: (text: string) => void): Promise<Plan> {
  // Answering Oggy's last question ("the docx one")? Plan the original request with your answer.
  const pending = followUp()
  const request = pending ? `${pending.command}\n(Oggy asked: "${pending.question}". The user answered: "${command}")` : command
  memory.set(PENDING, '')

  onNote(pending ? 'Planning with your answer…' : 'Planning…')
  const catalog = fileCatalog()
  const recent = recentlyDone()
  let correction: string | undefined
  for (const careful of [false, true]) {
    const answer = await llm(request, catalog, { recent, correction, careful })
    if ('ask' in answer) {
      memory.set(PENDING, JSON.stringify({ command: pending?.command ?? command, question: answer.ask, at: Date.now() }))
      return { intent: 'unknown', label: 'Question', steps: [step({ kind: 'note', title: 'Which one?', args: { message: `${answer.ask} Just tell me.` } })] }
    }
    if ('cannot' in answer) {
      if (careful) return failPlan("Can't do that yet", answer.cannot)
      correction = `it was judged impossible ("${answer.cannot}"). Do every part the tools allow, and use "skipped" for the rest.`
    } else {
      const result = checked(answer, catalog.files, request)
      if (!('problem' in result)) return result
      if (careful) return failPlan("Can't do that", result.problem)
      correction = `the plan was rejected: ${result.problem}`
    }
    onNote('Taking a closer look…')
  }
  return failPlan("Can't do that yet", "Oggy couldn't work that out.")
}

/** Designs a workflow from your words (Claude, in real use). */
export type WorkflowDesigner = (text: string, help: { correction?: string }) => Promise<WorkflowAnswer>

/**
 * You described a workflow: Claude designs it, Oggy checks the design against what's real, and a design
 * that fails gets one more look with the reason in hand. A missing name comes back to you as a question.
 */
async function workflowLane(command: string, design: WorkflowDesigner, onNote: (text: string) => void): Promise<Plan> {
  const pending = followUp()
  const request = pending ? `${pending.command}\n(Oggy asked: "${pending.question}". The user answered: "${command}")` : command
  memory.set(PENDING, '')
  onNote('Designing the workflow…')
  let correction: string | undefined
  for (const last of [false, true]) {
    const answer = await design(request, { correction })
    if ('ask' in answer) {
      memory.set(PENDING, JSON.stringify({ command: pending?.command ?? command, question: answer.ask, at: Date.now() }))
      return { intent: 'unknown', label: 'Question', steps: [step({ kind: 'note', title: 'Which one?', args: { message: `${answer.ask} Just tell me.` } })] }
    }
    if ('cannot' in answer) return failPlan("Can't build that workflow", answer.cannot)
    const project = answer.project ? (heardProject(request, String(answer.project)) ?? String(answer.project)) : undefined
    const built = buildWorkflow({ ...answer, project }, request)
    if (!('problem' in built)) {
      return { intent: 'workflow.create', label: `Create ${built.name}`, steps: [step({ kind: 'workflow.create', title: `Save workflow “${built.name}”`, args: { workflow: built, asked: pending?.command ?? command } })] }
    }
    if (last) return failPlan("Can't build that workflow", built.problem)
    correction = `it was rejected: ${built.problem}`
    onNote('Taking a closer look…')
  }
  return failPlan("Can't build that workflow", "Oggy couldn't work that out.")
}

/**
 * "create a project called x with react and tailwind, then open it in vs code and start the dev server":
 * the "and"s up front describe the project (one job for the agent); the known commands at the end run
 * after it's built, on the new project.
 */
function createThen(command: string, whole: Plan, clauses: string[]): Plan {
  const name = whole.steps.find((s) => s.kind === 'agent.job')?.args?.project
  if (typeof name !== 'string') return whole
  const tail: Plan[] = []
  let i = clauses.length
  while (i > 1) {
    const p = plan(clauses[i - 1], { project: name })
    if (['unknown', 'project.create', 'workflow.run'].includes(p.intent)) break
    tail.unshift(p)
    i--
  }
  if (!tail.length) return whole
  const brief = command.slice(0, command.lastIndexOf(clauses[i])).replace(/[\s,;]*(?:\b(?:and|then|after\s+that)\b[\s,]*)*$/i, '')
  const head = plan(brief)
  if (head.intent !== 'project.create') return whole
  return {
    intent: 'project.create',
    label: ['Create project', ...new Set(tail.map(labelFor))].join(' + '),
    steps: dedupe([...head.steps, ...tail.flatMap((p) => p.steps)])
  }
}

/**
 * Plan a whole command, which may be several commands joined by "and", "then" or commas.
 * Known commands (keywords) run straight away, part by part, each with the project from the parts
 * before it. If any part isn't known, the whole sentence goes to the plan lane instead.
 */
export async function planAll(command: string, llm: LlmPlanner, onNote: (text: string) => void = () => {}, design?: WorkflowDesigner): Promise<Plan> {
  const p = await arrange(command, llm, onNote, design)
  return { ...p, steps: handOut(p.steps, command) }
}

async function arrange(command: string, llm: LlmPlanner, onNote: (text: string) => void, design?: WorkflowDesigner): Promise<Plan> {
  const whole = plan(command)
  const clauses = splitClauses(command)

  // A workflow is described in one breath: its "and"s and "then"s are the workflow, not separate commands.
  const open = followUp()
  // A new description is a new workflow, not the answer to a question you left open.
  if (whole.intent === 'workflow.create') memory.set(PENDING, '')
  if (whole.intent === 'workflow.create' || (whole.intent === 'unknown' && open && CREATING.test(open.command))) {
    return design ? workflowLane(command, design, onNote) : failPlan("Can't build that workflow", 'Workflows need Claude Code to design them.')
  }

  // "This is broken, fix it and deploy": there's work before the deploy, so it needs a real plan.
  if (whole.intent === 'deploy' && BUG.test(command.replace(/\b(?:deploy|ship)\b.*$/i, ''))) return planLane(command, llm, onNote)

  // A known command means you moved on: drop any open question.
  if (whole.intent !== 'unknown') memory.set(PENDING, '')
  if (whole.intent === 'project.create') return createThen(command, whole, clauses)
  if (clauses.length < 2 || followUp()) return whole.intent !== 'unknown' ? whole : planLane(command, llm, onNote)

  // "close chrome and notepad" is one command whose second half means nothing alone,
  // so the whole-sentence plan wins when it covers more than any single part.
  const quick = clauses.map((c) => plan(c))
  const wholeCoversMore = whole.intent !== 'unknown' && !quick.some((q) => q.intent !== 'unknown' && kinds(q) === kinds(whole))
  if (wholeCoversMore && quick.some((q) => q.intent === 'unknown')) return whole
  // Deliberate combos ("add dark mode to my portfolio and deploy it") keep their own plan.
  if (whole.combo && wholeCoversMore) return whole

  const ctx: PlanContext = {}
  const parts: Plan[] = []
  for (const c of clauses) {
    const p = plan(c, ctx)
    // "put my resume, offer letter and interview docs in …": not keyword commands at all.
    if (p.intent === 'unknown') return planLane(command, llm, onNote)
    const project = p.steps.find((s) => typeof s.args?.project === 'string')?.args?.project
    if (typeof project === 'string') ctx.project = project
    parts.push(p.intent === 'workflow.run' ? { ...p, steps: workflowSteps(p) } : p)
  }

  const labels = [...new Set(parts.map(labelFor))]
  return {
    intent: 'chain',
    label: labels.length > 3 ? `${labels.slice(0, 2).join(' + ')} + ${labels.length - 2} more` : labels.join(' + '),
    steps: dedupe(parts.flatMap((p) => p.steps))
  }
}
