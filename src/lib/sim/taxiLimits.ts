// Where a big aircraft does not fit: the limits an airport publishes, and the wingtip clearance to the buildings beside
// a taxiway (measured on the map). Used by route planning (a route keeps off what the aircraft does not fit) and by the
// crew, who refuse a taxiway they do not fit (taximind.ts).
import type { OsmAirport } from '../osmAirport';

interface PublishedLimit {
  /** Closed to a wingspan over this, metres. */
  maxSpanM: number;
  taxiway: string;
  /** Only the part between these two taxiways. */
  between?: [string, string];
  /** Only coming from this taxiway, turning to within 90 degrees of `toward` (true). */
  from?: string; toward?: number;
  /** Departures only ("outbound"). */
  outbound?: boolean;
}
const FT = 0.3048;
/** FAA Chart Supplement remarks (SFO: as published for 29 Oct 2026). Other airports: none entered, buildings only. */
const PUBLISHED: Record<string, PublishedLimit[]> = {
  KSFO: [
    { taxiway: 'S', between: ['Z', 'S2'], maxSpanM: 215 * FT },
    { taxiway: 'Z', from: 'Z2', toward: 270, maxSpanM: 171 * FT - 0.01, outbound: true },
  ],
};
/** Clear space a crew wants between its wingtip and a building, metres. */
const WINGTIP_M = 5;

