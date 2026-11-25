// Settles a new airport: check -> stands that cannot be pushed or driven cleanly go on the "no way" list -> stand plan again,
// until a round finds no new one.  node scripts/gatelab/settle.cjs KJFK [rounds=4]
const fs = require('node:fs'), { execFileSync } = require('node:child_process');
const ICAO = process.argv[2].toUpperCase(), ROUNDS = Number(process.argv[3] || 4), F = 'src/lib/sim/standplans/noway.json';
const lab = (what) => { try { return execFileSync('bash', ['scripts/gatelab.sh', ICAO, ...what], { env: { ...process.env, HTML: '0' }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] }); } catch (e) { return String(e.stdout); } };
const near = (a, b, m) => { const [x, y] = a.split(',').map(Number), [u, v] = b.split(',').map(Number); return Math.hypot((x - u) * 111320, (y - v) * 111320 * Math.cos(x * Math.PI / 180)) < m; };
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`-- round ${round}: plan`); lab(['fix']);
  const txt = lab([]); console.log(txt.split('\n').filter((l) => /FAIL|stands,|to fix|pass/.test(l)).map((l) => l.slice(0, 150)).join('\n'));
  const { report: r, stands } = JSON.parse(fs.readFileSync('.tmp/gatelab.json', 'utf8')); const at = new Map(stands.map((s) => [s.ref, s.at ?? null])); const bad = new Map(); const add = (ref, why) => { if (at.has(ref)) bad.set(ref, why); };
  for (const k of ['pushHits', 'pushWall', 'pushEndOff', 'noPush', 'inBuilding', 'leadInBlocked', 'inHits', 'inWall', 'noLeadIn', 'nothingFits', 'sharedGround']) for (const x of r[k] || []) add(x.a, k);
  for (const x of r.overlap || []) add(x.b, 'overlap'); for (const x of r.backToBack || []) add(x.b, 'backToBack'); for (const x of r.inLine || []) add(x.behind, 'inLine');
  for (const x of r.startsBehind || []) add(x.label.split('->')[0], 'startsBehind');
  // (a whole field that enters a runway far down is the field's way, not the stand's)
  { const by = {}; for (const x of r.farEntry || []) { const [a, b] = x.label.split('->'); (by[b] ||= new Set()).add(a); } for (const set of Object.values(by)) if (set.size < stands.length * 0.25) for (const a of set) add(a, 'farEntry'); }
  const total = {}, gone = {}; for (const x of r.noRoute || []) { const [a, b] = x.label.split('->'); for (const s of [a, b]) if (at.has(s)) gone[s] = (gone[s] || 0) + 1; } for (const [s, n] of Object.entries(gone)) if (n >= 2) add(s, 'noRoute');
  for (const x of r.offLine || []) { const [a, b] = x.label.split('->'); if (at.has(a) && x.s < 330) add(a, 'offLine'); else if (at.has(b) && at.get(b) && near(at.get(b), x.at, 170)) add(b, 'offLine in'); }
  for (const x of r.parksCrooked || []) if (x.deg > 35) add(x.a, 'parksCrooked');
  for (const x of r.wiggle || []) for (const [s, p] of at) if (p && near(p, x.at, 90) && (x.eg || '').split('->').includes(s)) add(s, 'wiggle');
  const all = JSON.parse(fs.readFileSync(F, 'utf8')), have = new Set(all[ICAO] || []), before = have.size; for (const s of bad.keys()) have.add(s);
  console.log(`   no clean way: ${[...bad].map(([s, w]) => `${s} (${w})`).join(', ') || 'none'}`);
  if (have.size === before) break;
  all[ICAO] = [...have].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); fs.writeFileSync(F, JSON.stringify(all));
  if (round === ROUNDS) lab(['fix']);
}
