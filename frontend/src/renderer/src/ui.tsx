/** The small pieces every screen of the app uses. */

/** A small square per agent, tinted so a glance tells who's who. */
export function Who({ name, size = 20 }: { name: string; size?: number }) {
  const hue = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 360
  return (
    <span className="who" style={{ width: size, height: size, background: `hsl(${hue} 32% 26%)`, color: `hsl(${hue} 60% 80%)` }} aria-hidden>
      {name[0]}
    </span>
  )
}

/** Everyone on a job, side by side. */
export const Crew = ({ names }: { names: string[] }) => (
  <span className="crew">
    {names.slice(0, 5).map((n) => (
      <Who key={n} name={n} />
    ))}
  </span>
)

export const Spinner = () => <span className="spin" aria-hidden />

export const Icon = ({ d }: { d: string }) => (
  <svg className="ico" viewBox="0 0 16 16" aria-hidden>
    <path d={d} />
  </svg>
)

export const I = {
  plus: 'M8 3v10M3 8h10',
  team: 'M6 7a2.3 2.3 0 100-4.6A2.3 2.3 0 006 7zM1.8 13.5c.4-2.6 2.2-4 4.2-4s3.8 1.4 4.2 4M10.5 7a2 2 0 000-4M12 9.7c1.2.5 2 1.8 2.2 3.8',
  bell: 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14a1.6 1.6 0 003 0',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  search: 'M7 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zM10.5 10.5L13.5 13.5',
  folder: 'M2 4.5h4.3L8 6h6v7H2z',
  branch: 'M5 3.5v9M5 8.5c0-2 6-1 6-4.5M5 12.5a1.3 1.3 0 100 .1M5 3.5a1.3 1.3 0 100 .1M11 4a1.3 1.3 0 100 .1',
  chevron: 'M6 4l4 4-4 4',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3L7 13',
  sun: 'M8 11a3 3 0 100-6 3 3 0 000 6zM8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1',
  screen: 'M2.5 3.5h11v7.5h-11zM6 13.5h4',
  calendar: 'M3 3.5h10v9.5H3zM3 6.5h10M6 2v3M10 2v3',
  note: 'M4 2.5h8v11H4zM6.5 6h3M6.5 8.5h3',
  camera: 'M2.5 5h2.7l1-1.5h3.6l1 1.5h2.7v7.5h-11zM8 10.7a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z',
  download: 'M8 2.5v7M5 7l3 3 3-3M3 13h10',
  mute: 'M3 6.2v3.6h2.2l3.3 2.7v-9L5.2 6.2zM11 6.2l3 3.6M14 6.2l-3 3.6',
  flow: 'M3 3h4v3.5H3zM9 9.5h4V13H9zM5 6.5V9a2 2 0 002 2h2',
  play: 'M5 3.5v9l7.5-4.5z',
  person: 'M8 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3.5 13.5c.4-2.8 2.3-4.2 4.5-4.2s4.1 1.4 4.5 4.2',
  fork: 'M8 13V8.5M8 8.5C8 6 4.5 6.5 4.5 3M8 8.5C8 6 11.5 6.5 11.5 3'
}
