// Clean airport maps for the airport list on /start (aprons, taxiways, buildings; the runways come from the manifest).
//   node scripts/pickmaps.cjs KSFO KJFK ...   -> public/maps/pick/<ICAO>.json   (OpenStreetMap data, metres east / south)
const fs = require('node:fs'), path = require('node:path'), root = path.join(__dirname, '..');
const rdp = (p, tol) => { if (p.length < 3) return p; const [a, b] = [p[0], p[p.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]); let m = 0, k = 0;
  for (let i = 1; i < p.length - 1; i++) { const d = L < 1e-6 ? Math.hypot(p[i][0] - a[0], p[i][1] - a[1]) : Math.abs((b[0] - a[0]) * (a[1] - p[i][1]) - (a[0] - p[i][0]) * (b[1] - a[1])) / L; if (d > m) { m = d; k = i; } }
  return m > tol ? [...rdp(p.slice(0, k + 1), tol).slice(0, -1), ...rdp(p.slice(k), tol)] : [a, b]; };
for (const icao of process.argv.slice(2)) {
  const g = JSON.parse(fs.readFileSync(path.join(root, `public/maps/osm/${icao}.geojson`), 'utf8')).features;
  const rw = g.filter((f) => f.properties.aeroway === 'runway' && f.geometry.type === 'LineString').flatMap((f) => f.geometry.coordinates);
  const lng0 = rw.reduce((s, c) => s + c[0], 0) / rw.length, lat0 = rw.reduce((s, c) => s + c[1], 0) / rw.length, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const xy = ([x, y]) => [(x - lng0) * kx, (lat0 - y) * 110540], flat = (p) => p.flatMap(([x, y]) => [Math.round(x), Math.round(y)]);
  const line = (c, tol) => flat(rdp(c.map(xy), tol));
  // a ring is cut in two first, or its closing point makes it one straight line
  const ring = (c, tol) => { const p = c.map(xy), h = p.length >> 1; return flat([...rdp(p.slice(0, h + 1), tol).slice(0, -1), ...rdp(p.slice(h), tol)]); };
  const out = { lat0: +lat0.toFixed(6), lng0: +lng0.toFixed(6), taxi: [], apron: [], bldg: [] };
  for (const f of g) {
    const a = f.properties.aeroway, t = f.geometry.type, c = f.geometry.coordinates;
    if ((a === 'taxiway' || a === 'taxilane') && t === 'LineString') out.taxi.push(line(c, 2.5));
    const polys = t === 'Polygon' ? [c] : t === 'MultiPolygon' ? c : [];
    const to = a === 'apron' ? out.apron : a === 'terminal' || a === 'hangar' ? out.bldg : null;
    if (to) for (const p of polys) if (p[0].length > 3) to.push(ring(p[0], 3));
  }
  const dir = path.join(root, 'public/maps/pick'); fs.mkdirSync(dir, { recursive: true });
  const s = JSON.stringify(out); fs.writeFileSync(path.join(dir, `${icao}.json`), s); console.log(icao, out.taxi.length, 'taxiways', out.apron.length, 'aprons', out.bldg.length, 'buildings', (s.length / 1024).toFixed(0), 'KB');
}
