'use client'
/*
  Airport lab, with every seat on the AI, to look at the airport and the traffic without playing. Three base maps
  under the same game layers (components/atc/MapboxMap/layers.ts: our ground, stands, jet bridges, fleet, labels):
  - /lab/airport        Mapbox: Mapbox Standard (3D city, landmark terminals, light presets). NEXT_PUBLIC_MAPBOX_TOKEN.
  - /lab/airport-open   Open: MapLibre GL with open vector tiles (OpenStreetMap data, buildings as extrusions) - the
                        look MapTiler Data gives as downloadable files. MapTiler's own style when
                        NEXT_PUBLIC_MAPTILER_KEY is set, else OpenFreeMap's Liberty style (free, no key).
  - /lab/airport-3d     Ours: only our own 3D world (components/atc/WorldMap), no map service at all.
  The switch in the panel flips between them in place (same simulation) and updates the address.
*/
import * as React from 'react'
import dynamic from 'next/dynamic'
import 'mapbox-gl/dist/mapbox-gl.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import type * as GeoJSON from 'geojson'
import { sim, useSim } from '@/components/atc/simStore'
import { MAPBOX_TOKEN } from '@/components/atc/MapboxMap/engine'
import type { Light, TrafficLayer } from '@/components/atc/MapboxMap/layers'
import { AIRPORT_LOCK, LOOKS, TILE_CACHE, airportBounds, applyLook, setAirportLock, type LookId } from '@/components/atc/MapboxMap/look'
import s from './AirportLab.module.css'