export class TaxiLimits {
  /** edge "a>b" -> the widest wingspan that fits past the buildings beside it. Only the edges a 24 m span or wider could not use. */
  private span = new Map<string, number>();
  /** edge "a>b" -> the widest wingspan that passes the tails of the aircraft parked beside it (only under an A380's). Kept off by routes, not refused. */
  private tails = new Map<string, number>();
  private turns: PublishedLimit[] = [];
  /** With the simple names on: a name on the map -> the airport's own (what the published limits are written in). */
  realName: ((n: string) => string) | null = null;
  constructor(private air: OsmAirport) {
    const c = air.center, R = 6371000, ky = R * Math.PI / 180, kx = ky * Math.cos(c.lat * Math.PI / 180);
    const xy = (p: { lng: number; lat: number }) => ({ x: (p.lng - c.lng) * kx, y: (p.lat - c.lat) * ky });
    const polys = air.buildings.filter(b => b.kind !== 'apron').map(b => {
      const pts = b.polygon.map(xy); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      return { pts, x0, x1, y0, y1 };
    });
    const REACH = 46;                                  // half the widest span (80 m) and the margin
    for (const n of air.nodes.values()) for (const e of n.edges) {
      if (!e.taxiway || e.leadIn || e.type === 'runway') continue;
      const o = air.nodes.get(e.to); if (!o || n.id > o.id) continue;
      const A = xy(n), B = xy(o);
      const near = polys.filter(P => Math.max(A.x, B.x) + REACH > P.x0 && Math.min(A.x, B.x) - REACH < P.x1 && Math.max(A.y, B.y) + REACH > P.y0 && Math.min(A.y, B.y) - REACH < P.y1);
      if (!near.length) continue;
      let d = Infinity;
      const steps = Math.max(1, Math.ceil(e.meters / 15));
      for (let k = 0; k <= steps; k++) {
        const px = A.x + (B.x - A.x) * k / steps, py = A.y + (B.y - A.y) * k / steps;
        for (const P of near) for (let i = 1; i < P.pts.length; i++) {
          const u = P.pts[i - 1], v = P.pts[i], dx = v.x - u.x, dy = v.y - u.y, t = Math.max(0, Math.min(1, ((px - u.x) * dx + (py - u.y) * dy) / (dx * dx + dy * dy || 1)));
          d = Math.min(d, Math.hypot(px - u.x - t * dx, py - u.y - t * dy));
        }
      }
      const s = 2 * (d - WINGTIP_M);
      if (s < 82 && s > 24) { this.span.set(`${n.id}>${o.id}`, s); this.span.set(`${o.id}>${n.id}`, s); }   // under 24 m: the map is wrong, not the taxiway
    }
    // the tails of parked aircraft, for the widest ones (an A380 along a lane with stands on it took the tail off a 320 neo)
    const LEN: Record<string, [number, number]> = { A: [13, 15], B: [24, 24], C: [40, 36], D: [56, 52], E: [70, 65], F: [76, 80] };
    const tails = (air.stands ?? []).map(st => { const p = xy(st), h = st.headingIn * Math.PI / 180, [len, span] = LEN[st.size] ?? LEN.C, f = { x: Math.sin(h), y: Math.cos(h) }, t = { x: p.x - f.x * len * 0.86, y: p.y - f.y * len * 0.86 }, w = span * 0.17; return { entry: st.entryNodeId, node: st.nodeId, t, a: { x: t.x - f.y * w, y: t.y + f.x * w }, b: { x: t.x + f.y * w, y: t.y - f.x * w } }; });
    for (const n of air.nodes.values()) for (const e of n.edges) {
      if (e.leadIn || e.type === 'runway') continue; const o = air.nodes.get(e.to); if (!o || n.id > o.id) continue;
      const A = xy(n), B = xy(o); let d = Infinity;
      for (const t of tails) { if (Math.max(A.x, B.x) + 60 < t.t.x || Math.min(A.x, B.x) - 60 > t.t.x || Math.max(A.y, B.y) + 60 < t.t.y || Math.min(A.y, B.y) - 60 > t.t.y) continue; for (const q of [t.a, t.b, t.t]) { const dx = B.x - A.x, dy = B.y - A.y, u = Math.max(0, Math.min(1, ((q.x - A.x) * dx + (q.y - A.y) * dy) / (dx * dx + dy * dy || 1))); d = Math.min(d, Math.hypot(q.x - A.x - u * dx, q.y - A.y - u * dy)); } }
      const s = 2 * (d - 2); if (s < 80) { const v = Math.max(66, s); this.tails.set(`${n.id}>${o.id}`, v); this.tails.set(`${o.id}>${n.id}`, v); }
    }
    for (const l of PUBLISHED[air.icao] ?? []) {
      if (l.from) { this.turns.push(l); continue; }
      for (const [a, b] of this.stretch(l)) for (const k of [`${a}>${b}`, `${b}>${a}`]) this.span.set(k, Math.min(this.span.get(k) ?? Infinity, l.maxSpanM));
    }
  }
  /** The edges of a taxiway, or of the part of it between two others: the shortest way along it from one to the other. */
  private stretch(l: PublishedLimit): Array<[string, string]> {
    const on = (id: string) => this.air.nodes.get(id)?.edges.filter(e => e.taxiway === l.taxiway) ?? [];
    const all: Array<[string, string]> = [];
    for (const id of this.air.taxiwayNodes.get(l.taxiway) ?? []) for (const e of on(id)) all.push([id, e.to]);
    if (!l.between) return all;
    const [x, y] = l.between.map(n => new Set(this.air.taxiwayNodes.get(n) ?? []));
    const own = new Set(this.air.taxiwayNodes.get(l.taxiway) ?? []);
    let starts = [...own].filter(id => x.has(id));
    if (!starts.length) {                              // they meet over an unnamed connector: the end of it nearest the other one
      const k = Math.cos(this.air.center.lat * Math.PI / 180); let bd = 150, near: string | null = null;
      for (const a of own) for (const b of x) { const A = this.air.nodes.get(a)!, B = this.air.nodes.get(b)!, d = Math.hypot((A.lng - B.lng) * k, A.lat - B.lat) * 111195; if (d < bd) { bd = d; near = a; } }
      if (near) starts = [near];
    }
    const came = new Map<string, string | null>(starts.map(s => [s, null]));
    const queue = [...starts];
    while (queue.length) {
      const id = queue.shift()!;
      if (y.has(id)) { const out: Array<[string, string]> = []; let c: string = id; for (let p = came.get(c); p; p = came.get(c)) { out.push([p, c]); c = p; } return out; }
      for (const e of on(id)) if (!came.has(e.to)) { came.set(e.to, id); queue.push(e.to); }
    }
    return [];
  }
  /** Whether any limit at this airport touches an aircraft this wide. */
  any(spanM: number): boolean { for (const s of this.span.values()) if (spanM > s) return true; return this.turns.some(t => spanM > t.maxSpanM); }
  /** Would an aircraft this wide pass too close to the tails parked beside this edge? (A route keeps off it where it can.) */
  tight(from: string, to: string, spanM: number): boolean { const s = this.tails.get(`${from}>${to}`); return s != null && spanM > s; }
  /** Is any lane here too tight for it? */
  anyTight(spanM: number): boolean { return spanM > 66 && this.tails.size > 0; }
  /** Does an aircraft this wide not fit along this edge? */
  tooWide(from: string, to: string, spanM: number): boolean { const s = this.span.get(`${from}>${to}`); return s != null && spanM > s; }
  /** The first taxiway on a node route that this aircraft does not fit, or null. */
  firstRefused(ids: string[], spanM: number, departure: boolean): string | null {
    let prev: string | null = null;
    for (let i = 1; i < ids.length; i++) {
      const e = this.air.nodes.get(ids[i - 1])?.edges.find(x => x.to === ids[i]); const tw = e?.taxiway ?? null;
      if (tw && this.tooWide(ids[i - 1], ids[i], spanM)) return tw;
      if (tw && tw !== prev) {
        const own = (n: string | null) => (n && this.realName ? this.realName(n) : n);
        const t = this.turns.find(l => l.taxiway === own(tw) && l.from === own(prev) && spanM > l.maxSpanM && (!l.outbound || departure));
        if (t) {
          const A = this.air.nodes.get(ids[i - 1])!, B = this.air.nodes.get(ids[i])!;
          const brg = (Math.atan2((B.lng - A.lng) * Math.cos(A.lat * Math.PI / 180), B.lat - A.lat) * 180 / Math.PI + 360) % 360;
          if (Math.abs(((brg - (t.toward ?? brg) + 540) % 360) - 180) < 90) return tw;
        }
      }
      if (tw) prev = tw;
    }
    return null;
  }
}
const CACHE = new WeakMap<object, TaxiLimits>();
export function taxiLimitsOf(air: OsmAirport): TaxiLimits {
  let l = CACHE.get(air); if (!l) { l = new TaxiLimits(air); CACHE.set(air, l); }
  return l;
}
