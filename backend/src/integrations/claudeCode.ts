import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasScript, projectParts, type Part } from '../tools.js'
import { config } from '../config.js'
import { memory } from '../db.js'
import { people } from '../team.js'
import type { WorkflowAnswer, WorkflowDesign } from '../workflow.js'

const TIMEOUT_MS = 120_000

export interface ToolInfo {
  name: string
  title: string
  args: string
  risky: boolean | 'depends'
}

export interface ClaudePlan {
  /** Short name for the job, e.g. "Organise job documents". */
  label: string
  /** `id` names a step; `after` lists the ids it waits for (none: it runs as soon as the plan starts). */
  steps: { id?: string; tool: string; title: string; args: Record<string, unknown>; after?: string[] }[]
  /** The part of the command these tools can't do, in one sentence. */
  skipped?: string
}

/** What helps Claude work out what you meant. */
export interface PlanHelp {
  /** What you asked for lately and how it went, oldest first, so "it" and "that" mean something. */
  recent: string[]
  /** A first try went wrong: what happened, for a second look. */
  correction?: string
  /** Use the stronger model: the quick one couldn't do it. */
  careful?: boolean
}

/**
 * Your project folders, with their parts and scripts, so "my dashboard-crm" matches a real one
 * and plans can say { part: "frontend" }: "dashboard-crm [frontend/: dev, build, start, lint | backend/: start, dev]".
 */
function projects(): string[] {
  try {
    if (!existsSync(config.projectsDir)) return []
    return readdirSync(config.projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const parts = projectParts(join(config.projectsDir, e.name))
        const scripts = (p: Part) => Object.keys(p.scripts).filter((s) => hasScript(p, s)).join(', ') || 'no scripts'
        if (!parts.length) return e.name
        if (parts.length === 1 && !parts[0].name) return `${e.name} [${scripts(parts[0])}]`
        return `${e.name} [${parts.map((p) => `${p.name}/: ${scripts(p)}`).join(' | ')}]`
      })
  } catch {
    return []
  }
}

/**
 * The real files of the projects a command is about (named in it, else the current one), so the
 * planner can tell an agent exactly which files to change instead of letting it search.
 */
function projectFiles(text: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(config.projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
  const t = text.toLowerCase()
  // "dashboard-crm", or a distinctive part of the name ("dashboard").
  let hits = names.filter((n) => t.includes(n.toLowerCase()) || n.toLowerCase().split(/[-_ .]/).some((w) => w.length >= 5 && t.includes(w)))
  const current = memory.get('current_project')
  if (!hits.length && current && names.includes(current)) hits = [current]
  return hits.slice(0, 2).flatMap((name) => {
    const r = spawnSync('git', ['ls-files'], { cwd: join(config.projectsDir, name), encoding: 'utf8', windowsHide: true })
    const files = (r.stdout ?? '')
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f && !/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|lock)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(f))
    return files.length ? ['', `Files in ${name} (from git):`, ...files.slice(0, 400)] : []
  })
}

export type ClaudeAnswer = ClaudePlan | { cannot: string } | { ask: string }

/** "C:\Users\me\Desktop\a.pdf" -> "~\Desktop\a.pdf": shorter for the prompt, and resolvePath reads it back. */
const short = (p: string) => (p.toLowerCase().startsWith(homedir().toLowerCase()) ? `~${p.slice(homedir().length)}` : p)

/**
 * Ask the local Claude Code CLI (your Claude login, headless) to plan a command from the toolbox.
 * It gets the real names of your files and may only pick from them; Oggy checks that afterwards.
 * Returns the plan, a question when it isn't sure, or a reason it can't be done.
 */
