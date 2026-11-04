import { useEffect, useRef } from 'react'
import type { FileChange } from '@shared/types'
import { Pet } from './Pet'

/**
 * One file's changes: added lines in green, removed in red, numbers in the gutter. Lines Oggy is
 * talking about light up and the rest fade back; an answer about a line sits right under it.
 */
export function DiffView(props: {
  file: FileChange
  /** Line ranges (in the file as it is now) to light up. */
  focus: { from: number; to: number }[]
  notes: { line: number; text: string }[]
  /** Changes when the view should scroll to what's lit up. */
  scrollKey: string
}) {
  const { file, focus, notes } = props
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // What Oggy is talking about, else the first change.
    const el = box.current?.querySelector('.dx-note, .dx-line.is-focus') ?? box.current?.querySelector('.dx-line.is-add, .dx-line.is-del')
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [props.scrollKey])

  if (file.binary) return <p className="dx-empty">A binary file (an image or similar) changed.</p>
  if (file.status === 'deleted') return <p className="dx-empty">This file was deleted.</p>
  if (!file.hunks?.length) return <p className="dx-empty">Nothing to show yet.</p>

  const lit = (n: number) => focus.some((r) => n >= r.from && n <= r.to)

  return (
    <div ref={box} className={`dx ${focus.length ? 'is-focusing' : ''}`}>
      <div className="dx-lines">
        {file.hunks.map((h, i) => {
          let a = h.oldStart
          let b = h.newStart
          return (
            <div key={i} className="dx-hunk">
              {(i > 0 || h.newStart > 1) && (
                <div className="dx-gap">
                  <span>⋯</span> line {h.newStart}
                </div>
              )}
              {h.lines.map((l, j) => {
                // A removed line sits just before new line `b`; it lights up with the lines around it.
                const n = l.t === '-' ? a : b
                const on = l.t === '-' ? lit(b) || lit(b - 1) : lit(b)
                const note = l.t !== '-' ? notes.find((x) => x.line === b) : undefined
                if (l.t !== '+') a++
                if (l.t !== '-') b++
                return (
                  <div key={j}>
                    <div className={`dx-line ${l.t === '+' ? 'is-add' : l.t === '-' ? 'is-del' : ''} ${on ? 'is-focus' : ''}`}>
                      <span className="dx-n">{n}</span>
                      <span className="dx-s">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
                      <span className="dx-t">{l.text || ' '}</span>
                    </div>
                    {note && (
                      <div className="dx-note">
                        <span className="dx-note-who">
                          <Pet size={14} />
                          Oggy
                        </span>
                        <p>{note.text}</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
        {file.cut ? <div className="dx-gap">+{file.cut} more lines</div> : null}
      </div>
    </div>
  )
}
