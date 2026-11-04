import { app, BrowserWindow, dialog, ipcMain, shell, type WebPreferences } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { join } from 'path'
import {
  SETUP_IPC,
  type ConnectRequest,
  type ConnectResult,
  type SetupAgent,
  type SetupProfile,
  type SetupRole,
  type SetupSave,
  type SwitchFound
} from '@common/api'

/**
 * First-run setup: connects Oggy to Switch, picks the team, and writes ~/.oggy/config.json.
 *
 * With Switch Console on this PC (the usual case), nobody handles a key. Switch Console runs a
 * local Switch server and keeps that server's settings, including its Admin sign-in, in
 * switch-core.env. Setup signs in as Admin, makes a one-time registration key, registers Oggy with
 * it (so Oggy belongs to Admin like every agent added in Switch Console, and they trust each other),
 * then deletes that key. This is how Switch Console 0.40 / Switch 0.31 lay things out, not a
 * documented API; when it isn't there, setup asks for a server address and a registration key.
 *
 * Keys and passwords stay in this process. The setup window only ever sees names and addresses.
 */

const DATA_DIR = process.env.OGGY_DATA_DIR || join(homedir(), '.oggy')
const CONFIG = join(DATA_DIR, 'config.json')
const SWITCH_ENV = join(
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'switchdash',
  'local-switch-server',
  'native',
  'run',
  'switch-core.env'
)
const SWITCH_CONSOLE_EXE = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'Programs',
  'Switch Console',
  'Switch Console.exe'
)

/** Example values the template ships with: still there means setup isn't done. */
const UNFILLED = ['YOUR-OGGY-AGENT-ID', 'YOUR-OGGY-AGENT-KEY', 'localhost:PORT', 'your-chat-username']
const AGENT_NAME = /^[a-z0-9][a-z0-9._-]*$/

/** How Oggy registers: always connected, exchanging messages, no mediation. Same as an existing Oggy. */
const OGGY_REGISTRATION = {
  description: 'Oggy: voice assistant that plans jobs, runs apps on the laptop and coordinates the agents',
  connector_type: 'Oggy',
  integration_profile: {
    connection_model: 'always_on',
    message_exchange: true,
    pre_invocation_mediation: [],
    post_invocation_mediation: [],
    event_reporting: [],
    command_capabilities: { reset: 'unsupported', compact: 'unsupported', interrupt: 'unsupported' }
  }
}

const ROLE_LABELS: Record<string, string> = {
  claude: 'General coder (the default)',
  scout: 'Scout: finds causes, never edits',
  frontend: 'Frontend',
  backend: 'Backend',
  tester: 'Tester',
  reviewer: 'Reviewer',
  release: 'Release: ships after a team vote',
  assistant: 'Assistant: mail, calendar, notes',
  other: 'Other: uses its own description'
}

/** Name words that say which job an agent does, checked in this order. */
const ROLE_HINTS: [string, RegExp][] = [
  ['scout', /scout|investigat|research/],
  ['frontend', /front|ui\b|web/],
  ['backend', /back|api\b|server/],
  ['tester', /test|qa\b/],
  ['reviewer', /review/],
  ['release', /release|deploy|ship/],
  ['assistant', /assist|mail|calendar|notion|daily/],
  ['claude', /claude|codex|coder|dev|code/]
]

type FileConfig = Record<string, any>

/** Oggy's Switch login once connected. Never leaves this process. */
let connection: { apiUrl: string; agentId: string; agentName: string; apiKey: string } | null = null

class SetupError extends Error {}

/* ---------- reading what's there ---------- */

function readConfig(): FileConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8')) as FileConfig
  } catch {
    return null
  }
}

function examplePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'oggy', 'switch', 'config.example.json')
    : join(app.getAppPath(), '..', 'switch', 'config.example.json')
}

function readExample(): FileConfig {
  try {
    return JSON.parse(readFileSync(examplePath(), 'utf8')) as FileConfig
  } catch {
    return {}
  }
}

/** Setup is needed when there's no config, it still has the template's placeholders, or no Switch login. */
export function needsSetup(): boolean {
  if (!existsSync(CONFIG)) return true
  const text = readFileSync(CONFIG, 'utf8')
  if (UNFILLED.some((s) => text.includes(s))) return true
  const cfg = readConfig()
  return !cfg?.switch?.apiUrl || !cfg.switch.agentId || !cfg.switch.agentApiKey
}

