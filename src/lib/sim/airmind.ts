// The crew's side of an instruction in the air, and the fuel ladder (the companion of taximind.ts): what they cannot fly
// and what they can do instead ("unable one twenty, one forty is our minimum, we can do that"), what looks wrong to them
// (a turn at traffic, too high for the approach), and fuel: a heads-up, "minimum fuel", then MAYDAY (engine.ts).
// Asks only, through the same approved / negative / say-it-again flow (dispatch.ts step 3b).
import { remembersNames } from './naming';
import type { SimEngine } from './engine';
import type { AircraftState } from './types';
import type { CommandAST, SingleAircraftCommand } from './commandAst';
import type { TaxiDoubt } from './taximind';
import { isAirborne } from './aircraft';
import { cpa, verticalSpeedFpm } from './alerts';
import { personaHash } from './persona';
import { angleDelta, headingTo, NM_TO_M } from './projection';

export const AIR_CONST = {
  /** Minutes of fuel: heads-up to the controller, and "minimum fuel" (MAYDAY FUEL is the engine's, under 20). */
  headsUpMin: 37, minimumMin: 30,
  /** The heads-up only after this long with us, s (a short flight is never told about). */
  withUsS: 600,
  /** This close in and settled, nothing about fuel is said any more (NM). */
  nearlyThereNM: 8,
  /** Slowing a jet below its clean speed far out: asked, not refused. */
  cleanFarNM: 18, cleanFt: 7000, clean: { L: 0, M: 190, H: 210, S: 210 } as Record<string, number>,
  /** A turn at traffic: passing this close within this long. */
  trafficNM: 1.8, trafficFt: 700, trafficS: 70, seeNM: 8,
  /** Steeper than this to the threshold is too high (ft per NM; a 3 degree glide path is 318). */
  steepFtNM: 480, tightNM: 3.5,
  tailKt: 10, repeatS: 240,
} as const;

const r10 = (n: number) => Math.round(n / 10) * 10;

export class AirMind {
  private said = new Map<string, number>();
  /** Crews that declared minimum fuel (by aircraft id). */
  private minimum = new Set<number>();
  readonly stats: Record<string, number> = {};
  private once(e: SimEngine, key: string, repeatS: number = AIR_CONST.repeatS): boolean {
    const t = this.said.get(key); if (t != null && e.time - t < repeatS) return false;
    this.said.set(key, e.time); return true;
  }
  isMinimumFuel(a: AircraftState): boolean { return this.minimum.has(a.id) && isAirborne(a); }

  check(e: SimEngine, a: AircraftState, part: SingleAircraftCommand, all: SingleAircraftCommand[]): TaxiDoubt | null {
    if (!isAirborne(a) || a.phase === 'takeoff' || a.emergency) return null;
    const d = this.look(e, a, part, all);
    if (d) this.stats[d.rule] = (this.stats[d.rule] ?? 0) + 1;
    return d;
  }

