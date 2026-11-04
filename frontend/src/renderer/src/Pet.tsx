import { useEffect, useRef, useState, type CSSProperties } from 'react'

export type Mood = 'idle' | 'hearing' | 'working' | 'waiting' | 'done' | 'stuck'
type Pose = 'sit' | 'walk' | 'run' | 'sleep' | 'hop'
/** How Oggy's dressed: in a hoodie for coding, in shades on a beach chair for your day. */
export type Look = 'cat' | 'coder' | 'beach'

/* The pet: Oggy, a small blue pixel cat, drawn here so there's no image to ship. */
const COLORS: Record<string, string> = {
  B: '#5f8fe8', D: '#3a63bd', L: '#8fb2f2', W: '#e4ecff', K: '#0f1218', P: '#f29bb4',
  // the hoodie
  H: '#5d6680', h: '#363d4d',
  // shades, and the beach chair
  S: '#141c28', G: '#eef4ff', R: '#ef7b6c', C: '#f1e2bd', O: '#a5703c'
}

const HEAD = [
  '....D.....D.....',
  '....DD...DD.....',
  '...DBBBBBBBD....',
  '...BBBBBBBBB....',
  '...BKBBBBBKB....',
  '...BBBWPWBBB...D',
  '....BWWWWWB...DB',
  '....BBBBBBBB..BD'
]
const SLEEPY = HEAD.map((row, i) => (i === 4 ? '...BDDBBBDDB....' : row))
const BODY = [
  '...LBBWWWBBBBBBD',
  '...BBBWWWBBBBBD.',
  '...BBBBBBBBBBB..',
  '...BBBBBBBBBBB..'
]
const legs = (a: string, b: string) => [a, b]
const SIT = legs('...WWB...BWW....', '................')
const STEP = [
  legs('...WW.....WW....', '................'),
  legs('....WW...WW.....', '................'),
  legs('.....WW.WW......', '................'),
  legs('....WW...WW.....', '................')
]
const LOAF = [
  '................',
  '................',
  '....D.....D.....',
  '....DD...DD.....',
  '...DBBBBBBBD....',
  '...BDDBBBDDB....',
  '...BBBWPWBBB....',
  '..BBBBWWWBBBBBB.',
  '..BBBBBBBBBBBBBD',
  '..BBBBBBBBBBBBBD',
  '...WWBBBBBBBWW..',
  '................',
  '................',
  '................'
]

/* Coding: the hood around the head, a grey hoodie with its drawstrings and pocket. */
const HOOD = [
  '....D.....D.....',
  '....DD...DD.....',
  '..hhhhhhhhhhh...',
  '..hHBBBBBBBHh...',
  '..hBKBBBBBKBh...',
  '..hBBBWPWBBBh..D',
  '..hhBWWWWWBhh.DB',
  '...hBBBBBBBBh.BD'
]
const HOOD_SLEEPY = HOOD.map((row, i) => (i === 4 ? '..hBDDBBBDDBh...' : row))
const HOODIE = [
  '...hHHWHWHHHHHHD',
  '...HHHWHWHHHHHD.',
  '...HHHhhhhHHHH..',
  '...HHHHHHHHHHH..'
]
const LOAF_HOODIE = LOAF.map((row, y) => (y >= 7 && y <= 9 ? row.replace(/[BW]/g, (c, x: number) => (x >= 2 && x <= 13 ? 'H' : c)) : y === 10 ? row.replace(/B/g, 'H') : row))

/* Your day: shades, and a striped beach chair to lean back in. */
const SHADES = HEAD.map((row, i) => (i === 4 ? '..KSGSKKKSGSK...' : i === 5 ? '...SSSWPWSSS...D' : row))
const LOUNGE = [
  '....D.....D.....',
  '....DD...DD.....',
  '...DBBBBBBBD.OO.',
  '...BBBBBBBBB.RR.',
  '..KSGSKKKSGSKCC.',
  '...SSSWPWSSS.RR.',
  '....BWWWWWB..CC.',
  '....BBBBBBBB.RR.',
  '...LBBWWWBBBBCC.',
  '...BBBWWWBBBBRR.',
  '...BBBBBBBBBBCC.',
  'WWBBBBBBBBBBBRR.',
  '..ORCRCRCRCRCRO.',
  '...O........O...'
]

/**
 * Sit, blink, four steps of a walk, two breaths of sleep, and a hop: the same nine frames in every
 * look. At the beach, sitting and sleeping are both lying back in the chair.
 */