export function planWithClaude(text: string, toolbox: ToolInfo[], catalog: { files: string[]; dirs: string[] }, help: PlanHelp = { recent: [] }): Promise<ClaudeAnswer> {
  const now = new Date()
  const prompt = [
    'You are the planner for Oggy, a desktop assistant on Windows. Turn the command into steps,',
    'using ONLY these tools (name, what it does, args shape, risky):',
    ...toolbox.map((t) => `- ${t.name}: ${t.title}. args ${t.args}${t.risky === true ? ' [risky]' : ''}`),
    '',
    'Facts:',
    `- Now: ${now.toString()}`,
    `- Owner: ${config.owner.name}. Home folder: ${process.env.USERPROFILE ?? '~'}`,
    `- Projects (for { project }, and { part } when a project is split into sub-folders): ${projects().join('; ') || 'none'}`,
    '- Tell agents which part to work in when it matters ("in dashboard-crm/backend").',
    `- Allowed folders: ${config.safety.folders.join('; ')}`,
    '',
    ...projectFiles(text),
    '',
    'Your files (~ is the home folder), newest first:',
    ...catalog.files.map(short),
    '',
    'Your folders:',
    ...catalog.dirs.map(short),
    '',
    ...(help.recent.length ? ['What the user asked for lately (oldest first), so "it", "that" and "again" have a meaning:', ...help.recent, ''] : []),
    'Understanding what they mean:',
    '- Commands are usually dictated by voice, so expect wrong words, wrong plurals and sound-alikes. "teams room" is the',
    '  team room, "my down load folder" is Downloads. Work out what they most likely meant from the meaning, their files,',
    '  their projects and what they just did, and do that. Never fail on the literal words when the meaning is clear.',
    '- "it", "that", "this file", "the same one" and "again" point at the recent commands above.',
    '- "open", "play", "watch" or "read" a FILE means file.open, so it really opens. Use folder.open with select only when',
    '  they ask where a file is, or to show it in its folder.',
    '- "latest", "newest" or "last" means the first match in the file list, which is newest first, inside the folder they',
    '  named. "first video" means the newest video in that folder (mp4, mov, mkv, avi, webm, wmv, m4v).',
    '- If part of the command is impossible, still plan the parts that work and put what you left out in "skipped".',
    '  Rooms take text only, so for "send a screenshot to the team" take the screenshot, room.post that it was taken and',
    '  where it is, and say in "skipped" that the image itself could not be attached.',
    '',
    'Rules:',
    '- Files the user describes ("my resume", "the offer letter", "interview docs") go in { from: [...] } as exact paths',
    '  copied from the list above, character for character, with every folder in them. Match by meaning (a CV is a resume).',
    '  Never invent or change a path.',
    '- A destination folder is { to: "..." }: an existing folder path from the list, or a new name like "~\\Desktop\\Jobs"',
    '  (put new folders next to the files when they are all in one place, else in ~\\Documents). Moving creates it.',
    '- Keep it minimal: only the steps the user asked for, in order. Titles are short and plain, like "Move job documents to Jobs".',
    '- Oggy only coordinates. All work on a project goes to the team with agent.job, and each specialist does their own part, like a factory:',
    '  * backend builds server, API and database work. frontend builds UI. They never do each other\'s part.',
    '  * Only agents with real work: a bug in the server gets backend, not frontend too. Never add an agent "to check" its side.',
    '  * A job that really changes both gets both, backend first so frontend can build on its routes, one after the other: they share one folder and branch.',
    '  * tester always follows the builders, to prove the work with tests.',
    '  * scout finds the cause of every bug first, and explains things. It never edits.',
    `  * Live server logs ("check the render logs", "is anything wrong in prod") are a scout job with { project } and the word "logs" in the prompt: Oggy fetches the real logs from Render for it. Projects on Render: ${Object.keys(config.deploy).filter((p) => config.deploy[p].service).join(', ') || 'none'}. Never skip this as impossible.`,
    '  * After the scout, the bug goes to whoever owns that part: a frontend bug to frontend, a backend bug to backend.',
    '  * reviewer checks before shipping, or when asked.',
    '  * To ship, end the plan with the deploy tool. The team votes, then the release agent does the deploy. Never give release a job yourself.',
    '  * Never assume earlier work still exists or name a branch: to fix something, plan the fix.',
    '  * The default agent is the owner\'s personal one: use it only if they ask for Claude by name.',
    '- Give each agent an exact job, so it doesn\'t have to search: the files to change (from the project files',
    '  below), the error if there is one, and what "done" means ("Done when GET /version returns 200 with the',
    '  version and its test passes"). Titles say who, like "@backend: add GET /version".',
    '- "Done" uses the FASTEST proof: the relevant test, or a type check (tsc --noEmit) for a UI change. Never ask for',
    '  a full production build or a package install for a small change: those take minutes.',
    '  Scope the proof to the job: "no type errors in the files you changed", never "tsc passes" for the whole project,',
    '  because errors that were already there in other files are not this job.',
    '- Give every step an "id" ("s1", "s2"…) and an "after" list of the ids it must wait for. Steps that don\'t',
    '  depend on each other wait for the same ids and run at the same time. The first steps have "after": [].',
    '- Moving, deleting or sending and not sure which file they mean (two offer letters, nothing that fits): ask.',
    '  For opening a file, a wrong guess costs nothing: pick the best match and go.',
    '- Use "cannot" only when none of it can be done with these tools; do not improvise.',
    '',
    'Reply with JSON only, no prose, exactly one of:',
    '{"label": "...", "steps": [{"id": "s1", "tool": "...", "title": "...", "args": {...}, "after": []}], "skipped": "only if part of it could not be done"}',
    '{"ask": "one short question for the user"}',
    '{"cannot": "one short sentence why"}',
    '',
    ...(help.correction ? [`A first try went wrong: ${help.correction}`, 'Look again and fix that.', ''] : []),
    `Command: ${text}`
  ].join('\n')

  return askClaude<Partial<ClaudePlan> & { cannot?: string; ask?: string }>(prompt, help.careful ? 'sonnet' : 'haiku').then(
    (parsed): ClaudeAnswer => {
      if (parsed.ask) return { ask: String(parsed.ask) }
      if (parsed.cannot) return { cannot: String(parsed.cannot) }
      if (!Array.isArray(parsed.steps) || !parsed.steps.length) return { cannot: "Claude didn't return any steps." }
      return { label: String(parsed.label ?? 'Plan'), steps: parsed.steps, skipped: parsed.skipped ? String(parsed.skipped) : undefined }
    },
    (err: Error): ClaudeAnswer => ({ cannot: err.message })
  )
}

