'use client'
/* The runway button beside the clock: which ends departures and arrivals use. One tap applies. Ends that work opposite ways are
   never both in use, and each side (departures, arrivals) always keeps at least one. */
import * as React from 'react'
import { sim, useSim } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'
import s from './RunwayPicker.module.css'

const ICON = <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 21 9.5 3h5L17 21z" /><path d="M12 6v2.5M12 11v2.5M12 16v2.5" /></svg>
interface Row { name: string; ref: string; dep: boolean; arr: boolean; head: number; cross: number; open: boolean; status: string; hdg: number }

export function RunwayPicker() {
  const shell = useShell()
  const [open, setOpen] = React.useState(false)
  const [why, setWhy] = React.useState('')
  const wrap = React.useRef<HTMLDivElement>(null)
  const rows = useSim((st) => (st.engine ? st.runways().map((r) => ({ name: r.name, ref: r.ref, dep: r.activeDep, arr: r.activeArr, head: Math.round(r.windHeadKt), cross: Math.round(Math.abs(r.windCrossKt)), open: r.status === 'open', status: r.status, hdg: r.headingTrue })) : []) as Row[])
  const wind = useSim((st) => { try { const w = st.engine?.wx(); return w ? { dir: w.windDirTrue, kts: Math.round(w.windKt) } : null } catch { return null } })
  const mag = useSim((st) => st.engine?.magVar ?? 0)
  React.useEffect(() => {
    if (!open) return
    setWhy('')
    const down = (ev: PointerEvent) => { if (!wrap.current?.contains(ev.target as Node)) setOpen(false) }
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true) }
  }, [open])
  const apply = (dep: string[], arr: string[]) => {
    if (!dep.length) { setWhy('Departures need at least one runway.'); return }
    if (!arr.length) { setWhy('Arrivals need at least one runway.'); return }
    setWhy(''); sim.setActiveRunways(dep, arr)
  }
  const toggle = (r: Row, role: 'dep' | 'arr') => {
    const on = !r[role], opposite = (q: Row) => Math.abs(((q.hdg - r.hdg + 540) % 360) - 180) > 150
    // opening an end shuts every end that works the other way, its own strip's and the parallel ones': nobody flies head-on
    const keep = (k: 'dep' | 'arr') => rows.filter((q) => q[k] && !(on && opposite(q))).map((q) => q.name)
    let dep = keep('dep'), arr = keep('arr')
    if (role === 'dep') dep = on ? [...dep, r.name] : dep.filter((n) => n !== r.name); else arr = on ? [...arr, r.name] : arr.filter((n) => n !== r.name)
    // the last end of a side moves over with it instead of leaving that side with none
    if (on && !dep.length) dep = [r.name]; if (on && !arr.length) arr = [r.name]
    apply([...new Set(dep)], [...new Set(arr)])
  }
  const intoWind = () => {
    const best = [...rows].filter((r) => r.open).sort((a, b) => b.head - a.head)[0]; if (!best) return
    const same = rows.filter((r) => r.open && Math.abs(((r.hdg - best.hdg + 540) % 360) - 180) < 15).map((r) => r.name); apply(same, same)
  }
  const strips = [...new Set(rows.map((r) => r.ref))].map((ref) => rows.filter((r) => r.ref === ref).sort((a, b) => b.head - a.head))
  const list = (k: 'dep' | 'arr') => rows.filter((r) => r[k]).map((r) => r.name).join(' ')
  return (
    <div ref={wrap} className={s.wrap}>
      <button type="button" className={s.btn} data-on={open || undefined} aria-expanded={open} aria-haspopup="dialog" aria-label="Runways in use" title={`Runways in use: departures ${list('dep') || 'none'}, arrivals ${list('arr') || 'none'}`} onClick={() => setOpen((v) => !v)} data-testid="runway-picker">{ICON}</button>
      {open ? (
        <div className={s.pop} role="dialog" aria-label="Runways in use" data-testid="runway-picker-panel">
          <header className={s.head}><b>Runways in use</b>{wind ? <span><i style={{ transform: `rotate(${wind.dir + 180}deg)` }}>↑</i>{String(Math.round(((wind.dir - mag) % 360 + 360) % 360)).padStart(3, '0')}° {wind.kts} kt</span> : null}<button type="button" onClick={intoWind} data-testid="runway-into-wind">Into the wind</button></header>
          <div className={s.cols}><span>Runway</span><span>Wind</span><span>Departures</span><span>Arrivals</span></div>
          {strips.map((ends) => (
            <div key={ends[0]?.ref} className={s.strip}>
              {ends.map((r) => (
                <div key={r.name} className={s.row} data-use={r.dep || r.arr || undefined}>
                  <b>{r.name}</b>
                  <span data-tail={r.head < -5 || undefined}>{r.open ? `${r.head >= 0 ? 'head' : 'tail'} ${Math.abs(r.head)}` : r.status}<small>cross {r.cross}</small></span>
                  <button type="button" className={s.tog} data-on={r.dep || undefined} aria-pressed={r.dep} disabled={!r.open} onClick={() => toggle(r, 'dep')} aria-label={`Departures from ${r.name}`} data-testid={`rp-${r.name}-dep`}>{r.dep ? 'On' : 'Off'}</button>
                  <button type="button" className={s.tog} data-on={r.arr || undefined} data-kind="arr" aria-pressed={r.arr} disabled={!r.open} onClick={() => toggle(r, 'arr')} aria-label={`Arrivals to ${r.name}`} data-testid={`rp-${r.name}-arr`}>{r.arr ? 'On' : 'Off'}</button>
                </div>
              ))}
            </div>
          ))}
          <footer className={s.foot}>{why ? <em>{why}</em> : <span>Applies at once. Cleared flights keep theirs.</span>}<button type="button" onClick={() => { setOpen(false); shell.show('runwayConfig') }}>Aircraft sizes</button></footer>
        </div>
      ) : null}
    </div>
  )
}
