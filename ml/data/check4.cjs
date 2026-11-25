// Keep only rows whose label the game parses to the same command: node ml/data/check4.cjs <compiled src dir> <in> <out>
const fs = require('fs'); const { parseCommand } = require(require('path').resolve(process.argv[2], 'lib/sim/commands.js'));
const rows = fs.readFileSync(process.argv[3], 'utf8').trim().split('\n').map(JSON.parse); const bad = {}, l0 = { same: 0, other: 0, none: 0 }, other = [];
const ac = (l) => { const w = l.split(' '), i = w.findIndex((x) => x === 'ARR' || x === 'DEP'); return { callsign: w[0], ...(i < 0 ? {} : { plan: { kind: w[i] === 'ARR' ? 'arrival' : 'departure', runway: w.slice(i + 1).find((x) => /^\d{1,2}[LRC]?$/.test(x)) ?? null, gateRef: w[i] === 'ARR' ? 'STAND' : null } }) }; };
const ctx = (c) => ({ aircraft: c.split('\n').slice(1).filter(Boolean).map(ac) });
const kept = rows.filter((r) => { if (r.line === 'SAY AGAIN') { const p = parseCommand(r.said, ctx(r.ctx)); if (p.ok && p.ast && p.ast.kind !== 'report') { other.push([r.said, JSON.stringify(p.ast).slice(0, 90)]); } return true; }
  const g = parseCommand(r.line, ctx(r.ctx)); if (!g.ok) { const k = r.line.replace(/^\S+ /, '').replace(/\d+/g, '#') + ' | ' + g.errors[0]?.message; bad[k] = (bad[k] || 0) + 1; return false; }
  const p = parseCommand(r.said, ctx(r.ctx)); if (!p.ok) l0.none++; else if (JSON.stringify(p.ast) === JSON.stringify(g.ast)) l0.same++; else { l0.other++; other.push([r.said, r.line, JSON.stringify(p.ast).slice(0, 110)]); } return true; });
fs.writeFileSync(process.argv[4], kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log({ in: rows.length, kept: kept.length, l0 }); console.log('labels the game cannot parse:', Object.entries(bad).sort((a, b) => b[1] - a[1]).slice(0, 8)); console.log('rules read it differently:', other.length); for (const o of other.filter((_, i) => i % Math.max(1, Math.floor(other.length / 25)) === 0).slice(0, 25)) console.log('  ', o.join(' | '));
