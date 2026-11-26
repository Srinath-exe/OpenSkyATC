/*
  The arrival manager: who lands after whom, when, and what each one flies to be there on time. Worked out the way an
  approach unit works (FAA JO 7110.65 5-7 / 5-9, EUROCONTROL's arrival management and Point Merge notes, the VATSIM
  Khaleej and Germany approach manuals): the order is set early and kept; everybody gets a landing time a fixed spacing
  behind the one before; time to lose is lost by speed first, then by a longer way round (the downwind carried on, a
  vector off to the side, the racetrack at the far end), and nobody is turned in before that puts it the spacing behind
  the one ahead. Until it is on the beam an arrival is 1,000 ft above the one before it: the lowest leaves first and
  the rest step down.
  More than four minutes to lose, near its arrival fix and not yet on its way in: it holds there (holds.ts), in a stack
  1,000 ft apart from 8,000 ft up; the one first in the order is lowest and leaves first, once a minute and a half is
  all it has left to lose, and the rest step down. Each is told when to expect further clearance.
  The plan is made once a second whoever works Approach; the AI gives its calls from it, the flight cards show them.

  Runway frame: `x` miles before the threshold along the final course, `d` miles off it on the arrival's own side.
*/
import type { SimEngine } from './engine';
import type { AircraftState } from './types';

const NM = 1852, RAD = Math.PI / 180;
const wrap = (v: number) => ((v % 360) + 540) % 360 - 180;
/** Nearest place the beam is met (NM), the downwind's and the delaying lane's distance from the final course (NM). */
const JOIN = 12, LANE = 5, WIDE = 8, RUN = 3.46;            // RUN: how far out of the join a 30 degree cut starts 2 NM off

export type ArrLeg = 'inbound' | 'downwind' | 'outbound' | 'wide' | 'dogleg' | 'base' | 'final' | 'out' | 'established' | 'hold';
/** A hold: the fix, its level in the stack (rank 0 = lowest, leaves first), when to expect further clearance (sim s). */
export interface ArrHold { fix: string; level: number; rank: number; efc: number }
export interface ArrPlan {
  rwy: string; course: number; side: 1 | -1; x: number; d: number;
  /** Place in the landing order of its runway direction (0 = next), who is before it, and how far behind him it must be (NM). */
  place: number; lead: AircraftState | null; gapNM: number; pathNM: number; leadNM: number;
  /** Seconds it would land ahead of its turn if it were turned in now (what is left to lose). */
  slack: number;
  leg: ArrLeg; hdg: number; level: number; kt: number; clear: boolean; go: boolean;
  hold: ArrHold | null;
}
interface Own { side: 1 | -1; go: boolean; dir: 'out' | 'in'; wide: boolean; rwy: string; seen: number; kt: number; dog: boolean; hold: string | null; efc: number }
/** Holding: in with more than this to lose (s), out (the lowest) with less than this. Bottom of a stack (ft). */
const HOLD_IN_S = 240, HOLD_OUT_S = 90, STACK_BASE_FT = 8000, STACK_TOP_FT = 15000;
interface Book { own: Map<number, Own>; order: number[]; plans: Map<number, ArrPlan>; at: number; swapped: number }
const BOOKS = new WeakMap<SimEngine, Book>();
const book = (e: SimEngine): Book => { let b = BOOKS.get(e); if (!b) { b = { own: new Map(), order: [], plans: new Map(), at: -1, swapped: -1e9 }; BOOKS.set(e, b); } return b; };

/** The end an arrival lands on: its own when that is in use, else the one in use whose final it is nearest to. */
export function arrivalEnd(e: SimEngine, a: AircraftState): string {
  const own = a.assignedRunway ?? a.plan.runway ?? '', on = e.activeEnds('arr').filter(r => r.status === 'open');
  if (!on.length || on.some(r => r.name === own)) return own;
  let best = on[0].name, bd = Infinity;
  for (const r of on) { const t = e.thresholdXY(r.name); if (!t) continue; const c = r.headingTrue * RAD, dd = Math.hypot(a.pos.x - (t.x - Math.sin(c) * 10 * NM), a.pos.y - (t.y - Math.cos(c) * 10 * NM)); if (dd < bd) { bd = dd; best = r.name; } }
  return best;
}
const flying = (a: AircraftState) => a.plan.kind === 'arrival' && a.altitude > 60 && !['rollout', 'taxi', 'parked', 'arrived', 'hold_short'].includes(a.phase);

