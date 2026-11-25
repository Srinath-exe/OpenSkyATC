// The crew's side of a taxi clearance: what they say before they move. A pilot who is sent along a taxiway that is not on
// the chart, does not connect, is too narrow, or runs into traffic says so and offers the way they had planned; one who
// is given more than they can take in asks for it in steps. The offer is answered "approved" or "negative" (dispatch.ts
// step 3b). Nothing here changes the state: it only asks.
//
//   cannot  (hard) the instruction cannot be flown as given: repeating it gets the same answer
//   rather not     the crew asks once; the same instruction again, or "negative", and they do as told
import { remembersNames } from './naming';
import type { SimEngine } from './engine';
import type { AircraftState } from './types';
import type { CommandAST, HoldShortTarget, SingleAircraftCommand, TaxiAst } from './commandAst';
import type { PilotQuery } from './ledger';
import { isAirborne } from './aircraft';
import { personaHash, personaOf, type PersonaKind } from './persona';
import { spokenTaxiway } from './phraseology';
import { dist } from './projection';
import { taxiLimitsOf } from './taxiLimits';

export type TaxiDoubt = Omit<PilotQuery, 'at' | 'ast'>;

export const TAXI_CONST = {
  /** Things to remember in one taxi clearance (taxiways, crossings, a hold short) before the crew asks for it in steps. */
  load: { captain: 9, line: 8, rookie: 6, visitor: 5, student: 5 } as Record<PersonaKind, number>,
  /** Head-on on one taxiway: shared stretch, and how far ahead a crew looks, metres. */
  sharedM: 80, lookM: 1800, taxiMps: 8, marginS: 25,
  /** "The long way round": this much longer than the crew's own way, and by at least this many metres. */
  longer: 1.8, longerM: 1200,
  /** The same wish is not repeated to the controller within this, s. */
  repeatS: 240,
  /** A route offered instead may be this much longer than the crew's shortest way. */
  offerMax: 3,
} as const;

// (stand sizes are estimated from the spacing on the map: the small ones are not trusted below a 737)
const SPAN: Record<string, number> = { A: 36, B: 36, C: 36, D: 52, E: 65, F: 80 };
const up = (s: string) => s.toUpperCase();
/** "Alpha, Bravo and Foxtrot". */
function spoken(names: string[]): string {
  const w = names.map(n => spokenTaxiway(n));
  return w.length < 2 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
}

export function sameTaxi(x: TaxiAst, y: TaxiAst): boolean {
  const key = (t: TaxiAst) => JSON.stringify([t.dest.kind, t.dest.kind === 'runway' ? up(t.dest.runway) : t.dest.kind === 'stand' ? up(t.dest.ref) : t.dest.nodeId, t.via.map(up), t.holdShortOf ?? null, t.cross.map(up), t.limit ?? null]);
  return key(x) === key(y);
}

export class TaxiMind {
  private said = new Map<string, number>();
  readonly stats: Record<string, number> = {};

  private once(e: SimEngine, key: string, repeatS: number = TAXI_CONST.repeatS): boolean {
    const t = this.said.get(key);
    if (t != null && e.time - t < repeatS) return false;
    this.said.set(key, e.time); return true;
  }
  /** Stable choice between wordings for one crew. */
  private pick(a: AircraftState, key: string, list: string[]): string { return list[personaHash(`${key}:${a.callsign}`) % list.length]; }

  /** What the crew says about this instruction instead of doing it, or null when they are happy with it. */
  check(e: SimEngine, a: AircraftState, part: SingleAircraftCommand): TaxiDoubt | null {
    if (isAirborne(a) || !['taxi', 'hold_short', 'pushback', 'startup', 'rollout'].includes(a.phase) || a.emergency) return null;
    const d = part.kind === 'taxi' ? this.taxi(e, a, part) : part.kind === 'holdShort' ? this.holdShort(e, a, part.of) : null;
    if (d) this.stats[d.rule] = (this.stats[d.rule] ?? 0) + 1;
    return d;
  }

