/*
  Holding, flown and run the way it is done for real.

  Flying (FAA AIM 5-3-8, ICAO Doc 8168): the pattern is a racetrack with the fix at its inner end. The inbound leg is one
  minute at or below 14,000 ft and one and a half above (or a set length in miles); turns go right unless the hold says
  left. How it is entered depends on the heading at the fix, measured from the inbound course (for right turns; mirror
  it for left):
    direct    -70 to +110 degrees: turn straight on to the outbound leg
    teardrop  +110 to 180:         out 30 degrees into the holding side for one leg, then turn on to the inbound course
    parallel  -180 to -70:         out on the non-holding side for one leg, turn back the other way, through more than
                                   180 degrees, to the fix
  The wind is flown out: the drift angle on the inbound leg, three times it on the outbound leg (so the turns put it back
  on the course), and the outbound leg timed so that the inbound one takes the set time.

  Running it (FAA JO 7110.65 4-6, the London and New York stacks): aircraft in one hold are stacked 1,000 ft apart, the
  lowest leaves first and the rest step down. Each is told when to expect further clearance (EFC); a crew whose EFC has
  passed asks for it.

  Where: every airspace fix with a hold heading in the airport's file is a holding fix, "as published" = that inbound
  course, right turns, one-minute legs; PUBLISHED below overrides it where a hold is charted differently.
*/
import type { AircraftState } from './types';
type TurnDir = 'L' | 'R';
import type { XY } from './projection';