  private look(e: SimEngine, a: AircraftState, part: SingleAircraftCommand, all: SingleAircraftCommand[]): TaxiDoubt | null {
    const C = AIR_CONST, P = a.perf;
    const cannot = (rule: TaxiDoubt['rule'], question: string, offer: CommandAST | null = null): TaxiDoubt => ({ earlier: null, rule, question, offer, hard: true });
    const rather = (rule: TaxiDoubt['rule'], question: string, offer: CommandAST | null = null): TaxiDoubt => ({ earlier: null, rule, question, offer, hard: false });
    const fieldNM = Math.hypot(a.pos.x - e.centerXY.x, a.pos.y - e.centerXY.y) / NM_TO_M;
    const arrival = a.plan.kind === 'arrival';

    if (part.kind === 'speed' && part.kts !== 'resume') {
      const est = a.ilsCaptured || a.phase === 'landing';
      const min = est ? P.approachSpeed : P.minAirspeedTMA, max = Math.min(est ? Math.min(210, P.maxAirspeedTMA) : P.maxAirspeedTMA, a.altitude < 10000 ? 250 : 999);
      const can = (kts: number): CommandAST => ({ ...part, kts });
      if (part.kts < min) { const m = Math.ceil(min / 10) * 10; return cannot('air_speed', `unable ${part.kts} knots, ${m} is our minimum, we can do that`, can(m)); }
      if (part.kts > max) { const m = Math.floor(max / 10) * 10; return cannot('air_speed', `unable ${part.kts} knots, ${m} is the best we can do${max === 250 && P.maxAirspeedTMA >= 250 ? ' below ten thousand' : ''}`, can(m)); }
      const clean = C.clean[P.weightClass] ?? 0;
      if (!est && P.propulsion === 'jet' && part.kts < clean && fieldNM > C.cleanFarNM && a.altitude > C.cleanFt && this.once(e, `clean:${a.id}`)) {
        return rather('air_speed', `${part.kts} means flaps out this far, could we keep ${clean} until we're closer in`, can(clean));
      }
      if (arrival && this.isMinimumFuel(a) && part.kts < 200 && fieldNM > 15 && this.once(e, `fuelspd:${a.id}`)) return rather('air_fuel', `we're minimum fuel, confirm ${part.kts} knots`, null);
    }

    if (part.kind === 'altitude') {
      const top = P.propulsion === 'piston' ? 12000 : null;
      if (top && part.ft > top) return cannot('air_level', `unable ${part.ft} feet, ${top} is as high as we go`, { ...part, ft: top });
    }

    if (part.kind === 'hold' && arrival && this.isMinimumFuel(a)) return cannot('air_fuel', `unable to hold, we're minimum fuel with ${Math.round(a.fuelMin ?? 0)} minutes, request vectors for the approach`);

    if (part.kind === 'heading' && a.altitude > 1500) {
      if (arrival && this.isMinimumFuel(a) && fieldNM > 10 && Math.abs(angleDelta(part.hdg, headingTo(a.pos, e.centerXY))) > 110 && this.once(e, `fuelhdg:${a.id}`)) {
        return rather('air_fuel', `that takes us away from the field and we're minimum fuel, how long is the delay, confirm the heading`);
      }
      const t = this.turnsAt(e, a, part.hdg, all);
      if (t && this.once(e, `turn:${a.id}:${t.id}`)) return rather('air_traffic', `that turn takes us at traffic, ${t.words}, confirm the heading`);
    }

    if (part.kind === 'ils' && !all.some(x => x.kind === 'heading' || x.kind === 'direct')) {
      const rs = e.runwayState(part.runway); const nm = rs ? e.distToThresholdNM(a, rs.name) : null;
      if (rs && nm != null) {
        const tail = e.tailwindKt(rs.headingTrue);
        if (tail > C.tailKt && this.once(e, `tail:${a.id}:${rs.name}`)) return rather('air_wind', `we show ${Math.round(tail)} knots on the tail for ${rs.name}, our limit is ${C.tailKt}, is another runway available`);
        // coming at the runway (not on a downwind, where there are miles still to fly)
        const toward = Math.abs(angleDelta(a.heading, rs.headingTrue)) < 60 && Math.abs(angleDelta(headingTo(a.pos, e.thresholdXY(rs.name) ?? a.pos), rs.headingTrue)) < 60;
        if (toward && !a.ilsCaptured && nm > 1 && nm < 25 && a.altitude > 2500 && a.altitude / nm > C.steepFtNM && this.once(e, `high:${a.id}`)) {
          return rather('air_high', `we're too high for that, ${r10(a.altitude / 10) * 10} feet at ${Math.round(nm)} miles, could we get a longer final`);
        }
        if (toward && !a.ilsCaptured && nm < C.tightNM && nm > 0.5 && Math.abs(angleDelta(a.heading, rs.headingTrue)) > 25 && this.once(e, `tight:${a.id}`)) return rather('air_tight', `that's too tight for us, ${Math.max(1, Math.round(nm))} miles out, request vectors back round`);
      }
    }
    return null;
  }

