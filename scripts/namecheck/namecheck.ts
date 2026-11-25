// Are the simple names heard as well as the real ones? Calls made from the game's own routes, stands and exits, said several
// ways (as a controller says them, loosely, and as recognisers write them), through the shipped chain: understandHeard() =
// clean-up, rules, the command model, the gate. The answer is compared with the same call typed.
//   scripts/namecheck.sh KSFO [calls=150]
import * as fs from 'node:fs';
import { makeEngine } from '../../tests/engine/helpers';
import { fromEngine } from '../../src/lib/sim/dispatch';
import { parseCommand } from '../../src/lib/sim/commands';
import { understandHeard } from '../../src/lib/voice/asr-nbest';
import { voiceContext, spokenName } from '../../src/lib/voice/context';
import { S1Model } from '../../src/lib/voice/s1';
import { S1_MODEL_URL } from '../../src/lib/voice/l1';
import { NATO } from './words';
import { execSync } from 'node:child_process';

// AUDIO=1: the calls spoken (espeak-ng) and heard by the site's own recogniser first (STT=http://localhost:3007)
async function heard(said: string, names: string[]): Promise<string[]> {
  const v = ['en-us', 'en-gb', 'en-us+f3', 'en-gb+m3'][said.length % 4]; const pcm = execSync(`espeak-ng -v ${v} -s 150 --stdout ${JSON.stringify(said)} | ffmpeg -loglevel error -i - -ar 16000 -ac 1 -f s16le -`, { maxBuffer: 1 << 26 });
  for (let k = 0; k < 20; k++) { const r: any = await fetch(`${process.env.STT ?? 'http://localhost:3007'}/api/voice/stt`, { method: 'POST', body: pcm, headers: { 'content-type': 'audio/l16', 'x-stt-names': encodeURIComponent(JSON.stringify(names)), 'x-stt-alts': '1' } }).catch(() => null); const j: any = await r?.json().catch(() => ({})); if (r?.ok) return [...new Set([j.text, ...(j.alternatives ?? [])].filter(Boolean))] as string[]; await new Promise(z => setTimeout(z, 1500)); }
  throw new Error('the recogniser does not answer');
}

