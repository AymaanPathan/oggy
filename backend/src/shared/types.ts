// Domain types shared by the backend and the Electron frontend.
// The frontend imports this file through its `@shared` alias, so it must stay type-only.

export type CommandSource = 'desktop' | 'telegram' | 'switch' | 'schedule'

export type Intent =
  | 'project.create'
  | 'code.change'
  | 'code.fix_tests'
  | 'code.review'
  | 'delegate.codex'
  | 'delegate.claude'
  | 'tool.run'
  | 'workflow.create' // you described one: Claude designed it, Oggy checked it
  | 'workflow.save'
  | 'workflow.run'
  | 'workflow.list'
  | 'deploy'
  | 'memory.remember'
  | 'quick'
  | 'chain' // several commands in one sentence, run in order
  | 'plan' // something new: Claude planned it from the toolbox, you said go
  | 'unknown'

/** Every tool in the toolbox (backend/src/toolbox.ts). A plan step is one tool call. */
export type StepKind =
  // apps & screen
  | 'app.open'
  | 'app.close'
  | 'folder.open'
  | 'screen.shot'
  | 'system.volume'
  | 'keys.press'
  // files (only inside the allowed folders)
  | 'file.open' // in its usual app
  | 'file.copy'
  | 'file.move'
  | 'file.rename'
  | 'file.zip'
  | 'file.delete' // to the Recycle Bin
  | 'undo'
  // people & agents
  | 'room.post'
  | 'agent.job' // give @claude or @reviewer a job in the Switch room and wait for DONE / BLOCKED
  | 'codex.job' // delegate coding to Codex (stubbed)
  | 'calendar.event'
  // projects in the code folder
  | 'project.build'
  | 'project.test'
  | 'project.install'
  | 'project.dev'
  | 'project.stop' // stop its dev server (the whole process tree)
  | 'project.code' // open in VS Code
  | 'project.room' // give the project its own Switch room
  | 'project.room.archive' // archive that room in Switch
  | 'git.status'
  | 'url.check'
  | 'deploy'
  // Oggy itself
  | 'workflow.create'
  | 'workflow.save'
  | 'memory.write'
  | 'owner.lock' // pin owner.switchUserId to your chat account (desktop only)
  | 'note'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'stubbed'

/** Someone's say-so before a step runs. */
export interface StepAsk {
  /** Who decides, by name. Empty: you. */
  who: string[]
  question: string
  /** A no ends the run, or skips just this step and carries on. */
  ifNo: 'stop' | 'continue'
}

export interface PlanStep {
  id: string
  kind: StepKind
  title: string
  /** Free-form args for the step executor. */
  args?: Record<string, unknown>
  /** Risky steps (delete, push, deploy, install) always go through the approval gate. */
  risky?: boolean
  /**
   * Ids of the steps this one waits for. Missing means "the step before it" (one after another);
   * steps with the same `after` run at the same time (e.g. @frontend and @backend both after @scout).
   */
  after?: string[]
  /** A yes/no this step's agent has to answer, for a later step's `when`. */
  question?: string
  /** The agent posted its own report in the room, so nobody has to post it for them. */
  spoke?: boolean
  /** What it answered. */
  answer?: 'yes' | 'no'
  /** Runs only when that step answered this way; otherwise it's skipped and the run goes on. */
  when?: { step: string; is: 'yes' | 'no' }
  /** Asked before it runs, whatever the tool would normally ask. */
  ask?: StepAsk
  /** The workflow step it came from, so a run can light up its drawing. */
  from?: string
  status: StepStatus
  output?: string
  /** When it started and finished working (for the live timers). */
  startedAt?: number
  endedAt?: number
}

export type RunStatus = 'planned' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled'