interface Frame { a: AircraftState; rwy: string; course: number; thr: { x: number; y: number }; x: number; off: number }
function frame(e: SimEngine, a: AircraftState, rwy: string): Frame | null {
  const end = e.runwayByEnd(rwy), thr = e.thresholdXY(rwy); if (!end || !thr) return null;
  const course = end.end.trueHdg, c = course * RAD, dx = a.pos.x - thr.x, dy = a.pos.y - thr.y;
  return { a, rwy, course, thr, x: -(dx * Math.sin(c) + dy * Math.cos(c)) / NM, off: (dx * Math.cos(c) - dy * Math.sin(c)) / NM };
}
const radiusNM = (a: AircraftState) => Math.max(140, a.speed) / 3600 / (Math.max(1, a.perf.turnRateAir) * RAD);

/** The shortest way in from here: miles to fly, and whether it can turn in now (a cut on to the final, or a base leg) or has to go out first. */
function wayIn(f: Frame, side: 1 | -1, go: boolean): { s: number; via: 'final' | 'base' | 'out' } {
  const { a, x, course } = f, d = f.off * side, ad = Math.abs(d), r = radiusNM(a), rel = wrap(a.heading - course) * -side;       // rel: how far the nose points in, towards the final (0 = inbound, 90 = square in, 180 = outbound)
  if (go && x > 5 && ad < 2.2 + r * 0.45 && Math.abs(rel) < 100) return { s: x + 0.27 * ad, via: 'final' };                     // (cutting on to the final)
  const outw = Math.max(0, Math.cos((Math.abs(rel) - 180) * RAD));                                                              // 1 flying outbound, 0 across or inbound
  if (x > 8.5 + 1.73 * ad && (Math.abs(rel) < 110 || ad > 3)) { const t = Math.abs(rel - (ad < 0.6 ? 0 : 27)); return { s: x + 0.27 * ad + (t > 30 ? r * t * RAD * 0.45 : 0), via: 'final' }; }
  const xb = x + r * outw, db = Math.max(0.5, d - r * outw * 0.9), arc = r * 1.57 * outw;
  if (xb > JOIN + RUN - 0.3 && d > 1.6) {
    const F = Math.max(JOIN, xb - RUN - 0.7 * Math.max(0, db - 2)), t = outw > 0.2 ? 0 : Math.abs(rel - 80);
    return { s: arc + Math.hypot(xb - (F + RUN), db - 2) + 4 + F + (t > 40 ? r * (t - 40) * RAD * 0.5 : 0), via: 'base' };
  }
  // out along the downwind first
  const tOut = Math.abs(Math.abs(rel) - 180), turn = tOut > 40 ? r * (tOut - 40) * RAD * 0.6 : 0, start = JOIN + RUN - r;
  const lane = d >= 3.5 ? d : LANE, join = d >= 3.5 && x > -4 ? Math.max(0, d - 9) : Math.hypot(Math.max(0, -1 - x), lane - d);
  return { s: turn + join + Math.max(0, start - Math.max(x, Math.min(-1, x))) - Math.max(0, -1 - x) + r * 1.57 + Math.max(0.5, Math.min(lane, 9) - r * 0.9 - 2) + 4 + JOIN, via: 'out' };
}
/** Seconds to fly the last `s` miles: 160 kt inside eleven, slower inside five. */
function timeFor(s: number, a: AircraftState, headKt: number): number {
  const leg = (from: number, to: number, kt: number) => Math.max(0, Math.min(s, from) - to) / Math.max(90, kt) * 3600;
  const v = Math.max(180, Math.min(a.speed, 220));
  return leg(5, 0, (a.perf.approachSpeed || 140) + 6 - headKt) + leg(11, 5, 164 - headKt) + leg(20, 11, Math.min(v, 182) - headKt * 0.4) + leg(999, 20, v);
}
/** Miles the next one must be behind (the radar minimum with a margin; the wake; more when a departure waits for a gap). */
function gapNM(e: SimEngine, lead: AircraftState, trail: AircraftState, rl: string, rt: string, waits: boolean): number {
  const same = e.sameStrip(rl, rt); if (!same && !e.closeParallel(rl, rt)) return 4.5;
  return Math.max(waits ? 6.8 : 5, e.wakeFinalNM(lead, trail) + 1.4);
}

