/*
  What exactly is wrong with a call that did not work, part by part: the wrong aircraft, a runway that is not here, a
  taxiway that does not meet the next one, a word that was not understood. Every fault names the words it is about, says
  what is wrong with them in plain English and, when there is a likely right answer, gives it (the call field offers it
  as a one-click fix). Used for typed and spoken calls (CommLog).
*/
import { PHONETIC_LETTER, TELEPHONY_TO_ICAO, VERB_STARTERS, parseCommand, resolveCallsign, tokenize, type ParseCtx } from './commands';
import { AIRLINE_TELEPHONY } from './phraseology';
import type { SimEngine } from './engine';
import type { AircraftState } from './types';

export interface Fault {
  /** The words as they were said or typed ('' = something is missing). */
  bad: string;
  /** Short name of the fault: "Wrong aircraft", "Wrong runway". */
  title: string;
  /** What is wrong, in a sentence. */
  text: string;
  /** What to put there instead, best first. */
  fixes: string[];
}

const dist = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]); for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
};
const list = (xs: string[], word = 'or'): string => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;
const DOING: Record<string, string> = { parked: 'at its stand', startup: 'starting up', pushback: 'pushing back', taxi: 'taxiing', hold_short: 'holding short', lineup: 'lined up', takeoff: 'taking off', climb: 'climbing out', cruise: 'en route', descent: 'inbound', approach: 'on approach', go_around: 'going around', landing: 'landing', rollout: 'rolling out' };
const doing = (a: AircraftState): string => a.phase === 'hold_short' && a.holdShortRunway ? `holding short of ${a.holdShortRunway}` : DOING[a.phase] ?? a.phase;
const name = (cs: string): string => { const m = cs.match(/^([A-Z]{3})(\w+)$/), t = m ? AIRLINE_TELEPHONY[m[1]] : undefined; return t ? `${cs} (${t} ${m![2]})` : cs; };
const SIDE: Record<string, string> = { LEFT: 'L', RIGHT: 'R', CENTER: 'C', CENTRE: 'C' };
const DIGIT: Record<string, string> = { ZERO: '0', ONE: '1', TWO: '2', THREE: '3', TREE: '3', FOUR: '4', FIVE: '5', FIFE: '5', SIX: '6', SEVEN: '7', EIGHT: '8', NINE: '9', NINER: '9' };
const isRwy = (t: string) => /^(0?[1-9]|[12]\d|3[0-6])[LRC]?$/.test(t);