/**
 * Turn what you described into a workflow. Claude only designs it: Oggy checks every agent, person and
 * project in the answer against what's real before anything is saved (buildWorkflow in workflow.ts).
 */
export function designWorkflow(text: string, help: { correction?: string } = {}): Promise<WorkflowAnswer> {
  const team = people()
  const prompt = [
    'You design workflows for Oggy, which coordinates a team of agents in Switch rooms. Turn the description into steps.',
    '',
    'The agents (use these aliases, and pick by what each does):',
    ...Object.values(config.switch.agents)
      .filter((a) => !a.isDefault || /\bclaude\b/i.test(text))
      .map((a) => `- ${a.alias}: ${a.does}`),
    '',
    `The people: ${team.map((p, i) => (i ? p.name : `${p.name} (the owner, "me" and "I" mean them)`)).join(', ')}`,
    `Projects: ${projects().join('; ') || 'none'}`,
    `Projects that can deploy: ${Object.keys(config.deploy).join(', ') || 'none'}`,
    '',
    'Each step is one of:',
    '- {"do": "agent", "agent": alias, "title": "...", "prompt": "the exact job"}: one agent\'s job.',
    '- {"do": "rollback", "title": "..."}: the release agent reverts the deploy on the live branch, and Oggy checks the site. Use this for any rollback.',
    '- {"do": "deploy", "title": "..."}: the release agent ships the branch, and Oggy checks the site. Use this for any deploy or redeploy.',
    '- {"do": "post", "room": "team" or "oggyDaily", "title": "..."}: the agent before it posts its report itself, word for word, in the job\'s thread. Coding reports go in "team" (the project\'s room), everyday ones in "oggyDaily". If the room refuses, Oggy posts it for them.',
    '',
    'Every step also takes:',
    '- "id" ("s1", "s2"…) and "after": the ids it waits for. Things said to happen "while" or "at the same time" share the same "after". The first steps have "after": [].',
    '- "question" (agent steps): a yes/no the agent must settle, when a later step depends on it. Put it on the agent who finds that out.',
    '- "when": {"step": id, "is": "yes" or "no"}: run only on that answer. Otherwise it is skipped and the workflow goes on.',
    '- "ask": {"who": ["me" or a person\'s name], "question": "short, what they are approving", "ifNo": "continue" or "stop"}: someone must say yes before it runs.',
    '',
    'Rules:',
    '- Only what they described, in their order. Add no agents, reviews or checks they did not ask for.',
    '- "ask me before X" and "NAME approves X" both go on step X as "ask", never as a step of their own. Keep each person they named.',
    '- "ifNo" is "continue" when the rest still makes sense without that step, like a rollback they turn down, or a report that should still be written after a redeploy is refused. Otherwise "stop".',
    '- Reports: an agent writes it in a job (the prompt says what it must cover, and that its final message is the report itself), then a "post" step right after it.',
    '- Agents see what earlier steps found, so a prompt can say "the fix for what was found". Prompts are exact: what to do, and what "done" means. A prompt never contains an @ mention.',
    '- Log hunting and checking what is down must not change code: say so in the prompt. Only the step that writes the fix changes code.',
    '- A short title says what happens, without the agent\'s name ("find what broke in the logs").',
    '- If they gave the workflow no name, or a job names nobody and the agents don\'t make it obvious, ask. Otherwise do not ask.',
    '- "project" is the folder name from Projects, or null if they named none. Deploys and rollbacks need one.',
    '- Everyday workflows (mail, calendar, notes, to-dos, bills, planning the day) use only the assistant agent, with "project": null, and post in "oggyDaily". Its prompts say exactly what to read and where to write (for example "add each task to my Notion page To-do").',
    '- Name the Notion page in the prompt only if they named one. The assistant uses the page with exactly that name, and creates it if it isn\'t there.',
    '- The assistant reads mail and calendar, writes in Notion, and drafts emails. A prompt never asks it to send or delete email, accept invites, pay or buy: it drafts, and the owner sends.',
    '- Everyday reports are short, for a chat room: counts, titles and what to do next, never whole emails or personal details. Say so in the prompt; the details go in Notion.',
    '- "schedule": when they said it should run by itself ("every morning at 9", "every Sunday evening"), {"days": "daily", "weekdays", "weekends" or a list like ["mon", "thu"], "time": "HH:MM" in 24-hour time}; evening means 18:00, morning 09:00 unless they gave a time. Otherwise null.',
    '',
    'Reply with JSON only, no prose, exactly one of:',
    '{"name": "the name they gave it", "description": "one sentence", "project": "...", "schedule": null, "steps": [...]}',
    '{"ask": "one short question"}',
    '{"cannot": "one short sentence why"}',
    '',
    ...(help.correction ? [`A first try went wrong: ${help.correction}`, 'Look again and fix that.', ''] : []),
    `What they described: ${text}`
  ].join('\n')

  return askClaude<WorkflowDesign & { cannot?: string; ask?: string }>(prompt, 'sonnet').then(
    (parsed): WorkflowAnswer => (parsed.ask ? { ask: String(parsed.ask) } : parsed.cannot ? { cannot: String(parsed.cannot) } : parsed),
    (err: Error): WorkflowAnswer => ({ cannot: err.message })
  )
}

