// What makes the frequency feel lived in: bumpy rides that one crew reports and the next asks about, weather to go round,
// two people talking at once, callsigns that sound alike, crews that thank you or have had enough, and crews that react
// to each other. Read from the simulator's state, its own random stream (scripted sessions are untouched); it asks and
// reports only. Runs when the session has characters (settings.personas); `radioRealism` = the harder radio parts.
import { remembersNames } from './naming';
import type { SimEngine } from './engine';
import type { AircraftState, PilotRequestKind } from './types';
import type { CommandAST, SingleAircraftCommand } from './commandAst';
import { isAirborne } from './aircraft';
import { personaHash, personaOf } from './persona';
import { altitudeLabel } from './phraseology';
import { angleDelta, advance, dist, headingTo, NM_TO_M, type XY } from './projection';
import { subStream } from './rng';

export const LIFE_CONST = {
  /** A patch of rough air: how often one appears (s), its size, and how long it lasts. */
  patchEveryS: [420, 900], patchNM: [6, 12], patchLifeS: [900, 1600], bandFt: 1800,
  /** In it this long before the crew says something, s. */
  feelS: 25,
  /** A crew that heard the report asks from this far away. */
  askNM: 12,
  /** A storm cell: the crew asks to go round it from here. */
  cellNM: [3, 5], cellAskNM: 9, cellAheadDeg: 22,
  /** Two calls this close together on one frequency can step on each other, s. */
  overlapS: 2.5,
  similarP: 0.3, similarEveryS: 240,
  /** The frequency is left alone for this long between chatty calls, s. */
  quietS: 40,
} as const;

interface Patch { id: number; pos: XY; r: number; lo: number; hi: number; until: number; word: 'light' | 'moderate'; by: number | null; freq: string | null; at: number }
interface Cell { id: number; pos: XY; r: number; until: number }

const BLOCKABLE: PilotRequestKind[] = ['pushback', 'startup', 'taxi', 'ready', 'higher', 'lower', 'direct', 'taxi_in'];
/** Same airline with the digits swapped or one different, or the same number at another airline. */
export function similarCallsigns(x: string, y: string): boolean {
  const a = x.match(/^([A-Z]{3})(\d{2,4})$/), b = y.match(/^([A-Z]{3})(\d{2,4})$/);
  if (!a || !b || x === y) return false;
  if (a[1] !== b[1]) return a[2] === b[2] && a[2].length >= 3;
  if (a[2].length !== b[2].length) return false;
  if ([...a[2]].sort().join('') === [...b[2]].sort().join('')) return true;
  return [...a[2]].filter((c, i) => c !== b[2][i]).length === 1 && a[2].length >= 3;
}

export class CrewLife {
  private rnd: () => number;
  private patches: Patch[] = []; private cells: Cell[] = [];
  private nextPatch: number; private nextCell = 0; private seq = 0;
  private felt = new Map<string, number>(); private said = new Map<string, number>(); private lastChat = -999;
  private onAir = new Map<string, { at: number; id: number }>();
  private runways = new Map<number, string[]>(); private waited = new Map<number, number>(); private thanked = new Map<number, number>();
  private landedWet: { runway: string; at: number; by: string } | null = null;
  private mayday: { id: number; at: number } | null = null;
  readonly stats: Record<string, number> = {};
  constructor(private e: SimEngine) { this.rnd = subStream('crewlife'); this.nextPatch = e.time + this.between(120, 420); }

  private between(a: number, b: number): number { return a + (b - a) * this.rnd(); }
  private count(k: string): void { this.stats[k] = (this.stats[k] ?? 0) + 1; }
  private once(key: string, s: number): boolean { const t = this.said.get(key); if (t != null && this.e.time - t < s) return false; this.said.set(key, this.e.time); return true; }
  get on(): boolean { return !!this.e.settings.personas && !this.e.settings.quietCrews; }