/** The local Switch server's settings, as Switch Console wrote them. */
function readSwitchEnv(): Record<string, string> | null {
  if (!existsSync(SWITCH_ENV)) return null
  const vars: Record<string, string> = {}
  for (const line of readFileSync(SWITCH_ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return vars
}

const cleanUrl = (url: string) => {
  const u = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(u) ? u : `http://${u}`
}

/* ---------- talking to Switch ---------- */

/** A Switch call that throws a SetupError with Switch's own explanation when it fails. */
async function call<T>(url: string, init: RequestInit & { timeout?: number } = {}): Promise<{ body: T; res: Response }> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? 15_000) })
  } catch {
    throw new SetupError(`Can't reach Switch at ${new URL(url).origin}. Is Switch Console running?`)
  }
  const text = await res.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail) ? body.detail.map((d: any) => d.msg).join('; ') : ''
    throw Object.assign(new SetupError(detail || `Switch answered ${res.status}`), { status: res.status })
  }
  return { body: body as T, res }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function findSwitch(): Promise<SwitchFound> {
  const env = readSwitchEnv()
  if (!env) {
    return existsSync(SWITCH_CONSOLE_EXE)
      ? { found: false, reason: "Switch Console is installed, but it hasn't set up a server on this PC yet. Open it and add a server." }
      : { found: false, reason: "Switch Console isn't installed on this PC." }
  }
  const host = !env.SERVER_HOST || env.SERVER_HOST === '0.0.0.0' ? '127.0.0.1' : env.SERVER_HOST
  const url = `http://${host}:${env.SERVER_PORT || 8000}`
  if (!(await healthy(url))) return { found: false, url, reason: "Switch Console's server isn't running. Open Switch Console, wait a moment, then try again." }
  return { found: true, url }
}

/** Is this login still good? Used to keep an existing Oggy instead of replacing its key. */
async function loginWorks(apiUrl: string, agentId: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/agents/${encodeURIComponent(agentId)}/ops`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok
  } catch {
    return false
  }
}

/** Signs in to the local Switch as Admin and makes a one-time registration key. Delete it with `done`. */
async function adminRegistrationKey(url: string): Promise<{ key: string; done: () => Promise<void> }> {
  const env = readSwitchEnv()
  if (!env?.GATEWAY_ADMIN_EMAIL || !env.GATEWAY_ADMIN_PASSWORD) {
    throw new SetupError("Switch Console's server settings don't include its Admin sign-in. Connect with a registration key instead.")
  }
  let login: Response
  try {
    ;({ res: login } = await call(`${url}/gateway/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD })
    }))
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      throw new SetupError("Switch didn't accept Switch Console's Admin sign-in (it may have been changed). Connect with a registration key instead.")
    }
    throw err
  }
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const auth = { cookie }
  const { body } = await call<{ id: string; key: string }>(`${url}/gateway/api-keys`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'oggy-setup' })
  })
  return {
    key: body.key,
    done: async () => {
      await fetch(`${url}/gateway/api-keys/${encodeURIComponent(body.id)}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(8000) }).catch(() => {})
    }
  }
}

/**
 * Registers Oggy. With `overwrite`, an agent already called `agentName` is re-registered: same id
 * and rooms, but a new key, so whatever used the old key stops working.
 */
async function registerOggy(url: string, registrationKey: string, agentName: string, overwrite: boolean): Promise<{ id: string; api_key: string }> {
  try {
    const { body } = await call<{ id: string; api_key: string }>(`${url}/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${registrationKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: agentName, overwrite, ...OGGY_REGISTRATION })
    })
    if (!body?.api_key) throw new SetupError('Switch registered Oggy but sent back no key.')
    return body
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 409) {
      throw new SetupError(
        overwrite
          ? `Someone else in Switch already has an agent called "${agentName}". Pick another name for Oggy.`
          : `Switch already has an agent called "${agentName}", maybe an Oggy on another PC. Pick another name for this one.`
      )
    }
    if (status === 401) throw new SetupError("Switch didn't accept that registration key. Check it, or make a new one.")
    throw err
  }
}

