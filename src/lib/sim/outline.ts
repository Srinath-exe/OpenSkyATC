// An aircraft on the ground as an outline (fuselage, wings, tailplane): real clearances instead of circles round the nose.
import { XY, advance, distToSegment } from './projection';

export type Poly = XY[];
export const segSeg = (a: XY, b: XY, c: XY, d: XY): number => {
  const o = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
};
export const inPoly = (p: XY, g: Poly) => { let c = false; for (let i = 0, j = g.length - 1; i < g.length; j = i++) { const a = g[i], b = g[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
export const polyDist = (A: Poly, B: Poly): number => {
  if (inPoly(A[0], B) || inPoly(B[0], A)) return 0;
  let d = Infinity;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) { d = Math.min(d, segSeg(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])); if (d === 0) return 0; }
  return d;
};

/** Four convex parts of an aircraft whose nose wheel is at `p` (12 % of the length behind the nose, as the game places it). */
export const outlineOf = (f: { lengthMeters: number; wingspanMeters: number }, p: XY, hdg: number): Poly[] => {
  const L = f.lengthMeters, S = f.wingspanMeters / 2, w = Math.max(1.6, L * 0.045);
  const at = (back: number, side: number) => advance(advance(p, hdg, L * 0.12 - back * L), hdg + 90, side);
  return [
    [at(0, -w * 0.4), at(0, w * 0.4), at(0.06, w), at(0.85, w), at(1, w * 0.3), at(1, -w * 0.3), at(0.85, -w), at(0.06, -w)],
    [at(0.34, w), at(0.55, S), at(0.60, S), at(0.56, w)], [at(0.34, -w), at(0.55, -S), at(0.60, -S), at(0.56, -w)],
    [at(0.86, 0), at(0.93, S * 0.36), at(0.98, S * 0.36), at(0.97, 0), at(0.98, -S * 0.36), at(0.93, -S * 0.36)],
  ];
};
export const boxOf = new WeakMap<Poly, [number, number, number, number]>();
export const box = (g: Poly) => { let b = boxOf.get(g); if (!b) { b = [Infinity, -Infinity, Infinity, -Infinity]; for (const p of g) { b[0] = Math.min(b[0], p.x); b[1] = Math.max(b[1], p.x); b[2] = Math.min(b[2], p.y); b[3] = Math.max(b[3], p.y); } boxOf.set(g, b); } return b; };
/** Gap between two aircraft, up to 20 m (20 beyond that). */
export const outlineGap = (A: Poly[], B: Poly[]) => { let d = 20; for (const a of A) for (const b of B) { const x = box(a), y = box(b); if (Math.hypot(Math.max(0, x[0] - y[1], y[0] - x[1]), Math.max(0, x[2] - y[3], y[2] - x[3])) >= d) continue; d = Math.min(d, polyDist(a, b)); if (d === 0) return 0; } return d; };

