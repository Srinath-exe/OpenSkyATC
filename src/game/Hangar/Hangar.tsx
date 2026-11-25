'use client'
/* The hangar: every aircraft model of the textured fleet (public/models/fleet, FlightGear AI aircraft, GPL v2) in 3D,
   each in any of its airline liveries. Link to one with /hangar?m=<model>&l=<livery>. */
import * as React from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { FLEET_V, fleetTexAlpha, fleetTexUrl } from '@/components/atc/WorldMap/fleet'
import { applyLights, cabinWindowMask, lightsForPhase, planToOn, forwardOf, type AircraftFrame, lightMaterial, makeBeam, makeCabin, makeLights, measureAircraft, setLightPositions, type LightsOn } from '@/components/atc/aircraftLights'
import s from './Hangar.module.css'

type TimeOfDay = 'day' | 'evening' | 'night'
/** Light rigs per time of day: sky / ground fill, the key light (sun or moon), rim, exposure, backdrop, light size. */
const TIMES: Record<TimeOfDay, { sky: number; ground: number; hemi: number; key: number; keyI: number; keyPos: [number, number, number]; rim: number; rimI: number; exp: number; bg: string; lightK: number }> = {
  day: { sky: 0xdfe9ff, ground: 0x3a3f48, hemi: 1.5, key: 0xffffff, keyI: 2.4, keyPos: [40, 60, 30], rim: 0x9fc4ff, rimI: 0.8, exp: 1.05, bg: 'radial-gradient(120% 90% at 50% 20%, #3b4a5e 0%, #1b222c 60%, #10141a 100%)', lightK: 0.45 },
  evening: { sky: 0xffcfa8, ground: 0x6a4e44, hemi: 1.35, key: 0xffa060, keyI: 2.2, keyPos: [70, 14, -20], rim: 0x8f9cff, rimI: 1.1, exp: 1.05, bg: 'linear-gradient(180deg, #2a2346 0%, #7a3f4f 55%, #e08a4f 100%)', lightK: 0.75 },
  night: { sky: 0x3a4a78, ground: 0x2a2620, hemi: 0.5, key: 0xa8bcff, keyI: 0.5, keyPos: [-30, 50, 40], rim: 0xffd2a0, rimI: 0.45, exp: 1.0, bg: 'radial-gradient(120% 90% at 50% 15%, #101a2e 0%, #070a12 70%, #030407 100%)', lightK: 1 },
}
type Surface = 'apron' | 'taxiway' | 'runway'
/** Paved surface under the aircraft, with real markings and lights: a runway (45 m, white centreline dashes 30 m long
 *  every 50 m, edge stripes, white edge lights every 60 m and centreline lights every 15 m) or a taxiway (23 m, yellow
 *  centreline, edge stripes, blue edge lights every 30 m, green centreline lights every 15 m). Laid along the fuselage. */
