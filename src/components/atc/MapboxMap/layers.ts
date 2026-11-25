/*
  The airport and the traffic on a Mapbox Standard map: airport surfaces from Mapbox Streets (OSM aeroways), the game's
  own airport data as GeoJSON (taxiway centrelines and letters, stands, runway labels, holding points), and the sim's
  aircraft as the textured fleet in a three.js custom layer that shares Mapbox's GL context and depth buffer.
  Used by the game (MapboxMap.tsx) and the lab (/lab/airport).
*/
import mapboxgl from 'mapbox-gl'
import * as THREE from 'three'
import type * as GeoJSON from 'geojson'
import { sim } from '@/components/atc/simStore'
import { getPerformance } from '@/lib/sim/aircraftDB'
import { GROUND_PLANS, buildGroundPlan, loadGroundPlan } from './groundPlan'
import { parkedDrawer, type ParkedFx } from './parked'
import { instantiate, litAs, loadAircraftModel, setGear, setModelNight, tint } from '@/components/atc/WorldMap/models'
import type { XY } from '@/lib/sim/projection'
import { beaconOn, dressCabin, isCargo, lightsForPhase, strobeOn, type LightPlan } from '@/components/atc/aircraftLights'
import { buildGse, buildJetBridges, buildStands } from '@/components/atc/WorldMap/apron'
import { buildAirport } from '@/components/atc/WorldMap/airfield'
import { viewPose } from '@/components/atc/viewPose'
import { GRASS_BODY, GRASS_DECL, ground, loadGround } from '@/components/atc/WorldMap/groundTex'
import { PALETTE, grassTexture, refreshSurfaceNight, setSurfaceNight, type Fade, type NightHandle } from '@/components/atc/WorldMap/terrain'
import { worldUrl } from '@/components/atc/WorldMap/worldList'
import type { World } from '@/components/atc/WorldMap/world'

export type Light = 'dawn' | 'day' | 'dusk' | 'night'
type Engine = NonNullable<typeof sim.engine>
export interface AirData { air: Engine['air']; proj: Engine['proj'] }
const FT = 0.3048
import { getHighlightStyle } from './highlight'
const FONT_B = ['DIN Pro Bold', 'Arial Unicode MS Bold']
const FONT_M = ['DIN Pro Medium', 'Arial Unicode MS Regular']
/** A width in metres at the airport's latitude, as a zoom expression (line-width is in pixels). */
export const metres = (m: number) => ['interpolate', ['exponential', 2], ['zoom'], 10, m / (124000 / 1024), 22, m / (124000 / 4194304)] as unknown as number
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features })
export const EMPTY = fc([])

/** Where a taxiway's name stands: on every exit just off the runway (the name to call), and about every 350 m along a taxiway,
 *  in the clear between two crossings rather than on one. */
export function taxiLabels(air: AirData['air']): { name: string; at: [number, number]; near: number }[] {
  const kx = 111320 * Math.cos((air.center.lat * Math.PI) / 180), ky = 111320, out: { name: string; at: [number, number]; near: number }[] = []
  const P = (id: string): [number, number] => { const n = air.nodes.get(id)!; return [n.lng * kx, n.lat * ky] }
  const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const edges = new Map<string, [string, string][]>(), seen = new Set<string>(), mix = new Map<string, Set<string>>(), rwy = new Set<string>()
  for (const [id, n] of air.nodes) for (const e of n.edges) {
    if (e.type === 'runway') { rwy.add(id); continue }
    if (e.leadIn || !air.nodes.has(e.to)) continue
    const s = mix.get(id) ?? new Set<string>(); s.add(e.taxiway ?? '?' + (id < e.to ? id + e.to : e.to + id)); mix.set(id, s)
    const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`; if (seen.has(key) || !e.taxiway) continue; seen.add(key)
    edges.set(e.taxiway, [...(edges.get(e.taxiway) ?? []), [id, e.to]])
  }
  for (const [name, list] of edges) {
    const pts: { p: [number, number]; a: string; clear: number }[] = [], cross = [...new Set(list.flat())].filter((id) => (mix.get(id)?.size ?? 0) > 1 || rwy.has(id)).map(P)
    for (const [a, b] of list) { const A = P(a), B = P(b), L = d(A, B), n = Math.max(1, Math.round(L / 20)); for (let i = 0; i < n; i++) { const t = (i + 0.5) / n, p: [number, number] = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]; let c = 120; for (const x of cross) c = Math.min(c, d(x, p)); pts.push({ p, a, clear: c }) } }
    const put: [number, number][] = [], add = (p: [number, number], near: number) => { put.push(p); out.push({ name, at: [p[0] / kx, p[1] / ky], near }) }
    // off each runway it leaves: 70 to 150 m out, where it stands clear
    for (const r of [...new Set(list.flat())].filter((id) => rwy.has(id)).map(P)) {
      const o = pts.filter((q) => { const m = d(q.p, r); return m > 70 && m < 150 && !put.some((x) => d(x, q.p) < 170) }).sort((x, y) => Math.abs(d(x.p, r) - 105) - x.clear * 0.6 - (Math.abs(d(y.p, r) - 105) - y.clear * 0.6))[0]
      if (o) add(o.p, 1)
    }
    for (const q of pts.sort((x, y) => Math.min(60, y.clear) - Math.min(60, x.clear))) if (!put.some((x) => d(x, q.p) < (q.clear > 25 ? 340 : 420))) add(q.p, 0)
    if (!put.length && pts.length) add(pts[0].p, 0)
  }
  return out
}
/** The game's airport as GeoJSON: taxiway centrelines (named), lead-ins, stand stop points, runway labels and holds. */
export function airportGeo({ air }: AirData) {
  const taxi: GeoJSON.Feature[] = [], lead: GeoJSON.Feature[] = [], stands: GeoJSON.Feature[] = [], rwyLabels: GeoJSON.Feature[] = [], holds: GeoJSON.Feature[] = [], twyLabels: GeoJSON.Feature[] = [], rwyLines: GeoJSON.Feature[] = []
  const seen = new Set<string>()
  for (const [id, n] of air.nodes) {
    for (const e of n.edges) {
      const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`
      if (seen.has(key)) continue; seen.add(key)
      const m = air.nodes.get(e.to); if (!m || e.type === 'runway') continue
      const f: GeoJSON.Feature = { type: 'Feature', properties: { name: e.taxiway ?? '' }, geometry: { type: 'LineString', coordinates: [[n.lng, n.lat], [m.lng, m.lat]] } }
      if (e.leadIn) lead.push(f); else taxi.push(f)
    }
  }
  for (const l of taxiLabels(air)) twyLabels.push({ type: 'Feature', properties: { name: l.name, near: l.near }, geometry: { type: 'Point', coordinates: l.at } })
  for (const st of air.stands) stands.push({ type: 'Feature', properties: { ref: st.ref }, geometry: { type: 'Point', coordinates: [st.lng, st.lat] } })
  for (const r of air.runways) {
    for (const e of r.ends) rwyLabels.push({ type: 'Feature', properties: { name: e.name }, geometry: { type: 'Point', coordinates: [e.lng, e.lat] } })
    const [a, b] = r.ends; rwyLines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } })
  }
  for (const h of air.holdingPositions) { const n = air.nodes.get(h.nodeId); if (n) holds.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [n.lng, n.lat] } }) }
  return { taxi: fc(taxi), lead: fc(lead), stands: fc(stands), rwyLabels: fc(rwyLabels), holds: fc(holds), twyLabels: fc(twyLabels), rwyc: fc(rwyLines) }
}