/** Ask the local Claude Code CLI (headless) something whose answer is one JSON object. */
function askClaude<T>(prompt: string, model = 'haiku'): Promise<T> {
  return new Promise((resolve, reject) => {
    let out = ''
    const child = spawn(config.claudeBin, ['-p', '--model', model, '--output-format', 'text'], {
      cwd: config.dataDir, // away from any project's CLAUDE.md
      windowsHide: true
    })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (err) => reject(new Error(`Couldn't run Claude Code (${err.message}).`)))
    child.on('close', () => {
      clearTimeout(timer)
      // The JSON object, even if wrapped in a code fence or a sentence.
      try {
        resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as T)
      } catch {
        reject(new Error("Claude's answer wasn't readable."))
      }
    })
    child.stdin.end(prompt)
  })
}

export interface Explanation {
  title: string
  summary: string
  sections: { key: 'wrong' | 'why' | 'changed' | 'tested'; text: string; refs: { path: string; from: number; to: number }[] }[]
  files: { path: string; why: string }[]
  risks: string[]
  tests?: { ok: boolean; text: string }
}

const SECTION_KEYS = ['wrong', 'why', 'changed', 'tested'] as const

/** Line refs from Claude, kept only when they name a changed file. */
function refsOf(v: unknown, paths: Set<string>): { path: string; from: number; to: number }[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => ({ path: String(r?.path ?? ''), from: Number(r?.from), to: Number(r?.to ?? r?.from) }))
    .filter((r) => paths.has(r.path) && r.from > 0 && r.to >= r.from)
    .slice(0, 4)
}

/**
 * Explain what the agents changed to the person who asked, in plain words, as four short boxes
 * (what was wrong, why it happened, what changed, how it's tested), each pointing at its lines.
 * `diff` has line numbers, so the boxes can point at real lines.
 */
