// What a crew says about an instruction in the air, and the fuel ladder (src/lib/sim/airmind.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, text, spawnOnFinal, evs, advance, NM_TO_M } from './helpers';
import { airMindOf } from '../../src/lib/sim/airmind';
import { dispatch } from '../../src/lib/sim/dispatch';
import { ledgerOf } from '../../src/lib/sim/ledger';
import { makeAst } from '../../src/lib/sim/commandAst';

function inbound(cs: string, type = 'B738', nm = 18, altFt = 6000) {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, cs, '27L', nm, { type, altFt, onFrequency: 'approach' }); a.ilsArmed = false; a.ilsCaptured = false; a.fuelMin = 90;
  return { e, a };
}

test('a speed below the minimum: unable, with what they can do; approved gives it, repeating it does not', () => {
  const { e, a } = inbound('UAL934', 'B77W');
  const q = text(e, 'UAL934 reduce speed to 120'); assert.equal(q.code, 'queried'); assert.match(q.readback, /unable 120 knots, 140 is our minimum, we can do that/);
  assert.match(text(e, 'UAL934 reduce speed to 120').readback, /still unable 120/);
  assert.equal(text(e, 'UAL934 approved').ok, true); run(e, 8); assert.equal(a.targetSpeed, 140);
});
test('too fast below ten thousand; "negative" leaves things as they are', () => {
  const { e, a } = inbound('BAW10'); const was = a.targetSpeed;
  assert.match(text(e, 'BAW10 increase speed to 300').readback, /250 is the best we can do below ten thousand/);
  const r = text(e, 'BAW10 negative'); assert.equal(r.ok, true); run(e, 8); assert.equal(a.targetSpeed, was);
});
test('a speed they cannot fly inside a longer call: one question, and approved does the whole call with the speed they can fly', () => {
  const { e, a } = inbound('UAL935', 'B77W'); const r = text(e, 'UAL935 turn left heading 240, reduce speed to 120');
  assert.equal(r.code, 'queried'); assert.match(r.readback, /unable 120 knots, 140 is our minimum/);
  assert.equal(text(e, 'UAL935 approved').ok, true); run(e, 8);
  assert.equal(a.targetSpeed, 140); assert.ok(Math.abs(a.targetHeading - 240) < 6, `heading ${a.targetHeading}`);
});
test('a heavy slowed far out asks once; the same again is done', () => {
  const { e, a } = inbound('SIA321', 'A388', 30, 9000);
  assert.match(text(e, 'SIA321 reduce speed to 180').readback, /could we keep 210/);
  assert.equal(text(e, 'SIA321 reduce speed to 180').ok, true); run(e, 8); assert.equal(a.targetSpeed, 180);
  const { e: e2 } = inbound('BAW11', 'B738', 12, 5000); assert.equal(text(e2, 'BAW11 reduce speed to 180').ok, true, 'near the field it is normal');
});
test('a turn at traffic is questioned; a clear one is not', () => {
  const { e, a } = inbound('BAW20', 'B738', 20, 5000); a.heading = 270; a.targetHeading = 270; a.speed = 200; a.targetAltitude = 5000;
  const b = spawnOnFinal(e, 'DLH7', '27L', 20, { altFt: 5000, onFrequency: 'approach' }); b.ilsArmed = false; b.ilsCaptured = false;
  b.pos = advance(a.pos, 360, 4 * NM_TO_M); b.heading = 180; b.targetHeading = 180; b.speed = 200; b.altitude = 5000; b.targetAltitude = 5000; a.heading = 90; a.targetHeading = 90;
  const q = text(e, 'BAW20 turn left heading 360'); assert.equal(q.code, 'queried'); assert.match(q.readback, /that turn takes us at traffic/);
  assert.equal(text(e, 'BAW20 turn right heading 120').ok, true);
});
test('too high for the approach: they ask for a longer final; roger has them try', () => {
  const { e, a } = inbound('AFR5', 'A320', 9, 7000); a.heading = 270;
  const q = text(e, 'AFR5 cleared ILS 27L'); assert.equal(q.code, 'queried'); assert.match(q.readback, /too high for that/);
  assert.equal(text(e, 'AFR5 roger').ok, true); run(e, 8); assert.ok(a.ilsArmed || a.ilsCaptured);
  const { e: e2, a: a2 } = inbound('AFR6', 'A320', 11, 3000); a2.heading = 270; assert.equal(text(e2, 'AFR6 cleared ILS 27L').ok, true);
});
test('fuel: a heads-up, then minimum fuel, then MAYDAY; minimum fuel cannot hold; AI controllers are not questioned', () => {
  const { e, a } = inbound('BAW30', 'A320', 24, 6000); e.settings.emergencyRate = 'off';
  a.delay.airborneS = 900; a.fuelMin = 36.5; a.requests = []; a.standbyUntil = 0; run(e, 3);
  assert.match(a.requests[0]?.text ?? '', /minutes before minimum fuel/); assert.equal(text(e, 'BAW30 roger').ok, true);
  a.fuelMin = 29.9; run(e, 3); assert.match(a.requests[0]?.text ?? '', /minimum fuel, 30 minutes remaining/); assert.ok(airMindOf(e).isMinimumFuel(a));
  const fix = e.beacons[0].id; const h = text(e, `BAW30 hold at ${fix}`); assert.equal(h.code, 'queried'); assert.match(h.readback, /unable to hold, we're minimum fuel/);
  ledgerOf(e).close('BAW30'); assert.notEqual(dispatch(e, makeAst('hold', 'BAW30', { fix }), { who: 'ai' }).code, 'queried');
  a.fuelMin = 19.9; run(e, 3); assert.equal(a.emergency?.type, 'fuel', 'MAYDAY FUEL');
  const b = spawnOnFinal(e, 'BAW31', '27L', 5, {}); b.fuelMin = 29; run(e, 5); assert.ok(!airMindOf(e).isMinimumFuel(b), 'established and nearly down: nothing said');
});
test('"affirm" answers a report', () => {
  const { e, a } = inbound('BAW40'); a.delay.airborneS = 900; a.fuelMin = 36; a.requests = []; run(e, 3); assert.equal(text(e, 'BAW40 affirm').ok, true); assert.ok(evs(e, 'request', 'BAW40').length);
});
// a good controller is hardly ever questioned: the AI works the airport and every instruction is put to the crew first
for (const icao of ['KSFO', 'EGLL']) test(`${icao}: the AI controllers' own instructions, put to the crews`, () => {
  const e = makeEngine(icao, { ends: icao === 'KSFO' ? ['28L', '28R'] : ['27L', '27R'], pilotDelay: null }); e.settings.personas = true; const m = airMindOf(e); let n = 0; const q: Record<string, number> = {}; const ex: string[] = [];
  const E = e as unknown as Record<string, (...x: unknown[]) => unknown>;
  const wrap = (name: string, ast: (a: { callsign: string }, r: unknown[]) => unknown) => { const f = E[name].bind(e); E[name] = (a: unknown, ...r: unknown[]) => { n++; const p = ast(a as { callsign: string }, r) as never; const d = m.check(e, a as never, p, [p]); if (d) { q[d.rule] = (q[d.rule] ?? 0) + 1; ex.push(d.question); } return f(a, ...r); }; };
  wrap('cmdHeading', (a, r) => makeAst('heading', a.callsign, { hdg: r[0] as number })); wrap('cmdAltitude', (a, r) => makeAst('altitude', a.callsign, { ft: r[0] as number }));
  wrap('cmdSpeed', (a, r) => makeAst('speed', a.callsign, { kts: r[0] as number })); wrap('cmdILS', (a, r) => makeAst('ils', a.callsign, { runway: r[0] as string }));
  e.settings.autoMode = true; e.settings.autoTower = true; e.settings.autoGround = true; e.settings.autoApproach = true;
  let t = 0; while (e.time < 2400) { if (e.time >= t && e.aircraft.filter(x => x.phase !== 'parked').length < 16) { if ((t / 45) % 2 < 1) e.spawnArrival(); else e.spawnDeparture(); t = e.time + 45; } run(e, 5); } const tot = Object.values(q).reduce((x, y) => x + y, 0);
  console.log(icao, 'instructions', n, 'questioned', tot, JSON.stringify(q), 'aircraft', e.aircraft.length, 'stats', JSON.stringify(m.stats)); ex.slice(0, 6).forEach(x => console.log('   ', x));
  if (n > 50) assert.ok(tot / n < 0.05, `${tot} of ${n}`);
});
