/* The camera from the keyboard: W A S D move over the ground the way the view faces, Q goes up, E comes down, Shift is
   faster. It eases in and out, and the speed goes with the height, so it feels the same close in and far out. */
import type mapboxgl from 'mapbox-gl'

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'])
export function flyKeys(map: mapboxgl.Map, opts: { may(e: KeyboardEvent): boolean; onStart?(): void }): () => void {
  const held = new Set<string>(); let shift = false, raf = 0, last = 0, vx = 0, vy = 0, vz = 0
  const step = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    const on = (k: string) => (held.has(k) ? 1 : 0), f = shift ? 2.4 : 1, ease = 1 - Math.exp(-dt * 11)
    vx += ((on('KeyD') - on('KeyA')) * f - vx) * ease; vy += ((on('KeyW') - on('KeyS')) * f - vy) * ease; vz += ((on('KeyE') - on('KeyQ')) * f - vz) * ease
    if (!held.size && Math.abs(vx) + Math.abs(vy) + Math.abs(vz) < 0.02) { vx = vy = vz = 0; raf = 0; return }
    const c = map.getCenter(), kx = 111320 * Math.cos(c.lat * Math.PI / 180), b = map.getBearing() * Math.PI / 180
    const m = 40075016 * Math.cos(c.lat * Math.PI / 180) / (512 * 2 ** map.getZoom()) * map.getContainer().clientHeight * 0.75 * dt
    const e = (vx * Math.cos(b) + vy * Math.sin(b)) * m, n = (vy * Math.cos(b) - vx * Math.sin(b)) * m
    map.jumpTo({ center: [c.lng + e / kx, c.lat + n / 111320], zoom: map.getZoom() + vz * 1.3 * dt })
    raf = requestAnimationFrame(step)
  }
  const down = (e: KeyboardEvent) => {
    shift = e.shiftKey
    if (!KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !opts.may(e)) return
    e.preventDefault()
    if (!held.size) { map.stop(); opts.onStart?.() }
    held.add(e.code); if (!raf) { last = performance.now(); raf = requestAnimationFrame(step) }
  }
  const up = (e: KeyboardEvent) => { shift = e.shiftKey; held.delete(e.code) }
  const drop = () => held.clear()
  window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', drop)
  return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', drop) }
}
