/*
  Bake the game's textured fleet (public/models/fleet: one GLB per type, liveries as separate textures) into
  self-contained GLBs for the phone's Mapbox model layer, which takes a model file with its textures inside.

    npx tsx mobile/tool/fleet/bake.ts            -> mobile/build-fleet/*.glb + map.json (every airline)
    MAX=512 OUT=mobile/assets/fleet CARRIERS=UAL,ASA,SWA,DAL,AAL,SKW,ANA,JAL,CPA,SIA,BAW npx tsx mobile/tool/fleet/bake.ts
                                                 -> the set the app ships with (SFO's carriers)

  One GLB per (model, livery) any airline in airlines.ts can fly, plus one plain white GLB per model for an airline
  without a livery. Textures go in as JPEG (PNG when they have transparency), at most MAX px. The models stay as the
  FlightGear made them (metres, y up), re-origined at the nose wheel on the ground with the nose toward -x; the app
  scales each by its type's real length over the model's own (map.json len).
*/
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { AIRLINES } from '../../../src/lib/sim/airlines'
import { FLEET_TYPES, setFleetIndex, fleetPick } from '../../../src/components/atc/WorldMap/fleet'

const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'public/models/fleet')
const OUT = path.resolve(ROOT, process.env.OUT ?? 'mobile/build-fleet')
// CARRIERS=UAL,ASA,...: only those airlines' liveries (every type still gets its plain model)
const PARTNER: Record<string, string> = { SKW: 'UAL' }
const ONLY = process.env.CARRIERS ? new Set(process.env.CARRIERS.split(',')) : null
const MAX = Number(process.env.MAX ?? 1024)
const index = JSON.parse(fs.readFileSync(path.join(SRC, 'index.json'), 'utf8'))
setFleetIndex(index)

function readGlb(file: string) {
  const b = fs.readFileSync(file)
  const jsonLen = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'))
  const binStart = 20 + jsonLen
  const binLen = b.readUInt32LE(binStart)
  const bin = b.subarray(binStart + 8, binStart + 8 + binLen)
  return { json, bin }
}
const pad4 = (b: Buffer, fill: number) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b)
function writeGlb(json: unknown, bin: Buffer): Buffer {
  const j = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20), bb = pad4(bin, 0)
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bb.length, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bb.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([head, jh, j, bh, bb])
}

const lengths = new Map<string, number>()
const texCache = new Map<string, Promise<{ data: Buffer; mime: string }>>()
function texture(hash: string) {
  let p = texCache.get(hash)
  if (!p) {
    const alpha = hash.length > 16
    const img = sharp(path.join(SRC, 'tex', `${hash.slice(0, 16)}.webp`)).resize(MAX, MAX, { fit: 'inside', withoutEnlargement: true })
    p = (alpha ? img.png({ compressionLevel: 9 }) : img.jpeg({ quality: 82, mozjpeg: true })).toBuffer().then((data) => ({ data, mime: alpha ? 'image/png' : 'image/jpeg' }))
    texCache.set(hash, p)
  }
  return p
}

/** The model with the livery's textures embedded (null: plain white, for airlines without a livery). */
async function bake(modelKey: string, tex: Record<string, string> | null): Promise<Buffer> {
  const m = index.models[modelKey]
  const { json, bin } = readGlb(path.join(SRC, m.glb))
  let buf = Buffer.from(bin)
  json.images = []; json.textures = []; json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
  const texIndex = new Map<string, number>()
  for (const mat of json.materials as Array<Record<string, any>>) {
    const slot = typeof mat.name === 'string' && mat.name.startsWith('tex:') ? mat.name.slice(4) : null
    const pbr = (mat.pbrMetallicRoughness ??= {})
    pbr.metallicFactor = 0.15; pbr.roughnessFactor = 0.55
    mat.doubleSided = true          // fins and tailplanes are single sheets
    const hash = slot && tex ? tex[slot] : null
    if (!hash) { pbr.baseColorFactor = [0.93, 0.94, 0.95, 1]; delete pbr.baseColorTexture; continue }
    let ti = texIndex.get(hash)
    if (ti == null) {
      const t = await texture(hash)
      buf = pad4(buf, 0)
      json.bufferViews.push({ buffer: 0, byteOffset: buf.length, byteLength: t.data.length })
      buf = Buffer.concat([buf, t.data])
      json.images.push({ bufferView: json.bufferViews.length - 1, mimeType: t.mime })
      json.textures.push({ sampler: 0, source: json.images.length - 1 })
      ti = json.textures.length - 1; texIndex.set(hash, ti)
    }
    pbr.baseColorTexture = { index: ti }; pbr.baseColorFactor = [1, 1, 1, 1]
    if (hash.length > 16) mat.alphaMode = 'MASK', mat.alphaCutoff = 0.5
  }
  const geo = geometry(json, bin)
  const L = geo.length
  // nose toward -x for every model; origin at the nose wheel (NOSE_WHEEL = 12 % of the length behind the nose, the
  // sim's position), wheels at y = 0. Mapbox draws glTF +x east, so the app's model-rotation z is heading + 90.
  const flip = !geo.noseAtMinusX
  const wheelX = flip ? geo.hi[0] - 0.12 * L : geo.lo[0] + 0.12 * L
  // flipped: rotate 180 degrees about y (x -> -x), then the wheel (at -wheelX after the turn) moves to the origin
  const root = { name: 'openatc-origin', children: [...json.scenes[json.scene ?? 0].nodes], ...(flip ? { rotation: [0, 1, 0, 0], translation: [wheelX, -geo.lo[1], 0] } : { translation: [-wheelX, -geo.lo[1], 0] }) }
  json.nodes.push(root); json.scenes[json.scene ?? 0].nodes = [json.nodes.length - 1]
  json.extras = { lengthM: Math.round(L * 1000) / 1000, flipped: flip }
  lengths.set(modelKey, Math.round(L * 1000) / 1000)
  if (!json.images.length) { delete json.images; delete json.textures; delete json.samplers }
  json.buffers = [{ byteLength: pad4(buf, 0).length }]
  json.asset = { version: '2.0', generator: 'openatc mobile/tool/fleet/bake.ts' }
  return writeGlb(json, buf)
}

