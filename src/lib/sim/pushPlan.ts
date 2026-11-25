// Pushbacks as data. A push = back along the stand's lead-in to where it meets the lane, then along `line` (metres from
// the stop) until the nose wheel is `extra` metres past the point `fix` metres along it. scripts/gatelab.sh generates the
// candidates, scores them against parked neighbours and buildings and writes the good ones to standplans/<ICAO>.json;
// the engine picks among a stand's options by the way to the runway.
import type { OsmAirport, OsmStand } from '../osmAirport';
import { XY, dist, headingTo, angleDelta, advance, arcLengths, sampleAlong } from './projection';

export interface PushOption { at: string; line: [number, number][]; fix: number; extra: number; r: number; /** Metres of taxi it is worth to push another way (the tail swung across the lane). */ p?: number }
export interface StandPlan {
  sig: string;
  drop: Record<string, string>;
  size: Record<string, string>;
  /** Pairs that cannot both be used at once (one's push or way in needs the other empty). */
  clash: [string, string][];
  push: Record<string, PushOption[]>;
}
/** What a plan was made for: a changed map (other nodes / stands) makes it void, and the engine's general rules apply. */
export function planSig(air: OsmAirport): string {
  let h = 0; for (const s of air.stands ?? []) h = (h * 31 + Math.round(s.lat * 1e5) * 7 + Math.round(s.lng * 1e5)) | 0;
  return `${air.nodes.size}:${air.stands?.length ?? 0}:${h >>> 0}`;
}
/** Main-gear polyline of a push option (before its corners are rounded), for a wheelbase. */
export function pushRaw(stop: XY, heading: number, wb: number, lead: XY[], o: PushOption): XY[] {
  const raw: XY[] = [advance(stop, (heading + 180) % 360, wb)];
  for (const p of lead) if (dist(raw[raw.length - 1], p) > 2 && dist(stop, p) > wb + 2) raw.push(p);
  const line = o.line.map(([x, y]) => ({ x: stop.x + x, y: stop.y + y })); const { cum, total } = arcLengths(line);
  const end = Math.min(total, o.fix + wb + o.extra);
  for (let i = 0; i < line.length && cum[i] < end - 0.5; i++) if (dist(raw[raw.length - 1], line[i]) > 2) raw.push(line[i]);
  raw.push(sampleAlong(line, cum, end).pos);
  return raw;
}
/** The most a path turns inside any 14 m of it (degrees): over about 75 the aircraft is spun round on the spot. */
export function tightestTurn(pts: XY[]): number {
  const at: number[] = [], h: number[] = []; let s = 0, sum = 0, prev: number | null = null;
  for (let i = 1; i < pts.length; i++) { const l = dist(pts[i - 1], pts[i]); if (l < 0.05) continue; const q = headingTo(pts[i - 1], pts[i]); if (prev != null) sum += angleDelta(prev, q); prev = q; at.push(s); h.push(sum); s += l; }
  let worst = 0; for (let i = 0; i < at.length; i++) for (let j = i; j < at.length && at[j] - at[i] <= 14; j++) worst = Math.max(worst, Math.abs(h[j] - h[i]));
  return worst;
}
/** Every push worth trying from a stand: along each lane at the end of its lead-in (or straight on past the end of one
 *  that stops there), short and long, tight and wide, and down an alley and round onto its first cross lanes. */
