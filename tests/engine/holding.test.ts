// Holding (holds.ts): the entry from the heading at the fix, the pattern on its side with the wind flown out, the inbound
// leg timed (counted here from 40 degrees before it rolls out, so a one-minute leg reads 60 to 75 s), a new EFC without starting again, the crew asking once the EFC has passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, cmd, dist, advance, NM_TO_M } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { holdEntry, holdFrame } from '../../src/lib/sim/holds';

test('entry sectors: direct, teardrop and parallel by the heading at the fix, mirrored for left turns', () => {
  // right turns, inbound 360: on the inbound course = direct; from the far side heading south-east = teardrop; heading south-west = parallel
  assert.equal(holdEntry(0, 0, 'R'), 'direct'); assert.equal(holdEntry(90, 0, 'R'), 'direct'); assert.equal(holdEntry(290, 0, 'R'), 'direct');
  assert.equal(holdEntry(135, 0, 'R'), 'teardrop'); assert.equal(holdEntry(170, 0, 'R'), 'teardrop');
  assert.equal(holdEntry(225, 0, 'R'), 'parallel'); assert.equal(holdEntry(270, 0, 'R'), 'parallel');
  assert.equal(holdEntry(225, 0, 'L'), 'teardrop'); assert.equal(holdEntry(135, 0, 'L'), 'parallel');
});

const FIX = 'SFONO';
function fly(fromBearing: number, wind: { dir: number; kt: number } | null, dir: 'R' | 'L' | null = null) {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  if (wind) e.weather.setState({ windDirTrue: wind.dir, windKt: wind.kt });
  const fix = e.beacons.find(b => b.id === FIX)!;
  const start = advance(fix, fromBearing, 9 * NM_TO_M), ll = e.proj.toLngLat(start.x, start.y);
  const a = e.spawnAt({ callsign: 'UAL1', type: 'B738', kind: 'arrival', phase: 'approach', posLL: { lat: ll.lat, lng: ll.lng, altFt: 9000 }, heading: (fromBearing + 180) % 360, speedKts: 230 });
  assert.equal(cmd(e, makeAst('hold', 'UAL1', { fix: FIX, inbound: null, dir, legTimeMin: null, legNM: null, efc: null })).code, 'ok_queued');
  run(e, 4);
  const inb = a.holdInboundHdg, turn = a.holdTurnDir;
  // to the fix and through the entry, then three laps measured
  let t = 0; while ((a.holdLaps ?? 0) < 1 && t < 900) { run(e, 1); t++; }
  assert.ok((a.holdLaps ?? 0) >= 1, `back over the fix after the ${a.holdEntry} entry (from ${fromBearing}, wind ${JSON.stringify(wind)}): ${a.holdPhase}, ${(dist(a.pos, fix) / NM_TO_M).toFixed(1)} NM out, hdg ${a.heading.toFixed(0)}`);
  let maxSide = 0, minSide = 0, maxOut = 0, inbS: number[] = [], inbAt = -1, laps = a.holdLaps!;
  for (let i = 0; i < 720 && (a.holdLaps ?? 0) < laps + 3; i++) {
    run(e, 1);
    const f = holdFrame(a.pos, fix, inb, turn);
    maxSide = Math.max(maxSide, f.side); minSide = Math.min(minSide, f.side); maxOut = Math.max(maxOut, f.toGo);
    if (a.holdPhase === 'inbound' && inbAt < 0) inbAt = e.time;
    if ((a.holdLaps ?? 0) > laps) { if (inbAt >= 0) inbS.push(e.time - inbAt); inbAt = -1; laps = a.holdLaps!; }
  }
  return { e, a, entry: a.holdEntry, maxSide, minSide, maxOut, inbS, fix };
}

test('every way in, calm and windy: the right entry, then the racetrack on its own side with a one-minute inbound leg', () => {
  const winds = [null, { dir: 270, kt: 35 }, { dir: 0, kt: 35 }, { dir: 135, kt: 30 }];
  const bad: string[] = []; const seen = new Set<string>();
  for (const w of winds) for (let b = 0; b < 360; b += 30) {
    const r = fly(b, w); seen.add(r.entry ?? '?');
    const tag = `from ${b}, wind ${w ? `${w.dir}/${w.kt}` : 'calm'}, ${r.entry}`;
    if (r.minSide < -1.0 * NM_TO_M) bad.push(`${tag}: ${(-r.minSide / NM_TO_M).toFixed(1)} NM on the wrong side`);
    if (r.maxSide > 4.5 * NM_TO_M) bad.push(`${tag}: ${(r.maxSide / NM_TO_M).toFixed(1)} NM wide`);
    if (r.maxOut > 7 * NM_TO_M) bad.push(`${tag}: ${(r.maxOut / NM_TO_M).toFixed(1)} NM out`);
    const inb = r.inbS.slice(1); if (inb.length && inb.some(s => s < 45 || s > 86)) bad.push(`${tag}: inbound legs ${inb.join(', ')} s`);
  }
  assert.deepEqual([...seen].sort(), ['direct', 'parallel', 'teardrop'], 'all three entries flown');
  assert.equal(bad.length, 0, bad.slice(0, 12).join('\n'));
});

test('left turns as told; holding speed; a new EFC keeps it going round; the crew asks once the EFC has passed', () => {
  const r = fly(90, null, 'L');
  assert.equal(r.a.holdTurnDir, 'L');
  assert.ok(r.minSide > -1.0 * NM_TO_M, 'left-hand pattern on its side');
  assert.ok(r.a.speed <= 231, `holding speed (${r.a.speed.toFixed(0)} kt)`);
  const { e, a } = r, laps = a.holdLaps;
  assert.equal(cmd(e, makeAst('hold', 'UAL1', { fix: FIX, inbound: null, dir: 'L', legTimeMin: null, legNM: null, efc: e.time + 120 })).code, 'ok_queued');
  run(e, 6);
  assert.notEqual(a.holdPhase, 'to_fix', 'not started again'); assert.equal(a.holdLaps, laps);
  let asked = false; for (let i = 0; i < 240 && !asked; i++) { run(e, 1); asked = a.requests.some(q => q.kind === 'further' && q.answeredAt == null); }
  assert.ok(asked, 'asks for further clearance after the EFC');
  assert.ok(dist(a.pos, r.fix) < 9 * NM_TO_M);
});
