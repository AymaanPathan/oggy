import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentFor, config } from './config.js'
import { newId, workflows } from './db.js'
import { emit, log } from './events.js'
import { postToRoom, switchConfigured, writeWorkflowsDoc } from './integrations/switch.js'
import { armSchedule } from './schedule.js'
import { EVERYDAY_AGENT, isEveryday, scheduleText } from './shared/everyday.js'
import type { StepAsk, StepTemplate, Workflow, WorkflowSchedule } from './shared/types.js'
import { people } from './team.js'

/**
 * Workflows you describe: Claude designs one from your words, and Oggy checks every part of it against
 * what's real (the agents you have, the people on the team, your projects, what can deploy) before it's
 * saved. Saved means it runs exactly as it's drawn in the app: nothing is added at run time.
 */

/** What Claude answers with, before Oggy has checked any of it. */
export interface DesignStep {
  id?: string
  /** An agent's job, a deploy, a rollback, or posting the last report in a room. */
  do?: string
  agent?: string
  title?: string
  prompt?: string
  after?: string[]
  /** A yes/no this agent answers, for a later step's `when`. */
  question?: string
  when?: { step?: string; is?: string }
  ask?: { who?: string[]; question?: string; ifNo?: string }
  room?: string
}

export interface WorkflowDesign {
  name?: string
  description?: string
  project?: string | null
  /** "every weekday at 9": { days: "weekdays", time: "09:00" }. */
  schedule?: { days?: string | string[]; time?: string } | null
  steps?: DesignStep[]
}

export type WorkflowAnswer = WorkflowDesign | { ask: string } | { cannot: string }

