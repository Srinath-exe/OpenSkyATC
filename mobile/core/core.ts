/*
  OpenATC phone core: the web game's simulation, command parser, AI controllers and pilots, unchanged, run headless in
  the app's embedded JS engine. The app draws everything natively (Mapbox, 3D models, Flutter UI) from what this
  returns; there is no WebView.

  The app owns the clock: it calls ATC.tick(dt) every frame (or a few times a second from a background isolate),
  reads ATC.frame() for the map and ATC.ui() for the panels, and sends what the player says or types to ATC.heard()
  / ATC.command(). Every call returns a JSON string (one crossing of the bridge per call).

  Built by mobile/core/build.mjs into mobile/assets/core/core.js.
*/
import { storageDump, storageLoad, provided, advanceTimers } from './shims'
import * as course from './course'
import * as radar from './radar'
import { drain as drainSound } from './sound'
import { sim } from '../../src/components/atc/simStore'
import type { RadioLine, StartConfig } from '../../src/components/atc/simStore'
import { fromEngine } from '../../src/lib/sim/dispatch'
import { spokenLine } from '../../src/lib/sim/dispatch'
import { registerVerifier, type L1Proposal } from '../../src/lib/voice/understand'
import { understandHeard, biasNames } from '../../src/lib/voice/asr-nbest'
import { voiceContext, positionOf } from '../../src/lib/voice/context'
import { applyFix, explainCall, type Fault } from '../../src/lib/sim/explain'
import { freshPose } from '../../src/components/atc/viewPose'
import { taxiLabels } from 'phone:taxiLabels'
import { routeOf, timesOf, stageLabel, stageTone, requestOf } from '../../src/game/Board/flightInfo'
import { nextCall, isMine } from '../../src/game/Board/nextCall'
import { preferredEnds } from '../../src/lib/sim/weather'
import { AIRPORT_BY_ICAO, runwaysOf } from '../../src/app/_lib/airports'
import { getPerformance } from '../../src/lib/sim/aircraftDB'
import { AIRLINE_BY_ICAO } from '../../src/lib/sim/airlines'
import type { AircraftState, PlayerPosition } from '../../src/lib/sim/types'
import { keep } from './osmAirport'
import { keep as keepNames } from './naming'
import { keep as keepLimits } from './taxiLimits'

const FT = 0.3048
const r5 = (x: number) => Math.round(x * 1e5) / 1e5
const r7 = (x: number) => Math.round(x * 1e7) / 1e7
const r1 = (x: number) => Math.round(x * 10) / 10
const json = (o: unknown) => JSON.stringify(o)
const eng = () => sim.engine
const ll = (x: number, y: number): [number, number] => { const q = eng()!.proj.toLngLat(x, y); return [r7(q.lng), r7(q.lat)] }

// ── lifecycle ────────────────────────────────────────────────────────────────

let bootState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
let bootError: string | null = null

/** The start page's opening set-up (start/page.tsx initialCfg): the ends the field's prevailing wind puts in use, and each
 *  end's aircraft sizes by runway length. Without it the store opens every end, both ways at once. */
function opening(icao: string): { ends: string[]; weights: NonNullable<StartConfig['weights']> } {
  const meta = AIRPORT_BY_ICAO[icao], rws = runwaysOf(icao)
  const size = (ft: number) => (ft >= 10000 ? ['L', 'M', 'H', 'S'] : ft >= 7500 ? ['L', 'M', 'H'] : ft >= 5500 ? ['L', 'M'] : ['L'])
  return {
    ends: meta ? preferredEnds(rws.flatMap((r) => r.ends), meta.wind.dir, meta.wind.kts) : [],
    weights: Object.fromEntries(rws.flatMap((r) => r.ends.map((x) => [x.name, size(r.lengthFt)]))) as NonNullable<StartConfig['weights']>,
  }
}
let lastBoot: StartConfig | null = null
function boot(cfgJson: string): string {
  const cfg = JSON.parse(cfgJson) as StartConfig & { settings?: Record<string, unknown> }
  bootState = 'loading'; bootError = null
  lastBoot = { ...cfg, settings: undefined } as StartConfig
  if (cfg.settings) sim.updateSettings(cfg.settings as never, { silent: true })
  const open = cfg.ends || cfg.spawn === 'none' ? { ends: cfg.ends, weights: cfg.weights } : opening((cfg.icao ?? 'KSFO').toUpperCase())
  sim.load({ ...open, icao: cfg.icao ?? 'KSFO', position: cfg.position ?? 'tower', difficulty: cfg.difficulty, seed: cfg.seed, spawn: cfg.spawn, naming: cfg.naming })
    .then(() => { if (sim.loadError || !sim.engine) { bootState = 'error'; bootError = sim.loadError ?? 'no engine' } else bootState = 'ready' })
    .catch((e: unknown) => { bootState = 'error'; bootError = String(e) })
  return status()
}
function status(): string { return json({ state: bootState, error: bootError, icao: sim.icao }) }

