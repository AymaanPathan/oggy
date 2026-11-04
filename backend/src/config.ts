import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir = process.env.OGGY_DATA_DIR || join(homedir(), '.oggy')
mkdirSync(dataDir, { recursive: true })

/**
 * Owner token. Only callers holding it (the Electron app, later the Telegram bridge)
 * can run actions. Generated once and stored at ~/.oggy/token (mode 600).
 */
function loadToken(): string {
  if (process.env.OGGY_TOKEN) return process.env.OGGY_TOKEN
  const file = join(dataDir, 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const token = randomBytes(24).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  return token
}

/** Shape of ~/.oggy/config.json (Switch login, rooms, agents). Every field is optional. */
interface FileConfig {
  /**
   * packages: ids of Switch packages (made by a person in the Gateway, under Resources > Packages)
   * that every project room gets when Oggy makes it, such as the team's rules.
   */
  switch?: { apiUrl?: string; agentId?: string; agentApiKey?: string; agentName?: string; packages?: string[] }
  owner?: { name?: string; discordUsername?: string; switchUserId?: string }
  rooms?: { team?: string; friends?: string; oggyDaily?: string }
  /** The other people on the team: they vote on anything that can't be undone. */
  team?: { name: string; discordUsername?: string; switchUserId?: string }[]
  /** Where each project ships: { "paytrack": { "url": "https://…/health" } }. The release agent ships it. */
  deploy?: Record<string, { branch?: string; url?: string; service?: string; hooks?: string[] }>
  /**
   * The team in Switch, keyed by alias: { "scout": { "name": "scout", "does": "Read-only investigator…" } }.
   * Older configs used "builder" / "reviewer" keys with an "alias" field; those still work.
   */
  agents?: Record<string, { name?: string; alias?: string; does?: string; default?: boolean }>
  doneMarkers?: { done?: string; blocked?: string; looksGood?: string; changesNeeded?: string; ask?: string }
  paths?: { codeFolder?: string; eventsFolder?: string; screenshots?: string }
  safety?: {
    /** Tool names (file.delete) or their last word (delete) that always ask you first. */
    needsApproval?: string[]
    /** Only run "@oggy …" from rooms when owner.discordUsername sent it. */
    onlyObeyOwner?: boolean
    /** The only folders file tools may read or change. Replaces the defaults when set. */
    allowedFolders?: string[]
    /** Apps Oggy may open or close: "name": "command", or { "open": "command", "process": "ProcessName" }. Added to the defaults. */
    allowedApps?: Record<string, string | AppSpec>
  }
}

export interface AppSpec {
  /** What `start` runs: an exe on PATH, a full path, or a URI like ms-settings:. */
  open: string
  /** Process name for closing it (Get-Process name, no .exe). */
  process?: string
}

const DEFAULT_APPS: Record<string, AppSpec> = {
  notepad: { open: 'notepad', process: 'notepad' },
  calculator: { open: 'calc', process: 'CalculatorApp' },
  vscode: { open: 'code', process: 'Code' },
  chrome: { open: 'chrome', process: 'chrome' },
  edge: { open: 'msedge', process: 'msedge' },
  terminal: { open: 'wt', process: 'WindowsTerminal' },
  explorer: { open: 'explorer', process: 'explorer' },
  settings: { open: 'ms-settings:', process: 'SystemSettings' },
  spotify: { open: 'spotify:', process: 'Spotify' },
  discord: { open: 'discord:', process: 'Discord' }
}

/** Read ~/.oggy/config.json once at startup. Keep that file out of git: it holds Oggy's Switch key. */
function loadFileConfig(): FileConfig {
  const file = join(dataDir, 'config.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FileConfig
  } catch (err) {
    console.error(`[oggy] ${file} is not valid JSON, ignoring it: ${(err as Error).message}`)
    return {}
  }
}

/** A project's Render service, from its deploy hook (https://api.render.com/deploy/srv-…?key=…). */
const renderService = (hooks: string[] = []) => hooks.map((h) => h.match(/\/deploy\/(srv-[a-z0-9]+)/i)?.[1]).find(Boolean)

const file = loadFileConfig()
const home = homedir()
const codeFolder = process.env.OGGY_PROJECTS_DIR || file.paths?.codeFolder || join(home, 'Projects')

export interface Agent {
  /** The short name you and the plans use: "scout", "frontend". */
  alias: string
  /** Its exact name in Switch (who Oggy sends the job to). */
  name: string
  /** One line on what it's for; Claude picks agents by this. */
  does: string
  /** The general coder: gets jobs that aren't clearly anyone else's. */
  isDefault: boolean
}

/** Keyed by alias. "builder"/"reviewer" keys from older configs become their aliases (claude, reviewer). */
function loadAgents(): Record<string, Agent> {
  const legacyDoes: Record<string, string> = {
    builder: 'General-purpose coder: builds and fixes code in any project.',
    reviewer: 'Reviews changes and replies LOOKS GOOD or CHANGES NEEDED. Never edits.'
  }
  const entries = Object.entries(file.agents ?? { builder: {}, reviewer: {} })
  const agents: Record<string, Agent> = {}
  for (const [key, a] of entries) {
    const alias = (a.alias || (key === 'builder' ? 'claude' : key)).toLowerCase()
    agents[alias] = { alias, name: a.name || alias, does: a.does || legacyDoes[key] || '', isDefault: Boolean(a.default) || key === 'builder' }
  }
  // Exactly one default: the one marked, else "claude", else the first.
  if (!Object.values(agents).some((a) => a.isDefault)) {
    const fallback = agents.claude ?? Object.values(agents)[0]
    if (fallback) fallback.isDefault = true
  }
  return agents
}

const appKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
const apps: Record<string, AppSpec> = { ...DEFAULT_APPS }
for (const [name, spec] of Object.entries(file.safety?.allowedApps ?? {})) {
  apps[appKey(name)] = typeof spec === 'string' ? { open: spec } : spec
}

export const config = {
  port: Number(process.env.OGGY_PORT || 4317),
  host: '127.0.0.1', // local only
  dataDir,
  dbPath: join(dataDir, 'oggy.db'),
  token: loadToken(),
  projectsDir: codeFolder,
  paths: {
    events: file.paths?.eventsFolder || join(dataDir, 'events'),
    screenshots: file.paths?.screenshots || join(home, 'Pictures', 'Screenshots')
  },
  safety: {
    /** Extra tools that ask first. Tools the toolbox marks risky ask no matter what this says. */
    needsApproval: file.safety?.needsApproval ?? ['deploy', 'delete', 'install'],
    onlyObeyOwner: file.safety?.onlyObeyOwner ?? true,
    folders: (file.safety?.allowedFolders?.length
      ? file.safety.allowedFolders
      : [codeFolder, ...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music'].map((d) => join(home, d))]
    ).map((p) => p.replace(/^~(?=[\\/]|$)/, home)),
    apps
  },
  codexBin: process.env.CODEX_BIN || 'codex',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  owner: {
    name: file.owner?.name || 'Me',
    /** Your username as Switch sees it in rooms (your Discord username). */
    username: file.owner?.discordUsername || '',
    /** Your id as Switch sends it with room messages (optional; the username is enough). */
    switchUserId: file.owner?.switchUserId || ''
  },
  team: (file.team ?? []).map((p) => ({ name: p.name, username: p.discordUsername || '', switchUserId: p.switchUserId || '' })),
  deploy: Object.fromEntries(Object.entries(file.deploy ?? {}).map(([project, d]) => [project.toLowerCase(), { branch: d.branch || 'main', url: d.url, service: d.service || renderService(d.hooks) }])) as Record<string, { branch: string; url?: string; service?: string }>,
  render: {
    /** Read-only use: Oggy fetches a project's logs for the agents, which never get this key from Oggy. */
    apiKey: process.env.RENDER_API_KEY || ''
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID || ''
  },
  switch: {
    apiUrl: (process.env.SWITCH_API_URL || file.switch?.apiUrl || '').replace(/\/+$/, ''),
    agentId: process.env.SWITCH_AGENT_ID || file.switch?.agentId || '',
    apiKey: process.env.SWITCH_API_KEY || file.switch?.agentApiKey || '',
    agentName: file.switch?.agentName || 'oggy',
    /** Attached to every project room Oggy makes. With one, the room doesn't copy #team's rules: the package carries them. */
    packages: file.switch?.packages ?? [],
    rooms: {
      team: process.env.SWITCH_ROOM_ID || file.rooms?.team || '',
      friends: file.rooms?.friends || '',
      oggyDaily: file.rooms?.oggyDaily || ''
    },
    agents: loadAgents(),
    markers: {
      done: file.doneMarkers?.done || 'DONE:',
      blocked: file.doneMarkers?.blocked || 'BLOCKED:',
      looksGood: file.doneMarkers?.looksGood || 'LOOKS GOOD',
      changesNeeded: file.doneMarkers?.changesNeeded || 'CHANGES NEEDED',
      /** "ASK: npm ci — install the packages": the agent waits for your yes before a heavy step. */
      ask: file.doneMarkers?.ask || 'ASK:'
    }
  }
}

/**
 * The agent for a plan's "agent" arg: an alias ("scout"), a Switch name, or the old roles
 * ("builder" = the default coder, "reviewer").
 */
export function agentFor(key: unknown): Agent | undefined {
  const k = String(key ?? '').toLowerCase().replace(/^@/, '')
  const all = Object.values(config.switch.agents)
  if (!k || k === 'builder') return all.find((a) => a.isDefault)
  return config.switch.agents[k] ?? all.find((a) => a.name.toLowerCase() === k)
}

/** Memory key: the account a name-only owner match last came from, which "lock oggy to me" pins. */
export const OWNER_CANDIDATE = 'owner.candidate'

/**
 * Lock Oggy to your exact Switch account: owner.switchUserId, saved into ~/.oggy/config.json (the old file
 * kept as config.json.before-lock) and used from now on, no restart needed.
 */
export function saveOwnerId(id: string): void {
  const path = join(dataDir, 'config.json')
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const saved = JSON.parse(raw) as FileConfig
  writeFileSync(`${path}.before-lock`, raw)
  saved.owner = { ...saved.owner, switchUserId: id }
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`)
  config.owner.switchUserId = id
}
