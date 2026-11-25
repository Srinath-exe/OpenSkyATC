// Gate lab: every stand, pushback, taxi route and driven path of an airport, checked as plain geometry. It calls the
// game's own functions (stands, pushbackPath, planTaxi, buildPath) and never steps the clock, so thousands of cases run
// in seconds.   scripts/gatelab.sh KSFO [gates|push|out|in|all]   (STANDS=B2,C1 TYPES=A320,B77W RWYS=28L V=1 OUT=file)
import * as fs from 'node:fs';
import { makeEngine } from '../../tests/engine/helpers';
import { Poly, segSeg, inPoly, polyDist, dims, shape, shapeDist, wiggles } from './geom';
import { dist, headingTo, angleDelta, advance, sampleAlong, distToSegment, XY } from '../../src/lib/sim/projection';
import { AIRCRAFT_DB } from '../../src/lib/sim/aircraftDB';
import { profileOf, AIRLINE_BY_ICAO, sizeFits } from '../../src/lib/sim/airlines';
import { laneFixFor } from '../../src/lib/sim/standPlans';
import { SimEngine } from '../../src/lib/sim/engine';
import { pushCandidates, pushRaw, tightestTurn, PushOption } from '../../src/lib/sim/pushPlan';
import { findPath, pathCache, taxiwaysForPath } from '../../src/lib/osmAirport';
import { taxiLimitsOf } from '../../src/lib/sim/taxiLimits';

const ICAO = process.argv[2] ?? 'KSFO', WHAT = (process.argv[3] ?? 'all').split(',');
const want = (k: string) => WHAT.includes('all') || WHAT.includes(k);
const V = !!process.env.V, list = (k: string) => process.env[k]?.split(',');
laneFixFor.add(ICAO);
const REPUSH = WHAT.includes('repush'), FIX = WHAT.includes('fix') || REPUSH; SimEngine.noStandPlans = (FIX && !REPUSH) || !!process.env.RAW;
const e = makeEngine(ICAO, { seed: 1 }); const E = e as any; const air = E.air; if (process.env.NAMING === 'simple' && !FIX) E.setNaming('simple');
const xy = (p: { lat: number; lng: number }): XY => e.proj.toXY(p.lat, p.lng);
const ll = (p: XY) => { const q = e.proj.toLngLat(p.x, p.y) as any; return `${q.lat.toFixed(5)},${q.lng.toFixed(5)}`; };
const t00 = Date.now(); pathCache.map = new Map();

// ── the field ───────────────────────────────────────────────────────────────
const buildings: { name: string; pts: Poly; x0: number; x1: number; y0: number; y1: number }[] = air.buildings.filter((b: any) => b.kind === 'terminal' || b.kind === 'hangar').map((b: any) => { const pts = b.polygon.map(xy); return { name: b.name ?? b.kind, pts, x0: Math.min(...pts.map((q: XY) => q.x)), x1: Math.max(...pts.map((q: XY) => q.x)), y0: Math.min(...pts.map((q: XY) => q.y)), y1: Math.max(...pts.map((q: XY) => q.y)) }; });
// walls on a 25 m grid (each wall in every cell within 25 m of it)
const BC = 25; const wallGrid = new Map<string, [XY, XY][]>();
for (const b of buildings) for (let i = 0; i < b.pts.length; i++) { const u = b.pts[i], v = b.pts[(i + 1) % b.pts.length]; const n = Math.max(1, Math.ceil(dist(u, v) / 12)); const cells = new Set<string>(); for (let k = 0; k <= n; k++) { const x = u.x + (v.x - u.x) * k / n, y = u.y + (v.y - u.y) * k / n; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(`${Math.floor(x / BC) + dx},${Math.floor(y / BC) + dy}`); } for (const c of cells) { let l = wallGrid.get(c); if (!l) wallGrid.set(c, l = []); l.push([u, v]); } }
/** Clearance of an aircraft shape to the walls, up to about 20 m (25 beyond that). */
const bldDist = (S: Poly[], _p?: XY): number => { let d = 25; const done = new Set<[XY, XY]>(); for (const g of S) for (let i = 0; i < g.length; i++) { const a = g[i], b = g[(i + 1) % g.length]; const n = Math.max(1, Math.ceil(dist(a, b) / 12)); for (let k = 0; k <= n; k++) { const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n; for (const w of wallGrid.get(`${Math.floor(x / BC)},${Math.floor(y / BC)}`) ?? []) { if (done.has(w)) continue; done.add(w); for (const q of S) for (let t = 0; t < q.length; t++) { d = Math.min(d, segSeg(q[t], q[(t + 1) % q.length], w[0], w[1])); if (d === 0) return 0; } } } } return d; };
const nearBld = (p: XY, r: number) => buildings.filter(b => p.x > b.x0 - r && p.x < b.x1 + r && p.y > b.y0 - r && p.y < b.y1 + r);
const ptBld = (p: XY) => { let d = Infinity; for (const b of nearBld(p, 200)) { if (inPoly(p, b.pts)) return 0; for (let i = 0; i < b.pts.length; i++) d = Math.min(d, distToSegment(p, b.pts[i], b.pts[(i + 1) % b.pts.length])); } return d; };
// painted lines on a 40 m grid
const C = 40; const grid = new Map<string, { a: XY; b: XY; name: string; lead: boolean; rwy: boolean }[]>();
for (const [id, n] of air.nodes) for (const ed of n.edges) { if (id > ed.to) continue; const a = E.nodeXY(id), b = E.nodeXY(ed.to), s = { a, b, name: ed.taxiway ?? '', lead: !!ed.leadIn, rwy: ed.type === 'runway' }; for (let gx = Math.floor((Math.min(a.x, b.x) - 40) / C); gx <= Math.floor((Math.max(a.x, b.x) + 40) / C); gx++) for (let gy = Math.floor((Math.min(a.y, b.y) - 40) / C); gy <= Math.floor((Math.max(a.y, b.y) + 40) / C); gy++) { const k = gx + ',' + gy; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(s); } }
const lineDist = (p: XY, leads = true) => { let d = 40; for (const s of grid.get(Math.floor(p.x / C) + ',' + Math.floor(p.y / C)) ?? []) if (leads || !s.lead) d = Math.min(d, distToSegment(p, s.a, s.b)); return d; };

