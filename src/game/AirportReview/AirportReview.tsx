'use client'
/*
  Airport review (/lab/airports): the new airports, one tab each, drawn exactly as the game draws them, to look over and
  say what to fix. No simulation runs. Mapbox drops its 3D buildings when zoomed out, so each map is laid out several
  times larger than the screen and scaled back down (with the pixel ratio lowered to match): the map then works at a
  zoom where every building is drawn, however far out the screen shows it.
*/
import * as React from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { sim } from '@/components/atc/simStore'
import { MAPBOX_TOKEN } from '@/components/atc/MapboxMap/engine'
import { relabel, addAirportLayers, trafficLayer, type Light, type TrafficLayer, type TrafficSource } from '@/components/atc/MapboxMap/layers'
import { flyKeys } from '@/components/atc/MapboxMap/flyKeys'
import type { ParkedFx } from '@/components/atc/MapboxMap/parked'
import { airportBounds, cityTrimmer, hideHighways } from '@/components/atc/MapboxMap/look'
import { buildOsmAirport } from '@/lib/osmAirport'
import { SimEngine } from '@/lib/sim/engine'
import { setSeed } from '@/lib/sim/rng'
import { AIRPORT_BY_ICAO } from '@/app/_lib/airports'
import s from './AirportReview.module.css'

const ICAOS = ['KSFO', 'KJFK', 'LFPG', 'WSSS', 'RJTT', 'OMDB']
const KEEP = 3                    // maps kept alive: going back to one of the last three is instant
const BUILDINGS_ZOOM = 14.5       // the map never works further out than this: Mapbox's terminal models are there, and ours fill in the rest until its own start at 15 (each zoom level closer is four times the tiles)

/* the pixel ratio the visible map works at (Mapbox reads window.devicePixelRatio as it draws) */
let over = 1
function overridePixelRatio(): () => void {
  const own = window.devicePixelRatio || 1
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => own / over })
  return () => { delete (window as unknown as Record<string, unknown>).devicePixelRatio }
}

interface Shown { planes: boolean; density: number; names: boolean; simple: boolean; light: Light; meter: boolean; trim: boolean; fx: ParkedFx }
interface Speed { fps: number; worst: number; ms: number; calls: number; tris: number }
const FX: [keyof ParkedFx, string][] = [['group', 'Draw matching planes together'], ['still', 'Place parked planes once'], ['share', 'Share paint, no cabin lights'], ['gentle', 'Load a few at a time']]
const allFx = (on: boolean): ParkedFx => ({ group: on, still: on, share: on, gentle: on })
interface Api { fit(): void; air: string; stands: number; planes: number }