export async function explainChanges(command: string, reports: string[], diff: string, paths: string[]): Promise<Explanation> {
  const prompt = [
    'You explain code changes to the person who asked for them. They want to understand what changed',
    'and what it means, without reading the code. Plain, friendly words, short sentences. No jargon unless needed.',
    '',
    `They asked: "${command}"`,
    '',
    'What the agents reported:',
    ...(reports.length ? reports : ['(nothing)']),
    '',
    'The changes, file by file. Each line: its number in the file now (removed lines show their old number),',
    'then "+" added, "-" removed, or " " unchanged:',
    diff.trim() || '(no files changed in this job)',
    '',
    'If nothing changed: say so plainly in the summary, explain from the reports why (it already existed, it was only',
    'a question, they got stuck) and where the work is if they mention it (a branch). If the agents are waiting on',
    "the user for a choice, end the summary with that question. Boxes that don't apply can say so in a few words.",
    '',
    'Reply with JSON only, no prose:',
    '{"title": "2-5 words, like \"Register crash fix\" or \"Health check route\"",',
    ' "summary": "1-2 sentences: what changed and what it means for them, as behaviour",',
    ' "sections": [',
    '   {"key": "wrong", "text": "1-2 sentences: what was wrong or missing before (for a new feature: what was missing)", "refs": [{"path": "...", "from": 22, "to": 24}]},',
    '   {"key": "why", "text": "1-2 sentences: why it happened (the cause), or why it is needed", "refs": [...]},',
    '   {"key": "changed", "text": "1-3 sentences: what the change does now", "refs": [...]},',
    '   {"key": "tested", "text": "1-2 sentences: how it was tested, from the reports (tests run, results). Say plainly if nobody tested it.", "refs": [...]}',
    ' ],',
    ' "files": [{"path": "the exact path from the list", "why": "one sentence: what this change does"}],',
    ' "risks": ["at most 3 short, real problems worth checking before keeping it (an empty test, a changed API, the fix missing',
    '           the cause); never comment on how the changes were shown to you; [] if it looks fine"],',
    ' "tests": {"ok": true, "text": "13 passing"} or null when the reports show no test run}',
    'refs: the exact changed lines each box is about (paths from the list, line numbers from the left column).',
    "Use [] when a box isn't about specific lines."
  ].join('\n')
  const r = await askClaude<Record<string, any>>(prompt)
  const known = new Set(paths)
  const sections = SECTION_KEYS.map((key) => {
    const got = Array.isArray(r.sections) ? r.sections.find((x: any) => x?.key === key) : undefined
    return { key, text: String(got?.text ?? '').trim(), refs: refsOf(got?.refs, known) }
  }).filter((x) => x.text)
  return {
    title: String(r.title ?? '').trim(),
    summary: String(r.summary ?? '').trim(),
    sections,
    files: Array.isArray(r.files) ? r.files.filter((f: any) => f && typeof f.path === 'string').map((f: any) => ({ path: f.path, why: String(f.why ?? '') })) : [],
    risks: Array.isArray(r.risks) ? r.risks.map(String).filter(Boolean).slice(0, 3) : [],
    tests: r.tests && typeof r.tests.text === 'string' && r.tests.text.trim() ? { ok: r.tests.ok !== false, text: String(r.tests.text).trim() } : undefined
  }
}

/** A question about the changes ("explain line 22", "why 401?"): a short answer, pinned to a line if it's about one. */
export async function askAboutChanges(question: string, command: string, explanation: string, diff: string, paths: string[]): Promise<{ text: string; ref?: { path: string; line: number } }> {
  const prompt = [
    'You help someone understand code changes they asked for. Answer their question in plain words, 1-4 short sentences.',
    '',
    `They asked for: "${command}"`,
    `What you told them so far: ${explanation}`,
    '',
    'The changes (line numbers on the left are the file as it is now):',
    diff,
    '',
    `Their question: "${question}"`,
    '',
    'Reply with JSON only: {"text": "your answer", "path": "file the answer is about, from the changes, or null", "line": number or null}'
  ].join('\n')
  const r = await askClaude<Record<string, any>>(prompt)
  const path = typeof r.path === 'string' && paths.includes(r.path) ? r.path : undefined
  const line = Number(r.line)
  return { text: String(r.text ?? '').trim() || "I'm not sure.", ref: path && line > 0 ? { path, line } : undefined }
}