  /** The way the crew would go by itself, as an instruction: it fits, it connects, and it keeps the limits of `t`. */
  private ownWay(e: SimEngine, a: AircraftState, t: TaxiAst, avoid?: Set<string>): { ast: TaxiAst; names: string[]; ids: string[]; m: number } | null {
    const p = e.taxiPlan(a, t.dest, [], avoid); if ('code' in p) return null;
    if (taxiLimitsOf(e.air).firstRefused(p.ids, a.perf.wingspanMeters, a.plan.kind === 'departure')) return null;
    // the controller's own words about runways stand: crossings on the new way are only the ones already cleared
    const on = new Set(p.path.holds!.filter(h => !h.isDepartureEntry).map(h => e.runwayState(h.runway)?.ref));
    const cross = t.cross.filter(c => on.has(e.runwayState(c)?.ref));
    // a runway on the new way nobody cleared: the crew offers to hold short of it (approving the offer is a complete clearance)
    const first = p.path.holds!.filter(h => !h.isDepartureEntry).sort((x, y) => x.at - y.at).find(h => !cross.some(c => e.runwayState(c)?.ref === e.runwayState(h.runway)?.ref));
    const said: HoldShortTarget | null = t.holdShortOf?.kind === 'runway' && on.has(e.runwayState(t.holdShortOf.runway)?.ref) ? t.holdShortOf
      : t.holdShortOf?.kind === 'taxiway' && e.taxiMeets(p.path, t.holdShortOf.taxiway) ? t.holdShortOf : null;
    const hs: HoldShortTarget | null = said ?? (first && !t.limit ? { kind: 'runway', runway: first.runway } : null);
    const limit = t.limit === 'hold' && hs ? 'hold' as const : t.limit === 'crossed' && cross.length ? 'crossed' as const : null;
    if (t.limit && !limit) return null;        // a step clearance whose stop is not on this way: not the crew's to change
    return { ast: { ...t, via: p.names, auto: false, cross, holdShortOf: hs, ...(limit ? { limit } : { limit: null }) }, names: p.names, ids: p.ids, m: p.path.total };
  }

