'use client'
/*
  The clouds between the airport and the radar: one see-through WebGL canvas over both views. Real cumulus, baked once at
  high quality (scripts/clouds/bake.cjs -> public/media/clouds.webp), hang at different heights; the camera looks down and
  flies through them. Leaving the airport it climbs out past them until they close into a full deck (nothing under it can
  be seen: the views swap there), and the deck parts from the middle over the radar. Going back it closes from the edges,
  the camera sinks through it, and it opens over the field once the map is drawn. The same clouds gather at the edge of a
  zoom (cloudGate.pressure) before the view changes.
*/
import * as React from 'react'
import { getDetected } from '@/components/atc/WorldMap/quality'
import { cloudGate, type CloudLight } from '@/components/atc/cloudGate'

const VERT = `#version 300 es
layout(location=0) in vec4 a;        // x, y, height, size
layout(location=1) in vec4 b;        // order (0 the middle .. 1 the edge), turn, cell, tone
uniform float aspect, hgt, cover, time; out vec2 vT; out float vA, vD, vTone;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2. - 1.;
  float d = hgt - a.z, gone = 1. - cover;
  vA = (1. - smoothstep(b.x * .72, b.x * .72 + .28, gone)) * smoothstep(.06, .75, d); vD = d; vTone = b.w;
  if (vA < .004 || d < .06) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec2 w = a.xy * (1. + gone * .55) + vec2(time * .018, 0.);
  float s = sin(b.y), k = cos(b.y); vec2 q = w + mat2(k, s, -s, k) * c * a.w * .5 * (1. + gone * .12);
  gl_Position = vec4(q / d / .62 / vec2(aspect, 1.), 0., 1.);
  vec2 cell = vec2(mod(b.z, 3.), floor(b.z / 3.)); vT = (cell + vec2(c.x * .5 + .5, .5 - c.y * .5)) / 3.; }`
const FRAG = `#version 300 es
precision highp float; in vec2 vT; in float vA, vD, vTone; uniform sampler2D tx; uniform vec3 sun, amb; uniform float dark, alpha; out vec4 o;
void main() {
  vec4 t = texture(tx, vT); if (t.a < .003) discard;
  float v = clamp(t.r / t.a, 0., 1.);
  vec3 c = mix(amb * .9, sun, smoothstep(.0, 1.08, v * .97 + .02)) * vTone;
  c = mix(c, amb * 1.06, smoothstep(1.6, 5.5, vD) * .34);                    // the lower ones stand back a little
  c = mix(c, dot(c, vec3(.33)) * vec3(.40, .46, .56), dark);                 // over the radar: moonlit
  o = vec4(c, 1.) * t.a * vA * alpha; }`
const FOG_VERT = `#version 300 es
out vec2 p; void main() { p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2. - 1.; gl_Position = vec4(p, 0., 1.); }`
const FOG_FRAG = `#version 300 es
precision highp float; in vec2 p; uniform vec3 sun, amb; uniform float fog, dark, alpha; out vec4 o;
void main() { vec3 c = mix(amb, sun, .34 - .12 * p.y + .08 * p.x); c = mix(c, dot(c, vec3(.33)) * vec3(.40, .46, .56), dark); o = vec4(c, 1.) * fog * alpha; }`

const LIGHTS: Record<CloudLight, { sun: [number, number, number]; amb: [number, number, number] }> = {
  day: { sun: [1.0, 0.99, 0.975], amb: [0.52, 0.6, 0.71] },
  dawn: { sun: [1.0, 0.88, 0.78], amb: [0.5, 0.49, 0.6] },
  dusk: { sun: [1.0, 0.85, 0.77], amb: [0.45, 0.39, 0.5] },
  night: { sun: [0.4, 0.47, 0.62], amb: [0.09, 0.115, 0.19] },
}
export interface Gfx { draw(v: View, time: number): void; clear(): void; resize(): void; dispose(): void }
export interface View { hgt: number; cover: number; fog: number; dark: number; alpha: number }

