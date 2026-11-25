// Bake an airport's graph for the phone (see osmAirport.ts):  node mobile/core/bake-airport.mjs KSFO
// Boots the core in Node with the airport's OSM + airspace files and writes mobile/assets/airports/ICAO.baked.json.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const icao = (process.argv[2] ?? 'KSFO').toUpperCase()
const ctx = vm.createContext({ console, Promise, Math, Date, JSON })
vm.runInContext(fs.readFileSync(path.join(root, 'mobile/assets/core/core.js'), 'utf8'), ctx)
const ATC = ctx.ATC
ATC.provide(`/maps/osm/${icao}.geojson`, fs.readFileSync(path.join(root, `public/maps/osm/${icao}.geojson`), 'utf8'))
ATC.provide(`/airspace/${icao}.txt`, fs.readFileSync(path.join(root, `public/airspace/${icao}.txt`), 'utf8'))
ATC.bakeNext()
ATC.boot(JSON.stringify({ icao, seed: 1, spawn: 'none', naming: 'real' }))   // the airport's own names: the game puts the simple ones on itself
for (let i = 0; i < 500 && JSON.parse(ATC.status()).state === 'loading'; i++) await new Promise((r) => setTimeout(r, 10))
const st = JSON.parse(ATC.status()); if (st.state !== 'ready') throw new Error(`boot: ${st.error}`)
for (const [from, to] of [[`osm/${icao}.geojson`, `${icao}.geojson`], [`../airspace/${icao}.txt`, `${icao}.txt`], [`pick/${icao}.json`, `${icao}.pick.json`]]) fs.copyFileSync(path.join(root, 'public/maps', from), path.join(root, 'mobile/assets/airports', to))
// the flat ground (groundPlan.ts draws the same file in 3D): land, districts, grass, aprons, car parks, decks as map fills
const plan = JSON.parse(fs.readFileSync(path.join(root, `public/maps/ground/${icao}.json`), 'utf8'))
const pair = (a) => { const o = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i], a[i + 1]]); if (o.length && (o[0][0] !== o.at(-1)[0] || o[0][1] !== o.at(-1)[1])) o.push(o[0]); return o }
const features = ['site', 'landside', 'deck', 'grass', 'parking', 'apron', 'piers'].flatMap((k) => (plan[k] ?? []).map((rings) => ({ type: 'Feature', properties: { k }, geometry: { type: 'Polygon', coordinates: rings.map(pair).filter((r) => r.length > 3) } })).filter((f) => f.geometry.coordinates.length))
fs.writeFileSync(path.join(root, `mobile/assets/airports/${icao}.ground.json`), JSON.stringify({ type: 'FeatureCollection', features }))
const out = path.join(root, `mobile/assets/airports/${icao}.baked.json`)
fs.writeFileSync(out, ATC.bakedAirport())
// the simple names (the switch makes the book; naming.ts keeps it)
ATC.settings(JSON.stringify({ naming: 'simple' }))
ATC.boot(JSON.stringify({ icao, seed: 1, spawn: 'none', naming: 'simple' }))
for (let i = 0; i < 500 && JSON.parse(ATC.status()).state === 'loading'; i++) await new Promise((r) => setTimeout(r, 10))
const names = ATC.bakedNames(); if (names === 'null') throw new Error('no name book')
fs.writeFileSync(out.replace('.baked.json', '.names.json'), names)
// what fits along each taxi line (taxiLimits.ts)
const limits = ATC.bakedLimits(); if (limits === 'null') throw new Error('no taxi limits')
fs.writeFileSync(out.replace('.baked.json', '.limits.json'), limits)
console.log(`${out} ${(fs.statSync(out).size / 1024).toFixed(0)} KB`)

// the airport list's little map: the web draws the runways from its manifest, the app takes them from the file
const pickFile = path.join(root, `mobile/assets/airports/${icao}.pick.json`), pick = JSON.parse(fs.readFileSync(pickFile, 'utf8'))
const kx = 111320 * Math.cos(pick.lat0 * Math.PI / 180), xy = (p) => [Math.round((p.lng - pick.lng0) * kx), Math.round((pick.lat0 - p.lat) * 110540)]
pick.rw = JSON.parse(fs.readFileSync(out, 'utf8')).runways.map((r) => r.ends.slice(0, 2).flatMap(xy))
fs.writeFileSync(pickFile, JSON.stringify(pick))