  // ── rides and weather ──────────────────────────────────────────────────────
  /** The ride where this aircraft is. */
  rideOf(a: AircraftState): 'smooth' | 'light' | 'moderate' {
    const p = this.patchAt(a.pos, a.altitude); return p ? p.word : 'smooth';
  }
  private patchAt(pos: XY, ft: number): Patch | null { return this.patches.find(p => ft >= p.lo && ft <= p.hi && dist(p.pos, pos) < p.r) ?? null; }
  /** For tests and scripted lessons. */
  addPatch(pos: XY, lo: number, hi: number, nm = 8, word: Patch['word'] = 'moderate'): void { this.patches.push({ id: ++this.seq, pos, r: nm * NM_TO_M, lo, hi, until: this.e.time + 1200, word, by: null, freq: null, at: 0 }); }
  addCell(pos: XY, nm = 4): void { this.cells.push({ id: ++this.seq, pos, r: nm * NM_TO_M, until: this.e.time + 1500 }); }

  private weather(): void {
    const e = this.e, C = LIFE_CONST, w = e.wx();
    this.patches = this.patches.filter(p => p.until > e.time); this.cells = this.cells.filter(c => c.until > e.time);
    const drift = (p: { pos: XY }) => { p.pos = advance(p.pos, (w.windDirTrue + 180) % 360, w.windKt * 0.5144); };
    this.patches.forEach(drift); this.cells.forEach(drift);
    if (e.time >= this.nextPatch) {
      const rough = Math.min(1.8, 0.7 + (w.windKt + w.gustKt) / 40);
      this.nextPatch = e.time + this.between(C.patchEveryS[0], C.patchEveryS[1]) / rough;
      if (this.patches.length < 2) {
        const lo = 1000 * Math.round(this.between(3, 10));
        this.addPatch(advance(e.centerXY, this.rnd() * 360, this.between(6, 22) * NM_TO_M), lo, lo + C.bandFt, this.between(C.patchNM[0], C.patchNM[1]), this.rnd() < 0.35 * rough ? 'moderate' : 'light');
        this.patches[this.patches.length - 1].until = e.time + this.between(C.patchLifeS[0], C.patchLifeS[1]);
      }
    }
    if (/CB/.test(w.cloud) && e.time >= this.nextCell && this.cells.length < 2) {
      this.nextCell = e.time + this.between(400, 800);
      this.addCell(advance(e.centerXY, this.rnd() * 360, this.between(10, 24) * NM_TO_M), this.between(C.cellNM[0], C.cellNM[1]));
    }
  }
  /** Speaks on a frequency the player works, when nothing else is open and nobody chatted just now. */
  private chat(a: AircraftState, kind: PilotRequestKind, param: string | number | null, text: string, quiet = true): boolean {
    const e = this.e;
    if (quiet && e.time - this.lastChat < LIFE_CONST.quietS) return false;
    if (!e.playerWorks(a) || e.time < a.standbyUntil || a.emergency) return false;
    const open = a.requests[0]; if (open && open.answeredAt == null) return false;
    const req = e.raiseRequest(a, kind, param, text); if (!req || req.text !== text) return false;
    if (kind === 'concern') req.expiresAt = e.time + 45;
    this.lastChat = e.time; return true;
  }
  private level(ft: number): string { return altitudeLabel(ft, (this.e as unknown as { transitionAltFt?: number }).transitionAltFt ?? 6000); }