/** The faults of a call that failed: `code` / `reason` are what the game answered. Empty when there is nothing to add. */
export function explainCall(text: string, ctx: ParseCtx, e: SimEngine | null, res?: { code?: string; reason?: string | null; callsign?: string | null }): Fault[] {
  const out: Fault[] = [], toks = tokenize(text); if (!toks.length) return out;
  const T = toks.map((t) => t.text), raw = (i: number, j = i) => toks.slice(i, j + 1).map((t) => t.raw).join(' ');
  const live = (e?.aircraft ?? []).filter((a) => a.phase !== 'departed' && a.phase !== 'arrived');
  const mine = (a: AircraftState) => !e || e.playerWorks(a);

  // ── the aircraft ──
  const cr = resolveCallsign(toks, 0, ctx); let at = cr.consumed, ac: AircraftState | null = cr.callsign ? live.find((a) => a.callsign === cr.callsign) ?? null : null;
  if (!cr.callsign) {
    if (cr.ambiguous.length) out.push({ bad: raw(0), title: 'Which aircraft?', text: `${raw(0)} fits ${list(cr.ambiguous, 'and')}. Say the airline too.`, fixes: cr.ambiguous.slice(0, 3) });
    else {
      // what was said as a callsign: an airline (name or code) and digits, or digits alone
      let airline = '', num = '', end = -1;
      for (const w of [3, 2, 1]) { const ic = TELEPHONY_TO_ICAO[T.slice(0, w).join('')]; if (ic) { airline = ic; end = w - 1; break; } }
      if (!airline) { const m = T[0].match(/^([A-Z]{2,3})(\d+[A-Z]{0,2})$/); if (m) { airline = m[1]; num = m[2]; end = 0; } else if (/^[A-Z]{2,3}$/.test(T[0]) && /^\d/.test(T[1] ?? '')) { airline = T[0]; end = 0; } }
      if (!num) { let k = end + 1; while (k < T.length && (/^\d{1,4}[A-Z]{0,2}$/.test(T[k]) || DIGIT[T[k]]) && num.length < 4) { num += DIGIT[T[k]] ?? T[k]; end = k; k++; } }
      if (airline || num) {
        const score = (a: AircraftState) => { const m = a.callsign.match(/^([A-Z]+)(\w+)$/); if (!m) return 99; const dn = num ? dist(num, m[2]) : 1; return dn + (airline && airline !== m[1] ? 1.6 : 0) + (mine(a) ? 0 : 0.4); };
        const near = live.map((a) => ({ a, s: score(a) })).filter((x) => x.s <= 2.7).sort((p, q) => p.s - q.s).slice(0, 3).map((x) => x.a);
        const said = raw(0, end), one = near[0], m = one?.callsign.match(/^([A-Z]+)(\w+)$/);
        const why = one && m ? (airline && airline !== m[1] ? (num === m[2] ? 'the number is right, the airline is not' : 'the airline and the number do not match') : num ? `the number is wrong (${num})` : 'the number is missing') : '';
        out.push({ bad: said, title: 'Wrong aircraft', text: one ? `There is no ${said} here: ${why}. Did you mean ${list(near.map((a) => `${a.callsign}, ${doing(a)}`))}?` : `There is no ${said} here. ${onFreq(live, mine)}`, fixes: near.map((a) => a.callsign) });
        at = end + 1;
      } else if (!VERB_STARTERS.has(T[0])) {
        const near = live.filter((a) => dist(T[0], a.callsign) <= 2).slice(0, 3);
        out.push({ bad: raw(0), title: near.length ? 'Wrong aircraft' : 'No aircraft named', text: near.length ? `There is no ${raw(0)} here. Did you mean ${list(near.map((a) => a.callsign))}?` : `“${raw(0)}” is not an aircraft here. Start with the callsign. ${onFreq(live, mine)}`, fixes: near.map((a) => a.callsign) });
        let k = 0; while (k < T.length && !VERB_STARTERS.has(T[k])) k++; at = k;
      } else if (!ctx.lastCallsign) out.push({ bad: '', title: 'No aircraft named', text: `The call has no callsign. ${onFreq(live, mine)}`, fixes: [] });
      else ac = live.find((a) => a.callsign === ctx.lastCallsign!.toUpperCase()) ?? null;
    }
  }
  // ── runways, taxiways, stands, headings named in it ──
  const rwys = (ctx.runways ?? []).map((r) => r.toUpperCase()), twys = new Set((ctx.taxiways ?? []).map((t) => t.toUpperCase())), stands = (ctx.stands ?? []).map((s) => s.toUpperCase());
  const via: Array<{ n: string; i: number; j: number }> = []; let mode: 'via' | '' = '';
  for (let i = at; i < T.length; i++) {
    const t = T[i];
    if (t === 'RUNWAY' || t === 'RWY' || /^\d{1,2}[LRC]$/.test(t) && !['SQUAWK', 'HEADING'].includes(T[i - 1] ?? '')) {
      mode = ''; let j = t === 'RUNWAY' || t === 'RWY' ? i + 1 : i, n = '';
      while (j < T.length && (DIGIT[T[j]] || /^\d{1,2}$/.test(T[j])) && n.length < 2) { n += DIGIT[T[j]] ?? T[j]; j++; }
      let last = j - 1; if (!n && /^\d{1,2}[LRC]$/.test(T[j] ?? '')) { n = T[j]; last = j; } else if (n && SIDE[T[j]]) { n += SIDE[T[j]]; last = j; } else if (n && /^[LRC]$/.test(T[j] ?? '')) { n += T[j]; last = j; }
      if (n) {
        const m = n.match(/^(\d+)([LRC]?)$/)!, full = m[1].padStart(2, '0') + m[2], said = raw(t === 'RUNWAY' || t === 'RWY' ? i + 1 : i, last);
        if (rwys.length && !rwys.includes(full)) {
          const same = rwys.filter((r) => r.startsWith(m[1].padStart(2, '0'))), plan = ac?.plan.runway && !same.includes(ac.plan.runway) ? [ac.plan.runway] : [];
          const fix = same.length ? same : [...plan, ...rwys.filter((r) => dist(r, full) <= 1)].slice(0, 3);
          out.push({ bad: said, title: 'Wrong runway', text: same.length && !m[2] ? `Runway ${m[1].padStart(2, '0')} has more than one side here: say ${list(same)}.` : `There is no runway ${full} here. ${fix.length ? `Did you mean ${list(fix)}?` : `The runways are ${list(rwys, 'and')}.`}`, fixes: fix });
        } else if (rwys.length && ac && ac.plan.runway && ac.plan.runway !== full && ['not_active', 'unable_runway', 'wrong_runway'].includes(res?.code ?? '')) out.push({ bad: said, title: 'Wrong runway', text: `${ac.callsign} is planned for ${ac.plan.runway}, not ${full}.`, fixes: [ac.plan.runway] });
        i = Math.max(i, last);
      } else if (t === 'RUNWAY' || t === 'RWY') out.push({ bad: raw(i), title: 'Runway missing', text: `“${raw(i)}” has no number after it. ${ac?.plan.runway ? `${ac.callsign} is planned for ${ac.plan.runway}.` : ''}`, fixes: ac?.plan.runway ? [`${raw(i)} ${ac.plan.runway}`] : [] });
      continue;
    }
    if (t === 'VIA') { mode = 'via'; continue; }
    if (['HOLD', 'CROSS', 'THEN', 'BEHIND', 'GIVE', 'FOLLOW', 'CONTACT', 'TO', 'WHEN', 'AFTER'].includes(t)) mode = '';
    if (['STAND', 'GATE', 'PARKING', 'BAY'].includes(t) && T[i + 1]) {
      mode = ''; let n = T[i + 1], j = i + 1; if (PHONETIC_LETTER[n]) n = PHONETIC_LETTER[n]; if (/^[A-Z]$/.test(n) && /^\d+$/.test(T[i + 2] ?? '')) { n += T[i + 2]; j = i + 2; }
      if (stands.length && !stands.includes(n)) {
        const near = [...(ac?.plan.gateRef ? [ac.plan.gateRef.toUpperCase()] : []), ...stands.filter((s) => dist(s, n) === 1)].filter((s, k, l) => l.indexOf(s) === k).slice(0, 3);
        out.push({ bad: raw(i + 1, j), title: 'Wrong stand', text: `There is no stand ${n} here. ${e?.otherName(n, true) ? `It is ${e.otherName(n, true)} with the ${e.naming} names on. ` : ''}${near.length ? `Did you mean ${list(near)}?` : ''}`.trim(), fixes: near });
      }
      i = j; continue;
    }
    if (t === 'HEADING' && /^\d{1,3}$/.test(T[i + 1] ?? '') && Number(T[i + 1]) > 360) out.push({ bad: raw(i + 1), title: 'Wrong heading', text: `${raw(i + 1)} is not a heading: they run from 001 to 360.`, fixes: [] });
    if (mode === 'via' && t !== ',' && t !== 'AND' && t !== 'TAXIWAY') {
      let n = PHONETIC_LETTER[t] ?? t, j = i; if (/^[A-Z]$/.test(n) && (DIGIT[T[i + 1]] || /^\d{1,2}$/.test(T[i + 1] ?? ''))) { n += DIGIT[T[i + 1]] ?? T[i + 1]; j = i + 1; }
      if (twys.has(n)) via.push({ n, i, j });
      else if (twys.has(PHONETIC_LETTER[t] ?? t)) { n = PHONETIC_LETTER[t] ?? t; j = i; via.push({ n, i, j }); }
      else if (twys.size && /^[A-Z]{1,3}\d{0,2}$/.test(n) && !VERB_STARTERS.has(n)) {
        const near = [...twys].filter((x) => x !== n && (x[0] === n[0] || dist(x, n) === 1)).sort((x, y) => dist(x, n) - dist(y, n)).slice(0, 3);
        out.push({ bad: raw(i, j), title: 'Wrong taxiway', text: `There is no taxiway ${n} here.${e?.otherName(n) ? ` It is called ${e.otherName(n)} with the ${e.naming} names on.` : ''}${near.length ? ` Did you mean ${list(near)}?` : ''}`, fixes: near });
      }
      i = j;
    }
  }
  // taxiways that exist but do not meet
  if (e && via.length && /does not connect|unable_route|no_route/i.test(`${res?.code} ${res?.reason}`)) {
    const next = (n: string): Set<string> => {
      const s = new Set<string>(), seen = new Set<string>(); let ring = e.air.taxiwayNodes.get(n) ?? [];
      for (let hop = 0; hop < 3; hop++) { const more: string[] = []; for (const id of ring) for (const d of e.air.nodes.get(id)?.edges ?? []) { if (d.taxiway) s.add(d.taxiway.toUpperCase()); else if (!seen.has(d.to) && d.type !== 'runway') { seen.add(d.to); more.push(d.to); } } ring = more; }
      s.delete(n); return s;
    };
    for (let k = 1; k < via.length; k++) {
      const a = via[k - 1], b = via[k]; if (a.n === b.n) continue; const s = next(a.n); if (s.has(b.n)) continue;
      const bridge = [...s].filter((x) => next(x).has(b.n)).slice(0, 3);
      out.push({ bad: raw(b.i, b.j), title: 'Taxiways do not meet', text: `${a.n} does not lead to ${b.n}.${bridge.length ? ` Go by ${list(bridge)} between them.` : ''}`, fixes: bridge.map((x) => `${x} ${b.n}`) });
      break;
    }
  }
  // ── the right aircraft, but not for this instruction ──
  const why = (res?.reason ?? '').trim();
  if (ac && !out.length && /^(On the ground|Airborne|Not landing|Not on approach|Not a departure|On stand|Already landed|Not at the .*holding point|Not lined up|Not moving|arrived|Not at the holding point yet|Below )/i.test(why)) {
    const said = T.slice(at).join(' ');
    const fits = (a: AircraftState): boolean => /LAND|APPROACH|GO AROUND|ILS/.test(said) ? ['approach', 'descent'].includes(a.phase) : /TAKE ?OFF|LINE UP|WAIT/.test(said) ? a.phase === 'hold_short' || a.phase === 'lineup' : /PUSH/.test(said) ? a.phase === 'parked' && a.plan.kind === 'departure' : /TAXI|CROSS|HOLD SHORT/.test(said) ? ['taxi', 'hold_short', 'rollout', 'startup'].includes(a.phase) : /HEADING|CLIMB|DESCEND|SPEED|DIRECT/.test(said) ? a.altitude > 30 : false;
    const near = live.filter((a) => a !== ac && fits(a) && mine(a)).sort((x, y) => dist(x.callsign, ac!.callsign) - dist(y.callsign, ac!.callsign)).slice(0, 3);
    out.push({ bad: raw(0, Math.max(0, at - 1)), title: 'Wrong aircraft for this call', text: `${ac.callsign} is ${doing(ac)}, so it cannot do that now (${why.replace(/\.$/, '').toLowerCase()}).${near.length ? ` Did you mean ${list(near.map((a) => `${a.callsign}, ${doing(a)}`))}?` : ''}`, fixes: near.map((a) => a.callsign) });
  }
  // ── understood, the right aircraft, but not now ──
  if (ac && !out.length && why && ['invalid_stage', 'unable_route', 'no_route', 'occupied', 'runway_occupied', 'wake', 'traffic'].includes(res?.code ?? '')) out.push({ bad: '', title: 'Not possible now', text: `${ac.callsign} is ${doing(ac)}: ${/^[A-Z][a-z]/.test(why) ? why[0].toLowerCase() + why.slice(1) : why}.`.replace(/\.\.$/, '.'), fixes: [] });
  // ── a word it could not read ──
  if (!out.length || out.every((f) => /aircraft/i.test(f.title))) {
    // (with the aircraft put right, is the rest readable?)
    const body = T.slice(at).join(' '), who = ac?.callsign ?? out[0]?.fixes[0] ?? live[0]?.callsign;
    const p = body && who ? parseCommand(`${who} ${body}`, { ...ctx, lastCallsign: who }) : null, er = p && !p.ok ? p.errors[0] : null;
    if (er) {
      const k = at + Math.max(0, er.at - 1), word = toks[k]?.raw ?? '', W = toks[k]?.text ?? '', expects = er.expected.filter((x) => !/^</.test(x));
      const near = W ? [...new Set([...expects, ...VERB_STARTERS])].filter((v) => v.length > 2 && dist(v, W) <= (W.length > 5 ? 2 : 1)).sort((x, y) => dist(x, W) - dist(y, W)).slice(0, 2) : [];
      const need: Record<string, string> = { '<runway>': 'a runway', '<taxiway>': 'a taxiway', '<stand>': 'a stand', '<fix>': 'a fix', '<aircraft>': 'an aircraft', '<callsign>': 'a callsign', '<number>': 'a number', '<verb>': 'an instruction', '<position>': 'a position' };
      const wants = er.expected.map((x) => need[x]).filter(Boolean), good = k > at ? raw(at, k - 1) : '';
      if (!word) out.push({ bad: '', title: 'Unfinished', text: `The call stops after “${good || raw(0, Math.max(0, at - 1))}”.${wants.length ? ` It needs ${list([...new Set(wants)])}.` : expects.length ? ` It could go on with ${list(expects.slice(0, 3).map((x) => x.toLowerCase()))}.` : ''}`, fixes: [] });
      else out.push({ bad: word, title: 'Not understood', text: `${good ? `Understood “${good}”, then not ` : 'Could not read '}“${word}”.${near.length ? ` Did you mean ${list(near.map((x) => x.toLowerCase()))}?` : wants.length ? ` Expected ${list([...new Set(wants)])} there.` : expects.length ? ` Expected something like ${list(expects.slice(0, 3).map((x) => x.toLowerCase()))}.` : ''}`, fixes: near.map((x) => x.toLowerCase()) });
    }
  }
  return out.slice(0, 4);
}
function onFreq(live: AircraftState[], mine: (a: AircraftState) => boolean): string {
  const xs = live.filter((a) => mine(a) && a.phase !== 'parked').concat(live.filter((a) => mine(a) && a.phase === 'parked')).slice(0, 4);
  return xs.length ? `With you now: ${list(xs.map((a) => name(a.callsign)), 'and')}.` : '';
}
/** The call with a fault's words put right. */
export function applyFix(text: string, f: Fault, fix: string): string {
  if (!f.bad) return `${text.trim()} ${fix}`;
  const i = text.toLowerCase().indexOf(f.bad.toLowerCase()); return i < 0 ? `${fix} ${text}`.trim() : `${text.slice(0, i)}${fix}${text.slice(i + f.bad.length)}`;
}