export interface Run {
  id: string
  command: string
  source: CommandSource
  /** Who sent it, for commands from a room (their username). The safety gate checks it is you. */
  requestedBy?: string
  intent: Intent
  /** Short human name for what Oggy is doing, e.g. "Add feature + deploy". */
  label?: string
  /** The saved workflow this is a run of. */
  workflowId?: string
  status: RunStatus
  steps: PlanStep[]
  /** Honest one-line outcome, set when the run finishes. */
  summary?: string
  createdAt: number
  updatedAt: number
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

/** Something that can't be taken back: everyone has to say yes, and one no stops it. */
export interface TeamVote {
  voters: string[]
  answers: Record<string, 'yes' | 'no'>
  /** Asked of named people without you: you can stop it, but you can't say yes for them. */
  notYou?: boolean
}

export interface Approval {
  id: string
  runId: string
  stepId: string
  action: string
  status: ApprovalStatus
  createdAt: number
  decidedAt?: number
  decidedVia?: CommandSource
  /** Set when this needs the whole team. */
  vote?: TeamVote
}

export type StepTemplate = Omit<PlanStep, 'status' | 'output' | 'answer' | 'from'>

export interface Workflow {
  id: string
  name: string
  description: string
  /** Step templates (status is reset on replay). */
  steps: StepTemplate[]
  /** What you said to make it. Set on workflows you described: those run exactly as drawn. */
  asked?: string
  /** The project it works on, unless a run names another. */
  project?: string
  /** When it runs by itself. */
  schedule?: WorkflowSchedule
  createdAt: number
  lastRunAt?: number
}

export interface WorkflowSchedule {
  /** 0 is Sunday. */
  days: number[]
  /** "09:00", on this computer's clock. */
  time: string
}

export interface MemoryItem {
  key: string
  value: string
  updatedAt: number
}

export interface IntegrationStatus {
  name: 'codex' | 'switch' | 'telegram'
  ready: boolean
  detail: string
}

/**
 * Show mode: what the desktop app animates on screen while a tool works.
 * The backend says what is happening; the stage window (frontend) decides how it looks.
 */
export type ShowEffect =
  /** About to capture: hide Oggy's own windows so they aren't in the picture. */
  | { kind: 'shutter.prep' }
  /** Captured: flash, shutter sound, thumbnail. `thumb` is filled in by the desktop app. */
  | { kind: 'shutter'; path: string; thumb?: string }
  /** An app opening or closing. `exe` (once known) lets the app show its real icon. */
  | { kind: 'app'; id: string; action: 'open' | 'close'; app: string; phase: 'start' | 'done' | 'failed'; note?: string; exe?: string; icon?: string }
  /** Files travelling from one place to another, `done` of `names.length` so far. */
  | { kind: 'files'; id: string; action: 'move' | 'copy' | 'delete' | 'zip' | 'undo'; from: string; to: string; names: string[]; done: number; phase: 'start' | 'progress' | 'done' }
  | { kind: 'keys'; keys: string[] }
  /** A caption, optionally spoken by the desktop app. */
  | { kind: 'say'; text: string }
  | { kind: 'toast'; icon: 'post' | 'calendar' | 'folder' | 'agent' | 'build' | 'volume' | 'undo' | 'deploy'; title: string; detail?: string }

/** A file the agents changed during a run, counted by git against the project as the job found it. */
export interface FileChange {
  /** Relative to the repo root, e.g. "backend/controller/auth/loginUser.controller.ts". */
  path: string
  added: number
  removed: number
  status: 'modified' | 'added' | 'deleted'
  binary?: boolean
  /** The diff itself, for the review panel (long files are cut, see `cut`). */
  hunks?: DiffHunk[]
  /** Lines left out of `hunks` to keep the panel fast. */
  cut?: number
}

/** One block of a diff: "@@ -14,6 +14,9 @@" and its lines. */
export interface DiffHunk {
  /** First line number of the block, before and after. */
  oldStart: number
  newStart: number
  lines: { t: '+' | '-' | ' '; text: string }[]
}

/** Lines of a changed file, in the file as it is now ("from" to "to", inclusive). */
export interface LineRef {
  path: string
  from: number
  to: number
}

/** One box of the explanation: what was wrong, why it happened, what changed, how it's tested. */
export interface ReviewSection {
  key: 'wrong' | 'why' | 'changed' | 'tested'
  title: string
  text: string
  /** The lines this box is about (lit up while Oggy talks about it). */
  refs: LineRef[]
}

/**
 * Oggy's review of what the agents changed: plain words for you, then your decision.
 * explaining -> ready (waiting for you) -> kept | undone | changing (a follow-up job is running).
 */
export interface Review {
  runId: string
  status: 'explaining' | 'ready' | 'kept' | 'undone' | 'changing'
  /** A few words: "Register crash fix". */
  title?: string
  /** One or two sentences: what happened, for someone who didn't read the code. */
  summary?: string
  sections: ReviewSection[]
  /** Per file: what this change means. */
  files: { path: string; why: string }[]
  /** Things to look at before keeping it. */
  risks: string[]
  /** "13 passing", "2 failing", or nothing when nobody ran tests. */
  tests?: { ok: boolean; text: string }
  /** The branch the work is on. */
  branch?: string
  /** What your decision did ("Put back 2 files"). */
  outcome?: string
  /** The follow-up job when you asked for a change. */
  nextRunId?: string
  /** This review is of a change you asked for in the review of that run. */
  continues?: string
}

/** Oggy's answer to a question in the review ("explain line 22"), pinned to a line when it's about one. */
export interface ReviewAnswer {
  text: string
  ref?: { path: string; line: number }
}

/** One step an agent took, as Oggy saw it in its session ("Editing backend/routes/index.ts"). */
export interface AgentStep {
  at: number
  kind: 'job' | 'read' | 'edit' | 'run' | 'search' | 'think' | 'plan' | 'post' | 'ask' | 'other' | 'mail' | 'calendar' | 'notes' | 'todo' | 'draft'
  /** What it's doing, in plain words: "Reading", "Installing the project's packages". */
  text: string
  /** What on: a file, a search, the command. */
  detail?: string
  /** Why this one takes a while ("The first install can take a few minutes"). */
  slow?: string
  /** To-dos it wrote, one line each ("Reply to Maaz"). */
  items?: string[]
}

/** One thing an agent did, in full, for the live window. */
export interface TraceEntry {
  id: string
  at: number
  /** Who did it. */
  agent: string
  /** The job step it belongs to: each agent's turn. */
  stepId?: string
  /** A step of work, or 'say': what the agent wrote in its own words. */
  kind: AgentStep['kind'] | 'say'
  text: string
  detail?: string
  /** To-dos it wrote, one line each. */
  items?: string[]
  /** What came back (cut to a sensible length). */
  output?: string
  /** How it ended; missing while it's still going. */
  ok?: boolean
  endedAt?: number
}

/** One agent on the team, live: what it's doing right now and its last steps. */
export interface AgentLive {
  alias: string
  name: string
  /** What it's for, from your config ("Server, API and database work"). */
  does: string
  status: 'working' | 'waiting' | 'idle'
  /** The job it's on (or was last on). */
  task?: string
  project?: string
  /** When that job started, and its last step. */
  since?: number
  lastAt?: number
  steps: AgentStep[]
}

export type OggyEvent =
  /** The whole team, whenever someone starts, takes a step, waits or stops. */
  | { type: 'team'; agents: AgentLive[] }
  | { type: 'run.updated'; run: Run }
  /** The saved workflows, whenever one is made, deleted or run. */
  | { type: 'workflows'; workflows: Workflow[] }
  | { type: 'run.activity'; runId: string; stepId?: string; text: string; at: number }
  /** Everything the agents have changed so far in this run (the whole list, each time it changes). */
  | { type: 'run.changes'; runId: string; files: FileChange[] }
  /** One entry of a job's live activity, new or updated (same id). */
  | { type: 'run.trace'; runId: string; entry: TraceEntry }
  | { type: 'run.review'; review: Review }
  | { type: 'show'; runId: string; effect: ShowEffect }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.decided'; approval: Approval }
  /** Someone on the team answered a vote. */
  | { type: 'approval.vote'; approval: Approval; voter: string; yes: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number }
