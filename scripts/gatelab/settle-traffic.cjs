// Second half of settling a new airport: whole sessions (wiresim); a stand whose way in or out touches a building goes on the
// "no way" list, two stands that touch each other are never used together.  node scripts/gatelab/settle-traffic.cjs KJFK [rounds=3] [sessions=16]
const fs = require('node:fs'), { execFileSync } = require('node:child_process');
const ICAO = process.argv[2].toUpperCase(), ROUNDS = Number(process.argv[3] || 3), N = process.argv[4] || '16';
const NW = 'src/lib/sim/standplans/noway.json', PLAN = `src/lib/sim/standplans/${ICAO}.json`, TG = 'src/lib/sim/standplans/together.json';
let from = Number(process.env.FROM || 1);
for (let round = 1; round <= ROUNDS; round++) {
  let out; try { out = execFileSync('bash', ['scripts/wiresim.sh', ICAO, N], { env: { ...process.env, HTML: '0', SHOW: '400', FROM: String(from) }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] }); } catch (e) { out = String(e.stdout); }
  from += Number(N);
  console.log(`-- round ${round} (seeds ${from - Number(N)}..${from - 1})\n${out.split('\n').filter((l) => /FAIL|sessions x|to fix|pass/.test(l)).map((l) => l.slice(0, 130)).join('\n')}`);
  const all = JSON.parse(fs.readFileSync(NW, 'utf8')), have = new Set(all[ICAO] || []), plan = JSON.parse(fs.readFileSync(PLAN, 'utf8')), tg = JSON.parse(fs.readFileSync(TG, 'utf8')), mine = (tg[ICAO] ||= []); let n = 0; const note = [];
  for (const m of out.matchAll(/(?:taxi|pushback|startup) ([A-Z0-9-]+) touches a building/g)) if (!have.has(m[1])) { have.add(m[1]); n++; note.push(`${m[1]} (building)`); }
  const pair = (a, b) => { if (a !== b && ![...plan.clash, ...mine].some(([x, y]) => (x === a && y === b) || (x === b && y === a))) { mine.push([a, b]); n++; note.push(`${a}+${b}`); } };
  for (const m of out.matchAll(/(?:taxi|pushback|startup) ([A-Z0-9-]+) touches \S+ parked at ([A-Z0-9-]+)/g)) pair(m[1], m[2]);
  for (const m of out.matchAll(/(?:pushback|startup) ([A-Z0-9-]+) touches .*?\(stands? ([A-Z0-9-]+), ([A-Z0-9-]+)\)/g)) pair(m[2], m[3]);
  console.log('   ', note.join(', ') || 'nothing new');
  if (!n) break;
  all[ICAO] = [...have].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); fs.writeFileSync(NW, JSON.stringify(all)); fs.writeFileSync(TG, JSON.stringify(tg));
}
