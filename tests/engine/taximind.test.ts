// What a crew says about a taxi clearance before it moves (src/lib/sim/taximind.ts): too wide, not on the chart, does not
// connect, too much at once, head-on with someone, a stand that is taken or too small; what it offers instead, and the
// answers "approved", "negative" and the same instruction again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, text } from './helpers';
import { ledgerOf } from '../../src/lib/sim/ledger';
import { taxiMindOf } from '../../src/lib/sim/taximind';
import { taxiLimitsOf } from '../../src/lib/sim/taxiLimits';
import { personaOf, type PersonaKind } from '../../src/lib/sim/persona';
import { dispatch } from '../../src/lib/sim/dispatch';
import { makeAst } from '../../src/lib/sim/commandAst';
import type { SimEngine } from '../../src/lib/sim/engine';

type E = SimEngine;
/** A departure stopped on the named taxiway, engines running, talking to ground. */
function onTaxiway(e: E, cs: string, type: string, taxiway: string, runway = '28R', nth = 0) {
  const ids = e.air.taxiwayNodes.get(taxiway)!; const id = ids[Math.min(nth, ids.length - 1)];
  const a = e.spawnAt({ callsign: cs, type, kind: 'departure', phase: 'taxi', taxiwayNode: id, onFrequency: 'ground', plan: { runway } } as never)!;
  assert.ok(a, `${cs} spawned`); a.path = null; a.speed = 0; a.phase = 'taxi';
  return a;
}
const csOf = (kind: PersonaKind, al = 'UAL') => { for (let n = 100; n < 900; n++) if (personaOf(`${al}${n}`).kind === kind) return `${al}${n}`; throw new Error(kind); };

test('a taxiway that does not exist: the crew says so and offers its own way; "approved" gives it', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); const a = onTaxiway(e, 'UAL214', 'B738', 'A');
  const ast = makeAst('taxi', 'UAL214', { dest: { kind: 'runway', runway: '28R', intersection: null }, via: ['A', 'X'], auto: false });
  const d = taxiMindOf(e).check(e, a, ast); assert.equal(d?.rule, 'taxi_unknown'); assert.match(d!.question, /don't see a taxiway X/);
  assert.equal(d!.hard, true); assert.ok(d!.offer);
});

test('a call the crew cannot make out is asked back, not just refused on the screen', async () => {
  const { executeText } = await import('../../src/lib/sim/dispatch');
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); onTaxiway(e, 'UAL214', 'B738', 'A');
  const r = executeText(e, 'UAL214 taxi to runway 28R via A X');
  assert.ok(r.ask || r.result.code === 'queried', JSON.stringify(r.result)); if (r.ask) assert.match(r.ask, /say again/);
});

test('too much at once: a crew new to the airport asks for it in steps; approved = the first step, negative = as cleared', () => {
  for (const answer of ['approved', 'negative', 'again'] as const) {
    const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); (e.settings as { personas?: boolean }).personas = true;
    const cs = csOf('visitor'); const a = onTaxiway(e, cs, 'B738', 'M');
    const p = e.taxiPlan(a, { kind: 'runway', runway: '28R', intersection: null }, []); assert.ok(!('code' in p));
    const via = [...p.names]; while (via.length < 6) via.push(via[via.length - 2]);
    const line = `${cs} taxi to runway 28R via ${via.join(' ')}`;
    const q = text(e, line); if (q.code !== 'queried') { console.log(p.names, q); }
    assert.equal(q.code, 'queried'); assert.match(q.readback, /in steps|progressive|slowly/);
    assert.equal(a.path, null, 'nothing done while the question is open');
    const open = ledgerOf(e).pending(cs, e.time)!; assert.equal(open.rule, 'taxi_complex');
    const r = text(e, answer === 'again' ? line : `${cs} ${answer}`); assert.equal(r.ok, true, `${answer}: ${JSON.stringify(r)}`);
    run(e, 12);
    assert.ok(a.path, `${answer}: taxiing`);
    if (answer === 'approved' && open.offer) assert.ok(a.holdShortTaxiway, 'first step only'); else if (answer !== 'approved') assert.equal(a.holdShortTaxiway, null);
  }
});

test('a captain takes the same long route without a word', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); (e.settings as { personas?: boolean }).personas = true;
  const cs = csOf('captain'); const a = onTaxiway(e, cs, 'B738', 'M');
  const p = e.taxiPlan(a, { kind: 'runway', runway: '28R', intersection: null }, []); assert.ok(!('code' in p));
  assert.equal(text(e, `${cs} taxi to runway 28R via ${p.names.join(' ')}`).ok, true);
});

test('S between Z and S2 is closed to wingspans over 215 ft (FAA remark): an A380 refuses, a 737 does not', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const lim = taxiLimitsOf(e.air); const edges: Array<[string, string]> = [];
  for (const id of e.air.taxiwayNodes.get('S')!) for (const x of e.air.nodes.get(id)!.edges) if (x.taxiway === 'S' && lim.tooWide(id, x.to, 79.8)) edges.push([id, x.to]);
  assert.ok(edges.length > 0, 'the stretch is on the map');
  assert.ok(edges.every(([a, b]) => !lim.tooWide(a, b, 35.8)), 'a 737 fits');
  assert.ok(edges.every(([a, b]) => !lim.tooWide(a, b, 64.8)), 'a 777 fits (212 ft)');
  assert.equal(lim.firstRefused(edges[0], 79.8, true), 'S');
});

