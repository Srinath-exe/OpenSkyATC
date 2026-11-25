/*
  The real ground of an airport, from OpenStreetMap (scripts/ground/plan.py -> public/maps/ground/<ICAO>.json): the land it
  stands on with its sea wall, the grass exactly where it grows, the districts outside the fence with their streets, raised
  roads with ramps and piers, tunnel mouths, car parks, approach-light piers and decks over water. Airports without a plan
  keep the drawn outline (layers.ts tidyGrass).
*/
import * as THREE from 'three'
import { apronMaterial, asphaltMaterial, markingMaterial, PALETTE } from '@/components/atc/WorldMap/terrain'

export const GROUND_PLANS = new Set(['RJTT', 'WSSS', 'LFPG', 'KJFK', 'KSFO', 'OMDB'])
type Rings = number[][]          // outer ring first, then its holes: lng, lat, lng, lat …
interface Plan {
  site: Rings[]; grass: Rings[]; landside: Rings[]; apron: Rings[]; parking: Rings[]; piers: Rings[]; deck: Rings[]
  roads: Array<{ p: number[]; w: number; a: number; b: number }>; mono: Array<{ p: number[] }>
  mouths: Array<[number, number, number, number]>; shore: number[][]
}
type Proj = { toXY(lat: number, lng: number): { x: number; y: number } }

export async function loadGroundPlan(icao: string): Promise<Plan | null> {
  if (!GROUND_PLANS.has(icao)) return null
  try { const r = await fetch(`/maps/ground/${icao}.json`, { cache: 'no-cache' }); return r.ok ? (await r.json() as Plan) : null } catch { return null }
}

/** Polygons with holes, flat at height h, facing up, textured by their place in the world. */
export function flatPolys(list: Rings[], proj: Proj, h: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = []
  for (const rings of list) {
    const rs = rings.map((a) => { const o: THREE.Vector2[] = []; for (let i = 0; i < a.length; i += 2) { const q = proj.toXY(a[i + 1], a[i]); o.push(new THREE.Vector2(q.x, q.y)) } return o })
    const [c, ...holes] = rs; if (!c || c.length < 3) continue
    if (THREE.ShapeUtils.isClockWise(c)) c.reverse()
    for (const q of holes) if (!THREE.ShapeUtils.isClockWise(q)) q.reverse()
    const all = [c, ...holes].flat()
    for (const t of THREE.ShapeUtils.triangulateShape(c, holes)) {
      const [a, b, d] = t.map((k) => all[k]), flip = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x) < 0
      for (const q of flip ? [a, d, b] : [a, b, d]) { pos.push(q.x, h, -q.y); uv.push(q.x, -q.y) }
    }
  }
  return geoOf(pos, uv)
}
function geoOf(pos: number[], uv?: number[], normals = true): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  if (normals) { const n = new Float32Array(pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(n, 3)) }
  return g
}
interface P3 { x: number; y: number; h: number }
/** Left and right edges of a line of points, mitred at the bends. */
function edges(p: P3[], w: number): Array<[number, number, number, number, number]> {
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)]
    let dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L
    let k = w / 2
    if (i > 0 && i < p.length - 1) { const ux = q.x - a.x, uy = q.y - a.y, ul = Math.hypot(ux, uy) || 1, c = (ux * dx + uy * dy) / ul; k = Math.min(w, w / 2 / Math.max(0.5, c)) }
    return [q.x - dy * k, q.y + dx * k, q.x + dy * k, q.y - dx * k, q.h]
  })
}