/** Make the plan for this second. */
export function stepArrivals(e: SimEngine): void {
  const bk = book(e); if (e.time - bk.at < 1 && e.time >= bk.at) return; bk.at = e.time; bk.plans.clear();
  const list: Array<{ f: Frame; o: Own; est: boolean; way: ReturnType<typeof wayIn>; t: number; side: 1 | -1 }> = [];
  for (const a of e.aircraft) {
    if (!flying(a)) continue; const rwy = arrivalEnd(e, a), f = rwy ? frame(e, a, rwy) : null; if (!f) continue;
    let o = bk.own.get(a.id);
    if (!o || e.sameDirection(o.rwy, rwy) === false) { o = { side: f.off >= 0 ? 1 : -1, go: false, dir: f.x > 12 ? 'in' : 'out', wide: false, rwy, seen: e.time, kt: 0, dog: false, hold: null, efc: 0 }; bk.own.set(a.id, o); }
    if (o.rwy !== rwy) o.rwy = rwy;
    o.seen = e.time;
    const est = a.ilsCaptured || a.phase === 'landing';
    if (est) { o.go = true; }
    else if (a.phase === 'go_around' || (a.goAround && f.x < 3)) { o.go = false; o.dir = 'out'; }
    // (the side it is on: it changes sides only well across, and not once it is on its way in)
    // (across the final without a clearance: the other side is its side now, and it comes in from there)
    if (!est && !a.ilsArmed && f.off * o.side < (o.go ? -1.1 : -3.5)) { o.side = f.off >= 0 ? 1 : -1; if (o.go) { o.go = false; o.dir = f.x > 16 ? 'in' : 'out'; } }
    const way = est ? { s: Math.max(0.1, f.x), via: 'final' as const } : wayIn(f, o.side, o.go), head = e.headwindOn(rwy);
    // (no sooner than it can be down: what it still has to lose, then the last ten miles)
    const down = est ? 0 : Math.max(0, a.altitude - 3000) / Math.max(900, a.perf.maxDescentRate * 0.85) * 60 + 25 + timeFor(10, a, head);
    list.push({ f, o, est, way, t: Math.max(timeFor(way.s, a, head), down), side: o.side });
  }
  for (const id of [...bk.own.keys()]) if (bk.own.get(id)!.seen !== e.time) bk.own.delete(id);
  // one order per direction (parallel runways share it)
  const fams: Array<{ course: number; l: typeof list }> = [];
  for (const q of list) { let g = fams.find(k => Math.abs(wrap(k.course - q.f.course)) < 15); if (!g) { g = { course: q.f.course, l: [] }; fams.push(g); } g.l.push(q); }
  bk.order = bk.order.filter(id => bk.own.has(id));
  for (const g of fams) {
    const by = new Map(g.l.map(q => [q.f.a.id, q])), urgent = (q: { f: Frame }) => !!q.f.a.emergency && q.f.a.emergency.status !== 'resolved';
    const fixed = (q: (typeof list)[number]) => q.est || (q.o.go && (q.way.s < 24));
    const order = bk.order.filter(id => by.has(id)).map(id => by.get(id)!);
    // a newcomer takes its place by the time it could land; it goes in front of somebody only when clearly sooner
    for (const q of g.l) if (!order.includes(q)) { let i = order.length; while (i > 0 && !fixed(order[i - 1]) && (urgent(q) && !urgent(order[i - 1]) || q.t + 45 < order[i - 1].t)) i--; order.splice(i, 0, q); }
    // the ones turned in are in the order they come down the final; the rest keep their places, unless one is three minutes sooner
    const inn = order.filter(fixed).sort((p, q) => p.way.s - q.way.s), open = order.filter(q => !fixed(q));
    if (e.time - bk.swapped > 45) for (let i = 1; i < open.length; i++) if ((urgent(open[i]) && !urgent(open[i - 1])) || open[i].t + 170 < open[i - 1].t) { const t = open[i]; open[i] = open[i - 1]; open[i - 1] = t; bk.swapped = e.time; break; }
    const seq = [...inn, ...open]; bk.order = [...bk.order.filter(id => !by.has(id)), ...seq.map(q => q.f.a.id)];
    // landing times, spacing behind spacing
    const waits = new Map<string, boolean>(); const wait = (r: string) => { let v = waits.get(r); if (v == null) { v = e.departureWaits(r); waits.set(r, v); } return v; };
    let prevT = -Infinity;
    seq.forEach((q, i) => {
      const { f, o, way } = q, a = f.a, lead = i ? seq[i - 1] : null, gap = lead ? gapNM(e, lead.f.a, a, lead.f.rwy, f.rwy, wait(f.rwy)) : 0;
      // (behind everybody on its own runway, not only the one next before it: a parallel one in between hides the wake of the one before that)
      let need = lead ? prevT + gap / Math.max(95, 150 - e.headwindOn(f.rwy)) * 3600 : -Infinity;
      for (let k = i - 2; k >= 0 && k >= i - 3; k--) if (e.sameStrip(seq[k].f.rwy, f.rwy) || e.closeParallel(seq[k].f.rwy, f.rwy)) need = Math.max(need, (seq[k] as any).sta + gapNM(e, seq[k].f.a, a, seq[k].f.rwy, f.rwy, wait(f.rwy)) / Math.max(95, 150 - e.headwindOn(f.rwy)) * 3600);
      const sta = q.est ? q.t : Math.max(q.t, need), slack = need - q.t; (q as any).sta = sta; prevT = sta;
      bk.plans.set(a.id, plan(e, q, i, lead ? lead.f.a : null, lead ? lead.way.s : 0, gap, Math.max(-300, slack), seq.slice(0, i)));
    });
  }
}
function plan(e: SimEngine, q: { f: Frame; o: Own; est: boolean; way: ReturnType<typeof wayIn> }, place: number, lead: AircraftState | null, leadNM: number, gap: number, slack: number, before: Array<{ f: Frame; est: boolean; o: Own }>): ArrPlan {
  const { f, o, est, way } = q, { a, x, course } = f, side = o.side, d = f.off * side, r = radiusNM(a), room = e.finalRoomNM(f.rwy) - 1;
  const at = (px: number, pd: number) => { const c = course * RAD, po = pd * side, wx = f.thr.x - (px * Math.sin(c) - po * Math.cos(c)) * NM, wy = f.thr.y - (px * Math.cos(c) + po * Math.sin(c)) * NM; return (Math.atan2(wx - a.pos.x, wy - a.pos.y) / RAD + 360) % 360; };
  const base: ArrPlan = { rwy: f.rwy, course, side, x, d, place, lead, gapNM: gap, pathNM: way.s, leadNM, slack, leg: 'established', hdg: course, level: 3000, kt: 160, clear: false, go: true, hold: null };
  if (est) return base;
  // ── hold: a long wait, near its arrival fix ──
  const h = holdPlan(e, a, o, slack, before);
  if (h) return { ...base, leg: 'hold', hdg: a.heading, level: h.level, kt: 0, clear: false, go: false, hold: h };
  // ── turn in now, or go on losing time? ──
  const inwards = way.via !== 'out';
  if (o.go && !a.ilsArmed && d > 0.4 && d < 3 && x - d * 1.75 < 5.5) { o.go = false; o.dir = 'out'; }                      // it would meet the beam too close in
  if (o.go && (x < 7.5 || d > 13 || (way.via === 'out' && d > 3))) { o.go = false; o.dir = 'out'; }                        // past the place to turn in: out and round again
  if (o.go && !a.ilsArmed && x < 9 && lead && way.s - leadNM < minNM(e, lead, a, f.rwy) - 0.3) { o.go = false; o.dir = 'out'; }   // too close behind to be cleared: out again while there is room
  if (!o.go && inwards && slack <= 12) { o.go = true; o.dog = false; }
  if (a.ilsArmed) o.go = true;
  let leg: ArrLeg, hdg: number;
  if (o.go) {
    const cut = d < 1 ? 18 : 27;
    if (d < 2.2 + r * 0.45 && x > 7 || x > 8.5 + 1.73 * Math.abs(d)) { leg = 'final'; hdg = d < -0.35 ? course + side * Math.min(27, 12 - d * 12) : Math.abs(d) < 0.25 ? at(x - 3, 0) : course - side * cut; }
    else { const F = Math.max(JOIN, Math.min(x - RUN - 0.7 * Math.max(0, d - 2), room - RUN)); leg = 'base'; hdg = at(F + RUN, 2); const rel = wrap(hdg - course) * -side; if (rel > 100) hdg = course - side * 100; }
  } else if (!inwards && (x < -3 || d < 3 || d > 10)) {
    // from behind the field, from across it, or out after a missed turn-in: to the start of the downwind
    if (d < 3.2 && x > -1) { leg = 'out'; hdg = course + 180 - side * (d < 1.2 ? 62 : 40); } else { leg = 'inbound'; hdg = at(x < -3 ? Math.max(-2, x + 4) : Math.min(x + 3, 9), LANE + 0.8); }
    o.dir = 'out';
  } else {
    // time to lose: outbound along the downwind; at the far end the wide lane back; from ahead of the field the wide lane in, or a vector off to the side
    if (o.dir === 'out' && x > room - r) o.dir = 'in';
    if (o.dir === 'in' && x < (o.wide ? 10 : 11)) o.dir = 'out';
    if (o.dir === 'out') { leg = d > 3 && x > 0 ? 'downwind' : 'outbound'; const want = x > 13 && d < WIDE - 1 && slack > 150 ? LANE : Math.max(LANE, Math.min(d, 6.5)); hdg = at(x + 4.5, want); }
    else if (x > JOIN + 2.5 && slack < 115 && d < 11) { leg = 'dogleg'; hdg = course + side * (slack > 60 ? 62 : 45); if (!e.insideBy(a, hdg, 4)) hdg = at(x - 5, WIDE); }
    else { leg = 'wide'; hdg = at(x - 5, WIDE); }
  }
  const spaced = !lead || way.s - leadNM >= minNM(e, lead, a, f.rwy) || leadNM > way.s + 3;
  // ── the level: one above everybody before it who is not on the beam yet, down as the miles run out ──
  const above = before.filter(b => !b.est && !(b.f.a.ilsArmed && b.o.go && Math.abs(b.f.off) < 1.2)).length;
  const ladder = Math.min(9000, 3000 + 1000 * above), s = way.s + Math.max(0, slack) / 3600 * 180;
  const near = leg! === 'final' && above === 0 && spaced && x - Math.max(0, d) * 1.96 < 9.6 ? 2000 : 3000;                                  // (meeting the beam close in: under the slope there)
  const level = Math.max(Math.min(ladder, above ? 9000 : near), x < 1 || s > 40 ? 8000 : s > 33 ? 6000 : near);      // (over the upwind side: above the departures, who climb to 7,000 first)
  // ── the speed ──
  const gapNow = lead ? way.s - leadNM : 99;
  let kt = leg === 'final' && x < 13 ? (gapNow < gap - 0.8 ? 150 : gapNow < gap + 0.4 ? 160 : 170) : leg === 'base' || leg === 'final' ? (slack > 15 ? 160 : 180) : way.s < 22 ? (slack > 25 ? 170 : 190) : way.s < 34 ? (slack > 45 ? 180 : 210) : slack > 60 ? 200 : 0;
  if (kt) kt = Math.max(kt, Math.ceil((a.perf.minAirspeedTMA + 3) / 10) * 10);
  if (kt && a.perf.propulsion === 'jet' && a.altitude > 6800 && Math.hypot(a.pos.x - e.centerXY.x, a.pos.y - e.centerXY.y) > 17.5 * NM) kt = Math.max(kt, a.perf.weightClass === 'H' || a.perf.weightClass === 'S' ? 210 : 190);      // no slower than clean far out: the crew asks for it
  if (o.kt && kt && Math.abs(kt - o.kt) <= 10 && leg !== 'final') kt = o.kt; else o.kt = kt;                                      // no to and fro
  // ── the ILS ── close enough, pointed in, and far enough behind the one before
  const turnTo = a.navMode === 'heading' ? a.targetHeading : a.heading, ic = Math.max(Math.abs(wrap(a.heading - course)), Math.abs(wrap(turnTo - course)));
  const towards = Math.abs(d) < 0.3 || (Math.sign(wrap(course - a.heading) * side) === Math.sign(d) && Math.sign(wrap(course - turnTo) * side) === Math.sign(d) && Math.abs(wrap(course - turnTo)) > 4);
  const meet = Math.max(0, x - Math.abs(d) / Math.tan(Math.max(10, ic) * RAD)), cur = a.cmdAltitude ?? a.targetAltitude;
  const onLevel = Math.abs(a.altitude - a.targetAltitude) < 350 && cur <= e.glideAltFt(f.rwy, meet) + 120 && a.altitude <= e.glideAltFt(f.rwy, meet) + 120;
  const clear = o.go && leg === 'final' && x > 5 && x < 24 && Math.abs(d) < 3.4 && ic <= 29.5 && towards && spaced && onLevel;
  return { ...base, leg, hdg: ((hdg % 360) + 360) % 360, level, kt, clear, go: o.go };
}
/** In a hold, or into one, or out of it: the stack it is in, or null when it flies the plan. */
function holdPlan(e: SimEngine, a: AircraftState, o: Own, slack: number, before: Array<{ f: Frame; est: boolean; o: Own }>): ArrHold | null {
  const urgent = !!a.emergency && a.emergency.status !== 'resolved';
  // (held by the controller at a fix of the airspace: it is in that stack)
  if (!o.hold && a.navMode === 'hold' && a.holdFixName && e.publishedHoldAt(a.holdFixName)) { o.hold = a.holdFixName; o.efc = a.holdEfc ?? e.time + Math.max(60, slack - HOLD_OUT_S); }
  if (!o.hold) {
    const fix = a.plan.fix ? e.beacons.find(b => b.id === a.plan.fix) : null;
    if (!fix || urgent || o.go || a.ilsArmed || slack < HOLD_IN_S || !e.publishedHoldAt(fix.id)) return null;
    const toFix = Math.hypot(a.pos.x - fix.x, a.pos.y - fix.y) / NM, out = Math.hypot(a.pos.x - e.centerXY.x, a.pos.y - e.centerXY.y) - Math.hypot(fix.x - e.centerXY.x, fix.y - e.centerXY.y);
    if (toFix > 12 || out < -2 * NM) return null;                       // (near the fix, not already well inside it)
    o.hold = fix.id; o.efc = Math.ceil((e.time + Math.max(60, slack - HOLD_OUT_S)) / 60) * 60;
  }
  const rank = before.filter(b => b.o.hold === o.hold).length;
  if (urgent || (rank === 0 && slack < HOLD_OUT_S)) { o.hold = null; o.dir = 'in'; return null; }
  // (a later time than it was told by three minutes or more: a new one)
  const est = Math.ceil((e.time + Math.max(60, slack - HOLD_OUT_S)) / 60) * 60; if (est > o.efc + 180 || o.efc < e.time - 30) o.efc = est;
  return { fix: o.hold, rank, level: Math.min(STACK_TOP_FT, STACK_BASE_FT + 1000 * rank), efc: o.efc };
}
/** Miles behind the one ahead below which it is not cleared for the approach. */
function minNM(e: SimEngine, lead: AircraftState, a: AircraftState, rwy: string): number {
  const rl = lead.assignedRunway ?? lead.plan.runway ?? rwy; return e.sameStrip(rl, rwy) || e.closeParallel(rl, rwy) ? Math.max(3.8, e.wakeFinalNM(lead, a) + 0.7) : 2.6;
}
export function arrivalPlan(e: SimEngine, a: AircraftState): ArrPlan | null { return book(e).plans.get(a.id) ?? null; }