type L = mapboxgl.AnyLayer
/** Airport surfaces and the game's airport overlays (call once the style has loaded). */
export function addAirportLayers(map: mapboxgl.Map, air: AirData, opts: { classicGround?: boolean } = {}): void {
  for (const [id, data] of Object.entries(airportGeo(air))) map.addSource(`ap-${id}`, { type: 'geojson', data })
  if (!opts.classicGround) addMapboxSurfaces(map)
  // zoomed out, the painted centrelines are thinner than a pixel: the taxiways as fine lines, so a route can be read and given
  else map.addLayer({ id: 'ap-taxi-far', type: 'line', source: 'ap-taxi', slot: 'middle', maxzoom: 15.6, paint: { 'line-color': '#f2c230', 'line-width': ['interpolate', ['linear'], ['zoom'], 12.5, 1.4, 14.5, 1.6], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 14.6, 0.85, 15.6, 0], 'line-emissive-strength': 1 } } as L)
  // Standard's own 3D buildings and terminal model are on; zoomed out, ours stand in (its plain buildings start at zoom 15): its SFO terminal model loads from
  // about zoom 14.5 but blanks the buildings under it from 14, so the terminal vanished in between
  if (!map.getSource('ap-bldg')) map.addSource('ap-bldg', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' })
  map.addLayer({ id: 'ap-buildings', type: 'fill-extrusion', source: 'ap-bldg', 'source-layer': 'building', maxzoom: 15, filter: ['==', ['get', 'extrude'], 'true'], paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['measure-light', 'brightness'], 0.12, '#8a8f9a', 0.4, '#c3c5ca'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'min_height'], 'fill-extrusion-opacity': 0.97, 'fill-extrusion-emissive-strength': ['interpolate', ['linear'], ['measure-light', 'brightness'], 0.12, 0.3, 0.4, 0], 'fill-extrusion-ambient-occlusion-intensity': 0.3, 'fill-extrusion-vertical-gradient': true } } as unknown as L)
  map.addLayer({ id: 'ap-twy', type: 'symbol', source: 'ap-twyLabels', slot: 'top', minzoom: 12, layout: { 'text-field': ['get', 'name'], 'symbol-sort-key': ['-', 0, ['get', 'near']], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12, 18, 13.5], 'text-font': FONT_B, 'text-padding': 4 }, paint: { 'text-color': '#151515', 'text-halo-color': '#f2c230', 'text-halo-width': 2.2, 'text-emissive-strength': 1 } } as L)
  // stand names from afar; close in the painted name on the ground reads, and a chip would sit on the parked aircraft
  map.addLayer({ id: 'ap-stands', type: 'symbol', source: 'ap-stands', slot: 'top', minzoom: 15.2, maxzoom: 16.8, layout: { 'text-field': ['get', 'ref'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15.2, 9, 18, 13], 'text-font': FONT_B, 'text-padding': 2, 'text-offset': [0, -1.2] }, paint: { 'text-color': '#1a1200', 'text-halo-color': '#f6b632', 'text-halo-width': 3, 'text-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'ap-rwy', type: 'symbol', source: 'ap-rwyLabels', slot: 'top', layout: { 'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 17, 18], 'text-font': FONT_B, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#111', 'text-halo-width': 2, 'text-emissive-strength': 1 } } as L)
}

/** The names again on a map that is up. */
export function relabel(map: mapboxgl.Map, air: AirData): void {
  const g = airportGeo(air)
  for (const id of ['taxi', 'stands', 'twyLabels'] as const) (map.getSource(`ap-${id}`) as mapboxgl.GeoJSONSource | undefined)?.setData(g[id])
}
/** Mapbox Streets aeroways as flat colour, the game's centrelines and holds: the look when the classic ground is off. */
function addMapboxSurfaces(map: mapboxgl.Map): void {
  map.addSource('ap-streets', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' })
  const surf = (id: string, kind: string, color: string, geom: 'Polygon' | 'LineString', width = 0) => map.addLayer((geom === 'Polygon'
    ? { id, type: 'fill', source: 'ap-streets', 'source-layer': 'aeroway', slot: 'bottom', filter: ['all', ['==', ['get', 'type'], kind], ['==', ['geometry-type'], 'Polygon']], paint: { 'fill-color': color, 'fill-emissive-strength': 0.35 } }
    : { id, type: 'line', source: 'ap-streets', 'source-layer': 'aeroway', slot: 'bottom', filter: ['all', ['==', ['get', 'type'], kind], ['==', ['geometry-type'], 'LineString']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': metres(width), 'line-emissive-strength': 0.35 } }) as L)
  surf('ap-apron', 'apron', '#d9d6d0', 'Polygon')
  surf('ap-twy-poly', 'taxiway', '#3b3d42', 'Polygon')
  surf('ap-twy-line', 'taxiway', '#3b3d42', 'LineString', 23)
  surf('ap-rwy-poly', 'runway', '#2c2e32', 'Polygon')
  surf('ap-rwy-line', 'runway', '#2c2e32', 'LineString', 60)
  map.addLayer({ id: 'ap-rwy-centre', type: 'line', source: 'ap-rwyc', slot: 'bottom', minzoom: 14, paint: { 'line-color': '#f4f4f4', 'line-width': metres(0.9), 'line-dasharray': [12, 8], 'line-emissive-strength': 0.6 } } as L)
  map.addLayer({ id: 'ap-rwy-edge', type: 'line', source: 'ap-rwyc', slot: 'bottom', minzoom: 14, paint: { 'line-color': '#f4f4f4', 'line-width': metres(1), 'line-gap-width': metres(44), 'line-emissive-strength': 0.6 } } as L)
  map.addLayer({ id: 'ap-taxi', type: 'line', source: 'ap-taxi', slot: 'middle', paint: { 'line-color': '#f2c230', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 0.6, 18, 3.2], 'line-opacity': 0.95, 'line-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'ap-lead', type: 'line', source: 'ap-lead', slot: 'middle', minzoom: 15, paint: { 'line-color': '#f2c230', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 15, 0.4, 18, 1.8], 'line-opacity': 0.8, 'line-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'ap-holds', type: 'circle', source: 'ap-holds', slot: 'middle', minzoom: 16, paint: { 'circle-color': '#e8443a', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 4], 'circle-emissive-strength': 1 } } as L)
}

/** Overlays the game drives: selected route, selection / hover rings, tutorial routes and marks, data blocks. */
export function addGameLayers(map: mapboxgl.Map): void {
  for (const id of ['g-route', 'g-rings', 'g-tutor-route', 'g-tutor-mark', 'g-blocks', 'g-stand']) map.addSource(id, { type: 'geojson', data: EMPTY })
  // ground routes by destination: cyan to a runway, magenta to a stand, white for a pushback (none of them reads as the
  // yellow taxiway paint); the selected aircraft's route bright and wide, the rest thinner and quieter
  const ROUTE_COLOR = ['match', ['get', 'kind'], 'stand', '#ff4fd2', 'push', '#f2f4f7', '#22d6ff'] as unknown as string
  const sel = (on: number, off: number) => ['case', ['==', ['get', 'sel'], 1], on, off] as unknown as number
  map.addLayer({ id: 'g-route-glow', type: 'line', source: 'g-route', slot: 'top', filter: ['==', ['get', 'sel'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE_COLOR, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 3, 18, 14], 'line-opacity': 0.3, 'line-blur': 2, 'line-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'g-route', type: 'line', source: 'g-route', slot: 'top', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sel'] }, paint: { 'line-color': ROUTE_COLOR, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, sel(1.6, 0.9), 18, sel(5, 2.6)], 'line-opacity': sel(1, 0.6), 'line-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'g-tutor-route', type: 'line', source: 'g-tutor-route', slot: 'top', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], '#3bea7a'], 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 2.5, 18, 9], 'line-opacity': 0.9, 'line-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'g-rings', type: 'circle', source: 'g-rings', slot: 'top', paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 13, 8, 18, 46], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2, 'circle-stroke-color': ['match', ['get', 'kind'], 'sel', '#ff8a1f', 'rgba(255,255,255,0.75)'], 'circle-pitch-alignment': 'map', 'circle-emissive-strength': 1 } } as L)
  // the selected arrival's stand: a magenta ring and its name (the route to it is magenta too)
  map.addLayer({ id: 'g-stand', type: 'circle', source: 'g-stand', slot: 'top', paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 13, 8, 18, 40], 'circle-color': 'rgba(255,79,210,0.16)', 'circle-stroke-width': 3, 'circle-stroke-color': '#ff4fd2', 'circle-pitch-alignment': 'map', 'circle-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'g-stand-label', type: 'symbol', source: 'g-stand', slot: 'top', layout: { 'text-field': ['get', 'label'], 'text-font': FONT_B, 'text-size': 13, 'text-offset': [0, -2.4], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffd6f4', 'text-halo-color': 'rgba(10,14,22,0.92)', 'text-halo-width': 4, 'text-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'g-tutor-mark', type: 'circle', source: 'g-tutor-mark', slot: 'top', paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 13, 7, 18, 30], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3, 'circle-stroke-color': ['match', ['get', 'tone'], 'stop', '#ff4a3a', 'go', '#3bea7a', '#ffffff'], 'circle-pitch-alignment': 'map', 'circle-emissive-strength': 1 } } as L)
  map.addLayer({ id: 'g-tutor-label', type: 'symbol', source: 'g-tutor-mark', slot: 'top', layout: { 'text-field': ['get', 'label'], 'text-font': FONT_B, 'text-size': 13, 'text-offset': [0, -2.2], 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,14,22,0.92)', 'text-halo-width': 4, 'text-emissive-strength': 1 } } as L)
  const block = (id: string, filter: unknown[], overlap: boolean) => map.addLayer({ id, type: 'symbol', source: 'g-blocks', slot: 'top', filter, layout: { 'text-field': ['get', 'text'], 'text-font': FONT_M, 'text-size': 11, 'text-anchor': 'left', 'text-justify': 'left', 'text-offset': [1.4, -1.1], 'text-allow-overlap': overlap, 'text-ignore-placement': overlap, 'text-padding': 2, 'symbol-sort-key': ['get', 'rank'] }, paint: { 'text-color': ['match', ['get', 'state'], 'sel', '#ffb15c', 'ghost', 'rgba(255,255,255,0.6)', '#ffffff'], 'text-halo-color': 'rgba(10,14,22,0.92)', 'text-halo-width': 4, 'text-emissive-strength': 1 } } as L)
  block('g-blocks', ['!', ['get', 'force']], false)
  block('g-blocks-top', ['get', 'force'], true)   // the selected / hovered aircraft's block always shows
  // lit routes go under the airport's own letters (taxiway names, runway numbers, stands), so the names stay readable
  const under = ['ap-twy', 'ap-stands', 'ap-rwy'].find((id) => map.getLayer(id))
  if (under) for (const id of ['g-route-glow', 'g-route', 'g-tutor-route']) { try { map.moveLayer(id, under) } catch { /* other slot */ } }
}

/* ── aircraft: a three.js layer in Mapbox's GL context ──
   The scene is in metres around the sim's reference point (x east, y up, z south); the layer's matrix places it in
   Mercator space (rotate y-up to z-up, scale metres to Mercator units, flip north). */
export interface TrafficLayer { stats: { frames: number; ms: number; js: number; calls: number; tris: number; models: number }; layer: mapboxgl.CustomLayerInterface; setLight(l: Light): void; setFps(fps: number): void; kick(): void; /** The stands' names have changed: their numbers on the ground again. */ rename(): void; /** Hidden behind the radar: no frames until shown again. */ setHidden(on: boolean): void; dispose(): void }
/** Redraw budget: the map redraws only while something moves (the sim running, the camera, a follow), at most `fps`. */
/** Traffic from somewhere other than the live sim (the landing film's script): the same fields the layer reads off the engine. */
export interface TrafficSource { aircraft: Array<{ id: number; callsign: string; phase: string; pos: XY; altitude: number; heading: number; pitch?: number; bank?: number; speed?: number; plan?: { kind?: string }; path?: { pts: XY[]; cum: number[]; total: number; kind: string; holdAt?: number } | null; distAlong?: number; perf: { icaoCode: string; lengthMeters: number; wingspanMeters?: number } }>; parked: Array<{ id: number; callsign: string; type: string; pos: XY; heading: number }>; groundLights?: Array<{ pos: XY; color: [number, number, number] }> }
export function trafficLayer(air: AirData, opts: { parked?: boolean; fps?: number; classicGround?: boolean; textures?: boolean; modelPx?: number; source?: () => TrafficSource; pxScale?: number; /** The map is drawn this many times larger and scaled down (the airport review): its zoom is that much too high. */ over?: number; /** The parked aircraft drawn the saving way (parked.ts), with these savings on. */ parkedFx?: () => ParkedFx } = {}): TrafficLayer {
  const zoomOff = Math.log2(opts.over ?? 1)
  // light points are sized in canvas pixels: the film's recorder draws at pixel ratio > 1 and scales them to match
  const pxScale = opts.pxScale ?? 1
  const modelPx = opts.modelPx ?? 34
  let fps = opts.fps ?? 30, lastDraw = 0, timer = 0, hiddenNow = false
  const stats = { frames: 0, ms: 0, js: 0, calls: 0, tris: 0, models: 0 }
  if (typeof window !== 'undefined') (window as unknown as { __mbxStats?: unknown }).__mbxStats = stats
  let renderer: THREE.WebGLRenderer | null = null, map: mapboxgl.Map | null = null
  const scene = new THREE.Scene(), camera = new THREE.Camera()
  const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x5a5f66, 1.7); scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-300, 600, 400); scene.add(sun)
  // the gates: the classic map's jet bridges and ground vehicles, built from the same stands and terminal outlines in
  // the same frame (they only need the airport's projection; SFO's apron is at sea level, so the base is 0)
  const world = { toLocal: (lng: number, lat: number) => air.proj.toXY(lat, lng), heightAt: () => 0 } as unknown as World
  const fixtures: THREE.Object3D[] = [], fixturesNear: THREE.Object3D[] = []
  try { const jb = buildJetBridges(world, air.air, 0); if (jb) { fixtures.push(jb); fixturesNear.push(jb) } const gse = buildGse(world, air.air, 0); if (gse) { fixtures.push(gse); fixturesNear.push(gse) } } catch (err) { console.warn('gates not built', err) }
  const nightHandles: NightHandle[] = [], fieldLights: Array<{ value: number }> = [], fieldVP: Array<{ value: THREE.Vector2 }> = [], fieldMinPx: Array<{ value: number }> = []
  const groundParts: THREE.Object3D[] = []; let gone = false, standsGroup: THREE.Group | null = null, standsBase = 0
  if (opts.classicGround) {
    try {
      const fades: Fade[] = []
      if (opts.textures !== false) loadGround(() => map?.triggerRepaint())
      const grass = grassField(air); scene.add(grass)
      const ap = buildAirport(world, air.air, fades, nightHandles, { allStrips: GROUND_PLANS.has(air.air.icao) }); scene.add(ap)
      const st = buildStands(world, air.air, (ap.userData.base as number) ?? 0, fades); scene.add(st)
      groundParts.push(grass, ap, st); standsGroup = st; standsBase = (ap.userData.base as number) ?? 0
      const pads = smoothPads(st, tidyGround(air)); flatGround(ap); flatGround(st)
      // an airport with its real ground (groundPlan.ts): its own grass, shore, landside and roads instead of the drawn outline
      if (GROUND_PLANS.has(air.air.icao)) {
        grass.visible = false
        void loadGroundPlan(air.air.icao).then((plan) => {
          grass.visible = true
          if (plan && !gone) {
            const g = buildGroundPlan(plan, air.proj); flatGround(g.flat); scene.add(g.flat, g.raised); groundParts.push(g.flat)
            const n = g.grass.getAttribute('position').count; g.grass.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(n), 1))
            grass.geometry.dispose(); grass.geometry = g.grass; grass.renderOrder = -1000 + 57 * 10; (grass.material as THREE.ShaderMaterial).uniforms.uLandOn = { value: 0 }   // the plan has the true shore
            if (pads) pads.visible = false
            const own = ap.getObjectByName('aprons'); if (own) own.visible = false      // (the plan's aprons: the mapped ones with their edges drawn straight)
            refreshSurfaceNight()
          }
          map?.triggerRepaint()
        })
      }
      ap.traverse((o) => { const u = ((o as THREE.Points).material as THREE.ShaderMaterial | undefined)?.uniforms; if (u?.uFar) fieldLights.push(u.uFar); if (u?.uVP) fieldVP.push(u.uVP); if (u?.uMinPx) fieldMinPx.push(u.uMinPx) })
      if (pxScale !== 1) for (const u of new Set(fieldMinPx)) u.value *= pxScale   // (materials may share one uniform)
    } catch (err) { console.warn('classic ground not built', err) }
  }
  for (const f of fixtures) scene.add(f)
  if (typeof window !== 'undefined') {
    const tris = (o: THREE.Object3D) => { let t = 0; o.traverse((x) => { const m = x as THREE.Mesh; const g = m.geometry; if (!g) return; t += (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / ((x as THREE.Points).isPoints ? 1 : 3) }); return Math.round(t) }
    ;(window as unknown as { __mbxParts?: unknown }).__mbxParts = () => scene.children.filter((c) => c.type !== 'HemisphereLight' && c.type !== 'DirectionalLight').map((c) => `${c.name || c.type}:${tris(c)}`)
  }
  // far aircraft: one instanced silhouette (a few dozen triangles each, one draw call for all of them); the textured
  // model only once the aircraft is `modelPx` long on screen
  const SIL_MAX = 600
  const sil = new THREE.InstancedMesh(silhouetteGeometry(), new THREE.MeshLambertMaterial({ color: 0xf1f2f4 }), SIL_MAX)
  sil.instanceMatrix.setUsage(THREE.DynamicDrawUsage); sil.frustumCulled = false; sil.count = 0; scene.add(sil)
  const parkedFx = opts.parkedFx, stood = parkedFx ? parkedDrawer(scene, modelPx, () => map?.triggerRepaint()) : null
  const silM = new THREE.Matrix4(), silQ = new THREE.Quaternion(), silE = new THREE.Euler(0, 0, 0, 'YXZ'), silP = new THREE.Vector3(), silS = new THREE.Vector3()
  const origin = mapboxgl.MercatorCoordinate.fromLngLat([air.proj.refLng, air.proj.refLat], 0)
  const k = origin.meterInMercatorCoordinateUnits()
  const base = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new THREE.Vector3(k, -k, k)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
  const models = new Map<string, { obj: THREE.Group | null; tinted: string; sig: string }>()
  // night lights: nav (red / green / white tail), red beacon, white strobes, as pixel-size points that read at any zoom
  const lightGeo = new THREE.BufferGeometry(); const MAXL = 400 * 5
  lightGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXL * 3), 3)); lightGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXL * 3), 3))
  // round glows (a core and a soft halo), sized in pixels by the zoom: ~1 m fittings read as small points far out and
  // grow as the camera closes in (fixed 8 px squares swamped the aircraft when zoomed out)
  const lightMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPx: { value: 4 }, uA: { value: 0 } },
    vertexShader: 'attribute vec3 color; uniform float uPx; varying vec3 vC; void main() { vC = color; gl_PointSize = uPx; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uA; varying vec3 vC; void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; float core = 1.0 - smoothstep(0.15, 0.45, r), halo = 1.0 - smoothstep(0.3, 1.0, r); gl_FragColor = vec4(vC * (1.5 * core + 0.45 * halo) * uA, 1.0); }' })
  const lights = new THREE.Points(lightGeo, lightMat)
  lights.frustumCulled = false; scene.add(lights)   // which are on: lightsForPhase (aircraftLights.ts, airline SOP)
  // the source's ground lights (the film's greens): their own points, kept big enough to read as a line from high up
  const MAXG = 1200, gGeo = new THREE.BufferGeometry()
  gGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXG * 3), 3)); gGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXG * 3), 3))
  const gMat = lightMat.clone(); const gPts = new THREE.Points(gGeo, gMat); gPts.frustumCulled = false; scene.add(gPts)
  let night = 0
  const place = (o: THREE.Object3D, x: number, y: number, altM: number, hdg: number, pitch = 0, bank = 0) => {
    o.position.set(x, altM, -y); o.rotation.order = 'YXZ'; o.rotation.set(pitch * Math.PI / 180, -hdg * Math.PI / 180, -bank * Math.PI / 180)
  }
  const lv = new THREE.Vector3()
  const sel = new THREE.Color(0xff8a1f), hov = new THREE.Color(0x404040)
  // selection effects, unit-sized (scaled to the aircraft's length), one group placed on the selected aircraft each frame
  const ORANGE = 0xff8a1f
  const fxMat = (c: number, o: number, add = false) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending })
  const fx = new THREE.Group(); fx.visible = false; scene.add(fx)
  // ground routes as ribbons in this scene: drawn after the pavement and before the aircraft, so a route runs under the
  // aircraft driving it (a map line layer is either under all of this layer or over all of it, planes included)
  const MAXRV = 90000
  const routeGeo = new THREE.BufferGeometry()
  routeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXRV * 3), 3)); routeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXRV * 4), 4))
  const routeMesh = new THREE.Mesh(routeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide }))
  routeMesh.frustumCulled = false; routeMesh.renderOrder = -300; scene.add(routeMesh)
  const ROUTE_RGB: Record<string, [number, number, number]> = { runway: [0.13, 0.84, 1], stand: [1, 0.31, 0.82], push: [0.95, 0.96, 0.97] }
  const drawRoutes = (ac: TrafficSource['aircraft'], mpp: number) => {
    const P = routeGeo.getAttribute('position').array as Float32Array, C = routeGeo.getAttribute('color').array as Float32Array; let n = 0
    const strip = (pts: XY[], wM: number, rgb: [number, number, number], alpha: number) => {
      for (let i = 1; i < pts.length && n + 6 <= MAXRV; i++) {
        const a = pts[i - 1], b = pts[i]; const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); if (L < 0.01) continue
        // a little past each end, so the joins between short segments close up
        const ux = dx / L, uy = dy / L, ox = -uy * wM / 2, oy = ux * wM / 2, ex = ux * wM * 0.25, ey = uy * wM * 0.25
        const ax = a.x - ex, ay = a.y - ey, bx = b.x + ex, by = b.y + ey
        const q: Array<[number, number]> = [[ax + ox, ay + oy], [ax - ox, ay - oy], [bx + ox, by + oy], [bx + ox, by + oy], [ax - ox, ay - oy], [bx - ox, by - oy]]
        for (const [x, y] of q) { P[n * 3] = x; P[n * 3 + 1] = 0.6; P[n * 3 + 2] = -y; C[n * 4] = rgb[0]; C[n * 4 + 1] = rgb[1]; C[n * 4 + 2] = rgb[2]; C[n * 4 + 3] = alpha; n++ }
      }
    }
    for (const a of ac) {
      const p = a.path; if (!p || p.pts.length < 2 || (p.kind !== 'taxi' && p.kind !== 'pushback')) continue
      const done = Math.max(0, Math.min(p.total, a.distAlong ?? 0))
      // up to the next hold line it has not been cleared past: beyond a runway's hold the taxi path runs on to the runway
      // end's node (behind the entry), which drew as a hook pointing the wrong way down the runway
      const end = p.holdAt != null && p.holdAt > done + 1 ? p.holdAt : p.total
      if (end - done < 5) continue
      const at = (d: number) => { let j = 1; while (j < p.pts.length - 1 && p.cum[j] <= d) j++; const k = (d - p.cum[j - 1]) / ((p.cum[j] - p.cum[j - 1]) || 1); return { j, xy: { x: p.pts[j - 1].x + (p.pts[j].x - p.pts[j - 1].x) * k, y: p.pts[j - 1].y + (p.pts[j].y - p.pts[j - 1].y) * k } } }
      const s0 = at(done), s1 = at(end)
      const pts = [s0.xy, ...p.pts.slice(s0.j, s1.j), s1.xy]
      const rgb = ROUTE_RGB[p.kind === 'pushback' ? 'push' : a.plan?.kind === 'arrival' ? 'stand' : 'runway']
      const sel = a.id === sim.selectedId
      if (sel) strip(pts, Math.max(4, 11 * mpp), rgb, 0.22)                    // a soft glow under the selected one
      strip(pts, Math.max(sel ? 1.6 : 1, (sel ? 4 : 2.2) * mpp), rgb, sel ? 1 : 0.6)
    }
    routeGeo.setDrawRange(0, n); routeGeo.getAttribute('position').needsUpdate = true; routeGeo.getAttribute('color').needsUpdate = true
  }
  const flat = (m: THREE.Mesh) => { m.rotation.x = -Math.PI / 2; return m }
  const ringFx = new THREE.Group()
  const ringLine = flat(new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 96), fxMat(ORANGE, 0.95))); const ringFill = flat(new THREE.Mesh(new THREE.CircleGeometry(0.9, 96), fxMat(ORANGE, 0.1)))
  const ringPulse = flat(new THREE.Mesh(new THREE.RingGeometry(0.97, 1.0, 96), fxMat(ORANGE, 0.5)))
  ringFx.add(ringFill, ringLine, ringPulse)
  const glowTex = (() => { if (typeof document === 'undefined') return null; const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!; const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,170,80,0.95)'); r.addColorStop(0.35, 'rgba(255,138,31,0.55)'); r.addColorStop(1, 'rgba(255,138,31,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t })()
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })
  const glowFx = flat(new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), glowMat))
  const brFx = new THREE.Group()
  { const m = fxMat(0xffffff, 0.95); const arm = 0.28, w = 0.035
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const a = flat(new THREE.Mesh(new THREE.PlaneGeometry(arm, w), m)); a.position.set(sx * (0.62 - arm / 2), 0, sz * 0.62); brFx.add(a)
      const b2 = flat(new THREE.Mesh(new THREE.PlaneGeometry(w, arm), m)); b2.position.set(sx * 0.62, 0, sz * (0.62 - arm / 2)); brFx.add(b2)
    } }
  const pinFx = new THREE.Group()
  { const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 8), fxMat(ORANGE, 0.85)); beam.position.y = 0.75
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.11), fxMat(ORANGE, 1)); gem.position.y = 1.35; gem.name = 'gem'
    const foot = flat(new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), fxMat(ORANGE, 0.9)))
    pinFx.add(beam, gem, foot) }
  fx.add(ringFx, glowFx, brFx, pinFx)
  for (const o of [ringFx, glowFx, brFx, pinFx]) o.traverse((x) => { x.renderOrder = o === glowFx || o === ringFx ? -400 : 50 })
  const placeFx = (x: number, y: number, altM: number, hdg: number, len: number, t: number, mpp: number) => {
    const st = getHighlightStyle(); fx.visible = st !== 'tint' && st !== 'none'
    ringFx.visible = st === 'ring'; glowFx.visible = st === 'glow'; brFx.visible = st === 'brackets'; pinFx.visible = st === 'pin'
    fx.position.set(x, altM + 0.4, -y); fx.rotation.set(0, -hdg * Math.PI / 180, 0)
    const L = Math.max(Math.max(24, len) * 0.75, 30 * mpp); fx.scale.setScalar(L)   // never under ~30 px across: it shows when zoomed out
    const w = 0.5 + 0.5 * Math.sin(t * 2.6)                                   // a slow breath
    if (st === 'ring') { const k = (t * 0.7) % 1; ringPulse.scale.setScalar(1 + k * 0.45); (ringPulse.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k); (ringFill.material as THREE.MeshBasicMaterial).opacity = 0.08 + 0.05 * w }
    if (st === 'glow') { glowFx.scale.setScalar(0.92 + 0.12 * w); glowMat.opacity = 0.7 + 0.3 * w }
    if (st === 'brackets') brFx.scale.setScalar(1.02 + 0.05 * w)
    if (st === 'pin') { const gem = pinFx.getObjectByName('gem'); if (gem) { gem.position.y = 1.35 + 0.06 * w; gem.rotation.y = t * 1.5 } }
  }
  const layer = {
    id: 'g-aircraft', type: 'custom', renderingMode: '3d', slot: 'middle',
    onAdd(m: mapboxgl.Map, gl: WebGL2RenderingContext) {
      map = m
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true })
      renderer.autoClear = false; renderer.outputColorSpace = THREE.SRGBColorSpace
    },
    render(_gl: WebGL2RenderingContext, matrix: number[]) {
      const e = (opts.source ? opts.source() : sim.engine) as unknown as TrafficSource | null; if (!e || !renderer) return
      const tJs = performance.now()
      const live = new Set<string>()
      const pos = lightGeo.getAttribute('position').array as Float32Array, col = lightGeo.getAttribute('color').array as Float32Array; let nl = 0
      const t = performance.now() / 1000
      // what is worth drawing: the view's bounds (with a margin) and the zoom; a 40 m airliner is a few pixels below z13
      const zoom = map!.getZoom() - zoomOff; const b = map!.getBounds()!
      const padX = (b.getEast() - b.getWest()) * 0.15, padY = (b.getNorth() - b.getSouth()) * 0.15
      const W = b.getWest() - padX, E = b.getEast() + padX, S = b.getSouth() - padY, N = b.getNorth() + padY
      const inView = (x: number, y: number) => { const q = air.proj.toLngLat(x, y); return q.lng > W && q.lng < E && q.lat > S && q.lat < N }
      const modelsOn = zoom >= 12, parkedOn = zoom >= 12   // every aircraft at every zoom the lock allows (small on screen: its silhouette)
      const mpp = 40075016 * Math.cos(air.proj.refLat * Math.PI / 180) / (512 * 2 ** zoom)
      for (const f of fixturesNear) f.visible = zoom + zoomOff >= 14.6
      // zoomed out, the flat ground (a few cm up) loses the depth test against Mapbox's own ground in bands and the
      // field breaks into stripes: lift it by about a pixel's worth of metres (invisible at that range; none up close)
      const lift = mpp * 1.5 * Math.max(0, Math.min(1, 15.5 - zoom))
      for (const g of groundParts) if (g.position.y !== lift) { g.position.y = lift; g.updateMatrixWorld(true) }
      let ns = 0
      const put = (key: string, type: string, cs: string, len: number, span: number, x: number, y: number, altFt: number, hdg: number, pitch: number, bank: number, airborne: boolean, state: string, active: boolean, plan: LightPlan | null, id: number) => {
        live.add(key)
        const show = (state !== '' || (modelsOn && (active || parkedOn))) && inView(x, y)
        // numbers start again with a new shift: the model belongs to this flight, not to whoever had its number before
        const sig = `${type}|${cs}`, old = models.get(key)
        if (old && old.sig !== sig) { if (old.obj) scene.remove(old.obj); models.delete(key) }
        const have = models.get(key)
        if (!show) { if (have?.obj) have.obj.visible = false; return }
        // small on screen: a silhouette (the model is not even loaded); big enough: the textured model
        const far = state === '' && len / mpp < modelPx
        if (far || !have?.obj) {                                   // (its silhouette also stands in while the model is on its way)
          if (far && have?.obj) have.obj.visible = false
          if (ns < SIL_MAX) {
            silE.set(pitch * Math.PI / 180, -hdg * Math.PI / 180, -bank * Math.PI / 180); silQ.setFromEuler(silE)
            silP.set(x, altFt * FT, -y); silS.set(span, len, len)
            silM.compose(silP, silQ, silS); sil.setMatrixAt(ns++, silM)
          }
        }
        let r = far ? have : models.get(key)
        if (!r && !far) {
          const rec = { obj: null as THREE.Group | null, tinted: '', sig }; r = rec; models.set(key, rec)
          void loadAircraftModel(type, cs).then((tpl) => { if (models.get(key) !== rec) return; if (!tpl) { models.delete(key); return } rec.obj = instantiate(tpl, len, cs); scene.add(rec.obj); try { rec.obj.userData.cab = dressCabin(rec.obj, type, len, isCargo(type, cs)) } catch { /* no cabin light */ } })
        }
        if (r?.obj && !far) {
          r.obj.visible = true
          place(r.obj, x, y, altFt * FT, hdg, pitch, bank); setGear(r.obj, !airborne || altFt < 1500)
          const hlStyle = getHighlightStyle(); const tk = state === 'sel' ? `sel:${hlStyle}` : state
          if (tk !== r.tinted) { tint(r.obj, state === 'sel' && hlStyle === 'tint' ? sel : null); if (state === 'sel' && hlStyle === 'lit') litAs(r.obj, true); r.tinted = tk }   // (hover: no tint; the model stays as it is)
          ;(r.obj.userData.cab as { set: (l: number) => void } | undefined)?.set(Math.max(0, Math.min(1, (night - 0.05) / 0.4)) * (plan?.cabin ?? 0))
        }
        if (night > 0.05 && plan && nl < MAXL - 12) {
          // on the airframe, from the model's own fuselage (cabin: centreline height and radius, unit length; nose wheel
          // at the origin, tail at +0.88): wingtips 43 % aft at wing height, tail light on the tail cone, beacon on the roof
          const h = hdg * Math.PI / 180, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h), base = altFt * FT
          const cab = (r?.obj?.userData.cabin as { yc: number; r: number } | undefined) ?? { yc: 0.115, r: 0.052 }
          const add = (aft: number, side: number, up: number, c: [number, number, number]) => { pos.set([x - fx * aft * len + rx * side, base + up * len, -y - fz * aft * len + rz * side], nl * 3); col.set(c, nl * 3); nl++ }
          const tip = span / 2 * 0.98, wingY = cab.yc - cab.r * 0.55, root = cab.r * len * 1.5
          const ph = t + id * 0.37, st = plan.strobe && strobeOn(ph)
          // where they are on this very airframe (measured on the model: aircraftLights.ts, what the hangar shows); the
          // proportions below only until the model has loaded
          const spec = r?.obj && !far ? (r.obj.userData.cab as { spec?: Record<string, THREE.Vector3 | undefined> } | undefined)?.spec : undefined
          if (spec && r?.obj) {
            r.obj.updateMatrixWorld()
            const on = (k: string, c: [number, number, number]) => { const p = spec[k] ?? spec[k === 'turnL' ? 'landL' : k === 'turnR' ? 'landR' : k]; if (!p) return; lv.copy(p).applyMatrix4(r!.obj!.matrixWorld); pos.set([lv.x, lv.y, lv.z], nl * 3); col.set(c, nl * 3); nl++ }
            if (plan.nav || st) { on('tipL', st ? [1.6, 1.6, 1.6] : [1, 0.12, 0.1]); on('tipR', st ? [1.6, 1.6, 1.6] : [0.15, 1, 0.35]); on('tail', [1, 1, 1]) }
            if (plan.beacon && beaconOn(ph)) { on('beaconTop', [1, 0.12, 0.1]); on('beaconBot', [1, 0.12, 0.1]) }
            if (plan.landing) { on('landL', [2, 2, 1.9]); on('landR', [2, 2, 1.9]) }
            if (plan.takeoff || plan.taxi) on('nose', plan.takeoff ? [1.8, 1.8, 1.7] : [1.2, 1.2, 1.1])
            if (plan.takeoff) { on('turnL', [1.2, 1.2, 1.1]); on('turnR', [1.2, 1.2, 1.1]) }
          } else {
            if (plan.nav || st) {
              add(0.43, -tip, wingY, st ? [1.6, 1.6, 1.6] : [1, 0.12, 0.1]); add(0.43, tip, wingY, st ? [1.6, 1.6, 1.6] : [0.15, 1, 0.35])
              add(0.875, 0, cab.yc + cab.r * 0.2, [1, 1, 1])
            }
            if (plan.beacon && beaconOn(ph)) { add(0.36, 0, cab.yc + cab.r * 1.05, [1, 0.12, 0.1]); add(0.3, 0, cab.yc - cab.r * 1.05, [1, 0.12, 0.1]) }
            if (plan.landing) { add(0.36, -root, cab.yc - cab.r * 0.75, [2, 2, 1.9]); add(0.36, root, cab.yc - cab.r * 0.75, [2, 2, 1.9]) }   // wing roots
            if (plan.takeoff || plan.taxi) add(0.07, 0, 1.4 / len, plan.takeoff ? [1.8, 1.8, 1.7] : [1.2, 1.2, 1.1])                       // nose gear
            if (plan.takeoff) { add(0.37, -root * 1.3, cab.yc - cab.r * 0.75, [1.2, 1.2, 1.1]); add(0.37, root * 1.3, cab.yc - cab.r * 0.75, [1.2, 1.2, 1.1]) }   // turnoff
          }
        }
      }
      drawRoutes(e.aircraft, 40075016 * Math.cos(air.proj.refLat * Math.PI / 180) / (512 * 2 ** map!.getZoom()))
      { const sa = sim.selectedId != null ? e.aircraft.find((x) => x.id === sim.selectedId) : undefined
        if (sa && sa.phase !== 'departed') { const vp = viewPose(sim.engine!, sa); placeFx(vp.x, vp.y, vp.alt * FT, vp.hdg, sa.perf.lengthMeters, t, 40075016 * Math.cos(air.proj.refLat * Math.PI / 180) / (512 * 2 ** map!.getZoom())) } else fx.visible = false }
      for (const a of e.aircraft) {
        const state = a.id === sim.selectedId ? 'sel' : a.id === sim.hoveredId ? 'hover' : ''
        const active = a.phase !== 'parked' && a.phase !== 'arrived' && a.phase !== 'departed'
        const plan = lightsForPhase({ phase: a.phase, kind: a.plan?.kind, altitude: a.altitude, speed: a.speed ?? 0 })
        const vp = opts.source ? { x: a.pos.x, y: a.pos.y, alt: a.altitude, hdg: a.heading } : viewPose(sim.engine!, a)
        put(`a${a.id}`, a.perf.icaoCode, a.callsign, a.perf.lengthMeters, a.perf.wingspanMeters ?? a.perf.lengthMeters, vp.x, vp.y, vp.alt, vp.hdg, a.pitch ?? 0, a.bank ?? 0, a.altitude > 5, state, active, plan, a.id)
      }
      if (stood && parkedFx) stood.draw((e.parked ?? []) as never, parkedFx(), inView, mpp, (p, len, span) => {
        if (ns >= SIL_MAX) return
        silE.set(0, -p.heading * Math.PI / 180, 0); silQ.setFromEuler(silE); silP.set(p.pos.x, 0, -p.pos.y); silS.set(span, len, len); silM.compose(silP, silQ, silS); sil.setMatrixAt(ns++, silM)
      })
      else if (opts.parked !== false) for (const p of e.parked ?? []) {
        const perf = getPerformance(p.type)
        put(`p${p.id}`, p.type, p.callsign, perf?.lengthMeters ?? 38, perf?.wingspanMeters ?? 34, p.pos.x, p.pos.y, 0, p.heading, 0, 0, false, '', false, null, p.id)   // static parked traffic: cold and dark
      }
      for (const [key, r] of models) if (!live.has(key)) { if (r.obj) scene.remove(r.obj); models.delete(key) }
      sil.count = ns; sil.instanceMatrix.needsUpdate = true
      { // extra ground lights from the source (the film's "follow the greens" centreline and stop bar), 0.8 m up
        const gp = gGeo.getAttribute('position').array as Float32Array, gc = gGeo.getAttribute('color').array as Float32Array; let ng = 0
        for (const g of e.groundLights ?? []) { if (ng >= MAXG) break; gp.set([g.pos.x, 0.8, -g.pos.y], ng * 3); gc.set(g.color, ng * 3); ng++ }
        gGeo.setDrawRange(0, ng); gGeo.getAttribute('position').needsUpdate = true; gGeo.getAttribute('color').needsUpdate = true
      }
      lightGeo.setDrawRange(0, nl); lightGeo.getAttribute('position').needsUpdate = true; lightGeo.getAttribute('color').needsUpdate = true
      const lpx = Math.max(2.5, Math.min(11, 4.5 / mpp)); lightMat.uniforms.uPx.value = lpx * pxScale
      lightMat.uniforms.uA.value = Math.min(1, night * 1.4) * (0.55 + 0.45 * Math.min(1, Math.max(0, (lpx - 3) / 4)))
      gMat.uniforms.uPx.value = Math.max(4.5, Math.min(10, 6 / mpp)) * pxScale; gMat.uniforms.uA.value = 0.5 + 0.5 * Math.min(1, night * 1.4)
      // the field's own lights: smaller and dimmer as the camera pulls back (full size from zoom 16.5, least by 13.5)
      const far = Math.max(0, Math.min(1, (16.5 - zoom) / 3)); for (const u of fieldLights) u.value = far
      { const cv = map!.getCanvas(); for (const u of fieldVP) u.value.set(cv.width, cv.height) }   // (sizes by distance: see airfield.ts)
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(base)
      const tR = performance.now()
      renderer.resetState(); renderer.render(scene, camera)
      lastDraw = performance.now()
      const info = renderer.info.render; stats.frames++; stats.ms += lastDraw - tR; stats.js += tR - tJs; stats.calls = info.calls; stats.tris = info.triangles; stats.models = [...models.values()].filter((r) => r.obj?.visible).length
      // next frame only while the traffic moves, at most `fps` a second (Mapbox draws on its own for camera moves)
      const want = sim.selectedId != null ? (fps >= 40 ? 60 : Math.max(30, fps)) : fps
      if (!hiddenNow && (!sim.paused || (sim.selectedId != null && getHighlightStyle() !== 'tint' && getHighlightStyle() !== 'none')) && !timer) timer = window.setTimeout(() => { timer = 0; map?.triggerRepaint() }, Math.max(0, 1000 / want - (performance.now() - lastDraw)))
    },
  } as unknown as mapboxgl.CustomLayerInterface
  return {
    layer, stats,
    setLight(l) {
      night = l === 'night' ? 1 : l === 'day' ? 0 : 0.45
      if (l === 'day') { hemi.intensity = 1.7; hemi.color.set(0xeaf2ff); sun.intensity = 2.2; sun.color.set(0xffffff) }
      if (l === 'dawn') { hemi.intensity = 1.0; hemi.color.set(0xffd9c4); sun.intensity = 1.3; sun.color.set(0xffb88a) }
      if (l === 'dusk') { hemi.intensity = 0.9; hemi.color.set(0xd9c4ff); sun.intensity = 1.1; sun.color.set(0xff9e6b) }
      if (l === 'night') { hemi.intensity = 0.35; hemi.color.set(0x8fa6d9); sun.intensity = 0.25; sun.color.set(0xa8bfff) }
      setModelNight(l === 'night' ? 0.55 : l === 'day' ? 0 : 0.15)
      const n = l === 'night' ? 1 : l === 'day' ? 0 : 0.35; setSurfaceNight(n); for (const h of nightHandles) h.setNight(n); grassNight.value = n
    },
    setFps(f) { fps = Math.max(10, Math.min(60, f)) },
    kick() { if (!timer && !hiddenNow) map?.triggerRepaint() },
    rename() {
      const old = standsGroup?.getObjectByName('stand-numbers') as THREE.Mesh | undefined; if (!standsGroup || !old) return
      const g = buildStands(world, air.air, standsBase, []); flatGround(g); const now = g.getObjectByName('stand-numbers')
      g.traverse((o) => { if (o !== now) (o as THREE.Mesh).geometry?.dispose() })
      if (now) { standsGroup.remove(old); old.geometry.dispose(); standsGroup.add(now); now.visible = old.visible; now.updateMatrixWorld(true) }
      map?.triggerRepaint()
    },
    setHidden(on) { hiddenNow = on; if (on) { if (timer) window.clearTimeout(timer); timer = 0 } else map?.triggerRepaint() },
    dispose() { gone = true; if (timer) window.clearTimeout(timer); stood?.clear(); renderer?.dispose(); lightGeo.dispose(); models.clear(); for (const f of fixtures) f.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.() }) },
  }
}