/** Advance by `dt` real seconds (the store applies rate and pause, as the web page's frame loop does). */
function tick(dt: number): void {
  const store = sim as unknown as { pruneToasts?: () => void }
  try { store.pruneToasts?.() } catch { /* private in TS, there in JS */ }
  advanceTimers(Math.min(dt, 0.25) * 1000)   // the tutorial coach's tick and delays (real time, as in the browser)
  if (sim.paused || !sim.engine) return
  sim.step(Math.min(dt, 0.25) * sim.rate * sim.boost)
}

// ── map frame ────────────────────────────────────────────────────────────────

let staticParkedKey = ''
/**
 * What the map draws now: every aircraft (position, attitude, model), the ground routes, the selection.
 * Parked airframes come with `parked` only when they changed (they are static between departures).
 */
function frame(): string {
  const e = eng(); if (!e) return json({ t: 0, ac: [] })
  const sel = sim.selectedId
  const ac = e.aircraft.filter((a) => a.phase !== 'departed').map((a) => {
    const v = freshPose(e as never, a as never)   // run on by the part of a step not taken yet, as the web draws it
    const [lng, lat] = ll(v.x, v.y)
    return {
      id: a.id, cs: a.callsign, lng, lat, alt: r1(v.alt * FT), hdg: r1(v.hdg), pitch: r1(a.pitch ?? 0), bank: r1(a.bank ?? 0),
      type: a.perf.icaoCode, al: a.callsign.slice(0, 3), len: r1(a.perf.lengthMeters), span: r1(a.perf.wingspanMeters ?? a.perf.lengthMeters),
      gnd: a.altitude < 5 ? 1 : 0, ph: a.phase, rwy: a.plan.kind === 'arrival' ? (a.assignedRunway ?? a.plan.runway ?? null) : null, kt: Math.round(a.speed ?? 0), fl: Math.round(a.altitude / 100),
      mine: isMine(a, sim.position as PlayerPosition) ? 1 : 0, req: a.requests.some((q) => q.answeredAt == null) ? 1 : 0,
      emg: a.emergency ? 1 : 0, sel: a.id === sel ? 1 : 0,
    }
  })
  const routes: Array<{ id: number; kind: string; sel: number; c: Array<[number, number]> }> = []
  for (const a of e.aircraft) {
    const p = a.path; if (!p || p.pts.length < 2 || (p.kind !== 'taxi' && p.kind !== 'pushback')) continue
    const done = Math.max(0, Math.min(p.total, a.distAlong ?? 0))
    const end = p.holdAt != null && p.holdAt > done + 1 ? p.holdAt : p.total
    if (end - done < 5) continue
    const at = (d: number) => { let j = 1; while (j < p.pts.length - 1 && p.cum[j] <= d) j++; const k = (d - p.cum[j - 1]) / ((p.cum[j] - p.cum[j - 1]) || 1); return { j, xy: { x: p.pts[j - 1].x + (p.pts[j].x - p.pts[j - 1].x) * k, y: p.pts[j - 1].y + (p.pts[j].y - p.pts[j - 1].y) * k } } }
    const s0 = at(done), s1 = at(end)
    const pts = [s0.xy, ...p.pts.slice(s0.j, s1.j), s1.xy]
    routes.push({ id: a.id, kind: p.kind === 'pushback' ? 'push' : a.plan.kind === 'arrival' ? 'stand' : 'runway', sel: a.id === sel ? 1 : 0, c: pts.map((q) => ll(q.x, q.y)) })
  }
  const out: Record<string, unknown> = { t: r1(e.time), wall: sim.sessionStartedAt + e.time * 1000, sel, paused: sim.paused, rate: sim.rate, ac, routes }
  const pk = e.parked.map((p) => p.id).join(',')
  if (pk !== staticParkedKey) {
    staticParkedKey = pk
    out.parked = e.parked.map((p) => { const [lng, lat] = ll(p.pos.x, p.pos.y); const perf = getPerformance(p.type); return { id: p.id, cs: p.callsign, lng, lat, hdg: r1(p.heading), type: p.type, al: p.callsign.slice(0, 3), len: r1(perf?.lengthMeters ?? 38) } })
  }
  return json(out)
}