export function pushCandidates(air: OsmAirport, st: OsmStand, xyOf: (id: string) => XY | null, toXY: (p: { lat: number; lng: number }) => XY, tees = false): (PushOption & { kind: string })[] {
  const stop = toXY(st), J = xyOf(st.entryNodeId), jn = air.nodes.get(st.entryNodeId); if (!J || !jn) return [];
  const lead = [...st.leadInPts].reverse().map(toXY);
  let k = lead.length - 2; while (k > 0 && dist(lead[k], J) < 4) k--;
  const inH = headingTo(lead[Math.max(0, k)] ?? stop, J);
  const lanes = (id: string, from: string | null) => air.nodes.get(id)!.edges.filter(e => e.to !== from && !e.leadIn && e.type !== 'runway');
  const turn = (a: number, b: number) => Math.abs(angleDelta(a, b));
  /** On along the lane, straightest way, up to `m` metres: points and their nodes. */
  const follow = (a: string, b: string, m: number): { pts: XY[]; ids: string[] } => {
    const pts = [xyOf(a)!, xyOf(b)!], ids = [a, b]; let acc = dist(pts[0], pts[1]), p = a, c = b;
    while (acc < m) {
      const h = headingTo(xyOf(p)!, xyOf(c)!); const nx = lanes(c, p).map(e => ({ id: e.to, t: turn(h, headingTo(xyOf(c)!, xyOf(e.to)!)) })).filter(e => e.t <= 45).sort((x, y) => x.t - y.t)[0];
      if (!nx || ids.includes(nx.id)) break;
      p = c; c = nx.id; ids.push(c); pts.push(xyOf(c)!); acc += dist(pts[pts.length - 2], pts[pts.length - 1]);
    }
    // the mapped lane ends: straight on (checked against the buildings and stands like everything else)
    if (acc < m) { const n = pts.length; pts.push(advance(pts[n - 1], headingTo(pts[n - 2], pts[n - 1]), m - acc)); }
    return { pts, ids };
  };
  const rel = (pts: XY[]): [number, number][] => pts.map(p => [+(p.x - stop.x).toFixed(1), +(p.y - stop.y).toFixed(1)]);
  const out: (PushOption & { kind: string })[] = [];
  const add = (kind: string, at: string, pts: XY[], fix: number) => { for (const extra of [8, 22, 40]) for (const r of [20, 30, 42]) out.push({ kind, at, line: rel(pts), fix, extra, r }); };
  const dirs: { h: number; pts: XY[]; ids: string[] }[] = [];
  for (const e of lanes(st.entryNodeId, null)) dirs.push({ h: headingTo(J, xyOf(e.to)!), ...follow(st.entryNodeId, e.to, 150) });
  const real = dirs.slice();
  for (const d of real) { const back = (d.h + 180) % 360; if (!dirs.some(o => turn(o.h, back) < 40)) dirs.push({ h: back, pts: [J, advance(J, back, 110)], ids: [] }); }
  // straight on back past the lane, when it goes on that way
  for (const d of dirs) if (turn(inH, d.h) <= 125) add(d.ids.length ? 'lane' : 'past', st.entryNodeId, d.pts, 0);
  // down the lane and round onto a cross lane, nose the other way: for an alley closed at this end
  for (const d of real) {
    if (turn(inH, d.h) > 125) continue;
    const { pts, ids } = follow(st.entryNodeId, d.ids[1], 320); let acc = 0, n = 0;
    for (let i = 1; i < ids.length && n < 4; i++) {
      acc += dist(pts[i - 1], pts[i]); if (acc < 25) continue;
      const h = headingTo(pts[i - 1], pts[i]);
      for (const e of lanes(ids[i], ids[i - 1])) { const t = turn(h, headingTo(pts[i], xyOf(e.to)!)); if (t < 40 || t > 125) continue; n++; const f = follow(ids[i], e.to, 130); add('cross', ids[i], [...pts.slice(0, i + 1), ...f.pts.slice(1)], acc); }
    }
  }
  // back down the lane a little, then the tail swings across it: the nose is left facing the lane, and the taxi turns out
  // along it (the way out of a cul-de-sac with no room to turn round at its end)
  if (tees) for (const d of real) {
    if (turn(inH, d.h) > 125) continue;
    const { pts, ids } = follow(st.entryNodeId, d.ids[1], 220); let acc = 0;
    for (let i = 0; i < ids.length; i++) {
      if (i) acc += dist(pts[i - 1], pts[i]); if (acc > 230) break;
      const h = i ? headingTo(pts[i - 1], pts[i]) : d.h;
      for (const side of [-100, -80, -60, 60, 80, 100]) {
        if (i === 0 && turn(inH, (h + side + 360) % 360) > 60) continue;
        const tail = (h + side + 360) % 360, line = [...pts.slice(0, i + 1), advance(pts[i], tail, 110)];
        for (const extra of [16, 28]) for (const r of [18, 26]) out.push({ kind: 'tee', at: ids[i], line: rel(line), fix: acc, extra, r });
      }
    }
  }
  return out;
}
