import type { AgentLive, Approval, FileChange, IntegrationStatus, MemoryItem, OggyEvent, Review, ReviewAnswer, Run, ShowEffect, TraceEntry, Workflow } from '@shared/types'

/** API exposed to the renderer on window.oggy (the renderer never sees the owner token). */
export interface OggyApi {
  submitCommand(text: string): Promise<Run>
  listRuns(): Promise<Run[]>
  listApprovals(): Promise<Approval[]>
  decideApproval(id: string, approve: boolean): Promise<Approval>
  listWorkflows(): Promise<Workflow[]>
  deleteWorkflow(id: string): Promise<void>
  listMemory(): Promise<MemoryItem[]>
  integrations(): Promise<IntegrationStatus[]>
  hideCommandBar(): void
  /** Show the bar without taking focus (a job finished or needs your OK). */
  peekCommandBar(): void
  /** While pinned (a job is running), clicking elsewhere doesn't hide the bar. */
  setBarPinned(pinned: boolean): void
  /** false makes the bar window click-through (for the transparent area around the bar). */
  setBarInteractive(interactive: boolean): void
  /**
   * Fires when the bar is shown (true) or about to hide (false), to drive enter/leave animations.
   * `focused` is true when you summoned it (Ctrl+Space), false when it popped up on its own.
   */
  onBarVisible(cb: (visible: boolean, focused: boolean) => void): () => void
  onEvent(cb: (e: OggyEvent) => void): () => void
  onBackendStatus(cb: (online: boolean) => void): () => void

  /* show mode (the #/show window) */
  onShow(cb: (effect: ShowEffect & { flashOnly?: boolean }) => void): () => void
  /** false makes the show window click-through again. */
  setShowInteractive(interactive: boolean): void
  /** Nothing is playing: the show window can hide. */
  showIdle(): void
  /** Open a screenshot the stage just showed (or reveal it in Explorer). */
  openShot(path: string, reveal?: boolean): void
  /** Open one of a run's changed files in VS Code (for the full editor). */
  openChange(runId: string, path: string): Promise<void>
  /**
   * Your decision on a run's review, as you'd say it: "keep it", "undo it", or what to change.
   * `handled: false` means it wasn't about the review (send it as a new command).
   */
  decideReview(runId: string, text: string, ask?: boolean): Promise<{ handled: boolean; review?: Review; followUp?: Run; answer?: ReviewAnswer }>
  /**
   * The big review screen is open: the whole window takes clicks until it closes.
   * `focus: false` when it opens by itself, so it doesn't take your keyboard mid-sentence.
   */
  setReviewOpen(open: boolean, focus?: boolean): void
  /** Windows asked the bar to close (Alt+F4, the taskbar): it tucks away instead of being destroyed. */
  onCloseRequested(cb: () => void): () => void
  /** Send the big window to the taskbar; its icon or Ctrl+Space brings it back. */
  minimizeWindow(): void
  /** Quit Oggy altogether. */
  quit(): void
  /** Everyone on the team and what they're doing now (then kept fresh by "team" events). */
  getTeam(): Promise<AgentLive[]>
  /** What the backend still has on a run: its changed files and its review. */
  runDetail(runId: string): Promise<{ changes: FileChange[]; review: Review | null; trace: TraceEntry[] }>
}

export const IPC = {
  submit: 'oggy:submit',
  runs: 'oggy:runs',
  approvals: 'oggy:approvals',
  decide: 'oggy:decide',
  workflows: 'oggy:workflows',
  deleteWorkflow: 'oggy:delete-workflow',
  memory: 'oggy:memory',
  integrations: 'oggy:integrations',
  hideBar: 'oggy:hide-bar',
  peekBar: 'oggy:peek-bar',
  pinBar: 'oggy:pin-bar',
  barVisible: 'oggy:bar-visible',
  barInteractive: 'oggy:bar-interactive',
  event: 'oggy:event',
  backendStatus: 'oggy:backend-status',
  show: 'oggy:show',
  showInteractive: 'oggy:show-interactive',
  showIdle: 'oggy:show-idle',
  openShot: 'oggy:open-shot',
  openChange: 'oggy:open-change',
  decideReview: 'oggy:decide-review',
  reviewOpen: 'oggy:review-open',
  team: 'oggy:team',
  runDetail: 'oggy:run-detail',
  closeRequested: 'oggy:close-requested',
  quit: 'oggy:quit',
  minimizeWindow: 'oggy:minimize-window'
} as const

/* ---------- First-run setup (the #/setup window) ---------- */

/** Where Switch is: found on this PC (Switch Console's own server), or not. */
export interface SwitchFound {
  found: boolean
  /** The server address, such as http://127.0.0.1:53754, when found. */
  url?: string
  /** Why it wasn't found, in words for the person. */
  reason?: string
}

/** How to connect: through Switch Console on this PC, or with an address and a registration key. */
export type ConnectRequest =
  | { mode: 'local'; agentName: string }
  | { mode: 'key'; url: string; registrationKey: string; agentName: string }

export interface ConnectResult {
  apiUrl: string
  agentId: string
  agentName: string
}

/** One of the person's agents in Switch, and the job Oggy guesses for it. */
export interface SetupAgent {
  name: string
  description: string
  /** claude-code, codex… or a custom connector. */
  kind: string
  role: string
}

/** A job an agent can have in Oggy's team. */
export interface SetupRole {
  id: string
  label: string
  does: string
}

export interface SetupProfile {
  /** Prefilled values: the Windows user name, an existing config's answers. */
  name: string
  discordUsername: string
  codeFolder: string
  agentName: string
  /** Switch is already set up from an earlier run on this PC (re-running setup). */
  reconnect: boolean
}

export interface SetupSave {
  name: string
  discordUsername: string
  codeFolder: string
  /** Each chosen agent and its role. */
  agents: { name: string; role: string; description: string }[]
}

/** API exposed on window.oggySetup to the setup window only. */
export interface OggySetupApi {
  profile(): Promise<SetupProfile>
  roles(): Promise<SetupRole[]>
  findSwitch(): Promise<SwitchFound>
  connect(req: ConnectRequest): Promise<ConnectResult>
  listAgents(): Promise<SetupAgent[]>
  pickFolder(current: string): Promise<string | null>
  save(answers: SetupSave): Promise<void>
  openSwitchConsole(): void
}

export const SETUP_IPC = {
  profile: 'setup:profile',
  roles: 'setup:roles',
  findSwitch: 'setup:find-switch',
  connect: 'setup:connect',
  listAgents: 'setup:list-agents',
  pickFolder: 'setup:pick-folder',
  save: 'setup:save',
  openSwitchConsole: 'setup:open-switch-console'
} as const
