'use client'
/*
  The ground / tower view on a Mapbox Standard map (the default; Settings > Graphics > Map). Held to the airport
  (look.ts: the camera stays in a box round the field, zoom and tilt limited, the airport's tiles kept in memory). The same contract as the classic
  three.js WorldMap: click to select, hover, right-click for the aircraft's actions, follow / centre / zoom / reset,
  the store's projector (centre-on, the test API), the selected flight's taxi route, data blocks, time of day (auto
  from the sim's clock), the sim's weather (fog, rain, snow) and the tutorial's cues (camera flights, lit routes, marks).
*/
import * as React from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type * as GeoJSON from 'geojson'
import { sim, useSim } from '@/components/atc/simStore'
import { worldSound } from '@/components/atc/worldSound'
import { cameraDistance } from '@/lib/audio/soundscape'
import { IconButton, Segmented, Icon, Tooltip } from '@/design'
import { requestOpenAction } from '@/game/CommandPanel/bus'
import { sunPosition } from '@/components/atc/WorldMap/sky'
import { TUTOR_EVENT, markListening } from '@/components/atc/WorldMap/tutor'
import type { Cue } from '@/game/Tutorial/lessons'
import type { XY } from '@/lib/sim/projection'
import { MAPBOX_TOKEN } from './engine'
import { MapCover } from '@/components/atc/PixelLanding'
import { detectTier, getGraphicsPref, publishDetected, type Tier } from '@/components/atc/WorldMap/quality'
import { relabel, EMPTY, addAirportLayers, addGameLayers, lightFor, trafficLayer, type Light, type TrafficLayer } from './layers'
import { freshPose, lockPose, unlockPose, viewPose } from '@/components/atc/viewPose'
import { ground } from '@/components/atc/WorldMap/groundTex'
import { cloudGate, wheelPush } from '@/components/atc/cloudGate'
import { flyKeys } from './flyKeys'
import { isEditableTarget, isPickerTarget } from '@/game/hooks/useHotkeys'
import { actionForChord, bindChord } from '@/game/keybindings'
import { AIRPORT_LOCK, TILE_CACHE, airportBounds, cityTrimmer, hideHighways } from './look'
import styles from '@/components/atc/WorldMap/WorldMap.module.css'
import { TimeWheel, ToolButton, ToolGroup, ICON, toolsClass, forcedTimeOfDay } from './MapTools'

type TimeMode = 'auto' | 'day' | 'dusk' | 'night'
type MenuState = { x: number; y: number; id: number; callsign: string; rows: { id: string; label: string; hotkey: string | null }[] }
const HOME = { zoom: 15.7, pitch: 58, bearing: -45 }
/** The Tower <-> Approach passage through the clouds (GameShell, CloudVeil): set before the map mounts behind the clouds
 *  on the way back from the radar, so it opens high over the field and flies down when the clouds open. */
export const viewIntro = { fromRadar: false }
/** toRadar: climb away; toGround: the map (kept) goes high over the field behind the clouds; open: fly down to it. */
export const VIEW_EVENT = 'atc-view-transition', MAP_READY_EVENT = 'atc-map-ready'
const HIGH = { zoom: 13.1, pitch: 18, bearing: -45 }
const easeInQuad = (t: number) => t * t, easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
/** Cost per quality tier (Settings > Graphics): redraw rate while traffic moves, when the detailed aircraft appear. */
// (the map is always drawn at the screen's own sharpness and always with its 3D buildings: both are what the game looks like)
const TIERS: Record<Tier, { aa: boolean; fps: number; modelPx: number; trees: boolean; shadows: boolean }> = {
  ultra: { aa: true, fps: 60, modelPx: 22, trees: true, shadows: true },
  // (High keeps Mapbox's own light and shadows: the flat light washed the map out and the 3D buildings lost their depth)
  high: { aa: true, fps: 40, modelPx: 36, trees: false, shadows: true },
  medium: { aa: true, fps: 30, modelPx: 48, trees: false, shadows: true },
  low: { aa: true, fps: 20, modelPx: 64, trees: false, shadows: false },
}
/** Mapbox Standard's light presets without its real-time shadows (one shadow map less per frame): Medium and Low. */
const FLAT_LIGHTS: Record<Light, { amb: string; ai: number; dir: string; di: number; az: number; pol: number }> = {
  day: { amb: 'hsl(0, 0%, 100%)', ai: 0.78, dir: 'hsl(0, 0%, 100%)', di: 0.55, az: 210, pol: 32 },
  dawn: { amb: 'hsl(28, 24%, 84%)', ai: 0.66, dir: 'hsl(32, 60%, 82%)', di: 0.45, az: 110, pol: 14 },
  dusk: { amb: 'hsl(236, 12%, 70%)', ai: 0.6, dir: 'hsl(28, 52%, 76%)', di: 0.4, az: 250, pol: 12 },
  night: { amb: 'hsl(222, 40%, 34%)', ai: 0.42, dir: 'hsl(222, 40%, 62%)', di: 0.18, az: 200, pol: 40 },
}

