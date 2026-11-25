/*
  The phone build's view of src/lib/sim/naming.ts (the engine's import is pointed here by build.mjs): everything is the
  real module, except that makeNameBook() returns the book baked ahead of time (bake-airport.mjs) when the app provided
  one. Making Paris's takes ~1 s in V8 and ~10 s in QuickJS. A book that does not fit the airport in hand is not used.
*/
import * as real from '../../src/lib/sim/naming'
import type { NameBook } from '../../src/lib/sim/naming'
import type { OsmAirport, OsmEdge } from '../../src/lib/osmAirport'
import { provided } from './shims'

export * from '../../src/lib/sim/naming'

type Pairs = Array<[string, string]>
interface Baked { nodes: number; lines: number; stands: string; edges: Array<[string, number, string, string]>; maps: Pairs[]; names: string[][]; at: Array<Array<[string, string[]]>> }
const standsOf = (air: OsmAirport): string => (air.stands ?? []).map((s) => s.ref).join(',')
const linesOf = (air: OsmAirport): number => { let n = 0; for (const x of air.nodes.values()) n += x.edges.length; return n }

export const keep: { on: boolean; json: string | null } = { on: false, json: null }

function write(air: OsmAirport, b: NameBook): string | null {
  const where = new Map<OsmEdge, [string, number]>()
  for (const [id, n] of air.nodes) n.edges.forEach((e, k) => where.set(e, [id, k]))
  const edges: Baked['edges'] = []
  for (const x of b.edges) { const w = where.get(x.e); if (!w) return null; edges.push([w[0], w[1], x.real, x.simple]) }
  const out: Baked = {
    nodes: air.nodes.size, lines: linesOf(air), stands: standsOf(air), edges,
    maps: [b.twyToSimple, b.twyToReal, b.standToSimple, b.standToReal].map((m) => [...m]), names: [b.realNames, b.simpleNames], at: [b.realNodes, b.simpleNodes].map((m) => [...m]),
  }
  return JSON.stringify(out)
}

export function makeNameBook(air: OsmAirport, opts: { extra?: boolean } = {}): NameBook {
  const text = opts.extra === false || keep.on ? undefined : provided.get(`/maps/baked/${air.icao.toUpperCase()}.names.json`)
  if (text) {
    const j = JSON.parse(text) as Baked
    if (j.nodes === air.nodes.size && j.lines === linesOf(air) && j.stands === standsOf(air)) {
      const edges = j.edges.map(([id, k, realName, simple]) => ({ e: air.nodes.get(id)?.edges[k] as OsmEdge, real: realName, simple }))
      if (edges.every((x) => x.e && (x.e.taxiway ?? '') === x.real)) {
        const [a, b, c, d] = j.maps.map((m) => new Map(m)), [rn, sn] = j.at.map((m) => new Map(m))
        return { edges, twyToSimple: a, twyToReal: b, standToSimple: c, standToReal: d, realNames: j.names[0], simpleNames: j.names[1], realNodes: rn, simpleNodes: sn }
      }
    }
  }
  const book = real.makeNameBook(air, opts)
  if (keep.on) keep.json = write(air, book)
  return book
}