const ICAO = process.argv[2] ?? 'KSFO', N = Number(process.argv[3] ?? 150);
const dir = 'public' + S1_MODEL_URL, bin = fs.readFileSync(`${dir}/model.bin`);
const m = new S1Model(JSON.parse(fs.readFileSync(`${dir}/model.json`, 'utf8')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
let pre = ''; const l1 = { complete: async (said: string, cs: string[], ctx?: string) => { if (ctx !== pre) { m.prefill(ctx!); pre = ctx!; } return { ...m.complete(said, cs), model: S1_MODEL_URL }; } };
let r0 = 7; const rnd = () => (r0 = (r0 * 1103515245 + 12345) % 2147483648) / 2147483648, pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length) % a.length];
const D = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const digits = (s: string, oh = false) => [...s].map(c => (/\d/.test(c) ? (oh && c === '0' ? 'oh' : D[Number(c)]) : /[A-Z]/i.test(c) ? NATO[c.toUpperCase()] : '')).filter(Boolean).join(' ');
const styles: ((s: string) => string)[] = [s => digits(s), s => s, s => s.split('').map(c => (/[A-Z]/.test(c) ? NATO[c] : c)).join('').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliett|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|xray|yankee|zulu)/g, '$1 $2')];
const rwySaid = (r: string) => digits(r.replace(/[LRC]/, '')) + (({ L: ' left', R: ' right', C: ' center' } as Record<string, string>)[r.slice(-1)] ?? '');
(async () => {
  for (const naming of (process.env.NAMING ?? 'real,simple').split(',')) {
    r0 = 7; const e = makeEngine(ICAO, { seed: 3 }) as any; if (naming === 'simple') e.setNaming('simple');
    const gates = e.gates.filter((g: any) => !g.closed), cs = ['UAL421', 'DAL88', 'BAW285', 'SWA1176', 'JAL1']; const acs: any[] = [];
    for (const c of cs) { const g = pick(gates.filter((q: any) => q.occupiedBy == null)) as any; const a = e.spawnAt({ callsign: c, type: 'A320', kind: 'departure', phase: 'parked', gate: g.ref, onFrequency: 'ground' }); if (a) acs.push(a); }
    const ends: string[] = [...new Set(e.runways.map((r: any) => r.name as string))] as string[];
    const arr = e.spawnAt({ callsign: 'AAL77', type: 'A320', kind: 'arrival', phase: 'taxi', taxiwayNode: [...e.air.taxiwayNodes.values()].sort((p: any, q: any) => q.length - p.length)[0][0], onFrequency: 'ground' }); if (arr) acs.push(arr);
    const ctx = fromEngine(e, { position: 'ground' } as never), st = voiceContext(e, 'ground');
    const tally: Record<string, [number, number, number]> = {}, wrong: string[] = []; let skipped = 0;
    for (let i = 0; i < N; i++) {
      const a = pick(acs), tel = spokenName(a), kind = pick(['rwy', 'rwy', 'stand', 'stand', 'exit', 'hold', 'loose']), dep = a.plan.kind === 'departure';
      let typed = '', said = ''; const tw = (names: string[]) => { const s = process.env.AUDIO ? styles[0] : pick(styles); return names.map(s); };
      const stand = (ref: string) => process.env.AUDIO ? digits(ref) : pick([digits(ref), digits(ref, true), ref]);
      const stay = e.air.taxiwayNames, r = pick(ends), g = pick(gates) as any;
      const p = kind === 'stand' || (kind === 'loose' && !dep) ? e.taxiPlan(a, { kind: 'stand', ref: g.ref }, []) : e.taxiPlan(a, { kind: 'runway', runway: r, intersection: null }, []);
      const names: string[] = 'code' in p ? [] : p.names.slice(0, 5); if ((kind === 'rwy' || kind === 'stand' || kind === 'loose') && !names.length) { skipped++; continue; }
      if (kind === 'rwy') { typed = `${a.callsign} taxi ${r} via ${names.join(' ')}`; said = `${tel} taxi to runway ${pick([rwySaid(r), r.replace(/([LRC])$/, (x: string) => ({ L: ' left', R: ' right', C: ' center' } as any)[x])])} via ${tw(names).join(pick([', ', ' ']))}`; }
      else if (kind === 'stand') { typed = `${a.callsign} taxi stand ${g.ref} via ${names.join(' ')}`; said = `${tel} taxi to ${pick(['stand', 'gate'])} ${stand(g.ref)} via ${tw(names).join(pick([', ', ' ']))}`; }
      else if (kind === 'loose') { const t = tw(names); typed = dep ? `${a.callsign} taxi ${r} via ${names.join(' ')}` : `${a.callsign} taxi stand ${g.ref} via ${names.join(' ')}`; said = dep ? `${tel} okay go ahead and taxi via ${t.join(' then ')} for runway ${rwySaid(r)}` : `${tel} okay go ahead and taxi via ${t.join(' then ')} to gate ${stand(g.ref)}`; }
      else if (kind === 'exit') { const x = pick(stay) as string; typed = `${a.callsign} exit at ${x}`; said = `${tel} ${pick(['vacate via', 'exit at', 'exit via'])} ${tw([x])[0]}`; }
      else { const x = pick(stay) as string; typed = `${a.callsign} hold short of taxiway ${x}`; said = `${tel} hold short of ${pick(['taxiway ', ''])}${tw([x])[0]}`; }
      const gold = parseCommand(typed, ctx); if (!gold.ok) { skipped++; if (process.env.V) console.log('  gold?', typed, gold.errors[0]?.message); continue; }
      const alts = process.env.AUDIO ? await heard(said, acs.map(spokenName)) : [said];
      const u = await understandHeard(alts, ctx, e.magVar, l1 as never, st);
      const got = u.ok ? parseCommand(u.line, ctx) : null, sent = u.ok && !u.sayAgain && (u.source === 'L0' || u.verify?.gate !== 'check');
      const same = !!got?.ok && JSON.stringify(got.ast) === JSON.stringify(gold.ast); const t = tally[kind] ??= [0, 0, 0];
      if (same && sent) t[0]++; else if (got?.ok && !same && sent) { t[1]++; wrong.push(`${said}${process.env.AUDIO ? ` [heard: ${alts[0]}]` : ''}   ->   ${u.line}   (meant ${typed})`); } else { t[2]++; if (process.env.V) console.log('  asked:', said, '->', u.line, u.error); }
    }
    const s = Object.values(tally).reduce((q, t) => [q[0] + t[0], q[1] + t[1], q[2] + t[2]], [0, 0, 0]), n = s[0] + s[1] + s[2];
    console.log(`${ICAO} ${naming.padEnd(6)} ${n} calls: right ${(s[0] / n * 100).toFixed(1)}%  wrong ${s[1]} (${(s[1] / n * 100).toFixed(1)}%)  asked again ${s[2]}  | ${Object.entries(tally).map(([k, t]) => `${k} ${t.join('/')}`).join('  ')}  skipped ${skipped}`);
    for (const w of wrong.slice(0, Number(process.env.SHOW ?? 4))) console.log('     ', w);
  }
})();