export function AirportReview() {
  const [icao, setIcao] = React.useState(() => { const q = (new URLSearchParams(location.search).get('icao') ?? '').toUpperCase(); return ICAOS.includes(q) ? q : ICAOS[0] })
  const [alive, setAlive] = React.useState<string[]>([icao])
  const [shown, setShown] = React.useState<Shown>({ planes: false, density: 60, names: true, simple: false, light: 'day', meter: true, trim: true, fx: allFx(true) })
  const [speed, setSpeed] = React.useState<Speed | null>(null)
  const [state, setState] = React.useState<Record<string, string>>({})
  const [counts, setCounts] = React.useState<Record<string, { stands: number; planes: number }>>({})
  const [spot, setSpot] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [unlocked, setUnlocked] = React.useState(false)
  const apis = React.useRef<Record<string, Api>>({})

  React.useEffect(() => { const was = sim.paused; sim.stop(); sim.paused = true; const undo = overridePixelRatio(); setUnlocked(true); return () => { undo(); sim.paused = was } }, [])
  const pick = (i: string) => {
    setIcao(i); setSpot(''); setAlive((l) => [i, ...l.filter((x) => x !== i)].slice(0, KEEP))
    try { history.replaceState(null, '', `${location.pathname}?icao=${i}`) } catch { /* ignore */ }
  }
  const onSpot = React.useCallback((t: string) => {
    setSpot(t); setCopied(false)
    navigator.clipboard?.writeText(t).then(() => setCopied(true), () => {})
  }, [])
  const set = (p: Partial<Shown>) => setShown((v) => ({ ...v, ...p }))
  const n = counts[icao]

  return (
    <div className={s.root}>
      {unlocked ? ICAOS.filter((i) => alive.includes(i)).map((i) => (
        <OneAirport key={i} icao={i} active={i === icao} shown={shown} onSpot={onSpot}
          onState={(t) => setState((v) => (v[i] === t ? v : { ...v, [i]: t }))}
          onCounts={(c) => setCounts((v) => ({ ...v, [i]: c }))} onSpeed={setSpeed} apis={apis} />
      )) : null}

      <header className={s.bar}>
        <div className={s.tabs} role="tablist" aria-label="Airport">
          {ICAOS.map((i) => (
            <button key={i} type="button" role="tab" aria-selected={i === icao} className={s.tab} onClick={() => pick(i)}>
              <b>{AIRPORT_BY_ICAO[i].iata}</b><span>{AIRPORT_BY_ICAO[i].city}</span>
            </button>
          ))}
        </div>
        <div className={s.tools}>
          <button type="button" className={s.btn} aria-pressed={shown.planes} onClick={() => set({ planes: !shown.planes })}>{shown.planes ? 'Hide planes' : 'Show planes'}</button>
          <label className={s.slide} data-off={!shown.planes || undefined}>
            <span>Stands filled {shown.density}%</span>
            <input type="range" min={5} max={100} step={5} value={shown.density} onChange={(e) => set({ density: Number(e.target.value), planes: true })} />
          </label>
          <button type="button" className={s.btn} aria-pressed={shown.names} onClick={() => set({ names: !shown.names })}>{shown.names ? 'Hide names' : 'Show names'}</button>
          <button type="button" className={s.btn} aria-pressed={shown.simple} onClick={() => set({ simple: !shown.simple })}>{shown.simple ? 'Simple names' : 'Real names'}</button>
          <div className={s.seg} role="radiogroup" aria-label="Light">
            {(['day', 'dusk', 'night'] as Light[]).map((l) => <button key={l} type="button" role="radio" aria-checked={shown.light === l} className={s.segBtn} onClick={() => set({ light: l })}>{l[0].toUpperCase() + l.slice(1)}</button>)}
          </div>
          <button type="button" className={s.btn} onClick={() => apis.current[icao]?.fit()}>Whole airport</button>
        </div>
      </header>

      <aside className={s.speed} aria-label="Speed">
        <div className={s.fpsRow}>
          <b className={s.fps} data-slow={(shown.meter && speed && speed.fps < 30) || undefined}>{shown.meter && speed ? speed.fps : '--'}</b><span>FPS</span>
          <button type="button" className={s.btn} aria-pressed={shown.meter} onClick={() => set({ meter: !shown.meter })}>{shown.meter ? 'Stop' : 'Measure'}</button>
        </div>
        <p className={s.nums}>{shown.meter && speed ? <>slowest frame {speed.worst} ms<br />airport and planes {speed.ms.toFixed(1)} ms a frame<br />{speed.calls.toLocaleString()} draw steps, {(speed.tris / 1e6).toFixed(2)}M triangles</> : 'Not measuring'}</p>
        {FX.map(([k, label]) => (
          <label key={k} className={s.fx}><input type="checkbox" checked={shown.fx[k]} onChange={(e) => set({ fx: { ...shown.fx, [k]: e.target.checked } })} /><span>{label}</span></label>
        ))}
        <label className={s.fx}><input type="checkbox" checked={shown.trim} onChange={(e) => set({ trim: e.target.checked })} /><span>Leave out buildings far from the airport</span></label>
        <div className={s.fxAll}>
          <button type="button" className={s.btn} onClick={() => set({ fx: allFx(true), trim: true })}>All on</button>
          <button type="button" className={s.btn} onClick={() => set({ fx: allFx(false), trim: false })}>All off</button>
        </div>
      </aside>

      <footer className={s.foot}>
        <span className={s.state} data-busy={state[icao] !== 'All loaded' || undefined}>{state[icao] ?? 'Loading'}</span>
        {n ? <span>{n.stands} gates{shown.planes ? `, ${n.planes} planes` : ''}</span> : null}
        {spot ? <span className={s.spot}>{spot}{copied ? <i>copied</i> : null}</span> : <span className={s.hint}>W A S D to move, Q up, E down, Shift faster. Click anywhere to copy the gate, taxiway and place</span>}
      </footer>
    </div>
  )
}

