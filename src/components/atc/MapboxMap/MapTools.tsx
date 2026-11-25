'use client'
/*
  The map's buttons as one glass column: the time of day (a wheel that opens on hover), zoom, follow / centre,
  labels, reset. One size, one style; a button that is on is filled.
*/
import * as React from 'react'
import s from './MapTools.module.css'

export type TimeMode = 'auto' | 'day' | 'dusk' | 'night'
/** A page that fixes the time of day (the tutorial: dusk). The map uses it instead of the player's choice and does not
 *  store it; the wheel still lets the player change it for the session. */
let forced: TimeMode | null = null
export const forceTimeOfDay = (m: TimeMode | null): void => { forced = m }
export const forcedTimeOfDay = (): TimeMode | null => forced
const svg = (d: React.ReactNode) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
export const ICON: Record<string, React.ReactNode> = {
  auto: svg(<><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>),
  day: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" /></>),
  dusk: svg(<><path d="M17 17a5 5 0 0 0-10 0" /><path d="M12 4v4M4.2 10.2l1.4 1.4M18.4 11.6l1.4-1.4M2 17h2.5M19.5 17H22M3 21h18" /></>),
  night: svg(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />),
  plus: svg(<path d="M12 5v14M5 12h14" />), minus: svg(<path d="M5 12h14" />),
  follow: svg(<><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="7.5" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22" /></>),
  centre: svg(<><circle cx="12" cy="12" r="8" /><path d="M12 8v8M8 12h8" /></>),
  eye: svg(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: svg(<><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>),
  home: svg(<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />),
}
const MODES: Array<{ id: TimeMode; label: string }> = [{ id: 'auto', label: 'Auto' }, { id: 'day', label: 'Day' }, { id: 'dusk', label: 'Dusk' }, { id: 'night', label: 'Night' }]

/** Time of day: one button showing the current choice; hover (or focus) fans the four choices out on an arc to its
 *  left; the one under the pointer grows and shows its name; click picks it. */
export function TimeWheel({ value, onChange }: { value: TimeMode; onChange: (m: TimeMode) => void }) {
  const [open, setOpen] = React.useState(false)
  const [hot, setHot] = React.useState<TimeMode | null>(null)
  const t = React.useRef<number>(0)
  const show = () => { window.clearTimeout(t.current); setOpen(true) }
  const hide = () => { window.clearTimeout(t.current); t.current = window.setTimeout(() => { setOpen(false); setHot(null) }, 220) }
  React.useEffect(() => () => window.clearTimeout(t.current), [])
  const R = 74
  return (
    <div className={s.wheel} data-open={open || undefined} onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} data-testid="world-time">
      {MODES.map((m, i) => {
        // an arc from straight up round to the left of the button (it sits at the map's right edge)
        const ang = (105 + i * 30) * Math.PI / 180
        const x = Math.cos(ang) * R, y = -Math.sin(ang) * R
        const on = m.id === value
        return (
          <button key={m.id} type="button" className={s.spoke} data-on={on || undefined} data-hot={hot === m.id || undefined} aria-label={`Time of day: ${m.label}`} aria-pressed={on}
            style={{ '--x': `${x.toFixed(1)}px`, '--y': `${y.toFixed(1)}px`, '--d': `${i * 30}ms` } as React.CSSProperties}
            tabIndex={open ? 0 : -1} onPointerEnter={() => setHot(m.id)} onPointerLeave={() => setHot((h) => (h === m.id ? null : h))}
            onClick={() => { onChange(m.id); setOpen(false) }} data-testid={`world-time-${m.id}`}>
            {ICON[m.id]}<span className={s.spokeLabel}>{m.label}</span>
          </button>
        )
      })}
      <button type="button" className={s.hub} aria-label={`Time of day: ${MODES.find((m) => m.id === value)?.label}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{ICON[value]}</button>
    </div>
  )
}

export function ToolButton({ icon, label, onClick, on, disabled, testId }: { icon: React.ReactNode; label: string; onClick: () => void; on?: boolean; disabled?: boolean; testId?: string }) {
  return <button type="button" className={s.btn} data-on={on || undefined} disabled={disabled} onClick={onClick} aria-label={label} title={label} aria-pressed={on} data-testid={testId}>{icon}</button>
}
export const ToolGroup = ({ children }: { children: React.ReactNode }) => <div className={s.group}>{children}</div>
export const toolsClass = s.tools