function buildSurface(kind: Surface, f: AircraftFrame): THREE.Group | null {
  if (kind === 'apron') return null
  const rw = kind === 'runway', W = rw ? 45 : 23, len = Math.max(900, f.L * 16), tile = rw ? 50 : 30
  const c = document.createElement('canvas'); c.width = 512; c.height = Math.round(512 * tile / W); const g = c.getContext('2d')!
  const px = c.width / W, img = g.createImageData(c.width, c.height)
  for (let i = 0; i < img.data.length; i += 4) { const v = (rw ? 46 : 40) + Math.random() * 14; img.data[i] = v; img.data[i + 1] = v + 1; img.data[i + 2] = v + 3; img.data[i + 3] = 255 }
  g.putImageData(img, 0, 0)
  const paint = (col: string, x: number, w: number, y = 0, h = c.height) => { g.fillStyle = col; g.fillRect((x + W / 2) * px - w * px / 2, y, w * px, h) }
  if (rw) {
    paint('rgba(235,235,230,0.85)', -W / 2 + 1.2, 0.9); paint('rgba(235,235,230,0.85)', W / 2 - 1.2, 0.9)          // edge stripes
    paint('rgba(240,240,235,0.9)', 0, 0.9, 0, c.height * 30 / tile)                                             // centreline dash
  } else {
    paint('rgba(240,190,40,0.9)', 0, 0.3)                                                                        // yellow centreline
    paint('rgba(240,190,40,0.75)', -W / 2 + 0.6, 0.15); paint('rgba(240,190,40,0.75)', -W / 2 + 0.9, 0.15)       // edge: double yellow
    paint('rgba(240,190,40,0.75)', W / 2 - 0.6, 0.15); paint('rgba(240,190,40,0.75)', W / 2 - 0.9, 0.15)
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, len / tile); tex.anisotropy = 8
  const grp = new THREE.Group()
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(W, len), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }))
  strip.rotation.x = -Math.PI / 2; grp.add(strip)
  // lights: positions along the strip (local: x across, z along), then the group is turned to the fuselage axis
  const pos: number[] = [], col: number[] = [], siz: number[] = []
  const put = (x: number, z: number, c3: number[], s1: number) => { pos.push(x, 0.25, z); col.push(...c3); siz.push(s1) }
  for (let z = -len / 2; z <= len / 2; z += rw ? 60 : 30) for (const x of [-W / 2 - 1, W / 2 + 1]) put(x, z, rw ? [1, 0.95, 0.85] : [0.15, 0.35, 1], rw ? 9 : 7)
  for (let z = -len / 2; z <= len / 2; z += 15) put(rw ? 0.8 : 0, z, rw ? [1, 0.96, 0.9] : [0.2, 1, 0.35], 6)
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); lg.setAttribute('size', new THREE.Float32BufferAttribute(siz, 1))
  lg.setAttribute('facing', new THREE.Float32BufferAttribute(new Array(siz.length * 3).fill(0), 3)); lg.setAttribute('cut', new THREE.Float32BufferAttribute(new Array(siz.length).fill(-2), 1))   // all round
  const lp = new THREE.Points(lg, lightMaterial); lp.frustumCulled = false; lp.renderOrder = 29; lp.name = 'surfaceLights'; grp.add(lp)
  grp.position.y = 0.005; grp.position.setComponent(f.S, f.sC)
  if (f.A === 0) grp.rotation.y = Math.PI / 2                                     // strip's length (z) along the fuselage (x)
  return grp
}

/** A flight from gate to gate: each step sets the lights the way crews do (lightsForPhase, the game's own rules) and
 *  the surface it happens on. */
const PHASES: { id: string; label: string; st: { phase: string; kind: string; altitude: number; speed: number }; surface: Surface }[] = [
  { id: 'boarding', label: 'Boarding', st: { phase: 'parked', kind: 'departure', altitude: 0, speed: 0 }, surface: 'apron' },
  { id: 'startup', label: 'Engine start', st: { phase: 'startup', kind: 'departure', altitude: 0, speed: 0 }, surface: 'apron' },
  { id: 'pushback', label: 'Pushback', st: { phase: 'pushback', kind: 'departure', altitude: 0, speed: 3 }, surface: 'apron' },
  { id: 'taxiout', label: 'Taxi out', st: { phase: 'taxi', kind: 'departure', altitude: 0, speed: 15 }, surface: 'taxiway' },
  { id: 'hold', label: 'Hold short', st: { phase: 'hold_short', kind: 'departure', altitude: 0, speed: 0 }, surface: 'taxiway' },
  { id: 'lineup', label: 'Line up', st: { phase: 'lineup', kind: 'departure', altitude: 0, speed: 5 }, surface: 'runway' },
  { id: 'takeoff', label: 'Takeoff', st: { phase: 'takeoff', kind: 'departure', altitude: 0, speed: 140 }, surface: 'runway' },
  { id: 'climb', label: 'Climb', st: { phase: 'climb', kind: 'departure', altitude: 4000, speed: 250 }, surface: 'runway' },
  { id: 'cruise', label: 'Cruise', st: { phase: 'cruise', kind: 'departure', altitude: 35000, speed: 460 }, surface: 'runway' },
  { id: 'approach', label: 'Approach', st: { phase: 'approach', kind: 'arrival', altitude: 1500, speed: 150 }, surface: 'runway' },
  { id: 'landing', label: 'Landing', st: { phase: 'landing', kind: 'arrival', altitude: 0, speed: 130 }, surface: 'runway' },
  { id: 'taxiin', label: 'Taxi in', st: { phase: 'taxi', kind: 'arrival', altitude: 0, speed: 15 }, surface: 'taxiway' },
  { id: 'gate', label: 'At gate', st: { phase: 'arrived', kind: 'arrival', altitude: 0, speed: 0 }, surface: 'apron' },
]