  private rides(): void {
    const e = this.e, C = LIFE_CONST;
    for (const a of e.aircraft) {
      if (!isAirborne(a) || a.altitude < 2500 || a.ilsCaptured || a.phase === 'landing' || a.phase === 'takeoff') continue;
      const cs = e.telephony(a.callsign), unit = e.unitName(a.onFrequency);
      const p = this.patchAt(a.pos, a.altitude);
      if (p) {
        const k = `${a.id}:${p.id}`; const since = this.felt.get(k); if (since == null) { this.felt.set(k, e.time); continue; }
        if (e.time - since < C.feelS || this.said.has(`ride:${k}`)) continue;
        // out of it the short way: down under it for an arrival, up over it for a departure
        const down = a.plan.kind === 'arrival' && p.lo - 1000 >= 2000; const to = down ? Math.floor((p.lo - 500) / 1000) * 1000 : Math.ceil((p.hi + 500) / 1000) * 1000;
        const here = this.level(Math.round(a.altitude / 100) * 100);
        const follow = p.by != null && p.by !== a.id && p.freq === a.onFrequency;
        const text = follow ? `${unit}, ${cs}, same here at ${here}, ${p.word} chop, we'd like ${this.level(to)} too.` : `${unit}, ${cs}, ${p.word} chop at ${here}, request ${this.level(to)}.`;
        if (this.chat(a, down ? 'lower' : 'higher', to, text, p.word !== 'moderate')) { this.said.set(`ride:${k}`, e.time); if (p.by == null) { p.by = a.id; p.freq = a.onFrequency; p.at = e.time; } this.count('ride'); }
        continue;
      }
      // out of it again: said once, to the crew that got the level it asked for
      const was = this.patches.find(x => this.felt.has(`${a.id}:${x.id}`) && this.said.has(`ride:${a.id}:${x.id}`) && !this.said.has(`out:${a.id}:${x.id}`));
      if (was && dist(was.pos, a.pos) < was.r && this.chat(a, 'concern', null, `${cs}, smooth here at ${this.level(Math.round(a.altitude / 100) * 100)}, thanks.`)) { this.said.set(`out:${a.id}:${was.id}`, e.time); this.count('smooth'); continue; }
      // heard someone report it, and we are going there
      const ahead = this.patches.find(x => x.by != null && x.by !== a.id && x.freq === a.onFrequency && !this.said.has(`ask:${a.id}:${x.id}`) && dist(x.pos, a.pos) < x.r + C.askNM * NM_TO_M
        && Math.min(a.altitude, a.targetAltitude) <= x.hi && Math.max(a.altitude, a.targetAltitude) >= x.lo && Math.abs(angleDelta(a.heading, headingTo(a.pos, x.pos))) < 35);
      if (ahead && this.chat(a, 'concern', null, `${unit}, ${cs}, we heard the chop report, is it any better lower?`)) { this.said.set(`ask:${a.id}:${ahead.id}`, e.time); this.count('rideAsk'); }
      const cell = this.cells.find(c => { const d = dist(c.pos, a.pos); return d > c.r && d - c.r < C.cellAskNM * NM_TO_M && Math.abs(angleDelta(a.heading, headingTo(a.pos, c.pos))) < C.cellAheadDeg; });
      if (cell && !this.said.has(`cell:${a.id}:${cell.id}`)) {
        const side = angleDelta(a.heading, headingTo(a.pos, cell.pos)) > 0 ? 'left' : 'right';
        if (this.chat(a, 'further', null, `${unit}, ${cs}, request 20 degrees ${side} for weather, build-up ahead.`, false)) { this.said.set(`cell:${a.id}:${cell.id}`, e.time); this.count('deviate'); }
      }
    }
  }

