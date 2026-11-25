// How people really talk on a radio, worked out after a sentence failed to parse as it stands: a correction in the middle
// of it ("turn left, correction, right heading 280"), a question ("how's your fuel?"), two aircraft in one breath, and an
// answer with something added ("approved, but hold short of Kilo"). Every result is parsed again like typed text.
import type { ParseCtx, ParseResult, Token } from './commands';

type Parse = (text: string, ctx: ParseCtx) => ParseResult;

// ── 1. a correction inside the sentence ──────────────────────────────────────
const MARKERS = ['CORRECTION', 'SORRY', 'I MEAN', 'I MEANT', 'NO WAIT', 'WAIT NO', 'MAKE THAT', 'SCRATCH THAT', 'RATHER', 'ER NO'];
const typeOf = (t: string): string => /^\d{1,2}[LRC]$/.test(t) ? 'runway' : /^(?:FL)?\d+$/.test(t) ? 'number' : t === 'LEFT' || t === 'RIGHT' ? 'side' : ['CLIMB', 'DESCEND'].includes(t) ? 'vert' : /^[A-Z]{1,2}\d{0,2}$/.test(t) ? 'taxiway' : `word:${t}`;
/** The sentence with the corrected part put in, first reading that parses; null when there is no correction in it. */
export function correctedSpeech(cs: string, rest: string[], ctx: ParseCtx, parse: Parse): ParseResult | null {
  for (let i = 1; i < rest.length; i++) {
    const m = MARKERS.find(x => x.split(' ').every((w, k) => rest[i + k] === w)); if (!m) continue;
    const before = rest.slice(0, i), after = rest.slice(i + m.split(' ').length); if (!after.length) return null;
    while (after[0] === 'TO' || after[0] === 'THE') after.shift();
    const tries: string[][] = [];
    const same = before.lastIndexOf(after[0]); if (same >= 0) tries.push([...before.slice(0, same), ...after]);
    for (let k = before.length - 1; k >= 0; k--) if (typeOf(before[k]) === typeOf(after[0])) { tries.push([...before.slice(0, k), ...after]); break; }
    if (/^[A-Z]{3,}$/.test(after[0]) && typeOf(after[0]) !== 'side') tries.push(after);        // a whole new instruction
    for (const t of tries) { const r = parse(`${cs} ${t.join(' ')}`, ctx); if (r.ok) return r; }
    return null;
  }
  return null;
}

// ── 2. a question ────────────────────────────────────────────────────────────
const Q: Array<[RegExp, string]> = [
  [/\b(?:how much fuel|(?:hows|how is|whats|what is) your fuel|how are you (?:doing |looking )?(?:for|on) fuel|fuel (?:state|status)|how long can you (?:hold|stay))/, 'SAY FUEL'],
  [/\b(?:hows|how is|whats|what is) (?:the |your )?ride|\b(?:any|is there) (?:turbulence|chop|bumps)|is it bumpy|\bsmooth up there/, 'SAY RIDE'],
  [/\bhow many (?:people|souls|passengers|pax)\b|\bhow many on board/, 'SAY SOULS'],
  [/\bwhere are you(?: now| at| right now)?$|\b(?:whats|what is) your (?:position|location)/, 'SAY POSITION'],
  [/\bhow high are you|\b(?:whats|what is) your (?:altitude|level|height)|\bwhat (?:altitude|level) are you/, 'SAY ALTITUDE'],
  [/\bhow fast are you|\b(?:whats|what is) your (?:air)?speed|\bwhat speed are you/, 'SAY SPEED'],
  [/\b(?:whats|what is) your heading|\bwhat heading are you|\bwhich way are you (?:going|heading)/, 'SAY HEADING'],
  [/\bare you ready|\bready to (?:go|depart)\b/, 'SAY READY'],
  [/\bare you (?:established|on the localizer|on the loc)/, 'SAY ESTABLISHED'],
  [/\bare you (?:clear of|off) the runway|\bhave you vacated/, 'SAY VACATED'],
  [/\b(?:whats|what is|what was) the (?:reason|problem)|\bwhy did you go around|\bwhats wrong/, 'SAY REASON'],
  [/\bwhat are your intentions|\bwhat do you (?:want|need|intend)/, 'SAY INTENTIONS'],
];
/** A question to the crew as a report request. Never one that also gives a value (that is an instruction put politely). */
export function askedOfCrew(cs: string, rest: string[], ctx: ParseCtx, parse: Parse): ParseResult | null {
  const said = rest.join(' ').toLowerCase(); if (rest.some(t => /\d/.test(t)) || rest.length > 12) return null;
  const hit = Q.find(([re]) => re.test(said)); if (!hit) return null;
  const r = parse(`${cs} ${hit[1]}`, ctx); return r.ok ? r : null;
}

// ── 3. two aircraft in one breath ────────────────────────────────────────────
/** "United 214 follow ..., Delta 88 cross 28 left": the calls, when every one of them parses by itself. */
export function twoCalls(text: string, ctx: ParseCtx, tokens: Token[], resolve: (t: Token[], i: number, c: ParseCtx) => { callsign: string | null; consumed: number }, parse: Parse): string[] | null {
  const first = resolve(tokens, 0, ctx); if (!first.callsign) return null;
  const starts: Array<{ i: number; cs: string }> = [{ i: 0, cs: first.callsign }];
  for (let i = first.consumed + 1; i < tokens.length - 1; i++) {
    if (!/^[A-Z]{2,}/.test(tokens[i].text)) continue;
    const r = resolve(tokens, i, ctx);
    if (r.callsign && r.consumed >= (/\d/.test(tokens[i].text) ? 1 : 2) && !starts.some(s => s.cs === r.callsign)) { starts.push({ i, cs: r.callsign }); i += r.consumed - 1; }
  }
  if (starts.length < 2 || starts.length > 3) return null;
  const calls = starts.map((s, k) => {
    const body = tokens.slice(s.i + resolve(tokens, s.i, ctx).consumed, k + 1 < starts.length ? starts[k + 1].i : tokens.length).map(t => t.text);
    while (body.length && ['AND', 'THEN', 'BREAK'].includes(body[body.length - 1])) body.pop();
    return `${s.cs} ${body.join(' ')}`;
  });
  return calls.every(c => { const r = parse(c, { ...ctx, lastCallsign: null }); return r.ok && !!r.ast; }) ? calls : null;
}

// ── 4. an answer with something added ────────────────────────────────────────
const YES = /^(?:approved|affirm(?:ative)?|yes|yeah|yep|ok|okay|sure)(?: as requested)?(?:[ ,]+(?:but|and|then|just))*[ ,]+(.+)$/i;
const NO = /^(?:negative|unable|no|nope)(?:[ ,]+(?:but|then|instead|just|rather))*[ ,]+(.+)$/i;
export interface AnswerWith { yes: boolean; rest: string; cs: string }
/** Only to a crew that has asked something (ctx.asked). */
export function answerWith(cs: string | null, restText: string, ctx: ParseCtx, parse: Parse): AnswerWith | null {
  if (!cs || !ctx.asked?.includes(cs)) return null;
  const y = YES.exec(restText), n = y ? null : NO.exec(restText); const m = y ?? n; if (!m) return null;
  let rest = m[1].replace(/^(?:make (?:it|that)|give me)\s+/i, '');
  const word = ctx.askedKind?.[cs]; if (/^\d+$/.test(rest) && word) rest = `${word} ${rest}`;
  const r = parse(`${cs} ${rest}`, ctx); return r.ok && r.ast ? { yes: !!y, rest, cs } : null;
}