function OneAirport({ icao, active, shown, onSpot, onState, onCounts, onSpeed, apis }: { icao: string; active: boolean; shown: Shown; onSpot(t: string): void; onState(t: string): void; onCounts(c: { stands: number; planes: number }): void; onSpeed(v: Speed): void; apis: React.RefObject<Record<string, Api>> }) {
  const box = React.useRef<HTMLDivElement>(null), host = React.useRef<HTMLDivElement>(null)
  const live = React.useRef<{ map: mapboxgl.Map; traffic: TrafficLayer | null; k: number; size(): void; apply(): void } | null>(null)
  const shownRef = React.useRef(shown), activeRef = React.useRef(active), cb = React.useRef({ onSpot, onState, onCounts, onSpeed })
  React.useEffect(() => { cb.current = { onSpot, onState, onCounts, onSpeed } })
  React.useEffect(() => { shownRef.current = shown; live.current?.apply() }, [shown])
  React.useEffect(() => {
    activeRef.current = active; const l = live.current; if (!l) return
    if (active) { over = l.k; l.size(); l.apply() }
  }, [active])

  React.useEffect(() => {
    let dead = false, off: (() => void) | null = null
    cb.current.onState('Loading the airport')
    void fetch(`/maps/osm/${icao}.geojson`, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`No airport data (${r.status})`); return r.json() }).then((fc) => {
      if (dead || !host.current || !box.current) return
      setSeed(7)
      const e = new SimEngine(buildOsmAirport(icao, fc, { quiet: true }))
      off = open(e)
    }).catch((err: unknown) => { if (!dead) cb.current.onState(err instanceof Error ? err.message : String(err)) })

    const open = (e: SimEngine): (() => void) => {
      const el = host.current!, wrap = box.current!, air = { air: e.air, proj: e.proj }, c = e.air.center
      // every stand gets an aircraft that fits it; the density decides how many of them are shown (the same ones each time)
      e.populateParked(999, 999)
      const rank = (t: string) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); h ^= h >>> 13; return (Math.imul(h, 0x5bd1e995) >>> 0) }
      const all = [...e.parked].sort((a, b) => rank(a.standRef) - rank(b.standRef))
      let parked: typeof all = []
      const source = () => ({ aircraft: [], parked }) as unknown as TrafficSource

      const [[w, so], [ea, no]] = airportBounds(air, 350), kx = 111320 * Math.cos(c.lat * Math.PI / 180)
      const W = wrap.clientWidth || 1600, H = wrap.clientHeight || 900
      const mppFit = Math.max((ea - w) * kx / W, (no - so) * 111320 / (H - 110))
      const fitZoom = Math.log2(40075016 * Math.cos(c.lat * Math.PI / 180) / (512 * mppFit)), minReal = fitZoom - 0.15
      const k = Math.max(1, Math.min(7, 2 ** (BUILDINGS_ZOOM - minReal))), up = Math.log2(k)
      if (activeRef.current) over = k
      const size = () => { const r = wrap.getBoundingClientRect(); el.style.width = `${r.width * k}px`; el.style.height = `${r.height * k}px`; el.style.transform = `scale(${1 / k})`; live.current?.map.resize() }
      size()

      mapboxgl.accessToken = MAPBOX_TOKEN
      const key = `airport-review-${icao}`
      let cam: { center: [number, number]; zoom: number; pitch: number; bearing: number } = { center: [(w + ea) / 2, (so + no) / 2], zoom: fitZoom, pitch: 0, bearing: 0 }
      const whole = { ...cam, zoom: fitZoom + up }
      try { const was = JSON.parse(sessionStorage.getItem(key) ?? 'null') as typeof cam | null; if (was) cam = was } catch { /* storage blocked */ }
      const map = new mapboxgl.Map({
        container: el, style: 'mapbox://styles/mapbox/standard', ...cam, zoom: cam.zoom + up, minZoom: minReal + up, maxPitch: 60, antialias: true, fadeDuration: 0, renderWorldCopies: false, performanceMetricsCollection: false,
        maxBounds: airportBounds(air, 3000), minTileCacheSize: 600, maxTileCacheSize: 1200,   // nothing seen is ever dropped
        config: { basemap: { lightPreset: shownRef.current.light, show3dObjects: true, show3dBuildings: true, show3dLandmarks: true, show3dTrees: false, showPointOfInterestLabels: false, showTransitLabels: false, showPlaceLabels: false, showRoadLabels: false, showPedestrianRoads: false, showAdminBoundaries: false } },
      } as mapboxgl.MapOptions)
      const L = { map, traffic: null as TrafficLayer | null, k, size, apply: () => {} }; live.current = L
      const ro = new ResizeObserver(() => { if (!activeRef.current) return; over = k; size() }); ro.observe(wrap)
      let ready = false, trimmed = false; const trim = cityTrimmer(map, air)
      L.apply = () => {
        const v = shownRef.current
        parked = v.planes ? all.slice(0, Math.round(all.length * v.density / 100)) : []
        cb.current.onCounts({ stands: e.gates.length, planes: parked.length })
        if (!ready) return
        for (const id of ['ap-twy', 'ap-stands', 'ap-rwy']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v.names ? 'visible' : 'none')
        if (e.setNaming(v.simple ? 'simple' : 'real')) { relabel(map, air); L.traffic?.rename() }
        if (v.trim !== trimmed) { trimmed = v.trim; trim(trimmed) }
        map.setConfigProperty('basemap', 'lightPreset', v.light); L.traffic?.setLight(v.light)
        map.triggerRepaint()
      }
      map.on('style.load', () => {
        if (dead) return
        cb.current.onState('Laying out the airfield')
        addAirportLayers(map, air, { classicGround: true }); hideHighways(map, air.air.icao)
        map.setPaintProperty('ap-buildings', 'fill-extrusion-cast-shadows', false)   // only seen from afar: no second drawing of the whole city for shadows a pixel long
        // sizes in pixels are for the screen: this map is drawn k times larger
        for (const [id, px] of [['ap-twy', 12], ['ap-stands', 11], ['ap-rwy', 16]] as [string, number][]) { map.setLayoutProperty(id, 'text-size', px * k); map.setLayoutProperty(id, 'text-padding', 2 * k); map.setPaintProperty(id, 'text-halo-width', 2.2 * k); map.setLayerZoomRange(id, id === 'ap-stands' ? Math.min(23, 15 + up) : 0, 24) }   // gate names only close in, as in the game
        map.setPaintProperty('ap-taxi-far', 'line-width', 1.5 * k); map.setLayerZoomRange('ap-taxi-far', 0, Math.min(24, 15.6 + up))
        map.setPaintProperty('ap-taxi-far', 'line-opacity', ['interpolate', ['linear'], ['zoom'], 14.6 + up, 0.85, 15.6 + up, 0])
        map.addSource('spot', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({ id: 'spot', type: 'circle', source: 'spot', slot: 'top', paint: { 'circle-radius': 8 * k, 'circle-color': 'rgba(255,138,60,0.25)', 'circle-stroke-color': '#ff8a3c', 'circle-stroke-width': 2.5 * k, 'circle-emissive-strength': 1 } } as mapboxgl.AnyLayer)
        L.traffic = trafficLayer(air, { classicGround: true, source, over: k, parkedFx: () => shownRef.current.fx }); map.addLayer(L.traffic.layer)
        map.setFog({ range: [16, 20], color: '#dfe6ee', 'horizon-blend': 0.05 } as mapboxgl.FogSpecification)
        ready = true; L.apply(); cb.current.onState('Loading buildings')
      })
      // the meter redraws the map without a pause, so the number is what the machine can do here
      let frames = 0, t0 = performance.now(), last = t0, worst = 0, s0 = { frames: 0, ms: 0, js: 0 }
      map.on('render', () => {
        const now = performance.now(); frames++; if (now - last < 1500) worst = Math.max(worst, now - last); last = now
        const st = L.traffic?.stats
        if (shownRef.current.meter && activeRef.current && st && now - t0 >= 600) {
          const n = Math.max(1, st.frames - s0.frames)
          cb.current.onSpeed({ fps: Math.round(frames * 1000 / (now - t0)), worst: Math.round(worst), ms: (st.ms + st.js - s0.ms - s0.js) / n, calls: st.calls, tris: st.tris })
          frames = 0; worst = 0; t0 = now; s0 = { frames: st.frames, ms: st.ms, js: st.js }
        }
        if (shownRef.current.meter && activeRef.current && !document.hidden) map.triggerRepaint()
      })
      map.on('error', (ev) => { const m = (ev as { error?: Error }).error?.message ?? ''; if (/token|401|403|Unauthorized|Forbidden/i.test(m)) cb.current.onState('Mapbox refused the token') })
      map.on('moveend', () => { const p = map.getCenter(); try { sessionStorage.setItem(key, JSON.stringify({ center: [p.lng, p.lat], zoom: map.getZoom() - up, pitch: map.getPitch(), bearing: map.getBearing() })) } catch { /* storage blocked */ } })
      map.on('click', (ev) => {
        const p = ev.lngLat, d = (lng: number, lat: number) => Math.hypot((lng - p.lng) * kx, (lat - p.lat) * 111320)
        let st = '', bd = 45; for (const x of e.air.stands) { const m = d(x.lng, x.lat); if (m < bd) { bd = m; st = x.ref } }
        let tw = '', bt = 40
        for (const nd of e.air.nodes.values()) for (const q of nd.edges) {
          const b = e.air.nodes.get(q.to); if (!b || !q.taxiway) continue
          const ax = (nd.lng - p.lng) * kx, ay = (nd.lat - p.lat) * 111320, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * 111320, dx = bx - ax, dy = by - ay
          const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1))), m = Math.hypot(ax + dx * t, ay + dy * t)
          if (m < bt) { bt = m; tw = q.taxiway }
        }
        ;(map.getSource('spot') as mapboxgl.GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })
        cb.current.onSpot([icao, st && `gate ${st}`, tw && `taxiway ${tw}`, `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`].filter(Boolean).join(' · '))
      })
      apis.current[icao] = { fit: () => map.easeTo({ ...whole, duration: 900 }), air: icao, stands: e.gates.length, planes: 0 }
      // aircraft models and textures arrive on their own time: a few redraws a second pick them up
      const pump = window.setInterval(() => { if (!activeRef.current || !ready) return; cb.current.onState(map.areTilesLoaded() ? 'All loaded' : 'Loading buildings'); if (!document.hidden) map.triggerRepaint() }, 500)
      ;(window as unknown as { __mbxMap?: unknown }).__mbxMap = map
      const noKeys = flyKeys(map, { may: () => activeRef.current })   // (the slider and the ticks do not use letters)
      return () => { noKeys(); window.clearInterval(pump); ro.disconnect(); L.traffic?.dispose(); map.remove(); live.current = null; delete apis.current[icao] }
    }
    return () => { dead = true; off?.() }
  }, [icao, apis])

  return <div ref={box} className={s.map} data-on={active || undefined}><div ref={host} className={s.host} /></div>
}
