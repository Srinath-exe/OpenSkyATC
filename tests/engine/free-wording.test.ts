// Everyday wording (src/lib/sim/freeWording.ts) and step-by-step taxi clearances (TaxiAst.limit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers';
import { parseCommand } from '../../src/lib/sim/commands';
import { dispatch, fromEngine } from '../../src/lib/sim/dispatch';
import { describe } from '../../src/lib/sim/commandAst';

function landed(seed = 4) {
  const e = makeEngine('KSFO', { seed, emergencies: 'off', pilotDelay: null, ends: ['28L', '28R'] } as never) as never as Record<string, any>;
  e.settings.autoApproach = e.settings.autoTower = true; e.settings.autoGround = false; e.playerPosition = 'tower';
  for (let i = 0; i < 4; i++) e.spawnArrival();
  const t0 = e.time; let a: any = null;
  while (e.time - t0 < 2400 && !a) { e.step(2); a = e.aircraft.find((x: any) => x.plan.kind === 'arrival' && x.phase === 'taxi' && x.requests.some((r: any) => r.kind === 'taxi_in' && r.answeredAt == null)); }
  assert.ok(a, 'an arrival has landed and asked for taxi');
  return { e, a };
}
const S = landed();
const parse = (cs: string, t: string) => parseCommand(`${cs} ${t}`, fromEngine(S.e as never) as never);
const air = () => S.e.aircraft.find((x: any) => x.altitude > 3000) as any;

test('altitude, speed, heading, approach and landing in everyday words', () => {
  const cs = air().callsign;
  const same: [string, string][] = [
    ['reduce altitude to three thousand feet', 'descend to three thousand'], ['drop to three thousand feet please', 'descend to three thousand'], ['get down to 3000', 'descend to 3000'],
    ['I need you at three thousand feet', 'maintain three thousand'], ['take it up to flight level one one zero', 'climb to flight level one one zero'],
    ['cut your speed to one eighty knots', 'reduce speed to one eighty'], ['give me two ten knots', 'maintain two one zero knots'],
    ['swing right heading three one zero', 'turn right heading three one zero'], ['head two four zero', 'fly heading two four zero'],
    ['you can land on two eight left', 'cleared to land two eight left'], ['clear for the ILS two eight left', 'cleared ils two eight left'], ['take the ILS two eight left', 'cleared ils two eight left'],
  ];
  for (const [free, std] of same) {
    const a = parse(cs, free), b = parse(cs, std);
    assert.ok(a.ok, `${free}: ${a.errors[0]?.message}`); assert.ok(b.ok, std);
    assert.equal(describe(a.ast!), describe(b.ast!), free);
  }
});

test('a negation, a question or a number that does not fit is never turned into an instruction', () => {
  const cs = air().callsign;
  for (const t of ['do not descend to three thousand', "don't drop to three thousand feet", 'did you descend to three thousand', 'can you see the traffic at three thousand feet', 'drop to one eighty', 'reduce altitude by one thousand feet', 'head for lunch', 'you can land when ready maybe not'])
    assert.equal(parse(cs, t).ok, false, t);
});

test('a question only ever asks: it is a report, never an instruction that moves the aircraft', () => {
  const cs = air().callsign;
  for (const t of ['what is your altitude', 'how high are you', 'what is your heading', 'what speed are you']) { const r = parse(cs, t); assert.ok(r.ok, t); assert.equal((r.ast as any).kind, 'report', t); }
  for (const t of ['what is your altitude three thousand', 'can you descend to three thousand or not', 'is your heading two eight zero']) { const r = parse(cs, t); assert.ok(!r.ok || (r.ast as any).kind !== 'report', t); }
});

test('ground steps in everyday words', () => {
  const cs = S.a.callsign;
  const limit: [string, string][] = [['taxi to kilo', 'K'], ['go to bravo and hold there', 'B'], ['keep going on bravo until echo', 'E'], ['turn left on kilo and hold short of alpha', 'A'], ['cross runway two eight right and hold short of kilo', 'K'], ['cross two eight right, hold short of bravo, report holding', 'B']];
  for (const [t, twy] of limit) {
    const r = parse(cs, t); assert.ok(r.ok, `${t}: ${r.errors[0]?.message}`);
    const ast = r.ast as any; assert.equal(ast.kind, 'taxi', t); assert.equal(ast.limit, 'hold', t); assert.equal(ast.holdShortOf.taxiway, twy, t);
    const again = parse(cs, describe(ast).toLowerCase()); assert.ok(again.ok, describe(ast)); assert.deepEqual(again.ast, ast, describe(ast));
  }
  const g = parse(cs, 'head to your gate'); assert.equal((g.ast as any).dest.ref, S.a.plan.gateRef);
  assert.equal(parse(cs, 'do not cross two eight right').ok, false);
  assert.equal(parse(cs, 'are you holding short of kilo').ok, false);
});

test('step by step: across the runway, stop, call; the next step; then the stand', () => {
  const { e, a } = landed();
  const say = (t: string) => { const r = parseCommand(`${a.callsign} ${t}`, fromEngine(e as never) as never); assert.ok(r.ok, `${t}: ${r.errors[0]?.message}`); const d = dispatch(e as never, r.ast!); assert.ok(d.ok, `${t}: ${d.reason ?? d.readback}`); return d; };
  const until = (f: () => boolean, s: number) => { const t = e.time; while (e.time - t < s && !f()) e.step(1); return f(); };
  const called = () => a.requests.some((r: any) => r.answeredAt == null && /request further taxi/.test(r.text));
  assert.match(say('cross runway 28R, hold short of B').readback, /hold short Bravo/i);
  assert.ok(until(called, 300), 'calls at the limit'); assert.ok(a.speed < 0.5);
  assert.match(a.requests[0].text, /holding short of Bravo/);
  const here = { ...a.pos }; for (let i = 0; i < 40; i++) e.step(1);
  assert.ok(Math.hypot(a.pos.x - here.x, a.pos.y - here.y) < 2, 'goes no further on its own');
  say('taxi via B hold short of H'); assert.ok(until(called, 400), 'calls at the next limit'); assert.match(a.requests[0].text, /Hotel/);
  say(`taxi to stand ${a.plan.gateRef}`); assert.ok(until(() => a.phase === 'arrived', 900), 'reaches its stand');
});

test('"cross" before reaching the line: only the next runway on the route, and it is crossed without stopping', () => {
  const { e, a } = landed(5);
  const r = dispatch(e as never, parseCommand(`${a.callsign} cross runway 28R`, fromEngine(e as never) as never).ast!);
  if (r.ok) { const t = e.time; while (e.time - t < 300 && !a.requests.some((q: any) => q.answeredAt == null && /request further taxi/.test(q.text))) e.step(1); assert.ok(a.requests.some((q: any) => /clear of runway two eight right/.test(q.text)), 'stops once across and calls'); assert.ok(e.distToRunway(a.pos, e.refOf('28R')) > 60); }
  else assert.equal(r.code, 'queried');
});
