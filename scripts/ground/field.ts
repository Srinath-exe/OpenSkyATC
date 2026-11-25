// The game's own airfield for scripts/ground/plan.py: stands as the game uses them (after the stand plan) and the taxi
// lines it draws.   npx esbuild scripts/ground/field.ts --bundle --platform=node --format=cjs --alias:@=./src --outfile=.tmp/field.cjs && node .tmp/field.cjs RJTT
import { buildOsmAirport } from '@/lib/osmAirport'; import { SimEngine } from '@/lib/sim/engine'; import { setSeed } from '@/lib/sim/rng'; import fs from 'node:fs'
for (const ic of process.argv.slice(2)) {
  setSeed(1); const a = buildOsmAirport(ic, JSON.parse(fs.readFileSync(`public/maps/osm/${ic}.geojson`, 'utf8')), { quiet: true }); const e = new SimEngine(a)
  const r = (v: number) => +v.toFixed(6), taxi: number[][] = [], seen = new Set<string>()
  for (const [id, n] of e.air.nodes) for (const q of n.edges) {
    if (q.type !== 'taxiway' || q.leadIn) continue; const k = id < q.to ? `${id}|${q.to}` : `${q.to}|${id}`; if (seen.has(k)) continue; seen.add(k)
    const m = e.air.nodes.get(q.to); if (m) taxi.push([r(n.lng), r(n.lat), r(m.lng), r(m.lat)])
  }
  const stands = e.air.stands.map((s) => ({ ref: s.ref, lng: r(s.lng), lat: r(s.lat), hdg: Math.round(s.headingIn), size: s.size, type: s.type, lead: s.leadInPts.map((p) => [r(p.lng), r(p.lat)]) }))
  fs.writeFileSync(`.tmp/field-${ic}.json`, JSON.stringify({ stands, taxi })); console.log(ic, stands.length, 'stands', taxi.length, 'taxi edges')
}
