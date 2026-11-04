import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

/** The four corners the island can live in. It grows away from its corner, so it never leaves the screen. */
export type Corner = 'tl' | 'tr' | 'bl' | 'br'

const CORNER_KEY = 'oggy.corner'
const MARGIN = 16
/** How far a throw carries, in seconds of its speed at release. */
const THROW = 0.16

export function loadCorner(): Corner {
  try {
    const c = localStorage.getItem(CORNER_KEY)
    return c === 'tl' || c === 'bl' || c === 'br' ? c : 'tr'
  } catch {
    return 'tr'
  }
}

export function saveCorner(c: Corner) {
  try {
    localStorage.setItem(CORNER_KEY, c)
  } catch {
    /* only a convenience */
  }
}

const pointOf = (c: Corner) => ({
  x: c[1] === 'r' ? window.innerWidth - MARGIN : MARGIN,
  y: c[0] === 'b' ? window.innerHeight - MARGIN : MARGIN
})

/**
 * Drag the island anywhere, throw it, and it springs into the corner you threw it towards, like
 * picture-in-picture on a phone. It follows the pointer on the compositor (a transform written
 * straight to the element, no React render), and the throw keeps your hand's speed.
 */
export function useIslandDrag(opts: {
  stage: RefObject<HTMLDivElement>
  isle: RefObject<HTMLDivElement>
  enabled: boolean
  /** Picked up or put down: the window must keep taking the mouse while it's held. */
  onHold: (held: boolean) => void
  onLift: (lifted: boolean) => void
  /** Called before the throw lands, so the island's anchor is the new corner when it's measured. */
  onCorner: (c: Corner) => void
}) {
  const grip = useRef<{ id: number; dx: number; dy: number; x: number; y: number; vx: number; vy: number; t: number } | null>(null)
  const raf = useRef(0)

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const stage = opts.stage.current
      if (!opts.enabled || !stage || e.button !== 0 || !target.closest('[data-drag]') || target.closest('button, textarea, input')) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      cancelAnimationFrame(raf.current)
      const box = stage.getBoundingClientRect()
      grip.current = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top, x: box.left, y: box.top, vx: 0, vy: 0, t: e.timeStamp }
      stage.style.translate = `${box.left}px ${box.top}px`
      opts.onHold(true)
      opts.onLift(true)
    },
    [opts]
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = grip.current
      const stage = opts.stage.current
      if (!g || g.id !== e.pointerId || !stage) return
      const x = e.clientX - g.dx
      const y = e.clientY - g.dy
      const dt = Math.max(1, e.timeStamp - g.t) / 1000
      // Smoothed, so the last jittery millisecond doesn't decide where a throw goes.
      g.vx = g.vx * 0.7 + ((x - g.x) / dt) * 0.3
      g.vy = g.vy * 0.7 + ((y - g.y) / dt) * 0.3
      g.x = x
      g.y = y
      g.t = e.timeStamp
      stage.style.translate = `${x}px ${y}px`
    },
    [opts.stage]
  )

  const settle = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = grip.current
      const stage = opts.stage.current
      const isle = opts.isle.current
      if (!g || g.id !== e.pointerId || !stage || !isle) return
      grip.current = null
      opts.onLift(false)

      // A pause before letting go means "put it here", not "throw it".
      const still = e.timeStamp - g.t > 80
      const vx = still ? 0 : g.vx
      const vy = still ? 0 : g.vy
      const box = isle.getBoundingClientRect()
      const aimX = box.left + box.width / 2 + vx * THROW
      const aimY = box.top + box.height / 2 + vy * THROW
      const corner: Corner = `${aimY > window.innerHeight / 2 ? 'b' : 't'}${aimX > window.innerWidth / 2 ? 'r' : 'l'}`
      opts.onCorner(corner)
      saveCorner(corner)

      // The anchor just moved to the new corner of the island: start from where that corner is on screen.
      const end = pointOf(corner)
      let x = corner[1] === 'r' ? box.right : box.left
      let y = corner[0] === 'b' ? box.bottom : box.top
      let sx = vx
      let sy = vy
      stage.style.translate = `${x}px ${y}px`
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        stage.style.translate = ''
        opts.onHold(false)
        return
      }

      const STIFFNESS = 240
      const DAMPING = 27
      let last = performance.now()
      const frame = (now: number) => {
        // Fixed small steps, so a dropped frame can't make the spring jump.
        let left = Math.min(0.05, (now - last) / 1000)
        last = now
        while (left > 0) {
          const dt = Math.min(left, 1 / 240)
          sx += (STIFFNESS * (end.x - x) - DAMPING * sx) * dt
          sy += (STIFFNESS * (end.y - y) - DAMPING * sy) * dt
          x += sx * dt
          y += sy * dt
          left -= dt
        }
        if (Math.hypot(end.x - x, end.y - y) < 0.3 && Math.hypot(sx, sy) < 6) {
          stage.style.translate = ''
          opts.onHold(false)
          return
        }
        stage.style.translate = `${x}px ${y}px`
        raf.current = requestAnimationFrame(frame)
      }
      raf.current = requestAnimationFrame(frame)
    },
    [opts]
  )

  return { onPointerDown, onPointerMove, onPointerUp: settle, onPointerCancel: settle, onLostPointerCapture: settle }
}