/** A checked workflow, ready to save. */
export interface BuiltWorkflow {
  name: string
  description: string
  project?: string
  schedule?: WorkflowSchedule
  steps: StepTemplate[]
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** When it runs by itself, from the design: nothing, a schedule, or what's wrong with it. */
function scheduleOf(asked: WorkflowDesign['schedule']): WorkflowSchedule | undefined | { problem: string } {
  if (!asked) return undefined
  const time = String(asked.time ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return { problem: `“${asked.time ?? ''}” isn't a time of day: give it as 09:00.` }
  const named = Array.isArray(asked.days) ? asked.days.map(String) : [String(asked.days ?? 'daily')]
  const days = new Set<number>()
  for (const d of named.map((n) => n.trim().toLowerCase())) {
    if (['daily', 'every day', 'everyday'].includes(d)) [0, 1, 2, 3, 4, 5, 6].forEach((x) => days.add(x))
    else if (d === 'weekdays') [1, 2, 3, 4, 5].forEach((x) => days.add(x))
    else if (d === 'weekends') [0, 6].forEach((x) => days.add(x))
    else if (DAY_NAMES.includes(d.slice(0, 3))) days.add(DAY_NAMES.indexOf(d.slice(0, 3)))
    else return { problem: `“${d}” isn't a day: use daily, weekdays, weekends or day names.` }
  }
  return { days: [...days].sort(), time: `${time[1].padStart(2, '0')}:${time[2]}` }
}

const ME = ['you', 'me', 'i', 'owner', 'myself']
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Who has to say yes, by their real names, you first. A name that isn't on the team is a problem, not a guess. */
function whoDecides(who: string[] = []): string[] | { problem: string } {
  const team = people()
  const names: string[] = []
  for (const w of who) {
    const person = ME.includes(w.trim().toLowerCase()) ? team[0] : team.find((p) => same(p.name, w) || (p.username && same(p.username, w)))
    if (!person) return { problem: `${w} isn't on the team (the team is ${team.map((p) => p.name).join(', ')}).` }
    if (!names.includes(person.name)) names.push(person.name)
  }
  // Just you is a plain question for you, not a vote.
  if (names.length === 1 && names[0] === team[0].name) return []
  return names.sort((a, b) => Number(b === team[0].name) - Number(a === team[0].name))
}

/** Steps in an order where each comes after what it waits for, or undefined if they wait in a circle. */
function inOrder(steps: StepTemplate[]): StepTemplate[] | undefined {
  const out: StepTemplate[] = []
  const left = [...steps]
  while (left.length) {
    const ready = left.filter((s) => (s.after ?? []).every((a) => out.some((o) => o.id === a)))
    if (!ready.length) return undefined
    out.push(...ready)
    for (const r of ready) left.splice(left.indexOf(r), 1)
  }
  return out
}

/** Oggy's check of Claude's design: the workflow, or what's wrong with it. */
export function buildWorkflow(design: WorkflowDesign, request: string): BuiltWorkflow | { problem: string } {
  const name = String(design.name ?? '').trim().replace(/\s+workflow$/i, '').slice(0, 60)
  if (!name) return { problem: 'The workflow has no name.' }
  const list = Array.isArray(design.steps) ? design.steps : []
  if (!list.length) return { problem: 'The workflow has no steps.' }
  const project = design.project ? String(design.project) : undefined
  if (project && !existsSync(join(config.projectsDir, project))) return { problem: `There's no ${project} project in ${config.projectsDir}.` }
  const schedule = scheduleOf(design.schedule)
  if (schedule && 'problem' in schedule) return schedule
  // Only the assistant's work, on no project: it's about your day, so it reports in #oggy-daily.
  const everyday = !project && list.every((s) => s.do === 'post' || (!['deploy', 'rollback'].includes(String(s.do)) && agentFor(s.agent)?.alias === EVERYDAY_AGENT))

  // Steps are named by Claude ("s1"); from here on they have real ids.
  const ids = new Map<string, string>(list.map((s, i) => [String(s.id ?? `#${i}`), newId()]))
  const steps: StepTemplate[] = []
  for (const [i, s] of list.entries()) {
    const id = ids.get(String(s.id ?? `#${i}`))!
    const title = String(s.title ?? '').trim().slice(0, 120)
    const kind = s.do === 'deploy' || s.do === 'rollback' ? 'deploy' : s.do === 'post' ? 'room.post' : 'agent.job'
    const base = project ? { project } : {}
    let args: Record<string, unknown>
    let shown = title
    if (kind === 'agent.job') {
      const agent = agentFor(s.agent)
      if (!agent) return { problem: `There's no agent called ${s.agent} (the team is ${Object.keys(config.switch.agents).join(', ')}).` }
      if (agent.isDefault && !/\bclaude\b/i.test(request)) return { problem: `${agent.alias} isn't on the team: it's the owner's personal agent, so only use it if they ask for it by name.` }
      if (!s.prompt?.trim()) return { problem: `“${title || agent.alias}” doesn't say what ${agent.alias} has to do.` }
      args = { ...base, agent: agent.alias, prompt: s.prompt.trim() }
      shown = `@${agent.alias}: ${title || 'on it'}`
    } else if (kind === 'deploy') {
      if (!project) return { problem: 'A deploy or a rollback needs a project: say which one.' }
      if (!config.deploy[project.toLowerCase()]) return { problem: `Deploying ${project} isn't connected: add it under "deploy" in ~/.oggy/config.json.` }
      if (!agentFor('release')) return { problem: 'A deploy needs a release agent: add it under "agents" in ~/.oggy/config.json.' }
      args = s.do === 'rollback' ? { ...base, rollback: true } : base
      shown = `@release: ${title || (s.do === 'rollback' ? `roll back ${project}` : `ship ${project}`)}`
    } else {
      const room = s.room === 'oggyDaily' || everyday ? 'oggyDaily' : 'team'
      args = { ...base, room, lastReport: true }
      shown = title || `Post it in #${room === 'team' ? 'team' : 'oggy-daily'}`
    }

    const when = s.when?.step ? ids.get(String(s.when.step)) : undefined
    if (s.when?.step && !when) return { problem: `“${title}” depends on a step that isn't in the workflow.` }
    if (s.when?.step && !list.some((o) => String(o.id) === String(s.when!.step) && o.question?.trim())) return { problem: `“${title}” depends on an answer, but that step has no question to answer.` }

    // A rollback changes production, so someone always says yes first: you, unless it names someone.
    const asked = s.ask ?? (s.do === 'rollback' ? {} : undefined)
    let ask: StepAsk | undefined
    if (asked) {
      const who = whoDecides(asked.who)
      if ('problem' in who) return who
      ask = { who, question: String(asked.question ?? '').trim() || title || shown, ifNo: asked.ifNo === 'continue' ? 'continue' : 'stop' }
    }
    const after = Array.isArray(s.after) ? s.after.map((a) => ids.get(String(a))).filter((a): a is string => Boolean(a)) : i > 0 ? [ids.get(String(list[i - 1].id ?? `#${i - 1}`))!] : []
    if (when && !after.includes(when)) after.push(when)
    steps.push({
      id,
      kind,
      title: shown,
      args,
      after,
      ...(s.question?.trim() && kind === 'agent.job' ? { question: s.question.trim() } : {}),
      ...(when ? { when: { step: when, is: s.when?.is === 'no' ? ('no' as const) : ('yes' as const) } } : {}),
      ...(ask ? { ask } : {})
    })
  }
  const sorted = inOrder(steps)
  if (!sorted) return { problem: 'The steps wait for each other in a circle.' }
  return { name, description: String(design.description ?? '').trim().slice(0, 240) || request.slice(0, 240), project, ...(schedule ? { schedule } : {}), steps: sorted }
}

const plain = (title: string) => title.replace(/^@(\w+):\s*/, (_m, who: string) => `${who[0].toUpperCase()}${who.slice(1)}: `)

/** A workflow in plain lines, for the rooms. No @, so posting it doesn't wake anyone. */
export function outline(steps: StepTemplate[]): string {
  const said = (s: StepTemplate) => [
    plain(s.title),
    s.when ? ` (only if: ${steps.find((o) => o.id === s.when!.step)?.question ?? 'the earlier answer fits'})` : '',
    s.ask ? ` (${s.ask.who.length ? `${s.ask.who.join(' and ')} must approve` : `${config.owner.name} is asked first`})` : ''
  ].join('')
  return steps.map((s, i) => `${i + 1}. ${said(s)}`).join('\n').replace(/@(?=\w)/g, '')
}

const shout = () => emit({ type: 'workflows', workflows: workflows.list() })

/** When it runs by itself, as a line for the rooms. */
export const whenLine = (w: { schedule?: WorkflowSchedule }) => (w.schedule ? `\n⏰ ${scheduleText(w.schedule)}` : '')

/** The workflows as the #team document agents and teammates read. Your everyday ones aren't the team's business. */
function renderDoc(all: Workflow[]): string {
  const body = all.map((w) => [`## ${w.name}${w.project ? ` · ${w.project}` : ''}`, w.description, '', outline(w.steps), '', `Run it: "@${config.switch.agentName} run ${w.name} workflow"`].join('\n'))
  return [`# Workflows`, `What ${config.owner.name} has saved with Oggy. Only ${config.owner.name} can start one.`, ...body].join('\n\n')
}

/** Tell the room and refresh #team's document. Never in the way: a saved workflow is saved either way. */
async function tellTeam(line?: string, everyday = false) {
  if (!switchConfigured() || !config.switch.rooms.team) return
  try {
    if (line) await postToRoom(line, everyday ? config.switch.rooms.oggyDaily || config.switch.rooms.team : config.switch.rooms.team)
    await writeWorkflowsDoc(renderDoc(workflows.list().filter((w) => w.asked && !isEveryday(w.steps))))
  } catch (err) {
    log('warn', `Couldn't tell #team about the workflow: ${(err as Error).message}`)
  }
}

export function saveWorkflow(built: BuiltWorkflow, asked: string): { workflow: Workflow; updated: boolean } {
  const updated = Boolean(workflows.byName(built.name))
  const workflow = workflows.upsert(built.name, built.description, built.steps, { asked, project: built.project, schedule: built.schedule })
  if (workflow.schedule) armSchedule(workflow.id)
  shout()
  void tellTeam(`🧩 ${updated ? 'Updated' : 'New'} workflow: **${workflow.name}**${workflow.project ? ` (${workflow.project})` : ''}\n${outline(workflow.steps)}${whenLine(workflow)}`, isEveryday(workflow.steps))
  return { workflow, updated }
}

export function deleteWorkflow(id: string): boolean {
  const gone = workflows.remove(id)
  if (gone) {
    shout()
    void tellTeam()
  }
  return gone
}

export function touchWorkflow(id: string) {
  workflows.touch(id)
  shout()
}
