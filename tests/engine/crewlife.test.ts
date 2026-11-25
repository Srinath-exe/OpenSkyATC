// The frequency's life (src/lib/sim/crewlife.ts): rides, weather, two at once, callsigns alike, mood, crews reacting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, text, spawnOnFinal, evs, advance, NM_TO_M } from './helpers';
import { crewLifeOf, similarCallsigns } from '../../src/lib/sim/crewlife';
import { ledgerOf } from '../../src/lib/sim/ledger';
import { setVoiceStress, voiceFor } from '../../src/lib/tts/pilotSpeech';
import type { SimEngine } from '../../src/lib/sim/engine';

function world(icao = 'EGLL') { const e = makeEngine(icao, { ends: icao === 'KSFO' ? ['28L', '28R'] : ['27R', '27L'] }); e.settings.personas = true; e.settings.radioRealism = true; e.playerPosition = 'approach'; return e; }
function air(e: SimEngine, cs: string, nm = 18, altFt = 8000, type = 'A320') { const a = spawnOnFinal(e, cs, '27L', nm, { type, altFt, onFrequency: 'approach' }); a.ilsArmed = false; a.ilsCaptured = false; a.fuelMin = 90; a.targetAltitude = altFt; a.requests = []; a.standbyUntil = 0; return a; }
const calls = (e: SimEngine, cs: string) => evs(e, 'request', cs).map(x => x.message).join(' | ');