const WorldMap = dynamic(() => import('@/components/atc/WorldMap/WorldMap').then((m) => m.WorldMap), { ssr: false })
export type LabBase = 'mapbox' | 'open' | 'own'
const LAB_PATH: Record<LabBase, string> = { mapbox: '/lab/airport', open: '/lab/airport-open', own: '/lab/airport-3d' }
const BASE_NAME: Record<LabBase, string> = { mapbox: 'Mapbox', open: 'Open', own: 'Ours' }
const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? ''
const OPEN_STYLE = MAPTILER_KEY ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}` : 'https://tiles.openfreemap.org/styles/liberty'
const OPEN_FONT_B = ['Noto Sans Bold'], OPEN_FONT_M = ['Noto Sans Regular']

/* the bits of the two map libraries the lab touches (their Map types differ; the calls are the same) */
interface LabMap {
  isStyleLoaded(): boolean | void
  setLayoutProperty(id: string, k: string, v: unknown): unknown
  easeTo(o: { pitch: number; duration: number }): unknown
  getLayer(id: string): unknown
  setConfigProperty?(scope: string, k: string, v: unknown): unknown
}
type AnyLayer = Record<string, unknown> & { id: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> }

/** A Mapbox layer made acceptable to MapLibre: no slots, no emissive strength, fonts its glyph server has. */
function forMapLibre(l: AnyLayer): AnyLayer {
  const { slot: _slot, ...rest } = l; void _slot
  const out: AnyLayer = { ...rest }
  if (l.paint) out.paint = Object.fromEntries(Object.entries(l.paint).filter(([k]) => !k.endsWith('-emissive-strength')))
  if (l.layout?.['text-font']) out.layout = { ...l.layout, 'text-font': String(l.layout['text-font']).includes('Bold') ? OPEN_FONT_B : OPEN_FONT_M }
  return out
}

export function AirportLab({ base: initialBase = 'mapbox' }: { base?: LabBase }) {
  const [base, setBase] = React.useState<LabBase>(initialBase === 'mapbox' && !MAPBOX_TOKEN ? 'open' : initialBase)
  const pick = (b: LabBase) => { setBase(b); try { history.replaceState(null, '', LAB_PATH[b] + location.search) } catch { /* ignore */ } }
  const host = React.useRef<HTMLDivElement>(null)
  const mapRef = React.useRef<LabMap | null>(null)
  const trafficRef = React.useRef<TrafficLayer | null>(null)
  const hasEngine = useSim((st) => !!st.engine)
  const count = useSim((st) => st.engine?.aircraft.length ?? 0)
  const [light, setLight] = React.useState<Light>('day')
  const [labels, setLabels] = React.useState(true)
  const [gates, setGates] = React.useState(true)
  const [pitch3d, setPitch3d] = React.useState(true)
  const [status, setStatus] = React.useState('')
  const [lock, setLock] = React.useState(() => new URLSearchParams(location.search).get('lock') !== '0')
  const [look, setLook] = React.useState<LookId>('standard')
  const [ready, setReady] = React.useState(false)
  const lockRef = React.useRef(lock); lockRef.current = lock

  // the simulation: every seat on the AI, so traffic pushes, taxis, departs and lands on its own
  React.useEffect(() => {
    const q = new URLSearchParams(location.search)
    sim.updateSettings({ autoGround: true, autoTower: true, autoApproach: true }, { silent: true })
    void sim.load({ icao: (q.get('icao') ?? 'KSFO').toUpperCase(), seed: Number(q.get('seed') ?? 7), spawn: 'default', position: 'tower' } as never)
    return () => { sim.stop() }
  }, [])

  React.useEffect(() => {
    if (base === 'own') { setStatus(''); return }
    if (!hasEngine || !host.current || mapRef.current) return
    let cleanup: (() => void) | null = null, dead = false
    setStatus('Loading the map…')
    // (each map library is loaded only when its base map is picked: "Ours" fetches neither)
    const lib = base === 'mapbox' ? import('mapbox-gl') : import('maplibre-gl')
    void Promise.all([lib, import('@/components/atc/MapboxMap/layers')]).then(([mod, { addAirportLayers, trafficLayer }]) => {
      if (dead || !host.current) return
      const e = sim.engine!; const air = { air: e.air, proj: e.proj }
      const c = e.air.center
      // airport lock from the start (no tiles outside the box are ever asked for) and the whole airport kept in memory
      const view = { center: [c.lng, c.lat] as [number, number], zoom: 15.3, pitch: 62, bearing: -62, maxTileCacheSize: TILE_CACHE,
        ...(lockRef.current ? { maxBounds: airportBounds(air), ...AIRPORT_LOCK } : { maxPitch: 80 }) }
      /* eslint-disable @typescript-eslint/no-explicit-any */
      let map: any
      if (base === 'mapbox') {
        const mapboxgl = (mod as typeof import('mapbox-gl')).default
        mapboxgl.accessToken = MAPBOX_TOKEN
        map = new mapboxgl.Map({ container: host.current, style: 'mapbox://styles/mapbox/standard', antialias: true, ...view,
          config: { basemap: { lightPreset: 'day', show3dObjects: true, showPointOfInterestLabels: false, showTransitLabels: false, showPlaceLabels: true, showRoadLabels: false } } } as any)
        map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right')
      } else {
        const maplibregl = mod as typeof import('maplibre-gl')
        map = new maplibregl.Map({ container: host.current, style: OPEN_STYLE, canvasContextAttributes: { antialias: true }, ...view } as any)
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
      }
      mapRef.current = map
      const ro = new ResizeObserver(() => map.resize()); ro.observe(host.current)
      ;(window as unknown as { __lab?: unknown }).__lab = { map, ready: false, base }
      const callsigns: AnyLayer = { id: 'lab-callsigns', type: 'symbol', source: 'lab-traffic', slot: 'top', layout: { 'text-field': ['get', 'cs'], 'text-size': 11, 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'], 'text-offset': [0, -2.2], 'text-padding': 2 }, paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,14,22,0.92)', 'text-halo-width': 4, 'text-emissive-strength': 1 } }
      map.on(base === 'mapbox' ? 'style.load' : 'load', () => {
        const t = trafficLayer(air, { classicGround: true }); trafficRef.current = t
        if (base === 'mapbox') {
          addAirportLayers(map, air, { classicGround: true })
          map.addSource('lab-traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          map.addLayer(t.layer)
          map.addLayer(callsigns)
        } else {
          // MapLibre: our ground and fleet under the style's 3D buildings (first extrusion layer), our labels on top;
          // its custom layers get the matrices inside an options object: defaultProjectionData.mainMatrix is the one
          // for Mercator 0..1 coordinates, like Mapbox's (modelViewProjectionMatrix is in world pixels)
          const styleLayers: Array<{ id: string; type: string }> = map.getStyle().layers ?? []
          const under = styleLayers.find((l) => l.type === 'fill-extrusion')?.id
          // (no shop / café / bus-stop icons: the airport reads cleaner, as on the Mapbox map)
          for (const l of styleLayers) if (/^poi/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none')
          const tl = t.layer as unknown as { render: (gl: unknown, m: number[]) => void }
          type Opts = { defaultProjectionData: { mainMatrix: ArrayLike<number> } }
          map.addLayer({ ...t.layer, render: (gl: unknown, o: Opts | number[]) => tl.render(gl, Array.from(Array.isArray(o) ? o : o.defaultProjectionData.mainMatrix)) }, under)
          const shim = { addSource: (id: string, src: unknown) => map.addSource(id, src), addLayer: (l: AnyLayer) => map.addLayer(forMapLibre(l)) }
          addAirportLayers(shim as never, air, { classicGround: true })
          map.addSource('lab-traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          map.addLayer(forMapLibre(callsigns))
        }
        setReady(true)
        ;(window as unknown as { __lab: { ready: boolean } }).__lab.ready = true
        setStatus('')
      })
      map.on('error', (ev: { error?: Error }) => { const m = ev.error?.message ?? ''; if (/token|key|401|403|Unauthorized|Forbidden/i.test(m)) setStatus(`The map service refused the request: ${m}`) })
      const tick = window.setInterval(() => {
        const src = map.getSource('lab-traffic'); const en = sim.engine; if (!src || !en) return
        const features: GeoJSON.Feature[] = en.aircraft.filter((a) => a.phase !== 'parked').map((a) => { const ll = en.proj.toLngLat(a.pos.x, a.pos.y); return { type: 'Feature', properties: { cs: a.callsign }, geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] } } })
        src.setData({ type: 'FeatureCollection', features })
      }, 250)
      /* eslint-enable @typescript-eslint/no-explicit-any */
      cleanup = () => { setReady(false); ro.disconnect(); window.clearInterval(tick); trafficRef.current?.dispose(); trafficRef.current = null; map.remove(); mapRef.current = null }
    })
    return () => { dead = true; cleanup?.() }
  }, [hasEngine, base])

  React.useEffect(() => {
    const m = mapRef.current; if (!ready || !m) return
    if (base === 'mapbox') { m.setConfigProperty?.('basemap', 'lightPreset', light); applyLook(m as never, look) }
    trafficRef.current?.setLight(light)
  }, [light, look, base, ready])
  React.useEffect(() => { const m = mapRef.current; const e = sim.engine; if (!ready || !m || !e) return; setAirportLock(m as never, { air: e.air, proj: e.proj }, lock) }, [lock, ready])
  React.useEffect(() => { const m = mapRef.current; if (!m?.isStyleLoaded() || !m.getLayer('lab-callsigns')) return; m.setLayoutProperty('lab-callsigns', 'visibility', labels ? 'visible' : 'none') }, [labels])
  React.useEffect(() => { const m = mapRef.current; if (!m?.isStyleLoaded()) return; for (const id of ['ap-stands', 'ap-twy']) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', gates ? 'visible' : 'none') }, [gates])
  React.useEffect(() => { const m = mapRef.current; if (!m) return; m.easeTo({ pitch: pitch3d ? 62 : 0, duration: 900 }) }, [pitch3d])

  const credit = base === 'mapbox' ? 'Base map © Mapbox © OpenStreetMap. ' : base === 'open' ? `Base map ${MAPTILER_KEY ? '© MapTiler ' : 'OpenFreeMap '}© OpenMapTiles © OpenStreetMap. ` : 'Map data © OpenStreetMap. '
  return (
    <div className={s.root} data-testid="airport-lab" data-base={base} data-mapbox={base === 'own' ? 'off' : 'on'}>
      {base !== 'own' ? <div key={base} ref={host} className={s.map} style={{ position: 'absolute', inset: 0 }} /> : hasEngine ? <div key="own" className={s.map} style={{ position: 'absolute', inset: 0 }}><WorldMap standalone /></div> : null}
      <aside className={s.panel}>
        <p className={s.kicker}>Experiment</p>
        <h1 className={s.title}>Airport lab</h1>
        <p className={s.sub}>{sim.engine?.air.icao ?? 'KSFO'} · {count} aircraft · all seats on AI</p>
        <div className={s.group}>
          <span className={s.label}>Base map</span>
          <div className={`${s.seg} ${s.seg3}`} role="radiogroup" aria-label="Base map">
            {(['mapbox', 'open', 'own'] as LabBase[]).map((b) => <button key={b} type="button" role="radio" aria-checked={base === b} disabled={b === 'mapbox' && !MAPBOX_TOKEN} className={s.segBtn} onClick={() => pick(b)} data-base={b}>{BASE_NAME[b]}</button>)}
          </div>
        </div>
        {base !== 'own' ? <>
        <label className={s.row} style={{ borderTop: 0 }}><span>Lock to the airport</span><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /></label>
        {base === 'mapbox' ? <div className={s.group}>
          <span className={s.label}>Look</span>
          <div className={`${s.seg} ${s.seg5}`} role="radiogroup" aria-label="Look">
            {(Object.keys(LOOKS) as LookId[]).map((k) => <button key={k} type="button" role="radio" aria-checked={look === k} className={s.segBtn} onClick={() => setLook(k)} data-look={k}>{LOOKS[k].name}</button>)}
          </div>
        </div> : null}
        {base === 'mapbox' ? <div className={s.group}>
          <span className={s.label}>Light</span>
          <div className={s.seg} role="radiogroup" aria-label="Light">
            {(['dawn', 'day', 'dusk', 'night'] as Light[]).map((l) => <button key={l} type="button" role="radio" aria-checked={light === l} className={s.segBtn} onClick={() => setLight(l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}
          </div>
        </div> : null}
        <label className={s.row}><span>Callsigns</span><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /></label>
        <label className={s.row}><span>Gate and taxiway labels</span><input type="checkbox" checked={gates} onChange={(e) => setGates(e.target.checked)} /></label>
        <label className={s.row}><span>3D view</span><input type="checkbox" checked={pitch3d} onChange={(e) => setPitch3d(e.target.checked)} /></label>
        </> : <p className={s.note} style={{ display: 'block' }}>Our own 3D world only: terrain, terminals, runways, taxiways, stands, jet bridges and the fleet. Time of day and labels are in the toolbar.</p>}
        {base === 'open' ? <p className={s.note} style={{ display: 'block' }}>Open map data (OpenStreetMap) in MapLibre: the look MapTiler Data sells as files you can host yourself and keep.</p> : null}
        <p className={s.note}>{credit}Aircraft from FlightGear (GPL v2).</p>
      </aside>
      {status ? <div className={s.status}>{status}</div> : null}
    </div>
  )
}