/** The airport as GeoJSON for the map (once per session): taxiway lines and names, stands, runway names, holds. */
function airport(): string {
  const e = eng(); if (!e) return json(null)
  const air = e.air
  type F = { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }
  const fc = (features: F[]) => ({ type: 'FeatureCollection', features })
  const taxi: F[] = [], lead: F[] = [], stands: F[] = [], rwyLabels: F[] = [], holds: F[] = [], twyLabels: F[] = [], rwyc: F[] = []
  const seen = new Set<string>()
  for (const [id, n] of air.nodes) {
    for (const ed of n.edges) {
      const key = id < ed.to ? `${id}|${ed.to}` : `${ed.to}|${id}`
      if (seen.has(key)) continue; seen.add(key)
      const m = air.nodes.get(ed.to); if (!m || ed.type === 'runway') continue
      const f: F = { type: 'Feature', properties: { name: ed.taxiway ?? '' }, geometry: { type: 'LineString', coordinates: [[r7(n.lng), r7(n.lat)], [r7(m.lng), r7(m.lat)]] } }
      if (ed.leadIn) lead.push(f); else taxi.push(f)
    }
  }
  // the web's own label places: every exit just off the runway, then about every 350 m, in the clear
  for (const l of taxiLabels(air)) twyLabels.push({ type: 'Feature', properties: { name: l.name, near: l.near }, geometry: { type: 'Point', coordinates: [r7(l.at[0]), r7(l.at[1])] } })
  for (const st of air.stands) stands.push({ type: 'Feature', properties: { ref: st.ref }, geometry: { type: 'Point', coordinates: [r7(st.lng), r7(st.lat)] } })
  for (const rw of air.runways) {
    for (const en of rw.ends) rwyLabels.push({ type: 'Feature', properties: { name: en.name }, geometry: { type: 'Point', coordinates: [r7(en.lng), r7(en.lat)] } })
    const [a, b] = rw.ends; rwyc.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[r7(a.lng), r7(a.lat)], [r7(b.lng), r7(b.lat)]] } })
  }
  for (const h of air.holdingPositions) { const n = air.nodes.get(h.nodeId); if (n) holds.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [r7(n.lng), r7(n.lat)] } }) }
  const c = e.proj.toLngLat(0, 0)
  // up the longest runway, the way it is in use now (the opening camera)
  const long = [...air.runways].map((rw) => { const [a, b] = rw.ends; return { rw, m: Math.hypot((a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180), (a.lat - b.lat) * 111320) } }).sort((x, y) => y.m - x.m)[0]?.rw
  const used = e.runwayStates().find((r) => long?.ends.some((x) => x.name === r.name) && (r.activeArr || r.activeDep)) ?? e.runwayStates().find((r) => long?.ends.some((x) => x.name === r.name))
  return json({ bearing: Math.round(used?.headingTrue ?? 0), naming: e.naming, center: [r5(c.lng), r5(c.lat)], name: sim.airspace?.name ?? e.airportName ?? sim.icao, taxi: fc(taxi), lead: fc(lead), stands: fc(stands), rwyLabels: fc(rwyLabels), holds: fc(holds), twyLabels: fc(twyLabels), rwyc: fc(rwyc) })
}

