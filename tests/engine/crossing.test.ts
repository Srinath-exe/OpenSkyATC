// The AI ground controller and runway crossings: it crosses behind an aircraft that has rolled past, never in front of one,
// and another open call from the same crew does not hide the crossing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, spawnOnFinal, ledgerHas, headingTo } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import type { SimEngine } from '../../src/lib/sim/engine';

type Any = any;   // eslint-disable-line @typescript-eslint/no-explicit-any
/** A departure from A1 to 28L, stopped short of 01L which it has to cross (the route of ground.test.ts). */
function atCrossing(): { e: SimEngine; a: Any } {
  const e = makeEngine('KSFO', { ends: ['28L', '28R', '01L', '01R'], pilotDelay: 1, emergencies: 'off' } as never);
  const a: Any = e.spawnDeparture({ callsign: 'UAL5', type: 'B738', runway: '28L', stand: 'A1' } as never)!;
  e.settings.autoGround = false;
  cmd(e, makeAst('pushback', 'UAL5', { dir: 'any', expectRunway: '28L', startup: true, tailTo: null }));
  assert.ok(runUntil(e, () => a.phase === 'taxi' || a.phase === 'startup' && a.requests.some((r: Any) => r.kind === 'taxi'), 400).ok, 'pushed');
  runUntil(e, () => a.requests.some((r: Any) => r.kind === 'taxi'), 200);
  cmd(e, makeAst('taxi', 'UAL5', { dest: { kind: 'runway', runway: '28L', intersection: null }, via: [], auto: true, holdShortOf: null, cross: [], expedite: false }));
  assert.ok(runUntil(e, () => a.phase === 'hold_short' && !!a.holdShortRunway && !a.path.holds[0].isDepartureEntry, 600).ok, 'holds short of the runway to cross');
  run(e, 12);
  return { e, a };
}

test('the crossing call is answered first, whatever else the crew has asked', () => {
  const { e, a } = atCrossing();
  a.requests.unshift({ id: 9999, kind: 'min_fuel', callsign: 'UAL5', text: 'minimum fuel', param: null, at: e.time, recallAt: e.time + 999, expiresAt: e.time + 9999, answeredAt: null });
  e.settings.autoGround = true;
  assert.ok(runUntil(e, () => a.holdReleased || a.phase !== 'hold_short', 60).ok, `still waiting: ${JSON.stringify(a.requests.map((r: Any) => r.kind))}`);
});

test('a crew with no call open is still crossed once it is safe', () => {
  const { e, a } = atCrossing(); a.requests.length = 0; (e as Any).sc(a).nextRequestAt = null;
  e.settings.autoGround = true;
  assert.ok(runUntil(e, () => a.holdReleased || a.phase !== 'hold_short', 60).ok, 'crossed');
});

test('crossing behind a landed aircraft: not while it comes toward the crossing, yes once it is well past', () => {
  const { e, a } = atCrossing(); const E: Any = e; const rw = a.holdShortRunway as string;
  const rs = e.runwayState(rw)!; const seg = E.runwaySegment(rs.ref); const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  const ux = (seg.b.x - seg.a.x) / len, uy = (seg.b.y - seg.a.y) / len; const at = (a.pos.x - seg.a.x) * ux + (a.pos.y - seg.a.y) * uy;
  const b: Any = spawnOnFinal(e, 'UAL900', rw, 9); const h = headingTo(seg.a, seg.b);
  // on the runway, rolling from seg.a to seg.b (or back)
  const put = (m: number, back = false) => { b.phase = 'rollout'; b.speed = 60; b.pos = { x: seg.a.x + ux * m, y: seg.a.y + uy * m }; b.heading = back ? (h + 180) % 360 : h; };
  for (const o of E.bothEnds(rs.ref)) { o.occupiedBy.length = 0; } e.addOccupant(rw, b, 'rollout');
  const safe = () => E.crossingSafe(rw, 35, true, a.pos) as boolean;
  put(at - 400); assert.equal(safe(), false, 'rolling toward the crossing');
  put(at + 100); assert.equal(safe(), false, 'only just past');
  put(at + 700); assert.equal(safe(), true, 'well past and going away');
  put(at + 700, true); assert.equal(safe(), false, 'well away, but coming back (a backtrack)');
  put(at + 700); b.speed = 0; assert.equal(safe(), false, 'stopped on the runway');
  put(at + 700); assert.equal(E.crossingSafe(rw, 35, true) as boolean, false, 'without a crossing point the whole roll counts');
  assert.ok(!ledgerHas(e, 'RWY_INCURSION'));
});
