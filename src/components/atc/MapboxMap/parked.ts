/*
  The aircraft parked at stands: they do not move, they are cold and dark, and many are the same type in the same paint.
  Four savings, each of which can be switched (the airport review compares them):
  group  - every aircraft of one type and airline is drawn in one go (instancing)
  still  - positions are worked out once, not on every frame
  share  - one set of materials per type and airline, and no cabin lights (reading the windows out of each livery is slow)
  gentle - models are built one at a time, a few a second, instead of all at once
*/
import * as THREE from 'three'
import { getPerformance } from '@/lib/sim/aircraftDB'
import { instantiate, loadAircraftModel, setGear } from '@/components/atc/WorldMap/models'
import { dressCabin, isCargo } from '@/components/atc/aircraftLights'

export interface ParkedFx { group: boolean; still: boolean; share: boolean; gentle: boolean }
interface Plane { id: number; type: string; callsign: string; pos: { x: number; y: number }; heading: number }
interface Rec { p: Plane; key: string; len: number; span: number; sig: string; obj: THREE.Group | null; asked: boolean; set: boolean; m: THREE.Matrix4[] | null }
interface Part { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }
interface Kind { proto: THREE.Group | null; asked: boolean; parts: Part[]; cap: number; shown: string }

export function parkedDrawer(scene: THREE.Scene, modelPx: number, repaint: () => void) {
  const recs = new Map<number, Rec>(), kinds = new Map<string, Kind>()
  let was = '', queue: Array<() => void> = [], lastBuild = 0, gen = 0
  const eul = new THREE.Euler(0, 0, 0, 'YXZ'), quat = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), pm = new THREE.Matrix4(), tmp = new THREE.Matrix4()
  const matrixOf = (p: Plane) => { eul.set(0, -p.heading * Math.PI / 180, 0); return pm.compose(pos.set(p.pos.x, 0, -p.pos.y), quat.setFromEuler(eul), one) }
  const drop = (r: Rec, own: boolean) => {
    if (!r.obj) return
    scene.remove(r.obj)
    if (own) r.obj.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of Array.isArray(m) ? m : [m]) if (x.name.startsWith('tex:')) x.dispose() })
    r.obj = null
  }
  const dropParts = (k: Kind) => { for (const q of k.parts) { scene.remove(q.mesh); q.mesh.dispose() } k.parts = []; k.cap = 0; k.shown = '' }
  let own = false
  const clear = () => { gen++; queue = []; for (const r of recs.values()) drop(r, own); recs.clear(); for (const k of kinds.values()) dropParts(k); kinds.clear() }
  const build = (fx: ParkedFx, f: () => void) => { if (fx.gentle) queue.push(f); else f() }

  /** One aircraft of a type and airline, dressed once: what the shared and the grouped ones are made from. */
  const askKind = (key: string, p: Plane, len: number, fx: ParkedFx): Kind => {
    let k = kinds.get(key); if (!k) { k = { proto: null, asked: false, parts: [], cap: 0, shown: '' }; kinds.set(key, k) }
    if (!k.asked) {
      const kk = k, g = gen; kk.asked = true
      build(fx, () => void loadAircraftModel(p.type, p.callsign).then((tpl) => {
        if (g !== gen) return
        if (!tpl) { window.setTimeout(() => { kk.asked = false; repaint() }, 4000); return }
        const obj = instantiate(tpl, len, p.callsign)
        const win = obj.getObjectByName('windows'); win?.parent?.remove(win)   // nobody on board: no lit windows
        setGear(obj, true); obj.updateMatrixWorld(true); kk.proto = obj; repaint()
      }))
    }
    return k
  }
  const makeParts = (k: Kind, cap: number) => {
    dropParts(k); k.cap = cap
    const walk = (o: THREE.Object3D) => {
      if (!o.visible) return
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const flip = m.matrixWorld.determinant() < 0
        const mat = (x: THREE.Material) => { if (!flip) return x; const c = x.clone(); c.onBeforeCompile = x.onBeforeCompile; c.customProgramCacheKey = x.customProgramCacheKey; c.side = THREE.DoubleSide; return c }   // a mirrored part
        const im = new THREE.InstancedMesh(m.geometry, Array.isArray(m.material) ? m.material.map(mat) : mat(m.material), cap)
        im.frustumCulled = false; im.renderOrder = m.renderOrder; im.matrixAutoUpdate = false; im.count = 0; im.visible = false
        scene.add(im); k.parts.push({ mesh: im, local: m.matrixWorld.clone() })
      }
      for (const c of o.children) walk(c)
    }
    walk(k.proto!)
  }

  return {
    clear,
    draw(list: Plane[], fx: ParkedFx, inView: (x: number, y: number) => boolean, mpp: number, silhouette: (p: Plane, len: number, span: number) => void) {
      const sig = JSON.stringify(fx); if (sig !== was) { clear(); was = sig; own = !fx.group && !fx.share }
      if (queue.length && performance.now() - lastBuild > 60) { lastBuild = performance.now(); queue.shift()!() }
      if (queue.length) window.setTimeout(repaint, 70)
      const live = new Set<number>(), by = new Map<string, Rec[]>()
      for (const p of list) {
        live.add(p.id)
        const s = `${p.type}|${p.callsign}`
        let r = recs.get(p.id)
        if (!r || r.sig !== s) {
          if (r) drop(r, own)
          const perf = getPerformance(p.type)
          r = { p, key: `${p.type}|${p.callsign.slice(0, 3)}`, len: perf?.lengthMeters ?? 38, span: perf?.wingspanMeters ?? 34, sig: s, obj: null, asked: false, set: false, m: null }; recs.set(p.id, r)
        }
        if (!inView(p.pos.x, p.pos.y)) { if (r.obj) r.obj.visible = false; continue }
        const far = r.len / mpp < modelPx
        if (far) { if (r.obj) r.obj.visible = false; silhouette(p, r.len, r.span); continue }
        if (fx.group) {
          const k = askKind(r.key, p, r.len, fx)
          if (!k.proto) { silhouette(p, r.len, r.span); continue }
          const l = by.get(r.key); if (l) l.push(r); else by.set(r.key, [r])
          continue
        }
        if (!r.obj) {
          silhouette(p, r.len, r.span)
          if (fx.share) {
            const k = askKind(r.key, p, r.len, fx)
            if (k.proto) { r.obj = k.proto.clone(true); r.set = false; scene.add(r.obj) }
          } else if (!r.asked) {
            const rec = r, g = gen; rec.asked = true
            build(fx, () => void loadAircraftModel(p.type, p.callsign).then((tpl) => {
              if (g !== gen || recs.get(p.id) !== rec) return
              if (!tpl) { window.setTimeout(() => { rec.asked = false; repaint() }, 4000); return }
              rec.obj = instantiate(tpl, rec.len, p.callsign); scene.add(rec.obj); repaint()
              try { rec.obj.userData.cab = dressCabin(rec.obj, p.type, rec.len, isCargo(p.type, p.callsign)) } catch { /* no cabin light */ }
            }))
          }
          continue
        }
        r.obj.visible = true
        if (!fx.still || !r.set) {
          r.obj.position.set(p.pos.x, 0, -p.pos.y); r.obj.rotation.order = 'YXZ'; r.obj.rotation.set(0, -p.heading * Math.PI / 180, 0); setGear(r.obj, true)
          ;(r.obj.userData.cab as { set?: (l: number) => void } | undefined)?.set?.(0)
          r.set = true
          if (fx.still) { r.obj.updateMatrixWorld(true); r.obj.traverse((o) => { o.matrixAutoUpdate = false }); r.obj.matrixWorldAutoUpdate = false }
        }
      }
      for (const [id, r] of recs) if (!live.has(id)) { drop(r, own); recs.delete(id) }
      if (!fx.group) return
      for (const [key, k] of kinds) {
        const l = by.get(key)
        if (!l) { if (k.shown) { for (const q of k.parts) q.mesh.visible = false; k.shown = '' } continue }
        if (k.cap < l.length) { makeParts(k, Math.max(8, l.length * 2)); for (const r of recs.values()) if (r.key === key) r.m = null }
        const shown = l.map((r) => r.p.id).join(',')
        if (fx.still && shown === k.shown) continue
        l.forEach((r, i) => {
          if (!r.m || !fx.still) { const base = matrixOf(r.p); r.m = k.parts.map((q) => tmp.multiplyMatrices(base, q.local).clone()) }
          for (let j = 0; j < k.parts.length; j++) k.parts[j].mesh.setMatrixAt(i, r.m[j])
        })
        for (const q of k.parts) { q.mesh.count = l.length; q.mesh.visible = true; q.mesh.instanceMatrix.needsUpdate = true }
        k.shown = shown
      }
    },
  }
}