async function connect(req: ConnectRequest): Promise<ConnectResult> {
  const agentName = req.agentName.trim().toLowerCase()
  if (!AGENT_NAME.test(agentName)) {
    throw new SetupError("Oggy's name can only use lowercase letters, digits, dots, dashes and underscores, and must start with a letter or digit.")
  }
  let url: string
  if (req.mode === 'local') {
    const found = await findSwitch()
    if (!found.found || !found.url) throw new SetupError(found.reason || "Couldn't find Switch on this PC.")
    url = found.url
  } else {
    url = cleanUrl(req.url)
    if (!(await healthy(url))) throw new SetupError(`Nothing answers as Switch at ${url}. Check the address.`)
  }

  // This PC's Oggy from an earlier setup: if its login works on this server, keep it, so its key
  // never changes. The login itself is the test, not the address: localhost and 127.0.0.1 are the
  // same server written two ways.
  const existing = readConfig()?.switch
  const mine = existing?.agentName === agentName
  if (mine && existing.agentId && existing.agentApiKey && (await loginWorks(url, existing.agentId, existing.agentApiKey))) {
    const apiUrl = existing.apiUrl ? cleanUrl(existing.apiUrl) : url
    connection = { apiUrl, agentId: existing.agentId, agentName, apiKey: existing.agentApiKey }
    return { apiUrl, agentId: existing.agentId, agentName }
  }

  // Taking over an existing name gives it a new key. Fine for this PC's own Oggy, or on your own
  // local Switch; on a shared server it could cut off someone else's Oggy, so there it must be new.
  const overwrite = mine || req.mode === 'local'
  let registered: { id: string; api_key: string }
  if (req.mode === 'local') {
    const reg = await adminRegistrationKey(url)
    try {
      registered = await registerOggy(url, reg.key, agentName, overwrite)
    } finally {
      await reg.done()
    }
  } else {
    registered = await registerOggy(url, req.registrationKey.trim(), agentName, overwrite)
  }
  connection = { apiUrl: url, agentId: registered.id, agentName, apiKey: registered.api_key }
  return { apiUrl: url, agentId: registered.id, agentName }
}

/* ---------- the team ---------- */

async function op<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!connection) throw new SetupError('Connect to Switch first.')
  const { body } = await call<{ result: T }>(`${connection.apiUrl}/agents/${encodeURIComponent(connection.agentId)}/ops/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    timeout: 30_000
  })
  return body.result
}

function guessRole(name: string, taken: Set<string>): string {
  const n = name.toLowerCase()
  for (const [role, hint] of ROLE_HINTS) {
    if (hint.test(n) && !taken.has(role)) return role
  }
  return 'other'
}

async function listAgents(): Promise<SetupAgent[]> {
  const listed = await op<unknown>('list_agents', {})
  // Each entry already has the name, description, connector_type and known_agent_type.
  const details = (Array.isArray(listed) ? listed : ((listed as { agents?: unknown[] })?.agents ?? [])) as Record<string, any>[]
  // An earlier setup's choices win over guesses.
  const before = readConfig()?.agents as Record<string, { name?: string }> | undefined
  const chosenBefore = new Map(Object.entries(before ?? {}).map(([alias, a]) => [a.name || alias, alias]))
  const taken = new Set<string>()
  return details
    .filter((a) => a?.name && a.name !== connection?.agentName && a.connector_type !== 'Oggy')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => {
      const prior = chosenBefore.get(a.name)
      const role = prior && ROLE_LABELS[prior] ? prior : guessRole(a.name, taken)
      if (role !== 'other') taken.add(role)
      return { name: a.name, description: a.description || '', kind: a.known_agent_type || a.connector_type || 'agent', role }
    })
}

function roles(): SetupRole[] {
  const example = readExample().agents ?? {}
  return Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label, does: example[id]?.does ?? '' }))
}

/* ---------- saving ---------- */

function save(answers: SetupSave) {
  if (!connection) throw new SetupError('Connect to Switch first.')
  const name = answers.name.trim()
  const discordUsername = answers.discordUsername.trim()
  const codeFolder = answers.codeFolder.trim()
  if (!name || !discordUsername || !codeFolder) throw new SetupError('Fill in your name, your Discord username and your code folder.')

  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(codeFolder, { recursive: true })
  const before = readConfig()
  if (before) copyFileSync(CONFIG, `${CONFIG}.bak`)
  const cfg: FileConfig = before ?? readExample()
  const roleInfo = new Map(roles().map((r) => [r.id, r]))

  // Each chosen agent under its role; a second agent with the same role goes under its own name.
  const agents: FileConfig = {}
  let hasDefault = false
  for (const a of answers.agents) {
    const alias = a.role !== 'other' && !agents[a.role] ? a.role : a.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
    const isDefault: boolean = a.role === 'claude' && !hasDefault
    hasDefault ||= isDefault
    agents[alias] = {
      name: a.name,
      does: (a.role !== 'other' && roleInfo.get(a.role)?.does) || a.description || `${a.name} in Switch.`,
      ...(isDefault ? { default: true } : {})
    }
  }

  cfg.switch = { ...cfg.switch, apiUrl: connection.apiUrl, agentId: connection.agentId, agentApiKey: connection.apiKey, agentName: connection.agentName }
  cfg.owner = { ...cfg.owner, name, discordUsername, switchUserId: cfg.owner?.switchUserId || '' }
  cfg.paths = { ...cfg.paths, codeFolder }
  cfg.agents = agents
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`)
}