// ── panels ───────────────────────────────────────────────────────────────────

const shown = (a: AircraftState) => a.phase !== 'departed' && a.phase !== 'arrived' && !(a.plan.kind === 'arrival' && a.phase === 'parked') && (a.plan.kind === 'departure' || a.plan.kind === 'arrival')
function finalOf(a: AircraftState): { rwy: string; nm: number; sec: number } | null {
  const e = eng(); const rwy = a.assignedRunway ?? a.plan.runway
  if (!e || !rwy || a.plan.kind !== 'arrival' || a.altitude < 20) return null
  const nm = e.distToThresholdNM(a, rwy); if (nm == null) return null
  return { rwy, nm, sec: nm / Math.max(60, a.speed) * 3600 }
}
const homeName = () => sim.airspace?.name ?? eng()?.airportName ?? ''
const airlineName = (a: AircraftState) => a.airline || AIRLINE_BY_ICAO[a.callsign.slice(0, 3)]?.name || ''

function row(a: AircraftState) {
  const r = routeOf(a, sim.icao, homeName()), t = timesOf(a), req = requestOf(a), fin = finalOf(a)
  const landed = a.plan.kind === 'arrival' && !fin
  const mid = req ?? (fin ? `${fin.rwy} · ${fin.nm.toFixed(1)} NM out` : landed ? `Landed · stand ${a.plan.gateRef ?? a.reservedStand ?? '—'}` : r.dep ? `to ${r.toCity}` : `from ${r.fromCity}`)
  return {
    id: a.id, cs: a.callsign, type: a.perf.icaoCode, al: a.callsign.slice(0, 3), mid, req: req ? 1 : 0,
    sched: t.sched, est: t.actual ?? t.est, tone: t.tone, late: t.lateMin, fin: fin ? { rwy: fin.rwy, nm: r1(fin.nm), sec: Math.round(fin.sec) } : null,
    mine: isMine(a, sim.position as PlayerPosition) ? 1 : 0, emg: a.emergency ? 1 : 0,
  }
}

function board() {
  const e = eng(); if (!e) return { deps: [], arrs: [] }
  const list = e.aircraft.filter(shown)
  const byTime = (x: AircraftState, y: AircraftState) => { const p = timesOf(x), q = timesOf(y); return (p.actual ?? p.est) - (q.actual ?? q.est) }
  const field = (a: AircraftState) => a.onFrequency === 'tower' || a.onFrequency === 'ground'
  const app = sim.position === 'approach'
  const deps = app ? [] : list.filter((a) => a.plan.kind === 'departure' && field(a)).sort(byTime)
  const soonest = (x: AircraftState, y: AircraftState) => (finalOf(x)?.sec ?? -1) - (finalOf(y)?.sec ?? -1) || byTime(x, y)
  const arrs = list.filter((a) => a.plan.kind === 'arrival' && (app ? !field(a) : field(a))).sort(soonest)
  return { deps: deps.map(row), arrs: arrs.map(row) }
}

const lineOut = (l: RadioLine) => ({ k: l.key, who: l.who, ai: l.aiPos ?? null, text: l.text, at: Math.round(l.at), cs: l.callsign ?? null, pos: l.position ?? null, st: l.status ?? null })