  // ── reacting to each other ─────────────────────────────────────────────────
  private react(): void {
    const e = this.e;
    const em = e.aircraft.find(a => a.emergency && a.emergency.status !== 'resolved' && a.emergency.type !== 'radio_failure');
    if (em && this.mayday?.id !== em.id) this.mayday = { id: em.id, at: e.time };
    if (!em) this.mayday = null;
    if (em && this.mayday && e.time - this.mayday.at > 25 && e.time - this.mayday.at < 120) {
      const b = e.aircraft.find(x => x !== em && isAirborne(x) && x.plan.kind === 'arrival' && !x.emergency && x.onFrequency === em.onFrequency && !x.landingCleared && !x.ilsCaptured);
      if (b && !this.said.has(`help:${em.id}`) && this.chat(b, 'concern', null, `${e.telephony(b.callsign)}, we can extend or slow down if it helps ${e.telephony(em.callsign)}.`, false)) { this.said.set(`help:${em.id}`, e.time); this.count('help'); }
    }
    const w = e.wx();
    for (const a of e.aircraft) {
      // braking action after a landing on a wet runway, and the next one down acknowledges it
      if (w.runwayCondition !== 'dry' && a.plan.kind === 'arrival' && a.phase === 'taxi' && a.plan.runway && !this.said.has(`brk:${a.id}`) && a.delay.airborneS > 0) {
        this.said.set(`brk:${a.id}`, e.time);
        const word = w.runwayCondition === 'contaminated' ? 'medium to poor' : 'medium';
        if (this.landedWet && this.landedWet.runway === a.plan.runway && e.time - this.landedWet.at < 600) continue;
        if (this.chat(a, 'concern', null, `${e.unitName(a.onFrequency)}, ${e.telephony(a.callsign)}, braking action ${word} on ${a.plan.runway}.`)) { this.landedWet = { runway: a.plan.runway, at: e.time, by: a.callsign }; this.count('braking'); }
      }
      // the one ahead on the approach in sight: the visual is there to be given
      if (a.plan.kind === 'arrival' && isAirborne(a) && !a.ilsCaptured && !a.landingCleared && a.phase !== 'go_around' && a.navMode !== 'visual' && a.plan.runway && w.visM >= 8000 && (w.ceilingFt == null || w.ceilingFt > 4000) && a.altitude < 6000) {
        const nm = e.distToThresholdNM(a, a.plan.runway); if (nm == null || nm > 14 || nm < 6 || this.said.has(`sight:${a.id}`)) continue;
        const ref = e.runwayState(a.plan.runway)?.ref;
        const lead = e.aircraft.find(b => b !== a && b.ilsCaptured && b.plan.runway && e.runwayState(b.plan.runway)?.ref === ref && (e.distToThresholdNM(b, b.plan.runway) ?? 99) < nm - 2 && dist(a.pos, b.pos) < 6 * NM_TO_M && b.onFrequency === a.onFrequency && Math.abs(angleDelta(a.heading, headingTo(a.pos, b.pos))) < 60);
        if (!lead || personaHash(`sight:${a.callsign}`) % 3 !== 0) continue;
        const own = lead.callsign.slice(0, 3) === a.callsign.slice(0, 3);
        if (this.chat(a, 'concern', lead.callsign, `${e.telephony(a.callsign)}, we have ${own ? 'the company' : 'the'} ${e.spokenType(lead)} ahead in sight, we can follow it.`)) { this.said.set(`sight:${a.id}`, e.time); this.count('sight'); }
      }
    }
  }

  // ── two at once ────────────────────────────────────────────────────────────
  /** A crew is about to call. True: someone else is talking right now and both are lost (the engine calls again later). */
  blocks(a: AircraftState, kind: PilotRequestKind): boolean {
    const e = this.e;
    if (!this.on || !e.settings.radioRealism || !BLOCKABLE.includes(kind) || !e.playerWorks(a)) return false;
    const last = this.onAir.get(a.onFrequency);
    const hit = !!last && last.id !== a.id && e.time - last.at < LIFE_CONST.overlapS && !this.said.has(`blk:${a.id}`);
    if (hit) { this.said.set(`blk:${a.id}`, e.time); this.count('blocked'); }
    return hit;
  }
  /** Someone is talking on a frequency. */
  talking(a: AircraftState): void { this.onAir.set(a.onFrequency, { at: this.e.time, id: a.id }); }

  // ── callsigns that sound alike ─────────────────────────────────────────────
  /** An instruction went to `a`: does another crew with a callsign like it think it was theirs? */
  confused(a: AircraftState, part: SingleAircraftCommand): { b: AircraftState; question: string } | null {
    const e = this.e;
    if (!this.on || !e.settings.radioRealism || !['altitude', 'heading', 'speed'].includes(part.kind)) return null;
    const b = e.aircraft.find(x => x !== a && isAirborne(x) && x.onFrequency === a.onFrequency && !x.emergency && similarCallsigns(x.callsign, a.callsign) && !x.ilsCaptured);
    if (!b || !this.once(`sim:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`, LIFE_CONST.similarEveryS)) return null;
    const kind = personaOf(b.callsign).kind; if (this.rnd() > LIFE_CONST.similarP * (kind === 'captain' ? 0.5 : kind === 'line' ? 1 : 1.8)) return null;
    this.count('similar');
    return { b, question: `was that for us or ${e.telephony(a.callsign)}` };
  }
  /** Now and then a new flight gets a number like one already here (its own random stream). */
  alike(icao3: string, taken: readonly string[]): string | null {
    if (!this.on || !this.e.settings.radioRealism || this.rnd() > 0.07) return null;
    const pool = taken.filter(c => c.startsWith(icao3) && /^\D{3}\d{3,4}$/.test(c)); if (!pool.length) return null;
    const c = pool[Math.floor(this.rnd() * pool.length)]; const n = c.slice(3).split('');
    const i = Math.floor(this.rnd() * (n.length - 1)); if (n[i] === n[i + 1] || (i === 0 && n[1] === '0')) return null;
    [n[i], n[i + 1]] = [n[i + 1], n[i]]; const out = icao3 + n.join('');
    return taken.includes(out) ? null : out;
  }

