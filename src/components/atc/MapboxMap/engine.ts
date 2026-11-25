/* Which 3D map the game draws for ground and tower: the Mapbox one (MapboxMap, the default) or the classic three.js
   world (WorldMap). Kept per browser once picked in Settings; ?map=mapbox|classic in the URL sets it. Mapbox needs
   NEXT_PUBLIC_MAPBOX_TOKEN (without it: classic). Test runs (?test=1) keep the classic map unless the URL asks. */
import { useSyncExternalStore } from 'react'

export type MapEngine = 'classic' | 'mapbox'
const KEY = 'skycontrol_map_engine'
export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''
export const mapboxAvailable = () => MAPBOX_TOKEN.length > 0

const subs = new Set<() => void>()
export function getMapEngine(): MapEngine {
  if (typeof window === 'undefined') return 'classic'
  try {
    const q = new URLSearchParams(window.location.search).get('map')
    if (q === 'mapbox' || q === 'classic') { localStorage.setItem(KEY, q); return q === 'mapbox' && mapboxAvailable() ? 'mapbox' : 'classic' }
    const saved = localStorage.getItem(KEY)
    if (saved === 'classic' || !mapboxAvailable()) return 'classic'
    if (saved !== 'mapbox' && new URLSearchParams(window.location.search).get('test') === '1') return 'classic'
    return 'mapbox'
  } catch { return 'classic' }
}
export function setMapEngine(e: MapEngine): void {
  try { localStorage.setItem(KEY, e) } catch { /* storage blocked */ }
  for (const f of subs) f()
}
export function useMapEngine(): MapEngine {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, getMapEngine, () => 'classic')
}