/** Vertex bounds and the fin: the models are long along x, wings along z, y up; the fin stands over the tail, so it
 *  tells which end is the nose (most FlightGear models face -x, a few +x). */
function geometry(json: any, bin: Buffer) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const pts: number[][] = []
  for (const node of json.nodes as any[]) {
    if (node.mesh == null) continue
    const t = node.translation ?? [0, 0, 0]
    if (node.rotation || node.scale || node.matrix) throw new Error(`node transform in ${node.name}: not handled`)
    for (const prim of json.meshes[node.mesh].primitives) {
      const acc = json.accessors[prim.attributes.POSITION], bv = json.bufferViews[acc.bufferView]
      const stride = bv.byteStride ?? 12, base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride
        const v = [bin.readFloatLE(o) + t[0], bin.readFloatLE(o + 4) + t[1], bin.readFloatLE(o + 8) + t[2]]
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]) }
        if (i % 2 === 0) pts.push(v)
      }
    }
  }
  const top = hi[1] - (hi[1] - lo[1]) * 0.08
  const fin = pts.filter((v) => v[1] >= top), finX = fin.reduce((s, v) => s + v[0], 0) / Math.max(1, fin.length)
  return { lo, hi, length: hi[0] - lo[0], noseAtMinusX: finX > (lo[0] + hi[0]) / 2 }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const fileOf = (key: string, livery: string | null) => `${key.replace('/', '_')}${livery ? `__${slug(livery)}` : ''}.glb`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const pairs: Record<string, string> = {}, types: Record<string, string> = {}
  const jobs = new Map<string, { key: string; livery: string | null; tex: Record<string, string> | null }>()
  // every type an airline flies (and every type the fleet table knows) x every airline
  const allTypes = new Set<string>(Object.keys(FLEET_TYPES))
  for (const al of AIRLINES) for (const t of Object.keys(al.fleet)) allTypes.add(t)
  for (const type of allTypes) {
    const keys = FLEET_TYPES[type]?.keys ?? []
    const key = keys.find((k) => index.models[k]); if (!key) continue
    const plain = fileOf(key, null); types[type] = plain; jobs.set(plain, { key, livery: null, tex: null })
    for (const al of AIRLINES) {
      if (!(type in al.fleet) || (ONLY && !ONLY.has(al.icao))) continue
      // a regional flying for a mainline partner wears the partner's express livery (SkyWest at SFO: United Express)
      let pick = fleetPick(type, `${al.icao}100`)
      if ((!pick || !pick.livery) && PARTNER[al.icao]) pick = fleetPick(type, `${PARTNER[al.icao]}100`) ?? pick
      if (!pick) continue
      const f = fileOf(pick.key, pick.livery); pairs[`${type}|${al.icao}`] = f
      jobs.set(f, { key: pick.key, livery: pick.livery, tex: pick.tex })
    }
  }
  let bytes = 0, n = 0
  const files: Record<string, number> = {}
  const len: Record<string, number> = {}
  for (const [f, j] of jobs) {
    const out = path.join(OUT, f)
    fs.writeFileSync(out, await bake(j.key, j.tex))
    const sz = fs.statSync(out).size; files[f] = sz; bytes += sz; n++; len[f] = lengths.get(j.key)!
  }
  // len: the model's own length in metres (the app scales each aircraft by its type's real length / len)
  fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify({ version: 1, pairs, types, len, files }, null, 0))
  console.log('flipped:', [...new Set([...jobs.values()].map((j) => j.key))].filter((k) => { const g = geometry(readGlb(path.join(SRC, index.models[k].glb)).json, readGlb(path.join(SRC, index.models[k].glb)).bin); return !g.noseAtMinusX }).join(' ') || 'none')
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(OUT, 'LICENSE')); fs.copyFileSync(path.join(SRC, 'NOTICE.txt'), path.join(OUT, 'NOTICE.txt'))
  console.log(`${n} GLBs, ${(bytes / 1048576).toFixed(1)} MB; ${Object.keys(pairs).length} airline/type pairs, ${Object.keys(types).length} types`)
}
main().catch((e) => { console.error(e); process.exit(1) })
