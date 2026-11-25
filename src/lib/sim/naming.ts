// Taxiway and stand names: the airport's real ones, or a simple set made from its layout. A name is only a label on the
// map's lines and stands; the game compares names and never reads anything into them, so a switch renames every line, every
// stand and everything already said or planned in one go (SimEngine.setNaming), also in the middle of a session.
//
//   long taxiways   one letter, nearest the gates first:  A, B, C
//   everything else a letter and a number, in order along the runway (exits) or along the taxiway it leaves (links): G1, G2
//                   a letter with numbers is never a taxiway by itself, so "alpha, two eight left" cannot be heard as A2
//   stands          numbers only, a hundred per area: 101, 102 ... 201 - so a stand and a taxiway never share a name
import type { OsmAirport, OsmEdge } from '../osmAirport';

export type Naming = 'real' | 'simple';
interface XY { x: number; y: number }
interface Unit { real: string | null; edges: [string, string][]; nodes: Set<string>; len: number; mid: XY; runways: Map<string, number> }
export interface NameBook {
  /** Every named line with both names ('' = none): the same edge objects the map holds. */
  edges: { e: OsmEdge; real: string; simple: string }[];
  twyToSimple: Map<string, string>; twyToReal: Map<string, string>;
  standToSimple: Map<string, string>; standToReal: Map<string, string>;
  realNames: string[]; realNodes: Map<string, string[]>;
  simpleNames: string[]; simpleNodes: Map<string, string[]>;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWYZ'.split('');       // no I, O (read as 1 and 0) and no X (a closed taxiway)
const naturally = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function makeNameBook(air: OsmAirport, opts: { /** Names for lines that have none (off only in the check that a switch changes nothing). */ extra?: boolean } = {}): NameBook {
  const c = air.center, ky = 111320, kx = ky * Math.cos(c.lat * Math.PI / 180);
  const at = (p: { lng: number; lat: number }): XY => ({ x: (p.lng - c.lng) * kx, y: (p.lat - c.lat) * ky });
  const pos = new Map<string, XY>(); for (const [id, n] of air.nodes) pos.set(id, at(n));
  const P = (id: string) => pos.get(id)!, D = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
  const runwaysAt = (id: string) => air.nodes.get(id)!.edges.filter(e => e.type === 'runway').map(e => e.runway ?? '').filter(Boolean);
  const stands = air.stands ?? [], entries = new Set(stands.map(s => s.entryNodeId)), stXY = stands.map(at);

  // ── the lines: every named taxiway is one unit (one name in, one name out) ──
  const lines: { a: string; b: string; m: number; name: string }[] = [], seen = new Set<string>();
  for (const [id, n] of air.nodes) for (const e of n.edges) {
    if (e.type === 'runway' || e.leadIn || !air.nodes.has(e.to)) continue;
    const k = key(id, e.to); if (seen.has(k)) continue; seen.add(k);
    const back = air.nodes.get(e.to)!.edges.find(x => x.to === id);
    lines.push({ a: id, b: e.to, m: D(P(id), P(e.to)), name: e.taxiway ?? back?.taxiway ?? '' });
  }
  const unit = (real: string | null, edges: typeof lines): Unit => {
    const u: Unit = { real, edges: edges.map(l => [l.a, l.b]), nodes: new Set(edges.flatMap(l => [l.a, l.b])), len: edges.reduce((s, l) => s + l.m, 0), mid: { x: 0, y: 0 }, runways: new Map() };
    let w = 0; for (const l of edges) { const q = Math.max(0.1, l.m); u.mid.x += (P(l.a).x + P(l.b).x) / 2 * q; u.mid.y += (P(l.a).y + P(l.b).y) / 2 * q; w += q; }
    u.mid.x /= w || 1; u.mid.y /= w || 1;
    for (const id of u.nodes) for (const r of runwaysAt(id)) u.runways.set(r, (u.runways.get(r) ?? 0) + 1);
    return u;
  };
  const byName = new Map<string, typeof lines>(); for (const l of lines) if (l.name) byName.set(l.name, [...(byName.get(l.name) ?? []), l]);
  const units = [...byName].sort((p, q) => naturally(p[0], q[0])).map(([n, ls]) => unit(n, ls));
  // a name the map lists without a line of its own (its lines were taken out): kept, so nothing is ever lost in a switch
  const ghosts = air.taxiwayNames.filter(n => !byName.has(n));

  // ── the lines without a name: runs between junctions; those that leave a runway or serve a row of stands get a name ──
  const free = lines.filter(l => !l.name && l.m > 0.01), adj = new Map<string, typeof lines>(); for (const l of free) for (const id of [l.a, l.b]) adj.set(id, [...(adj.get(id) ?? []), l]);
  const namedAt = (id: string) => air.nodes.get(id)!.edges.map(e => e.taxiway).filter((x): x is string => !!x);
  const dir = (from: string, to: string) => Math.atan2(P(to).x - P(from).x, P(to).y - P(from).y);
  const bend = (a: number, b: number) => Math.abs(((a - b) * 180 / Math.PI + 540) % 360 - 180);
  const used = new Set<(typeof lines)[number]>(), runs: { ls: typeof lines; ends: [string, string] }[] = [];
  for (const l0 of [...free].sort((p, q) => q.m - p.m)) {
    if (used.has(l0)) continue; used.add(l0); const ls = [l0];
    const walk = (prev: string, cur: string): string => {                     // straight on through side branches, up to a named line or a runway
      for (;;) {
        if (namedAt(cur).length || runwaysAt(cur).length) return cur;
        const nx = (adj.get(cur) ?? []).filter(l => !used.has(l)).map(l => ({ l, to: l.a === cur ? l.b : l.a })).map(o => ({ ...o, t: bend(dir(prev, cur), dir(cur, o.to)) })).sort((p, q) => p.t - q.t)[0];
        if (!nx || nx.t > 50) return cur;
        used.add(nx.l); ls.push(nx.l); prev = cur; cur = nx.to;
      }
    };
    const e1 = walk(l0.a, l0.b), e0 = walk(l0.b, l0.a); runs.push({ ls, ends: [e0, e1] });
  }
  const alias = new Map<string, Unit>();                                      // "a|b" -> the unit whose name it shares
  if (opts.extra !== false) for (const r of runs) {
    const len = r.ls.reduce((s, l) => s + l.m, 0), off = r.ends.map(id => runwaysAt(id).length > 0), rest = r.ls.flatMap(l => [l.a, l.b]);
    if (off[0] !== off[1]) {                                                  // it leaves a runway
      const far = r.ends[off[0] ? 1 : 0], near = r.ends[off[0] ? 0 : 1];
      // the second curve of an exit that has a name: the same exit
      const mate = units.filter(u => u.real && u.nodes.has(far) && u.runways.size).find(u => [...u.nodes].some(id => runwaysAt(id).length && D(P(id), P(near)) < 170)) ?? (len < 130 ? units.find(u => u.real && u.nodes.has(far)) : undefined);
      if (mate) { for (const l of r.ls) alias.set(key(l.a, l.b), mate); continue; }
      if (len > 60) units.push(unit(null, r.ls));
    } else if (len > 220 && rest.filter(id => entries.has(id)).length >= 3) units.push(unit(null, r.ls));   // a lane along a row of stands
  }

  // ── letters and numbers ──
  const nearStand = (u: Unit) => { const ids = [...u.nodes].filter((_, i) => i % 5 === 0); return ids.reduce((s, id) => s + (stXY.length ? Math.min(...stXY.map(q => D(q, P(id)))) : 0), 0) / Math.max(1, ids.length); };
  const reach = (u: Unit) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const id of u.nodes) { const p = P(id); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); } return Math.hypot(x1 - x0, y1 - y0); };
  let trunks = units.filter(u => u.real && u.len > 900 && reach(u) > 700).sort((p, q) => q.len - p.len).slice(0, 9);
  const name = new Map<Unit, string>();
  const build = (cap: number, small: number): boolean => {
    name.clear(); const T = new Set(trunks), families: { of: string; list: Unit[]; axis: XY; rank: number }[] = [];
    const axisOf = (ids: string[]): XY => { let A = ids[0], B = ids[0]; for (const i of ids) for (const j of [ids[0], ids[ids.length - 1]]) if (D(P(i), P(j)) > D(P(A), P(B))) { A = i; B = j; } const d = { x: P(B).x - P(A).x, y: P(B).y - P(A).y }, n = Math.hypot(d.x, d.y) || 1; return Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x / n * Math.sign(d.x || 1), y: d.y / n * Math.sign(d.x || 1) } : { x: -d.x / n * Math.sign(d.y || 1), y: -d.y / n * Math.sign(d.y || 1) }; };   // west to east, or north to south
    const fam = (of: string, axis: XY, rank: number) => { let f = families.find(q => q.of === of); if (!f) families.push(f = { of, list: [], axis, rank }); return f; };
    for (const u of units) {
      if (T.has(u)) continue;
      if (u.runways.size) {
        const rw = air.runways.map((r, i) => ({ r, i, d: Math.min(...r.nodeIds.filter(id => pos.has(id)).map(id => D(P(id), u.mid))) })).filter(o => u.runways.has(o.r.ref)).sort((p, q) => p.d - q.d)[0];
        if (rw) { fam(`r${rw.i}`, axisOf(rw.r.nodeIds.filter(id => pos.has(id))), rw.i).list.push(u); continue; }
      }
      const touch = trunks.map((t, i) => ({ t, i, d: [...u.nodes].some(id => t.nodes.has(id)) ? 0 : Math.min(...[...t.nodes].filter((_, k) => k % 3 === 0).map(id => D(P(id), u.mid))) })).sort((p, q) => p.d - q.d)[0];
      fam(touch ? `t${touch.i}` : 'x', touch ? axisOf([...touch.t.nodes]) : { x: 1, y: 0 }, 100 + (touch?.i ?? 99)).list.push(u);
    }
    families.sort((p, q) => p.rank - q.rank);
    // a small family joins the one before it, so letters last
    for (let i = families.length - 1; i >= 0; i--) if (families[i].list.length < small && families.length > 1) { const j = i > 0 ? i - 1 : 1; families[j].list.push(...families[i].list); families.splice(i, 1); }
    const order = [...trunks].sort((p, q) => nearStand(p) - nearStand(q)); let L = 0;
    if (order.length + families.reduce((s, f) => s + Math.ceil(f.list.length / cap), 0) > LETTERS.length) return false;
    for (const u of order) name.set(u, LETTERS[L++]);        // (nine at most, A to J: never a bare L or R, which "exit left" and "exit right" are typed as)
    for (const f of families) {
      const s = (u: Unit) => u.mid.x * f.axis.x + u.mid.y * f.axis.y; f.list.sort((p, q) => s(p) - s(q) || naturally(p.real ?? '', q.real ?? ''));
      const parts = Math.ceil(f.list.length / cap), each = Math.ceil(f.list.length / parts);
      for (let k = 0; k < f.list.length; k++) name.set(f.list[k], `${LETTERS[L + Math.floor(k / each)]}${k % each + 1}`);
      L += Math.ceil(f.list.length / each);
    }
    return true;
  };
  fit: for (let cap = 9; cap < 60; cap++) for (const small of [3, 6, 9]) if (build(cap, small)) break fit;

  // ── the stands: areas of a hundred, in the order the airport itself numbers them ──
  const groups = new Map<string, number[]>(); stands.forEach((s, i) => { const g = s.ref.match(/^(\d)-/)?.[1] ?? s.ref.match(/^[A-Z]+/)?.[0] ?? `#${Math.floor(Number(s.ref.match(/\d+/)?.[0] ?? 0) / 100)}`; groups.set(g, [...(groups.get(g) ?? []), i]); });
  let areas = [...groups].map(([g, ids]) => ({ gs: [{ g, ids }], n: ids.length, c: { x: ids.reduce((s, i) => s + stXY[i].x, 0) / ids.length, y: ids.reduce((s, i) => s + stXY[i].y, 0) / ids.length } }));
  while (areas.length > 1 && (areas.length > 9 || areas.some(a => a.n < 5))) {
    const a = areas.reduce((m, q) => (q.n < m.n ? q : m)); const b = areas.filter(q => q !== a && a.n + q.n < 99).sort((p, q) => D(p.c, a.c) - D(q.c, a.c))[0]; if (!b) break;
    const n = a.n + b.n; b.c = { x: (a.c.x * a.n + b.c.x * b.n) / n, y: (a.c.y * a.n + b.c.y * b.n) / n }; b.gs.push(...a.gs); b.n = n; areas = areas.filter(q => q !== a);
  }
  areas.sort((p, q) => naturally(p.gs[0].g, q.gs[0].g));
  const standToSimple = new Map<string, string>(); let hundred = 1;
  for (const a of areas) { let k = 0; for (const g of a.gs.sort((p, q) => naturally(p.g, q.g))) for (const i of g.ids.sort((p, q) => naturally(stands[p].ref, stands[q].ref))) { if (++k > 99) { hundred++; k = 1; } standToSimple.set(stands[i].ref, `${hundred}${String(k).padStart(2, '0')}`); } hundred++; }

  // ── the book ──
  const twyToSimple = new Map<string, string>(), twyToReal = new Map<string, string>(), takenNames = new Set<string>();
  const nameOf = new Map<string, string>(), realOf = new Map<string, string>();
  for (const [u, s] of name) { takenNames.add(s); if (u.real) { twyToSimple.set(u.real, s); twyToReal.set(s, u.real); } for (const [a, b] of u.edges) { nameOf.set(key(a, b), s); realOf.set(key(a, b), u.real ?? ''); } }
  for (const [k, u] of alias) nameOf.set(k, name.get(u)!);
  for (const g of ghosts) { let k = 1; while (takenNames.has(`Z${k}`)) k++; takenNames.add(`Z${k}`); twyToSimple.set(g, `Z${k}`); twyToReal.set(`Z${k}`, g); }
  const edges: NameBook['edges'] = [];
  for (const [id, n] of air.nodes) for (const e of n.edges) { if (e.type === 'runway' || e.leadIn) { if (e.taxiway) edges.push({ e, real: e.taxiway, simple: twyToSimple.get(e.taxiway) ?? e.taxiway }); continue; } const s = nameOf.get(key(id, e.to)); if (s) edges.push({ e, real: e.taxiway ?? '', simple: e.taxiway ? twyToSimple.get(e.taxiway)! : s }); }
  const realNodes = new Map([...air.taxiwayNodes].map(([n, ids]): [string, string[]] => [n, [...ids]])), simpleNodes = new Map<string, string[]>();
  for (const [n, ids] of realNodes) simpleNodes.set(twyToSimple.get(n) ?? n, [...ids]);
  for (const [k, s] of nameOf) { const have = simpleNodes.get(s) ?? []; for (const id of k.split('|')) if (!have.includes(id)) have.push(id); simpleNodes.set(s, have); }
  const extra = [...new Set([...nameOf.values()])].filter(s => !twyToReal.has(s));
  return {
    edges, twyToSimple, twyToReal, standToSimple, standToReal: new Map([...standToSimple].map(([r, s]) => [s, r])),
    realNames: [...air.taxiwayNames], realNodes, simpleNames: [...air.taxiwayNames.map(n => twyToSimple.get(n) ?? n), ...extra].sort(naturally), simpleNodes,
  };
}

