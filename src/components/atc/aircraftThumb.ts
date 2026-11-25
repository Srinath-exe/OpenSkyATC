/* Aircraft pictures for the UI (strip cards): the game's own 3D model of the type in the airline's livery
   (models.ts: fleet model + livery, else the community model painted), rendered once from a three-quarter front view on
   a transparent background, cached per type + airline. One small offscreen renderer, one picture at a time. */
import * as React from 'react'
import * as THREE from 'three'
import { instantiate, loadAircraftModel, setGear } from './WorldMap/models'

const W = 480, H = 170
const cache = new Map<string, string | null>()
const waiting = new Map<string, Array<(u: string | null) => void>>()
let renderer: THREE.WebGLRenderer | null = null, scene: THREE.Scene | null = null, camera: THREE.PerspectiveCamera | null = null
let chain: Promise<void> = Promise.resolve()

function setup() {
  if (renderer) return
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(W, H, false); renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1
  scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xe6eeff, 0x40444c, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-3, 4, -2); scene.add(key)
  const rim = new THREE.DirectionalLight(0xa8c4ff, 0.9); rim.position.set(3, 2, 3); scene.add(rim)
  camera = new THREE.PerspectiveCamera(12, W / H, 0.01, 200)
}

/** The airline part of a callsign (UAL214 -> UAL): the livery key. */
const airline = (cs: string) => (cs.match(/^[A-Z]{3}/)?.[0] ?? cs)

async function render(type: string, callsign: string): Promise<string | null> {
  setup()
  const tpl = await loadAircraftModel(type, callsign); if (!tpl) return null
  const g = instantiate(tpl, 1, callsign)
  setGear(g, true)
  g.traverse((o) => { if (o.name === 'windows' || o.name === 'cabin') o.visible = false })
  // frame it: the model's box, seen from ahead-left and a little above
  const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
  // side profile, nose to the left (the model's nose is -z): the camera on the left side, a touch above the wing
  const len = Math.max(size.z, size.x * 0.6), hfov = 2 * Math.atan(Math.tan((camera!.fov * Math.PI / 180) / 2) * camera!.aspect)
  const dist = (len * 0.54) / Math.tan(hfov / 2)
  camera!.position.set(c.x - dist, c.y + dist * 0.05, c.z)
  camera!.lookAt(c.x, c.y, c.z)
  scene!.add(g)
  // textures arrive asynchronously: wait for the livery to load before the picture is taken
  const maps: THREE.Texture[] = []
  g.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) if (mat.map) maps.push(mat.map) })
  for (let i = 0; i < 40 && maps.some((t) => !(t.image as HTMLImageElement | undefined)?.width); i++) await new Promise((ok) => setTimeout(ok, 150))
  renderer!.render(scene!, camera!)
  const url = renderer!.domElement.toDataURL('image/png')
  scene!.remove(g)
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) mat.dispose() })
  return url
}

/** A picture of `type` in `callsign`'s airline livery (data URL), or null while it is made / when there is no model. */
export function aircraftThumb(type: string, callsign: string, cb: (u: string | null) => void): string | null | undefined {
  const key = `${type}|${airline(callsign)}`
  if (cache.has(key)) return cache.get(key)
  const list = waiting.get(key); if (list) { list.push(cb); return undefined }
  waiting.set(key, [cb])
  chain = chain.then(async () => {
    let u: string | null = null
    try { u = await render(type, callsign) } catch { u = null }
    cache.set(key, u); for (const f of waiting.get(key) ?? []) f(u); waiting.delete(key)
  })
  return undefined
}

export function useAircraftThumb(type: string, callsign: string): string | null {
  const [u, setU] = React.useState<string | null>(() => (typeof window === 'undefined' ? null : (cache.get(`${type}|${airline(callsign)}`) ?? null)))
  React.useEffect(() => {
    let live = true
    const now = aircraftThumb(type, callsign, (x) => { if (live) setU(x) })
    if (now !== undefined) setU(now)
    return () => { live = false }
  }, [type, callsign])
  return u
}