/** The sky's clouds: x, y, height, size / order, turn, cell, tone; low ones first (drawn far to near). */
function layout(n: number): Float32Array {
  let seed = 20261123; const r = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const cols = Math.round(Math.sqrt(n * 1.7)), rows = Math.ceil(n / cols), out: number[][] = []
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = ((i + 0.5 + (r() - 0.5) * 0.95) / cols - 0.5) * 9.6, y = ((j + 0.5 + (r() - 0.5) * 0.95) / rows - 0.5) * 6, z = r() * r() * 2.6
    const wisp = r() < 0.16
    out.push([x, y, z, (wisp ? 1.7 : 1.35) + r() * 0.95, Math.min(1, Math.hypot(x / 4.8, y / 3) * 0.72 + r() * 0.34), (r() - 0.5) * 0.5, wisp ? 7 + Math.floor(r() * 2) : Math.floor(r() * 7), 0.93 + r() * 0.1])
  }
  out.sort((a, b) => a[2] - b[2]); return new Float32Array(out.flat())
}
export function makeGfx(canvas: HTMLCanvasElement, low: boolean, src = '/media/clouds.webp'): Gfx | null {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
  if (!gl) return null
  const prog = (vs: string, fs: string) => {
    const p = gl.createProgram()!
    for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); gl.attachShader(p, sh) }
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('clouds', gl.getProgramInfoLog(p), gl.getAttachedShaders(p)?.map((s) => gl.getShaderInfoLog(s)).join(' ')); return null }
    const u = new Map<string, WebGLUniformLocation | null>(); return { p, u: (n: string) => { if (!u.has(n)) u.set(n, gl.getUniformLocation(p, n)); return u.get(n)! } }
  }
  const pc = prog(VERT, FRAG), pf = prog(FOG_VERT, FOG_FRAG); if (!pc || !pf) return null
  const data = layout(low ? 110 : 190), count = data.length / 8
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  for (const i of [0, 1]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, i * 16); gl.vertexAttribDivisor(i, 1) }
  const tex = gl.createTexture(); let ready = false
  const im = new Image(); im.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im)
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, w, gl.CLAMP_TO_EDGE); ready = true
  }; im.src = src
  let scale = low ? 0.6 : 1, slow = 0, lastT = 0
  const resize = () => {
    const r = canvas.getBoundingClientRect(), k = Math.min(scale, (low ? 700 : 1600) / Math.max(1, r.width))
    const w = Math.max(2, Math.round(r.width * k)), h = Math.max(2, Math.round(r.height * k)); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    gl.viewport(0, 0, w, h)
  }
  return {
    resize,
    clear() { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); lastT = 0 },
    draw(v, time) {
      // a slow graphics chip: fewer pixels rather than a stutter
      if (lastT && time - lastT > 0.034) { if (++slow > 5 && scale > 0.4) { scale *= 0.75; slow = 0; resize() } } else slow = Math.max(0, slow - 1)
      lastT = time
      const l = LIGHTS[cloudGate.light]
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      if (v.fog > 0.002) {
        gl.useProgram(pf.p); gl.uniform3fv(pf.u('sun'), l.sun); gl.uniform3fv(pf.u('amb'), l.amb); gl.uniform1f(pf.u('fog'), v.fog); gl.uniform1f(pf.u('dark'), v.dark); gl.uniform1f(pf.u('alpha'), v.alpha)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      if (!ready) return
      gl.useProgram(pc.p); gl.uniform3fv(pc.u('sun'), l.sun); gl.uniform3fv(pc.u('amb'), l.amb); gl.uniform1f(pc.u('dark'), v.dark); gl.uniform1f(pc.u('alpha'), v.alpha)
      gl.uniform1f(pc.u('aspect'), canvas.width / canvas.height); gl.uniform1f(pc.u('hgt'), v.hgt); gl.uniform1f(pc.u('cover'), v.cover); gl.uniform1f(pc.u('time'), time % 60 - 30)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    },
    dispose() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
  }
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
/** Seconds: up to the swap, and from the swap to clear air. */
export const CLOUD_IN_S = 1.5, CLOUD_OUT_S = 1.8
const HOLD_MAX_S = 7
/** Camera height at which the deck fills the view. */
const DECK = 4.3

