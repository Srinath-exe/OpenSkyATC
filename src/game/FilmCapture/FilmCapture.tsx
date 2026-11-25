'use client'
/*
  /lab/film: the landing film's 3D part recorded from the game's own Mapbox map. Not a page for people: film/mbx-capture.cjs
  opens it in a browser, injects the film's script (film/scene.js bundled as window.FilmScene) and its data (jfk.json as
  window.__J), then steps window.__film.go(i) through the frames and screenshots each one.
  - airport: the game's KSFO data (the sim loaded with no traffic and paused) -> our ground, stands, jet bridges, lights
  - traffic: the film script's poses (film units: 10 m, x east, z south of its reference point) -> the game's frame
  - camera: the script's eye / target / vertical lens -> Mapbox's free camera and (horizontal) field of view
  - "follow the greens": each taxiway's centreline lights come on as the controller names it (the script's greens()),
    and the departure's red stop bar - drawn in the 3D scene, so the aircraft hide what is under them
*/
import * as React from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { sim, useSim } from '@/components/atc/simStore'
import { MAPBOX_TOKEN } from '@/components/atc/MapboxMap/engine'
import { addAirportLayers, trafficLayer, type TrafficSource } from '@/components/atc/MapboxMap/layers'
import { loadAircraftModel } from '@/components/atc/WorldMap/models'

type V3 = [number, number, number]
interface Pose { id: string; cs: string; type: string; x: number; y: number; z: number; hdg: number; pitch: number; bank: number; ft: number; holding: boolean; leg: number; kind: string }
interface Instr { pts: number[][]; cum: number[]; L: number }
interface FilmScene { makeScene(J: unknown): { AC: Array<{ id: string; cs: string; type: string }>; INSTR: Instr[]; greens(I: Instr, f: number): { from: number; to: number; bar: boolean } | null; HOLD: { c: number[]; n: number[] } | null; aircraftAt(f: number): Pose[]; camera(f: number): { eye: V3; tgt: V3; fov: number }; knobs(f: number): Record<string, number>; PARK: Array<{ type: string; x: number; z: number; hdg: number }> }; LEN: Record<string, number>; SPAN: Record<string, number>; SUB: number; N: number }
type Win = Window & { FilmScene?: FilmScene; __J?: { lat0: number; lon0: number }; __film?: { ready: boolean; n: number; sub: number; go(i: number): Promise<void> } }