function card() {
  const e = eng(); const id = sim.selectedId
  const a = id != null && e ? e.byId(id) : null
  if (!a || !e) return null
  const stage = sim.stageOf(a), r = routeOf(a, sim.icao, homeName()), t = timesOf(a), fin = finalOf(a)
  const n = nextCall(e, a)
  const next = 'wait' in n ? { wait: n.wait } : { cmd: n.cmd, why: n.why, say: spokenLine(e as never, n.cmd) }
  const lines = sim.radio.filter((l) => l.callsign === a.callsign && (l.who === 'ATC' || l.who === 'PILOT' || l.who === 'AI')).slice(-30).map(lineOut)
  return {
    id: a.id, cs: a.callsign, airline: airlineName(a), model: a.perf.modelName, type: a.perf.icaoCode, al: a.callsign.slice(0, 3),
    stage: stageLabel(stage), tone: stageTone(stage), route: r, sched: t.sched, est: t.actual ?? t.est, actual: t.actual, label: t.label, timeTone: t.tone, late: t.lateMin,
    fin: fin ? { rwy: fin.rwy, nm: r1(fin.nm), sec: Math.round(fin.sec) } : null,
    alt: Math.round(a.altitude / 100) * 100, kt: Math.round(a.speed), air: a.altitude > 50 ? 1 : 0,
    stand: a.plan.gateRef ?? a.reservedStand ?? '—', rwy: e.runwayGiven(a) === false ? 'Not given' : a.assignedRunway ?? a.plan.runway ?? '—', squawk: a.squawk ?? '—',
    mine: isMine(a, sim.position as PlayerPosition) ? 1 : 0, next, lines,
  }
}

let radioSeen = 0
/** The panels' state: board, selected flight, new radio lines since the last call, toasts, alerts, score, sounds. */
function ui(): string {
  const e = eng()
  const fresh = sim.radio.filter((l) => l.key > radioSeen); if (fresh.length) radioSeen = fresh[fresh.length - 1].key
  const st = e?.stats
  return json({
    t: e ? r1(e.time) : 0, wall: e ? sim.sessionStartedAt + e.time * 1000 : Date.now(), position: sim.position, paused: sim.paused, rate: sim.rate,
    board: board(), card: card(), radio: fresh.map(lineOut),
    toasts: sim.toasts.map((x) => ({ k: x.key, kind: x.kind, text: x.text })),
    alerts: sim.alerts().map((x) => ({ id: x.id, sev: x.severity, title: x.title, detail: x.detail, who: x.subjects })),
    score: st ? { points: Math.round(st.points), skill: Math.round(st.score), movements: st.movements, deps: st.departures, arrs: st.arrivals } : null,
    names: e?.naming ?? 'real', inUse: inUse(), high: sim.highScore, counts: e ? sim.counts() : null, sounds: drainSound(),
  })
}

/** Every radio line kept (the full log, when the panel opens). */
function radio(): string { return json(sim.radio.slice(-200).map(lineOut)) }

// ── input ────────────────────────────────────────────────────────────────────

/** What exactly is wrong with a call that did not work, part by part (explain.ts), each with the call put right. */
function faults(text: string, r: { code?: string; reason?: string | null }): Array<{ bad: string; title: string; text: string; fixes: Array<{ label: string; call: string }> }> {
  const e = eng(); if (!e || !text) return []
  let xs: Fault[] = []
  try { xs = explainCall(text, fromEngine(e, { lastCallsign: sim.lastCallsign, position: sim.position }), e, r) } catch { /* nothing to add */ }
  return xs.slice(0, 2).map((f) => ({ bad: f.bad, title: f.title, text: f.text, fixes: f.fixes.slice(0, 3).map((x) => ({ label: x, call: applyFix(text, f, x) })) }))
}
function run(text: string): { ok: boolean; error: string | null; callsign: string | null; faults: ReturnType<typeof faults> } {
  const r = sim.command(text) as { ok: boolean; code?: string; reason?: string | null; error?: string; callsign?: string }
  return { ok: r.ok, error: r.ok ? null : r.error ?? r.reason ?? r.code ?? null, callsign: r.callsign ?? null, faults: r.ok ? [] : faults(text, r) }
}
/** A typed line (the command bar). */
function command(text: string): string { return json(run(text)) }