  private taxi(e: SimEngine, a: AircraftState, t: TaxiAst): TaxiDoubt | null {
    const cannot = (rule: PilotQuery['rule'], question: string, offer: CommandAST | null): TaxiDoubt => ({ earlier: null, rule, question, offer, hard: true });
    const rather = (rule: PilotQuery['rule'], question: string, offer: CommandAST | null): TaxiDoubt => ({ earlier: null, rule, question, offer, hard: false });
    const way = (w: { names: string[] } | null): string => w?.names.length ? this.pick(a, 'way', [`, we can take ${spoken(w.names)} if that works`, `, could we do ${spoken(w.names)} instead`, `, we had ${spoken(w.names)} planned, is that available`]) : ', say again the route';

    // 1. the stand: taken, or too small for us
    if (t.dest.kind === 'stand') {
      const ref = up(t.dest.ref); const g = e.gateByRef(ref);
      if (g) {
        const occ = e.standOccupant(ref), size = e.air.stands.find(s => up(s.ref) === ref)?.size ?? null;
        const small = size != null && (SPAN[size] ?? 80) < a.perf.wingspanMeters - 1.5 && up(a.plan.gateRef ?? '') !== ref;
        if ((occ && occ !== a.callsign) || small) {
          const alt = this.standFor(e, a, ref);
          const why = small ? `stand ${ref} is too small for us` : `${e.telephony(occ!)} has stand ${ref}`;
          return cannot('taxi_stand', alt ? `${why}, we could take ${alt}` : `unable, ${why}, request another stand`, alt ? { ...t, dest: { kind: 'stand', ref: alt }, via: [], auto: true, holdShortOf: null, cross: [], limit: null } : null);
        }
        if (a.plan.kind === 'arrival' && a.plan.gateRef && up(a.plan.gateRef) !== ref && this.once(e, `stand:${a.id}`, Infinity)) {
          return rather('taxi_stand', `company has us on stand ${a.plan.gateRef}, confirm ${ref}`, null);
        }
      }
    }
    // 2. a taxiway that is not here
    const unknown = t.via.map(up).find(v => !e.air.taxiwayNodes.has(v));
    if (unknown) { const w = this.ownWay(e, a, t); return cannot('taxi_unknown', `we don't see a taxiway ${spokenTaxiway(unknown)} on the chart${way(w)}`, w?.names.length ? w.ast : null); }
    if (t.holdShortOf?.kind === 'taxiway' && !e.air.taxiwayNodes.has(up(t.holdShortOf.taxiway))) return cannot('taxi_unknown', `we don't see a taxiway ${spokenTaxiway(t.holdShortOf.taxiway)} on the chart, say again the hold short point`, null);
    if (!t.via.length) return null;                     // "taxi to 28R": the crew picks its own way
    // 3. it does not connect
    const p = e.taxiPlan(a, t.dest, t.via);
    if ('code' in p) {
      if (p.code !== 'unable_route' && p.code !== 'no_route') return null;
      const w = this.ownWay(e, a, t); return cannot('taxi_route', `${spoken(t.via)} doesn't get us there${way(w)}`, w?.names.length ? w.ast : null);
    }
    const own = this.ownWay(e, a, t);
    const useful = own && own.names.length && own.names.join() !== t.via.map(up).join() ? own : null;
    // 4. too narrow for us (only when there is another way: with none the crew takes it slowly)
    const tight = taxiLimitsOf(e.air).firstRefused(p.ids, a.perf.wingspanMeters, a.plan.kind === 'departure');
    if (tight && useful) return cannot('taxi_width', `unable ${spokenTaxiway(tight)}, ${this.pick(a, 'wide', ["we're too wide for it", 'not enough wingtip clearance for us', `it's restricted for ${/^[AEIO]/i.test(e.spokenType(a)) ? 'an' : 'a'} ${e.spokenType(a)}`])}${way(useful)}`, useful.ast);
    // 5. too much at once
    const settings = e.settings as { personas?: boolean };
    if (settings.personas) {
      const load = t.via.length + t.cross.length + (t.holdShortOf ? 1 : 0), kind = personaOf(a.callsign).kind;
      if (load > TAXI_CONST.load[kind] && t.via.length >= 3 && !t.limit && this.once(e, `load:${a.id}`)) {
        const step = this.firstStep(e, a, t);
        const lead = this.pick(a, 'load', kind === 'visitor' ? ["we're not familiar here, that's a lot to copy", "first time in, that's a long one"] : ["that's a long one", 'that was a lot to copy', "we didn't get all of that"]);
        return rather('taxi_complex', step ? `${lead}, could we have it in steps, ${step.via.map(n => spokenTaxiway(n)).join(', ')}, hold short of ${spokenTaxiway((step.holdShortOf as { taxiway: string }).taxiway)} first` : `${lead}, say again slowly, or progressive taxi`, step);
      }
    }
    // 6. head-on with someone already on it
    const opp = this.headOn(e, a, p.ids);
    if (opp && this.once(e, `opp:${a.id}:${opp.other.id}`)) {
      const round = own && own.m < p.path.total * TAXI_CONST.offerMax + 800 && !this.headOn(e, a, own.ids) ? own : this.ownWay(e, a, t, opp.nodes);
      if (round && round.names.length && round.names.join() !== t.via.map(up).join() && !this.headOn(e, a, round.ids) && round.m < p.path.total * TAXI_CONST.offerMax + 800) {
        return rather('taxi_traffic', `${e.telephony(opp.other.callsign)} is coming the other way on ${spokenTaxiway(opp.taxiway)}, could we take ${spoken(round.names)}`, round.ast);
      }
    }
    // 7. the long way round: some captains ask
    const kind = personaOf(a.callsign).kind;
    if (settings.personas && useful && (kind === 'captain' || kind === 'line') && personaHash(`long:${a.callsign}`) % 2 === 0
      && p.path.total > useful.m * TAXI_CONST.longer && p.path.total - useful.m > TAXI_CONST.longerM && !this.headOn(e, a, useful.ids) && this.once(e, `long:${a.id}`, Infinity)) {
      return rather('taxi_long', `that's the long way round for us, any chance of ${spoken(useful.names)}`, useful.ast);
    }
    return null;
  }

  /** The first part of a long clearance, up to a taxiway the route meets about half way. */
  private firstStep(e: SimEngine, a: AircraftState, t: TaxiAst): TaxiAst | null {
    for (let k = Math.max(1, Math.min(3, Math.floor(t.via.length / 2))); k >= 1; k--) {
      const stop = up(t.via[k]), via = t.via.slice(0, k).map(up);
      if (via.includes(stop)) continue;
      const p = e.taxiPlan(a, t.dest, t.via); if ('code' in p) return null;
      const at = e.taxiMeets(p.path, stop); if (!at || at < 60) continue;
      const refs = new Set(p.path.holds!.filter(h => !h.isDepartureEntry && h.at < at).map(h => e.runwayState(h.runway)?.ref));
      const ast: TaxiAst = { ...t, via, auto: false, holdShortOf: { kind: 'taxiway', taxiway: stop }, cross: t.cross.filter(c => refs.has(e.runwayState(c)?.ref)), limit: 'hold' };
      const s = e.taxiPlan(a, t.dest, via); if ('code' in s || !e.taxiMeets(s.path, stop)) continue;
      return ast;
    }
    return null;
  }

  /** A stand we fit, free, as near as can be to the one that was given: our own one first. */
  private standFor(e: SimEngine, a: AircraftState, near: string): string | null {
    const free = (ref: string) => { const g = e.gateByRef(ref); if (!g || g.closed) return false; const occ = e.standOccupant(ref); return (!occ || occ === a.callsign) && !e.parkedOn(ref); };
    const fits = (ref: string) => { const s = e.air.stands.find(x => up(x.ref) === up(ref)); return !s || (SPAN[s.size] ?? 80) >= a.perf.wingspanMeters - 1.5; };
    if (a.plan.kind === 'arrival' && a.plan.gateRef && up(a.plan.gateRef) !== near && free(a.plan.gateRef) && fits(a.plan.gateRef)) return a.plan.gateRef;
    const s0 = e.air.stands.find(x => up(x.ref) === near); if (!s0) return null;
    let best: string | null = null, bd = 900;
    for (const s of e.air.stands) {
      if (up(s.ref) === near || !free(s.ref) || !fits(s.ref)) continue;
      const d = Math.hypot((s.lng - s0.lng) * Math.cos(s0.lat * Math.PI / 180), s.lat - s0.lat) * 111195;
      if (d < bd) { bd = d; best = s.ref; }
    }
    return best;
  }

  /** Someone the crew can see or hear coming the other way along our route, and we would meet on it. */
  private headOn(e: SimEngine, a: AircraftState, ids: string[]): { other: AircraftState; taxiway: string; nodes: Set<string> } | null {
    const C = TAXI_CONST; const at: number[] = [0];
    for (let i = 1; i < ids.length; i++) at[i] = at[i - 1] + dist(e.nodeXY(ids[i - 1])!, e.nodeXY(ids[i])!);
    const mine = new Map<string, number>(); for (let i = 1; i < ids.length && at[i - 1] < C.lookM; i++) mine.set(`${ids[i - 1]}>${ids[i]}`, i);
    for (const b of e.aircraft) {
      if (b === a || isAirborne(b) || (b.phase !== 'taxi' && b.phase !== 'hold_short') || b.onFrequency !== a.onFrequency) continue;
      const theirs = e.routeAhead(b); if (theirs.length < 2) continue;
      let shared = 0, first = Infinity, last = -1, taxiway: string | null = null, theirM = 0, theirEnd = 0; const nodes = new Set<string>();
      for (let j = 1; j < theirs.length; j++) {
        const m = dist(e.nodeXY(theirs[j - 1])!, e.nodeXY(theirs[j])!); theirM += m;
        const i = mine.get(`${theirs[j]}>${theirs[j - 1]}`); if (i == null) continue;
        shared += m; first = Math.min(first, at[i - 1]); last = Math.max(last, i); theirEnd = theirM; nodes.add(theirs[j - 1]); nodes.add(theirs[j]);
        taxiway ??= e.air.nodes.get(theirs[j - 1])?.edges.find(x => x.to === theirs[j])?.taxiway ?? null;
      }
      if (shared < C.sharedM || !taxiway) continue;
      if (b.phase === 'taxi' && theirEnd / C.taxiMps + C.marginS < first / C.taxiMps) continue;       // off it before we get there
      const theirStart = theirEnd - shared;
      if (at[last] / C.taxiMps + C.marginS < theirStart / C.taxiMps) continue;                       // we are off it before they get there
      return { other: b, taxiway, nodes };
    }
    return null;
  }

  /** "Hold short of F" when F is behind us or not on our way: what we can do instead. */
  private holdShort(e: SimEngine, a: AircraftState, of: HoldShortTarget): TaxiDoubt | null {
    if (of.kind !== 'taxiway' || !a.path || (a.phase !== 'taxi' && a.phase !== 'hold_short')) return null;
    const name = up(of.taxiway);
    if (!e.air.taxiwayNodes.has(name)) return { earlier: null, rule: 'taxi_unknown', hard: true, offer: null, question: `we don't see a taxiway ${spokenTaxiway(name)} on the chart, say again the hold short point` };
    if (e.taxiMeets(a.path, name, a.distAlong + 25)) return null;
    const behind = e.taxiMeets(a.path, name) != null || (a.plan.taxiRoute ?? []).map(up).includes(name);
    let next: { name: string; at: number } | null = null;
    for (const n of e.air.taxiwayNames) { if (up(n) === name || n === e.taxiwayUnder(a)) continue; const at = e.taxiMeets(a.path, up(n), a.distAlong + 80); if (at && (!next || at < next.at)) next = { name: up(n), at }; }
    const why = behind ? `unable, we're already past ${spokenTaxiway(name)}` : `${spokenTaxiway(name)} isn't on our route`;
    return { earlier: null, rule: 'taxi_hold', hard: true, question: next ? `${why}, we can hold short of ${spokenTaxiway(next.name)}` : `${why}, say again`,
      offer: next ? { kind: 'holdShort', callsign: a.callsign, of: { kind: 'taxiway', taxiway: next.name } } as CommandAST : null };
  }

  /** A taxi call the crew could not make sense of at all (it did not parse): what they ask back. null: a plain "say again". */
  static unclear(e: SimEngine, a: AircraftState, code: string | undefined, token: string | null, text: string): string | null {
    if (isAirborne(a) || !/\b(?:taxi|via|stand|gate|hold short)\b/i.test(text)) return null;
    if (code === 'unknown_taxiway' || (/\bvia\b/i.test(text) && token && /^[A-Z]{1,2}\d{0,2}$/.test(token))) return token && /^[A-Z]{1,2}\d{0,2}$/.test(token) ? `we don't see a taxiway ${spokenTaxiway(token)} on the chart, say again the route` : 'say again the taxi route, we missed a taxiway';
    if (code === 'unknown_stand') return a.plan.kind === 'arrival' && a.plan.gateRef ? `say again the stand, company has us on ${a.plan.gateRef}` : 'say again the stand';
    if (code === 'missing_param' && /\btaxi\b/i.test(text)) return a.plan.kind === 'departure' ? 'say again, taxi to which runway' : 'say again, taxi to which stand';
    return null;
  }
}

const MINDS = new WeakMap<object, TaxiMind>();
remembersNames(e => MINDS.get(e));
export function taxiMindOf(engine: object): TaxiMind {
  let m = MINDS.get(engine); if (!m) { m = new TaxiMind(); MINDS.set(engine, m); }
  return m;
}
