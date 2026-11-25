/*
  The textured fleet: FlightGear's AI aircraft (GNU GPL v2, converted by scripts/fleet/convert_fg.py into
  public/models/fleet/), one model per type and one texture set per airline livery. Which model a type uses
  (FLEET_TYPES) and which livery an airline wears (AIRLINE_LIVERIES) are decided here; a type or airline without one
  falls back to the community model with the procedural livery (models.ts).
*/

export const FLEET_V = '1';
const BASE = '/models/fleet';

interface FleetLivery { xml: string; tex: Record<string, string> }
interface FleetModel { glb: string; type: string; textures: string[]; gear: boolean; tris: number; description: string; authors: string; liveries: Record<string, FleetLivery> }
interface FleetIndex { models: Record<string, FleetModel> }

/** Our ICAO type -> the fleet model keys to try (folder/model), best first; `prefix` picks the variant's liveries. */
export const FLEET_TYPES: Record<string, { keys: string[] }> = {
  B733: { keys: ['733/733'] }, B734: { keys: ['734/73P'] }, B735: { keys: ['735/735'] }, B736: { keys: ['736/736'] },
  B737: { keys: ['736/736', '733/73C', '738/737-800', '739/73J', '733/733', '735/735', '734/73P'] }, B738: { keys: ['738/737-800', '739/73J', '733/73C', '733/733', '736/736', '735/735', '734/73P'] }, B38M: { keys: ['738/737-800', '739/73J', '733/73C', '733/733', '736/736', '735/735', '734/73P'] },
  B739: { keys: ['739/73J', '738/737-800', '733/73C', '733/733', '736/736', '735/735', '734/73P'] }, B39M: { keys: ['739/73J', '738/737-800', '733/73C', '733/733', '736/736', '735/735', '734/73P'] }, B712: { keys: ['717/717'] },
  B752: { keys: ['757/757-200'] }, B753: { keys: ['757/757-300'] }, B763: { keys: ['767/763', '767/76W', '767/76Y'] }, B764: { keys: ['767/76Y'] },
  B772: { keys: ['777/77L', '777/77W', '777/77F'] }, B77L: { keys: ['777/77L'] }, B77W: { keys: ['777/77W', '777/77L', '777/77F'] },
  B788: { keys: ['787/788', '787/789'] }, B789: { keys: ['787/789', '787/788'] }, B78X: { keys: ['787/789'] },
  B744: { keys: ['747/744', '747/74Y', '747/74F'] }, B748: { keys: ['747/74N', '747/744', '747/74Y', '747/74F'] }, VC25: { keys: ['747/744'] },
  A319: { keys: ['A319/A319', 'A320/A320', 'A321/A321'] }, A320: { keys: ['A320/A320', 'A321/A321', 'A319/A319'] }, A20N: { keys: ['A320/A320', 'A321/A321', 'A319/A319'] }, A321: { keys: ['A321/A321', 'A320/A320', 'A319/A319'] }, A21N: { keys: ['A321/A321', 'A320/A320', 'A319/A319'] },
  A332: { keys: ['A332/A332', 'A333/A333'] }, A333: { keys: ['A333/A333', 'A332/A332'] }, A339: { keys: ['A333/A333', 'A332/A332'] }, A343: { keys: ['A343/A343'] }, A346: { keys: ['A346/A346'] },
  A359: { keys: ['A350/359'] }, A35K: { keys: ['A350/359'] }, A388: { keys: ['A380/388'] },
  E170: { keys: ['E70/ERJ170'] }, E175: { keys: ['E70/ERJ175', 'E70/ERJ170', 'E90/E90', 'CR9/CR9'] }, E190: { keys: ['E90/E90', 'E95/E95', 'E70/ERJ175'] }, E195: { keys: ['E95/E95', 'E90/E90'] },
  CRJ7: { keys: ['CR7/CR7', 'CR9/CR9'] }, CRJ9: { keys: ['CR9/CR9', 'CR7/CR7', 'E70/ERJ175'] }, DH8D: { keys: ['DH4/DH4'] }, AT76: { keys: ['AT7/AT7'] }, AT72: { keys: ['AT7/AT7'] },
  MD11: { keys: ['M11/M1F'] }, C172: { keys: ['c172/c172p'] }, PA28: { keys: ['pa-28/pa-28'] }, F18: { keys: ['F-4/F-4_lowpoly'] }, F35: { keys: ['F-4/F-4_lowpoly'] }, C17: { keys: ['777/77F', '777/77W'] },
  BCS1: { keys: ['220/223'] }, BCS3: { keys: ['220/223'] }, MD82: { keys: ['MD80/md-80'] }, MD88: { keys: ['MD80/md-80'] },
};