/** The light preset for the sim's clock: the sun's elevation at the airport (dawn before noon, dusk after). */
export function lightFor(elevation: number, azimuth: number): Light {
  if (elevation > 8) return 'day'
  if (elevation > -5) return azimuth < 180 ? 'dawn' : 'dusk'
  return 'night'
}

/* ── grass: the classic map's grass texture and colours on a field that follows the runways and taxiways ── */
const grassNight = { value: 0 }
const GRASS_VERT = /* glsl */ `attribute float aDist; varying vec3 vWorld; varying float vDist; void main() { vWorld = position; vDist = aDist; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const GRASS_FRAG = /* glsl */ `
  uniform sampler2D uGrass; uniform vec2 uMow; uniform vec3 cVeg, cVegLight; uniform float uNight; varying vec3 vWorld; varying float vDist;
  uniform vec2 uEdge; uniform sampler2D uLand; uniform vec4 uLandRect; uniform float uLandOn;
  ${GRASS_DECL}
  void main() {
    // soft edge: full grass inside uEdge.x of a runway / taxiway, none past uEdge.y; none over water (land mask, blue)
    float a = 1.0 - smoothstep(uEdge.x, uEdge.y, vDist);
    if (uLandOn > 0.5) { vec2 luv = (vec2(vWorld.x, -vWorld.z) - uLandRect.xy) / uLandRect.zw; a *= 1.0 - smoothstep(0.3, 0.7, texture2D(uLand, luv).r); }
    if (a < 0.01) discard;
    vec2 mowUv = vec2(dot(vWorld.xz, uMow), dot(vWorld.xz, vec2(-uMow.y, uMow.x)));
    vec3 gM = texture2D(uGrass, vWorld.xz / 210.0).rgb; float gM2 = texture2D(uGrass, mowUv / 730.0 + 0.37).r;
    vec4 gS = texture2D(uGrass, mowUv / 26.0); float gF = texture2D(uGrass, vWorld.xz / 6.0).b;
    float gPatch = 0.6 * gM.r + 0.4 * gM2;
    vec3 col = mix(cVeg, cVegLight, 0.3 + 0.25 * gPatch);
    col = mix(col, mix(col, vec3(0.58, 0.54, 0.33), 0.55), smoothstep(0.5, 0.85, gPatch) * 0.75);
    col *= (0.92 + 0.16 * gS.g) * (0.94 + 0.12 * gF);
${GRASS_BODY}
    col *= mix(1.0, 0.16, uNight);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`
/** The flat ground (pavement, paint, stands) drawn strictly bottom to top: in order of height, then of the classic
 *  map's own layer order, writing no depth. Surfaces a centimetre or two apart no longer fight in Mapbox's depth
 *  buffer (they flickered as the camera moved); Mapbox's 3D buildings and our aircraft still hide them by depth. */
function flatGround(root: THREE.Object3D): void {
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh && !(o as THREE.Points).isPoints) return
    const pos = m.geometry?.getAttribute('position'); if (!pos) return
    let y = 0; const n = Math.min(pos.count, 256), step = Math.max(1, Math.floor(pos.count / n))
    for (let i = 0; i < pos.count; i += step) y += pos.getY(i)
    y = y / Math.ceil(pos.count / step) + o.matrixWorld.elements[13]
    o.renderOrder = -1000 + Math.round(Math.max(0, Math.min(9.9, y)) * 100) * 10 + Math.max(0, Math.min(9, o.renderOrder))
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat) mat.depthWrite = false
  })
}

/** The stand concrete (the classic map's pads under every stand, slabs along the apron lanes, corridors, bands round
 *  the terminals) is a pile of overlapping rotated rectangles: their corners poke out past each other and the edge
 *  against the grass is a staircase. Here it becomes one smooth slab: the pile is rasterised onto a 4 m grid,
 *  the coverage blurred over ~12 m, and the 50 % contour traced (marching squares, edge points interpolated) -
 *  notches fill, corners round, the outline runs clean. Same material and world-space texture, so it still meets the
 *  OSM apron slabs seamlessly. */
function smoothPads(stands: THREE.Object3D, tidy: boolean): THREE.Mesh | null {
  let pad: THREE.Mesh | null = null
  for (const c of stands.children) {
    const m = c as THREE.Mesh; const mat = m.material as THREE.MeshLambertMaterial | undefined
    if (!m.isMesh || m.renderOrder !== 0 || !mat?.map) continue
    const pos = m.geometry.getAttribute('position'); if (!pos?.count) continue
    let y = 0; for (let i = 0; i < Math.min(pos.count, 60); i++) y += pos.getY(i)
    if (Math.abs(y / Math.min(pos.count, 60) - 0.55) < 0.06) { pad = m; break }
  }
  if (!pad) return null
  const g = pad.geometry, P = g.getAttribute('position'), I = g.index
  const tri = (k: number) => (I ? I.getX(k) : k), nTri = (I ? I.count : P.count) / 3
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i); if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z }
  const C = 4, PAD = tidy ? 96 : 24; x0 -= PAD; z0 -= PAD; x1 += PAD; z1 += PAD
  const nx = Math.ceil((x1 - x0) / C) + 1, nz = Math.ceil((z1 - z0) / C) + 1
  // 1. coverage: grid points inside any triangle
  let f = new Float32Array(nx * nz)
  for (let t = 0; t < nTri; t++) {
    const a = tri(3 * t), b = tri(3 * t + 1), c = tri(3 * t + 2)
    const ax = P.getX(a), az = P.getZ(a), bx = P.getX(b), bz = P.getZ(b), cx = P.getX(c), cz = P.getZ(c)
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(den) < 1e-9) continue
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / C)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / C))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / C)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / C))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = x0 + i * C, pz = z0 + j * C
      const w1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, w2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den
      if (w1 >= -1e-6 && w2 >= -1e-6 && w1 + w2 <= 1 + 1e-6) f[j * nx + i] = 1
    }
  }
  // (tidy: notches up to about 100 m across are filled and bumps under 60 m taken off first, so the edge runs straight past a row)
  if (tidy) { f = grow(f, nx, nz, 52 / C); f = grow(f, nx, nz, -84 / C); f = grow(f, nx, nz, 32 / C) }
  // 2. blur: a 7-point box along x then z, twice (close to a Gaussian, ~12 m)
  const R = tidy ? 5 : 3, tmp = new Float32Array(nx * nz)
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < nz; j++) { let acc = 0; for (let i = -R; i <= R; i++) acc += f[j * nx + Math.min(nx - 1, Math.max(0, i))]
      for (let i = 0; i < nx; i++) { tmp[j * nx + i] = acc / (2 * R + 1); acc += f[j * nx + Math.min(nx - 1, i + R + 1)] - f[j * nx + Math.max(0, i - R)] } }
    for (let i = 0; i < nx; i++) { let acc = 0; for (let j = -R; j <= R; j++) acc += tmp[Math.min(nz - 1, Math.max(0, j)) * nx + i]
      for (let j = 0; j < nz; j++) { f[j * nx + i] = acc / (2 * R + 1); acc += tmp[Math.min(nz - 1, j + R + 1) * nx + i] - tmp[Math.max(0, j - R) * nx + i] } }
  }
  // 3. the 0.5 contour: inside cells merged per row, edge cells clipped (marching squares)
  const T = 0.5, Y = 0.55, out: number[] = []
  const v = (i: number, j: number) => f[j * nx + i]
  const quad = (xa: number, za: number, xb: number, zb: number) => out.push(xa, Y, za, xb, Y, za, xb, Y, zb, xa, Y, za, xb, Y, zb, xa, Y, zb)
  for (let j = 0; j < nz - 1; j++) {
    const za = z0 + j * C, zb = za + C
    let run = -1
    for (let i = 0; i <= nx - 1; i++) {
      const c = i < nx - 1 ? [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)] : null
      if (c && Math.min(...c) >= T) { if (run < 0) run = i; continue }
      if (run >= 0) { quad(x0 + run * C, za, x0 + i * C, zb); run = -1 }
      if (!c || Math.max(...c) < T) continue
      const pts: Array<[number, number]> = [], cx = [x0 + i * C, x0 + (i + 1) * C, x0 + (i + 1) * C, x0 + i * C], cz = [za, za, zb, zb]
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4
        if (c[k] >= T) pts.push([cx[k], cz[k]])
        if ((c[k] >= T) !== (c[k2] >= T)) { const u = (T - c[k]) / (c[k2] - c[k]); pts.push([cx[k] + u * (cx[k2] - cx[k]), cz[k] + u * (cz[k2] - cz[k])]) }
      }
      for (let k = 1; k + 1 < pts.length; k++) out.push(pts[0][0], Y, pts[0][1], pts[k][0], Y, pts[k][1], pts[k + 1][0], Y, pts[k + 1][1])
    }
  }
  // (wound to face up: three flips a double-sided Lambert surface's normal on its back face, and it rendered black)
  for (let k = 0; k < out.length; k += 9) for (let q = 0; q < 3; q++) { const t = out[k + 3 + q]; out[k + 3 + q] = out[k + 6 + q]; out[k + 6 + q] = t }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  const n = out.length / 3, uv = new Float32Array(n * 2), nrm = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) { uv[2 * k] = out[3 * k]; uv[2 * k + 1] = out[3 * k + 2]; nrm[3 * k + 1] = 1 }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.dispose(); pad.geometry = geo
  return pad
}

/* the classic map's land / water mask (its terrain shader's), to keep the grass off the bay */
const water = { tex: null as THREE.Texture | null, rect: new THREE.Vector4(0, 0, 1, 1), on: { value: 0 } }

/** Airports whose ground was drawn before the tidy outlines (SFO was finished by hand and stays as it is). */
const tidyGround = (air: AirData) => air.air.icao !== 'KSFO'
/** Distance (in cells) from every grid point to the nearest set one: exact, two passes of parabola envelopes. */
function cellDist(on: (k: number) => boolean, nx: number, ny: number): Float32Array {
  const d = new Float32Array(nx * ny); for (let k = 0; k < d.length; k++) d[k] = on(k) ? 0 : 1e12
  const n = Math.max(nx, ny), f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1)
  const pass = (len: number, at: (i: number) => number) => {
    for (let i = 0; i < len; i++) f[i] = d[at(i)]
    let k = 0; v[0] = 0; z[0] = -1e30; z[1] = 1e30
    for (let q = 1; q < len; q++) {
      let x = 0
      for (;;) { const p = v[k]; x = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p); if (x <= z[k] && k > 0) k--; else break }
      if (x <= z[k]) { v[k] = q; continue }
      k++; v[k] = q; z[k] = x; z[k + 1] = 1e30
    }
    k = 0
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[at(q)] = (q - v[k]) * (q - v[k]) + f[v[k]] }
  }
  for (let i = 0; i < nx; i++) pass(ny, (j) => j * nx + i)
  for (let j = 0; j < ny; j++) pass(nx, (i) => j * nx + i)
  for (let k = 0; k < d.length; k++) d[k] = Math.sqrt(d[k])
  return d
}
/** A 0 / 1 grid grown (r > 0) or shrunk (r < 0) by r cells. */
function grow(f: Float32Array, nx: number, ny: number, r: number): Float32Array<ArrayBuffer> {
  const d = cellDist(r > 0 ? (k) => f[k] >= 0.5 : (k) => f[k] < 0.5, nx, ny), o = new Float32Array(nx * ny)
  for (let k = 0; k < o.length; k++) o[k] = r > 0 ? (d[k] <= r ? 1 : 0) : d[k] > -r ? 1 : 0
  return o
}
/** The airport's own ground: everything inside its outline (runways, taxiways, stands, terminals, with every gap and hole
 *  between them closed) is one surface, so the city map never shows through the middle of the field; Mapbox's buildings
 *  stand on it. A 12 m grid of signed distance to that outline, smoothed, so the edge is one clean line. Returned as the
 *  same arrays the plain grass makes. */
function tidyGrass(segs: Array<[number, number, number, number, number]>, box: [number, number, number, number], edge: number): { pos: number[]; dst: number[] } {
  const C = 12, M = 720, x0 = box[0] - M, y0 = box[1] - M, nx = Math.ceil((box[2] + M - x0) / C) + 1, ny = Math.ceil((box[3] + M - y0) / C) + 1
  let g = new Float32Array(nx * ny)
  for (const [ax, ay, bx, by, R] of segs) {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - x0) / C)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + R - x0) / C)), j0 = Math.max(0, Math.floor((Math.min(ay, by) - R - y0) / C)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + R - y0) / C))
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const px = x0 + i * C, py = y0 + j * C, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)); if (Math.hypot(px - ax - t * dx, py - ay - t * dy) <= R) g[j * nx + i] = 1 }
  }
  g = grow(g, nx, ny, 420 / C); g = grow(g, nx, ny, -420 / C)
  // holes: whatever cannot be reached from the edge of the grid
  { const seen = new Uint8Array(nx * ny), st: number[] = []; const go = (k: number) => { if (!seen[k] && g[k] < 0.5) { seen[k] = 1; st.push(k) } }
    for (let i = 0; i < nx; i++) { go(i); go((ny - 1) * nx + i) } for (let j = 0; j < ny; j++) { go(j * nx); go(j * nx + nx - 1) }
    while (st.length) { const k = st.pop()!, i = k % nx; if (i > 0) go(k - 1); if (i < nx - 1) go(k + 1); if (k >= nx) go(k - nx); if (k < nx * (ny - 1)) go(k + nx) }
    for (let k = 0; k < g.length; k++) if (!seen[k]) g[k] = 1 }
  g = grow(g, nx, ny, -110 / C); g = grow(g, nx, ny, 110 / C); g = grow(g, nx, ny, 420 / C); g = grow(g, nx, ny, -420 / C)
  const out = cellDist((k) => g[k] >= 0.5, nx, ny), inn = cellDist((k) => g[k] < 0.5, nx, ny), sd = new Float32Array(nx * ny), tmp = new Float32Array(nx * ny)
  for (let k = 0; k < sd.length; k++) sd[k] = (out[k] > 0 ? out[k] - 0.5 : 0.5 - inn[k]) * C
  for (let pass = 0; pass < 4; pass++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let s = 0; for (let q = -4; q <= 4; q++) s += sd[j * nx + Math.max(0, Math.min(nx - 1, i + q))]; tmp[j * nx + i] = s / 9 }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let s = 0; for (let q = -4; q <= 4; q++) s += tmp[Math.max(0, Math.min(ny - 1, j + q)) * nx + i]; sd[j * nx + i] = s / 9 }
  }
  const pos: number[] = [], dst: number[] = [], F = 14
  const quad = (xa: number, ya: number, xb: number, yb: number, d: number[]) => { pos.push(xa, 0.3, -ya, xb, 0.3, -ya, xb, 0.3, -yb, xa, 0.3, -ya, xb, 0.3, -yb, xa, 0.3, -yb); dst.push(d[0], d[1], d[2], d[0], d[2], d[3]) }
  for (let j = 0; j < ny - 1; j++) {
    let run = -1; const ya = y0 + j * C, yb = ya + C
    for (let i = 0; i < nx; i++) {
      const c = i < nx - 1 ? [sd[j * nx + i], sd[j * nx + i + 1], sd[(j + 1) * nx + i + 1], sd[(j + 1) * nx + i]] : null
      if (c && Math.max(...c) < -F) { if (run < 0) run = i; continue }
      if (run >= 0) { quad(x0 + run * C, ya, x0 + i * C, yb, [0, 0, 0, 0]); run = -1 }
      if (c && Math.min(...c) < F) quad(x0 + i * C, ya, x0 + (i + 1) * C, yb, c.map((v) => edge + v))
    }
  }
  return { pos, dst }
}

/** Grass round the runways and taxiways: a 24 m grid whose corners carry their distance to the nearest runway or
 *  taxiway centreline. The fragment shader cuts the edge where that distance reaches 150 m, with a 25 m soft fade,
 *  and fades it out over water (the classic map's land mask) - a smooth, natural edge instead of 12 m steps, and no
 *  gaps between parallel runways. Cells wholly inside are merged per row (one quad per run, no overlaps: every pixel
 *  shaded once). Drawn first, writing no depth, so the pavement always lies on it. */
function grassField(air: AirData): THREE.Mesh {
  const W = 150, F = 25, C = 24
  const pos: number[] = [], dst: number[] = []
  const xy = (id: string) => { const n = air.air.nodes.get(id)!; return air.proj.toXY(n.lat, n.lng) }
  const segs: Array<[number, number, number, number, number]> = []; const seen = new Set<string>()
  const tidy = tidyGround(air)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [id, n] of air.air.nodes) {
    const a = xy(id); minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y)
    for (const e of n.edges) { const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`; if (seen.has(key) || e.leadIn) continue; seen.add(key); const b = xy(e.to); segs.push([a.x, a.y, b.x, b.y, e.type === 'runway' || e.runway ? 190 : 120]) }
  }
  if (tidy) {
    for (const st of air.air.stands ?? []) { const p = air.proj.toXY(st.lat, st.lng); segs.push([p.x, p.y, p.x, p.y, 120]) }
    for (const b of air.air.buildings) if (b.polygon.length > 2) { const q = b.polygon.map((v) => air.proj.toXY(v.lat, v.lng)); for (let i = 0; i < q.length; i++) { const n = q[(i + 1) % q.length]; if (q[i].x > minX - 400 && q[i].x < maxX + 400 && q[i].y > minY - 400 && q[i].y < maxY + 400) segs.push([q[i].x, q[i].y, n.x, n.y, 70]) } }
  }
  const tg = tidy ? tidyGrass(segs, [minX, minY, maxX, maxY], W - F / 2) : null
  minX -= W + C; minY -= W + C; maxX += W + C; maxY += W + C
  const nx = Math.ceil((maxX - minX) / C), ny = Math.ceil((maxY - minY) / C), vx = nx + 1
  // distance from every grid corner to the nearest segment (only corners within W + C of one are worked out)
  const d = new Float32Array(vx * (ny + 1)).fill(1e9)
  if (!tg) for (const [ax, ay, bx, by] of segs) {
    const R = W + C
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - minX) / C)), i1 = Math.min(nx, Math.ceil((Math.max(ax, bx) + R - minX) / C))
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - R - minY) / C)), j1 = Math.min(ny, Math.ceil((Math.max(ay, by) + R - minY) / C))
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = minX + i * C, py = minY + j * C
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
      const q = Math.hypot(px - ax - t * dx, py - ay - t * dy); if (q < d[j * vx + i]) d[j * vx + i] = q
    }
  }
  const quad = (x0: number, y0: number, x1: number, y1: number, d00: number, d10: number, d11: number, d01: number) => {
    // (0.3 m up, just under the pavement: at 0 it lost the depth test against Mapbox's own ground when zoomed out)
    pos.push(x0, 0.3, -y0, x1, 0.3, -y0, x1, 0.3, -y1, x0, 0.3, -y0, x1, 0.3, -y1, x0, 0.3, -y1)
    dst.push(d00, d10, d11, d00, d11, d01)
  }
  if (tg) { for (const v of tg.pos) pos.push(v); for (const v of tg.dst) dst.push(v) }
  else for (let j = 0; j < ny; j++) {
    const y0 = minY + j * C, y1 = y0 + C
    let run = -1
    for (let i = 0; i <= nx; i++) {
      const c = i < nx ? [d[j * vx + i], d[j * vx + i + 1], d[(j + 1) * vx + i + 1], d[(j + 1) * vx + i]] : null
      const inner = !!c && Math.max(...c) <= W - F                               // fully grass: merge into the row's run
      if (inner) { if (run < 0) run = i; continue }
      if (run >= 0) { quad(minX + run * C, y0, minX + i * C, y1, 0, 0, 0, 0); run = -1 }
      if (c && Math.min(...c) < W) quad(minX + i * C, y0, minX + (i + 1) * C, y1, c[0], c[1], c[2], c[3])   // the edge: per cell
    }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('aDist', new THREE.Float32BufferAttribute(dst, 1))
  const hdg = (air.air.runways[0]?.ends[0]?.trueHdg ?? 0) * Math.PI / 180
  const mat = new THREE.ShaderMaterial({ vertexShader: GRASS_VERT, fragmentShader: GRASS_FRAG, side: THREE.DoubleSide, depthWrite: false,
    // blended but in the opaque pass (drawn first, under the pavement): custom blending keeps three from sorting it last
    transparent: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,   // (the canvas keeps its alpha)
    uniforms: { t_grass: ground.tex.grass, t_grass2: ground.tex.grass2, t_dry: ground.tex.dry, gReady: ground.ready, gWet: ground.wet, uGrass: { value: grassTexture() }, uMow: { value: new THREE.Vector2(Math.sin(hdg), -Math.cos(hdg)) }, cVeg: { value: PALETTE.veg }, cVegLight: { value: PALETTE.vegLight }, uNight: grassNight,
      uEdge: { value: new THREE.Vector2(W - F, W) }, uLand: { value: water.tex ?? new THREE.Texture() }, uLandRect: { value: water.rect }, uLandOn: water.on } })
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -2000; m.name = 'grass'
  // the land mask: meta.json gives its lng/lat box; mapped into the grass's frame (x east, z south)
  void (async () => {
    try {
      const icao = air.air.icao
      const meta = await fetch(worldUrl(icao, 'meta.json')).then((r) => r.json() as Promise<{ bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } }>)
      const tex = await new THREE.TextureLoader().loadAsync(worldUrl(icao, 'shore.webp'))   // land or water, one channel
      tex.format = THREE.RedFormat; tex.colorSpace = THREE.NoColorSpace; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter
      const sw = air.proj.toXY(meta.bbox.minLat, meta.bbox.minLng), ne = air.proj.toXY(meta.bbox.maxLat, meta.bbox.maxLng)
      water.tex = tex; water.rect.set(sw.x, sw.y, ne.x - sw.x, ne.y - sw.y); water.on.value = 1
      mat.uniforms.uLand.value = tex
    } catch { /* no world for this airport: grass without the shoreline cut */ }
  })()
  return m
}