test('head-on on one taxiway: the crew names the traffic and offers another way', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  let asked = 0, tried = 0;
  for (const [x, y] of [['A', 'M'], ['B', 'M'], ['A', 'F'], ['B', 'C'], ['A', 'C'], ['M', 'A']] as const) {
    const n = tried++; const a = onTaxiway(e, `UAL${300 + n}`, 'B738', x, '28R', n), b = onTaxiway(e, `DAL${400 + n}`, 'B738', y, '01L', n);
    const pa = e.taxiPlan(a, { kind: 'runway', runway: '28R', intersection: null }, []); if ('code' in pa || !pa.names.length) continue;
    // the other one comes the other way along a stretch of it
    const part = pa.ids.slice(Math.floor(pa.ids.length * 0.25), Math.floor(pa.ids.length * 0.5)).reverse(); if (part.length < 3) continue;
    (e as unknown as { sc(a: unknown): { routeIds: string[] } }).sc(b).routeIds = part; b.pos = { ...e.nodeXY(part[0])! };
    const d = taxiMindOf(e).check(e, a, makeAst('taxi', a.callsign, { dest: { kind: 'runway', runway: '28R', intersection: null }, via: pa.names, auto: false }));
    if (d?.rule === 'taxi_traffic') { asked++; assert.match(d.question, /coming the other way/); assert.ok(d.offer); assert.equal(d.hard, false); }
    e.aircraft.splice(0, e.aircraft.length);
  }
  assert.ok(asked > 0, `asked ${asked} of ${tried}`);
});

test('a stand that is too small, and one that is taken: the crew offers one that works', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = onTaxiway(e, 'UAL900', 'B77W', 'A'); a.plan.kind = 'arrival'; a.plan.gateRef = null as never; a.phase = 'taxi';
  const small = e.air.stands.find(s => s.size === 'C' && !e.standOccupant(s.ref))!;
  const d = taxiMindOf(e).check(e, a, makeAst('taxi', 'UAL900', { dest: { kind: 'stand', ref: small.ref } }));
  assert.equal(d?.rule, 'taxi_stand'); assert.match(d!.question, /too small/); assert.equal(d!.hard, true);
  const g = e.gateByRef('A1')!; const other = onTaxiway(e, 'DAL5', 'B738', 'B'); g.reservedFor = other.id;
  const c = onTaxiway(e, 'AAL7', 'B738', 'A', '28R', 3); c.plan.kind = 'arrival'; c.plan.gateRef = null as never;
  const q = text(e, 'AAL7 taxi to stand A1'); assert.equal(q.code, 'queried'); assert.match(q.readback, /has stand A1/);
});

test('"approved" with nothing asked is not a clearance; AI controllers are never questioned', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); onTaxiway(e, 'UAL214', 'B738', 'A');
  const r = text(e, 'UAL214 approved'); assert.equal(r.ok, false); assert.equal(r.code, 'nothing_pending');
  const bad = makeAst('taxi', 'UAL214', { dest: { kind: 'runway', runway: '28R', intersection: null }, via: ['NOPE'], auto: false });
  assert.equal(dispatch(e, bad, {}).code, 'queried', 'a player is asked');
  ledgerOf(e).close('UAL214');
  assert.notEqual(dispatch(e, bad, { who: 'ai' }).code, 'queried', 'the AI is not'); assert.equal(ledgerOf(e).pending('UAL214', e.time), null);
});

// the route the game itself suggests must never be refused, at any airport, for any size; and a wide one is never left without a way
for (const icao of ['KSFO', 'EGLL', 'KLAX', 'KJFK', 'VIDP', 'OMDB']) test(`${icao}: the crew's own route is never questioned (all sizes)`, () => {
  const e = makeEngine(icao); let n = 0, none = 0; const bad: string[] = [];
  const ends = e.runways.map(r => r.name); const names = e.air.taxiwayNames;
  for (const type of ['B738', 'B77W', 'A388']) for (let k = 0; k < 40; k++) {
    const tw = names[(k * 7 + type.length) % names.length], rw = ends[(k * 3) % ends.length];
    const a = onTaxiway(e, `TST${100 + n}`, type, tw, rw, k % 4); n++;
    const dest = { kind: 'runway' as const, runway: rw, intersection: null };
    const p = e.taxiPlan(a, dest, []);
    if ('code' in p) { none++; } else if (p.names.length) {
      const d = taxiMindOf(e).check(e, a, makeAst('taxi', a.callsign, { dest, via: p.names, auto: false }));
      if (d) bad.push(`${type} ${tw}->${rw} via ${p.names.join(' ')}: ${d.rule} ${d.question}`);
    }
    e.aircraft.splice(0, e.aircraft.length);
  }
  console.log(icao, `${n} routes, ${none} unreachable, questioned ${bad.length}`); bad.slice(0, 8).forEach(b => console.log('  ', b));
  assert.equal(bad.length, 0);
});

test('approving an offer is a complete clearance: no penalty for a runway on the new way', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); (e.settings as { region: string }).region = 'FAA'; let n = 0;
  for (const tw of ['A', 'B', 'M', 'Z', 'S', 'F', 'C', 'K']) {
    const cs = `UAL${500 + n}`; const a = onTaxiway(e, cs, 'B738', tw, '28L', n % 3); const before = e.stats.ledger.length;
    const d = taxiMindOf(e).check(e, a, makeAst('taxi', cs, { dest: { kind: 'runway', runway: '28L', intersection: null }, via: ['NOPE'], auto: false }));
    if (d?.offer) { const ask = (ledgerOf(e) as { ask: (...x: unknown[]) => void }); ask.ask(cs, d, d.offer as never, d.offer, e.time); const r = text(e, `${cs} approved`); assert.equal(r.ok, true, JSON.stringify(r)); n++; }
    assert.ok(!e.stats.ledger.slice(before).some(l => l.code === 'TAXI_INCOMPLETE'), `${tw}: TAXI_INCOMPLETE`);
    e.aircraft.splice(0, e.aircraft.length);
  }
  assert.ok(n >= 3, `${n} offers approved`);
});