/** Livery name aliases (lowercase, letters and digits only) per airline ICAO code. Longest match wins. */
const AIRLINE_LIVERIES: Record<string, string[]> = {
  BAW: ['britishairways', 'ba'], VIR: ['virginatlantic'], EIN: ['aerlingus'], EZY: ['easyjet'], RYR: ['ryanair'],
  DLH: ['lufthansa'], AFR: ['airfrance'], TRA: ['transavia'], KLM: ['klm'], SWR: ['swiss'], UAE: ['emirates'],
  FDB: ['flydubai'], QTR: ['qatar'], ETD: ['etihad'], THY: ['turkish', 'thy'], AIC: ['airindia'], IGO: ['indigo'],
  SIA: ['singapore', 'sia'], SCO: ['scoot'], CPA: ['cathay'], HKE: ['hkexpress'], CES: ['chinaeastern'],
  CCA: ['airchina'], ANA: ['ana', 'allnippon'], JAL: ['jal', 'japanairlines'], QFA: ['qantas'],
  VOZ: ['virginaustralia'], JST: ['jetstar'], ANZ: ['airnewzealand', 'airnz'], UAL: ['united'],
  AAL: ['american', 'aa'], DAL: ['delta'], SWA: ['southwest'], JBU: ['jetblue'], ASA: ['alaska'], SKW: ['skywest'],
  FDX: ['fedex'], UPS: ['ups'], EVA: ['eva'], SJX: ['starlux'], ACA: ['aircanada'], KAL: ['korean'], AAR: ['asiana'],
  CAL: ['chinaairlines'], CSN: ['chinasouthern'], HAL: ['hawaiian'], AFL: ['aeroflot'], SAS: ['sas'], IBE: ['iberia'],
  AZA: ['alitalia', 'ita'], AUA: ['austrian'], TAP: ['tap'], ELY: ['elal'], SVA: ['saudia'], ETH: ['ethiopian'],
  MAS: ['malaysia'], THA: ['thai'], GIA: ['garuda'], PAL: ['philippine'], VIV: ['vivaaerobus'], AMX: ['aeromexico'],
  WJA: ['westjet'], NKS: ['spirit'], FFT: ['frontier'],
}
// a few variants FlightGear names differently (express / connection brands fly for their mainline partner)
const PREFER_OVER: Record<string, string[]> = { 'american': ['americaneagle'], 'united': ['unitedexpress'], 'delta': ['deltaconnection'], 'aircanada': ['aircanadaexpress', 'aircanadarouge'] }

let index: FleetIndex | null = null;
let loading: Promise<FleetIndex | null> | null = null;
export function loadFleetIndex(): Promise<FleetIndex | null> {
  if (index) return Promise.resolve(index);
  loading ??= fetch(`${BASE}/index.json?v=${FLEET_V}`).then((r) => r.ok ? r.json() as Promise<FleetIndex> : null).then((j) => (index = j)).catch(() => null).then((j) => { if (!j) setTimeout(() => { loading = null; }, 5000); return j; });   // (a failed download is asked for again)
  return loading;
}

