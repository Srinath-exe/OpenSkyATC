// Wire simulator: the real game logic (engine, pilots, radio, AI controllers, flight-card player) with nothing drawn, one
// seed after another, every aircraft checked as an outline.   See scripts/wiresim.sh.
import '../../tests/store/stubs';
const G = globalThis as any; const bus = new EventTarget(); G.addEventListener = bus.addEventListener.bind(bus); G.removeEventListener = bus.removeEventListener.bind(bus); G.dispatchEvent = bus.dispatchEvent.bind(bus);
import * as fs from 'node:fs';
import { sim } from '../../src/components/atc/simStore';
import { nextCall, isMine } from '../../src/game/Board/nextCall';
import { dist, angleDelta, arcLengths, XY } from '../../src/lib/sim/projection';
import { shape, shapeDist, wiggles, makeWalls, makeLines, Poly } from '../gatelab/geom';

const ICAO = process.env.ICAO ?? 'KSFO', MIN = Number(process.env.MIN ?? 40), WATCH = process.env.WATCH?.split(',');
const APP = !!process.env.APP;                                   // the player works Approach from the flight cards, the AI the tower
const log = console.log; if (!process.env.V) { console.log = () => undefined; console.warn = () => undefined; }
export interface Finding { kind: string; seed: number; t: number; cs: string; at: string; x: number; y: number; note: string }

