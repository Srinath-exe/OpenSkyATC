// Runs the bundled gate lab over all cores and puts the parts together.  node run.cjs <ICAO> <what>  (see ../gatelab.sh)
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ICAO = (process.argv[2] || 'KSFO').toUpperCase(), WHAT = process.argv[3] || 'all', N = Number(process.env.JOBS || os.cpus().length), T = '.tmp/gatelab'; fs.mkdirSync(T, { recursive: true });
const t0 = Date.now();
const runAll = (what, tag) => Promise.all(Array.from({ length: N }, (_, i) => new Promise((res, rej) => { const out = `${T}/${ICAO}-${tag}-${i}.json`; const p = spawn('node', ['.tmp/gatelab.cjs', ICAO, what], { env: { ...process.env, SHARD: `${i}/${N}`, OUT: out }, stdio: ['ignore', 'inherit', 'inherit'] }); p.on('exit', c => (c ? rej(new Error(`shard ${i} failed`)) : res(JSON.parse(fs.readFileSync(out, 'utf8'))))); })));
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
// what each finding means, and whether it fails the run (the rest are for information)
const KINDS = {
  overlap: ['Stands parked on top of each other', 1], loop: ['Goes round in a circle', 1], sharedGround: ['Stands painted over one another (one cannot be used while the other is)', 1], tight: ['Parked aircraft closer than the ICAO clearance (4.5 / 7.5 m)', 0], backToBack: ['Tails facing with no lane between', 1], inLine: ['One stand behind another', 1],
  inBuilding: ['Parked aircraft inside a building', 1], farFromTerminal: ['Gate more than 35 m from its terminal', 0], tailInLane: ['Parked tail within 18 m of a taxilane', 0], longLeadIn: ['Lead-in longer than 200 m', 0], noLeadIn: ['No lead-in', 1], leadInBlocked: ['Way in runs through a parked neighbour', 1], nothingFits: ['No aircraft fits', 1],
  noPush: ['No pushback found', 1], pushSpin: ['Pushback spins the aircraft round on the spot', 1], pushHits: ['Pushback hits a parked neighbour', 1], pushTight: ['Pushback passes a neighbour closer than 3 / 4.5 m', 0], pushWall: ['Pushback passes a building closer than 3 m', 1], pushWiggle: ['Pushback swings one way and back', 0], pushLong: ['Pushback longer than 190 m', 0], pushEndOff: ['Pushback ends off the lane', 1],
  noRoute: ['No taxi route', 1], noExit: ['No runway exit', 0], brokenRoute: ['Route jumps off the taxiways', 1], tooWide: ['Route uses a taxiway the aircraft does not fit', 1], noHold: ['Runway entered with no hold line', 1], notOptimal: ['Route clearly longer than the best one', 1], outAndBack: ['Instruction leaves a taxiway and returns to it', 1], viaRefused: ['Spoken route refused', 1], viaDiffers: ['Spoken route drives a longer way', 1],
  farEntry: ['Enters the departure runway far from its threshold', 1], sharpCorner: ['Corner of more than 95 degrees cut on its fillet', 0], offLine: ['Driven line more than 12 m off the painted lines', 1], startsBehind: ['Taxi starts behind the nose', 1], crab: ['Turn sharper than the aircraft can follow', 0], wiggle: ['Leaves a line and comes back to it', 1], inWall: ['Way into the stand touches a building', 1], inHits: ['Way into the stand hits a parked neighbour', 1], inTight: ['Way into the stand within 2 m of a neighbour', 0], parksCrooked: ['Parks more than 8 degrees crooked', 0],
};
const esc = s => String(s).replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'));
(async () => {
  if (WHAT.split(',').includes('repush')) {
    const push = {}; for (const p of await runAll('repush', 'repush')) Object.assign(push, p.push);
    const f = `src/lib/sim/standplans/${ICAO}.json`, doc = JSON.parse(fs.readFileSync(f, 'utf8')); Object.assign(doc.push, push); fs.writeFileSync(f, JSON.stringify(doc));
    console.log(`${ICAO}: new pushes for ${Object.keys(push).join(' ')}`); return;
  }
  if (WHAT.split(',').includes('fix')) {
    const parts = await runAll('fix', 'fix'); const p0 = parts[0], size = {}, push = {}, clash = new Set(); for (const p of parts) Object.assign(p0.drop, p.drop);
    for (const p of parts) { Object.assign(push, p.push); for (const c of p.clash) clash.add(c); }
    // a size lowered by any part wins
    for (const p of parts) for (const [r, z] of Object.entries(p.size)) if (!size[r] || z < size[r]) size[r] = z;
    const doc = { sig: p0.sig, drop: p0.drop, size, clash: [...clash].map(c => c.split('|')).filter(([a, b]) => !(a in p0.drop) && !(b in p0.drop)), push: Object.fromEntries(Object.entries(push).filter(([r, o]) => !(r in p0.drop) && o.length)) };
    const f = `src/lib/sim/standplans/${ICAO}.json`; fs.writeFileSync(f, JSON.stringify(doc));
    console.log(`${ICAO} plan written: ${Object.keys(p0.size0).length - Object.keys(p0.drop).length} stands kept, ${Object.keys(p0.drop).length} dropped, ${Object.keys(size).length} resized, ${doc.clash.length} pairs never used together, ${parts.reduce((m, p) => m + p.cases, 0)} pushes tried, ${secs()} s -> ${f} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
    console.log('  dropped:', Object.entries(p0.drop).map(([a, b]) => `${a} (${b})`).join(', ') || 'none'); console.log('  resized:', Object.entries(size).map(([a, b]) => `${a} ${p0.size0[a]}>${b}`).join(', ') || 'none'); console.log('  not together:', doc.clash.map(c => c.join('+')).join(' ') || 'none'); console.log('  no push found:', parts.flatMap(p => p.none).join(' ') || 'none');
    // check what was made: a pair that still gets in each other's way is never used together
    require('node:child_process').execSync('npx esbuild scripts/gatelab/lab.ts --bundle --platform=node --format=cjs --alias:@=./src --log-level=error --outfile=.tmp/gatelab.cjs');
    for (let round = 0; round < 3; round++) {
      const more = new Set(); for (const p of await runAll('gates,push,in', 'heal')) for (const k of ['leadInBlocked', 'pushHits', 'inHits', 'overlap']) for (const o of p.report[k] || []) more.add([o.a, o.by || o.b].sort().join('|'));
      if (!more.size) break;
      for (const m of more) doc.clash.push(m.split('|')); fs.writeFileSync(f, JSON.stringify(doc)); console.log('  also not together:', [...more].join(' '));
      require('node:child_process').execSync('npx esbuild scripts/gatelab/lab.ts --bundle --platform=node --format=cjs --alias:@=./src --log-level=error --outfile=.tmp/gatelab.cjs');
    }
    const src = fs.readFileSync('src/lib/sim/standPlans.ts', 'utf8'); if (!src.includes(`./standplans/${ICAO}.json`)) console.log(`  add ${ICAO} to src/lib/sim/standPlans.ts`);
    return;
  }
  const parts = await runAll(WHAT, 'check'); const rep = {}, wig = new Map(); let cases = 0;
  for (const p of parts) { cases += p.cases; for (const [k, v] of Object.entries(p.report)) if (k === 'wiggle') for (const w of v) { const key = w.at.split(',').map(x => (+x).toFixed(4)).join(); const c = wig.get(key); if (c) { c.n += w.n; c.off = Math.max(c.off, w.off); } else wig.set(key, { ...w }); } else (rep[k] ??= []).push(...v); }
  if (wig.size) rep.wiggle = [...wig.values()].sort((a, b) => b.n - a.n);
  let fails = 0; console.log(`${ICAO}: ${parts[0].stands.length} stands, ${cases} cases in ${secs()} s${parts[0].planned ? '' : '   (no stand plan: run "fix" first)'}`);
  const rows = Object.entries(KINDS).map(([k, [what, bad]]) => { const v = rep[k] || []; if (bad) fails += v.length; return { k, what, bad, n: v.length, v }; });
  for (const r of rows) if (r.n) console.log(`  ${r.bad ? 'FAIL' : 'note'}  ${String(r.n).padStart(5)}  ${r.what}  [${r.k}]  e.g. ${JSON.stringify(r.v[0]).slice(0, 150)}`);
  console.log(fails ? `  ${fails} to fix` : '  all checks pass');
  fs.writeFileSync('.tmp/gatelab.json', JSON.stringify({ icao: ICAO, cases, report: rep, stands: parts[0].stands }, null, 1));
  if (process.env.HTML !== '0') {
    const f = `public/reports/gatelab-${ICAO}.html`;
    fs.writeFileSync(f, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ICAO} gate check</title><style>body{font:15px/1.5 system-ui;margin:0;background:#0b0e13;color:#e8edf4}main{max-width:1000px;margin:auto;padding:32px 16px}table{border-collapse:collapse;width:100%}td,th{padding:7px 10px;border-bottom:1px solid #222a35;text-align:left;vertical-align:top}.ok{color:#5cffb0}.bad{color:#ff8a6b}.note{color:#ffd27a}details{margin:0}code{font-size:12px;color:#9fb0c5;white-space:pre-wrap}</style><main><h1>${ICAO} gate check</h1><p>${parts[0].stands.length} stands, ${cases.toLocaleString('en')} cases, ${secs()} s. ${fails ? `<b class="bad">${fails} to fix</b>` : '<b class="ok">All checks pass</b>'}</p><table><tr><th>Check<th>Found<th>Examples</tr>${rows.map(r => `<tr><td>${esc(r.what)}<td class="${r.n ? (r.bad ? 'bad' : 'note') : 'ok'}">${r.n || 'none'}<td>${r.n ? `<details><summary>show</summary><code>${r.v.slice(0, 40).map(o => esc(JSON.stringify(o))).join('\n')}</code></details>` : ''}</tr>`).join('')}</table></main>`);
    console.log(`  report: ${f}`);
  }
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error(e.message); process.exit(2); });