/** Puts one set of names on the map: lines, lists, stands. */
export function putNames(air: OsmAirport, book: NameBook, to: Naming): void {
  for (const x of book.edges) { const n = to === 'simple' ? x.simple : x.real; if (n) x.e.taxiway = n; else delete x.e.taxiway; }
  const names = to === 'simple' ? book.simpleNames : book.realNames, nodes = to === 'simple' ? book.simpleNodes : book.realNodes;
  air.taxiwayNames.splice(0, air.taxiwayNames.length, ...names);
  air.taxiwayNodes.clear(); for (const [n, ids] of nodes) air.taxiwayNodes.set(n, ids);
  const st = to === 'simple' ? book.standToSimple : book.standToReal, tw = to === 'simple' ? book.twyToSimple : book.twyToReal;
  for (const s of air.stands ?? []) s.ref = st.get(s.ref) ?? s.ref;
  for (const g of air.gates ?? []) g.ref = st.get(g.ref) ?? g.ref;
  for (const h of air.holdingPositions ?? []) if (h.taxiwayRef) h.taxiwayRef = tw.get(h.taxiwayRef) ?? h.taxiwayRef;
}

const TWY_KEYS = new Set(['taxiway', 'via', 'tailTo', 'exitTaxiway', 'holdShortTaxiway', 'taxiRoute', 'intersection', 'lahso', 'names']);
const STAND_KEYS = new Set(['gateRef', 'reservedStand', 'standRef', 'stand']);
const LEAVE = new Set(['air', 'proj', 'perf', 'path', 'nodes', 'bus', 'trail', 'text', 'callsign', 'telephony']);
/** Renames everything already said, planned or pending: plans, clearances, requests, readbacks (plain data, by field name). */
export function renameState(root: unknown, tw: Map<string, string>, st: Map<string, string>, done = new WeakSet<object>(), depth = 0): void {
  if (!root || typeof root !== 'object' || done.has(root) || depth > 12) return; done.add(root);
  if (root instanceof Map || root instanceof Set) { for (const v of root.values()) renameState(v, tw, st, done, depth + 1); return; }
  if (Array.isArray(root)) { for (const v of root) renameState(v, tw, st, done, depth + 1); return; }
  const proto = Object.getPrototypeOf(root); if (proto !== Object.prototype && proto !== null) return;      // plain data only
  const o = root as Record<string, unknown>;
  const turn = (v: unknown, m: Map<string, string>): unknown => (typeof v === 'string' ? m.get(v) ?? v : Array.isArray(v) && v.every(q => typeof q === 'string') ? v.map(q => m.get(q) ?? q) : v);
  for (const [k, v] of Object.entries(o)) {
    if (LEAVE.has(k) || typeof v === 'function') continue;
    const m = TWY_KEYS.has(k) ? tw : STAND_KEYS.has(k) || (k === 'ref' && o.kind === 'stand') ? st : null;
    const n = m ? turn(v, m) : v;
    if (n !== v) try { o[k] = n; } catch { /* frozen */ }
    if (n && typeof n === 'object') renameState(n, tw, st, done, depth + 1);
  }
}

/** Modules that remember things about a session (the ledger, the pilots' minds) say here where, so a switch reaches them. */
const MEMORIES: ((engine: object) => unknown)[] = [];
export function remembersNames(of: (engine: object) => unknown): void { MEMORIES.push(of); }
export function renameMemories(engine: object, tw: Map<string, string>, st: Map<string, string>, done: WeakSet<object>): void {
  for (const of of MEMORIES) { const m = of(engine); if (m && typeof m === 'object') for (const v of Object.values(m)) if (v !== engine) renameState(v, tw, st, done); }
}
