// The world behind the airport map view on /start, as a grid of land dots (1.5 degrees, longitude -170..190, latitude 74..-56).
//   node scripts/pickworld.cjs ne_50m_land.geojson     (Natural Earth, public domain) -> public/maps/pick/world.json
const fs = require('node:fs'), path = require('node:path'), g = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const polys = g.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)).map((p) => ({ p, b: p[0].reduce((b, [x, y]) => [Math.min(b[0], x), Math.max(b[1], x), Math.min(b[2], y), Math.max(b[3], y)], [1e9, -1e9, 1e9, -1e9]) }));
const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
const land = (x, y) => polys.some(({ p, b }) => x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3] && inRing(p[0], x, y) && !p.slice(1).some((h) => inRing(h, x, y)));
const S = 1.5, C = 240, R = 87, rows = [];
for (let r = 0; r < R; r++) { let s = ''; for (let c = 0; c < C; c++) { let x = -170 + (c + 0.5) * S; if (x > 180) x -= 360; s += land(x, 74 - (r + 0.5) * S) ? '1' : '0'; } rows.push(s.match(/.{4}/g).map((q) => parseInt(q, 2).toString(16)).join('')); }
const out = path.join(__dirname, '../public/maps/pick/world.json'); fs.writeFileSync(out, JSON.stringify({ step: S, lng0: -170, lat0: 74, cols: C, rows })); console.log(out, fs.statSync(out).size, rows.join('').replace(/0/g, '').length);