/** Tests: use an index read from disk. */
export function setFleetIndex(j: FleetIndex): void { index = j; }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The livery of `model` an airline wears, or null. Livery names are like "UnitedAirlines", "788-United", "Delta-2019". */
function liveryOf(model: FleetModel, airline: string): string | null {
  const aliases = AIRLINE_LIVERIES[airline]; if (!aliases) return null;
  let best: string | null = null, bestScore = 0;
  for (const name of Object.keys(model.liveries)) {
    // drop the variant prefix ("788-", "ERJ175-", "77W-": capitals with a digit) and keep the airline part
    const k = norm(name.replace(/^(?=[A-Z]*\d)[A-Z0-9]{2,7}-/, ''));
    for (const a of aliases) {
      if (!k.startsWith(a)) continue;
      const rest = k.slice(a.length);
      const partner = PREFER_OVER[a]?.some((x) => k.startsWith(x)) ? 40 : 0;   // "americaneagle": only when there is no mainline livery
      if (a.length <= 3 && rest && !/^(\d|new|old|retro|airlines|airways|air|cargo)/.test(rest)) continue;   // "ba" must not match "bangkok"
      const score = a.length * 10 - rest.length - partner + 50;
      if (score > bestScore) { bestScore = score; best = name; }
    }
  }
  return best;
}

export interface FleetPick { key: string; glb: string; livery: string; tex: Record<string, string> }
/** A regional flying for a mainline partner wears the partner's express livery (SkyWest at SFO: United Express). */
const PARTNER: Record<string, string> = { SKW: 'UAL' };
const liveryFor = (m: FleetModel, airline: string): string | null => liveryOf(m, airline) ?? (PARTNER[airline] ? liveryOf(m, PARTNER[airline]) : null);
/** The fleet model and livery for a flight: our type + the callsign's airline. Null = use the fallback model. */
export function fleetPick(type: string, callsign: string | undefined): FleetPick | null {
  if (!index) return null;
  const t = FLEET_TYPES[type.toUpperCase()] ?? FLEET_TYPES.A320;
  const airline = /^[A-Z]{3}/.test(callsign ?? '') ? callsign!.slice(0, 3) : '';
  for (const key of t.keys) {
    const m = index.models[key]; if (!m) continue;
    const livery = airline ? liveryFor(m, airline) : null;
    if (livery) return { key, glb: `${BASE}/${m.glb}?v=${FLEET_V}`, livery, tex: m.liveries[livery].tex };
  }
  // no livery of its own (a scripted flight): the proper airframe in its plain house paint, never another model
  for (const key of t.keys) { const p = plain(key); if (p) return p; }
  return null;
}
/** A 3D file in its plain paint. */
function plain(key: string): FleetPick | null {
  const m = index?.models[key]; if (!m) return null;
  const n = Object.keys(m.liveries), livery = n.find((x) => /^default$/i.test(x)) ?? n.find((x) => /default/i.test(x)) ?? n[0];
  return { key, glb: `${BASE}/${m.glb}?v=${FLEET_V}`, livery: livery ?? '', tex: livery ? m.liveries[livery].tex : {} };
}
/** The livery of one 3D file for an airline (the file an aircraft was built from decides, not its type: several types share
 *  a file, and dressing it by another type's choice wrapped that type's texture sheet round the wrong airframe). */
export function fleetDress(key: string, callsign: string | undefined): FleetPick | null {
  const m = index?.models[key]; if (!m) return null;
  const airline = /^[A-Z]{3}/.test(callsign ?? '') ? callsign!.slice(0, 3) : '';
  const livery = airline ? liveryFor(m, airline) : null;
  return livery ? { key, glb: `${BASE}/${m.glb}?v=${FLEET_V}`, livery, tex: m.liveries[livery].tex } : plain(key);
}
/** Texture ids are 16-hex content hashes; a 17th character "a" marks a texture with transparency. */
export const fleetTexUrl = (h: string) => `${BASE}/tex/${h.slice(0, 16)}.webp?v=${FLEET_V}`;
export const fleetTexAlpha = (h: string) => h.length > 16;
