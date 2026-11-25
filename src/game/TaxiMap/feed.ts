/*
  The taxi map's feed (TaxiMap.tsx, its own window at /taxi): the running game tells every open taxi map what the field
  looks like and where everyone is, over a BroadcastChannel (same browser, nothing leaves the machine). Nothing is sent
  unless a taxi map has asked in the last few seconds.
*/
import { sim } from '@/components/atc/simStore'
import { nextCall } from '@/game/Board/nextCall'
import { viewPose } from '@/components/atc/viewPose'
import type { SimEngine } from '@/lib/sim/engine'
import type { AircraftState } from '@/lib/sim/types'

export const TAXI_CHANNEL = 'skycontrol-taxi-map'
export interface TaxiField {
  t: 'field'; key: string; icao: string; name: string
  /** x1, y1, x2, y2 (metres, y north) per piece; name '' = unnamed; lane = into a stand. */
  taxi: Array<{ p: [number, number, number, number]; n: string; lane: boolean }>
  runways: Array<{ a: [number, number]; b: [number, number]; an: string; bn: string }>
  stands: Array<{ x: number; y: number; h: number; ref: string }>
  buildings: Array<Array<[number, number]>>
  holds: Array<{ x: number; y: number; h: number }>
}
export interface TaxiCraft {
  id: number; cs: string; type: string; len: number; x: number; y: number; h: number; spd: number; alt: number; kind: 'departure' | 'arrival'; phase: string
  status: string; rwy: string; gate: string; dest: string; mine: boolean; moving: boolean
  /** The way it has been given and still has to go, up to the next stop, then what is beyond it. Empty until it is cleared. */
  path: Array<[number, number]>; beyond: Array<[number, number]>
  route: string[]; hold: string; say: string; note: string
}
/** The call being made right now (spoken or typed): who, the taxiways named so far, and the way they give. `named` metres of `pts` are what has been said. */
export interface TaxiCall { id: number | null; line: string; via: string[]; runways: string[]; said: Array<[number, number]>; rest: Array<[number, number]> }
/** One runway end in use: who is on final to it, who is waiting to go from it, and whether it is free. */
export interface TaxiFinal {
  rwy: string; thr: [number, number]; hdg: number; lands: boolean
  arr: Array<{ id: number; cs: string; type: string; nm: number; sec: number; spd: number; cleared: boolean }>
  dep: Array<{ id: number; cs: string; type: string; phase: string; say: string; note: string }>
  tone: 'go' | 'care' | 'stop'; verdict: string; cross: string
}
export interface TaxiNow { t: 'now'; key: string; time: number; paused: boolean; hidden: boolean; sel: number | null; ac: TaxiCraft[]; rate: number; call: TaxiCall | null; finals: TaxiFinal[] }
export type TaxiMsg = TaxiField | TaxiNow | { t: 'hello'; want: string } | { t: 'select'; id: number | null } | { t: 'bye' }

