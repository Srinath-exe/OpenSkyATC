/*
  The phone build's view of src/lib/sim/taxiLimits.ts (the sim's imports are pointed here by build.mjs): everything is
  the real module, except that taxiLimitsOf() fills the limits in from the ones baked ahead of time (bake-airport.mjs)
  when the app provided them. Measuring every taxi line against every building and parked tail is seconds in QuickJS.
  Limits that do not fit the airport in hand are not used.
*/
import * as real from '../../src/lib/sim/taxiLimits'
import type { TaxiLimits } from '../../src/lib/sim/taxiLimits'
import type { OsmAirport } from '../../src/lib/osmAirport'
import { provided } from './shims'

export * from '../../src/lib/sim/taxiLimits'

type Inside = { air: OsmAirport; span: Map<string, number>; tails: Map<string, number>; turns: unknown[]; realName: unknown }
type Edges = Array<[number, number, number]>           // from node, to node (their places in the graph), metres
interface Baked { nodes: number; lines: number; stands: string; span: Edges; tails: Edges; turns: unknown[] }
const FIELDS = 'air,realName,span,tails,turns'
const standsOf = (air: OsmAirport): string => (air.stands ?? []).map((s) => s.ref).join(',')
const linesOf = (air: OsmAirport): number => { let n = 0; for (const x of air.nodes.values()) n += x.edges.length; return n }

export const keep: { on: boolean; json: string | null } = { on: false, json: null }

function write(air: OsmAirport, l: TaxiLimits): string | null {
  const i = l as unknown as Inside
  if (Object.keys(i).sort().join() !== FIELDS) return null     // the real class holds something new: it has to be baked too
  const at = new Map([...air.nodes.keys()].map((id, k) => [id, k]))
  const edges = (m: Map<string, number>): Edges => [...m].map(([k, v]) => { const [a, b] = k.split('>'); return [at.get(a)!, at.get(b)!, v] })
  const out: Baked = { nodes: air.nodes.size, lines: linesOf(air), stands: standsOf(air), span: edges(i.span), tails: edges(i.tails), turns: i.turns }
  return [...out.span, ...out.tails].some(([a, b]) => a == null || b == null) ? null : JSON.stringify(out)
}

const CACHE = new WeakMap<object, TaxiLimits>()
export function taxiLimitsOf(air: OsmAirport): TaxiLimits {
  const had = CACHE.get(air); if (had) return had
  let l: TaxiLimits | null = null
  const text = keep.on ? undefined : provided.get(`/maps/baked/${air.icao.toUpperCase()}.limits.json`)
  if (text) {
    const j = JSON.parse(text) as Baked
    if (j.nodes === air.nodes.size && j.lines === linesOf(air) && j.stands === standsOf(air)) {
      const ids = [...air.nodes.keys()], map = (es: Edges) => new Map(es.map(([a, b, v]) => [`${ids[a]}>${ids[b]}`, v]))
      const i: Inside = { air, span: map(j.span), tails: map(j.tails), turns: j.turns, realName: null }
      l = Object.assign(Object.create(real.TaxiLimits.prototype) as object, i) as unknown as TaxiLimits
    }
  }
  l = l ?? real.taxiLimitsOf(air)
  if (keep.on) keep.json = write(air, l)
  CACHE.set(air, l)
  return l
}