/** Everything that lies flat on the ground (the caller orders it with the rest of the field) and everything raised. */
export function buildGroundPlan(plan: Plan, proj: Proj): { flat: THREE.Group; raised: THREE.Group; grass: THREE.BufferGeometry } {
  const flat = new THREE.Group(), raised = new THREE.Group(); flat.name = 'ground-plan'; raised.name = 'ground-raised'
  const add = (g: THREE.BufferGeometry, m: THREE.Material, order = 0) => { if (!g.getAttribute('position').count) return; const o = new THREE.Mesh(g, m); o.renderOrder = order; o.frustumCulled = false; flat.add(o) }
  const col = (c: string) => new THREE.Color(c)
  const pave = asphaltMaterial(PALETTE.asphalt.clone()), town = asphaltMaterial(col('#9b9c98')), road = asphaltMaterial(col('#4b4d51')), lot = asphaltMaterial(col('#6f7276'))
  add(flatPolys(plan.site, proj, 0.3), pave)
  add(flatPolys(plan.landside, proj, 0.58), town)
  add(flatPolys(plan.parking, proj, 0.585), lot, 1)
  add(flatPolys(plan.apron, proj, 0.68), apronMaterial())      // over the taxiway strips: their asphalt ends at the apron's edge, only the paint goes on
  add(flatPolys(plan.piers, proj, 0.6), new THREE.MeshLambertMaterial({ color: '#b5573a', side: THREE.DoubleSide }), 2)

  const quad = (out: number[], uv: number[] | null, a: number[], b: number[], c: number[], d: number[]) => { for (const q of [a, b, c, a, c, d]) { out.push(q[0], q[2], -q[1]); uv?.push(q[0], -q[1]) } }
  // the sea wall: a pale band along the shore and the decks' edges
  const wall: number[] = [], wallUv: number[] = []
  for (const s of plan.shore) {
    const p: P3[] = []; for (let i = 0; i < s.length; i += 2) { const q = proj.toXY(s[i + 1], s[i]); p.push({ ...q, h: 0.605 }) }
    const e = edges(p, 5); for (let i = 1; i < e.length; i++) { const u = e[i - 1], v = e[i]; quad(wall, wallUv, [u[2], u[3], 0.605], [v[2], v[3], 0.605], [v[0], v[1], 0.605], [u[0], u[1], 0.605]) }
  }
  add(geoOf(wall, wallUv), asphaltMaterial(col('#b9b8b2')), 3)

  // roads: flat ones on the ground, raised ones as decks with parapets, walls under the ramps and columns
  const inAir: number[] = [], inAirUv: number[] = [], town2: number[] = [], townUv: number[] = [], dash: number[] = []
  const top: number[] = [], topUv: number[] = [], side: number[] = []
  const face = (a: number[], b: number[], lo0: number, lo1: number) => { quad(side, null, [a[0], a[1], lo0], [b[0], b[1], lo1], [b[0], b[1], b[2]], [a[0], a[1], a[2]]) }
  const column = (x: number, y: number, h: number, r: number) => {
    const c = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]]
    for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; face([a[0], a[1], h], [b[0], b[1], h], 0, 0) }
  }
  for (const r of plan.roads) {
    const p: P3[] = []; for (let i = 0; i < r.p.length; i += 3) { const q = proj.toXY(r.p[i + 1], r.p[i]); if (!p.length || Math.hypot(q.x - p[p.length - 1].x, q.y - p[p.length - 1].y) > 0.3) p.push({ ...q, h: r.p[i + 2] }) }
    if (p.length < 2) continue
    const e = edges(p, r.w); let run = 0
    for (let i = 1; i < e.length; i++) {
      const u = e[i - 1], v = e[i], L = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
      const high = Math.max(u[4], v[4]) > 0.4
      if (!high) {
        const h = r.a ? 0.575 : 0.59
        quad(r.a ? inAir : town2, r.a ? inAirUv : townUv, [u[2], u[3], h], [v[2], v[3], h], [v[0], v[1], h], [u[0], u[1], h])
        for (const q of i === 1 ? [p[0], p[1]] : [p[i]]) {   // round ends and joints, so ways meet without notches
          const R = r.w / 2, o = r.a ? inAir : town2, ou = r.a ? inAirUv : townUv
          for (let k = 0; k < 8; k++) { const t0 = k * Math.PI / 4, t1 = t0 + Math.PI / 4; for (const c of [[q.x, q.y], [q.x + R * Math.cos(t0), q.y + R * Math.sin(t0)], [q.x + R * Math.cos(t1), q.y + R * Math.sin(t1)]]) { o.push(c[0], h, -c[1]); ou.push(c[0], -c[1]) } }
        }
      } else {
        const hu = u[4] + 0.65, hv = v[4] + 0.65
        quad(top, topUv, [u[2], u[3], hu], [v[2], v[3], hv], [v[0], v[1], hv], [u[0], u[1], hu])
        const lo = (h: number, g: number) => (g < 3 ? 0 : h - 1.3)                       // a ramp stands on its walls, a deck on columns
        for (const s of [0, 2]) face([u[s], u[s + 1], hu + 0.9], [v[s], v[s + 1], hv + 0.9], lo(hu, u[4]), lo(hv, v[4]))
        for (let d = 32 - run; d < L; d += 32) { const t = d / L, h = p[i - 1].h + (p[i].h - p[i - 1].h) * t; if (h > 3) column(p[i - 1].x + (p[i].x - p[i - 1].x) * t, p[i - 1].y + (p[i].y - p[i - 1].y) * t, h - 0.4, 0.9) }
        run = (run + L) % 32
      }
      if (!r.a && r.w >= 7) for (let d = 3; d + 4 < L; d += 10) {     // broken centre line
        const ux = (p[i].x - p[i - 1].x) / L, uy = (p[i].y - p[i - 1].y) / L, at = (s: number, o: number) => { const t = s / L; return [p[i - 1].x + ux * s - uy * o, p[i - 1].y + uy * s + ux * o, high ? p[i - 1].h + (p[i].h - p[i - 1].h) * t + 0.7 : 0.62] }
        if (!high) quad(dash, null, at(d, -0.16), at(d + 4, -0.16), at(d + 4, 0.16), at(d, 0.16))
      }
    }
  }
  add(geoOf(inAir, inAirUv), road, 0); add(geoOf(town2, townUv), road, 2)
  add(geoOf(dash), markingMaterial(PALETTE.marking), 4)
  // tunnel mouths: the road running down into the dark between two walls, under a concrete lintel
  const dark: number[] = []
  for (const [lng, lat, hdg, w] of plan.mouths) {
    const o = proj.toXY(lat, lng), t = hdg * Math.PI / 180, ux = Math.sin(t), uy = Math.cos(t), H = w / 2 + 0.6
    const at = (f: number, s: number, h: number) => [o.x + ux * f + uy * s, o.y + uy * f - ux * s, h]
    quad(dark, null, at(0, H, 0.6), at(16, H, 0.6), at(16, -H, 0.6), at(0, -H, 0.6))
    for (const s of [-H, H]) face(at(-14, s, 1.5), at(16, s, 1.5), 0, 0)
    face(at(16, -H - 0.5, 2.2), at(16, H + 0.5, 2.2), 0, 0); face(at(17.2, -H - 0.5, 2.2), at(17.2, H + 0.5, 2.2), 0, 0)
    quad(top, topUv, at(16, -H - 0.5, 2.2), at(17.2, -H - 0.5, 2.2), at(17.2, H + 0.5, 2.2), at(16, H + 0.5, 2.2))
  }
  add(geoOf(dark), new THREE.MeshBasicMaterial({ color: '#0c0d0f', side: THREE.DoubleSide }), 5)
  // the monorail: a beam on slim columns
  for (const m of plan.mono) {
    const p: P3[] = []; for (let i = 0; i < m.p.length; i += 3) { const q = proj.toXY(m.p[i + 1], m.p[i]); p.push({ ...q, h: m.p[i + 2] }) }
    const e = edges(p, 2.6); let run = 0
    for (let i = 1; i < e.length; i++) {
      const u = e[i - 1], v = e[i], L = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
      quad(top, topUv, [u[2], u[3], u[4]], [v[2], v[3], v[4]], [v[0], v[1], v[4]], [u[0], u[1], u[4]])
      for (const s of [0, 2]) face([u[s], u[s + 1], u[4]], [v[s], v[s + 1], v[4]], Math.max(0, u[4] - 1.8), Math.max(0, v[4] - 1.8))
      if (p[i].h > 4) for (let d = 26 - run; d < L; d += 26) { const t = d / L; column(p[i - 1].x + (p[i].x - p[i - 1].x) * t, p[i - 1].y + (p[i].y - p[i - 1].y) * t, p[i].h - 1.6, 0.6) }
      run = (run + L) % 26
    }
  }
  const deckTop = new THREE.Mesh(geoOf(top, topUv), asphaltMaterial(col('#5a5c60'))), walls = geoOf(side, undefined, false); walls.computeVertexNormals()
  const deckSide = new THREE.Mesh(walls, new THREE.MeshLambertMaterial({ color: '#b7b6b0', side: THREE.DoubleSide }))
  for (const m of [deckTop, deckSide]) { m.frustumCulled = false; if (m.geometry.getAttribute('position').count) raised.add(m) }
  return { flat, raised, grass: flatPolys(plan.grass, proj, 0.57) }
}