/** Parked aircraft drawn with every saving on (parked.ts). */
const PARKED_FX = { group: true, still: true, share: true, gentle: true }

export function MapboxMap({ hidden = false }: { hidden?: boolean }) {
  const hiddenRef = React.useRef(hidden); const onHidden = React.useRef<(on: boolean) => void>(() => {})
  React.useEffect(() => { hiddenRef.current = hidden; onHidden.current(hidden) }, [hidden])
  const host = React.useRef<HTMLDivElement>(null)
  const icao = useSim((s) => s.icao)
  const hasEngine = useSim((s) => !!s.engine)
  const selectedId = useSim((s) => s.selectedId)
  const naming = useSim((s) => s.engine?.naming); const onNaming = React.useRef<() => void>(() => {})
  React.useEffect(() => { onNaming.current() }, [naming])
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = React.useState('')
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const [following, setFollowing] = React.useState(false)
  const [showLabels, setShowLabels] = React.useState(true)
  const [timeMode, setTimeMode] = React.useState<TimeMode>(() => { const f = forcedTimeOfDay(); if (f) return f; try { return (localStorage.getItem('skycontrol_world_time') as TimeMode) || 'auto' } catch { return 'auto' } })
  const ctl = React.useRef<{ zoom(f: number): void; reset(): void; follow(on: boolean): void; centre(): void } | null>(null)
  const labelsEl = React.useRef<HTMLDivElement>(null)
  const followRef = React.useRef(false); const labelsRef = React.useRef(true); const timeRef = React.useRef<TimeMode>(timeMode)
  const applyLabels = React.useRef<() => void>(() => {})
  React.useEffect(() => { labelsRef.current = showLabels; applyLabels.current() }, [showLabels])
  React.useEffect(() => { timeRef.current = timeMode; if (forcedTimeOfDay()) return; try { localStorage.setItem('skycontrol_world_time', timeMode) } catch { /* storage blocked */ } }, [timeMode])

  React.useEffect(() => {
    if (!hasEngine || !host.current) return
    // (the engine can be gone again by the time this runs: another airport being loaded. The next one mounts the map)
    const e = sim.engine; if (!e) return; const air = { air: e.air, proj: e.proj }
    const el = host.current
    mapboxgl.accessToken = MAPBOX_TOKEN
    const det = detectTier(); publishDetected(det)
    const pref = getGraphicsPref(); const tier: Tier = pref === 'auto' ? det.tier : pref; const q = TIERS[tier]
    const c = e.air.center
    const st = e.air.stands; const home: [number, number] = st.length ? [st.reduce((a, x) => a + x.lng, 0) / st.length, st.reduce((a, x) => a + x.lat, 0) / st.length] : [c.lng, c.lat]
    const map = new mapboxgl.Map({
      container: el, style: 'mapbox://styles/mapbox/standard', center: home, ...HOME, antialias: q.aa, fadeDuration: 0, attributionControl: true, performanceMetricsCollection: false,
      maxBounds: airportBounds(air), ...AIRPORT_LOCK, maxTileCacheSize: TILE_CACHE,
      config: { basemap: { lightPreset: 'day', show3dObjects: true, show3dBuildings: true, show3dLandmarks: true, show3dTrees: q.trees, showPointOfInterestLabels: false, showTransitLabels: false, showPlaceLabels: true, showRoadLabels: false, showPedestrianRoads: false, showAdminBoundaries: false } },
    } as mapboxgl.MapOptions)
    // the game shell sizes the map area after mount and whenever panels open or close; Mapbox only watches the window
    const ro = new ResizeObserver(() => map.resize()); ro.observe(el)
    const w = window as unknown as { __mbx?: { map: mapboxgl.Map; ready: boolean } }
    w.__mbx = { map, ready: false }
    let traffic: TrafficLayer | null = null
    let ready = false, light: Light | null = null, disposed = false, wxKey = '', wxRain = false, wxSnow = false
    const ll = (p: XY): [number, number] => { const q = e.proj.toLngLat(p.x, p.y); return [q.lng, q.lat] }
    // where to centre the map so an aircraft in the air sits in the middle: the camera looks at the ground, and a point
    // h metres up shows over the ground h*tan(pitch) further along the view
    const aimAt = (p: XY, altFt: number, pitchDeg: number, bearingDeg: number): XY => { const d = Math.max(0, altFt) * 0.3048 * Math.tan(Math.min(80, pitchDeg) * Math.PI / 180), b = bearingDeg * Math.PI / 180; return { x: p.x + d * Math.sin(b), y: p.y + d * Math.cos(b) } }
    const mpp = () => 40075016 * Math.cos(c.lat * Math.PI / 180) / (512 * 2 ** map.getZoom())
    const src = (id: string) => map.getSource(id) as mapboxgl.GeoJSONSource | undefined

    // ── picking: nearest aircraft whose projected footprint (or an 18 px halo) covers the pointer ──
    const pick = (pt: { x: number; y: number }): number | null => {
      let best: number | null = null, bd = Infinity; const m = mpp()
      for (const a of e.aircraft) {
        if (a.phase === 'departed') continue
        const s = map.project(ll(a.pos)); const d = Math.hypot(s.x - pt.x, s.y - pt.y)
        const r = Math.max(18, a.perf.lengthMeters / m * 0.55)
        if (d < r && d < bd) { bd = d; best = a.id }
      }
      return best
    }
    map.on('mousemove', (ev) => { const id = pick(ev.point); if (id !== sim.hoveredId) sim.hover(id); map.getCanvas().style.cursor = id != null ? 'pointer' : '' })
    map.on('mouseout', () => { if (sim.hoveredId != null) sim.hover(null) })
    map.on('click', (ev) => { const id = pick(ev.point); sim.select(id); setMenu(null); if (id == null) setFollow(false) })
    map.on('contextmenu', (ev) => {
      const id = pick(ev.point); const a = id != null ? e.byId(id) : null
      if (!a) { setMenu(null); return }
      sim.select(a.id)
      let rows: MenuState['rows'] = []
      try { rows = sim.actionsFor(a).filter((x) => x.state === 'enabled').slice(0, 7).map((x) => ({ id: x.id, label: x.label, hotkey: x.hotkey })) } catch { rows = [] }
      setMenu({ x: ev.point.x, y: ev.point.y, id: a.id, callsign: a.callsign, rows })
    })
    map.on('dragstart', () => { setFollow(false); setMenu(null) })
    // zooming out past the whole field pushes up into the clouds (cloudGate): wheel, and a two-finger pinch
    // (the airport box can stop the zoom before minZoom does: "at the limit" is also "scrolling out and nothing moves")
    let stuckZ = NaN, stuckAt = 0
    const atTop = () => ready && !hiddenRef.current && (map.getZoom() <= AIRPORT_LOCK.minZoom + 0.06 || (stuckAt > 0 && performance.now() - stuckAt > 160 && Math.abs(map.getZoom() - stuckZ) < 0.004))
    const onWheel = (ev: WheelEvent) => {
      if (ev.deltaY <= 0) { stuckAt = 0; return }
      const z = map.getZoom(), now = performance.now()
      if (!stuckAt || Math.abs(z - stuckZ) >= 0.004 || z > 14.2) { stuckZ = z; stuckAt = now }
      if (atTop()) cloudGate.push('out', wheelPush(ev))
    }
    let pinch = 0
    const onTouch = (ev: TouchEvent) => {
      if (ev.touches.length !== 2) { pinch = 0; return }
      const d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY)
      if (pinch && d < pinch && atTop()) cloudGate.push('out', (pinch - d) / 170)
      pinch = d
    }
    el.addEventListener('wheel', onWheel, { passive: true }); el.addEventListener('touchmove', onTouch, { passive: true }); el.addEventListener('touchend', onTouch, { passive: true })

    // ── camera controls, the store's projector ──
    const setFollow = (on: boolean) => { followRef.current = on && sim.selectedId != null; setFollowing(followRef.current) }
    ctl.current = {
      zoom: (f) => f > 1 && atTop() ? cloudGate.push('out', 0.5) : map.easeTo({ zoom: map.getZoom() - Math.log2(f), duration: 350 }),
      reset: () => { setFollow(false); map.flyTo({ center: home, ...HOME, duration: 1200 }) },
      follow: (on) => setFollow(on),
      centre: () => { const a = sim.selectedId != null ? e.byId(sim.selectedId) : null; if (a) map.easeTo({ center: ll(a.pos), duration: 700 }) },
    }
    const unregister = sim.registerProjector('ground',
      (xy, altFt = 0) => { const s = map.project(ll(altFt > 0 ? aimAt(xy, altFt, map.getPitch(), map.getBearing()) : xy)); return { x: s.x, y: s.y } },
      (xy) => map.flyTo({ center: ll(xy), zoom: Math.max(map.getZoom(), 15.2), duration: 900, essential: true }),   // to it, close enough to see it
      () => ({ lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() }) as never,
      {
        size: () => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height } },
        // fit points in view clear of the flight board (left), the flight card (right), the top bar and the radio bar
        frame: (pts: XY[], o?: { bearing?: number }) => {
          setFollow(false)
          const r = el.getBoundingClientRect(), lls = pts.map(ll)
          const b = new mapboxgl.LngLatBounds(lls[0] as [number, number], lls[0] as [number, number]); for (const p of lls) b.extend(p as [number, number])
          const padding = { left: Math.min(380, r.width * 0.26), right: Math.min(400, r.width * 0.27), top: 120, bottom: 170 }
          const cam = map.cameraForBounds(b, { padding, bearing: o?.bearing ?? map.getBearing(), pitch: map.getPitch(), maxZoom: 17.2 })
          if (cam) map.flyTo({ ...cam, bearing: o?.bearing ?? map.getBearing(), pitch: map.getPitch(), duration: 1000, essential: true })
        },
      } as never)

    // W A S D Q E fly the camera while no flight is selected (with one selected the letters are its calls)
    const noKeys = flyKeys(map, { onStart: () => setFollow(false), may: (ev) => { if (!ready || hiddenRef.current || sim.selectedId != null || isEditableTarget(ev.target) || isPickerTarget(ev.target)) return false; const bc = bindChord(ev); return !(bc && actionForChord(bc)) } })

    // ── the tutorial's cues ──
    const tRoutes = new Map<string, GeoJSON.Feature>(), tMarks = new Map<string, GeoJSON.Feature>()
    const pushTutor = () => { src('g-tutor-route')?.setData({ type: 'FeatureCollection', features: [...tRoutes.values()] }); src('g-tutor-mark')?.setData({ type: 'FeatureCollection', features: [...tMarks.values()] }) }
    const zoomForDist = (d: number) => Math.log2(40075016 * Math.cos(c.lat * Math.PI / 180) / 512 * el.clientHeight / Math.max(60, d * 1.15))
    const onTutor = (ev: Event) => {
      const q = (ev as CustomEvent<Cue>).detail
      if (q.kind === 'camera') {
        setFollow(false)
        const pitch = Math.max(0, Math.min(78, 90 - (q.pitch ?? 0.9) * 180 / Math.PI)), bearing = q.yaw != null ? -q.yaw * 180 / Math.PI : map.getBearing()
        const fa = q.follow != null ? e.byId(q.follow) : null
        const to = ll(fa ? aimAt(fa.pos, fa.altitude, pitch, bearing) : q.at)
        map.flyTo({ center: to, zoom: zoomForDist(q.dist), pitch, bearing, duration: q.ms ?? 1600, essential: true })
        if (q.follow != null) map.once('moveend', () => { sim.select(q.follow!); setFollow(true) })
      } else if (q.kind === 'route') {
        tRoutes.set(q.id, { type: 'Feature', properties: { color: q.color ?? '#3bea7a' }, geometry: { type: 'LineString', coordinates: q.pts.map(ll) } }); pushTutor()
      } else if (q.kind === 'mark') {
        tMarks.set(q.id, { type: 'Feature', properties: { label: q.label, tone: q.tone }, geometry: { type: 'Point', coordinates: ll(q.at) } }); pushTutor()
      } else if (q.kind === 'clear') {
        if (q.id) { tRoutes.delete(q.id); tMarks.delete(q.id) } else { tRoutes.clear(); tMarks.clear() }
        pushTutor()
      }
    }
    const onRepaint = () => map.triggerRepaint(); window.addEventListener('skycontrol:repaint', onRepaint)   // a report's screenshot reads the canvas in its own frame
    window.addEventListener(TUTOR_EVENT, onTutor); (window as unknown as { __mbxMap?: unknown }).__mbxMap = map   // (headless checks read the camera)

    // the passage through the clouds (GameShell times it): climb away from the field; come back in high above it; fly down
    const goHigh = () => { setFollow(false); map.stop(); map.jumpTo({ center: home, ...HIGH }) }
    const flyDown = () => { map.flyTo({ center: home, ...HOME, duration: 2300, curve: 1.1, easing: easeOutCubic, essential: true }) }
    const onView = (ev: Event) => {
      const k = (ev as CustomEvent<string>).detail
      if (!ready) return
      if (k === 'toRadar') {
        setFollow(false); setMenu(null)
        map.easeTo({ zoom: Math.max(AIRPORT_LOCK.minZoom, Math.min(map.getZoom() - 0.4, HIGH.zoom)), pitch: 18, duration: 1500, easing: easeInQuad, essential: true })
      } else if (k === 'toGround') {
        goHigh(); let said = false
        const say = () => { if (said || disposed) return; said = true; window.dispatchEvent(new CustomEvent(MAP_READY_EVENT)) }
        map.once('idle', say); window.setTimeout(say, 1200)      // its tiles are in memory
      } else if (k === 'open') flyDown()
    }
    // the eye: every name on the map (flight tags, taxiways, stands, runways, places), not only the tags
    applyLabels.current = () => {
      if (!ready) return
      const on = labelsRef.current
      for (const id of ['ap-twy', 'ap-stands', 'ap-rwy']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
      try { map.setConfigProperty('basemap', 'showPlaceLabels', on) } catch { /* the style has no such switch */ }
    }
    // other names (lib/sim/naming.ts): the labels and the numbers on the stands; nothing else is drawn again
    let named = e.naming
    onNaming.current = () => { if (!ready || e.naming === named) return; named = e.naming; relabel(map, air); traffic?.rename() }
    onHidden.current = (on) => { traffic?.setHidden(on); if (ready) markListening(!on) }
    window.addEventListener(VIEW_EVENT, onView)
    map.on('style.load', () => {
      if (disposed) return
      addAirportLayers(map, air, { classicGround: true })
      addGameLayers(map)
      traffic = trafficLayer(air, { fps: q.fps, classicGround: true, textures: tier !== 'low', modelPx: q.modelPx, parkedFx: () => PARKED_FX })
      map.addLayer(traffic.layer)
      // the city's buildings away from the field are left out, and those seen from afar cast no shadows: most of a frame's cost
      cityTrimmer(map, air)(true); hideHighways(map, air.air.icao)
      try { map.setPaintProperty('ap-buildings', 'fill-extrusion-cast-shadows', false) } catch { /* an older style */ }
      ready = true; w.__mbx!.ready = true; markListening(true)
      setStatus('ready'); applyLight(true); onNaming.current()
      // Approach -> Tower, freshly mounted behind the clouds: high over the field until the tiles are in (flyDown on 'open')
      if (viewIntro.fromRadar) {
        viewIntro.fromRadar = false; goHigh(); let said = false
        const say = () => { if (said || disposed) return; said = true; window.dispatchEvent(new CustomEvent(MAP_READY_EVENT)) }
        map.once('idle', say); window.setTimeout(say, 4000)
      }
      if (hiddenRef.current) onHidden.current(true)
      if (!labelsRef.current) applyLabels.current()
    })
    map.on('error', (ev) => { const msg = (ev as { error?: Error }).error?.message ?? ''; if (/token|401|403|Unauthorized|Forbidden/i.test(msg)) { setStatus('error'); setError('Mapbox refused the token') } })

    // ── light and weather from the sim (every 2 s) ──
    const applyLight = (force = false) => {
      if (!ready) return
      const mode = timeRef.current
      let want: Light
      if (mode === 'auto') { const sp = sunPosition((sim.sessionStartedAt || Date.now()) + e.time * 1000, c.lat, c.lng); want = lightFor(sp.elevation, sp.azimuth) } else want = mode === 'dusk' ? 'dusk' : mode
      if (want !== light || force) {
        light = want; cloudGate.light = want; map.setConfigProperty('basemap', 'lightPreset', want); traffic?.setLight(want)
        if (!q.shadows) { const f = FLAT_LIGHTS[want]; map.setLights([{ id: 'amb', type: 'ambient', properties: { color: f.amb, intensity: f.ai } }, { id: 'sun', type: 'directional', properties: { color: f.dir, intensity: f.di, direction: [f.az, f.pol], 'cast-shadows': false } }] as mapboxgl.LightsSpecification[]) }
      }
      try {
        const wx = e.wx(); const vis = wx?.visM ?? 10000
        const m = map as unknown as { setRain?: (o: unknown) => void; setSnow?: (o: unknown) => void }
        const rain = wx?.precip === 'rain' || wx?.precip === 'freezing' ? 0.8 : wx?.precip === 'drizzle' ? 0.35 : 0, snow = wx?.precip === 'snow'
        ground.wet.value = rain > 0 ? Math.min(1, 0.4 + rain) : 0
        const wkey = `${light}|${Math.round(vis / 500)}|${rain}|${snow}`
        if (wkey === wxKey && !force) return
        const hadRain = wxRain, hadSnow = wxSnow; wxKey = wkey; wxRain = rain > 0; wxSnow = snow
        map.setFog({ range: [Math.max(0.3, vis / 4000), Math.max(2, vis / 1000)], color: light === 'night' ? '#0b1020' : '#dfe6ee', 'horizon-blend': vis < 3000 ? 0.3 : 0.08 } as mapboxgl.FogSpecification)
        // precipitation is a full-screen effect: only switched on while it falls, and only switched off once
        if (rain || hadRain) m.setRain?.(rain ? { density: rain, intensity: rain, opacity: 0.5, vignette: 0.3 } : { density: 0, intensity: 0 })
        if (snow || hadSnow) m.setSnow?.(snow ? { density: 0.8, intensity: 0.8 } : { density: 0, intensity: 0 })
      } catch { /* weather effects are optional */ }
    }
    const lightTimer = window.setInterval(() => applyLight(), 5000)

    // ── per frame: follow; ~6 Hz: data blocks, rings, the selected route ──
    let raf = 0, lastFollow = 0, wasPaused = true, standKey = '', drawn = true, lastLabels = 0
    map.on('render', () => { drawn = true })
    const labelEls = new Map<number, HTMLDivElement>()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!ready || document.hidden || hiddenRef.current) return
      if (wasPaused && !sim.paused) traffic?.kick()
      wasPaused = sim.paused
      const selA = sim.selectedId != null ? e.byId(sim.selectedId) : null
      // a selected arrival on the ground: its stand ringed and named (magenta, like the route to it)
      { const st = selA && selA.plan.kind === 'arrival' && selA.altitude < 30 && selA.phase !== 'arrived' ? (selA.reservedStand ?? selA.plan.gateRef) : null
        const key = st ? `${selA!.id}|${st}` : ''
        if (key !== standKey) { standKey = key; const g = st ? e.gateByRef(st) : null
          src('g-stand')?.setData({ type: 'FeatureCollection', features: g ? [{ type: 'Feature', properties: { label: `Stand ${g.ref}` }, geometry: { type: 'Point', coordinates: ll(e.gateXY(g)) } }] : [] }) } }
      // locked on: the camera and the aircraft are drawn from the same position, every frame (viewPose.ts)
      if (followRef.current && selA) {
        if (now - lastFollow >= (q.fps >= 40 ? 0 : 1000 / Math.max(30, q.fps) - 4)) {
          lastFollow = now; const vp = freshPose(e, selA); lockPose(selA.id, vp)
          const cur = map.getCenter(); const [lng, lat] = ll(aimAt(vp, vp.alt, map.getPitch(), map.getBearing()))
          map.jumpTo({ center: Math.hypot(lng - cur.lng, lat - cur.lat) < 0.004 ? [lng, lat] : [cur.lng + (lng - cur.lng) * 0.25, cur.lat + (lat - cur.lat) * 0.25] })   // eased only to catch up from far
        }
      } else unlockPose()
      // labels and the ear only move when the map was drawn (and ten times a second for what is typed on them)
      if (!drawn && now - lastLabels < 100) return
      drawn = false; lastLabels = now
      // the aircraft labels, every frame, as plain elements over the map: no Mapbox placement pass (that re-ran for every
      // label four times a second, so they stepped behind the aircraft, faded out and in and traded places)
      // the ear follows the camera
      { const cc = map.getCenter(), xy = e.proj.toXY(cc.lat, cc.lng); worldSound.ear = { x: xy.x, y: xy.y, bearing: map.getBearing(), pitch: map.getPitch(), distanceM: cameraDistance(map.getZoom(), cc.lat, host.current?.clientHeight ?? 900) } }
      const box = labelsEl.current
      if (box) {
        const live = new Set<number>(), pitch = map.getPitch(), bearing = map.getBearing(), W = box.clientWidth, H = box.clientHeight
        for (const a of e.aircraft) {
          if (a.phase === 'departed' || a.phase === 'arrived') continue
          const isSel = a.id === sim.selectedId, isHov = a.id === sim.hoveredId
          if (!labelsRef.current && !isSel) continue
          if (a.phase === 'parked' && !isSel && !isHov) continue
          const vp = viewPose(e, a), q = map.project(ll(vp.alt > 5 ? aimAt(vp, vp.alt, pitch, bearing) : vp))
          if (q.x < -120 || q.y < -60 || q.x > W + 40 || q.y > H + 60) continue
          live.add(a.id)
          let el = labelEls.get(a.id)
          if (!el) { el = document.createElement('div'); el.className = styles.acLabel; box.appendChild(el); labelEls.set(a.id, el) }
          const airborne = a.altitude > 5
          const line2 = airborne ? `${String(Math.round(a.altitude / 100)).padStart(3, '0')} ${Math.round(a.speed)}` : `${Math.round(a.speed)} kt`
          const mine = a.onFrequency === sim.position || sim.position === 'ground' || (sim.position === 'tower' && a.onFrequency === 'ground')
          const text = `${a.callsign} ${a.perf.icaoCode}\n${line2}`, st = isSel ? 'sel' : mine ? 'mine' : 'ghost'
          if (el.dataset.t !== text) { el.dataset.t = text; el.textContent = text }
          if (el.dataset.st !== st) el.dataset.st = st
          el.style.transform = `translate3d(${q.x.toFixed(1)}px, ${(q.y - 44).toFixed(1)}px, 0) translate(-50%, -100%)`   // above it, on its line (.acLabel::after)
        }
        for (const [id, el] of labelEls) if (!live.has(id)) { el.remove(); labelEls.delete(id) }
      }
      // (the ground routes are drawn by the traffic layer, under the aircraft: see layers.ts drawRoutes)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true; noKeys(); cancelAnimationFrame(raf); window.clearInterval(lightTimer); window.removeEventListener(TUTOR_EVENT, onTutor); window.removeEventListener('skycontrol:repaint', onRepaint); window.removeEventListener(VIEW_EVENT, onView)
      if (ready) markListening(false)
      el.removeEventListener('wheel', onWheel); el.removeEventListener('touchmove', onTouch); el.removeEventListener('touchend', onTouch)
      for (const l of labelEls.values()) l.remove()          // (the box outlives this map: a restarted shift left the old labels hanging)
      labelEls.clear(); unlockPose()
      ro.disconnect(); unregister(); traffic?.dispose(); map.remove(); ctl.current = null; delete w.__mbx
    }
  }, [hasEngine, icao])

  return (
    <div className={styles.root} data-testid="world-map" data-engine="mapbox" data-status={status} onContextMenu={(ev) => ev.preventDefault()}>
      <div ref={host} className={styles.canvasHost} style={{ position: 'absolute', inset: 0 }} data-testid="world-canvas" />
      <div ref={labelsEl} className={styles.acLabels} aria-hidden="true" />
      <MapCover icao={icao} open={status === 'loading'} step={hasEngine ? 'Laying out the airfield' : 'Loading the airport'} />
      {menu ? (
        <div className={styles.menu} style={{ left: Math.min(menu.x, (host.current?.clientWidth ?? 800) - 240), top: Math.min(menu.y, (host.current?.clientHeight ?? 600) - 40 * (menu.rows.length + 1)) }} data-testid="world-quick-menu" role="menu" onPointerDown={(ev) => ev.stopPropagation()}>
          <div className={styles.menuHead}>{menu.callsign}</div>
          {menu.rows.length ? menu.rows.map((r) => (
            <button key={r.id} type="button" role="menuitem" className={styles.menuRow} data-testid={`ctx-${r.id}`} onClick={() => { requestOpenAction({ aircraftId: menu.id, actionId: r.id as never }); setMenu(null) }}>
              <span>{r.label}</span>{r.hotkey ? <kbd>{r.hotkey}</kbd> : null}
            </button>
          )) : <div className={styles.menuEmpty}>No actions available</div>}
        </div>
      ) : null}
      <WindChip />
      <div className={toolsClass} data-testid="world-toolbar" onPointerDown={(ev) => ev.stopPropagation()}>
        <TimeWheel value={timeMode} onChange={setTimeMode} />
        <ToolGroup>
          <ToolButton icon={ICON.plus} label="Zoom in" onClick={() => ctl.current?.zoom(0.6)} testId="world-zoom-in" />
          <ToolButton icon={ICON.minus} label="Zoom out" onClick={() => ctl.current?.zoom(1.6)} testId="world-zoom-out" />
        </ToolGroup>
        <ToolGroup>
          <ToolButton icon={ICON.follow} label={following ? 'Stop following' : 'Follow the selected aircraft'} on={following} disabled={selectedId == null} onClick={() => ctl.current?.follow(!following)} testId="world-follow" />
          <ToolButton icon={ICON.centre} label="Centre on the selected aircraft" disabled={selectedId == null} onClick={() => ctl.current?.centre()} testId="world-centre" />
        </ToolGroup>
        <ToolGroup>
          <ToolButton icon={showLabels ? ICON.eye : ICON.eyeOff} label={showLabels ? 'Hide all labels' : 'Show labels'} on={!showLabels} onClick={() => setShowLabels((v) => !v)} testId="world-labels" />
          <ToolButton icon={ICON.home} label="Reset the view" onClick={() => ctl.current?.reset()} testId="world-reset" />
        </ToolGroup>
      </div>
      {status !== 'ready' ? <div className={styles.status} data-testid="world-status">{status === 'error' ? `${error}: switch the map back to Classic in Settings > Graphics` : 'Loading the map…'}</div> : null}
    </div>
  )
}

/** Wind and visibility chip (top-left), as on the classic map. */
function WindChip() {
  const wind = useSim((s) => { try { const w = s.engine?.wx(); return w ? { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt, vis: w.visM, cloud: w.cloud, precip: w.precip } : null } catch { return null } }, [])
  const mag = useSim((s) => s.engine?.magVar ?? 0)
  if (!wind) return null
  const dirMag = ((wind.dir - mag) % 360 + 360) % 360
  return (
    <div className={styles.windChip} data-testid="world-wind">
      <span className={styles.windArrow} style={{ transform: `rotate(${wind.dir + 180}deg)` }} aria-hidden="true">↑</span>
      <span className={styles.windText}>{String(Math.round(dirMag)).padStart(3, '0')}° · {Math.round(wind.kts)}{wind.gust ? `G${Math.round(wind.gust)}` : ''} kt</span>
      <span className={styles.windMeta}>{wind.vis >= 10000 ? '10 km+' : `${(wind.vis / 1000).toFixed(1)} km`} · {wind.cloud}{wind.precip !== 'none' ? ` · ${wind.precip}` : ''}</span>
    </div>
  )
}