export function FilmCapture() {
  const host = React.useRef<HTMLDivElement>(null)
  const hasEngine = useSim((st) => !!st.engine)
  const [msg, setMsg] = React.useState('loading')

  React.useEffect(() => {
    void sim.load({ icao: 'KSFO', seed: 1, spawn: 'none', position: 'tower', naming: 'real' } as never)
    return () => { sim.stop() }
  }, [])

  React.useEffect(() => {
    if (!hasEngine || !host.current) return
    const w = window as Win
    let map: mapboxgl.Map | null = null, dead = false
    const boot = () => {
      if (dead) return
      if (!w.FilmScene || !w.__J) { setTimeout(boot, 200); return }
      sim.setPaused(true)
      const e = sim.engine!; const air = { air: e.air, proj: e.proj }
      const F = w.FilmScene, J = w.__J, S = F.makeScene(J)
      // ?bld=0: no 3D buildings or trees (the recorder's second pass: the difference is the buildings' matte); ?greens: route lights
      const Q = new URLSearchParams(location.search)
      const KX = 111320 * Math.cos((J.lat0 * Math.PI) / 180), KY = 110574
      const ll = (x: number, z: number): [number, number] => [J.lon0 + (x * 10) / KX, J.lat0 - (z * 10) / KY]
      const xy = (x: number, z: number) => { const [lng, lat] = ll(x, z); return e.proj.toXY(lat, lng) }
      const idOf = new Map(S.AC.map((a, i) => [a.id, i + 1]))
      const deg = (r: number) => (r * 180) / Math.PI
      const parked: TrafficSource['parked'] = S.PARK.map((p, k) => ({ id: 1000 + k, callsign: '', type: p.type, pos: xy(p.x, p.z), heading: deg(p.hdg) }))
      let cur: TrafficSource = { aircraft: [], parked }
      // the greens: centreline lights every 15 m along the lit part of each route, and the stop bar across the departure's hold
      const along = (I: Instr, s: number): [number, number] => {
        let i = 1; while (i < I.cum.length - 1 && I.cum[i] < s) i++
        const a = I.pts[i - 1], b = I.pts[i], t = Math.min(1, Math.max(0, (s - I.cum[i - 1]) / ((I.cum[i] - I.cum[i - 1]) || 1)))
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      }
      const greens = (f: number): NonNullable<TrafficSource['groundLights']> => {
        const out: NonNullable<TrafficSource['groundLights']> = []
        for (const I of S.INSTR) {
          const g = S.greens(I, f); if (!g) continue
          for (let s = Math.ceil(g.from / 1.5) * 1.5; s <= g.to; s += 1.5) { const [x, z] = along(I, s); out.push({ pos: xy(x, z), color: [0.25, 1, 0.45] }) }
          if (g.bar && S.HOLD) for (let k = -3; k <= 3; k++) out.push({ pos: xy(S.HOLD.c[0] + S.HOLD.n[0] * k * 0.35, S.HOLD.c[1] + S.HOLD.n[1] * k * 0.35), color: [1, 0.12, 0.1] })
        }
        return out
      }
      const poses = (f: number): TrafficSource['aircraft'] => S.aircraftAt(f).map((s) => ({
        id: idOf.get(s.id) ?? 999, callsign: s.cs, phase: s.kind === 'arr' && s.holding && s.y < 0.3 ? 'arrived' : 'taxi', pos: xy(s.x, s.z),
        altitude: Math.max(0, s.ft), heading: deg(s.hdg), pitch: deg(s.pitch || 0), bank: deg(s.bank || 0),
        perf: { icaoCode: s.type, lengthMeters: (F.LEN[s.type] ?? 4) * 10, wingspanMeters: (F.SPAN[s.type] ?? 4) * 10 },
      }))
      // every model the film shows, loaded up front: a model met for the first time mid-take would miss its first frame
      const want = new Set<string>([...S.AC.map((a) => `${a.type}|${a.cs}`), ...S.PARK.map((p) => `${p.type}|`)])
      void Promise.all([...want].map((k) => { const [t, cs] = k.split('|'); return loadAircraftModel(t, cs || undefined) }))

      mapboxgl.accessToken = MAPBOX_TOKEN
      const c0 = e.air.center
      map = new mapboxgl.Map({
        container: host.current!, style: 'mapbox://styles/mapbox/standard', center: [c0.lng, c0.lat], zoom: 14, pitch: 60, maxPitch: 85,
        antialias: true, pixelRatio: window.devicePixelRatio || 1,   // the recorder's device scale: 1.6 -> 2560 x 1440 frames fadeDuration: 0, attributionControl: true, performanceMetricsCollection: false, maxTileCacheSize: 2000,
        config: { basemap: { lightPreset: 'night', show3dObjects: Q.get('bld') !== '0', show3dTrees: Q.get('bld') !== '0', showPointOfInterestLabels: false, showTransitLabels: false, showPlaceLabels: false, showRoadLabels: false, showPedestrianRoads: false, showAdminBoundaries: false } },
      } as mapboxgl.MapOptions)
      const m = map
      m.on('style.load', () => {
        addAirportLayers(m, air, { classicGround: true })
        for (const id of ['ap-twy', 'ap-stands', 'ap-rwy']) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', 'none')
        const t = trafficLayer(air, { classicGround: true, modelPx: 14, fps: 60, source: () => cur, pxScale: window.devicePixelRatio || 1 }); m.addLayer(t.layer); t.setLight('night')
        const idle = () => new Promise<void>((r) => { let done = false; const fin = () => { if (!done) { done = true; r() } }; m.once('idle', fin); setTimeout(fin, 20000) })
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        w.__film = {
          ready: true, n: F.N * F.SUB, sub: F.SUB,
          async go(i: number) {
            const f = i / F.SUB
            cur = { aircraft: poses(f), parked, groundLights: Q.has('greens') ? greens(f) : [] }
            // the camera: lens first (Mapbox's is horizontal), then the eye and where it looks (the ground point on the
            // line of sight - the script keeps it at least 5.5 degrees below level, so the line always meets the ground)
            const c = S.camera(f), aspect = m.getCanvas().width / m.getCanvas().height
            ;(m as unknown as { transform: { fov: number } }).transform.fov = Math.min(60, (2 * Math.atan(Math.tan(((c.fov * Math.PI) / 180) / 2) * aspect) * 180) / Math.PI)
            const dy = c.eye[1] - c.tgt[1], s = dy > 1e-3 ? c.eye[1] / dy : 50
            const g: [number, number] = [c.eye[0] + (c.tgt[0] - c.eye[0]) * s, c.eye[2] + (c.tgt[2] - c.eye[2]) * s]
            const cam = m.getFreeCameraOptions()
            cam.position = mapboxgl.MercatorCoordinate.fromLngLat(ll(c.eye[0], c.eye[2]), c.eye[1] * 10)
            cam.lookAtPoint(ll(g[0], g[1]))
            m.setFreeCameraOptions(cam)
            t.kick(); await idle(); await frame()
            t.kick(); await frame(); await frame()          // (models that finished loading during the first pass)
          },
        }
        setMsg('')
      })
    }
    boot()
    return () => { dead = true; map?.remove() }
  }, [hasEngine])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }} data-testid="film-capture">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {msg ? <div style={{ position: 'absolute', left: 12, top: 12, color: '#888', font: '12px monospace' }}>{msg}</div> : null}
    </div>
  )
}
