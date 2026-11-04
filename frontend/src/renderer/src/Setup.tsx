import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { SetupAgent, SetupProfile, SetupRole, SwitchFound } from '@common/api'
import { Pet } from './Pet'
import './setup.css'

/**
 * First run: connect Oggy to Switch, pick the team, and say who you are. Everything with a key
 * happens in the main process (src/main/setup.ts); this screen only sees names and addresses.
 */

type Step = 'connect' | 'team' | 'you' | 'done'
const STEPS: { id: Step; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'team', label: 'Your team' },
  { id: 'you', label: 'About you' }
]

const setup = window.oggySetup
const errorText = (err: unknown) => (err as Error)?.message || String(err)

export function Setup() {
  const [step, setStep] = useState<Step>('connect')
  const [profile, setProfile] = useState<SetupProfile | null>(null)
  const [roles, setRoles] = useState<SetupRole[]>([])

  useEffect(() => {
    void setup.profile().then(setProfile)
    void setup.roles().then(setRoles)
  }, [])

  return (
    <div className="setup">
      <header className="su-head">
        <Pet mood={step === 'done' ? 'done' : 'idle'} pose={step === 'done' ? 'hop' : undefined} size={44} />
        <div>
          <h1>{step === 'done' ? 'Oggy is ready' : profile?.reconnect ? 'Set up Oggy again' : 'Set up Oggy'}</h1>
          <p>{step === 'done' ? 'Press Ctrl + Space and tell it what you need.' : 'Three short steps, and you only do this once.'}</p>
        </div>
      </header>

      {step !== 'done' && (
        <ol className="su-steps" aria-label="Setup steps">
          {STEPS.map((s, i) => {
            const at = STEPS.findIndex((x) => x.id === step)
            return (
              <li key={s.id} className={i === at ? 'is-now' : i < at ? 'is-done' : ''} aria-current={i === at ? 'step' : undefined}>
                <span className="su-num">{i < at ? '✓' : i + 1}</span>
                {s.label}
              </li>
            )
          })}
        </ol>
      )}

      <main className="su-body" key={step}>
        {!profile ? (
          <Loading text="Getting ready…" />
        ) : step === 'connect' ? (
          <Connect profile={profile} onConnected={() => setStep('team')} />
        ) : step === 'team' ? (
          <Team roles={roles} onNext={(agents) => (setTeam(agents), setStep('you'))} />
        ) : step === 'you' ? (
          <You profile={profile} onBack={() => setStep('team')} onSaved={() => setStep('done')} />
        ) : (
          <Done />
        )}
      </main>
    </div>
  )
}

/* The chosen team, kept between steps without lifting every field into Setup. */
let team: { name: string; role: string; description: string }[] = []
const setTeam = (t: typeof team) => (team = t)

/* ---------- 1. Connect ---------- */