// ── runways in use (NavBar/RunwayPicker.tsx: the same rules) ──
type Rw = { name: string; ref: string; dep: boolean; arr: boolean; head: number; cross: number; open: boolean; status: string; hdg: number }
const rwRows = (): Rw[] => (eng() ? sim.runways().map((r) => ({ name: r.name, ref: r.ref, dep: r.activeDep, arr: r.activeArr, head: Math.round(r.windHeadKt), cross: Math.round(Math.abs(r.windCrossKt)), open: r.status === 'open', status: r.status, hdg: r.headingTrue })) : [])
const inUse = () => { const x = rwRows(); return { dep: x.filter((r) => r.dep).map((r) => r.name), arr: x.filter((r) => r.arr).map((r) => r.name) } }
function runways(): string {
  const e = eng(); let wind: { dir: number; kts: number } | null = null
  try { const w = e?.wx(); if (w) wind = { dir: Math.round(((w.windDirTrue - (e?.magVar ?? 0)) % 360 + 360) % 360), kts: Math.round(w.windKt) } } catch { /* no weather yet */ }
  return json({ rows: rwRows(), wind })
}
function applyRunways(dep: string[], arr: string[]): string {
  if (!dep.length) return json({ why: 'Departures need at least one runway.' })
  if (!arr.length) return json({ why: 'Arrivals need at least one runway.' })
  sim.setActiveRunways([...new Set(dep)], [...new Set(arr)])
  return json({ why: '' })
}
function toggleRunway(name: string, role: 'dep' | 'arr'): string {
  const rows = rwRows(), r = rows.find((q) => q.name === name); if (!r || !r.open) return json({ why: r ? `${name} is ${r.status}.` : '' })
  const on = !r[role], opposite = (q: Rw) => Math.abs(((q.hdg - r.hdg + 540) % 360) - 180) > 150
  // opening an end shuts every end that works the other way, its own strip's and the parallel ones'
  const keep = (k: 'dep' | 'arr') => rows.filter((q) => q[k] && !(on && opposite(q))).map((q) => q.name)
  let dep = keep('dep'), arr = keep('arr')
  if (role === 'dep') dep = on ? [...dep, name] : dep.filter((n) => n !== name); else arr = on ? [...arr, name] : arr.filter((n) => n !== name)
  // the last end of a side moves over with it instead of leaving that side with none
  if (on && !dep.length) dep = [name]; if (on && !arr.length) arr = [name]
  return applyRunways(dep, arr)
}
function runwaysIntoWind(): string {
  const rows = rwRows(), best = rows.filter((r) => r.open).sort((a, b) => b.head - a.head)[0]; if (!best) return json({ why: '' })
  const same = rows.filter((r) => r.open && Math.abs(((r.hdg - best.hdg + 540) % 360) - 180) < 15).map((r) => r.name)
  return applyRunways(same, same)
}

/** What the recogniser heard (its n best guesses): repaired against the aircraft on frequency, parsed by the rules,
 *  and sent when understood. Same chain as the web page (understandHeard), without the S1 model for now. */
/** The command model runs in the app (lib/src/s1, its own thread): the core asks, the app answers. */
let l1Url: string | null = null, l1Seq = 0
const l1Ask: { id: number; said: string; callsigns: string[]; ctx: string }[] = []
const l1Wait = new Map<number, { ok: (p: L1Proposal) => void; err: (e: Error) => void }>()
const l1 = { complete: (said: string, callsigns: string[], ctx?: string) => new Promise<L1Proposal>((ok, err) => { const id = ++l1Seq; l1Wait.set(id, { ok, err }); l1Ask.push({ id, said, callsigns, ctx: ctx ?? '' }) }) }
function l1Enable(url: string | null, gateJson?: string | null): void { l1Url = url; if (url && gateJson) registerVerifier(url, JSON.parse(gateJson)) }
function l1Take(): string { return json(l1Ask.splice(0)) }
function l1Answer(id: number, answer: string | null): void {
  const w = l1Wait.get(id); if (!w) return; l1Wait.delete(id)
  if (answer == null) w.err(new Error('command model unavailable')); else { const p = JSON.parse(answer); for (const k of Object.keys(p.signals ?? {})) if (p.signals[k] == null) p.signals[k] = NaN; w.ok({ ...p, model: l1Url ?? undefined }) }
}
/** The game state as the model reads it (prefilled while the player talks). */
function l1Ctx(): string { const e = eng(); return e ? voiceContext(e, positionOf(sim.position) ?? 'tower').text : '' }

