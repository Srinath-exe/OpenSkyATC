// The second opinion on shaky rules readings, cut-off calls, sides that are not sides (src/lib/voice/verify.ts, understand.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/lib/sim/commands';
import { understandVoice } from '../../src/lib/voice/understand';
import { cutOff, kindVeto, roundTrip, shaky } from '../../src/lib/voice/verify';

const ctx = { aircraft: [{ callsign: 'UAE280', altitude: 5000 }, { callsign: 'RYR117', altitude: 4000 }, { callsign: 'JBU562', altitude: 0, plan: { kind: 'departure', runway: '27' } }] } as never;
const ast = (l: string) => { const p = parseCommand(l, ctx); assert.ok(p.ok && p.ast, l); return p.ast!; };
const model = (line: string) => ({ complete: async () => ({ line, confidence: 0.99, ms: 1, sayAgain: false }) });
const state = { text: '@APP 25\nUAE280 emirates 280 ARR APP approach 5000ft h100 25', callsigns: ['UAE280', 'RYR117', 'JBU562'] };

test('cut off in the middle', () => {
  for (const t of ['ryanair 117 climb to eight thousand and then', 'taxi via alpha then', 'line up and', 'start your']) assert.ok(cutOff(t), t);
  for (const t of ['hold on', 'ryanair 117 descend to five thousand', 'cleared to land runway two five']) assert.ok(!cutOff(t), t);
});
test('words swallowed as a reason, unused numbers and stray parts are shaky; plain calls and questions are not', () => {
  assert.ok(shaky('ryanair one one seven stop asking for six thousand', ast('RYR117 hold position asking for 6000'), ctx));
  assert.ok(shaky('emirates two eight zero wind it back to two two zero knots', ast('UAE280 wind check'), ctx));
  assert.ok(!shaky('emirates two eight zero descend to three thousand', ast('UAE280 Altitude 3000'), ctx));
  assert.ok(!shaky('emirates two eight zero what altitude are you through right now', ast('UAE280 Report altitude'), ctx));
});
test('a shaky reading is not sent when the model reads something else, and is when it reads the same', async () => {
  const said = 'ryanair one one seven stop asking for six thousand';
  const other = await understandVoice(said, ctx, 0, { complete: async () => ({ line: 'SAY AGAIN', confidence: 0.9, ms: 1, sayAgain: true }) } as never, state);
  assert.equal(other.ok, false);
  const alone = await understandVoice('emirates two eight zero descend to three thousand', ctx, 0, model('RYR117 Go around') as never, state);
  assert.ok(alone.ok && /Altitude 3000/.test(alone.line));
});
test('left and right that are no runway side or turn', () => {
  const miss = (said: string, l: string) => roundTrip(said, ast(l), ctx).sideMiss;
  assert.equal(miss('jetblue five six two left on november then zulu and keep short of juliett', 'JBU562 Taxi via N, Z, hold short twy J'), 0);
  assert.equal(miss('ryanair one one seven unable right now traffic', 'RYR117 Unable (traffic)'), 0);
  assert.equal(miss('ryanair one one seven hold short of runway two four left', 'RYR117 Hold short 24'), 1);
  assert.equal(miss('ryanair one one seven turn right heading one two zero', 'RYR117 Fly heading 120'), 1);
});
test('a question about an earlier call is never carried out on the model alone', () => {
  for (const t of ['ryanair 117 was that you asking about the wind', 'ryanair 117 who told you to descend to four thousand', 'ryanair 117 i never gave you six thousand did i', 'ryanair 117 reckon you can get down to five thousand']) assert.ok(kindVeto(t, ast('RYR117 Altitude 4000')), t);
  assert.equal(kindVeto('ryanair 117 come round to three four zero', ast('RYR117 Fly heading 340')), null);
});
