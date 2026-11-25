/*
  The phone build's view of src/lib/osmAirport.ts (the store's import is pointed here by build.mjs): everything is the
  real module, except that buildOsmAirport() returns the airport baked ahead of time when the app provided one
  (ATC.provide('/maps/baked/KSFO.json', ...)). Building SFO's graph from OSM takes ~1 s in V8 and ~15 s in QuickJS on
  a phone; the result is the same data either way (bake-airport.ts writes it with the real builder, and
  test/core_quickjs_test.dart checks a baked boot against an unbaked one).
*/
import * as real from '../../src/lib/osmAirport'
import type { OsmAirport, OsmHoldingPosition } from '../../src/lib/osmAirport'
import { provided } from './shims'

export * from '../../src/lib/osmAirport'

type Built = Omit<OsmAirport, 'nodes' | 'holdByNode' | 'taxiwayNodes'> & { nodes: Array<[string, unknown]>; taxiwayNodes: Array<[string, string[]]>; bakedMagVar: number | null }

export function serialize(a: OsmAirport, magVarDeg: number | null): string {
  const { holdByNode: _h, ...rest } = a
  return JSON.stringify({ ...rest, nodes: [...a.nodes.entries()], taxiwayNodes: [...a.taxiwayNodes.entries()], bakedMagVar: magVarDeg })
}

export function revive(json: string): { air: OsmAirport; magVar: number | null } {
  const b = JSON.parse(json) as Built
  const holdingPositions = b.holdingPositions as OsmHoldingPosition[]
  const { bakedMagVar, ...rest } = b
  const air = { ...rest, nodes: new Map(b.nodes), holdByNode: new Map(holdingPositions.map((h) => [h.nodeId, h])), taxiwayNodes: new Map(b.taxiwayNodes) } as unknown as OsmAirport
  return { air, magVar: bakedMagVar }
}

export function buildOsmAirport(icao: string, fc: unknown, opts: Parameters<typeof real.buildOsmAirport>[2] = {}): OsmAirport {
  const baked = provided.get(`/maps/baked/${icao.toUpperCase()}.json`)
  if (baked) {
    const r = revive(baked)
    // only when it was baked with the same magnetic variation the store asks for now
    if ((r.magVar ?? null) === ((opts as { magVarDeg?: number } | undefined)?.magVarDeg ?? null)) return r.air
  }
  const air = real.buildOsmAirport(icao, fc as never, opts)
  // (written out here, before the engine sees it: the engine drops stands from this object and renames it in place)
  if (keep.on) keep.json = serialize(air, (opts as { magVarDeg?: number } | undefined)?.magVarDeg ?? null)
  return air
}
/** Baking (bake-airport.mjs): the airport as built, kept as text. */
export const keep: { on: boolean; json: string | null } = { on: false, json: null }