const carriers = Object.keys(profileOf(ICAO).carriers);
const types = [...new Set(carriers.flatMap(c => Object.keys(AIRLINE_BY_ICAO[c]?.fleet ?? {})))].filter(t => AIRCRAFT_DB[t]).sort((a, b) => AIRCRAFT_DB[a].wingspanMeters - AIRCRAFT_DB[b].wingspanMeters || AIRCRAFT_DB[a].lengthMeters - AIRCRAFT_DB[b].lengthMeters);
interface G { ref: string; st: any; p: XY; h: number; big: string; fits: string[]; gate: any }
const gates: G[] = E.gates.filter((g: any) => !g.closed && E.standOf(g)).map((g: any) => { const st = E.standOf(g); const fits = types.filter(t => sizeFits(t, st.size) && (!E.standFits || E.standFits(g, t))); const big = fits[fits.length - 1] ?? types[0]; return { ref: g.ref, st, p: E.gateXY(g), h: E.standHeading(g), big, fits, gate: g }; });
const parked = new Map(gates.map(g => [g.ref, shape(g.big, g.p, g.h)] as const));
const near = new Map(gates.map(g => [g.ref, gates.filter(o => o !== g && dist(o.p, g.p) < 260 && !E.clashOf.get(g.ref)?.has(o.ref))] as const));
const [SI, SN] = (process.env.SHARD ?? '0/1').split('/').map(Number);
const pick = gates.filter(g => !list('STANDS') || list('STANDS')!.includes(g.ref)).filter((_, i) => i % SN === SI);
const RWYS: string[] = list('RWYS') ?? [...new Set(E.runways.map((r: any) => r.name as string))] as string[];
const report: Record<string, any[]> = {}; let cases = 0;
const flag = (kind: string, o: any) => (report[kind] ??= []).push(o);


const wbOf = (t: string) => Math.max(2.5, dims(t).lengthMeters * 0.37);