function framesOf(head: string[], sleepy: string[], body: string[], loaf: string[], rest?: string[]): string[][] {
  return [
    rest ?? [...head, ...body, ...SIT],
    rest ?? [...sleepy, ...body, ...SIT],
    ...STEP.map((l) => [...head, ...body, ...l]),
    rest ?? loaf,
    rest ?? ['................', ...loaf.slice(0, 13)],
    ['................', ...head, ...body, '...WW.....WW....']
  ]
}
const LOOKS: Record<Look, string[][]> = {
  cat: framesOf(HEAD, SLEEPY, BODY, LOAF),
  coder: framesOf(HOOD, HOOD_SLEEPY, HOODIE, LOAF_HOODIE),
  beach: framesOf(SHADES, SHADES, BODY, LOAF, LOUNGE)
}
const FRAMES = LOOKS.cat.length
const W = 16
const H = 14

function sheet(look: Look): string {
  const frames = LOOKS[look]
  const c = document.createElement('canvas')
  c.width = W * frames.length
  c.height = H
  const g = c.getContext('2d')!
  frames.forEach((rows, f) =>
    rows.forEach((row, y) =>
      [...row].forEach((px, x) => {
        if (!COLORS[px]) return
        g.fillStyle = COLORS[px]
        g.fillRect(f * W + x, y, 1, 1)
      })
    )
  )
  return `url(${c.toDataURL()})`
}
const cached: Partial<Record<Look, string>> = {}

const POSES: Record<Mood, Pose> = { idle: 'sit', hearing: 'hop', working: 'walk', waiting: 'sit', done: 'hop', stuck: 'sit' }

/** The pet in one place, showing how Oggy is: sitting, listening, trotting, sleeping, hopping. */
export function Pet({ mood = 'idle', pose, size = 28, look = 'cat', style }: { mood?: Mood; pose?: Pose; size?: number; look?: Look; style?: CSSProperties }) {
  cached[look] ??= sheet(look)
  return (
    <span
      className={`pet is-${pose ?? POSES[mood]} mood-${mood} look-${look}`}
      style={{ '--s': `${size}px`, '--frames': FRAMES, backgroundImage: cached[look], ...style } as CSSProperties}
      aria-hidden
    />
  )
}

/**
 * Oggy, roaming: walks along the edge of the room, stops, looks around, naps when nothing's going
 * on, and hurries when there's work. The bubble says what it's up to. Moved with a transform straight
 * on the element, so walking never re-renders the app.
 */
export function RoamingPet({ mood, line, look = 'cat', onClick }: { mood: Mood; line?: string; look?: Look; onClick?: () => void }) {
  const box = useRef<HTMLButtonElement>(null)
  const [pose, setPose] = useState<Pose>('sit')
  const [left, setLeft] = useState(false)
  const moodNow = useRef(mood)
  moodNow.current = mood
  // At the beach Oggy stays in the chair, and only gets up when there's work.
  const lookNow = useRef(look)
  lookNow.current = look

  useEffect(() => {
    const el = box.current
    if (!el) return
    let x = 40
    let target = x
    let until = performance.now() + 1200
    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const busy = moodNow.current === 'working'
      const width = (el.parentElement?.clientWidth ?? 600) - 44
      if (x !== target) {
        const step = (busy ? 72 : 34) * dt
        x = Math.abs(target - x) <= step ? target : x + Math.sign(target - x) * step
        el.style.transform = `translateX(${x}px)`
        if (x === target) {
          setPose(busy ? 'sit' : moodNow.current === 'idle' && Math.random() < 0.45 ? 'sleep' : 'sit')
          until = now + (busy ? 900 + Math.random() * 1500 : 3000 + Math.random() * 6000)
        }
      } else if (now > until && lookNow.current === 'beach' && !busy) {
        until = now + 1500
        setPose('sit')
      } else if (now > until) {
        target = 12 + Math.random() * Math.max(40, width - 12)
        setLeft(target < x)
        setPose(busy ? 'run' : 'walk')
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const shown = mood === 'done' || mood === 'waiting' || mood === 'stuck' ? mood : undefined
  return (
    <button ref={box} className="roam" onClick={onClick} title="Oggy" tabIndex={-1}>
      {line && (
        <span key={line} className="roam-say">
          {line}
        </span>
      )}
      <Pet pose={shown === 'done' ? 'hop' : pose} mood={mood} look={look} size={38} style={{ scale: left ? '-1 1' : undefined }} />
    </button>
  )
}