let call: TaxiCall | null = null, callNow: (() => void) | null = null
export function setLiveCall(c: { id: number | null; line: string; via: string[]; runways: string[]; pts: Array<{ x: number; y: number }>; cum: number[]; named: number } | null): void {
  if (!c) { if (call) { call = null; callNow?.() } return }
  const said: Array<[number, number]> = [], rest: Array<[number, number]> = []
  c.pts.forEach((p, i) => { const q: [number, number] = [r1(p.x), r1(p.y)]; if (c.cum[i] <= c.named + 0.5) said.push(q); else { if (!rest.length && said.length) rest.push(said[said.length - 1]); rest.push(q) } })
  call = { id: c.id, line: c.line, via: c.via.map((v) => v.toUpperCase()), runways: c.runways, said, rest }; callNow?.()
}
const r1 = (v: number) => Math.round(v * 10) / 10
function fieldOf(e: SimEngine, key: string): TaxiField {
  const xy = (p: { lat: number; lng: number }) => { const q = e.proj.toXY(p.lat, p.lng); return [r1(q.x), r1(q.y)] as [number, number] }
  const taxi: TaxiField['taxi'] = [], seen = new Set<string>()
  for (const n of e.air.nodes.values()) for (const d of n.edges) {
    if (d.type === 'runway' || d.runway) continue
    const k = n.id < d.to ? `${n.id}|${d.to}` : `${d.to}|${n.id}`; if (seen.has(k)) continue; seen.add(k)
    const o = e.air.nodes.get(d.to); if (!o) continue
    taxi.push({ p: [...xy(n), ...xy(o)] as [number, number, number, number], n: d.taxiway ?? '', lane: !!d.leadIn })
  }
  return {
    t: 'field', key, icao: e.air.icao, name: sim.icao, taxi,
    runways: e.air.runways.map((r) => ({ a: xy(r.ends[0]), b: xy(r.ends[1]), an: r.ends[0].name, bn: r.ends[1].name })),
    stands: (e.air.stands ?? []).map((s) => { const [x, y] = xy(s); return { x, y, h: s.headingIn, ref: s.ref } }),
    buildings: e.air.buildings.filter((b) => b.kind !== 'apron').map((b) => b.polygon.map(xy)),
    holds: e.air.holdingPositions.map((h) => { const [x, y] = xy(h); return { x, y, h: 0 } }),
  }
}
const STATUS: Record<string, string> = { parked: 'At the stand', startup: 'Starting engines', pushback: 'Pushing back', taxi: 'Taxiing', hold_short: 'Holding short', lineup: 'Lined up', takeoff: 'Taking off', climb: 'Climbing', cruise: 'En route', descent: 'Inbound', approach: 'On approach', go_around: 'Going around', landing: 'Landing', rollout: 'Rolling out', arrived: 'Parked', departed: 'Gone' }
function craft(e: SimEngine, a: AircraftState): TaxiCraft {
  const v = viewPose(e, a), p = a.path, ground = a.altitude < 30
  let path: Array<[number, number]> = [], beyond: Array<[number, number]> = [], hold = ''
  if (ground && p && p.pts.length > 1 && (p.kind === 'taxi' || p.kind === 'pushback')) {
    const done = Math.max(0, Math.min(p.total, a.distAlong ?? 0)), stop = p.holdAt != null && p.holdAt > done + 1 ? p.holdAt : p.total
    path = [[r1(v.x), r1(v.y)]]
    for (let i = 0; i < p.pts.length; i++) { const q: [number, number] = [r1(p.pts[i].x), r1(p.pts[i].y)]; if (p.cum[i] > done && p.cum[i] <= stop) path.push(q); else if (p.cum[i] > stop) { if (!beyond.length) beyond.push(path[path.length - 1]); beyond.push(q) } }
    const h = p.holds?.find((x) => x.at > done + 1 && !x.isDepartureEntry && Math.abs(x.at - stop) < 2); if (h) hold = h.runway
  }
  let say = '', note = ''
  try { const n = nextCall(e, a); if ('cmd' in n) { say = n.cmd; note = n.why } else note = n.wait } catch { /* no card for it */ }
  // only what a controller has given: no suggested ways, no runway before it is assigned
  const route = path.length && p?.kind === 'taxi' ? a.plan.taxiRoute ?? [] : []
  return {
    id: a.id, cs: a.callsign, type: a.perf.icaoCode, len: a.perf.lengthMeters, x: r1(v.x), y: r1(v.y), h: Math.round(v.hdg * 10) / 10, spd: Math.round(a.speed), alt: Math.round(a.altitude), kind: a.plan.kind, phase: a.phase,
    status: a.phase === 'hold_short' && a.holdShortRunway ? `Holding short of ${a.holdShortRunway}` : a.phase === 'taxi' && a.speed < 1 ? 'Stopped on the taxiway' : STATUS[a.phase] ?? a.phase,
    rwy: e.runwayGiven(a) ? a.plan.runway ?? a.assignedRunway ?? '' : '', gate: a.reservedStand ?? a.plan.gateRef ?? '', dest: a.plan.kind === 'departure' ? a.plan.dest ?? '' : a.plan.fix ?? '', mine: e.playerWorks(a), moving: a.speed > 1,
    path, beyond, route, hold, say, note,
  }
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
/** The line-up and take-off rules are the flight card's (nextCall.ts): no line-up inside 6.5 NM, no take-off inside 3. */
const LINEUP_NM = 6.5, TAKEOFF_NM = 3
function finalsOf(e: SimEngine): TaxiFinal[] {
  const landing = new Set([...e.arrivalRunwaysInUse()].map((r) => r.toUpperCase())), out: TaxiFinal[] = []
  const inbound = new Map<string, TaxiFinal['arr']>()
  for (const a of e.aircraft) {
    if (a.plan.kind !== 'arrival' || a.altitude < 20 || !['approach', 'landing', 'descent'].includes(a.phase)) continue
    const rwy = (a.assignedRunway ?? a.plan.runway ?? '').toUpperCase(), nm = rwy ? e.distToThresholdNM(a, rwy) : null
    if (nm == null || nm > 16 || (!a.ilsCaptured && a.phase !== 'landing' && nm > 12)) continue
    const l = inbound.get(rwy) ?? []; l.push({ id: a.id, cs: a.callsign, type: a.perf.icaoCode, nm, sec: nm / Math.max(60, a.speed) * 3600, spd: Math.round(a.speed), cleared: a.landingCleared }); inbound.set(rwy, l)
  }
  const waiting = e.aircraft.filter((a) => a.plan.kind === 'departure' && (a.phase === 'lineup' || (a.phase === 'hold_short' && (a.holdShortRunway ?? '').toUpperCase() === (a.plan.runway ?? '').toUpperCase())))
  for (const rs of e.runways) {
    const rwy = rs.name.toUpperCase(), arr = (inbound.get(rwy) ?? []).sort((x, y) => x.nm - y.nm), dep = waiting.filter((a) => (a.plan.runway ?? '').toUpperCase() === rwy)
    if (!landing.has(rwy) && !arr.length && !dep.length) continue
    const thr = e.thresholdXY(rs.name); if (!thr) continue
    const roll = e.rollingDeparture(rs.name), cross = e.crossingTraffic(rs.name), occ = e.runwayOccupant(rs.name), f = arr[0]
    let tone: TaxiFinal['tone'] = 'go', verdict = f ? `Free for ${mmss(f.sec)}, then ${f.cs} lands` : 'Free, nobody on final'
    if (f && f.nm < TAKEOFF_NM) { tone = 'stop'; verdict = `Hold: ${f.cs} lands in ${mmss(f.sec)}` }
    else if (roll) { tone = 'care'; verdict = `${roll} is rolling` }
    else if (cross) { tone = 'stop'; verdict = `${cross} is crossing` }
    else if (occ && !dep.some((d) => d.callsign === occ)) { tone = 'stop'; verdict = `${occ} is on the runway` }
    else if (f && f.nm < LINEUP_NM) { tone = 'care'; verdict = `No line-up: ${f.cs} lands in ${mmss(f.sec)}` }
    // a runway that crosses this one: somebody close in on it matters too
    const meets = e.air.runways.find((r) => r.ref === rs.ref)?.intersects ?? []
    let x: { cs: string; rwy: string; sec: number } | null = null
    for (const [n, l] of inbound) { const r = e.air.runways.find((q) => q.ends.some((v) => v.name === n)); if (r && meets.includes(r.ref)) for (const a of l) if (a.nm < 4 && (!x || a.sec < x.sec)) x = { cs: a.cs, rwy: n, sec: a.sec } }
    out.push({
      rwy, thr: [r1(thr.x), r1(thr.y)], hdg: rs.headingTrue, lands: landing.has(rwy), arr, tone, verdict, cross: x ? `Crossing ${x.rwy}: ${x.cs} lands in ${mmss(x.sec)}` : '',
      dep: dep.map((a) => { let say = '', note = ''; try { const n = nextCall(e, a); if ('cmd' in n) say = n.cmd; else note = n.wait } catch { /* no card */ } return { id: a.id, cs: a.callsign, type: a.perf.icaoCode, phase: a.phase === 'lineup' ? 'Lined up' : 'Holding short', say, note } }),
    })
  }
  return out.sort((a, b) => (b.arr.length + b.dep.length ? 1 : 0) - (a.arr.length + a.dep.length ? 1 : 0) || a.rwy.localeCompare(b.rwy))
}
/** Runs in the game's window for as long as the shell is up. */
export function startTaxiFeed(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  const ch = new BroadcastChannel(TAXI_CHANNEL); let asked = 0, sent = '', stamp = 0, last: unknown = null
  const keyOf = () => { if (sim.engine !== last) { last = sim.engine; stamp++ } return `${sim.icao}#${stamp}#${sim.engine?.naming}#${performance.timeOrigin}` }
  ch.onmessage = (ev: MessageEvent<TaxiMsg>) => {
    const m = ev.data
    if (m.t === 'hello') { asked = performance.now(); const k = keyOf(); if (m.want !== k) sent = '' }
    else if (m.t === 'select') { if (m.id == null || sim.engine?.byId(m.id)) sim.select(m.id) }
  }
  const send = () => {
    const e = sim.engine; if (!e || sim.testMode || performance.now() - asked > 6000) return
    const key = keyOf()
    if (sent !== key) { ch.postMessage(fieldOf(e, key)); sent = key }
    const ac = e.aircraft.filter((a) => a.phase !== 'departed' && a.phase !== 'arrived').map((a) => craft(e, a))
    ch.postMessage({ t: 'now', key, time: e.time, paused: sim.paused, hidden: document.hidden, sel: sim.selectedId, ac, rate: sim.rate, call, finals: finalsOf(e) } satisfies TaxiNow)
  }
  const tick = window.setInterval(send, 120); callNow = send          // a word said shows at once
  const bye = () => ch.postMessage({ t: 'bye' } satisfies TaxiMsg)
  window.addEventListener('pagehide', bye)
  return () => { window.clearInterval(tick); callNow = null; window.removeEventListener('pagehide', bye); bye(); ch.close() }
}
/** Its own window, sized for a second screen (a tab when the browser will not). */
export function openTaxiMap(): void {
  const w = window.open('/taxi', 'skycontrol-taxi', `popup=yes,width=${Math.min(1500, screen.availWidth - 80)},height=${Math.min(950, screen.availHeight - 80)}`)
  if (!w) window.open('/taxi', '_blank'); else w.focus()
}
