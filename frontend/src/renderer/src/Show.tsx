import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ShowEffect } from '@shared/types'
import './show.css'

/**
 * Show mode: the transparent window over each screen. The backend says what is happening
 * ("moving 12 files", "Notepad is open"); this decides how it looks and sounds.
 */

type FilesEffect = Extract<ShowEffect, { kind: 'files' }>
type AppEffect = Extract<ShowEffect, { kind: 'app' }>
type ToastEffect = Extract<ShowEffect, { kind: 'toast' }>

type Item = { key: string; leaving?: boolean } & (
  | { kind: 'flash' }
  | { kind: 'shot'; path: string; thumb?: string }
  | ({ kind: 'app' } & Omit<AppEffect, 'kind'>)
  | ({ kind: 'files' } & Omit<FilesEffect, 'kind'> & { chips: { id: number; name: string }[] })
  | { kind: 'keys'; keys: string[] }
  | { kind: 'say'; text: string }
  | ({ kind: 'toast' } & Omit<ToastEffect, 'kind'>)
)

const LEAVE_MS = 380
const LINGER: Record<string, number> = { flash: 650, shot: 6500, keys: 1900, toast: 4200 }

/* ---------- names ---------- */

const APP_NAMES: Record<string, string> = { vscode: 'VS Code', chrome: 'Chrome', edge: 'Edge', explorer: 'File Explorer' }
const appName = (a: string) => APP_NAMES[a] ?? a.charAt(0).toUpperCase() + a.slice(1)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

const FILE_VERBS: Record<FilesEffect['action'], [string, string]> = {
  move: ['Moving', 'Moved'],
  copy: ['Copying', 'Copied'],
  delete: ['Recycling', 'Recycled'],
  zip: ['Zipping', 'Zipped'],
  undo: ['Putting back', 'Put back']
}

/* ---------- the stage ---------- */

