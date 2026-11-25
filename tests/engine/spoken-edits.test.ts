// How people really talk (src/lib/sim/spokenEdits.ts): corrections, questions, two aircraft, answers with something added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, text, spawnOnFinal } from './helpers';
import { parseCommand } from '../../src/lib/sim/commands';
import { fromEngine, twoCallsIn } from '../../src/lib/sim/dispatch';
import { describe, makeAst } from '../../src/lib/sim/commandAst';
import { ledgerOf } from '../../src/lib/sim/ledger';
import { understand } from '../../src/lib/voice/understand';

function world() {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = spawnOnFinal(e, 'UAL214', '28L', 18, { altFt: 8000, onFrequency: 'approach' }), b = spawnOnFinal(e, 'DAL88', '28R', 22, { altFt: 9000, onFrequency: 'approach' });
  for (const x of [a, b]) { x.ilsArmed = false; x.ilsCaptured = false; x.fuelMin = 90; }
  return { e, a, b };
}
const line = (e: ReturnType<typeof world>['e'], t: string) => { const r = parseCommand(t, fromEngine(e)); return r.ok && r.ast ? describe(r.ast) : `-- ${r.errors[0]?.message}`; };

test('a correction in the middle of a sentence', () => {
  const { e } = world(); const same = (x: string, y: string) => assert.equal(line(e, x), line(e, y), `${x} => ${line(e, x)}`);
  same('united 214 turn left, correction, right heading 280', 'united 214 turn right heading 280');
  same('united 214 descend to 4000 correction 5000', 'united 214 descend to 5000');
  same('united 214 turn left heading 270, sorry, 290', 'united 214 turn left heading 290');
  same('united 214 cleared ILS 28 left, correction, 28 right', 'united 214 cleared ILS 28R');
  same('united 214 descend to 4000 make that 5000', 'united 214 descend 5000');
  same('united 214 reduce speed to 180, i mean, 190 knots', 'united 214 reduce speed to 190 knots');
  same('united 214 fly heading 270 correction heading 290', 'united 214 fly heading 290');
  same('united 214 cross runway 28 right correction runway 28 left', 'united 214 cross runway 28L');
  same('united 214 descend to 4000 correction altitude 5000', 'united 214 descend to 5000');
  assert.match(line(e, 'united 214 descend to 4000 correction banana'), /^--/);
});
test('questions to the crew are answered, not obeyed', () => {
  const { e } = world();
  for (const [q, k] of [["how's your fuel", 'fuel'], ['what is your heading', 'heading'], ['how high are you', 'altitude'], ["how's the ride", 'ride'], ['where are you', 'position'], ['are you established', 'established']] as const) {
    const r = parseCommand(`united 214 ${q}?`, fromEngine(e)); assert.ok(r.ok, q); assert.deepEqual([(r.ast as { kind: string }).kind, (r.ast as { items: string[] }).items], ['report', [k]], q);
  }
  const r = text(e, "united 214 how's the ride"); assert.equal(r.ok, true); run(e, 6);
  assert.ok(e.events.some(x => x.type === 'readback' && /smooth ride/.test(x.message)));
  assert.match(line(e, 'united 214 where are you parked tonight'), /^--/); assert.match(line(e, "united 214 how's your day going"), /^--/); assert.match(line(e, 'united 214 can you do heading 280 how is that'), /^(?!Report)/);
});
test('two aircraft in one breath', () => {
  const { e } = world(); const c = fromEngine(e);
  assert.deepEqual(twoCallsIn(e, 'united 214 descend to 5000, delta 88 turn left heading 250', c), ['UAL214 DESCEND TO 5000', 'DAL88 TURN LEFT HEADING 250']);
  assert.equal(twoCallsIn(e, 'united 214 descend to 5000', c), null); assert.equal(twoCallsIn(e, 'united 214 descend to 5000, delta 88 banana', c), null);
  const u = understand('united 214 descend to 5000 and delta 88 turn left heading 250', c, e.magVar); assert.ok(u.ok); assert.equal(u.line.split(' | ').length, 2);
  assert.equal(twoCallsIn(e, 'delta 88 cleared visual 28R follow united 214', c), null, 'naming another aircraft is not a second call');
});
test('an answer with something added', () => {
  const { e, a } = world(); a.altitude = 6000; a.targetAltitude = 6000;   // low and close enough that 170 is an ordinary speed
  assert.equal(text(e, 'UAL214 reduce speed to 110').code, 'queried');
  const u = understand('united 214 negative make it 170', fromEngine(e), e.magVar); assert.ok(u.ok, u.error ?? ''); const r = text(e, u.line); assert.equal(r.ok, true, JSON.stringify(r)); run(e, 8); assert.equal(a.targetSpeed, 170);
  assert.equal(text(e, 'UAL214 reduce speed to 110').code, 'queried'); assert.equal(text(e, 'UAL214 approved, and descend to 5000').ok, true); run(e, 8); assert.equal(Math.round(a.targetAltitude), 5000); assert.equal(a.targetSpeed, 130);
  assert.equal(understand('delta 88 approved but hold short of kilo', fromEngine(e), e.magVar).ok, false, 'nothing asked: not an answer');
});
test('approved, but hold short: the offered taxi with the stop put in', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] }); const id = e.air.taxiwayNodes.get('A')![0];
  const a = e.spawnAt({ callsign: 'UAL5', type: 'B738', kind: 'departure', phase: 'taxi', taxiwayNode: id, onFrequency: 'ground', plan: { runway: '28R' } } as never)!; a.path = null; a.speed = 0;
  const p = e.taxiPlan(a, { kind: 'runway', runway: '28R', intersection: null }, []); assert.ok(!('code' in p)); const stop = p.names[p.names.length - 1];
  const t = makeAst('taxi', 'UAL5', { dest: { kind: 'runway', runway: '28R', intersection: null }, via: p.names, auto: false });
  ledgerOf(e).ask('UAL5', { earlier: null, rule: 'taxi_route', question: 'x', offer: t, hard: true }, t, t, e.time);
  const r = text(e, `UAL5 approved but hold short of ${stop}`); assert.equal(r.ok, true, JSON.stringify(r)); run(e, 10); assert.equal(a.holdShortTaxiway, stop);
});
