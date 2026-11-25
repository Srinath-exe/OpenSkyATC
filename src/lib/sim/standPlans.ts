// Per-airport stand plans, written by scripts/gatelab.sh <ICAO> fix (see pushPlan.ts).
import type { StandPlan } from './pushPlan';
import noway from './standplans/noway.json';
import together from './standplans/together.json';
import KSFO from './standplans/KSFO.json';
import KJFK from './standplans/KJFK.json';
import LFPG from './standplans/LFPG.json';
import WSSS from './standplans/WSSS.json';
import RJTT from './standplans/RJTT.json';
import OMDB from './standplans/OMDB.json';

const PLANS: Record<string, unknown> = { KSFO, KJFK, LFPG, WSSS, RJTT, OMDB };
/** Parts of an airport the game does not use: no one parks there or is sent there (kept apart from the generated plans, so
 *  running "fix" again does not bring them back). SFO: United's maintenance base north of the 10L end. */
const UNUSED: Record<string, RegExp> = { KSFO: /^(50-\d+|R(8[3-9]|9\d|10\d|11[0-2]))$/ };
/** Stands the gate lab found no clean way in or out of on the map we have (written by scripts/gatelab/settle.cjs). */
const NO_WAY = noway as Record<string, string[]>;
const noWaySets = new Map(Object.entries(NO_WAY).map(([k, v]) => [k, new Set(v)]));
/** Gates that look right but have no clean push or taxi out: aircraft stand there, no traffic uses them. */
const SHOW_ONLY: Record<string, Set<string>> = { RJTT: new Set(['59', '65', '66']), KJFK: new Set(['35', '39', '41', '43', '45', 'A2', '507', '8X', 'A8', 'B29A']) };
export function standShowOnly(icao: string, ref: string): boolean { return !!SHOW_ONLY[icao]?.has(ref); }
export function standUnused(icao: string, ref: string): boolean { return !!UNUSED[icao]?.test(ref) || !!noWaySets.get(icao)?.has(ref); }
/** Stands that got in each other's way in whole sessions (scripts/gatelab/settle-traffic.cjs), on top of the plan's own pairs. */
const merged = new Map<string, StandPlan>();
export function standPlanOf(icao: string): StandPlan | null {
  const p = PLANS[icao] as StandPlan | undefined; if (!p?.sig) return null;
  let m = merged.get(icao); if (!m) { const more = (together as unknown as Record<string, [string, string][]>)[icao]; m = more?.length ? { ...p, clash: [...p.clash, ...more] } : p; merged.set(icao, m); }
  return m;
}
/** Airports with a reviewed plan: their dead-end lanes are run on to the stands they serve (osmAirport.ts). The gate lab
 *  adds the airport it is working on. Listing an airport in PLANS is what switches all of it on. */
export const laneFixFor = new Set<string>(Object.keys(PLANS));
