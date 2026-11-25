import fs from 'fs';
import path from 'path';

async function main() {
  const { default: earcut } = await import('earcut');

  const osmPath = 'public/maps/osm/KSFO.geojson';
  const vecPath = 'public/world/KSFO/vectors.json';
  const outObjPath = 'public/models/KSFO_airport.obj';
  const outMtlPath = 'public/models/KSFO_airport.mtl';

  const osm = JSON.parse(fs.readFileSync(osmPath, 'utf8'));
  const vec = JSON.parse(fs.readFileSync(vecPath, 'utf8'));

  const refLng = osm.center[0] || -122.379;
  const refLat = osm.center[1] || 37.6213;

  function toLocal(lng, lat) {
    const x = (lng - refLng) * Math.cos(refLat * Math.PI / 180) * 111320;
    const z = -(lat - refLat) * 110574; // -north (so +z is south, standard three.js / OBJ)
    return [x, z];
  }

  let vertices = []; // array of [x, y, z]
  let vertIndexMap = new Map();
  let objects = []; // { name, material, faces: [[v1, v2, v3], ...] }

  function addVertex(x, y, z) {
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (vertIndexMap.has(key)) return vertIndexMap.get(key);
    vertices.push([x, y, z]);
    const idx = vertices.length; // 1-based index for OBJ
    vertIndexMap.set(key, idx);
    return idx;
  }

  function extrudePolygon(coords2d, baseH, topH, objName, matName) {
    if (coords2d.length < 3) return;
    // ensure closed or unclosed? earcut expects array of x,y,x,y...
    let pts = coords2d;
    if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
      pts = pts.slice(0, -1);
    }
    if (pts.length < 3) return;

    const flat = [];
    for (const [x, z] of pts) {
      flat.push(x, z);
    }
    const triangles = earcut(flat);

    const faces = [];

    // Roof cap
    for (let i = 0; i < triangles.length; i += 3) {
      const i0 = triangles[i];
      const i1 = triangles[i + 1];
      const i2 = triangles[i + 2];
      const v0 = addVertex(pts[i0][0], topH, pts[i0][1]);
      const v1 = addVertex(pts[i1][0], topH, pts[i1][1]);
      const v2 = addVertex(pts[i2][0], topH, pts[i2][1]);
      faces.push([v0, v1, v2]);
    }

    // Side walls
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const x0 = pts[i][0], z0 = pts[i][1];
      const x1 = pts[next][0], z1 = pts[next][1];

      const b0 = addVertex(x0, baseH, z0);
      const b1 = addVertex(x1, baseH, z1);
      const t0 = addVertex(x0, topH, z0);
      const t1 = addVertex(x1, topH, z1);

      faces.push([b0, b1, t1]);
      faces.push([b0, t1, t0]);
    }

    objects.push({ name: objName, material: matName, faces });
  }

  function flatPolygon(coords2d, yH, objName, matName) {
    let pts = coords2d;
    if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
      pts = pts.slice(0, -1);
    }
    if (pts.length < 3) return;

    const flat = [];
    for (const [x, z] of pts) {
      flat.push(x, z);
    }
    const triangles = earcut(flat);
    const faces = [];
    for (let i = 0; i < triangles.length; i += 3) {
      const v0 = addVertex(pts[triangles[i]][0], yH, pts[triangles[i]][1]);
      const v1 = addVertex(pts[triangles[i + 1]][0], yH, pts[triangles[i + 1]][1]);
      const v2 = addVertex(pts[triangles[i + 2]][0], yH, pts[triangles[i + 2]][1]);
      faces.push([v0, v1, v2]);
    }
    objects.push({ name: objName, material: matName, faces });
  }

  // 1. Terminals and Hangars from KSFO.geojson
  let termIdx = 0;
  for (const feat of osm.features) {
    const aero = feat.properties?.aeroway;
    const name = feat.properties?.name || feat.properties?.ref || (aero ? `${aero}_${termIdx++}` : null);
    if (!name) continue;

    if (aero === 'terminal' || aero === 'hangar') {
      const height = aero === 'terminal' ? 18.0 : 14.0;
      const mat = aero === 'terminal' ? 'mat_terminal' : 'mat_hangar';
      const geom = feat.geometry;
      if (geom.type === 'Polygon') {
        const coords = geom.coordinates[0].map(([lng, lat]) => toLocal(lng, lat));
        extrudePolygon(coords, 0, height, name.replace(/\s+/g, '_'), mat);
      } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach((poly, pIdx) => {
          const coords = poly[0].map(([lng, lat]) => toLocal(lng, lat));
          extrudePolygon(coords, 0, height, `${name.replace(/\s+/g, '_')}_${pIdx}`, mat);
        });
      }
    } else if (aero === 'apron') {
      const geom = feat.geometry;
      if (geom.type === 'Polygon') {
        const coords = geom.coordinates[0].map(([lng, lat]) => toLocal(lng, lat));
        flatPolygon(coords, 0.1, `apron_${termIdx++}`, 'mat_apron');
      }
    }
  }

  // 2. Runways from KSFO.geojson
  let rwyIdx = 0;
  for (const feat of osm.features) {
    if (feat.properties?.aeroway === 'runway') {
      const geom = feat.geometry;
      const rwyName = feat.properties?.ref || `runway_${++rwyIdx}`;
      if (geom.type === 'Polygon') {
        const coords = geom.coordinates[0].map(([lng, lat]) => toLocal(lng, lat));
        flatPolygon(coords, 0.25, `rwy_${rwyName}`, 'mat_runway');
      } else if (geom.type === 'LineString') {
        // Line runway with width ~60m
        const pts = geom.coordinates.map(([lng, lat]) => toLocal(lng, lat));
        if (pts.length >= 2) {
          const [p0, p1] = [pts[0], pts[pts.length - 1]];
          const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
          const len = Math.hypot(dx, dz);
          if (len > 0) {
            const nx = -dz / len * 30, nz = dx / len * 30; // 60m width
            const poly = [
              [p0[0] + nx, p0[1] + nz],
              [p1[0] + nx, p1[1] + nz],
              [p1[0] - nx, p1[1] - nz],
              [p0[0] - nx, p0[1] - nz]
            ];
            flatPolygon(poly, 0.25, `rwy_${rwyName}`, 'mat_runway');
          }
        }
      }
    }
  }

  // 3. Buildings near SFO from vectors.json (within 3.2km of center)
  let bldgIdx = 0;
  for (const b of vec.buildings || []) {
    const pts = b.p.map(([lng, lat]) => toLocal(lng, lat));
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const dist = Math.hypot(cx, cz);
    if (dist < 3200) { // Airport perimeter
      const h = b.h || 8.0;
      const k = b.k === 'terminal' ? 'mat_terminal' : b.k === 'hangar' ? 'mat_hangar' : 'mat_building';
      extrudePolygon(pts, 0, h, `building_${++bldgIdx}`, k);
    }
  }

  console.log(`Generated ${vertices.length} vertices and ${objects.length} mesh objects.`);

  // Write MTL file
  const mtlContent = `
# Materials for SFO Airport
newmtl mat_terminal
Kd 0.76 0.77 0.76
Ka 0.2 0.2 0.2
Ks 0.1 0.1 0.1
Ns 20

newmtl mat_hangar
Kd 0.58 0.60 0.62
Ka 0.2 0.2 0.2
Ks 0.1 0.1 0.1
Ns 10

newmtl mat_building
Kd 0.48 0.49 0.50
Ka 0.2 0.2 0.2
Ks 0.05 0.05 0.05
Ns 5

newmtl mat_runway
Kd 0.18 0.19 0.20
Ka 0.1 0.1 0.1
Ks 0.0 0.0 0.0
Ns 2

newmtl mat_apron
Kd 0.70 0.70 0.68
Ka 0.2 0.2 0.2
Ks 0.05 0.05 0.05
Ns 2
`.trim();

  fs.mkdirSync('public/models', { recursive: true });
  fs.writeFileSync(outMtlPath, mtlContent);

  // Stream write OBJ file to handle large size
  const out = fs.createWriteStream(outObjPath);
  out.write(`# SFO Airport 3D Model\n`);
  out.write(`# Centered at San Francisco International Airport (KSFO)\n`);
  out.write(`# Reference: lat ${refLat}, lng ${refLng}, units: meters\n`);
  out.write(`mtllib KSFO_airport.mtl\n\n`);

  for (const [x, y, z] of vertices) {
    out.write(`v ${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}\n`);
  }

  for (const obj of objects) {
    out.write(`\no ${obj.name}\n`);
    out.write(`usemtl ${obj.material}\n`);
    for (const [v0, v1, v2] of obj.faces) {
      out.write(`f ${v0} ${v1} ${v2}\n`);
    }
  }

  out.end();
  console.log(`Successfully written ${outObjPath} and ${outMtlPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
