'use client'
/*
  The flight board (left) and the flight card (right): the game's traffic as flights rather than strips. No
  instruction buttons: calls are spoken or typed. The board splits departures and arrivals; each row has the picture,
  where it is going or coming from, its time and whether it is on time. The card is the selected flight in full:
  route, schedule, stand / runway / type, and its own radio history.
*/
import * as React from 'react'
import { sim, useSim } from '@/game/hooks/useSimSelector'
import { useAircraftThumb } from '@/components/atc/aircraftThumb'
import type { AircraftState } from '@/lib/sim/types'
import { routeOf, timesOf, clockOf, stageLabel, stageTone, requestOf } from './flightInfo'
import { keyLabel, useKey } from '../keybindings'
import { nextCall, isMine } from './nextCall'
import { airMindOf } from '@/lib/sim/airmind'
import { spokenLine } from '@/lib/sim/dispatch'
import type { PlayerPosition } from '@/lib/sim/types'
import b from './Board.module.css'

function Thumb({ a, className }: { a: AircraftState; className?: string }) {
  const u = useAircraftThumb(a.perf.icaoCode, a.callsign)
  return <span className={`${b.thumb} ${className ?? ''}`}>{u ? <img src={u} alt="" /> : <i className={b.thumbPh} />}</span>
}
const useHome = () => { const icao = useSim((s) => s.icao ?? ''); const name = useSim((s) => s.airspace?.name ?? s.engine?.airportName ?? ''); return { icao, name } }
// gone from the board once done: a departure that has left, an arrival parked at its stand
const shown = (a: AircraftState) => a.phase !== 'departed' && a.phase !== 'arrived' && !(a.plan.kind === 'arrival' && a.phase === 'parked') && (a.plan.kind === 'departure' || a.plan.kind === 'arrival')

/** An arrival still in the air: runway, miles to the threshold and time to touchdown (at its present ground speed). */
export function finalOf(a: AircraftState): { rwy: string; nm: number; sec: number } | null {
  const e = sim.engine; const rwy = a.assignedRunway ?? a.plan.runway
  if (!e || !rwy || a.plan.kind !== 'arrival' || a.altitude < 20) return null
  const nm = e.distToThresholdNM(a, rwy); if (nm == null) return null
  return { rwy, nm, sec: nm / Math.max(60, a.speed) * 3600 }
}
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
const goTo = (a: AircraftState) => { sim.select(a.id); sim.centerOn(a.id) }   // the camera flies to it

function Row({ a, now, sel }: { a: AircraftState; now: number; sel: boolean }) {
  const home = useHome()
  const r = routeOf(a, home.icao, home.name), t = timesOf(a), req = requestOf(a), fin = finalOf(a)
  const landed = a.plan.kind === 'arrival' && !fin
  const mid = req ?? (fin ? `${fin.rwy} · ${fin.nm.toFixed(1)} NM out` : landed ? `Landed · stand ${a.plan.gateRef ?? a.reservedStand ?? '—'}` : r.dep ? `to ${r.toCity}` : `from ${r.fromCity}`)
  return (
    <button type="button" className={b.row} data-sel={sel || undefined} data-req={req ? true : undefined} onClick={() => goTo(a)}
      onPointerEnter={() => sim.hover(a.id)} onPointerLeave={() => sim.hover(null)} data-testid={`board-${a.callsign}`} title={`Go to ${a.callsign}`}>
      <Thumb a={a} className={b.rowImg} />
      <span className={b.rowMid}><b>{a.callsign}</b><span>{mid}</span></span>
      {fin ? (
        <span className={b.rowEnd} data-soon={fin.sec < 120 || undefined}><b className={b.mono}>{mmss(fin.sec)}</b><span className={b.toLand}>to land</span></span>
      ) : (
        <span className={b.rowEnd}><b className={b.mono}>{clockOf(t.actual ?? t.est, now)}</b><span data-tone={t.tone}>{t.tone === 'ok' ? 'On time' : t.tone === 'late' ? `Delayed ${t.lateMin}m` : `Early ${-t.lateMin}m`}</span></span>
      )}
    </button>
  )
}

export function FlightBoard() {
  const now = useSim((s) => Math.floor(s.time()))
  const selectedId = useSim((s) => s.selectedId)
  const list = useSim((s) => s.engine?.aircraft.filter(shown) ?? [])
  void now
  const byTime = (x: AircraftState, y: AircraftState) => { const p = timesOf(x), q = timesOf(y); return (p.actual ?? p.est) - (q.actual ?? q.est) }
  const position = useSim((s) => s.position)
  // Tower (and ground): your departures until they go to departure control, and the arrivals handed to you (on final,
  // then on the ground) - the ones you can no longer see from the field, with how far out and how long to touchdown.
  // Approach: only the arrivals, the ones still yours (not yet handed to the tower).
  const field = (a: AircraftState) => a.onFrequency === 'tower' || a.onFrequency === 'ground'
  const app = position === 'approach'
  const deps = app ? [] : list.filter((a) => a.plan.kind === 'departure' && field(a)).sort(byTime)
  const soonest = (x: AircraftState, y: AircraftState) => (finalOf(x)?.sec ?? -1) - (finalOf(y)?.sec ?? -1) || byTime(x, y)
  const arrs = list.filter((a) => a.plan.kind === 'arrival' && (app ? !field(a) : field(a))).sort(soonest)
  const group = (title: string, xs: AircraftState[], empty: string) => (
    <section className={b.group}>
      <p className={b.h}>{title}<em>{xs.length}</em></p>
      {xs.length ? <div className={b.rows}>{xs.map((a) => <Row key={a.id} a={a} now={now} sel={a.id === selectedId} />)}</div> : <p className={b.empty}>{empty}</p>}
    </section>
  )
  return (
    <div className={b.board} data-testid="flight-board">
      {app ? null : group('Departures', deps, 'No departures right now')}
      {group(app ? 'Arrivals' : 'Arrivals · handed to you', arrs, app ? 'No arrivals right now' : 'None on final yet')}
    </div>
  )
}