/** A unit airliner seen from above, extruded thin: x = span (unit), y = up, z = length (unit), nose at -z, origin at
 *  the nose wheel (12 % aft of the nose), as the models are. Scaled per instance by span and length. */
function silhouetteGeometry(): THREE.BufferGeometry {
  const sh = new THREE.Shape()
  // half outline (x >= 0) from the nose to the tail, mirrored; in the shape's xy, y runs nose (+) to tail (-)
  const half: Array<[number, number]> = [[0, 0.5], [0.035, 0.45], [0.05, 0.36], [0.05, 0.1], [0.5, -0.06], [0.5, -0.1], [0.05, -0.04], [0.045, -0.3], [0.17, -0.4], [0.17, -0.45], [0.03, -0.42], [0, -0.5]]
  sh.moveTo(half[0][0], half[0][1]); for (const [x, y] of half.slice(1)) sh.lineTo(x, y)
  for (const [x, y] of half.slice(0, -1).reverse()) sh.lineTo(-x, y)
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.035, bevelEnabled: false })
  g.rotateX(-Math.PI / 2)                    // shape y (nose +) -> world -z, the extrusion -> up
  g.translate(0, 0.075, 0.38)                // lifted to the fuselage; origin at the nose wheel (nose 0.12 ahead)
  g.computeVertexNormals()
  return g
}