function profile(): SetupProfile {
  const cfg = readConfig()
  const user = userInfo().username
  const slug = user.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'me'
  const filled = !!cfg && !needsSetup()
  return {
    name: (filled && cfg?.owner?.name) || user,
    discordUsername: (filled && cfg?.owner?.discordUsername) || '',
    codeFolder: (filled && cfg?.paths?.codeFolder) || join(homedir(), 'code'),
    agentName: (filled && cfg?.switch?.agentName) || `oggy.${slug}`,
    reconnect: filled
  }
}

/* ---------- the window ---------- */

const message = (err: unknown) => (err instanceof SetupError ? err.message : `Something went wrong: ${(err as Error)?.message || err}`)

/** Handlers that report failures as plain sentences, which the window shows as they are. */
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  })
}

let open: Promise<boolean> | null = null

/**
 * Opens the setup window. Resolves true once the answers are saved, false if it was closed first.
 * `load` puts the #/setup screen into the window.
 */
export function runSetup(load: (win: BrowserWindow) => void, webPreferences: WebPreferences): Promise<boolean> {
  if (open) {
    BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Set up Oggy')?.focus()
    return open
  }
  open = new Promise<boolean>((resolve) => {
    connection = null
    let saved = false
    const win = new BrowserWindow({
      width: 1040,
      height: 700,
      minWidth: 860,
      minHeight: 560,
      title: 'Set up Oggy',
      backgroundColor: '#0d0d0f',
      autoHideMenuBar: true,
      show: false,
      webPreferences
    })
    win.once('ready-to-show', () => win.show())
    win.on('page-title-updated', (e) => e.preventDefault())

    handle(SETUP_IPC.profile, profile)
    handle(SETUP_IPC.roles, roles)
    handle(SETUP_IPC.findSwitch, findSwitch)
    handle(SETUP_IPC.connect, connect)
    handle(SETUP_IPC.listAgents, listAgents)
    handle(SETUP_IPC.pickFolder, async (current: string) => {
      const r = await dialog.showOpenDialog(win, { title: 'Your code folder', defaultPath: current, properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    })
    handle(SETUP_IPC.save, (answers: SetupSave) => {
      save(answers)
      saved = true
      setTimeout(() => win.close(), 900)
    })
    ipcMain.on(SETUP_IPC.openSwitchConsole, () => {
      if (existsSync(SWITCH_CONSOLE_EXE)) void shell.openPath(SWITCH_CONSOLE_EXE)
      else void shell.openExternal('https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console.md')
    })

    win.on('closed', () => {
      for (const channel of Object.values(SETUP_IPC)) {
        ipcMain.removeHandler(channel)
        ipcMain.removeAllListeners(channel)
      }
      connection = null
      open = null
      resolve(saved)
    })
    load(win)
  })
  return open
}