async function heard(altsJson: string): Promise<string> {
  const e = eng(); if (!e) return json({ ok: false, error: 'No game running' })
  const alts = JSON.parse(altsJson) as string[]
  const state = voiceContext(e, positionOf(sim.position) ?? 'tower')
  const pctx = fromEngine(e, { lastCallsign: sim.lastCallsign, position: sim.position })
  const u = await understandHeard(alts, pctx, e.magVar ?? 0, l1Url ? l1 : null, state)
  if (u.ok) { const r = run(u.line); return json({ ok: r.ok, sent: true, line: u.line, heard: u.heard, error: r.error, faults: r.faults }) }
  const said = u.line || u.transcript || u.heard || alts[0] || ''
  return json({ ok: false, sent: false, line: u.line, heard: u.heard, transcript: u.transcript, error: u.error, sayAgain: u.sayAgain, faults: u.line ? [] : faults(said, { reason: u.error }) })
}

/** Spoken names to bias the recogniser with ("united two one four"), your own frequency first. */
function hints(): string {
  const e = eng(); if (!e) return json([])
  return json(biasNames(voiceContext(e, positionOf(sim.position) ?? 'tower')))
}

/** The calls the AI would make for every flight of yours (practice lines for the microphone test). */
function practice(): string {
  const e = eng(); if (!e) return json([])
  const out: Array<{ cmd: string; say: string | null }> = []
  for (const a of e.aircraft) { const n = nextCall(e, a); if (!('wait' in n)) out.push({ cmd: n.cmd, say: spokenLine(e as never, n.cmd) }) }
  return json(out.slice(0, 6))
}

function select(id: number | null): void { sim.select(id) }
function setPosition(p: string): void { sim.setPosition(p as never) }
function setPaused(b: boolean): void { sim.setPaused(b) }
function setRate(r: number): void { sim.setRate((r === 2 || r === 4 ? r : 1) as 1 | 2 | 4) }
function settings(patchJson?: string): string {
  if (patchJson) sim.updateSettings(JSON.parse(patchJson), { silent: true })
  return json(sim.settings)
}
function setSectorAi(on: boolean): void {
  // the player's seat worked by the AI too: the airfield is ground and tower together, as the web game's sectorPatch
  const patch = sim.position === 'approach' ? { autoApproach: on, autoMode: true } : { autoGround: on, autoTower: on, autoMode: true }
  sim.updateSettings(patch as never, { silent: true })
}
/** A new shift: the same airport and options, the seat the player is in now, new traffic. Poll status() as for boot. */
function restart(): string {
  return boot(JSON.stringify({ ...(lastBoot ?? {}), position: sim.position, seed: undefined }))
}

const api = {
  provide: (path: string, text: string) => { provided.set(path, text) },
  storage: () => json(storageDump()),
  restore: (s: string) => { try { storageLoad(JSON.parse(s)) } catch { /* fresh */ } },
  /** The airport graph as built, for mobile/core/bake-airport.mjs (what the app ships as /maps/baked/ICAO.json). */
  bakeNext: () => { keep.on = keepNames.on = keepLimits.on = true }, bakedAirport: () => keep.json ?? 'null', bakedNames: () => keepNames.json ?? 'null', bakedLimits: () => keepLimits.json ?? 'null',
  l1Enable, l1Take, l1Answer, l1Ctx,
  runways, toggleRunway, runwaysIntoWind,
  boot, status, tick, frame, airport, ui, radio, command, heard, hints, practice,
  select, setPosition, setPaused, setRate, settings, setSectorAi, restart,
  /** The approach scope (core/radar.ts): the chart once, the traffic every update. */
  radarScene: radar.scene, radarFrame: radar.frame,
  /** The tutorial (core/course.ts): boot with { spawn: 'none', position: 'ground', ends: [...] } first. */
  course: {
    start: (fromStart?: boolean) => course.start(!!fromStart), state: course.state, next: course.next, back: course.back, goTo: course.goTo,
    goSection: course.goSection, send: course.send, freePlay: course.freePlay, restart: course.restartCourse, dismissNote: course.dismissNote, stop: course.stop,
  },
  version: '1',
}
;(globalThis as unknown as { ATC: typeof api }).ATC = api
export default api