export function Show() {
  const [items, setItems] = useState<Item[]>([])
  const timers = useRef(new Map<string, number>())
  const chipId = useRef(0)

  const remove = (key: string) => {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, leaving: true } : i)))
    window.setTimeout(() => setItems((all) => all.filter((i) => i.key !== key)), LEAVE_MS)
  }
  const later = (key: string, ms: number) => {
    window.clearTimeout(timers.current.get(key))
    timers.current.set(key, window.setTimeout(() => remove(key), ms))
  }
  const hold = (key: string) => window.clearTimeout(timers.current.get(key))
  const upsert = (key: string, make: (prev: Item | undefined) => Item) =>
    setItems((all) => {
      const prev = all.find((i) => i.key === key)
      const next = make(prev)
      return prev ? all.map((i) => (i.key === key ? next : i)) : [...all, next]
    })

  useEffect(
    () =>
      window.oggy.onShow((e) => {
        switch (e.kind) {
          case 'shutter.prep':
            return
          case 'shutter': {
            const t = Date.now()
            upsert(`flash-${t}`, () => ({ key: `flash-${t}`, kind: 'flash' }))
            later(`flash-${t}`, LINGER.flash)
            if (e.flashOnly) return
            const key = `shot-${t}`
            upsert(key, () => ({ key, kind: 'shot', path: e.path, thumb: e.thumb }))
            return later(key, LINGER.shot)
          }
          case 'app': {
            const key = `app-${e.id}`
            upsert(key, (prev) => ({ ...e, key, icon: e.icon ?? (prev?.kind === 'app' ? prev.icon : undefined) }))
            if (e.phase === 'start') return
            return later(key, e.phase === 'done' ? 1900 : 4000)
          }
          case 'files': {
            const key = `files-${e.id}`
            upsert(key, (prev) => {
              const p = prev?.kind === 'files' ? prev : undefined
              const names = p?.names ?? e.names
              const before = p?.done ?? 0
              // One flying chip for each file finished since the last update.
              const fresh = Array.from({ length: Math.max(0, Math.min(e.done, names.length) - before) }, (_, i) => ({
                id: ++chipId.current,
                name: names[before + i] ?? ''
              }))
              return { ...e, key, names, chips: [...(p?.chips ?? []), ...fresh].slice(-14) }
            })
            if (e.phase === 'done') later(key, 1700)
            return
          }
          case 'keys': {
            const key = `keys-${Date.now()}`
            upsert(key, () => ({ key, kind: 'keys', keys: e.keys }))
            return later(key, LINGER.keys)
          }
          case 'say': {
            const key = 'say' // one caption at a time
            upsert(key, () => ({ key, kind: 'say', text: e.text }))
            hold(key)
            return later(key, Math.max(2400, e.text.length * 70))
          }
          case 'toast': {
            const key = `toast-${Date.now()}`
            upsert(key, () => ({ key, kind: 'toast', icon: e.icon, title: e.title, detail: e.detail }))
            return later(key, LINGER.toast)
          }
        }
      }),
    []
  )

  // Nothing playing: let the window hide so it never sits over your screen.
  useEffect(() => {
    if (items.length) return
    const t = window.setTimeout(() => window.oggy.showIdle(), 200)
    return () => window.clearTimeout(t)
  }, [items.length])

  const interactive = {
    onMouseEnter: () => window.oggy.setShowInteractive(true),
    onMouseLeave: () => window.oggy.setShowInteractive(false)
  }

  const dock = items.filter((i) => i.kind === 'app' || i.kind === 'files' || i.kind === 'keys' || i.kind === 'say')
  return (
    <div className="show-root">
      {items.map((i) => i.kind === 'flash' && <div key={i.key} className="show-flash" />)}

      <div className="show-toasts">
        {items.map(
          (i) =>
            i.kind === 'toast' && (
              <div key={i.key} className={`show-toast ${i.leaving ? 'is-leaving' : ''}`}>
                <span className={`st-icon is-${i.icon}`}>{TOAST_ICONS[i.icon]}</span>
                <span className="st-text">
                  <b>{i.title}</b>
                  {i.detail && <small>{i.detail}</small>}
                </span>
              </div>
            )
        )}
      </div>

      <div className="show-dock">
        {dock.map((i) => (
          <div key={i.key} className={`show-card is-${i.kind} ${i.leaving ? 'is-leaving' : ''}`}>
            {i.kind === 'app' && <AppCard item={i} />}
            {i.kind === 'files' && <FilesCard item={i} />}
            {i.kind === 'keys' && (
              <div className="keys">
                {i.keys.map((k, n) => (
                  <kbd key={n} style={{ animationDelay: `${n * 70}ms` }}>
                    {k}
                  </kbd>
                ))}
              </div>
            )}
            {i.kind === 'say' && (
              <div className="say">
                <span className="say-wave" aria-hidden>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <i key={n} style={{ animationDelay: `${n * 110}ms` }} />
                  ))}
                </span>
                <span>{i.text}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {items.map(
        (i) =>
          i.kind === 'shot' && (
            <ShotCard
              key={i.key}
              item={i}
              {...interactive}
              onHold={() => hold(i.key)}
              onRelease={() => later(i.key, 2500)}
              onOpen={(reveal) => {
                window.oggy.openShot(i.path, reveal)
                remove(i.key)
                window.oggy.setShowInteractive(false)
              }}
            />
          )
      )}
    </div>
  )
}

/* ---------- pieces ---------- */

function AppCard({ item }: { item: Extract<Item, { kind: 'app' }> }) {
  const name = appName(item.app)
  const opening = item.action === 'open'
  const title =
    item.phase === 'start' ? `${opening ? 'Opening' : 'Closing'} ${name}` : item.phase === 'failed' ? `Couldn't ${item.action} ${name}` : item.note ?? (opening ? `${name} is open` : `Closed ${name}`)
  const sub = item.phase === 'start' ? (opening ? 'Waiting for its window…' : 'Asking it to close…') : item.phase === 'failed' ? item.note : opening ? 'Ready' : 'Gone'
  return (
    <div className={`app is-${item.action} is-${item.phase}`}>
      <span className="app-icon">
        {item.icon ? <img src={item.icon} alt="" /> : <span className="app-letter">{name.charAt(0)}</span>}
        <span className="app-ring" />
        {item.phase !== 'start' && <span className="app-badge">{item.phase === 'done' ? '✓' : '!'}</span>}
      </span>
      <span className="app-text">
        <b>{title.charAt(0).toUpperCase() + title.slice(1)}</b>
        {sub && <small>{sub}</small>}
      </span>
    </div>
  )
}

function FilesCard({ item }: { item: Extract<Item, { kind: 'files' }> }) {
  const total = item.names.length
  const [verb, past] = FILE_VERBS[item.action]
  const finished = item.phase === 'done'
  // Each chip flies once: landed ones leave this list and must not come back on the next update.
  const seen = useRef(new Set<number>())
  const [chips, setChips] = useState<typeof item.chips>([])
  useEffect(() => {
    const fresh = item.chips.filter((c) => !seen.current.has(c.id))
    for (const c of fresh) seen.current.add(c.id)
    if (fresh.length) setChips((all) => [...all, ...fresh])
  }, [item.chips])
  const pct = total ? Math.round((Math.min(item.done, total) / total) * 100) : 100

  return (
    <div className={`files is-${item.action} ${finished ? 'is-finished' : ''}`}>
      <div className="files-head">
        <b>{finished ? `${past} ${plural(total, 'file')}` : `${verb} ${plural(total, 'file')}`}</b>
        <span>
          {Math.min(item.done, total)} of {total}
        </span>
      </div>
      <div className="files-lane">
        <Place label={item.from} kind="folder" />
        <div className="files-track">
          <span className="files-fill" style={{ width: `${pct}%` }} />
          {chips.map((c) => (
            <span
              key={c.id}
              className="chip"
              onAnimationEnd={(e) => {
                if (e.target !== e.currentTarget) return
                setChips((all) => all.filter((x) => x.id !== c.id))
              }}
            >
              <span className="chip-y">
                <FileGlyph name={c.name} />
                <span className="chip-name">{c.name}</span>
              </span>
            </span>
          ))}
        </div>
        <Place label={item.to} kind={item.action === 'delete' ? 'bin' : item.action === 'zip' ? 'zip' : 'folder'} pulse={item.done} done={finished} />
      </div>
    </div>
  )
}

function Place({ label, kind, pulse, done }: { label: string; kind: 'folder' | 'bin' | 'zip'; pulse?: number; done?: boolean }) {
  return (
    <span className={`place is-${kind} ${done ? 'is-done' : ''}`}>
      <span key={pulse} className="place-icon">
        {kind === 'bin' ? BIN : kind === 'zip' ? ZIP : FOLDER}
      </span>
      <small title={label}>{label}</small>
    </span>
  )
}

function FileGlyph({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const tone = /png|jpe?g|gif|webp|heic|bmp/.test(ext) ? 'img' : /mp4|mov|mkv|avi/.test(ext) ? 'vid' : /zip|rar|7z/.test(ext) ? 'zip' : /pdf/.test(ext) ? 'pdf' : 'doc'
  return <span className={`glyph is-${tone}`}>{ext.slice(0, 4) || '—'}</span>
}

function ShotCard(props: {
  item: Extract<Item, { kind: 'shot' }>
  onMouseEnter: () => void
  onMouseLeave: () => void
  onHold: () => void
  onRelease: () => void
  onOpen: (reveal: boolean) => void
}) {
  const { item } = props
  // Starts as the whole screen and shrinks into the corner, like a photo dropping onto the desk.
  const W = window.innerWidth
  const H = window.innerHeight
  const w = 300
  const h = w * (H / W)
  const style = {
    '--s': W / w,
    '--tx': `${W / 2 - (W - 24 - w / 2)}px`,
    '--ty': `${H / 2 - (H - 24 - h / 2)}px`
  } as CSSProperties
  const name = item.path.split(/[\\/]/).pop()
  return (
    <div
      className={`show-shot ${item.leaving ? 'is-leaving' : ''}`}
      style={style}
      onMouseEnter={() => (props.onMouseEnter(), props.onHold())}
      onMouseLeave={() => (props.onMouseLeave(), props.onRelease())}
    >
      <button className="shot-img" onClick={() => props.onOpen(false)} title="Open">
        {item.thumb ? <img src={item.thumb} alt="Screenshot" /> : <span className="shot-missing">Screenshot</span>}
      </button>
      <div className="shot-bar">
        <span>{name}</span>
        <button onClick={() => props.onOpen(true)}>Show in folder</button>
      </div>
    </div>
  )
}

/* ---------- icons ---------- */

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
)
const FOLDER = svg(<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />)
const BIN = svg(
  <>
    <path d="M4 7h16M9 7V5h6v2M6.5 7l1 12.5h9l1-12.5" />
    <path d="M10 11v5M14 11v5" />
  </>
)
const ZIP = svg(
  <>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M12 3v2M12 7v2M12 11v2M10.5 15h3v3h-3z" />
  </>
)
const TOAST_ICONS: Record<ToastEffect['icon'], ReactNode> = {
  post: svg(<path d="M4 5h16v11H8l-4 3.5z" />),
  calendar: svg(
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </>
  ),
  folder: FOLDER,
  agent: svg(
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1-4 4-6 7-6s6 2 7 6" />
    </>
  ),
  build: svg(<path d="M14.5 6.5l3 3M4 20l7.5-7.5M13 4l7 7-3 3-7-7z" />),
  volume: svg(<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9a4 4 0 0 1 0 6" />),
  undo: svg(<path d="M9 7L5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2" />),
  deploy: svg(<path d="M12 3c3 2 5 6 5 10l-2.5 3h-5L7 13c0-4 2-8 5-10zM9.5 16l-1.5 4M14.5 16l1.5 4" />)
}