function Connect({ profile, onConnected }: { profile: SetupProfile; onConnected: () => void }) {
  const [found, setFound] = useState<SwitchFound | null>(null)
  const [manual, setManual] = useState(false)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [agentName, setAgentName] = useState(profile.agentName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const look = async () => {
    setFound(null)
    setError('')
    const f = await setup.findSwitch().catch((e) => ({ found: false, reason: errorText(e) }) as SwitchFound)
    setFound(f)
    if (!f.found && f.url) setUrl(f.url)
  }
  useEffect(() => void look(), [])

  const connect = async (e?: FormEvent) => {
    e?.preventDefault()
    setBusy(true)
    setError('')
    try {
      await setup.connect(manual ? { mode: 'key', url, registrationKey: key, agentName } : { mode: 'local', agentName })
      onConnected()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="su-card" onSubmit={connect}>
      <h2>Connect to Switch</h2>
      <p className="su-lead">Oggy works through Switch, the app that runs your agents and links them to Discord.</p>

      {!manual && (
        <>
          {!found ? (
            <Loading text="Looking for Switch on this PC…" />
          ) : found.found ? (
            <div className="su-status is-ok">
              <span className="su-dot" />
              <div>
                <b>Found Switch on this PC</b>
                <small className="mono">{found.url}</small>
              </div>
            </div>
          ) : (
            <div className="su-status is-warn">
              <span className="su-dot" />
              <div>
                <b>Switch isn't ready</b>
                <small>{found.reason}</small>
              </div>
            </div>
          )}

          {found?.found && (
            <p className="su-note">
              {profile.reconnect
                ? 'Oggy is already connected on this PC. If that login still works, Oggy keeps it.'
                : "Oggy signs in to Switch as your Switch Admin to add itself as an agent, the same way Switch Console adds agents. It reads that sign-in from Switch Console's settings on this PC and never shows or sends it anywhere else."}
            </p>
          )}

          {found && !found.found && (
            <div className="su-row">
              <button type="button" className="su-btn" onClick={() => setup.openSwitchConsole()}>
                Open Switch Console
              </button>
              <button type="button" className="su-btn" onClick={() => void look()}>
                Try again
              </button>
            </div>
          )}
        </>
      )}

      {manual && (
        <>
          <Field label="Switch server address" hint="The address Switch Console shows for the server, such as https://switch.example.com">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8000" spellCheck={false} required />
          </Field>
          <Field label="Registration key" hint="On the server's admin page: API Keys → Create Registration Key. Oggy uses it once to add itself.">
            <input value={key} onChange={(e) => setKey(e.target.value)} type="password" spellCheck={false} required />
          </Field>
        </>
      )}

      <details className="su-more">
        <summary>Oggy's name in Switch</summary>
        <Field label="Agent name" hint="How Oggy appears in your rooms. Lowercase letters, digits, dots and dashes.">
          <input value={agentName} onChange={(e) => setAgentName(e.target.value)} spellCheck={false} required />
        </Field>
      </details>

      {error && <p className="su-error" role="alert">{error}</p>}

      <div className="su-actions">
        <button type="button" className="su-link" onClick={() => (setManual(!manual), setError(''))}>
          {manual ? 'Use Switch on this PC instead' : 'Use a different Switch server'}
        </button>
        <button type="submit" className="su-btn is-primary" disabled={busy || (!manual && !found?.found)}>
          {busy ? <Spin /> : null}
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  )
}

/* ---------- 2. Team ---------- */

function Team({ roles, onNext }: { roles: SetupRole[]; onNext: (agents: { name: string; role: string; description: string }[]) => void }) {
  const [agents, setAgents] = useState<SetupAgent[] | null>(null)
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const [roleOf, setRoleOf] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const load = async () => {
    setAgents(null)
    setError('')
    try {
      const list = await setup.listAgents()
      setAgents(list)
      setChosen(Object.fromEntries(list.map((a) => [a.name, true])))
      setRoleOf(Object.fromEntries(list.map((a) => [a.name, a.role])))
    } catch (err) {
      setError(errorText(err))
      setAgents([])
    }
  }
  useEffect(() => void load(), [])

  const picked = (agents ?? []).filter((a) => chosen[a.name])
  const hasCoder = picked.some((a) => roleOf[a.name] === 'claude')

  return (
    <div className="su-card">
      <h2>Your team</h2>
      <p className="su-lead">Oggy plans the work and hands each step to one of your Switch agents. Pick who's on the team and what each one does.</p>

      {!agents ? (
        <Loading text="Getting your agents from Switch…" />
      ) : agents.length === 0 ? (
        <div className="su-empty">
          <b>No agents in Switch yet</b>
          <p>In Switch Console, open Your Agents and add at least one, such as a Claude Code agent. Then come back and refresh.</p>
          <div className="su-row">
            <button type="button" className="su-btn" onClick={() => setup.openSwitchConsole()}>
              Open Switch Console
            </button>
            <button type="button" className="su-btn" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </div>
      ) : (
        <ul className="su-agents">
          {agents.map((a) => (
            <li key={a.name} className={chosen[a.name] ? 'is-on' : ''}>
              <label className="su-check">
                <input type="checkbox" checked={!!chosen[a.name]} onChange={(e) => setChosen({ ...chosen, [a.name]: e.target.checked })} />
                <span>
                  <b>{a.name}</b>
                  <small>{a.description || a.kind}</small>
                </span>
              </label>
              <select
                value={roleOf[a.name]}
                disabled={!chosen[a.name]}
                onChange={(e) => setRoleOf({ ...roleOf, [a.name]: e.target.value })}
                aria-label={`Role for ${a.name}`}
                title={roles.find((r) => r.id === roleOf[a.name])?.does}
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}

      {agents && agents.length > 0 && !hasCoder && picked.length > 0 && (
        <p className="su-note">Tip: make one agent the General coder. Oggy gives it any job that isn't clearly someone else's.</p>
      )}
      {error && <p className="su-error" role="alert">{error}</p>}

      <div className="su-actions">
        {agents && agents.length > 0 && (
          <button type="button" className="su-link" onClick={() => void load()}>
            Refresh list
          </button>
        )}
        <button
          type="button"
          className="su-btn is-primary"
          disabled={!agents}
          onClick={() => onNext(picked.map((a) => ({ name: a.name, role: roleOf[a.name], description: a.description })))}
        >
          {picked.length ? 'Continue' : 'Skip for now'}
        </button>
      </div>
    </div>
  )
}

/* ---------- 3. You ---------- */

function You({ profile, onBack, onSaved }: { profile: SetupProfile; onBack: () => void; onSaved: () => void }) {
  const [name, setName] = useState(profile.name)
  const [discord, setDiscord] = useState(profile.discordUsername)
  const [folder, setFolder] = useState(profile.codeFolder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const browse = async () => {
    const picked = await setup.pickFolder(folder).catch(() => null)
    if (picked) setFolder(picked)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await setup.save({ name, discordUsername: discord.replace(/^@/, ''), codeFolder: folder, agents: team })
      onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <form className="su-card" onSubmit={save}>
      <h2>About you</h2>
      <p className="su-lead">So Oggy knows who it works for and where your code lives.</p>

      <Field label="Your name" hint="How Oggy talks about you to the team.">
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Your Discord username" hint="Oggy only takes orders in your rooms from this username. Not your display name: the one under it, like aymaan.">
        <input value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="your-username" spellCheck={false} required />
      </Field>
      <Field label="Code folder" hint="Every folder inside it is a project Oggy can work on.">
        <div className="su-pick">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} required />
          <button type="button" className="su-btn" onClick={() => void browse()}>
            Browse…
          </button>
        </div>
      </Field>

      {error && <p className="su-error" role="alert">{error}</p>}

      <div className="su-actions">
        <button type="button" className="su-link" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="submit" className="su-btn is-primary" disabled={busy}>
          {busy ? <Spin /> : null}
          {busy ? 'Saving…' : 'Finish setup'}
        </button>
      </div>
    </form>
  )
}

/* ---------- done ---------- */

function Done() {
  return (
    <div className="su-card su-done">
      <div className="su-status is-ok">
        <span className="su-dot" />
        <div>
          <b>All set</b>
          <small>Oggy is starting. Look for it in the tray, or press Ctrl + Space.</small>
        </div>
      </div>
      <p className="su-note">To add Oggy to a room, open the room in Switch Console and invite it. Change any of this later from the tray: Set up Oggy again.</p>
    </div>
  )
}

/* ---------- bits ---------- */

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="su-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

const Spin = () => <span className="su-spin" aria-hidden />

function Loading({ text }: { text: string }) {
  return (
    <p className="su-loading">
      <Spin /> {text}
    </p>
  )
}
