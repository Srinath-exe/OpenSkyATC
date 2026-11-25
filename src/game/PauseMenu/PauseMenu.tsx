'use client'
/* Pause menu (UX 04 §2.1, §10 "pause-*", §G12 pause-confirm-*): Esc with nothing selected. The sim is paused while it is open. */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import styles from './PauseMenu.module.css'
import { Icon } from '@/design'
import { sim, useSim, formatSimClock } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'
import { openReport } from '../Report/Report'

type Confirm = 'restart' | 'quit' | null

export function PauseMenu() {
  const shell = useShell()
  const router = useRouter()
  const open = !!shell.open.pause
  const icao = useSim((s) => s.icao)
  const time = useSim((s) => Math.floor(s.time()))
  const score = useSim((s) => s.score())
  const counts = useSim((s) => s.counts())
  const [confirm, setConfirm] = React.useState<Confirm>(null)
  /** The menu paused a running sim (so closing it resumes). */
  const pausedByMenu = React.useRef(false)
  /** A sub-overlay (settings / runway config / stats) was opened from the menu: keep the pause and come back afterwards. */
  const detour = React.useRef(false)

  // Pause on open; resume on close only if the menu itself paused the sim and we are not detouring into a sub-overlay.
  React.useEffect(() => {
    if (!open) return
    if (!detour.current) pausedByMenu.current = !sim.paused
    detour.current = false
    if (!sim.paused) sim.setPaused(true)
    setConfirm(null)
    return () => { if (!detour.current && pausedByMenu.current && sim.paused) { sim.setPaused(false); pausedByMenu.current = false } }
  }, [open])

  const subOpen = !!(shell.open.settings || shell.open.runwayConfig || shell.open.stats)
  // Back from a sub-overlay: reopen the menu (still paused) instead of leaving the player on a silently paused shift.
  React.useEffect(() => {
    if (open || !detour.current || subOpen) return
    shell.show('pause')
  }, [open, subOpen, shell])

  const close = React.useCallback(() => shell.hide('pause'), [shell])
  const openFromMenu = (o: 'runwayConfig' | 'settings' | 'stats') => { detour.current = true; close(); shell.show(o) }
  const restart = () => { pausedByMenu.current = false; close(); void sim.restart() }
  const quit = () => { pausedByMenu.current = false; close(); sim.stop(); router.push('/start') }

  // Esc resumes; focus starts on Resume
  const resumeRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => resumeRef.current?.focus(), 30)
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (confirm) setConfirm(null); else close() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.clearTimeout(t); window.removeEventListener('keydown', onKey, true) }
  }, [open, confirm, close])
  if (!open) return null

  const rows: Array<{ icon: string; title: string; sub: string; on: () => void; id: string; danger?: boolean }> = [
    { icon: 'rotate-ccw', title: 'Restart', sub: 'Same airport and runways, new traffic', on: () => setConfirm('restart'), id: 'pause-restart' },
    { icon: 'plane-takeoff', title: 'Runways', sub: 'Runways in use and who may use them', on: () => openFromMenu('runwayConfig'), id: 'pause-runways' },
    { icon: 'settings-2', title: 'Settings', sub: 'Sound, voice, display', on: () => openFromMenu('settings'), id: 'pause-settings' },
    { icon: 'gauge', title: 'Shift stats', sub: 'Score, movements, incidents', on: () => openFromMenu('stats'), id: 'pause-tracks' },
    { icon: 'circle-alert', title: 'Report a problem', sub: 'The last radio calls go with it', on: () => { close(); openReport() }, id: 'pause-report' },
    { icon: 'house', title: 'Quit to start', sub: 'Ends the shift', on: () => setConfirm('quit'), id: 'pause-quit', danger: true },
  ]
  return (
    <div className={styles.scrim} onMouseDown={(ev) => { if (ev.target === ev.currentTarget) close() }}>
      <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="pause-title" data-testid="pause-menu">
        <header className={styles.head}>
          <h2 id="pause-title">Paused</h2>
          <dl className={styles.meta}>
            <div><dt>Airport</dt><dd>{icao}</dd></div>
            <div><dt>Clock</dt><dd>{formatSimClock(time)}</dd></div>
            <div><dt>Traffic</dt><dd>{counts.total}</dd></div>
            <div><dt>Score</dt><dd>{score}</dd></div>
          </dl>
        </header>
        {confirm ? (
          <div className={styles.confirm} role="group" aria-label={confirm === 'restart' ? 'Confirm restart' : 'Confirm quit'} data-testid={`pause-confirm-${confirm}`}>
            <p>{confirm === 'restart' ? 'Restart the shift with fresh traffic? This shift is saved in your history.' : 'Quit to the start screen? This shift is saved in your history.'}</p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.ghost} onClick={() => setConfirm(null)} data-testid="pause-confirm-no">Back</button>
              <button type="button" className={styles.danger} onClick={confirm === 'restart' ? restart : quit} data-testid="pause-confirm-yes" autoFocus>{confirm === 'restart' ? 'Restart' : 'Quit'}</button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.resumeWrap}>
              <button ref={resumeRef} type="button" className={styles.resume} onClick={close} data-testid="pause-resume">
                <Icon name="play" size={18} /><span>Resume shift</span><kbd>Esc</kbd>
              </button>
            </div>
            <TrafficLimit />
            <ul className={styles.rows} role="menu">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" role="menuitem" className={styles.row} data-danger={r.danger || undefined} onClick={r.on} data-testid={r.id}>
                    <span className={styles.rowIcon}><Icon name={r.icon as never} size={17} /></span>
                    <span className={styles.rowText}><b>{r.title}</b><small>{r.sub}</small></span>
                    <span className={styles.chev} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <nav className={styles.legal} aria-label="Legal">{[['Privacy', '/privacy'], ['Terms', '/terms'], ['Credits', '/credits'], ['Contact', '/contact']].map(([t, h]) => <a key={h} href={h} target="_blank" rel="noopener">{t}</a>)}</nav>
          </>
        )}
      </section>
    </div>
  )
}

/** How many aircraft at once: a quick limit the spawner respects (the far right is no limit). */
const LIMIT_MAX = 24
function TrafficLimit() {
  const limit = useSim((s) => s.trafficLimit)
  const now = useSim((s) => s.engine?.aircraft.filter((a) => a.phase !== 'arrived' && a.phase !== 'departed').length ?? 0)
  const v = limit ?? LIMIT_MAX
  return (
    <div className={styles.traffic} data-testid="pause-traffic">
      <div className={styles.trafficHead}>
        <label htmlFor="pause-traffic-range">Traffic at once</label>
        <b>{limit == null ? 'No limit' : `Up to ${limit}`}</b>
      </div>
      <input id="pause-traffic-range" className={styles.range} type="range" min={2} max={LIMIT_MAX} step={1} value={v}
        style={{ ['--p' as string]: `${((v - 2) / (LIMIT_MAX - 2)) * 100}%` }}
        onChange={(ev) => { const n = Number(ev.target.value); sim.setTrafficLimit(n >= LIMIT_MAX ? null : n) }}
        aria-valuetext={limit == null ? 'No limit' : `${limit} aircraft`} data-testid="pause-traffic-range" />
      <p className={styles.trafficNote}>{now} moving now. New flights wait while you are at the limit; nothing already flying is removed.</p>
    </div>
  )
}