export interface CloudVeilProps {
  mode: 'toRadar' | 'toGround' | null
  /** The view on the far side is drawn: the clouds may open. */
  ready: boolean
  /** Nothing of the old view can be seen any more: swap. */
  onCovered(): void
  /** The clouds begin to open. */
  onOpen(): void
  onDone(): void
}
export function CloudVeil(props: CloudVeilProps) {
  const ref = React.useRef<HTMLCanvasElement>(null), plain = React.useRef<HTMLDivElement>(null)
  const p = React.useRef(props); p.current = props
  const kick = React.useRef<() => void>(() => {})
  React.useEffect(() => {
    const canvas = ref.current!; let gfx: Gfx | null = null, made = false, raf = 0, last = 0, disposed = false
    const low = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency ?? 8) <= 4
    const ensure = () => { if (made) return; made = true; try { gfx = makeGfx(canvas, low) } catch { gfx = null } gfx?.resize() }
    // built while nothing is happening, so the first passage does not wait for it
    // (a weak chip makes them only when the player goes up for the first time)
    const idle = window.setTimeout(() => { if (getDetected()?.tier === 'low') return; const w = window as unknown as { requestIdleCallback?: (f: () => void) => void }; if (w.requestIdleCallback) w.requestIdleCallback(() => { if (!disposed) ensure() }); else ensure() }, 6000)
    const v: View = { hgt: 0, cover: 0, fog: 0, dark: 0, alpha: 0 }
    let from: View | null = null, stage: 'in' | 'hold' | 'out' | null = null, t = 0, running: string | null = null, shown = false
    const show = (on: boolean) => { if (shown === on) return; shown = on; canvas.style.visibility = on ? 'visible' : 'hidden'; if (!on) { gfx?.clear(); if (plain.current) plain.current.style.opacity = '0' } }
    const frame = (now: number) => {
      raf = 0
      const dt = Math.min(0.1, (now - (last || now)) / 1000); last = now
      const q = p.current
      if (q.mode !== running) {   // a passage starts (or is called off)
        running = q.mode; stage = q.mode ? 'in' : null; t = 0; cloudGate.busy = !!q.mode
        from = { ...v, alpha: shown ? v.alpha : 0 }
        if (q.mode && !shown) { from.hgt = q.mode === 'toRadar' ? 0.5 : 6.4; from.cover = q.mode === 'toRadar' ? 0.5 : 0; from.dark = q.mode === 'toGround' ? 1 : 0; from.fog = 0; from.alpha = 1 }
        if (q.mode) { ensure(); gfx?.resize() }
      }
      const up = running === 'toRadar'
      if (stage && from) {
        t += dt
        if (stage === 'in') {
          const s = Math.min(1, t / CLOUD_IN_S)
          // up: past the first clouds and above them, closing into a full deck; down: the deck closes, nearing it
          v.hgt = mix(from.hgt, DECK, up ? 1 - (1 - s) ** 2.2 : ss(0, 1, s)); v.cover = mix(from.cover, 1, up ? ss(0, 0.75, s) : ss(0, 0.9, s)); v.fog = Math.max(from.fog * (1 - s), ss(0.55, 1, s))
          v.dark = mix(from.dark, 0, ss(0.15, 0.85, s)); v.alpha = mix(from.alpha, 1, ss(0, 0.15, s))
          if (s >= 1) { v.fog = 1; stage = 'hold'; t = 0; q.onCovered() }
        } else if (stage === 'hold') {
          v.fog = 1; v.cover = 1; v.hgt += dt * (up ? 0.25 : -0.12)
          if ((q.ready && t > 0.12) || t > HOLD_MAX_S) { stage = 'out'; t = 0; q.onOpen() }
        } else {
          const s = Math.min(1, t / CLOUD_OUT_S)
          if (t <= dt) from = { ...v }
          if (up) { v.fog = 1 - ss(0, 0.35, s); v.hgt = mix(from!.hgt, 6.6, 1 - (1 - s) ** 2); v.cover = 1 - ss(0.02, 0.95, s); v.dark = ss(0.05, 0.75, s); v.alpha = 1 - ss(0.85, 1, s) }
          else { v.fog = 1 - ss(0, 0.42, s); v.hgt = mix(from!.hgt, 0.15, s * s * (1.7 - 0.7 * s)); v.cover = mix(1, 0.55, ss(0.1, 1, s)); v.dark = 0; v.alpha = 1 }
          if (s >= 1) { stage = null; cloudGate.pressure = 0; cloudGate.busy = false; running = null; q.onDone() }
        }
      } else if (cloudGate.pressure > 0 && !running) {
        cloudGate.drain(now, dt); ensure(); if (!shown) gfx?.resize()
        const k = cloudGate.pressure, out = cloudGate.dir === 'out'
        v.hgt = out ? mix(0.7, 1.7, k) : mix(6.2, 5.4, k); v.cover = out ? mix(0.45, 0.7, k) : mix(0.1, 0.45, k); v.dark = out ? 0 : mix(0.9, 0.5, k); v.fog = 0
        v.alpha = ss(0, 0.3, k)
      }
      const on = !!stage || (cloudGate.pressure > 0.005 && !running)
      show(on)
      if (on) {
        if (gfx) gfx.draw(v, now / 1000); else if (plain.current) plain.current.style.opacity = String(v.fog)
        raf = requestAnimationFrame(frame)
      } else last = 0
    }
    const start = () => { if (!raf && !disposed) raf = requestAnimationFrame(frame) }
    kick.current = start; cloudGate.wake = start
    const ro = new ResizeObserver(() => { if (shown) gfx?.resize() }); ro.observe(canvas)
    return () => { disposed = true; cancelAnimationFrame(raf); window.clearTimeout(idle); ro.disconnect(); cloudGate.wake = null; cloudGate.busy = false; cloudGate.pressure = 0; gfx?.dispose() }
  }, [])
  React.useEffect(() => { kick.current() }, [props.mode, props.ready])
  const layer: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 6 }
  return (
    <>
      <div ref={plain} aria-hidden="true" style={{ ...layer, background: '#c9d0d8', opacity: 0 }} />
      <canvas ref={ref} aria-hidden="true" data-testid="cloud-veil" style={{ ...layer, visibility: 'hidden' }} />
    </>
  )
}