  // ── mood and memory ────────────────────────────────────────────────────────
  /** What this crew adds to a readback: thanks for a shortcut, or that this is the third runway. "" = nothing. */
  aside(a: AircraftState, ast: CommandAST): string {
    if (!this.on || a.emergency) return '';
    const parts = ast.kind === 'sequence' ? ast.parts : [ast];
    for (const p of parts) {
      const rw = p.kind === 'ils' || p.kind === 'expectRunway' ? p.runway : p.kind === 'taxi' && p.dest.kind === 'runway' ? p.dest.runway : null;
      if (rw) {
        const l = this.runways.get(a.id) ?? (a.plan.runway ? [a.plan.runway.toUpperCase()] : []); if (l[l.length - 1] !== rw.toUpperCase()) l.push(rw.toUpperCase()); this.runways.set(a.id, l);
        if (l.length >= 3 && this.once(`rwy:${a.id}:${l.length}`, 1e9)) { this.count('runwayChange'); return l.length === 3 ? `that's the ${ORD[l.length] ?? 'next'} runway for us, confirm that's the last change` : `${ORD[l.length] ?? 'another'} runway now`; }
      }
    }
    const wait = this.waited.get(a.id) ?? 0; this.waited.delete(a.id);
    if (wait >= 2 && this.once(`wait:${a.id}`, 600)) { this.count('waited'); return ['thanks, we were starting to wonder', 'appreciate it, it was a long wait'][personaHash(a.callsign) % 2]; }
    const nice = parts.find(p => p.kind === 'direct' || p.kind === 'visual' || (p.kind === 'altitude' && this.said.has(`asked:${a.id}`)));
    if (nice && (this.thanked.get(a.id) ?? 0) < 2 && personaHash(`thx:${a.callsign}`) % 2 === 0) { this.thanked.set(a.id, (this.thanked.get(a.id) ?? 0) + 1); this.said.delete(`asked:${a.id}`); this.count('thanks'); return 'thanks'; }
    if (parts.some(p => p.kind === 'contact') && personaHash(`bye:${a.callsign}`) % 5 < 2) { this.count('bye'); return ['good day', 'see you', 'thanks for the help'][personaHash(`bye2:${a.callsign}`) % 3]; }
    return '';
  }
  /** A call is being answered after this many repeats. */
  answered(a: AircraftState, recalls: number, kind: PilotRequestKind): void { if (recalls >= 2) this.waited.set(a.id, recalls); if (kind === 'higher' || kind === 'lower' || kind === 'direct') this.said.set(`asked:${a.id}`, this.e.time); }

  /** Once per simulated second. */
  tick(): void {
    if (!this.on) return;
    this.weather();
    if (Math.round(this.e.time) % 2 === 0) { this.rides(); this.react(); }
    if (this.felt.size > 2000) this.felt.clear();
  }
}
const ORD: Record<number, string> = { 3: 'third', 4: 'fourth', 5: 'fifth' };

const LIVES = new WeakMap<object, CrewLife>();
remembersNames(e => LIVES.get(e));
export function crewLifeOf(engine: object): CrewLife {
  let l = LIVES.get(engine); if (!l) { l = new CrewLife(engine as SimEngine); LIVES.set(engine, l); }
  return l;
}