const RAD = Math.PI / 180, NM = 1852;
const wrap = (d: number) => ((d % 360) + 540) % 360 - 180;
const norm = (d: number) => ((d % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface PublishedHold { fix: string; inbound: number; dir: TurnDir; legMin: number | null; legNM: number | null }
/** Charted holds that differ from the airport file's default (true inbound course). Key: `ICAO/FIX`. */
const PUBLISHED: Record<string, Partial<Omit<PublishedHold, 'fix'>>> = {};

/** The hold at `fix` as published: the airport file's hold heading, right turns, timed legs (unless charted otherwise). */
export function publishedHold(icao: string, fix: { id: string; holdHeading?: number }, altitudeFt: number): PublishedHold | null {
  const o = PUBLISHED[`${icao}/${fix.id}`];
  const inbound = o?.inbound ?? fix.holdHeading; if (inbound == null) return null;
  return { fix: fix.id, inbound: norm(inbound), dir: o?.dir ?? 'R', legNM: o?.legNM ?? null, legMin: o?.legNM != null ? null : o?.legMin ?? (altitudeFt > 14000 ? 1.5 : 1) };
}

/** Holding speed limit (AIM 5-3-8 j): 200 kt to 6,000 ft, 230 to 14,000, 265 above. */
export const holdSpeedKt = (altFt: number) => (altFt <= 6000 ? 200 : altFt <= 14000 ? 230 : 265);

export type HoldEntry = 'direct' | 'teardrop' | 'parallel';
/** How a hold is entered, from the heading at the fix. */
export function holdEntry(headingTrue: number, inboundTrue: number, dir: TurnDir): HoldEntry {
  const d = wrap(headingTrue - inboundTrue) * (dir === 'R' ? 1 : -1);
  return d > 110 ? 'teardrop' : d < -70 ? 'parallel' : 'direct';
}

/** Where the aircraft is in the hold's frame: metres still to go to the fix along the inbound course (negative = past it),
 *  and metres off the inbound course to the holding side (negative = the other side). */
export function holdFrame(pos: XY, fix: XY, inboundTrue: number, dir: TurnDir): { toGo: number; side: number } {
  const c = inboundTrue * RAD, rx = pos.x - fix.x, ry = pos.y - fix.y;
  const right = rx * Math.cos(c) - ry * Math.sin(c);
  return { toGo: -(rx * Math.sin(c) + ry * Math.cos(c)), side: dir === 'R' ? right : -right };
}

export interface HoldWind { dirTrue: number; kt: number }
/** Drift angle to fly a track (degrees to add to the track for the heading). */
function drift(trackTrue: number, tasKt: number, w: HoldWind): number {
  const xw = Math.sin(wrap(w.dirTrue - trackTrue) * RAD) * w.kt;
  return Math.asin(clamp(xw / Math.max(80, tasKt), -0.5, 0.5)) / RAD;
}
const groundKt = (trackTrue: number, tasKt: number, w: HoldWind) => Math.max(60, tasKt - Math.cos(wrap(w.dirTrue - trackTrue) * RAD) * w.kt);

/** One step of the pattern: sets the heading to fly (and a forced turn direction), moves the phase on. */
export function flyHold(a: AircraftState, dt: number, w: HoldWind): void {
  const fix = a.holdFix; if (!fix) return;
  const C = a.holdInboundHdg, O = norm(C + 180), dir = a.holdTurnDir, sgn = dir === 'R' ? 1 : -1, other: TurnDir = dir === 'R' ? 'L' : 'R';
  const legS = a.holdLegMin * 60, d = Math.hypot(a.pos.x - fix.x, a.pos.y - fix.y), toFix = norm(Math.atan2(fix.x - a.pos.x, fix.y - a.pos.y) / RAD);
  const f = holdFrame(a.pos, fix, C, dir), tas = a.speed;
  const steer = (track: number) => { a.targetHeading = norm(track + drift(track, tas, w)); };
  // outbound: a track that ends the leg as far to the holding side as the turn back needs (twice its radius, plus what
  // the wind blows it across the course during that turn), so the turn rolls out on the inbound course
  const v = Math.max(140, tas) * 0.5144, rM = v / (Math.min(Math.max(1, a.perf.turnRateAir) * 1.6, 9.81 * Math.tan(25 * RAD) / v / RAD) * RAD),   // (the turn the physics flies: aircraft.ts)
    wTo = (w.dirTrue + 180) * RAD, c = C * RAD;
  const across = (Math.sin(wTo) * Math.cos(c) - Math.cos(wTo) * Math.sin(c)) * sgn * w.kt * 0.5144;      // wind towards the holding side, m/s
  const want = 2 * rM - across * Math.PI * rM / Math.max(70, tas * 0.5144);
  const outTrack = norm(O - sgn * clamp((want - f.side) * 0.012, -25, 30)), out = norm(outTrack + drift(outTrack, tas, w));
  // (over the fix: within 400 m, or abeam it and going away)
  const overFix = d < 400 || (d < 3000 && Math.abs(wrap(toFix - a.heading)) > 100 && a.holdTimer > 20);
  switch (a.holdPhase) {
    case 'to_fix':
      steer(toFix); a.holdTimer += dt;
      if (overFix || (d < 1500 && a.holdTimer > 240)) {
        const e = holdEntry(a.heading, C, dir); a.holdEntry = e; a.holdTimer = 0;
        if (e === 'direct') { a.holdPhase = 'outbound_turn'; a.turnDir = dir; a.targetHeading = norm(O + drift(O, tas, w)); }
        else if (e === 'teardrop') { a.holdPhase = 'teardrop'; a.turnDir = null; a.targetHeading = norm(O - 30 * sgn); }
        else { a.holdPhase = 'parallel'; a.turnDir = null; a.targetHeading = O; }
      }
      break;
    case 'teardrop':   // 30 degrees off the outbound course, into the holding side, for one leg; then round to the inbound course
      a.targetHeading = norm(O - 30 * sgn); a.holdTimer += dt;
      if (a.holdTimer >= legS) { a.holdPhase = 'inbound_turn'; a.turnDir = dir; a.targetHeading = C; }
      break;
    case 'parallel':   // out along the non-holding side for one leg, then back the other way, through more than 180 degrees, towards the fix
      steer(O); a.holdTimer += dt;
      if (a.holdTimer >= legS) { a.holdPhase = 'parallel_turn'; a.turnDir = other; a.targetHeading = norm(C - 40 * sgn); }
      break;
    case 'parallel_turn':
      if (Math.abs(wrap(a.heading - a.targetHeading)) < 8) { a.holdPhase = 'inbound'; a.turnDir = null; a.holdTimer = -1e9; }
      break;
    case 'outbound_turn': {
      // (the whole turn first, to the outbound course; the offset is put right on the leg)
      const o2 = norm(O + drift(O, tas, w)); a.targetHeading = o2;
      if (Math.abs(wrap(a.heading - o2)) < 6) { a.holdPhase = 'outbound'; a.holdTimer = 0; a.turnDir = null; }
      break;
    }
    case 'outbound': {
      a.targetHeading = out; if (f.toGo >= 0) a.holdTimer += dt;      // (timed from abeam the fix, or wings level, whichever is later)
      // timed so the inbound leg takes the set time: a first guess from the winds, then put right each lap by the inbound leg it gave; a leg in miles ends at its distance
      const first = clamp(legS * groundKt(C, tas, w) / groundKt(O, tas, w) - 8, legS * 0.4, legS * 1.7);
      a.holdOutS ??= first;
      const done = a.holdLegNM != null ? f.toGo >= a.holdLegNM * NM : a.holdTimer >= a.holdOutS;
      if (done) { a.holdPhase = 'inbound_turn'; a.turnDir = dir; a.targetHeading = C; }
      break;
    }
    case 'inbound_turn':
      a.targetHeading = C;
      if (Math.abs(wrap(a.heading - C)) < 40) { a.holdPhase = 'inbound'; a.turnDir = null; a.holdTimer = 0; }
      break;
    case 'inbound': {
      // on to the inbound course (up to 30 degrees in), then along it to the fix
      // (the last miles: straight at the fix, the way a parallel entry ends)
      const right = f.side * sgn;
      steer(f.toGo < 2.5 * NM && f.toGo > 300 ? toFix : norm(C - clamp(right * 0.02, -30, 30))); a.holdTimer += dt;
      if (d < 700 || (f.toGo < 150 && Math.abs(f.side) < 0.8 * NM)) {
        // (the inbound leg against the set time: the next outbound leg longer or shorter by the difference)
        if (a.holdTimer > 0 && a.holdLegNM == null && (a.holdLaps ?? 0) > 0) a.holdOutS = clamp((a.holdOutS ?? legS) + (legS + 12 - a.holdTimer) * 0.8, legS * 0.5, legS * 1.8);   // (not after the entry: that inbound leg says nothing)
        a.holdPhase = 'outbound_turn'; a.turnDir = dir; a.targetHeading = norm(O + drift(O, tas, w)); a.holdTimer = 0; a.holdLaps = (a.holdLaps ?? 0) + 1;
      } else if (f.toGo < -0.6 * NM) { a.holdPhase = 'to_fix'; a.holdTimer = 0; }      // (past it without crossing it: back to the fix, and in again)
      break;
    }
  }
}
