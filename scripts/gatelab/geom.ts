// Wireframe geometry shared by the gate lab and the wire simulator: aircraft as outlines, walls, painted lines.
import { dist, headingTo, angleDelta, advance, sampleAlong, distToSegment, XY } from '../../src/lib/sim/projection';
import { AIRCRAFT_DB } from '../../src/lib/sim/aircraftDB';
import { sizeOfType } from '../../src/lib/sim/airlines';

// ── geometry ────────────────────────────────────────────────────────────────
import { Poly, segSeg, inPoly, polyDist, outlineOf, outlineGap } from '../../src/lib/sim/outline';
export { segSeg, inPoly, polyDist, outlineGap as shapeDist };
export type { Poly };
export const NOTYPE = new Set(['F18', 'F35', 'C17', 'VC25', 'A346', 'MD11']);
export const ENV: Record<string, { lengthMeters: number; wingspanMeters: number }> = {};
for (const [t, f] of Object.entries(AIRCRAFT_DB)) { if (NOTYPE.has(t)) continue; const k = 'ENV:' + sizeOfType(t), x = (ENV[k] ??= { lengthMeters: 0, wingspanMeters: 0 }); x.lengthMeters = Math.max(x.lengthMeters, f.lengthMeters); x.wingspanMeters = Math.max(x.wingspanMeters, f.wingspanMeters); }
export const dims = (t: string) => ENV[t] ?? AIRCRAFT_DB[t];
export const shape = (type: string, p: XY, hdg: number): Poly[] => outlineOf(dims(type), p, hdg);
/** Wiggles: the line swings out and comes back to the heading it had. Only where both ends run the same way. */
export const wiggles = (pts: XY[], cum: number[]): { at: XY; s: number; off: number; len: number }[] => {
  const out: { at: XY; s: number; off: number; len: number }[] = []; const total = cum[cum.length - 1]; const st = 4; const P: XY[] = [], H: number[] = [];
  for (let s = 0; s <= total; s += st) { const q = sampleAlong(pts, cum, s); P.push(q.pos); H.push(q.heading); }
  const N = P.length, straight = (i: number) => Math.abs(angleDelta(H[i], headingTo(P[i], P[i + 1]))) < 3;
  let i = 5;
  while (i < N - 12) {
    let best: any = null; const a0 = H[i - 4];
    if (Math.abs(angleDelta(a0, H[i])) < 2 && straight(i)) for (let j = i + 6; j < Math.min(N - 6, i + 46); j++) {
      // back on the same line: same heading, not more than 2 m to the side of it
      if (Math.abs(angleDelta(H[i], H[j])) > 4 || Math.abs(angleDelta(H[j], H[j + 5])) > 4) continue;
      const hr = H[i] * Math.PI / 180, side = (k: number) => (P[k].x - P[i].x) * Math.cos(hr) - (P[k].y - P[i].y) * Math.sin(hr);
      if (Math.abs(side(j)) > 2) continue;
      let off = 0, k0 = i, sw = 0; for (let k = i + 1; k < j; k++) { const d = Math.abs(side(k)); if (d > off) { off = d; k0 = k; } sw = Math.max(sw, Math.abs(angleDelta(H[i], H[k]))); }
      if (off > 1.2 && sw > 5 && off > Math.abs(side(j)) + 1 && (!best || off > best.off)) best = { at: P[k0], s: k0 * st, off, len: (j - i) * st, j, from: P[i], to: P[j], h0: H[i], h1: H[j] };
    }
    if (best) { out.push(best); i = best.j; } else i++;
  }
  return out;
};
/** The walls of an airport on a 25 m grid: how close an outline comes to one (25 m when none is near). */
export function makeWalls(polys: Poly[]): (S: Poly[]) => number {
  const BC = 25, grid = new Map<string, [XY, XY][]>();
  for (const pts of polys) for (let i = 0; i < pts.length; i++) { const u = pts[i], v = pts[(i + 1) % pts.length]; const n = Math.max(1, Math.ceil(dist(u, v) / 12)); const cells = new Set<string>(); for (let k = 0; k <= n; k++) { const x = u.x + (v.x - u.x) * k / n, y = u.y + (v.y - u.y) * k / n; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(`${Math.floor(x / BC) + dx},${Math.floor(y / BC) + dy}`); } for (const c of cells) { let l = grid.get(c); if (!l) grid.set(c, l = []); l.push([u, v]); } }
  return (S) => { let d = 25; const done = new Set<[XY, XY]>(); for (const g of S) for (let i = 0; i < g.length; i++) { const a = g[i], b = g[(i + 1) % g.length]; const n = Math.max(1, Math.ceil(dist(a, b) / 12)); for (let k = 0; k <= n; k++) { const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n; for (const w of grid.get(`${Math.floor(x / BC)},${Math.floor(y / BC)}`) ?? []) { if (done.has(w)) continue; done.add(w); for (const q of S) for (let t = 0; t < q.length; t++) { d = Math.min(d, segSeg(q[t], q[(t + 1) % q.length], w[0], w[1])); if (d === 0) return 0; } } } } return d; };
}
/** Distance to the nearest painted line (40 m when none is nearer). */
export function makeLines(E: any): (p: XY) => number {
  const C = 40, grid = new Map<string, [XY, XY][]>();
  for (const [id, n] of E.air.nodes) for (const ed of n.edges) { if (id > ed.to) continue; const a = E.nodeXY(id), b = E.nodeXY(ed.to); for (let gx = Math.floor((Math.min(a.x, b.x) - 40) / C); gx <= Math.floor((Math.max(a.x, b.x) + 40) / C); gx++) for (let gy = Math.floor((Math.min(a.y, b.y) - 40) / C); gy <= Math.floor((Math.max(a.y, b.y) + 40) / C); gy++) { const k = gx + ',' + gy; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push([a, b]); } }
  return (p) => { let d = 40; for (const s of grid.get(Math.floor(p.x / C) + ',' + Math.floor(p.y / C)) ?? []) d = Math.min(d, distToSegment(p, s[0], s[1])); return d; };
}
