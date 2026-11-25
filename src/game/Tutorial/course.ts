/*
  The course: the whole tutorial as one sequence on the live SFO map, for someone who has never heard a controller.
  ~10 minutes. First the airport (the camera flies to each thing as it is named), then the radio (how words and numbers
  are said), then the job itself: one Lufthansa 747 from its stand to the sky, then an arrival brought down from the
  radar. Tour steps are read-and-next; mission steps are the coach's chapters (lessons.ts), played live.
*/
import type { SimEngine } from '@/lib/sim/engine'
import type { XY } from '@/lib/sim/projection'
import { COURSE_CS, routePreview, type Cue } from './lessons'

export type Section = 'airport' | 'radio' | 'ground' | 'tower' | 'approach'
export const SECTIONS: Array<{ id: Section; title: string }> = [
  { id: 'airport', title: 'The airport' },
  { id: 'radio', title: 'The radio' },
  { id: 'ground', title: 'Ground' },
  { id: 'tower', title: 'Tower' },
  { id: 'approach', title: 'Approach' },
]

export type Visual = 'journey' | 'compass' | 'plan' | 'taxiways' | 'words' | 'numbers' | 'anatomy' | 'controls' | 'finish'
export interface Step {
  id: string
  sec: Section
  title: string
  /** Short lines, shown one by one (tour), or the mission's one-line brief. */
  body: string[]
  visual?: Visual
  /** What the map shows: camera and highlights, built from the live airport. */
  cues?: (e: SimEngine) => Cue[]
  /** A live mission: the coach's chapter id. */
  mission?: string
  fresh?: boolean
  /** Point at a part of the screen (the bubble sits on it). */
  point?: 'cmd'
  /** Where on the map the bubble points (default: where the camera goes, else the middle of the screen). */
  anchor?: (e: SimEngine) => XY | null
}

// ---------------------------------------------------------------------------------------------------------------------
// the airport, from the engine
// ---------------------------------------------------------------------------------------------------------------------
const RAD = Math.PI / 180
function endsOf(e: SimEngine, end: string): { a: XY; b: XY; hdg: number } | null {
  const r = e.runwayByEnd(end); if (!r) return null
  const a = e.nodeXY(r.end.nodeId), b = e.nodeXY(r.other.nodeId); if (!a || !b) return null
  return { a, b, hdg: r.end.trueHdg }
}
const mid = (p: XY, q: XY, t = 0.5): XY => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
/** Camera yaw that looks along a true heading (the map turns so the heading points up the screen). */
const look = (hdg: number) => -hdg * RAD
function centre(e: SimEngine): XY {
  const pts = e.air.runways.flatMap((r) => r.ends.map((x) => e.nodeXY(x.nodeId)).filter(Boolean) as XY[])
  if (!pts.length) return { x: 0, y: 0 }
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length }
}
/** A runway lit from end to end, with each end's number on the ground. */
function runway(e: SimEngine, end: string, color: string, labels: [string, string] | null = null): Cue[] {
  const g = endsOf(e, end); if (!g) return []
  const r = e.runwayByEnd(end)!
  const out: Cue[] = [{ kind: 'route', id: `rw-${end}`, pts: [g.a, g.b], legs: [], color }]
  const [la, lb] = labels ?? [r.end.name, r.other.name]
  if (la) out.push({ kind: 'mark', id: `rwa-${end}`, at: mid(g.a, g.b, 0.04), label: la, tone: 'info' })
  if (lb) out.push({ kind: 'mark', id: `rwb-${end}`, at: mid(g.a, g.b, 0.96), label: lb, tone: 'info' })
  return out
}
const ac = (e: SimEngine) => e.find(COURSE_CS)
const at = (e: SimEngine): XY => { const a = ac(e); return a ? { x: a.pos.x, y: a.pos.y } : centre(e) }
/** The 747's way to its runway (what "taxi to runway 01R" will give it). */
function route(e: SimEngine) { const a = ac(e); return a ? routePreview(e, a, '01R') : null }
function pointAlong(pts: XY[], cum: number[], s: number): XY {
  let i = 1; while (i < pts.length - 1 && cum[i] < s) i++
  const L = cum[i] - cum[i - 1] || 1, t = Math.max(0, Math.min(1, (s - cum[i - 1]) / L))
  return mid(pts[i - 1], pts[i], t)
}
/** The taxiway names on the 747's route, in order (for the bubble). */
export function routeNames(e: SimEngine): string[] { return (route(e)?.legs ?? []).map((l) => l.name).filter((n, i, a) => n && a.indexOf(n) === i) }