export function FlightCard() {
  const a = useSim((s) => (s.selectedId != null ? s.engine?.byId(s.selectedId) ?? null : null))
  const now = useSim((s) => Math.floor(s.time()))
  const stage = useSim((s) => { const x = s.selectedId != null ? s.engine?.byId(s.selectedId) : null; return x ? s.stageOf(x) : null })
  const radio = useSim((s) => s.radio)
  const home = useHome()
  const logRef = React.useRef<HTMLDivElement>(null)
  const lines = React.useMemo(() => (a ? radio.filter((l) => l.callsign === a.callsign && (l.who === 'ATC' || l.who === 'PILOT' || l.who === 'AI')).slice(-6) : []), [radio, a])
  React.useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines.length, a?.id])
  if (!a || !stage) return null
  const r = routeOf(a, home.icao, home.name), t = timesOf(a)
  const stand = a.plan.gateRef ?? a.reservedStand ?? '—', rwy = sim.engine?.runwayGiven(a) === false ? 'Not given' : a.assignedRunway ?? a.plan.runway ?? '—'
  const air = a.altitude > 50, fin = finalOf(a)
  return (
    <div className={b.card} data-testid="flight-card">
      <div className={b.head}>
        <div><h3>{a.callsign}</h3><p>{a.airline} · {a.perf.modelName}</p></div>
        <span className={b.stage} data-tone={stageTone(stage)}>{stageLabel(stage)}</span>
        {sim.engine && airMindOf(sim.engine).isMinimumFuel(a) ? <span className={b.stage} data-tone="warn" data-testid="min-fuel">Min fuel</span> : null}
      </div>
      {/* only what is acted on: the time shows when it is off */}
      {t.tone !== 'ok' ? <p className={b.off} data-tone={t.tone}>{Math.abs(t.lateMin)} min {t.tone === 'late' ? 'late' : 'early'}</p> : null}
      <Thumb a={a} className={b.hero} />
      <div className={b.route}>
        <div><b>{r.from}</b><span>{r.fromCity}</span></div>
        <i className={b.line}><span>✈</span></i>
        <div data-r><b>{r.to}</b><span>{r.toCity}</span></div>
      </div>
      {fin ? (
        <div className={b.final} data-soon={fin.sec < 120 || undefined}>
          <div><small>Runway</small><b>{fin.rwy}</b></div>
          <div><small>Out</small><b className={b.mono}>{fin.nm.toFixed(1)} NM</b></div>
          <div><small>To touchdown</small><b className={b.mono}>{mmss(fin.sec)}</b></div>
        </div>
      ) : null}
      <NextCallBox a={a} />
      {fin ? null : (
        <div className={b.facts} data-n={air ? 3 : 2}>
          {air ? <><div><small>Altitude</small><b>{Math.round(a.altitude / 100) * 100} ft</b></div><div><small>Speed</small><b>{Math.round(a.speed)} kt</b></div></>
            : <div><small>Stand</small><b>{stand}</b></div>}
          <div><small>Runway</small><b>{rwy}</b></div>
        </div>
      )}
      <div className={b.log} ref={logRef}>
        {lines.length ? lines.map((l) => (
          <p key={l.key} data-atc={l.who === 'ATC' || undefined}>
            <small className={b.mono}>{clockOf(l.at, now)}</small>
            <span><b>{l.who === 'ATC' ? 'You' : l.who === 'AI' ? `AI ${l.aiPos ?? ''}`.trim() : 'Pilot'}</b>{l.text}</span>
          </p>
        )) : <p className={b.empty}>Nothing said yet.</p>}
      </div>
    </div>
  )
}

/** Put a line in the call field (the player still sends it, or says it). */
function fillCall(text: string) {
  const el = document.querySelector<HTMLInputElement>('[data-testid="cmd-input"]'); if (!el) return
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true })); el.focus()
}

/** The call the AI would give this flight next: as typed, and as said on the radio (hold Space and read it out). */
function NextCallBox({ a }: { a: AircraftState }) {
  const position = useSim((s) => s.position) as PlayerPosition
  const talk = keyLabel(useKey('ptt'))
  const e = sim.engine
  if (!e) return null
  const n = nextCall(e, a)
  const mine = isMine(a, position)
  const seat = position === 'approach' ? 'Tower' : 'Approach'
  if ('wait' in n) return <div className={b.next} data-wait data-testid="next-call"><p className={b.nextH}>What to say next</p><p className={b.nextWait}>Nothing yet. {n.wait}</p></div>
  const said = spokenLine(e as never, n.cmd)
  return (
    <div className={b.next} data-testid="next-call" data-ai={mine ? undefined : true}>
      <p className={b.nextH}>What to say next <em>{mine ? `hold ${talk} and say it` : `the AI works this one (${seat})`}</em></p>
      {said ? <p className={b.nextSay}>“{said}”</p> : null}
      <button type="button" className={b.nextCmd} onClick={() => fillCall(n.cmd)} title="Put it in the call field">
        <span className={b.mono}>{n.cmd}</span><i>type it</i>
      </button>
      <p className={b.nextWhy}>{n.why}</p>
    </div>
  )
}