// ── shared: two stands that take up the same ground as drawn - one's way in runs through an aircraft parked on the other, or
//    its painted line or box lies over the other's box. The "never both at once" pairs are NOT left out here: the game never
//    parks on both, but both are painted. ──
const ENVELOPE: Record<string, [number, number]> = { A: [15, 13], B: [24, 24], C: [36, 40], D: [52, 56], E: [65, 70], F: [80, 76] };
const boxOf = (g: G): Poly => { const n = gates.reduce((d, o) => (o === g ? d : Math.min(d, dist(o.p, g.p))), Infinity); const [sp, len] = ENVELOPE[g.st.size] ?? ENVELOPE.C, half = Math.max(8, Math.min(sp / 2 + 2, n / 2 - 1.5)); const at = (f: number, l: number) => advance(advance(g.p, g.h, f), g.h + 90, l); return [at(4, -half), at(4, half), at(2 - len, half), at(2 - len, -half)]; };
const boxes = new Map(gates.map(g => [g.ref, boxOf(g)] as const));
const wayOf = (g: G): Poly[][] => { const o: Poly[][] = []; const L = g.st.leadInPts.map(xy).reverse() as XY[]; let acc = 0; for (let i = 1; i < L.length; i++) { const h = headingTo(L[i], L[i - 1]), n = dist(L[i - 1], L[i]); for (let s = 4; s <= n && acc + s < 120; s += 4) o.push(shape(g.big, advance(L[i - 1], h + 180, s), h)); acc += n; } return o; };
/** metres of g's painted straight lead-in that lie inside o's box */
const lineIn = (g: G, o: G) => { const L = g.st.leadInPts.map(xy) as XY[], B = boxes.get(o.ref)!; let m = 0; for (let i = 1; i < L.length; i++) { const n = dist(L[i - 1], L[i]); for (let s = 0.5; s < n; s += 1) if (inPoly({ x: L[i - 1].x + (L[i].x - L[i - 1].x) * s / n, y: L[i - 1].y + (L[i].y - L[i - 1].y) * s / n }, B)) m++; } return m; };
const sharedPairs = () => {
  const out: { a: string; b: string; rel: number; stops: number; gap: number; wayA: number; wayB: number; lineA: number; lineB: number; boxes: number; pair: boolean }[] = [];
  for (let i = 0; i < gates.length; i++) for (let j = i + 1; j < gates.length; j++) {
    const x = gates[i], y = gates[j], d = dist(x.p, y.p); if (d > 160) continue; const rel = Math.abs(angleDelta(x.h, y.h)); if (rel > 125) continue;
    const A = boxes.get(x.ref)!, B = boxes.get(y.ref)!, gap = shapeDist(parked.get(x.ref)!, parked.get(y.ref)!);
    const wayA = Math.min(30, ...wayOf(x).map(P => shapeDist(P, parked.get(y.ref)!))), wayB = Math.min(30, ...wayOf(y).map(P => shapeDist(P, parked.get(x.ref)!)));
    // how deep the boxes lie over each other (a shared edge is how tight rows are painted)
    let over = 0; for (const [P, Q] of [[A, B], [B, A]]) for (let t = 0; t < 4; t++) for (let s = 0; s <= 1; s += 0.05) { const q = { x: P[t].x + (P[(t + 1) % 4].x - P[t].x) * s, y: P[t].y + (P[(t + 1) % 4].y - P[t].y) * s }; if (inPoly(q, Q)) over = Math.max(over, Math.min(...[0, 1, 2, 3].map(k => distToSegment(q, Q[k], Q[(k + 1) % 4])))); }
    const o = { a: x.ref, b: y.ref, rel: Math.round(rel), stops: Math.round(d), gap: +gap.toFixed(1), wayA: +wayA.toFixed(1), wayB: +wayB.toFixed(1), lineA: lineIn(x, y), lineB: lineIn(y, x), boxes: +over.toFixed(1), pair: !!E.clashOf.get(x.ref)?.has(y.ref) };
    if (gap < 2 || wayA < 1.5 || wayB < 1.5 || o.lineA > 2 || o.lineB > 2 || over > 3) out.push(o);
  }
  return out;
};
if (WHAT.includes('pairs')) { for (const o of sharedPairs()) { const z = (r: string) => { const g = gates.find(q => q.ref === r)!; return g.st.size + (g.st.named ? '' : '?') + (g.st.type === 'gate' ? 'g' : 'r'); }; console.log(ICAO, o.a, z(o.a), o.b, z(o.b), JSON.stringify(o).replace(/"/g, '').replace(/a:.*?,rel/, 'rel')); } process.exit(0); }

// ── fix: make the airport's stand plan ──────────────────────────────────────
if (FIX) {
  const ORD = ['A', 'B', 'C', 'D', 'E', 'F'], env = (z: string) => 'ENV:' + z;
  const S = new Map<string, { g: G; z: string; rank: number }>(gates.map(g => [g.ref, { g, z: g.st.size as string, rank: !g.st.named ? 2 : /#\d+$/.test(g.ref) || /^[A-Z]*\d+[A-Z]$/.test(g.ref) ? 1 : 0 }]));
  const size0 = new Map(gates.map(g => [g.ref, g.st.size as string]));
  const drop: Record<string, string> = {}, clash = new Set<string>(), push: Record<string, PushOption[]> = {};
  const alive = () => [...S.values()].filter(x => !(x.g.ref in drop));
  const body = (x: { g: G; z: string }) => shape(env(x.z), x.g.p, x.g.h);
  const nbOf = (x: { g: G }) => near.get(x.g.ref)!.map(o => S.get(o.ref)!).filter(o => !(o.g.ref in drop));
  const kill = (ref: string, why: string) => { drop[ref] = why; };
  const laneGap = (P: Poly[]) => { let d = 40; for (const g of P) for (let i = 0; i < g.length; i++) { const a = g[i]; for (const s of grid.get(Math.floor(a.x / C) + ',' + Math.floor(a.y / C)) ?? []) if (!s.lead) d = Math.min(d, segSeg(a, g[(i + 1) % g.length], s.a, s.b)); } return d; };
  const less = (z: string) => ORD[Math.max(1, ORD.indexOf(z) - 1)];
  // 1. what physically fits: clear of the walls, and 15 m off every lane
  if (!REPUSH) for (const x of alive()) {
    const jl = air.nodes.get(x.g.st.entryNodeId).edges.filter((q: any) => !q.leadIn && q.type !== 'runway');
    const ok = (z: string) => { if (z > 'C' && jl.length && jl.every((q: any) => taxiLimitsOf(air).tooWide(x.g.st.entryNodeId, q.to, dims(env(z)).wingspanMeters))) return false; const P = shape(env(z), x.g.p, x.g.h); return bldDist(P) >= 1.5 && laneGap(P) >= (x.rank ? 15 : 12); };
    let z = x.z; while (z > 'B' && !ok(z)) z = less(z);
    if (ok(z)) x.z = z; else if (x.rank === 2 || x.g.st.type !== 'gate') kill(x.g.ref, laneGap(shape(env('B'), x.g.p, x.g.h)) < 12 ? 'on a taxilane' : 'against a building');
    else x.z = 'C';
  }
  // 2. the unnamed lines drawn over a real gate or its way in, and stands parked on top of each other
  const corridor = (x: { g: G; z: string }): Poly[][] => { const out: Poly[][] = []; const L = x.g.st.leadInPts.map(xy).reverse(); let acc = 0; for (let i = 1; i < L.length; i++) { const h = headingTo(L[i], L[i - 1]); const n = dist(L[i - 1], L[i]); for (let s = 6; s <= n && acc + s < 150; s += 8) out.push(shape(env(x.z), advance(L[i - 1], h + 180, s), h)); acc += n; } return out; };
  const cor = new Map<string, Poly[][]>();
  for (const x of alive()) cor.set(x.g.ref, corridor(x));
  const inWay = (x: { g: G; z: string }, o: { g: G; z: string }) => { const B = body(o); return cor.get(x.g.ref)!.some(P => shapeDist(P, B) < 1); };
  if (!REPUSH) for (const x of alive()) for (const o of nbOf(x)) {
    if (x.g.ref in drop || o.g.ref in drop) continue;
    if (x.rank < 2 && o.rank === 2 && (shapeDist(body(x), body(o)) < 2 || inWay(x, o) || inWay(o, x))) kill(o.g.ref, `drawn over ${x.g.ref}`);
    else if (x.rank === 2 && o.rank === 2 && x.g.ref < o.g.ref && (shapeDist(body(x), body(o)) < 1 || inWay(x, o) || inWay(o, x))) { if (x.z > 'C' || o.z > 'C') { const b = x.z >= o.z ? x : o; b.z = less(b.z); cor.set(b.g.ref, corridor(b)); } if (shapeDist(body(x), body(o)) < 1 || inWay(x, o) || inWay(o, x)) { const bad = inWay(x, o) ? x : o; kill(bad.g.ref, `one behind the other with ${bad === x ? o.g.ref : x.g.ref}`); } }
  }
  if (!REPUSH) for (let pass = 0; pass < 6; pass++) for (const x of alive()) for (const o of nbOf(x)) {
    if (x.g.ref in drop || o.g.ref in drop || x.g.ref > o.g.ref) continue;
    if (shapeDist(body(x), body(o)) >= 2) continue;
    const b = x.z > o.z ? x : o.z > x.z ? o : x.rank >= o.rank ? x : o;
    if (b.z > 'B') { b.z = less(b.z); continue; }
    const out = x.rank !== o.rank ? (x.rank > o.rank ? x : o) : x.g.ref.length > o.g.ref.length ? x : o; kill(out.g.ref, `on top of ${out === x ? o.g.ref : x.g.ref}`);
  }
  // 3. pushes: every candidate swept against the neighbours and the walls
  const DEP = (E.runways as any[]).map(r => E.runwayByEnd(r.name)?.end.nodeId).filter(Boolean);
  const reach = (o: PushOption, nose: number) => DEP.filter((n: string) => findPath(air, o.at, n, { maxTurnDeg: 120, startHeading: nose })).length;
  const sweep = (type: string, g: G, pts: XY[], cum: number[], total: number, nb: { g: G; z: string }[], own: Map<string, number>, stop: number) => {
    const wb = wbOf(type); let h = g.h, prev = h, turned = 0; const hit = new Set<string>(); let gap = 20, wall = 25, off = 0, pos = g.p;
    const w0 = bldDist(shape(type, g.p, g.h));
    for (let s = 0; s <= total; s += 4) {
      const q = sampleAlong(pts, cum, s); for (let k = 0; k < 4; k++) { const d = angleDelta(h, (q.heading + 180) % 360); h = (h + Math.sign(d) * Math.min(Math.abs(d), 8) + 360) % 360; }
      turned += Math.abs(angleDelta(prev, h)); prev = h; pos = advance(q.pos, h, wb); const B = shape(type, pos, h);
      for (const o of nb) { if (hit.has(o.g.ref) || dist(o.g.p, pos) > 140) continue; const d = shapeDist(B, bodyOf(o)); if (d < Math.min(1.5, (own.get(o.g.ref) ?? 20) - 0.3)) { hit.add(o.g.ref); if (hit.size > stop) return null; } else if (d < (own.get(o.g.ref) ?? 20) - 0.5) gap = Math.min(gap, d); }
      const w = bldDist(B); if (w < w0 - 0.5) wall = Math.min(wall, w); if (wall < 2) return null;
    }
    off = Math.max(lineDist(pos), lineDist(advance(pos, h + 180, wb)));
    return { hit, gap, wall, off, total, wig: turned - Math.abs(angleDelta(g.h, h)), nose: h, pos };
  };
  const bodies = new Map<string, Poly[]>(); const bodyOf = (o: { g: G; z: string }) => { const k = o.g.ref + o.z; let b = bodies.get(k); if (!b) bodies.set(k, b = body(o)); return b; };
  // the way in: the aircraft coming along each lane onto the lead-in
  const wayIn = (x: { g: G; z: string }): Set<string> => {
    const g = x.g, hit = new Set<string>(), type = env(x.z), wb = wbOf(type), nb = nbOf(x), own = new Map(nb.map(o => [o.g.ref, shapeDist(body(x), bodyOf(o))] as const));
    const J = g.st.entryNodeId as string, jx = E.nodeXY(J) as XY, lead = g.st.leadInPts.map(xy) as XY[];
    for (const ed of air.nodes.get(J).edges) {
      if (ed.leadIn || ed.type === 'runway') continue;
      const back: XY[] = [jx]; let p = J, c = ed.to, acc = 0; while (acc < 110) { const cx = E.nodeXY(c); acc += dist(back[back.length - 1], cx); back.push(cx); const h = headingTo(E.nodeXY(p), cx); const nx = air.nodes.get(c).edges.filter((q: any) => q.to !== p && !q.leadIn && q.type !== 'runway').map((q: any) => ({ id: q.to, t: Math.abs(angleDelta(h, headingTo(cx, E.nodeXY(q.to)))) })).sort((m: any, n: any) => m.t - n.t)[0]; if (!nx || nx.t > 45) break; p = c; c = nx.id; }
      if (acc < 30 || Math.abs(angleDelta(headingTo(back[1], jx), headingTo(lead[0], lead[1] ?? g.p))) > 125) continue;
      const path = E.buildPath([...back.reverse(), ...lead.slice(1)], 'taxi', false, [jx]); let h = path.pts.length > 1 ? headingTo(path.pts[0], path.pts[1]) : g.h; const one = new Set<string>();
      for (let s = 0; s <= path.total; s += 3) { const m = sampleAlong(path.pts, path.cum, s); for (let k = 0; k < 3; k++) { const d = angleDelta(h, m.heading); h = (h + Math.sign(d) * Math.min(Math.abs(d), Math.abs(Math.sin(d * Math.PI / 180)) / wb * 57.3) + 360) % 360; } if (path.total - s > 130) continue; const B = shape(type, m.pos, h); for (const o of nb) if (!one.has(o.g.ref) && dist(o.g.p, m.pos) < 140 && shapeDist(B, bodyOf(o)) < Math.min(1, (own.get(o.g.ref) ?? 20) - 0.3)) one.add(o.g.ref); }
      for (const r of one) hit.add(r);
    }
    return hit;
  };
  const plan = (x: { g: G; z: string }, z: string, stop: number) => { if (REPUSH) return plan1(x, z, stop, true); const r = plan1(x, z, stop, false); return r.clean[0] && r.clean[0].cost < 330 ? r : plan1(x, z, stop, true); };
  const plan1 = (x: { g: G; z: string }, z: string, stop: number, tees: boolean) => {
    const g = x.g, type = env(z), nb = nbOf(x), own = new Map(nb.map(o => [o.g.ref, shapeDist(shape(type, g.p, g.h), bodyOf(o))] as const)); const lead = [...g.st.leadInPts].reverse().map(xy);
    const best = new Map<string, { o: PushOption; cost: number; hit: Set<string>; kind: string }>();
    for (const c of pushCandidates(air, g.st, (id: string) => E.nodeXY(id), xy, tees)) {
      const path = E.pushPathOf(pushRaw(g.p, g.h, wbOf(type), lead, c), c.r); cases++;
      const r = sweep(type, g, path.pts, path.cum, path.total, nb, own, stop); if (REPUSH && V) { const w = (E.__why ??= {}), q = (w[g.ref] ??= { n: 0, swept: 0, nose: 0, reach: 0 }); q.n++; if (!r) q.swept++; } if (!r) continue;
      // the nose ends pointing at the node the taxi starts from, with room to steer
      const jx = E.nodeXY(c.at) as XY, jd = dist(r.pos, jx); if (jd < 6 || Math.abs(angleDelta(r.nose, headingTo(r.pos, jx))) > 22) { if (REPUSH && V) E.__why[g.ref].nose++; continue; }
      const n = reach(c, r.nose); if (!n) { if (REPUSH && V) E.__why[g.ref].reach++; continue; }
      const cost = r.hit.size * 5000 + r.total + Math.max(0, r.wig - 15) * 3 + (r.gap < 4 ? (4 - r.gap) * 40 : 0) + (r.wall < 5 ? 60 : 0) + Math.max(0, r.off - 3) * 12 + (DEP.length - n) * 40 - (c.r - 20) * 0.6 + (c.kind === 'cross' ? 60 : c.kind === 'tee' ? 50 : 0) + (() => { const t = tightestTurn(path.pts); return t > 75 ? 3000 + t * 10 : Math.max(0, t - 60) * 2; })();
      const k = c.at + '|' + Math.round(r.nose / 40) % 9; const b = best.get(k); if (!b || cost < b.cost) best.set(k, { o: { at: c.at, line: c.line, fix: +c.fix.toFixed(1), extra: c.extra, r: c.r }, cost, hit: r.hit, kind: c.kind });
    }
    const all = [...best.values()].sort((a, b) => a.cost - b.cost); const clean = all.filter(b => !b.hit.size);
    return { all, clean };
  };
  const stat = { clean: 0, shrunk: 0, clash: 0, none: 0 };
  if (REPUSH) {
    // only the pushes of these stands (sizes, drops and pairs stay): the gentle ones, one for each way the nose can end
    for (const x of pick.map(g => S.get(g.ref)!)) if (x.g.gate.needsPushback) {
      const r = plan(x, x.z, 2), g = x.g, lead = [...g.st.leadInPts].reverse().map(xy), tight = (o: PushOption) => tightestTurn(E.pushPathOf(pushRaw(g.p, g.h, wbOf(env(x.z)), lead, o), o.r).pts);
      const len = (o: PushOption) => E.pushPathOf(pushRaw(g.p, g.h, wbOf(env(x.z)), lead, o), o.r).total, gentle = r.clean.filter(b => tight(b.o) <= 75), near = gentle.filter(b => len(b.o) <= 190), ok = near.length ? near : gentle, had = ((E.standPlan?.push[g.ref] ?? []) as PushOption[]).filter(o => tight(o) <= 75);
      const lanes = ok.filter(b => b.kind !== 'tee' && !had.some(o => o.at === b.o.at && Math.abs(o.line[0][0] - b.o.line[0][0]) < 2)), tees = (had.length + lanes.length > 1 ? [] : ok.filter(b => b.kind === 'tee').slice(0, 3)).map(b => ({ ...b.o, p: 400 }));
      const use = [...had, ...lanes.slice(0, 4).map(b => b.o), ...tees];
      if (use.length) push[g.ref] = use; if (V && E.__why?.[g.ref]) console.log(g.ref, JSON.stringify(E.__why[g.ref])); if (V || !use.length) console.log(`${g.ref} ${x.z} (${r.all.length} in all, best ${r.all.slice(0, 3).map(b => `${b.kind} ${Math.round(b.cost)} hits ${[...b.hit].join("+")} turn ${Math.round(tight(b.o))}`).join(", ")}): kept ${had.length} of ${(E.standPlan?.push[g.ref] ?? []).length}, ${lanes.length} more along the lane, ${tees.length} across`);
    }
    fs.writeFileSync(process.env.OUT ?? '.tmp/gatelab-fix.json', JSON.stringify({ push })); process.exit(0);
  }
  for (const x of alive().sort((a, b) => a.rank - b.rank).filter((_, i) => i % SN === SI)) {
    if (!x.g.gate.needsPushback) { for (const r of wayIn(x)) clash.add([x.g.ref, r].sort().join('|')); continue; }
    let z = x.z, r = plan(x, z, 2), win = wayIn({ g: x.g, z });
    // too big to get out or in past its neighbours: one size smaller, down to a narrowbody
    while ((!r.clean.length || win.size) && z > 'C') { const y = less(z), r2 = plan(x, y, 2), w2 = wayIn({ g: x.g, z: y }); if ((r.clean.length && !r2.clean.length) || (w2.size >= win.size && r2.clean.length === r.clean.length && r.clean.length)) { if (y <= 'C') break; } z = y; r = r2; win = w2; }
    if (z !== x.z) { stat.shrunk++; x.z = z; }
    const use = r.clean.length ? r.clean : r.all;
    if (!use.length) { stat.none++; if (V) console.log('no push', x.g.ref, x.z); }
    const keep = use.slice(0, 4).filter(b => b.cost < use[0].cost + 220);
    if (!use.length && x.rank === 2) { kill(x.g.ref, 'no way to push back'); continue; }
    for (const o of nbOf(x)) if (!win.has(o.g.ref) && corridor(x).some(P => shapeDist(P, bodyOf(o)) < 1)) clash.add([x.g.ref, o.g.ref].sort().join('|'));
    push[x.g.ref] = keep.map(b => b.o);
    if (!r.clean.length) for (const h of use[0]?.hit ?? []) clash.add([x.g.ref, h].sort().join('|')); else stat.clean++;
    if (!r.clean.length && use[0]) push[x.g.ref] = [use[0].o];
    for (const h of win) clash.add([x.g.ref, h].sort().join('|'));
  }
  const size: Record<string, string> = {}; for (const x of alive()) if (x.z !== size0.get(x.g.ref)) size[x.g.ref] = x.z;
  fs.writeFileSync(process.env.OUT ?? '.tmp/gatelab-fix.json', JSON.stringify({ sig: E.standSig, kept: alive().length, drop, size, size0: Object.fromEntries(size0), clash: [...clash], push, stat, cases, none: alive().filter((x, i) => x.g.gate.needsPushback && i >= 0 && push[x.g.ref] && !push[x.g.ref].length).map(x => x.g.ref) }));
  process.exit(0);
}

// ── 1 · gates ───────────────────────────────────────────────────────────────
if (want('gates') && SI === 0) {
  for (const o of sharedPairs()) for (const [a, b, way, line] of [[o.a, o.b, o.wayA, o.lineA], [o.b, o.a, o.wayB, o.lineB]] as [string, string, number, number][]) { cases++; if (way < 1 || line > 2 || (o.gap < 2 && a === o.a)) flag('sharedGround', { a, by: b, gap: o.gap, way, line, at: ll(gates.find(g => g.ref === a)!.p) }); }
  for (const g of gates) {
    for (const o of near.get(g.ref)!) {
      if (o.ref < g.ref || dist(o.p, g.p) > 160) continue; cases++;
      const d = shapeDist(parked.get(g.ref)!, parked.get(o.ref)!);
      const need = Math.max(AIRCRAFT_DB[g.big].wingspanMeters, AIRCRAFT_DB[o.big].wingspanMeters) >= 36 ? 7.5 : 4.5;
      const rel = Math.abs(angleDelta(g.h, o.h));
      if (d === 0) flag('overlap', { a: g.ref, b: o.ref, types: `${g.big}/${o.big}`, stops: Math.round(dist(g.p, o.p)), rel: Math.round(rel), at: ll(g.p) });
      else if (d < need) flag('tight', { a: g.ref, b: o.ref, types: `${g.big}/${o.big}`, gap: +d.toFixed(1), need, rel: Math.round(rel) });
      // back to back: tails toward each other with no lane between
      const ta = advance(g.p, g.h + 180, AIRCRAFT_DB[g.big].lengthMeters * 0.88), tb = advance(o.p, o.h + 180, AIRCRAFT_DB[o.big].lengthMeters * 0.88);
      if (rel > 140 && dist(ta, tb) < 30 && dist(ta, tb) < dist(g.p, o.p)) flag('backToBack', { a: g.ref, b: o.ref, tails: Math.round(dist(ta, tb)), at: ll(ta) });
      // one behind the other, same way round (nose to tail)
      const dx = o.p.x - g.p.x, dy = o.p.y - g.p.y, hr = g.h * Math.PI / 180, along = dx * Math.sin(hr) + dy * Math.cos(hr), across = Math.abs(dx * Math.cos(hr) - dy * Math.sin(hr));
      if (rel < 40 && across < 18 && Math.abs(along) > 12) { const [fr, bk] = along > 0 ? [o, g] : [g, o]; if (Math.abs(along) - AIRCRAFT_DB[fr.big].lengthMeters * 0.88 - AIRCRAFT_DB[bk.big].lengthMeters * 0.12 < 60) flag('inLine', { front: fr.ref, behind: bk.ref, along: Math.round(Math.abs(along)), at: ll(g.p) }); }
    }
    const S = parked.get(g.ref)!; const b = bldDist(S, g.p); cases++;
    if (b < 1) flag('inBuilding', { a: g.ref, type: g.big, d: +b.toFixed(1), at: ll(g.p) });
    const nose = advance(g.p, g.h, AIRCRAFT_DB[g.big].lengthMeters * 0.12), nd = ptBld(nose);
    if (g.st.type === 'gate' && nd > 35) flag('farFromTerminal', { a: g.ref, nose: Math.round(nd), size: g.st.size, at: ll(g.p) });
    const tail = advance(g.p, g.h + 180, AIRCRAFT_DB[g.big].lengthMeters * 0.88); const td = lineDist(tail, false);
    if (td < 18) flag('tailInLane', { a: g.ref, type: g.big, d: +td.toFixed(1), at: ll(tail) });
    const lead = g.st.leadInPts.map(xy); let L = 0; for (let i = 1; i < lead.length; i++) L += dist(lead[i - 1], lead[i]);
    if (L > 200) flag('longLeadIn', { a: g.ref, m: Math.round(L), at: ll(g.p) });
    if (L < 15) flag('noLeadIn', { a: g.ref, m: Math.round(L), at: ll(g.p) });
    // the way in and straight back out: the aircraft on its own lead-in, against every neighbour parked
    for (let s = 6; s < Math.min(L, 160); s += 6) { const q = advance(g.p, g.h + 180, s); if (g.st.leadInPts.length > 2) break; const B = shape(g.big, q, g.h); const hit = near.get(g.ref)!.find(o => dist(o.p, q) < 130 && shapeDist(B, parked.get(o.ref)!) === 0); cases++; if (hit && shapeDist(S, parked.get(hit.ref)!) > 0) { flag('leadInBlocked', { a: g.ref, by: hit.ref, type: g.big, at: ll(q) }); break; } }
    if (!g.fits.length) flag('nothingFits', { a: g.ref, size: g.st.size });
  }
}

// ── the driven path: the game's own steering, 1 m steps ─────────────────────

{ // the check can fail: a straight line with a 4 m swing out and back must be caught, the same line without it must not
  const mk = (amp: number) => { const pts: XY[] = []; for (let s = 0; s <= 400; s += 2) pts.push({ x: amp * Math.exp(-(((s - 200) / 22) ** 2)), y: s }); const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i])); return wiggles(pts, cum).length; };
  if (!mk(4) || mk(0)) { console.error('wiggle self-test failed', mk(4), mk(0)); process.exit(3); }
}
const drive = (type: string, pts: XY[], cum: number[], hdg: number) => {
  const wb = wbOf(type), total = cum[cum.length - 1]; let h = hdg; let maxSwing = 0, minR = Infinity, crab = 0, crabAt = 0;
  for (let s = 0; s <= total; s += 1) { const q = sampleAlong(pts, cum, s); const d = angleDelta(h, q.heading); const sn = Math.abs(d) > 150 ? 0.5 * (d < 0 ? -1 : 1) : Math.sin(d * Math.PI / 180); const stp = Math.min(8, Math.abs(sn) / wb * 180 / Math.PI); h = (h + Math.sign(sn) * Math.min(Math.abs(d), stp) + 360) % 360; { const c = s > 10 ? Math.abs(angleDelta(h, q.heading)) : 0; if (c > crab) { crab = c; crabAt = s; } } if (stp > 0.1) minR = Math.min(minR, 57.3 / stp); maxSwing = Math.max(maxSwing, stp); }
  return { crab, minR, end: h, at: crabAt };
};
const proto = new Map<string, any>();
const acOf = (type: string): any => { let a = proto.get(type); if (!a) { e.clear(); a = e.spawnAt({ callsign: 'LAB1', type, kind: 'departure', phase: 'parked', gate: gates[0].ref, runway: RWYS[0] } as any); proto.set(type, a); } E.aircraft.length = 0; return a; };
const put = (a: any, p: XY, h: number, gate: string | null, rwy: string | null) => { a.pos = { ...p }; a.heading = h; a.reservedStand = gate; a.plan.gateRef = gate; a.plan.runway = rwy; a.path = null; a.distAlong = 0; a.speed = 0; if (!rwy) E.sc(a).pushJoin = null; };
const typesFor = (g: G) => { const t = list('TYPES'); if (t) return t.filter(x => g.fits.includes(x)); const mid = g.fits[Math.floor(g.fits.length / 2)]; return [...new Set([g.big, mid, g.fits[0]])].filter(Boolean).slice(0, Number(process.env.NTYPES ?? 2)); };
interface End { p: XY; h: number }
const pushEnd = new Map<string, End>();
const pushOne = (g: G, type: string, rwy: string, rep = true): End | null => {
  const a = acOf(type); put(a, g.p, g.h, g.ref, rwy); const path = E.pushbackPath(a, 'any'); cases++; E.sc(a).pushJoin = path?.join ?? null;
  if (!path) { if (rep) flag('noPush', { a: g.ref, type, rwy }); return null; }
  const wb = wbOf(type); let h = g.h, turned = 0, worst: any = { d: Infinity }, wall = Infinity, wallAt: XY = g.p, prevH = h;
  const nb = near.get(g.ref)!; const S0 = new Map(nb.map(o => [o.ref, shapeDist(shape(type, g.p, g.h), parked.get(o.ref)!)] as const));
  const S0w = bldDist(shape(type, g.p, g.h), g.p);
  let pos = g.p;
  for (let s = 0; s <= path.total; s += 3) {
    const q = sampleAlong(path.pts, path.cum, s);
    for (let k = 0; k < 3; k++) { const d = angleDelta(h, (q.heading + 180) % 360); h = (h + Math.sign(d) * Math.min(Math.abs(d), 8 + 0.05) + 360) % 360; }
    turned += Math.abs(angleDelta(prevH, h)); prevH = h; pos = advance(q.pos, h, wb);
    const B = shape(type, pos, h);
    for (const o of nb) { if (dist(o.p, pos) > 140) continue; const d = shapeDist(B, parked.get(o.ref)!); if (d < worst.d && d < (S0.get(o.ref) ?? 99) - 0.5) worst = { d, by: o.ref, at: pos, s }; if (worst.d === 0) break; }
    const w = bldDist(B, pos); if (w < wall && w < S0w - 0.5) { wall = w; wallAt = pos; }
  }
  if (rep) {
    const need = AIRCRAFT_DB[type].wingspanMeters >= 36 ? 4.5 : 3;
    if (worst.d < need) flag(worst.d === 0 ? 'pushHits' : 'pushTight', { a: g.ref, type, rwy, by: worst.by, gap: +worst.d.toFixed(1), s: Math.round(worst.s), at: ll(worst.at) });
    if (wall < 3) flag('pushWall', { a: g.ref, type, rwy, gap: +wall.toFixed(1), at: ll(wallAt) });
    const net = Math.abs(angleDelta(g.h, h)); if (turned - net > 40) flag('pushWiggle', { a: g.ref, type, rwy, turned: Math.round(turned), net: Math.round(net), total: Math.round(path.total) });
    { const t = tightestTurn(path.pts); if (t > 75) flag('pushSpin', { a: g.ref, type, rwy, deg: Math.round(t) }); }
    if (path.total > 190) flag('pushLong', { a: g.ref, type, rwy, m: Math.round(path.total) });
    const off = Math.max(lineDist(pos), lineDist(advance(pos, h + 180, wb)));
    if (off > (E.standPlan?.push[g.ref] ? 70 : 8)) flag('pushEndOff', { a: g.ref, type, rwy, off: +off.toFixed(1), at: ll(pos) });
  }
  return { p: pos, h };
};
// ── 2 · pushback ────────────────────────────────────────────────────────────
if (want('push')) for (const g of pick) if (g.gate.needsPushback) for (const type of typesFor(g)) for (const rwy of RWYS) pushOne(g, type, rwy);

// ── 3 · taxi out, 4 · taxi in ───────────────────────────────────────────────
const lim = taxiLimitsOf(air);
const edgesOf = (ids: string[]) => ids.slice(1).map((id, i) => air.nodes.get(ids[i])?.edges.find((x: any) => x.to === id));
const costOf = (ids: string[]) => ids.slice(1).reduce((m, id, i) => { const ed = air.nodes.get(ids[i])?.edges.find((x: any) => x.to === id); return m + dist(E.nodeXY(ids[i]), E.nodeXY(id)) * (ed?.type === 'runway' ? 10 : 1); }, 0);
const lenOf = (ids: string[]) => ids.slice(1).reduce((m, id, i) => m + dist(E.nodeXY(ids[i]), E.nodeXY(id)), 0);
const wig = new Map<string, { n: number; off: number; at: string; names: string; eg: string }>();
const checkRoute = (label: string, type: string, a: any, plan: any, dest: any, dep: boolean, kind: string) => {
  const ids: string[] = plan.ids, path = plan.path, names = taxiwaysForPath(air, ids); cases++;
  // correct: every named taxiway joins the next, runway crossings held, nothing the aircraft does not fit
  const eds = edgesOf(ids); if (eds.some(x => !x)) flag('brokenRoute', { label, type });
  const refused = lim.firstRefused(ids, AIRCRAFT_DB[type].wingspanMeters, dep);
  const entries = E.runwayEntries(ids), held = path.holds?.length ?? 0;
  const firstOn = eds[0]?.type === 'runway'; if (held < entries - (firstOn ? 1 : 0) && !E.runwaysAt(a.pos, 40).length) flag('noHold', { label, type, entries, held });
  // optimal: against the shortest way with the same rules (forward only, turns cost, a crossing costs 400 m)
  const L = costOf(ids) + 400 * entries; let opt = Infinity, optIds: string[] = [];
  for (const avoid of [[], E.runways.map((r: any) => r.ref).filter((r: string) => !dep || E.runwayState(dest.runway)?.ref !== r)]) {
    const q = findPath(air, ids[0], ids[ids.length - 1], { ...E.taxiDir(a, ids[0]), avoidRunways: avoid, edgeMult: lim.any(AIRCRAFT_DB[type].wingspanMeters) ? (f: string, t: string) => (lim.tooWide(f, t, AIRCRAFT_DB[type].wingspanMeters) ? 30 : 1) : undefined });
    if (q) { const c = costOf(q) + 400 * E.runwayEntries(q); if (c < opt) { opt = c; optIds = q; } }
  }
  if (refused && optIds.length && !lim.firstRefused(optIds, AIRCRAFT_DB[type].wingspanMeters, dep)) flag('tooWide', { label, type, on: refused });   // and there is a way it does fit
  if (L > opt * 1.12 + 120) flag('notOptimal', { label, type, m: Math.round(L), best: Math.round(opt), via: names.join(' '), bestVia: taxiwaysForPath(air, optIds).join(' ') });
  // leaves a taxiway and comes straight back to it
  for (let i = 0; i < names.length - 2; i++) if (names[i] === names[i + 2]) { const s = names[i + 1]; const m = eds.reduce((k, x, q) => k + (x?.taxiway === s ? dist(E.nodeXY(ids[q]), E.nodeXY(ids[q + 1])) : 0), 0); if (m < 200) flag('outAndBack', { label, via: names.join(' '), off: s, m: Math.round(m) }); }
  // the spoken instruction, given back as a via list, drives the same way
  if (names.length) { const p2 = E.planTaxi(a, dest, names); if ('code' in p2) flag('viaRefused', { label, type, via: names.join(' '), code: p2.code }); else if (lenOf(p2.ids) > lenOf(ids) * 1.05 + 60 || E.runwayEntries(p2.ids) > entries) flag('viaDiffers', { label, via: names.join(' '), m: Math.round(lenOf(ids)), viaM: Math.round(lenOf(p2.ids)), x: entries, x2: E.runwayEntries(p2.ids) }); }
  // driven line
  let off = 0, oa = path.pts[0], os = 0; for (let s = E.sc(a).pushJoin ? 66 : 0; s < path.total; s += 6) { const q = sampleAlong(path.pts, path.cum, s).pos, d = lineDist(q);   // the first metres of a swing-out push are off the lane on purpose
    if (d > off) { off = d; oa = q; os = s; } }
  // a corner sharper than about 95 degrees has its own paved fillet: the arc lies inside the wedge, not on either line
  if (off > 12) { let bend = 0; const h = (s: number) => sampleAlong(path.pts, path.cum, Math.max(0, Math.min(path.total, s))).heading; for (let w = -60; w <= 0; w += 10) bend = Math.max(bend, Math.abs(angleDelta(h(os + w), h(os + w + 70)))); flag(off < 40 && bend > 95 ? 'sharpCorner' : 'offLine', { label, type, off: Math.round(off), s: Math.round(os), at: ll(oa) }); }
  const first = path.pts.find((p: XY) => dist(p, a.pos) > 25); if (first && Math.abs(angleDelta(a.heading, headingTo(a.pos, first))) > 100) flag('startsBehind', { label, type, deg: Math.round(Math.abs(angleDelta(a.heading, headingTo(a.pos, first)))) });
  const dh = path.holds?.find((h: any) => h.isDepartureEntry)?.at ?? path.total, dn = path.cum.findIndex((c: number) => c >= dh) + 1 || path.pts.length;   // past the hold line the line-up path takes over
  if (dep && dest.runway) { const de = path.holds?.find((h: any) => h.isDepartureEntry), thr = E.thresholdXY(dest.runway); if (de && thr) { const m = dist(sampleAlong(path.pts, path.cum, de.at).pos, thr); if (m > 1000) flag('farEntry', { label, type, m: Math.round(m), via: names.join(' ') }); } }
  const D = drive(type, path.pts.slice(0, dn), path.cum.slice(0, dn), a.heading); if (D.crab > 95) flag('crab', { label, type, deg: Math.round(D.crab), at: ll(sampleAlong(path.pts, path.cum, D.at).pos), s: Math.round(D.at), of: Math.round(path.total), via: names.join(' ') });
  // goes round in a circle: over 300 degrees of turning, one way or the other, inside 220 m
  { const hs: number[] = []; for (let s = 0; s < path.total; s += 5) hs.push(sampleAlong(path.pts, path.cum, s).heading); const turn = hs.map((h, i) => (i ? angleDelta(hs[i - 1], h) : 0)); let best = 0, bi = 0;
    for (let i = 0; i < turn.length; i++) { let net = 0; for (let k = i; k < Math.min(turn.length, i + 44); k++) { if (Math.abs(turn[k]) < 60) net += turn[k]; if (Math.abs(net) > best) { best = Math.abs(net); bi = k; } } }
    if (best > 300) flag('loop', { label, type, deg: Math.round(best), s: bi * 5, at: ll(sampleAlong(path.pts, path.cum, bi * 5).pos), via: names.join(' ') }); }
  for (const w of wiggles(path.pts, path.cum)) { const k = `${Math.round(w.at.x / 25)},${Math.round(w.at.y / 25)}`; const c = wig.get(k); if (c) { c.n++; if (w.off > c.off) { c.off = w.off; c.eg = label; } } else wig.set(k, { n: 1, off: w.off, at: ll(w.at), names: names.join(' '), eg: label }); }
  if (V) console.log(label, type, Math.round(path.total), names.join(' '));
};
const taxiTypes = (g: G) => typesFor(g);
if (want('out')) for (const g of pick) for (const type of taxiTypes(g)) for (const rwy of RWYS) {
  const end = g.gate.needsPushback ? pushOne(g, type, rwy, false) : { p: g.p, h: g.h }; if (!end) continue;
  const a = acOf(type); put(a, end.p, end.h, g.ref, rwy); const dest = { kind: 'runway', runway: rwy, intersection: null };
  const plan = E.planTaxi(a, dest, []); if ('code' in plan) { flag('noRoute', { label: `${g.ref}->${rwy}`, type, code: plan.code }); continue; }
  checkRoute(`${g.ref}->${rwy}`, type, a, plan, dest, true, 'out');
}
const swept = new Set<string>();
if (want('in')) {
  // lands, takes the exit the game takes (by its gate's side and where it has slowed down), rolls clear, then taxies in
  const ends: string[] = list('ARR') ?? [...new Set(E.runways.map((r: any) => r.name as string))] as string[];
  for (const g of pick) for (const type of typesFor(g).slice(0, 1)) for (const end of ends) for (const [along, kt] of (process.env.FULL ? [[350, 135], [450, 125], [600, 140], [900, 120]] : [[450, 130]]) as [number, number][]) {
    const rs = E.runwayState(end), thr = E.thresholdXY(end); const a = acOf(type); put(a, advance(thr, rs.headingTrue, along), rs.headingTrue, g.ref, null); a.plan.kind = 'arrival'; a.phase = 'rollout'; a.speed = kt; a.exitDir = null; a.exitTaxiway = null;
    const ex = E.chooseExit(a, rs.ref, rs.headingTrue, kt, null, false); if (!ex) { flag('noExit', { label: `${end}->${g.ref}`, type }); a.plan.kind = 'departure'; continue; }
    a.pos = E.nodeXY(ex.runwayNodeId); E.exitViaTaxiway(a, rs, ex, false); const xp = a.path, n = xp.pts.length; const s = { label: `${end}/${ex.taxiway ?? '?'}` }; a.plan.kind = 'departure';
    { const D = drive(type, xp.pts, xp.cum, rs.headingTrue); if (D.crab > 95) flag('crab', { label: `exit ${s.label}`, type, deg: Math.round(D.crab) }); put(a, xp.pts[n - 1], headingTo(xp.pts[n - 3] ?? xp.pts[0], xp.pts[n - 1]), g.ref, null); }
    const dest = { kind: 'stand', ref: g.ref };
    const plan = E.planTaxi(a, dest, []); if ('code' in plan) { flag('noRoute', { label: `${s.label}->${g.ref}`, type, code: plan.code }); continue; }
    checkRoute(`${s.label}->${g.ref}`, type, a, plan, dest, false, 'in');
    // into the stand: what the aircraft sweeps against the neighbours
    const path = plan.path, wb = wbOf(type), z = sampleAlong(path.pts, path.cum, Math.max(0, path.total - 160)), zk = `${g.ref}|${type}|${Math.round(z.pos.x)}|${Math.round(z.pos.y)}`; if (swept.has(zk)) continue; swept.add(zk); let h = sampleAlong(path.pts, path.cum, Math.max(0, path.total - 160)).heading; let wall = 25, wallAt: any = null; let worst: any = { d: Infinity };
    for (let q = Math.max(0, path.total - 160); q <= path.total; q += 3) { const m = sampleAlong(path.pts, path.cum, q); for (let k = 0; k < 3; k++) { const d = angleDelta(h, m.heading); h = (h + Math.sign(d) * Math.min(Math.abs(d), Math.abs(Math.sin(d * Math.PI / 180)) / wb * 57.3) + 360) % 360; } const B = shape(type, m.pos, h); { const w = bldDist(B); if (w < wall && path.total - q > 8) { wall = w; wallAt = m.pos; } } for (const o of near.get(g.ref)!) { if (dist(o.p, m.pos) > 130) continue; const d = shapeDist(B, parked.get(o.ref)!); if (d < worst.d && d < shapeDist(parked.get(g.ref)!, parked.get(o.ref)!) - 0.5) worst = { d, by: o.ref, at: m.pos }; } }
    if (worst.d < 2) flag(worst.d === 0 ? 'inHits' : 'inTight', { a: g.ref, type, by: worst.by, gap: +worst.d.toFixed(1), from: s.label, at: ll(worst.at) });
    if (wall < 0.5) flag('inWall', { a: g.ref, type, from: s.label, gap: +wall.toFixed(1), at: ll(wallAt) });
    const turn = Math.abs(angleDelta(h, g.h)); if (turn > 8) flag('parksCrooked', { a: g.ref, type, from: s.label, deg: Math.round(turn) });
  }
}
for (const w of [...wig.values()].sort((a, b) => b.n - a.n)) flag('wiggle', { n: w.n, off: +w.off.toFixed(1), at: w.at, eg: w.eg, via: w.names });

// ── summary ─────────────────────────────────────────────────────────────────
const key = (o: any) => o.a ?? o.label?.split('->')[0] ?? '';
if (SN === 1) console.log(`${ICAO}: ${gates.length} stands, ${cases} cases in ${((Date.now() - t00) / 1000).toFixed(1)} s`);
if (SN === 1) for (const [k, v] of Object.entries(report)) {
  const stands = [...new Set(v.map(key))].filter(Boolean);
  console.log(`  ${k.padEnd(16)} ${String(v.length).padStart(5)}${stands.length ? `  (${stands.length} stands / starts)` : ''}`);
}
fs.writeFileSync(process.env.OUT ?? '.tmp/gatelab.json', JSON.stringify({ icao: ICAO, cases, planned: !!E.standPlan, warnings: air.warnings.filter((w: string) => w.includes('run on')), clash: [...E.clashOf].map(([k, v]: any) => [k, [...v]]), report, stands: gates.map(g => ({ ref: g.ref, size: g.st.size, type: g.st.type, big: g.big, h: Math.round(g.h), at: ll(g.p) })) }, null, 1));
