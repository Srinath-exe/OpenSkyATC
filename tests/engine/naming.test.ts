// Taxiway and stand names (lib/sim/naming.ts): one set in, one set out, and nothing an aircraft is doing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers';
import { fromEngine } from '../../src/lib/sim/dispatch';
import { parseCommand } from '../../src/lib/sim/commands';

type Any = any;
for (const icao of ['KSFO', 'KJFK', 'LFPG', 'WSSS', 'RJTT', 'OMDB']) test(`${icao}: simple names are unique, sayable, and come off without a trace`, () => {
  const e = makeEngine(icao, { seed: 5 }) as Any;
  const snap = () => JSON.stringify([e.air.taxiwayNames, [...e.air.taxiwayNodes], e.gates.map((g: Any) => g.ref), e.air.stands.map((s: Any) => s.ref), [...e.air.nodes].map(([id, n]: Any) => [id, n.edges.map((x: Any) => x.taxiway ?? '')])]);
  const before = snap(), n = e.gates.length; assert.equal(e.setNaming('simple'), true);
  const names: string[] = e.air.taxiwayNames, stands: string[] = e.gates.map((g: Any) => g.ref);
  assert.equal(new Set(names).size, names.length); assert.equal(new Set(stands).size, n);
  for (const x of names) assert.match(x, /^[A-HJ-NP-WYZ]\d{0,2}$/);
  for (const x of stands) assert.match(x, /^[1-9]\d\d$/);
  const bare = new Set(names.filter(x => x.length === 1)); for (const x of names) if (x.length > 1) assert.ok(!bare.has(x[0]), `${x}: ${x[0]} is a taxiway by itself`);
  for (const b of ['L', 'R']) assert.ok(!bare.has(b));
  for (const g of e.gates) assert.ok(e.gateByRef(g.ref) === g && (!e.standOf(g) || e.standOf(g).ref === g.ref));
  assert.equal(e.setNaming('simple'), false); assert.equal(e.setNaming('real'), true); assert.equal(snap(), before);
});

test('a switch in the middle: plans, clearances and what is reserved keep meaning the same thing', () => {
  const e = makeEngine('LFPG', { seed: 5 }) as Any; const g = e.gates.find((x: Any) => !x.closed && e.standOf(x)?.size >= 'C');
  const a = e.spawnAt({ callsign: 'AFR12', type: 'A320', kind: 'departure', phase: 'parked', gate: g.ref, onFrequency: 'ground' });
  const rwy = e.runways[0].name, p = e.taxiPlan(a, { kind: 'runway', runway: rwy, intersection: null }, []); assert.ok(!('code' in p) && p.names.length > 1);
  a.exitTaxiway = p.names[0]; a.holdShortTaxiway = p.names[1]; const ref = g.ref, names = [...p.names];
  const r = parseCommand(`AFR12 taxi ${rwy} via ${names.join(' ')}`, fromEngine(e, { position: 'ground' } as never)); assert.ok(r.ok);
  e.setNaming('simple');
  assert.notEqual(g.ref, ref); assert.equal(a.plan.gateRef, g.ref); assert.notEqual(a.exitTaxiway, names[0]);
  const q = e.taxiPlan(a, { kind: 'runway', runway: rwy, intersection: null }, []); assert.deepEqual(q.ids, p.ids, 'the same way out');
  assert.equal(e.otherName(names[0]), a.exitTaxiway, 'an old name can be told its new one');
  assert.ok(parseCommand(`AFR12 taxi ${rwy} via ${q.names.join(' ')}`, fromEngine(e, { position: 'ground' } as never)).ok);
  e.setNaming('real'); assert.equal(g.ref, ref); assert.equal(a.exitTaxiway, names[0]); assert.equal(a.holdShortTaxiway, names[1]);
});

test('spelled letters with a pause are two taxiways; taxiways L and R are not a side', () => {
  const ctx = { aircraft: [{ callsign: 'SWA1', plan: { kind: 'departure', runway: '13L' } }], runways: ['13L'], taxiways: ['A', 'S', 'SA', 'L'], stands: ['1'] } as never;
  assert.deepEqual((parseCommand('SWA1 taxi 13L via sierra, alpha', ctx).ast as Any).via, ['S', 'A']);
  assert.deepEqual((parseCommand('SWA1 taxi 13L via sierra alpha', ctx).ast as Any).via, ['SA']);
});

test('a pause between letters changes the taxiways only: a callsign the clean-up mends stays mended', async () => {
  const { understandHeard } = await import('../../src/lib/voice/asr-nbest');
  const { voiceContext } = await import('../../src/lib/voice/context');
  const e = makeEngine('KJFK', { seed: 3 }) as Any; const g = e.gates.find((x: Any) => !x.closed);
  e.spawnAt({ callsign: 'SWA1176', type: 'A320', kind: 'departure', phase: 'parked', gate: g.ref, onFrequency: 'ground' });
  const ctx = fromEngine(e, { position: 'ground' } as never), st = voiceContext(e, 'ground');
  const hear = async (s: string) => (await understandHeard([s], ctx, e.magVar, null, st)).line;
  const want = 'SWA1176 Taxi RWY 13L via S, A';
  assert.equal(await hear('southwest 1176 taxi to runway 13 left via sierra, alpha'), want);
  // (where the words as heard do not parse by themselves the clean-up's reading stands, callsign and runway included)
  for (const s of ['south west 11 76 taxi to runway 13 left via sierra, alpha', 'southwest 1-1-7-6 taxi to runway 13 left via sierra, alpha', 'southwest 1176, taxi to runway 1 3 left via sierra, alpha']) assert.match(await hear(s), /^SWA1176 Taxi RWY 13L via /, s);
  const plain = (s: string) => s.replace(/,(?= alpha)/, ''); for (const s of ['southwes 1176 taxi to runway 13 left via sierra, alpha', 'south best 1176 taxi to runway 13 left via sierra, alpha']) assert.equal((await hear(s)).split(' ')[0], (await hear(plain(s))).split(' ')[0], `${s}: the same aircraft with and without the pause`);
});
