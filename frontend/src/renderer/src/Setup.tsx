import { useEffect, useState, type ReactNode } from 'react'
import type { SetupAgent, SetupProfile, SetupRole, SwitchFound } from '@common/api'
import { Pet, RoamingPet, type Mood } from './Pet'
import { Who } from './ui'
import './app.css'
import './setup.css'

/**
 * First run: connect Oggy to Switch, pick the team, and say who you are. Built from the dashboard's
 * own pieces (sidebar, toolbar, tables, buttons, the roaming pet) so it looks like the rest of Oggy.
 * Everything with a key happens in the main process (src/main/setup.ts); this only sees names.
 */

type Step = 'connect' | 'team' | 'you' | 'done'
type Pick = { name: string; role: string; description: string }

const STEPS: { id: Exclude<Step, 'done'>; label: string; title: string }[] = [
  { id: 'connect', label: 'Connect', title: 'Connect to Switch' },
  { id: 'team', label: 'Team', title: 'Pick your team' },
  { id: 'you', label: 'You', title: 'About you' }
]

const setup = window.oggySetup
const errorText = (err: unknown) => (err as Error)?.message || String(err)

export function Setup() {
  const [step, setStep] = useState<Step>('connect')
  const [profile, setProfile] = useState<SetupProfile | null>(null)
  const [roles, setRoles] = useState<SetupRole[]>([])
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | undefined>()

  // Step 1
  const [found, setFound] = useState<SwitchFound | null>(null)
  const [manual, setManual] = useState(false)
  const [url, setUrl] = useState('')
  const [regKey, setRegKey] = useState('')
  const [agentName, setAgentName] = useState('')
  // Step 2
  const [agents, setAgents] = useState<SetupAgent[] | null>(null)
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const [roleOf, setRoleOf] = useState<Record<string, string>>({})
  // Step 3
  const [name, setName] = useState('')
  const [discord, setDiscord] = useState('')
  const [folder, setFolder] = useState('')

  const [error, setError] = useState('')
  const at = STEPS.findIndex((s) => s.id === step)

  useEffect(() => {
    void setup.profile().then((p) => {
      setProfile(p)
      setAgentName(p.agentName)
      setName(p.name)
      setDiscord(p.discordUsername)
      setFolder(p.codeFolder)
    })
    void setup.roles().then(setRoles)
    void look()
  }, [])

  const look = async () => {
    setFound(null)
    setError('')
    const f = await setup.findSwitch().catch((e) => ({ found: false, reason: errorText(e) }) as SwitchFound)
    setFound(f)
    if (!f.found && f.url) setUrl(f.url)
    setSaid(f.found ? 'Found Switch' : undefined)
  }

  const loadAgents = async () => {
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

  /** The toolbar's main button: whatever moves this step forward. */
  const next = async () => {
    setError('')
    setBusy(true)
    try {
      if (step === 'connect') {
        setSaid('Connecting…')
        await setup.connect(manual ? { mode: 'key', url, registrationKey: regKey, agentName } : { mode: 'local', agentName })
        setSaid('Connected')
        setStep('team')
        void loadAgents()
      } else if (step === 'team') {
        setStep('you')
        setSaid(undefined)
      } else if (step === 'you') {
        if (!name.trim() || !discord.trim() || !folder.trim()) throw new Error('Fill in your name, your Discord username and your code folder.')
        const team: Pick[] = (agents ?? []).filter((a) => chosen[a.name]).map((a) => ({ name: a.name, role: roleOf[a.name], description: a.description }))
        await setup.save({ name, discordUsername: discord.replace(/^@/, ''), codeFolder: folder, agents: team })
        setSaid('All set')
        setStep('done')
      }
    } catch (err) {
      setError(errorText(err))
      setSaid(undefined)
    } finally {
      setBusy(false)
    }
  }

  const picked = (agents ?? []).filter((a) => chosen[a.name])
  const canGo =
    !busy &&
    (step === 'connect'
      ? manual
        ? !!url.trim() && !!regKey.trim() && !!agentName.trim()
        : !!found?.found && !!agentName.trim()
      : step === 'team'
        ? agents !== null
        : step === 'you'
          ? !!name.trim() && !!discord.trim() && !!folder.trim()
          : false)
  const action = step === 'connect' ? (busy ? 'Connecting…' : 'Connect') : step === 'team' ? (picked.length ? 'Continue' : 'Skip for now') : busy ? 'Saving…' : 'Finish setup'
  const mood: Mood = step === 'done' ? 'done' : busy ? 'working' : error ? 'stuck' : 'idle'
  const current = STEPS[at]

  return (
    <div className="oggy-app su">
      <aside className="side">
        <div className="side-brand">
          <Pet size={18} />
          <b>Oggy</b>
        </div>
        <p className="su-side-lead">Set up</p>
        <nav className="side-nav" aria-label="Setup steps">
          {STEPS.map((s, i) => {
            const state = step === 'done' || i < at ? 'is-done' : i === at ? (busy ? 'is-working' : 'is-you') : 'is-queued'
            return (
              <button
                key={s.id}
                className={i === at ? 'is-on' : ''}
                disabled={step === 'done' || i > at || busy}
                onClick={() => (setError(''), setStep(s.id))}
                aria-current={i === at ? 'step' : undefined}
              >
                <span className={`state ${state}`} />
                {s.label}
                <em className="is-quiet">{i + 1}</em>
              </button>
            )
          })}
        </nav>
        <div className="grow" />
        <div className="side-foot">
          <span className="dot" style={{ background: found?.found ? 'var(--ok)' : 'var(--paper-4)' }} />
          {found?.found ? 'Switch found' : found ? 'Switch not found' : 'Looking for Switch…'}
        </div>
      </aside>

      <section className="main">
        <header className="bar">
          <p className="crumbs">
            <b>{step === 'done' ? 'Oggy is ready' : current.title}</b>
            {step !== 'done' && <span>Step {at + 1} of 3</span>}
          </p>
          <div className="grow" />
          {(step === 'team' || step === 'you') && (
            <button className="btn" disabled={busy} onClick={() => (setError(''), setStep(step === 'you' ? 'team' : 'connect'))}>
              Back
            </button>
          )}
          {step !== 'done' && (
            <button className="btn is-primary" disabled={!canGo} onClick={() => void next()}>
              {busy && <span className="spin su-spin-dark" />}
              {action}
            </button>
          )}
        </header>

        <div className="su-page" key={step}>
          {!profile ? (
            <p className="su-muted">
              <span className="spin" /> Getting ready…
            </p>
          ) : step === 'connect' ? (
            <>
              <Intro>Oggy works through Switch, which runs your agents and links them to Discord. Oggy adds itself to Switch as an agent.</Intro>

              {!manual ? (
                <div className="table">
                  <header>
                    <b>Switch on this PC</b>
                    <span>{found?.found ? 'Ready' : found ? 'Not ready' : 'Checking'}</span>
                  </header>
                  <div className="su-line">
                    {!found ? <span className="spin" /> : <span className={`state ${found.found ? 'is-done' : 'is-you'}`} />}
                    <div className="su-line-what">
                      <b>{!found ? 'Looking for Switch Console…' : found.found ? 'Switch Console is running' : "Switch isn't ready"}</b>
                      <small>{found?.found ? <span className="mono">{found.url}</span> : found?.reason}</small>
                    </div>
                    {found && !found.found && (
                      <span className="su-line-acts">
                        <button className="btn" onClick={() => setup.openSwitchConsole()}>
                          Open Switch Console
                        </button>
                        <button className="btn" onClick={() => void look()}>
                          Try again
                        </button>
                      </span>
                    )}
                  </div>
                  {found?.found && (
                    <p className="su-foot-note">
                      {profile.reconnect
                        ? 'Oggy is already connected on this PC. If its login still works, it keeps it.'
                        : "Oggy signs in as your Switch Admin to add itself, the same way Switch Console adds agents. It reads that sign-in from Switch Console's settings on this PC and never shows or sends it anywhere else."}
                    </p>
                  )}
                </div>
              ) : (
                <div className="table">
                  <header>
                    <b>Another Switch server</b>
                    <span>Team or hosted</span>
                  </header>
                  <div className="su-fields">
                    <Field label="Server address" hint="The address Switch Console shows for the server.">
                      <input className="su-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://switch.example.com" spellCheck={false} />
                    </Field>
                    <Field label="Registration key" hint="On the server's admin page: API Keys → Create Registration Key. Oggy uses it once.">
                      <input className="su-input" value={regKey} onChange={(e) => setRegKey(e.target.value)} type="password" spellCheck={false} />
                    </Field>
                  </div>
                </div>
              )}

              <div className="table">
                <header>
                  <b>Oggy's name in Switch</b>
                  <span>How it shows in your rooms</span>
                </header>
                <div className="su-fields">
                  <Field hint="Lowercase letters, digits, dots and dashes.">
                    <input className="su-input mono" value={agentName} onChange={(e) => setAgentName(e.target.value)} spellCheck={false} aria-label="Oggy's name in Switch" />
                  </Field>
                </div>
              </div>

              <button className="btn is-quiet su-switch" onClick={() => (setManual(!manual), setError(''))}>
                {manual ? 'Use Switch on this PC instead' : 'Use a different Switch server'}
              </button>
            </>
          ) : step === 'team' ? (
            <>
              <Intro>Oggy plans the work and hands each step to one of your Switch agents. Pick who's on the team and what each one does.</Intro>
              <div className="table">
                <header>
                  <b>{agents ? `${agents.length} agent${agents.length === 1 ? '' : 's'}` : 'Agents'}</b>
                  <span>{agents ? `${picked.length} on the team` : ''}</span>
                </header>
                {!agents ? (
                  <p className="table-empty">
                    <span className="spin" /> Getting your agents from Switch…
                  </p>
                ) : agents.length === 0 ? (
                  <div className="su-line">
                    <span className="state is-you" />
                    <div className="su-line-what">
                      <b>No agents in Switch yet</b>
                      <small>In Switch Console, open Your Agents and add one, such as a Claude Code agent. Then refresh.</small>
                    </div>
                    <span className="su-line-acts">
                      <button className="btn" onClick={() => setup.openSwitchConsole()}>
                        Open Switch Console
                      </button>
                      <button className="btn" onClick={() => void loadAgents()}>
                        Refresh
                      </button>
                    </span>
                  </div>
                ) : (
                  agents.map((a) => (
                    <label key={a.name} className={`su-agent ${chosen[a.name] ? 'is-on' : ''}`}>
                      <input type="checkbox" checked={!!chosen[a.name]} onChange={(e) => setChosen({ ...chosen, [a.name]: e.target.checked })} />
                      <Who name={a.name} />
                      <span className="su-line-what">
                        <b className="clip">{a.name}</b>
                        <small className="clip">{a.description || a.kind}</small>
                      </span>
                      <select
                        className="su-select"
                        value={roleOf[a.name]}
                        disabled={!chosen[a.name]}
                        onChange={(e) => setRoleOf({ ...roleOf, [a.name]: e.target.value })}
                        aria-label={`Job for ${a.name}`}
                        title={roles.find((r) => r.id === roleOf[a.name])?.does}
                      >
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))
                )}
              </div>
              {agents && agents.length > 0 && (
                <button className="btn is-quiet su-switch" onClick={() => void loadAgents()}>
                  Refresh list
                </button>
              )}
              {agents && picked.length > 0 && !picked.some((a) => roleOf[a.name] === 'claude') && (
                <p className="su-muted">Tip: make one agent the General coder. Oggy gives it any job that isn't clearly someone else's.</p>
              )}
            </>
          ) : step === 'you' ? (
            <>
              <Intro>So Oggy knows who it works for and where your code lives.</Intro>
              <div className="table">
                <header>
                  <b>You</b>
                </header>
                <div className="su-fields">
                  <Field label="Your name" hint="How Oggy talks about you to the team.">
                    <input className="su-input" value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  <Field label="Discord username" hint="Oggy only takes orders in your rooms from this username: the one under your display name.">
                    <input className="su-input" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="your-username" spellCheck={false} />
                  </Field>
                  <Field label="Code folder" hint="Every folder inside it is a project Oggy can work on.">
                    <div className="su-pick">
                      <input className="su-input mono" value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
                      <button
                        className="btn"
                        onClick={() =>
                          void setup
                            .pickFolder(folder)
                            .then((p) => p && setFolder(p))
                            .catch(() => {})
                        }
                      >
                        Browse…
                      </button>
                    </div>
                  </Field>
                </div>
              </div>
            </>
          ) : (
            <div className="su-done">
              <Pet pose="hop" mood="done" size={56} />
              <div>
                <b>Oggy is ready</b>
                <p>Press Ctrl + Space and tell it what you need. Oggy lives in the tray.</p>
                <p className="su-muted">Next, open a room in Switch Console and invite {agentName} to it. To change anything later: tray icon → Set up Oggy again…</p>
              </div>
            </div>
          )}

          {error && (
            <p className="su-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="pet-rail su-rail">
          <RoamingPet mood={mood} line={said} />
        </div>
      </section>
    </div>
  )
}

function Intro({ children }: { children: ReactNode }) {
  return <p className="su-intro">{children}</p>
}

function Field({ label, hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="su-field">
      {label && <span>{label}</span>}
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}
