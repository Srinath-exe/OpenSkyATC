/*
  The Mapbox map held to the airport, and its looks. Shared by the game map and the airport lab.

  Airport lock: the view may not leave a box round the airport's taxi network (+ 2 km), zoom out past the whole
  field or tilt past 60 degrees - so Mapbox fetches and draws the airport and little else (a steep view toward the
  horizon pulls in far tiles). Tiles land in the browser's cache as they are first seen (Mapbox's own tile cache,
  12 h under Mapbox's cache lifetime); `maxTileCacheSize` keeps the whole airport in memory for the session.
  (No preload: flying the camera over the field to fetch everything up front showed the player every hop.)

  Looks: Mapbox Standard config (theme, colours) plus our own light overrides. The style's defaults are restored
  for every key a look does not set, so looks can be switched freely.
*/
import type { AirData } from './layers'

/** Airport box: the taxi network's extent plus `padM` metres all round, as [[west, south], [east, north]]. */
export function airportBounds(a: AirData, padM = 2000): [[number, number], [number, number]] {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
  for (const nd of a.air.nodes.values()) { if (nd.lng < w) w = nd.lng; if (nd.lng > e) e = nd.lng; if (nd.lat < s) s = nd.lat; if (nd.lat > n) n = nd.lat }
  if (!Number.isFinite(w)) { const c = a.air.center; w = e = c.lng; s = n = c.lat }
  const dLat = padM / 111320, dLng = padM / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180))
  return [[w - dLng, s - dLat], [e + dLng, n + dLat]]
}
/** Camera limits with the lock on (off: Mapbox's own). */
export const AIRPORT_LOCK = { minZoom: 12.3, maxPitch: 60 }   // the whole field and its corners fit on screen
export const FREE_VIEW = { minZoom: 0, maxPitch: 80 }
/** Tiles kept in memory: the whole locked airport at every zoom it is seen at, so nothing is fetched twice in a session. */
export const TILE_CACHE = 600

interface LockableMap { setMaxBounds(b: [[number, number], [number, number]] | null): unknown; setMinZoom(z?: number | null): unknown; setMaxPitch(p?: number | null): unknown }
export function setAirportLock(map: LockableMap, a: AirData, on: boolean): void {
  map.setMaxBounds(on ? airportBounds(a) : null)
  map.setMinZoom(on ? AIRPORT_LOCK.minZoom : FREE_VIEW.minZoom)
  map.setMaxPitch(on ? AIRPORT_LOCK.maxPitch : FREE_VIEW.maxPitch)
}

export type LookId = 'standard' | 'faded' | 'mono' | 'ours'
interface Look { name: string; theme: 'default' | 'faded' | 'monochrome'; colors?: Record<string, string | number> }
/* Looks change Standard's theme and colours only - never its lights: Mapbox's own light follows the light preset
   (day / dawn / dusk / night) and gives the 3D buildings their depth; any setLights() call, even setLights(null),
   replaces it and the buildings stop changing with the time of day. */
export const LOOKS: Record<LookId, Look> = {
  standard: { name: 'Standard', theme: 'default' },
  faded: { name: 'Faded', theme: 'faded' },
  mono: { name: 'Mono', theme: 'monochrome' },
  // our palette: dusky land and concrete, deep water, muted green, quiet roads - the airport and the traffic read first
  ours: {
    name: 'Ours', theme: 'default',
    colors: {
      colorLand: 'hsl(35, 9%, 78%)', colorWater: 'hsl(206, 40%, 50%)', colorGreenspace: 'hsl(95, 18%, 60%)', colorBuildings: 'hsl(32, 10%, 80%)',
      colorCommercial: 'hsl(30, 10%, 80%)', colorIndustrial: 'hsl(220, 5%, 76%)', colorMedical: 'hsl(0, 10%, 80%)', colorEducation: 'hsl(40, 10%, 80%)',
      colorRoads: 'hsl(220, 6%, 66%)', colorTrunks: 'hsl(220, 7%, 60%)', colorMotorways: 'hsl(220, 8%, 56%)', roadsBrightness: 0.25,
      colorPlaceLabels: 'hsl(0, 0%, 14%)',
    },
  },
}
/** Mapbox Standard's defaults for every key a look may change (from the style's schema). */
const DEFAULTS: Record<string, string | number> = {
  colorLand: 'hsl(20, 20%, 95%)', colorWater: 'hsl(200, 100%, 80%)', colorGreenspace: 'hsl(115, 60%, 84%)', colorBuildings: 'hsl(40, 43%, 93%)',
  colorCommercial: 'hsla(24, 100%, 94%, 1)', colorIndustrial: 'hsl(230, 15%, 92%)', colorMedical: 'hsl(0, 50%, 92%)', colorEducation: 'hsl(40, 50%, 88%)',
  colorRoads: 'hsl(224, 25%, 80%)', colorTrunks: 'hsl(235, 20%, 70%)', colorMotorways: 'hsl(214, 23%, 70%)', roadsBrightness: 0.4,
  colorPlaceLabels: 'hsl(0, 0%, 0%)',
}