  /** Traffic a new heading would point us at, when the present one does not. */
  private turnsAt(e: SimEngine, a: AircraftState, hdg: number, all: SingleAircraftCommand[]): { id: number; words: string } | null {
    const C = AIR_CONST; const alt = all.find(x => x.kind === 'altitude');
    const target = alt && alt.kind === 'altitude' ? alt.ft : a.targetAltitude;
    const vs = verticalSpeedFpm(a);
    const me = (h: number) => ({ pos: a.pos, heading: h, speedKt: a.speed, altFt: a.altitude, vsFpm: vs });
    for (const b of e.aircraft) {
      if (b === a || !isAirborne(b) || b.altitude < 1500 || b.phase === 'landing' || (a.ilsCaptured && b.ilsCaptured)) continue;
      const vb = { pos: b.pos, heading: b.heading, speedKt: b.speed, altFt: b.altitude, vsFpm: verticalSpeedFpm(b) };
      const c = cpa(me(hdg), vb, C.trafficS); if (c.nowNM > C.seeNM || c.distNM >= C.trafficNM || c.tS < 8) continue;
      if (cpa(me(a.heading), vb, C.trafficS).distNM < C.trafficNM) continue;                    // already on it without the turn
      const level = (now: number, rate: number, to: number, t: number) => { const p = now + rate * t / 60; return rate > 0 ? Math.min(p, Math.max(to, now)) : rate < 0 ? Math.max(p, Math.min(to, now)) : now; };
      const va = alt ? (target > a.altitude ? Math.max(vs, 1500) : target < a.altitude ? Math.min(vs, -1500) : 0) : vs;
      if (Math.abs(level(a.altitude, va, target, c.tS) - level(b.altitude, vb.vsFpm, b.targetAltitude, c.tS)) >= C.trafficFt) continue;
      const clock = ((Math.round(angleDelta(a.heading, headingTo(a.pos, b.pos)) / 30) % 12) + 12) % 12 || 12, dz = b.altitude - a.altitude;
      return { id: b.id, words: `${clock} o'clock, ${Math.max(1, Math.round(c.nowNM))} miles, ${Math.abs(dz) < 300 ? 'same level' : `${Math.round(Math.abs(dz) / 100) * 100} feet ${dz > 0 ? 'above' : 'below'}`}` };
    }
    return null;
  }

  /** Once per simulated second: the fuel ladder of the arrivals (departures carry no figure). */
  tick(e: SimEngine): void {
    const C = AIR_CONST; if (e.settings.quietCrews) return;
    for (const a of e.aircraft) {
      if (a.fuelMin == null || a.plan.kind !== 'arrival' || !isAirborne(a) || a.emergency || a.phase === 'landing') continue;
      if (a.fuelMin > C.headsUpMin) continue;
      const rw = a.plan.runway ?? a.assignedRunway; const nm = rw ? e.distToThresholdNM(a, rw) : null;
      if (a.ilsCaptured && nm != null && nm < C.nearlyThereNM) continue;
      const open = a.requests[0]; if (open && open.answeredAt == null && open.kind !== 'further') continue;
      if (e.time < a.standbyUntil || !e.playerWorks(a)) continue;     // (an AI controller is not told: it sequences by itself)
      const who = `${e.unitName(a.onFrequency)}, ${e.telephony(a.callsign)}`, min = Math.round(a.fuelMin);
      const speak = (text: string) => { const req = e.raiseRequest(a, 'concern', null, text); if (req?.text === text) { req.expiresAt = e.time + 60; return true; } return false; };
      if (a.fuelMin <= C.minimumMin) {
        if (!this.minimum.has(a.id) && speak(`${who}, minimum fuel, ${min} minutes remaining, unable to accept any delay.`)) { this.minimum.add(a.id); this.stats.minimumFuel = (this.stats.minimumFuel ?? 0) + 1; }
      } else if (a.delay.airborneS > C.withUsS && !this.said.has(`fuel:${a.id}`)) {
        const left = Math.max(1, Math.round(a.fuelMin - C.minimumMin));
        const ask = ['any idea of the delay', 'how long to the approach', 'what are we looking at for the approach'][personaHash(`fuel:${a.callsign}`) % 3];
        if (speak(`${who}, we've about ${left} minutes before minimum fuel, ${ask}?`)) { this.said.set(`fuel:${a.id}`, e.time); this.stats.fuelHeadsUp = (this.stats.fuelHeadsUp ?? 0) + 1; }
      }
    }
    if (this.said.size > 3000) for (const [k, t] of this.said) if (!k.startsWith('fuel:') && e.time - t > 900) this.said.delete(k);
  }
}

const MINDS = new WeakMap<object, AirMind>();
remembersNames(e => MINDS.get(e));
export function airMindOf(engine: object): AirMind {
  let m = MINDS.get(engine); if (!m) { m = new AirMind(); MINDS.set(engine, m); }
  return m;
}