// ---------------------------------------------------------------------------------------------------------------------
// the steps
// ---------------------------------------------------------------------------------------------------------------------
export const STEPS: Step[] = [
  // ── the airport: the camera does the showing, the bubble sits on the thing named ──
  {
    id: 'welcome', sec: 'airport', title: "You're the controller",
    body: ['This is San Francisco airport.', 'Planes move only when you tell them to.', "Let's send a 747 into the sky."],
    visual: 'journey',
    // close and tilted on the 747 at its gate, looking out over the field: the 3D world is the first thing you see
    cues: (e) => { const p = at(e), c = centre(e); return [{ kind: 'camera', at: mid(p, c, 0.18), dist: 950, pitch: 0.4, yaw: look(Math.atan2(c.x - p.x, c.y - p.y) / RAD), ms: 2400 }] },
  },
  {
    id: 'runways', sec: 'airport', title: 'Runways',
    body: ['Four runways, in two crossing pairs.', 'Green ones: take off.', 'Blue ones: land.'],
    visual: 'plan',
    cues: (e) => [{ kind: 'clear' }, { kind: 'camera', at: centre(e), dist: 5600, pitch: 1.15, yaw: 0, ms: 2600 }, ...runway(e, '01L', '#3bea7a', ['', '']), ...runway(e, '01R', '#3bea7a', ['Take off', '']), ...runway(e, '28L', '#5aa8ff', ['', '']), ...runway(e, '28R', '#5aa8ff', ['Land', ''])],
  },
  {
    id: 'numbers', sec: 'airport', title: 'A runway is named by its direction',
    body: ['This one points 280° on the compass.', 'Drop the last zero: runway 28.', 'Two side by side: 28L (left), 28R (right).'],
    visual: 'compass',
    cues: (e) => { const g = endsOf(e, '28L'), h = endsOf(e, '28R'); return [{ kind: 'clear' }, ...runway(e, '28L', '#ffd34a', ['28L', '']), ...runway(e, '28R', '#ffd34a', ['28R', '']), ...(g && h ? [{ kind: 'camera' as const, at: mid(mid(g.a, h.a), mid(g.b, h.b), 0.1), dist: 2400, pitch: 0.5, yaw: look(g.hdg), ms: 2600 }] : [])] },
  },
  {
    id: 'taxiways', sec: 'airport', title: 'Taxiways: the roads',
    body: ['Planes drive to the runway on taxiways.', 'Each has a name: a letter, maybe a number.', "A route is a list of names. Here's the 747's."],
    visual: 'taxiways',
    anchor: (e) => at(e),
    cues: (e) => {
      const pv = route(e); if (!pv) return [{ kind: 'clear' }]
      const P = pv.path, marks: Cue[] = []
      const seen = new Set<string>()
      for (const l of pv.legs) { if (!l.name || seen.has(l.name) || l.s1 - l.s0 < 60) continue; seen.add(l.name); marks.push({ kind: 'mark', id: `tw-${l.name}`, at: pointAlong(P.pts, P.cum, (l.s0 + l.s1) / 2), label: l.name, tone: 'info' }) }
      return [{ kind: 'clear' }, { kind: 'route', id: 'route', pts: P.pts, legs: [], color: '#3bea7a' }, ...marks, { kind: 'camera', at: pointAlong(P.pts, P.cum, P.total * 0.5), dist: Math.max(1400, P.total * 0.75), pitch: 1.0, yaw: -0.3, ms: 2600 }]
    },
  },
  {
    id: 'holds', sec: 'airport', title: 'Hold lines: stop here',
    body: ['Every runway has a stop line before it.', 'Planes wait there until you clear them across.'],
    cues: (e) => {
      const pv = route(e); if (!pv) return [{ kind: 'clear' }]
      const P = pv.path, holds = (P.holds ?? []).filter((h) => !h.isDepartureEntry)
      const h = holds[0]; const p = h ? pointAlong(P.pts, P.cum, h.at) : pointAlong(P.pts, P.cum, P.total)
      return [{ kind: 'clear' }, { kind: 'route', id: 'route', pts: P.pts, legs: [], color: '#3bea7a' }, ...runway(e, '01L', '#ff4a3a', ['', '']), { kind: 'mark', id: 'hold', at: p, label: `Runway ${h?.runway ?? '01L'} ahead`, tone: 'stop' }, { kind: 'camera', at: p, dist: 700, pitch: 0.6, yaw: -0.5, ms: 2600 }]
    },
  },
  // ── the radio ──
  {
    id: 'words', sec: 'radio', title: 'The words',
    body: ['A few fixed phrases. This is all you need today.'],
    visual: 'words',
    cues: (e) => [{ kind: 'clear' }, { kind: 'camera', at: centre(e), dist: 4200, pitch: 0.7, yaw: 0.5, ms: 5000 }],
  },
  {
    id: 'digits', sec: 'radio', title: 'Letters and numbers',
    body: ['Letters are said as words: M is “Mike”.', 'Numbers go digit by digit: 455 is “four five five”.'],
    visual: 'numbers',
  },
  {
    id: 'anatomy', sec: 'radio', title: 'Every call: who, what, where',
    body: ['The pilot repeats it back, so you know it was heard.'],
    visual: 'anatomy',
  },
  {
    id: 'controls', sec: 'radio', title: 'Your radio',
    body: ['Click the green call to send it.', 'Or type it here and press Enter.', 'Or hold Space and say it.'],
    point: 'cmd',
  },
  // ── ground: one aircraft, gate to runway (the bubble rides on the aircraft) ──
  { id: 'm-push', sec: 'ground', title: 'Pushback', body: ['A tug pushes it back from the gate.'], mission: 'g-push', fresh: true },
  { id: 'm-taxi', sec: 'ground', title: 'Taxi', body: ['Give it the way to runway 01R.'], mission: 'g-taxi' },
  { id: 'm-stop', sec: 'ground', title: 'Stop and go', body: ['Stop it any time, then let it carry on.'], mission: 'g-stop' },
  { id: 'm-cross', sec: 'ground', title: 'Cross a runway', body: ['A 737 takes off on 01L. Wait, then let ours cross.'], mission: 'g-cross' },
  { id: 'm-handoff', sec: 'ground', title: 'Hand off', body: ["Ground's done. Pass it to the tower."], mission: 'g-handoff' },
  // ── tower ──
  { id: 'm-depart', sec: 'tower', title: 'Takeoff', body: ["You're the tower now. Line it up, then clear it."], mission: 't-follow' },
  { id: 'm-land', sec: 'tower', title: 'Landing', body: ['An Airbus is on final for 28L.', 'Land it, turn it off, bring it to its gate.'], mission: 't-land' },
  // ── approach ──
  { id: 'm-vectors', sec: 'approach', title: 'Steer on the radar', body: ['Heading, altitude, speed: three numbers.'], mission: 'a-vectors' },
  { id: 'm-ils', sec: 'approach', title: 'Onto the ILS', body: ["Point it at the runway's beam. It flies itself in."], mission: 'a-ils' },
  // ── done ──
  {
    id: 'finish', sec: 'approach', title: "You're cleared",
    body: ["That's the whole job.", 'A real shift: the same calls, more planes.'],
    visual: 'finish',
    cues: (e) => [{ kind: 'clear' }, { kind: 'camera', at: centre(e), dist: 3200, pitch: 0.45, yaw: -0.9, ms: 4200 }],
  },
]

export const firstOf = (sec: Section) => STEPS.findIndex((s) => s.sec === sec)