const LIGHT_LABELS: [keyof LightsOn, string][] = [['nav', 'Wingtip (nav)'], ['strobe', 'Strobes'], ['beacon', 'Beacon (red, top + belly)'], ['landing', 'Landing'], ['taxi', 'Taxi'], ['takeoff', 'Takeoff'], ['cabin', 'Cabin']]

interface Livery { xml: string; tex: Record<string, string> }
interface Model { glb: string; type: string; textures: string[]; tris: number; description: string; authors: string; liveries: Record<string, Livery> }

/** "UnitedAirlines" / "789-BritishAirways" / "ERJ175-AlaskaAirlines" -> "United Airlines" / "British Airways" / "Alaska Airlines" */
export function liveryName(n: string): string {
  const t = n.replace(/^(?=[A-Z]*\d)[A-Z0-9]{2,7}-/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').trim()
  return t === 'default' ? 'Default' : t || n
}
/** "Boeing737-800" / "" -> a readable model name, falling back to the file name. */
function modelName(key: string, m: Model): string {
  const d = (m.description || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+/g, ' ').trim()
  const n = d && d.length < 60 ? d : key.split('/').pop()!.replace(/[_-]+/g, ' ')
  return /^A3\d\d/.test(n) ? `Airbus ${n}` : /^7[0-9]7\b/.test(n) ? `Boeing ${n}` : n
}

export function Hangar() {
  const [models, setModels] = React.useState<Record<string, Model> | null>(null)
  const [sel, setSel] = React.useState<string | null>(null)
  const [livery, setLivery] = React.useState<string | null>(null)
  const [q, setQ] = React.useState('')
  const [lq, setLq] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [time, setTime] = React.useState<TimeOfDay>('night')
  const [surface, setSurface] = React.useState<Surface>('taxiway')
  const [phase, setPhase] = React.useState<string | null>(null)
  const pickPhase = (id: string) => { const P = PHASES.find((x) => x.id === id)!; setPhase(id); setSurface(P.surface); setLights(planToOn(lightsForPhase(P.st))) }
  const [lights, setLights] = React.useState<LightsOn>({ nav: true, strobe: true, beacon: true, landing: true, taxi: true, takeoff: false, cabin: true })

  React.useEffect(() => {
    void fetch(`/models/fleet/index.json?v=${FLEET_V}`).then((r) => r.json()).then((j: { models: Record<string, Model> }) => {
      setModels(j.models)
      const u = new URLSearchParams(location.search)
      const m = u.get('m') && j.models[u.get('m')!] ? u.get('m')! : (j.models['738/737-800'] ? '738/737-800' : Object.keys(j.models)[0])
      setSel(m)
      const l = u.get('l')
      setLivery(l && j.models[m].liveries[l] ? l : pickLivery(j.models[m]))
    })
  }, [])

  const list = React.useMemo(() => {
    if (!models) return []
    const k = q.trim().toLowerCase()
    return Object.entries(models)
      .filter(([key, m]) => !k || key.toLowerCase().includes(k) || modelName(key, m).toLowerCase().includes(k) || Object.keys(m.liveries).some((l) => liveryName(l).toLowerCase().includes(k)))
      .sort((a, b) => Object.keys(b[1].liveries).length - Object.keys(a[1].liveries).length || a[0].localeCompare(b[0]))
  }, [models, q])

  const model = models && sel ? models[sel] : null
  const liveries = React.useMemo(() => {
    if (!model) return []
    const k = lq.trim().toLowerCase()
    return Object.keys(model.liveries).filter((l) => !k || liveryName(l).toLowerCase().includes(k)).sort((a, b) => liveryName(a).localeCompare(liveryName(b)))
  }, [model, lq])

  React.useEffect(() => {
    if (!sel || !livery) return
    const u = new URL(location.href); u.searchParams.set('m', sel); u.searchParams.set('l', livery)
    history.replaceState(null, '', u.toString())
  }, [sel, livery])

  const choose = (key: string) => {
    if (!models) return
    setSel(key); setLq('')
    // keep the same airline when the new model has it
    const want = livery ? liveryName(livery).toLowerCase() : ''
    const same = Object.keys(models[key].liveries).find((l) => liveryName(l).toLowerCase() === want)
    setLivery(same ?? pickLivery(models[key]))
  }
  const total = models ? Object.values(models).reduce((a, m) => a + Object.keys(m.liveries).length, 0) : 0

  return (
    <div className={s.root} data-testid="hangar">
      <aside className={s.models}>
        <div className={s.head}>
          <h1 className={s.title}>Hangar</h1>
          <p className={s.sub}>{models ? `${Object.keys(models).length} aircraft · ${total.toLocaleString()} liveries` : 'Loading the fleet…'}</p>
          <input className={s.search} type="search" placeholder="Search aircraft or airline" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search aircraft or airline" data-testid="hangar-search" />
        </div>
        <ul className={s.list} role="listbox" aria-label="Aircraft">
          {list.map(([key, m]) => (
            <li key={key}>
              <button type="button" role="option" aria-selected={key === sel} className={s.item} onClick={() => choose(key)} data-testid={`hangar-model-${key}`}>
                <span className={s.itemName}>{modelName(key, m)}</span>
                <span className={s.itemMeta}>{key.split('/')[0]} · {Object.keys(m.liveries).length} {Object.keys(m.liveries).length === 1 ? 'livery' : 'liveries'}</span>
              </button>
            </li>
          ))}
          {models && !list.length ? <li className={s.empty}>Nothing matches “{q}”.</li> : null}
        </ul>
      </aside>

      <section className={s.stage}>
        <Viewer model={model} livery={model && livery ? model.liveries[livery] : null} onLoading={setLoading} time={time} lights={lights} surface={surface} />
        <div className={s.ctl} data-testid="hangar-controls">
          <div className={s.ctlRow} role="radiogroup" aria-label="Time of day">
            {(['day', 'evening', 'night'] as TimeOfDay[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={time === t} className={s.ctlBtn} onClick={() => setTime(t)} data-testid={`hangar-time-${t}`}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
          <div className={s.ctlRow} role="radiogroup" aria-label="Surface">
            {(['apron', 'taxiway', 'runway'] as Surface[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={surface === k} className={s.ctlBtn} onClick={() => setSurface(k)} data-testid={`hangar-surface-${k}`}>{k[0].toUpperCase() + k.slice(1)}</button>
            ))}
          </div>
          <div className={s.ctlRow} role="radiogroup" aria-label="Flight phase (sets the lights as crews do)">
            {PHASES.map((P) => (
              <button key={P.id} type="button" role="radio" aria-checked={phase === P.id} className={s.ctlBtn} onClick={() => pickPhase(P.id)} data-testid={`hangar-phase-${P.id}`}>{P.label}</button>
            ))}
          </div>
          <div className={s.ctlRow} aria-label="Aircraft lights">
            {LIGHT_LABELS.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={lights[k]} className={s.ctlBtn} onClick={() => { setPhase(null); setLights((o) => ({ ...o, [k]: !o[k] })) }} data-testid={`hangar-light-${k}`}>{label}</button>
            ))}
          </div>
        </div>
        {model && sel ? (
          <div className={s.caption}>
            <h2 className={s.capTitle}>{modelName(sel, model)}</h2>
            <p className={s.capSub}>{livery ? liveryName(livery) : ''}{loading ? ' · loading…' : ''}</p>
          </div>
        ) : null}

        {model ? (
          <div className={s.liveries}>
            <div className={s.livHead}>
              <span className={s.livCount}>{Object.keys(model.liveries).length} {Object.keys(model.liveries).length === 1 ? 'livery' : 'liveries'}</span>
              <input className={s.searchSm} type="search" placeholder="Find an airline" value={lq} onChange={(e) => setLq(e.target.value)} aria-label="Find an airline livery" data-testid="hangar-livery-search" />
            </div>
            <div className={s.chips} role="listbox" aria-label="Liveries">
              {liveries.map((l) => (
                <button key={l} type="button" role="option" aria-selected={l === livery} className={s.chip} onClick={() => setLivery(l)} data-testid={`hangar-livery-${l}`}>{liveryName(l)}</button>
              ))}
            </div>
            <p className={s.credit}>{model.authors ? `Model by ${model.authors}. ` : ''}From FlightGear, GNU GPL v2 · <a href="/models/fleet/NOTICE.txt" target="_blank" rel="noopener noreferrer">credits and source</a></p>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function pickLivery(m: Model): string {
  const names = Object.keys(m.liveries)
  return names.find((n) => /united/i.test(n)) ?? names.find((n) => !/default|main/i.test(n)) ?? names[0]
}

/* ── the 3D view ── */
function Viewer({ model, livery, onLoading, time, lights, surface }: { model: Model | null; livery: Livery | null; onLoading: (b: boolean) => void; time: TimeOfDay; lights: LightsOn; surface: Surface }) {
  const env = React.useRef({ time, lights, surface }); env.current = { time, lights, surface }
  const host = React.useRef<HTMLDivElement>(null)
  const api = React.useRef<{ show: (m: Model, l: Livery) => void; paint: (l: Livery) => void } | null>(null)
  const shown = React.useRef<string | null>(null)

  React.useEffect(() => {
    const el = host.current; if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio)); renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x3a3f48, 1.5); scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(40, 60, 30); scene.add(sun)
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.8); rim.position.set(-50, 20, -40); scene.add(rim)
    // the aircraft's own lights (aircraftLights.ts, the same as in the game), placed on each model as it loads
    const lightPts = makeLights(); let lit = false
    // the apron: dark concrete that the landing / taxi / takeoff lights throw their pools onto
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.92, metalness: 0 }))
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; scene.add(ground)
    // lamps that light the ground (spot lights) and their visible beams; placed per model in show()
    type Lamp = { spot: THREE.SpotLight; beam: THREE.Mesh; kind: 'landing' | 'taxi' | 'turnoff'; hit: number; near: number }
    const lamps: Lamp[] = []
    const lamp = (kind: Lamp['kind'], ang: number, color: number) => { const spot = new THREE.SpotLight(color, 0, 0, ang, 0.55, 1.6); const beam = makeBeam(1, ang * 0.8, color); scene.add(spot, spot.target, beam); const l: Lamp = { spot, beam, kind, hit: 50, near: 20 }; lamps.push(l); return l }
    const lampTaxi = lamp('taxi', Math.PI / 7, 0xfff1dc), lampLandL = lamp('landing', Math.PI / 22, 0xfff6ea), lampLandR = lamp('landing', Math.PI / 22, 0xfff6ea)
    const lampTurnL = lamp('turnoff', Math.PI / 6, 0xfff1dc), lampTurnR = lamp('turnoff', Math.PI / 6, 0xfff1dc)
    let cabin: THREE.Mesh | null = null
    let frameNow: AircraftFrame | null = null, surf: THREE.Group | null = null, surfKey = ''
    const setSurface = (k: Surface) => {
      if (!frameNow) return
      const key = `${k}:${frameNow.L.toFixed(1)}:${frameNow.A}`; if (key === surfKey) return; surfKey = key
      if (surf) { scene.remove(surf); surf.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() }) }
      surf = buildSurface(k, frameNow); if (surf) scene.add(surf)
      ;(ground.material as THREE.MeshStandardMaterial).color.setHex(k === 'apron' ? 0x3a3d42 : 0x1c2119)   // grass beside a runway / taxiway
    }
    let appliedTime: TimeOfDay | null = null
    const setTime = (t: TimeOfDay) => {
      const T = TIMES[t]; appliedTime = t
      hemi.color.setHex(T.sky); hemi.groundColor.setHex(T.ground); hemi.intensity = T.hemi
      sun.color.setHex(T.key); sun.intensity = T.keyI; sun.position.set(...T.keyPos)
      rim.color.setHex(T.rim); rim.intensity = T.rimI; rim.position.set(-T.keyPos[0], Math.max(20, T.keyPos[1]), -T.keyPos[2]); renderer.toneMappingExposure = T.exp; el.style.background = T.bg
    }
    // a soft contact shadow under the aircraft
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64); grd.addColorStop(0, 'rgba(0,0,0,0.45)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(0, 0, 128, 128)
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }))
    shadow.rotation.x = -Math.PI / 2; scene.add(shadow)
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 0.8; controls.enablePan = false
    controls.maxPolarAngle = Math.PI * 0.49
    controls.addEventListener('start', () => { controls.autoRotate = false })
    const loader = new GLTFLoader(); const texLoader = new THREE.TextureLoader()
    const texCache = new Map<string, THREE.Texture>()
    const glbCache = new Map<string, Promise<THREE.Group>>()
    let current: THREE.Group | null = null; let token = 0
    const texReady = new Map<string, Promise<THREE.Texture>>()
    const tex = (h: string) => { let t = texCache.get(h); if (!t) { const p = new Promise<THREE.Texture>((ok) => { t = texLoader.load(fleetTexUrl(h), (x) => ok(x)) }); t!.flipY = false; t!.colorSpace = THREE.SRGBColorSpace; t!.anisotropy = renderer.capabilities.getMaxAnisotropy(); texCache.set(h, t!); texReady.set(h, p) } return t! }
    // the livery's own painted windows, lit (cabinWindowMask); per model + livery texture, made once
    const winMasks = new Map<string, THREE.Texture | null>(), winMats = new Set<THREE.MeshStandardMaterial>()
    let frameCur: AircraftFrame | null = null, glbCur = '', cargoModel = false, paintTok = 0
    // freighters: no passenger cabin (their windows are plugged), so no cabin light even where the texture paints windows
    const CARGO = /freight|cargo|fedex|\bups\b|dhl|cargolux|atlas|kalitta|polar|aerologic|abx|\basl\b|tnt|western ?global|amazon ?air|prime ?air/i
    const paint = (l: Livery) => {
      const my = ++paintTok; winMats.clear()
      const cargo = cargoModel || CARGO.test(l.xml.replace(/([a-z])([A-Z])/g, '$1 $2'))
      current?.traverse((o) => {
        const m = o as THREE.Mesh; if (!m.isMesh) return
        for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
          const file = mat.name.startsWith('tex:') ? mat.name.slice(4) : null; const h = file ? l.tex[file] : null
          if (!h) continue
          mat.map = tex(h); mat.alphaTest = fleetTexAlpha(h) ? 0.5 : 0; mat.metalness = 0.2; mat.roughness = 0.5
          mat.emissiveMap = null; mat.emissive.setRGB(0, 0, 0); mat.needsUpdate = true
          const key = `${glbCur}|${h}`, root = current!
          if (cargo) continue
          void texReady.get(h)!.then((t) => {
            if (my !== paintTok || !frameCur) return
            if (!winMasks.has(key)) winMasks.set(key, cabinWindowMask(root, frameCur, mat, t.image as HTMLImageElement))
            const mask = winMasks.get(key)
            if (mask) { mat.emissiveMap = mask; mat.emissive.setRGB(1, 1, 1); mat.emissiveIntensity = 0; mat.needsUpdate = true; winMats.add(mat) }
          })
        }
      })
    }
    const show = (m: Model, l: Livery) => {
      const my = ++token; onLoading(true)
      let p = glbCache.get(m.glb)
      if (!p) { p = loader.loadAsync(`/models/fleet/${m.glb}?v=${FLEET_V}`).then((gl) => gl.scene); glbCache.set(m.glb, p) }
      void p.then((src) => {
        if (my !== token) return
        if (current) scene.remove(current)
        const g = src.clone(true)
        g.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) mm.material = Array.isArray(mm.material) ? mm.material.map((x) => x.clone()) : mm.material.clone() })
        const box = new THREE.Box3().setFromObject(g); const size = box.getSize(new THREE.Vector3()); const ctr = box.getCenter(new THREE.Vector3())
        g.position.set(-ctr.x, -box.min.y, -ctr.z)
        const holder = new THREE.Group(); holder.add(g); scene.add(holder); current = holder
        const { spec, frame } = measureAircraft(holder); setLightPositions(lightPts, spec); holder.add(lightPts); lit = true
        frameCur = frame; glbCur = m.glb; cargoModel = /freight|cargo/i.test(`${m.description} ${m.type}`) || /F$/.test(m.glb.split('/')[0].replace(/\.glb$/i, '')) || /\/\w*F\b/.test(m.glb)
        paint(l)
        if (cabin) { cabin.removeFromParent(); cabin.geometry.dispose() }
        cabin = makeCabin(frame); holder.add(cabin)
        // aim each lamp: landing lights straight ahead and slightly down (meet the ground ~5 lengths out), the taxi light
        // ahead and down (pool ~1.5 lengths ahead), turnoff lights splayed 35 deg outwards
        const fwd = forwardOf(frame), Lm = frame.L, side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize()   // to port
        const aim = (l: Lamp, from: THREE.Vector3, dir: THREE.Vector3, dist: number) => {
          const to = from.clone().addScaledVector(dir, dist); to.y = 0
          l.spot.position.copy(from); l.spot.target.position.copy(to); l.spot.distance = dist * 2.2
          const len = from.distanceTo(to); l.hit = len
          // where the cone's lower edge meets the ground: the brightest part of the pool
          const dep = Math.atan2(from.y, from.clone().setY(0).distanceTo(to)), lo = Math.min(Math.PI / 2 - 0.01, dep + l.spot.angle)
          l.near = Math.max(from.y, from.y / Math.sin(lo)); l.beam.position.copy(from); l.beam.scale.set(len, len, len); l.beam.lookAt(to)
        }
        aim(lampTaxi, spec.nose, fwd, Lm * 1.5)
        const splay = (sgn: number, a: number) => fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, sgn * Math.sin(a))   // a little outboard, clear of the nose
        aim(lampLandL, spec.landL, splay(1, 0.05), Lm * 3); aim(lampLandR, spec.landR, splay(-1, 0.05), Lm * 3)
        const out = (sgn: number) => fwd.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(side, sgn * Math.sin(0.6))
        aim(lampTurnL, spec.turnL ?? spec.landL, out(1), Lm * 1.2); aim(lampTurnR, spec.turnR ?? spec.landR, out(-1), Lm * 1.2)
        ground.scale.setScalar(Lm * 7); frameNow = frame; surfKey = ''
        const r = Math.max(size.x, size.z, size.y * 2)
        shadow.scale.set(size.x * 1.25, size.z * 1.25, 1)
        controls.target.set(0, size.y * 0.2 - r * 0.06, 0); controls.minDistance = r * 0.6; controls.maxDistance = r * 4
        if (shown.current !== m.glb) { const k = el.clientWidth < 600 ? 1.45 : 1.15; camera.position.set(r * 0.95 * k, r * 0.4 * k, r * 1.05 * k); shown.current = m.glb }
        controls.update(); onLoading(false)
      }).catch(() => onLoading(false))
    }
    api.current = { show, paint }
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix() }
    const ro = new ResizeObserver(resize); ro.observe(el); resize()
    const clock = new THREE.Clock()
    let raf = 0; const loop = () => {
      raf = requestAnimationFrame(loop)
      const { time: tm, lights: on } = env.current
      if (tm !== appliedTime) setTime(tm)
      setSurface(env.current.surface)
      if (lit) {
        applyLights(lightPts, on, clock.getElapsedTime(), TIMES[tm].lightK)
        lightMaterial.uniforms.uOpacity.value = tm === 'day' ? 0.6 : 1; lightMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio()
        // brightness: physical-ish candela for the spots (they only read after dark), beam haze only after dark
        const dark = tm === 'day' ? 0 : tm === 'evening' ? 0.55 : 1
        for (const l of lamps) {
          const want = l.kind === 'landing' ? on.landing : l.kind === 'turnoff' ? !!on.takeoff : (on.taxi || !!on.takeoff)
          // the pool's brightness where the beam meets the ground (the night fill is ~0.2): landing / takeoff glaring, taxi bright
          // brightness of the pool's brightest part (the night fill is ~0.5): landing / takeoff glaring, taxi clear but soft
          const pool = l.kind === 'landing' ? 70 : l.kind === 'turnoff' ? 16 : on.takeoff ? 36 : 14
          l.spot.intensity = want ? pool * Math.pow(l.near, 1.6) * (0.25 + 0.75 * dark) : 0
          ;(l.beam.material as THREE.ShaderMaterial).uniforms.uI.value = want ? (l.kind === 'landing' ? 0.16 : l.kind === 'turnoff' ? 0.06 : on.takeoff ? 0.09 : 0.045) * dark : 0
          l.beam.visible = want && dark > 0
        }
        const cabK = on.cabin ? (tm === 'day' ? 0.15 : tm === 'evening' ? 0.75 : 1) : 0
        for (const mat of winMats) mat.emissiveIntensity = cabK * 1.1
        // the generated strip only when the livery's windows were not found
        if (cabin) { (cabin.material as THREE.ShaderMaterial).uniforms.uWin.value = cabK; cabin.visible = winMats.size === 0 }
      }
      controls.update(); renderer.render(scene, camera)
    }; loop()
    ;(window as unknown as { __hangar?: unknown }).__hangar = { ready: () => !!current }
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); for (const t of texCache.values()) t.dispose(); el.removeChild(renderer.domElement); api.current = null }
  }, [onLoading])

  const glb = model?.glb
  React.useEffect(() => { if (model && livery) api.current?.show(model, livery) }, [glb])   // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (livery) api.current?.paint(livery) }, [livery])
  return <div ref={host} className={s.viewer} data-testid="hangar-viewer" />
}