interface StyledMap { setConfigProperty(scope: string, k: string, v: unknown): unknown }
/** Apply look `id`: theme and colours (Standard's defaults for every colour the look leaves alone). Lights untouched. */
export function applyLook(map: StyledMap, id: LookId): void {
  const look = LOOKS[id]
  map.setConfigProperty('basemap', 'theme', look.theme)
  for (const [k, v] of Object.entries(DEFAULTS)) map.setConfigProperty('basemap', k, look.colors?.[k] ?? v)
}

/* The city round the airport: thousands of buildings nobody looks at, and most of the cost of a frame. Buildings further
   than `nearM` from any taxiway or stand are left out as the tiles are read, so they are never sent to the graphics card.
   Standard has no setting for it: its own building layers get one more condition (its layers are reached through the
   imported style, which Mapbox keeps to itself; a version without it simply keeps every building). */
interface OwnStyle { getOwnLayer(id: string): unknown; getFilter(id: string): unknown; setFilter(id: string, f: unknown, o?: { validate?: boolean }): void }
const CITY = ['3d-building', '2d-building', '2d-building-outline', 'procedural-buildings', 'trees']
export function cityTrimmer(map: unknown, a: AirData, nearM = 400): (on: boolean) => void {
  const m = map as { style?: { getFragmentStyle?(id: string): OwnStyle | undefined }; getLayer(id: string): unknown; getFilter(id: string): unknown; setFilter(id: string, f: unknown): void; _update?(s: boolean): void }
  const cells = new Map<string, [number, number]>(), kx = 111320 * Math.cos(a.air.center.lat * Math.PI / 180)
  for (const p of [...a.air.nodes.values(), ...a.air.stands]) { const k = `${Math.round(p.lng * kx / 180)}|${Math.round(p.lat * 111320 / 180)}`; if (!cells.has(k)) cells.set(k, [p.lng, p.lat]) }
  const near = ['<', ['distance', { type: 'MultiPoint', coordinates: [...cells.values()] }], nearM]
  const was = new Map<string, unknown>()
  return (on) => {
    const one = (key: string, st: { getFilter(id: string): unknown; setFilter(id: string, f: unknown, o?: { validate?: boolean }): void }, id: string) => {
      try {
        if (!was.has(key)) { if (!on) return; was.set(key, st.getFilter(id) ?? null) }
        const f = was.get(key); st.setFilter(id, on ? (f ? ['all', f, near] : near) : f, { validate: false })
      } catch { /* the layer stays as it is */ }
    }
    const own = m.style?.getFragmentStyle?.('basemap')
    if (own) for (const id of CITY) if (own.getOwnLayer(id)) one(`basemap/${id}`, own, id)
    if (m.getLayer('ap-buildings')) one('ap-buildings', m, 'ap-buildings')
    m._update?.(true)
  }
}

/** Airports whose motorways are left out, on the field (scripts/ground/plan.py) and on the map round it. */
const NO_HIGHWAYS = new Set(['LFPG'])
const ROADS = ['tunnel-roads-case', 'tunnel-roads', 'roads-case', 'roads', 'road-polygon-case', 'road-primary-polygon-fill', 'road-motorway-trunk-polygon-fill', 'hd-sd-other-roads', 'bridge-roads', '3d-bridges', 'bridge-primary-shadow', 'bridge-primary-case',
  ...['bridge-major-link', 'bridge-motorway-trunk', 'bridge-major-link-2', 'bridge-motorway-trunk-2'].flatMap((b) => [b, `${b}-shadow`, `${b}-case`]),
  ...['tunnel', 'road', 'bridge'].flatMap((b) => [`${b}-oneway-arrow-trunk`, `${b}-oneway-arrow-motorway`])]
export function hideHighways(map: unknown, icao: string): void {
  const own = NO_HIGHWAYS.has(icao) ? (map as { style?: { getFragmentStyle?(id: string): OwnStyle | undefined } }).style?.getFragmentStyle?.('basemap') : undefined
  if (!own) return
  const rest = ['!', ['in', ['get', 'class'], ['literal', ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']]]]
  for (const id of ROADS) if (own.getOwnLayer(id)) try { const f = own.getFilter(id); own.setFilter(id, f ? ['all', f, rest] : rest, { validate: false }) } catch { /* the layer stays as it is */ }
}
