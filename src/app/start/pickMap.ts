// The clean airport map on the airport list: drawn once per airport and size on a canvas, then only moved.
import { runwaysOf, sanitiseRef } from '../_lib/airports';

export interface PickMap { lat0: number; lng0: number; taxi: number[][]; apron: number[][]; bldg: number[][] }
const cache = new Map<string, Promise<PickMap | null>>();
export function loadPickMap(icao: string): Promise<PickMap | null> {
  let p = cache.get(icao);
  if (!p) { p = fetch(`/maps/pick/${icao}.json`).then((r) => (r.ok ? (r.json() as Promise<PickMap>) : null)).catch(() => null); cache.set(icao, p); }
  return p;
}

/** Land dots of the world (scripts/pickworld.cjs). */
export interface PickWorld { step: number; lng0: number; lat0: number; cols: number; rows: string[] }
let world: Promise<PickWorld | null> | null = null;
export function loadPickWorld(): Promise<PickWorld | null> { world ??= fetch('/maps/pick/world.json').then((r) => (r.ok ? (r.json() as Promise<PickWorld>) : null)).catch(() => null); return world; }

export const MAP_BG = '#10151b';
/** Where the map sits on a W x H screen: what shows through the drop on the list, and what the drop opens on to. */
export function mapBox(W: number, H: number): { w: number; h: number; cy: number } {
  const { rx, ry, s0 } = dropSize(W, H);
  return { w: 2 * rx / s0 * 0.9, h: 2 * ry / s0 * 0.76, cy: H / 2 - ry / s0 * 0.1 };
}
/** Height of the name under the map, on the same screen. */
export function capY(W: number, H: number): number { const { ry, s0 } = dropSize(W, H); return H / 2 + ry / s0 * 0.8; }
/** The drop's half sizes, and how far back the map stands behind it. */
export function dropSize(W: number, H: number): { rx: number; ry: number; s0: number } {
  return W <= 760 ? { rx: W * 0.43, ry: H * 0.17, s0: 0.82 } : { rx: Math.min(W * 0.285, H * 0.56), ry: H * 0.3, s0: 0.62 };
}

export function drawPickMap(cv: HTMLCanvasElement, icao: string, map: PickMap | null, W: number, H: number, dpr: number): void {
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d'); if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = MAP_BG; c.fillRect(0, 0, W, H);
  const rws = runwaysOf(icao); if (!rws.length) return;
  const ends = rws.flatMap((r) => r.ends.map((e) => e.thr));
  const lat0 = map?.lat0 ?? ends.reduce((a, p) => a + p.lat, 0) / ends.length, lng0 = map?.lng0 ?? ends.reduce((a, p) => a + p.lng, 0) / ends.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), m = (p: { lat: number; lng: number }): [number, number] => [(p.lng - lng0) * kx, (lat0 - p.lat) * 110540];
  // north up, fitted to the runways and the buildings between them (a lone hangar far out does not shrink the field)
  const re = ends.map(m), bx = re.map((p) => p[0]), by = re.map((p) => p[1]);
  let x0 = Math.min(...bx), x1 = Math.max(...bx), y0 = Math.min(...by), y1 = Math.max(...by); const lim = [x0 - 350, x1 + 350, y0 - 350, y1 + 350];
  for (const q of map?.bldg ?? []) for (let i = 0; i < q.length; i += 2) if (q[i] > lim[0] && q[i] < lim[1] && q[i + 1] > lim[2] && q[i + 1] < lim[3]) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]); }
  const { w, h, cy } = mapBox(W, H), pad = 24, sc = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0)), mx = (x0 + x1) / 2, my = (y0 + y1) / 2, F = { sc };
  const P = (x: number, y: number): [number, number] => [W / 2 + (x - mx) * sc, cy + (y - my) * sc];
  const trace = (a: number[]) => { for (let i = 0; i < a.length; i += 2) { const [x, y] = P(a[i], a[i + 1]); if (i) c.lineTo(x, y); else c.moveTo(x, y); } };
  c.lineJoin = c.lineCap = 'round';
  if (map) {
    c.fillStyle = '#1b222b'; c.beginPath(); for (const a of map.apron) { trace(a); c.closePath(); } c.fill('nonzero');
    c.strokeStyle = '#2b3540'; c.lineWidth = Math.max(3, 24 * F.sc); c.beginPath(); for (const a of map.taxi) trace(a); c.stroke();
    c.strokeStyle = '#5f9c7b'; c.lineWidth = 1.1; c.beginPath(); for (const a of map.taxi) trace(a); c.stroke();
    c.fillStyle = '#e08a48'; c.beginPath(); for (const a of map.bldg) { trace(a); c.closePath(); } c.fill('nonzero');
  }
  const px = Math.max(13, Math.min(22, W / 72));
  c.font = `600 ${px}px ${getComputedStyle(cv).fontFamily || 'monospace'}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineCap = 'butt';
  for (const r of rws) {
    const [a, b] = r.ends.map((e) => P(...m(e.thr))), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const rw = Math.max(6, 60 * F.sc);
    c.strokeStyle = MAP_BG; c.lineWidth = rw + 4; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
    c.strokeStyle = '#eef1f5'; c.lineWidth = rw; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke();
    c.strokeStyle = '#8b939e'; c.lineWidth = 1; c.setLineDash([9, 7]); c.beginPath(); c.moveTo(a[0] + ux * 12, a[1] + uy * 12); c.lineTo(b[0] - ux * 12, b[1] - uy * 12); c.stroke(); c.setLineDash([]);
  }
  // the numbers last, over every runway
  for (const r of rws) {
    const [a, b] = r.ends.map((e) => P(...m(e.thr))), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const off = px * 1.15;
    for (const [e, q, s] of [[r.ends[0].name, a, -1], [r.ends[1].name, b, 1]] as [string, [number, number], number][]) {
      const x = q[0] + ux * off * s, y = q[1] + uy * off * s, t = sanitiseRef(e);
      c.lineWidth = 5; c.strokeStyle = MAP_BG; c.lineJoin = 'round'; c.strokeText(t, x, y); c.fillStyle = '#fff'; c.fillText(t, x, y);
    }
  }
}