test('rough air: one crew reports it and asks for another level, the level answers it, and it says it is smooth again', () => {
  const e = world(), a = air(e, 'BAW101'); const L = crewLifeOf(e);
  L.addPatch({ ...a.pos }, 7000, 9000, 14, 'moderate'); run(e, 40);
  assert.match(calls(e, 'BAW101'), /moderate chop at .* request/); assert.equal(L.rideOf(a), 'moderate');
  const req = a.requests[0]; assert.equal(req.kind, 'lower'); assert.equal(req.param, 6000);
  assert.equal(text(e, 'BAW101 descend 6000').ok, true); assert.equal(a.requests.length, 0);
  run(e, 130); assert.equal(L.rideOf(a), 'smooth'); assert.match(calls(e, 'BAW101'), /smooth here/);
});
test('a crew that heard the report and is headed there asks about it; one that did not hear anything does not', () => {
  const e = world(), a = air(e, 'BAW101', 10), b = air(e, 'DLH7', 17); const L = crewLifeOf(e); b.heading = 270; a.heading = 270;
  L.addPatch({ ...a.pos }, 7000, 9000, 3, 'moderate'); run(e, 34); assert.match(calls(e, 'BAW101'), /chop/); text(e, 'BAW101 descend 5000'); a.requests = [];
  run(e, 60); assert.match(calls(e, 'DLH7'), /heard the chop report|same here/);
});
test('weather ahead: a deviation is asked for, and a heading answers it', () => {
  const e = world(), a = air(e, 'AFR9', 18); const L = crewLifeOf(e); a.heading = 270; a.targetHeading = 270; L.addCell(advance(a.pos, 272, 9 * NM_TO_M), 3); run(e, 6);
  assert.match(calls(e, 'AFR9'), /request 20 degrees left for weather/); assert.equal(text(e, 'AFR9 turn left heading 250').ok, true); assert.equal(a.requests.length, 0);
});
test('callsigns that sound alike', () => {
  assert.ok(similarCallsigns('UAL214', 'UAL241')); assert.ok(similarCallsigns('UAL214', 'UAL215')); assert.ok(similarCallsigns('UAL214', 'DAL214')); assert.ok(!similarCallsigns('UAL214', 'UAL983')); assert.ok(!similarCallsigns('UAL21', 'DAL21'));
  for (const answer of ['negative', 'affirm', 'disregard'] as const) {
    let asked = false;
    for (let n = 0; n < 40 && !asked; n++) {
      const e = world(); const a = air(e, 'UAL214', 18, 8000), b = air(e, 'UAL241', 22, 9000); crewLifeOf(e); (crewLifeOf(e) as unknown as { rnd: () => number }).rnd = () => 0;
      run(e, 1); assert.equal(text(e, 'UAL214 descend 6000').ok, true);
      const q = ledgerOf(e).pending('UAL241', e.time); if (!q) continue; asked = true;
      assert.match(b.requests[0].text, /was that for us or United two fourteen|was that for us or/);
      const r = text(e, `UAL241 ${answer}`); assert.equal(r.ok, true, JSON.stringify(r)); run(e, 10);
      assert.equal(Math.round(b.targetAltitude), answer === 'affirm' ? 6000 : 9000, answer); assert.equal(Math.round(a.targetAltitude), 6000); assert.equal(b.requests.length, 0);
    }
    assert.ok(asked, answer);
  }
});
test('two at once: the second call is lost and made again; off when the setting is off', () => {
  for (const on of [true, false]) {
    const e = world(); e.settings.radioRealism = on; const a = air(e, 'BAW1', 18), b = air(e, 'BAW902', 24);
    run(e, 1); e.raiseRequest(a, 'higher', 9000); e.raiseRequest(b, 'higher', 9000);
    assert.equal(b.requests.length, on ? 0 : 1); if (on) { assert.ok(evs(e, 'info').some(x => /Two stations/.test(x.message))); run(e, 20); assert.equal(b.requests.length, 1, 'called again'); }
  }
});
test('mood: the third runway is remarked on, a shortcut is thanked, a long wait is remembered', () => {
  const e = world(); const a = air(e, 'VIR5'); const L = crewLifeOf(e); a.plan.runway = '27L';
  assert.equal(L.aside(a, { kind: 'expectRunway', callsign: 'VIR5', runway: '27R' } as never), ''); assert.match(L.aside(a, { kind: 'expectRunway', callsign: 'VIR5', runway: '27L' } as never), /third runway/);
  L.answered(a, 3, 'direct'); assert.match(L.aside(a, { kind: 'heading', callsign: 'VIR5', hdg: 90 } as never), /wait|wonder/);
});
test('the voice follows the stress, and comes back', () => {
  const calm = voiceFor('BAW12'); setVoiceStress('BAW12', 1); const hot = voiceFor('BAW12'); assert.ok(hot.speed > calm.speed && hot.detune > calm.detune && hot.voice === calm.voice); setVoiceStress('BAW12', 0); assert.deepEqual(voiceFor('BAW12'), calm);
});
test('quiet crews (lessons): no chat, no calls', () => { const e = world(); e.settings.quietCrews = true; const a = air(e, 'BAW101'); crewLifeOf(e).addPatch({ ...a.pos }, 7000, 9000, 14); run(e, 60); assert.doesNotMatch(calls(e, 'BAW101'), /chop/); });
// how much of this a session gets: an hour with the player on approach must stay a working frequency
for (const icao of ['KSFO', 'EGLL']) test(`${icao}: how talkative an hour is`, () => {
  const e = makeEngine(icao, { ends: icao === 'KSFO' ? ['28L', '28R'] : ['27R', '27L'], pilotDelay: null }); e.settings.personas = true; e.settings.radioRealism = true;
  e.settings.autoMode = true; e.settings.autoTower = true; e.settings.autoGround = true; e.settings.autoApproach = true;
  (e as unknown as { playerWorks: () => boolean }).playerWorks = () => true;        // the AI flies it, the crews talk as to a player
  let t = 0, sep = 0; while (e.time < 3600) { if (e.time >= t && e.aircraft.filter(x => x.phase !== 'parked').length < 16) { if ((t / 45) % 2 < 1) e.spawnArrival(); else e.spawnDeparture(); t = e.time + 45; } run(e, 5); }
  sep = e.aircraft.length; const s = crewLifeOf(e).stats; const n = Object.entries(s).filter(([k]) => !['thanks', 'bye', 'waited', 'runwayChange'].includes(k)).reduce((x, [, v]) => x + v, 0);
  console.log(icao, 'extra calls in an hour', n, JSON.stringify(s), 'aircraft', sep); assert.ok(n < 60, `${n} extra calls`);
});