async function run(seed: number): Promise<{ seed: number; setup: string; findings: Finding[]; why: Record<string, number>; stats: Record<string, number>; ms: number; simS: number }> {
  const t0 = performance.now();
  // what this seed varies: who controls, which way the airport works, how busy it is, whether pilots talk back
  const who = process.env.WHO ?? (['card', 'ai'] as const)[seed % 2], flow = Number(process.env.FLOW ?? Math.floor(seed / 2) % 3 === 2 ? 1 : 0), busy = (process.env.BUSY ?? ['normal', 'high', 'low'][Math.floor(seed / 2) % 3]) as 'low' | 'normal' | 'high';
  const talk = process.env.TALK ? process.env.TALK === '1' : true;
  await sim.load({ icao: ICAO, spawn: 'default', position: 'tower', seed, ends: [], difficulty: busy } as never);
  sim.stop(); let e = sim.engine! as any;
  // the ends in use: the same way for all runways (flow 0 = the airport's main direction, 1 = the opposite)
  const ends = (() => {
    const main: Record<string, string[]> = { KSFO: ['28L', '28R', '01L', '01R'] };
    const names: string[] = e.runways.map((r: any) => r.name); const rec = (n: string) => e.runwayState(n).reciprocal as string;
    let m = main[ICAO];
    if (!m) { const long = e.air.runways.slice().sort((a: any, b: any) => b.lengthM - a.lengthM)[0] ?? e.air.runways[0]; const h0 = long.ends[0].trueHdg; m = e.air.runways.map((r: any) => (Math.cos((r.ends[0].trueHdg - h0 - 20) * Math.PI / 180) >= 0 ? r.ends[0].name : r.ends[1].name)); }
    return (flow ? m!.map(rec) : m!).filter(n => names.includes(n));
  })();
  await sim.load({ icao: ICAO, spawn: 'default', position: 'tower', seed, ends, difficulty: busy } as never);
  sim.stop(); e = sim.engine! as any; (sim as any).autoSpawn = true;
  sim.updateSettings({ autoGround: APP || who === 'ai', autoTower: APP || who === 'ai', autoApproach: !APP, emergencyRate: 'off' } as never, { silent: true });
  e.settings.autoGround = e.settings.autoTower = who === 'ai'; e.settings.autoApproach = !APP; e.settings.emergencyRate = 'off'; if (APP) { e.settings.autoGround = e.settings.autoTower = true; } if (!talk) e.settings.personas = false;

  const NAMING = process.env.NAMING ?? '';                      // simple | toggle (simple names, switched to and fro every 45 s) | swap / swaptoggle (one name in, one name out: must come out identical)
  if (/swap/.test(NAMING)) e.nameLoose = false; if (NAMING) e.setNaming('simple');
  const seenAir = new Map<number, number>(), airT = new Map<number, number>(); const why: Record<string, number> = {}; let digest = 1; const F: Finding[] = [], once = new Set<string>(); let t = 0;
  const add = (kind: string, a: any, note: string, key = `${kind}|${a?.id}`, p: XY = a.pos) => { if (once.has(key)) return; once.add(key); const q = e.proj.toLngLat(p.x, p.y); F.push({ kind, seed, t: Math.round(t), cs: a?.callsign ?? '', at: `${q.lat.toFixed(5)},${q.lng.toFixed(5)}`, x: Math.round(p.x), y: Math.round(p.y), note }); };
  const xy = (p: any) => e.proj.toXY(p.lat, p.lng);
  const walls = makeWalls(e.air.buildings.filter((b: any) => b.kind === 'terminal' || b.kind === 'hangar').map((b: any) => b.polygon.map(xy))), lines = makeLines(e);
  const still = new Map<string, { at: number; S: Poly[] }>();
  const outline = (id: string, type: string, p: XY, h: number): Poly[] => { const k = `${p.x.toFixed(1)},${p.y.toFixed(1)},${h.toFixed(0)}`, c = still.get(id); if (c && (c as any).k === k) return c.S; const S = shape(type, p, h); still.set(id, { at: t, S, k } as any); return S; };
  const prev = new Map<number, { x: number; y: number; h: number; v: number; phase: string }>(), held = new Map<number, number>(), offT = new Map<number, number>(), track = new Map<number, XY[]>(), started = new Map<number, XY>(), sent = new Map<string, { t: number; no: number }>();
  let cmds = 0, refused = 0, moved = 0, maxGround = 0; const ids = new Set<number>(); let landed = 0, departed = 0; const lastPhase = new Map<number, string>();
  const endTrack = (a: any) => { const tr = track.get(a.id); track.delete(a.id); if (!tr || tr.length < 20) return; const { cum } = arcLengths(tr); for (const w of wiggles(tr, cum)) add('wiggle', a, `${w.off.toFixed(1)} m out over ${w.len} m, from ${(w as any).from.x.toFixed(0)},${(w as any).from.y.toFixed(0)} h${(w as any).h0.toFixed(0)} to ${(w as any).to.x.toFixed(0)},${(w as any).to.y.toFixed(0)} h${(w as any).h1.toFixed(0)} off at ${w.at.x.toFixed(0)},${w.at.y.toFixed(0)}`, `wiggle|${a.id}|${Math.round(w.at.x / 40)}`, w.at); };
  const GROUND = new Set(['taxi', 'pushback', 'hold_short', 'lineup', 'rollout', 'startup']);
  try {
    for (; t < MIN * 60; t += 0.5) {
      if (process.env.DIGEST && t % 5 === 0) for (const a of e.aircraft) digest = (digest * 31 + Math.round(a.pos.x * 100) * 7 + Math.round(a.pos.y * 100) * 13 + Math.round(a.heading * 10)) % 4294967291;
      if (/toggle/.test(NAMING) && t > 0 && t % 45 === 0) e.setNaming(e.naming === 'simple' ? 'real' : 'simple');
      for (const ev of (sim.step(0.5) as any[]) ?? []) { if (/DIVERSION|SEPARATION LOSS/i.test(ev.message ?? '')) { const a = e.find(ev.callsign) ?? (sim as any).lastGone; F.push({ kind: /DIVERSION/i.test(ev.message) ? 'diversion' : 'sepLoss', seed, t: Math.round(t), cs: ev.callsign ?? '', at: '', x: 0, y: 0, note: String(ev.message).slice(0, 90) + (a ? ` | ${a.plan.kind} ${a.phase} ${Math.round(a.altitude)} ft h${Math.round(a.heading)} ${a.onFrequency}` : '') }); }
        if (/INCURSION|GROUND CONFLICT|COLLISION/i.test(ev.message ?? '')) { const a = e.find(ev.callsign); if (a) add(/INCURSION/i.test(ev.message) ? 'incursion' : 'groundAlert', a, String(ev.message).slice(0, 110), `alert|${ev.message.slice(0, 50)}`); } }
      const ac = e.aircraft as any[], ground = ac.filter(a => a.altitude < 1 && GROUND.has(a.phase)); maxGround = Math.max(maxGround, ground.length);
      for (const a of ac) if (a.plan.kind === 'arrival' && a.altitude > 50) { const f = seenAir.get(a.id) ?? t; seenAir.set(a.id, f); if (t - f === 1800) add('longAir', a, `30 min in the air (${a.phase}, ${Math.round(a.altitude)} ft, ${e.sc(a).aiMode ?? ''})`, `longAir|${a.id}`); } else if (seenAir.has(a.id) && !airT.has(a.id)) airT.set(a.id, t - seenAir.get(a.id)!);
      for (const a of ac) { ids.add(a.id); const lp = lastPhase.get(a.id); if (lp !== a.phase) { if (a.phase === 'climb' && lp === 'takeoff') departed++; if (a.phase === 'rollout' && lp === 'landing') landed++; lastPhase.set(a.id, a.phase); } }
      for (const a of ground) {
        const p = prev.get(a.id), d = p ? Math.hypot(a.pos.x - p.x, a.pos.y - p.y) : 0; moved += d;
        if (p && p.phase === a.phase && a.phase !== 'rollout') {
          const turn = Math.abs(angleDelta(p.h, a.heading));
          if (d > Math.max(p.v, a.speed) * 0.5144 * 0.5 + 4) add('jump', a, `${d.toFixed(0)} m in half a second (${a.phase})`);
          if (!e.sc(a).tow && turn > 2 && d < 0.15) add('pivot', a, `turned ${turn.toFixed(0)} deg on the spot (${a.phase})`);
        }
        prev.set(a.id, { x: a.pos.x, y: a.pos.y, h: a.heading, v: a.speed, phase: a.phase });
        const taxi = a.phase === 'taxi' && !e.sc(a).tow;
        if (taxi) { if (!track.has(a.id)) { track.set(a.id, []); started.set(a.id, { ...a.pos }); } const tr = track.get(a.id)!, l = tr[tr.length - 1]; if (!l || dist(l, a.pos) >= 2) tr.push({ ...a.pos }); } else if (track.has(a.id) && a.phase !== 'hold_short') endTrack(a);
        // off the painted lines (not the first metres of a swing-out push)
        if (taxi && a.speed > 0.5 && dist(started.get(a.id)!, a.pos) > 70 && lines(a.pos) > 14) { const n = (offT.get(a.id) ?? 0) + 0.5; offT.set(a.id, n); if (n >= 2) add('offLine', a, `${lines(a.pos).toFixed(0)} m off, to ${a.plan.kind === 'departure' ? a.plan.runway : a.plan.gateRef}`, `offLine|${a.id}|${Math.round(a.pos.x / 60)}`); } else offT.delete(a.id);
        // standing still with somewhere to go
        const wants = (a.phase === 'taxi' && a.path && a.path.total - a.distAlong > 3) || (a.phase === 'pushback' && a.pushback.stage === 'pushing') || (a.phase === 'rollout' && e.sc(a).vacated) || (a.phase === 'hold_short' && !a.holdShortRunway);
        if (wants && a.speed < 0.3 && !e.sc(a).tow) { const n = (held.get(a.id) ?? 0) + 0.5; held.set(a.id, n); if (n === 240) {
          const b = e.byId(e.sc(a).blockedById), bb = b ? e.byId(e.sc(b).blockedById) : null;
          // the whole row of who waits for whom, to the one at its head
          const say = (x: any) => `${x.callsign} ${x.phase}${x.phase === 'pushback' ? '/' + x.pushback.stage : ''} to ${x.plan.kind === 'departure' ? x.assignedRunway ?? x.plan.runway : x.plan.gateRef ?? x.reservedStand} (${e.holdReasonOf(x.id) ?? (x.phase === 'hold_short' ? `at ${x.holdShortRunway ?? x.holdShortTaxiway}` : 'free')}${e.sc(x).stoppedSince != null ? `, ${Math.round(e.time - e.sc(x).stoppedSince)} s` : ''})`;
          const row: any[] = [a]; for (let x = b; x && row.length < 7 && !row.includes(x); x = e.byId(e.sc(x).blockedById)) row.push(x);
          const head = row[row.length - 1], ring = !!b && row.includes(e.byId(e.sc(head).blockedById));
          add(bb === a ? 'standoff' : ring ? 'standoff' : head !== a && ((head.phase === 'hold_short' && head.holdShortRunway) || head.phase === 'takeoff' || head.phase === 'lineup') && row.every((x: any) => x.plan.kind === 'departure' && Math.abs(angleDelta(x.heading, row[Math.max(0, row.indexOf(x) - 1)].heading)) < 100) ? 'queue' : 'stuck', a, row.map(say).join(' <- '));
        } } else held.delete(a.id);
        if (a.phase === 'hold_short' && a.holdShortRunway) { const n = (held.get(-a.id) ?? 0) + 0.5; held.set(-a.id, n); if (n === 900) add('longHold', a, `15 min at ${a.holdShortRunway}`); } else held.delete(-a.id);
        if (a.phase === 'startup' && a.pushback?.stage === 'complete') { const n = (held.get(-1e6 - a.id) ?? 0) + 0.5; held.set(-1e6 - a.id, n); if (n === 600) add('noTaxiCall', a, 'pushed back, 10 min without a taxi clearance'); }
      }
      // outlines: moving aircraft against everything else and the walls, every second
      if (t % 1 === 0) {
        const mov = ground.filter(a => a.speed > 0.2);
        for (const a of mov) {
          const S = outline(`a${a.id}`, a.perf.icaoCode, a.pos, a.heading);
          for (const b of ac) { if (b === a || b.altitude > 1 || dist(a.pos, b.pos) > 100) continue; const g = shapeDist(S, outline(`a${b.id}`, b.perf.icaoCode, b.pos, b.heading)); if (g === 0) add('collision', a, `${a.perf.icaoCode} ${a.phase} touches ${b.callsign} ${b.perf.icaoCode} ${b.phase} (stands ${a.plan.gateRef ?? "-"}, ${b.reservedStand ?? b.plan.gateRef ?? "-"})`, `col|${Math.min(a.id, b.id)}|${Math.max(a.id, b.id)}`); else if (g < 1.5) add('close', a, `${g.toFixed(1)} m from ${b.callsign} ${b.phase}`, `close|${Math.min(a.id, b.id)}|${Math.max(a.id, b.id)}`); }
          for (const b of e.parked) { if (dist(a.pos, b.pos) > 100) continue; const g = shapeDist(S, outline(`p${b.id}`, b.type, b.pos, b.heading)); if (g === 0) add('collision', a, `${a.perf.icaoCode} ${a.phase} ${a.reservedStand ?? a.plan.gateRef ?? ''} touches ${b.type} parked at ${b.standRef}`, `col|${a.id}|p${b.id}`); }
          if (walls(S) < 0.5) add('wall', a, `${a.perf.icaoCode} ${a.phase} ${a.plan.gateRef ?? ''} touches a building`, `wall|${a.id}|${a.phase}`);
        }
      }
      // the player, doing what the flight cards say
      if ((who === 'card' || APP) && t % 2 === 0) for (const a of [...ac]) {
        if (!isMine(a, APP ? 'approach' : 'tower')) continue; const n = nextCall(e, a) as any; if (!n.cmd) continue;
        const k = `${a.id}|${e.naming === 'simple' ? n.cmd.split(' ').map((w: string) => e.names.twyToReal.get(w) ?? e.names.standToReal.get(w) ?? w).join(' ') : n.cmd}`, s = sent.get(k); if (s && s.t > t - 30) continue;
        cmds++; const r: any = sim.command(n.cmd); const no = r?.ok ? 0 : (s?.no ?? 0) + 1; sent.set(k, { t, no }); if (!r?.ok) { refused++; const k2 = `!${n.cmd.split(' ')[1]}: ${r?.code ?? ''} ${String(r?.reason ?? r?.readback ?? '').replace(/[A-Z]{2,3}\d+[A-Z]*|\d+[LRC]?/g, '#').replace(/(Alpha|Bravo|Charlie|Delta|Echo|Foxtrot|Golf|Hotel|India|Juliett|Kilo|Lima|Mike|November|Oscar|Papa|Quebec|Romeo|Sierra|Tango|Uniform|Victor|Whiskey|Yankee|Zulu)( (one|two|three|four|five|six|seven|eight|niner?|zero)+)*/g, '@').slice(0, 70)}`; why[k2] = (why[k2] ?? 0) + 1; }
        if (no === 4) add('badCard', a, `"${n.cmd.replace(a.callsign, '').trim()}" refused 4 times: ${r?.code ?? ''} ${String(r?.reason ?? r?.readback ?? '').slice(0, 80)}`, `badCard|${a.id}|${n.cmd}`);
        if (WATCH && WATCH.includes(a.callsign)) log(`  ${Math.round(t)} CARD ${n.cmd} -> ${r?.ok} ${r?.code ?? ''} ${r?.reason ?? ''}`);
      }
      if (process.env.TOWDBG && t === Number(process.env.TOWDBG)) for (const a of ac) if (WATCH?.includes(a.callsign)) { const b = e.byId(e.sc(a).blockedById); log('  TOW', a.callsign, 'by', b?.callsign, 'plan', b ? !!e.towPlan(a, b) : null, 'dest', JSON.stringify(e.sc(a).taxiDest), 'trail', a.trail.length, a.trail.slice(-12).map((q: any) => `${q.x.toFixed(0)},${q.y.toFixed(0)}`).join(' '), 'lastTow', e.sc(a).lastTowAt, 'held', e.sc(a).heldSince, 'path', a.path ? Array.from({ length: 6 }, (_, k) => { const i = Math.min(a.path.pts.length - 1, a.path.cum.findIndex((c: number) => c >= a.distAlong + k * 30)); const q = a.path.pts[i < 0 ? a.path.pts.length - 1 : i]; return `${q.x.toFixed(0)},${q.y.toFixed(0)}`; }).join(' ') : null, 'give', a.giveWayTo, 'wing', b ? `clr ${e.clearPast(a, b, 170)}` : ''); }
      if (process.env.DBG && WATCH && t % 20 === 0) for (const a of ac) if (WATCH.includes(a.callsign)) { const q = e.sc(a), b = e.byId(q.blockedById); log('   DBG', a.callsign, 'pull', JSON.stringify(q.pull), 'pass', JSON.stringify(q.pass), 'tow', !!q.tow, 'held', q.heldSince != null ? Math.round(e.time - q.heldSince) : null, 'by', b?.callsign, b ? [e.clearPast(a, b, 170), e.clearPast(a, b, 60, 2), e.clearPast(a, b, 22, 0.4)] : '', 'manual', e.manualHold.has(a.id), 'gw', a.giveWayTo, a.phase === 'hold_short' && a.holdShortRunway ? ['cross', a.holdShortRunway, e.crossingSafe(a.holdShortRunway, 80, true, a.pos), e.aiCrossAllowed(a), e.farSideBlocker(a)?.callsign, e.crossesToward(a, a.path?.holds?.[0]?.at ?? null), JSON.stringify(a.path?.holds?.map((h: any) => [h.runway, Math.round(h.at)])), JSON.stringify(e.arrivalOnFinal(a.holdShortRunway, 10)?.nm)].join(' ') : ''); }
      if (WATCH && t % 10 === 0) for (const a of ac) if (WATCH.includes(a.callsign)) log(`  ${Math.round(t)} ${a.callsign} ${a.phase}${a.phase === 'pushback' ? '/' + a.pushback.stage : ''} ${a.pos.x.toFixed(0)},${a.pos.y.toFixed(0)} h${a.heading.toFixed(0)} ${a.speed.toFixed(1)}kt ${a.trafficHold ? 'HELD ' + (e.holdReasonOf(a.id) ?? '') : ''} path ${a.path ? `${a.distAlong.toFixed(0)}/${a.path.total.toFixed(0)}` : '-'} ${a.plan.taxiRoute?.join(' ') ?? ''} req ${a.requests.map((r: any) => r.kind + (r.answeredAt == null ? '?' : '')).join(',')} ${a.giveWayTo ? 'giveway ' + (e.byId(a.giveWayTo)?.callsign ?? '') : ''} card ${who === 'card' ? JSON.stringify(nextCall(e, a)).slice(0, 150) : ''}`);
      if ((who === 'ai' && !APP) && t % 10 === 0) for (const a of ac) for (const r of a.requests) if (r.answeredAt == null && t - r.at > (r.kind === 'pushback' || r.kind === 'startup' ? 900 : 420) && r.kind !== 'cross' && a.altitude < 1) add('aiIgnores', a, `${r.kind} unanswered 7 min (${a.phase})`, `ai|${a.id}|${r.kind}`);
    }
  } catch (err) { F.push({ kind: 'crash', seed, t: Math.round(t), cs: '', at: '', x: 0, y: 0, note: String((err as Error)?.stack ?? err).split('\n').slice(0, 3).join(' | ') }); }
  for (const a of e.aircraft) endTrack(a);
  const led: Record<string, number> = {}; for (const l of e.stats.ledger) if (l.points < 0) led[l.code] = (led[l.code] ?? 0) + 1;
  return { seed, setup: `${who} ${ends.join('/')} ${busy}${talk ? '' : ' no talk-back'}`, findings: F, why, stats: { aircraft: ids.size, landed, departed, cmds, refused, airS: Math.round([...airT.values()].reduce((m, v) => m + v, 0)), airN: airT.size, taxiKm: +(moved / 1000).toFixed(1), maxGround, ...(process.env.DIGEST ? { digest } : {}), ...Object.fromEntries(Object.entries(led).map(([k, v]) => ['-' + k, v])) }, ms: performance.now() - t0, simS: t };
}
(async () => {
  process.on('message', async (m: any) => { if (m === 'stop') process.exit(0); try { process.send!({ ok: await run(m.seed) }); } catch (err) { process.send!({ err: String((err as Error)?.stack ?? err), seed: m.seed }); } });
  if (!process.send) { for (const s of (process.env.SEEDS ?? '1').split(',').map(Number)) { const r = await run(s); log(`seed ${s} [${r.setup}] ${(r.ms / 1000).toFixed(1)} s`, JSON.stringify(r.stats)); for (const f of r.findings) log('  ', f.kind, f.t, f.cs, f.at, f.note); } process.exit(0); }
  else process.send('ready');
})();
