/* Aircraft exterior lights, one place for the game's 3D map (WorldMap) and the hangar (/hangar, where they are tuned):
   where each light sits on a model, and how each kind looks (colour, size, flash pattern).
     nav       red left wingtip, green right wingtip, white tail: steady
     strobe    white flashes at the wingtips and tail (double flash)
     beacon    red anti-collision lights on top of and under the fuselage ("antenna" lights): slow flash
     landing   white, at the wing roots' leading edge, facing forward and a little down: very bright, with a beam
     taxi      white, on the nose gear strut, lighting the ground ahead; takeoff = the nose light at full power plus
               the runway turnoff lights at the wing roots, splayed outwards
     cabin     warm light through the passenger windows (makeCabin)
   Sizes are in CSS pixels (scaled by the device pixel ratio in the shader), multiplied by `k` (dimmer by day). */
import * as THREE from 'three'

export const LIGHT_ORDER = ['tipL', 'tipR', 'tail', 'beaconTop', 'beaconBot', 'nose', 'landL', 'landR', 'turnL', 'turnR'] as const
export type LightKey = (typeof LIGHT_ORDER)[number]
export type LightSpec = Record<Exclude<LightKey, 'turnL' | 'turnR'>, THREE.Vector3> & Partial<Record<'turnL' | 'turnR', THREE.Vector3>>
export interface LightsOn { nav: boolean; strobe: boolean; beacon: boolean; landing: boolean; taxi: boolean; takeoff?: boolean; cabin?: boolean }

/** The look of each light: colour (linear RGB) and size in px. Tune here; both the game and the hangar use it. */
export const LOOK = {
  navRed: { c: [1, 0.12, 0.1], px: 14 },
  navGreen: { c: [0.2, 1, 0.3], px: 14 },
  navWhite: { c: [1, 1, 1], px: 11 },
  strobe: { c: [1, 1, 1], px: 34 },
  beacon: { c: [1, 0.12, 0.08], px: 24 },
  landing: { c: [1, 0.98, 0.94], px: 48 },
  taxi: { c: [1, 0.97, 0.9], px: 20 },
  takeoff: { c: [1, 0.98, 0.94], px: 42 },
  turnoff: { c: [1, 0.97, 0.9], px: 26 },
} as const
/** Flash timing (s): strobe double flash every 1.35 s, beacon on for 0.32 s every 1.2 s. */
export const strobeOn = (t: number) => { const p = t % 1.35; return p < 0.07 || (p > 0.16 && p < 0.23) }
export const beaconOn = (t: number) => t % 1.2 < 0.32

export const lightMaterial = new THREE.ShaderMaterial({
  uniforms: { uOpacity: { value: 1 }, uPixelRatio: { value: 1 } },
  // each light shines over a cone (facing, cos of its half-angle in cut; cut < -1 = all round): outside it, it is not seen
  vertexShader: `attribute float size; attribute vec3 color; attribute vec3 facing; attribute float cut; varying vec3 vColor; uniform float uPixelRatio;
    void main() {
      vColor = color; vec4 wp = modelMatrix * vec4(position, 1.0); vec4 mv = viewMatrix * wp;
      float vis = 1.0;
      if (cut > -1.0) { vec3 f = normalize(mat3(modelMatrix) * facing); vec3 v = normalize(cameraPosition - wp.xyz); vis = smoothstep(cut - 0.12, cut + 0.1, dot(f, v)); }
      gl_PointSize = size * uPixelRatio * vis; gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `varying vec3 vColor; uniform float uOpacity;
    void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); float core = 1.0 - smoothstep(0.0, 0.32, d); gl_FragColor = vec4(vColor + vec3(0.5) * core, (a * a * 0.7 + core) * uOpacity); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
})

export function makeLights(): THREE.Points {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length * 3), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length * 3), 3))
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length), 1))
  g.setAttribute('facing', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length * 3), 3))
  g.setAttribute('cut', new THREE.BufferAttribute(new Float32Array(LIGHT_ORDER.length).fill(-2), 1))
  const p = new THREE.Points(g, lightMaterial); p.frustumCulled = false; p.renderOrder = 30
  return p
}
export function setLightPositions(p: THREE.Points, spec: LightSpec): void {
  const arr = p.geometry.getAttribute('position').array as Float32Array
  LIGHT_ORDER.forEach((k, i) => { const v = spec[k] ?? (k === 'turnL' ? spec.landL : spec.landR); arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z })
  p.geometry.getAttribute('position').needsUpdate = true
  // where each light shines (real aircraft: nav red / green from dead ahead round to 110 deg on their own side, the tail
  // light the 140 deg behind, landing / taxi / turnoff forward only, beacons all round)
  const fwd = spec.nose.clone().sub(spec.tail).setY(0).normalize(), left = spec.tipL.clone().sub(spec.tipR).setY(0).normalize()
  const at = (a: number, side: THREE.Vector3) => fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize()
  const right = left.clone().negate(), deg = (d: number) => Math.cos(d * Math.PI / 180)
  const F: [THREE.Vector3 | null, number][] = [
    [at(0.96, left), deg(58)], [at(0.96, right), deg(58)], [fwd.clone().negate(), deg(72)], [null, -2], [null, -2],
    [fwd, deg(48)], [at(0.05, left), deg(38)], [at(0.05, right), deg(38)], [at(0.6, left), deg(42)], [at(0.6, right), deg(42)],
  ]
  const fa = p.geometry.getAttribute('facing').array as Float32Array, ca = p.geometry.getAttribute('cut').array as Float32Array
  F.forEach(([v, c], i) => { if (v) { fa[i * 3] = v.x; fa[i * 3 + 1] = v.y; fa[i * 3 + 2] = v.z } ca[i] = c })
  p.userData.navCut = [ca[0], ca[1], ca[2]]
  p.geometry.getAttribute('facing').needsUpdate = true; p.geometry.getAttribute('cut').needsUpdate = true
}
/** Colours and sizes for time `t` (s, offset per aircraft so they do not flash together) and size factor `k`. */
export function applyLights(p: THREE.Points, on: LightsOn, t: number, k = 1): void {
  const col = p.geometry.getAttribute('color').array as Float32Array, siz = p.geometry.getAttribute('size').array as Float32Array
  const set = (i: number, c: readonly number[], px: number) => { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; siz[i] = px * k }
  const st = on.strobe && strobeOn(t), bc = on.beacon && beaconOn(t)
  const nc = p.userData.navCut as number[] | undefined
  if (nc) { const ca = p.geometry.getAttribute('cut').array as Float32Array; const want = st ? -2 : 0; if ((ca[0] < -1) !== (want < -1)) { for (let i = 0; i < 3; i++) ca[i] = st ? -2 : nc[i]; p.geometry.getAttribute('cut').needsUpdate = true } }
  set(0, st ? LOOK.strobe.c : LOOK.navRed.c, st ? LOOK.strobe.px : on.nav ? LOOK.navRed.px : 0)
  set(1, st ? LOOK.strobe.c : LOOK.navGreen.c, st ? LOOK.strobe.px : on.nav ? LOOK.navGreen.px : 0)
  set(2, LOOK.navWhite.c, st ? LOOK.strobe.px * 0.7 : on.nav ? LOOK.navWhite.px : 0)
  set(3, LOOK.beacon.c, bc ? LOOK.beacon.px : 0); set(4, LOOK.beacon.c, bc ? LOOK.beacon.px * 0.8 : 0)
  set(5, LOOK.taxi.c, on.takeoff ? LOOK.takeoff.px : on.taxi ? LOOK.taxi.px : 0)
  set(6, LOOK.landing.c, on.landing ? LOOK.landing.px : 0); set(7, LOOK.landing.c, on.landing ? LOOK.landing.px : 0)
  set(8, LOOK.turnoff.c, on.takeoff ? LOOK.turnoff.px : 0); set(9, LOOK.turnoff.c, on.takeoff ? LOOK.turnoff.px : 0)
  p.geometry.getAttribute('color').needsUpdate = true; p.geometry.getAttribute('size').needsUpdate = true
}

/** A model's frame as measured: the fuselage axis (component A, +tailDir toward the tail), span axis S, the centre
 *  line sC, length L, the cabin's centre height yc and radius r, nose and tail ends, the ground (y0). */
export interface AircraftFrame { A: 0 | 2; S: 0 | 2; tailDir: 1 | -1; leftSign: number; sC: number; L: number; span: number; yc: number; r: number; aNose: number; aTail: number; aWing: number; y0: number }

/** Light positions (and the frame) measured from a model's geometry, in the frame of `root` (y up; works whichever
 *  horizontal axis the fuselage lies along; the tail is the end with the highest point, the fin). Every light is snapped
 *  onto the model's own surface: wingtips at the outermost points, beacons on the crown and belly, landing lights on
 *  the wing roots' leading edge, the taxi light on the nose gear. */
export function measureAircraft(root: THREE.Object3D): { spec: LightSpec; frame: AircraftFrame } {
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), v = new THREE.Vector3(), pts: number[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh || !m.visible || !m.geometry?.attributes?.position) return
    const pos = m.geometry.attributes.position as THREE.BufferAttribute, step = Math.max(1, Math.floor(pos.count / 40000))
    const mm = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
    for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(mm); pts.push(v.x, v.y, v.z) }
  })
  const n = pts.length / 3
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity, iTop = 0
  for (let i = 0; i < n; i++) { const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); y0 = Math.min(y0, y); if (y > y1) { y1 = y; iTop = i } }
  // fuselage axis: the fin (highest point) is far from the middle along the fuselage and on the centre line across it
  // (comparing extents fails on wide-bodies, whose span is about their length)
  const alongX = Math.abs(pts[iTop * 3] - (x0 + x1) / 2) / (x1 - x0) > Math.abs(pts[iTop * 3 + 2] - (z0 + z1) / 2) / (z1 - z0), A = (alongX ? 0 : 2) as 0 | 2, S = (alongX ? 2 : 0) as 0 | 2
  const a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1, aC = (a0 + a1) / 2, L = a1 - a0
  const tailDir = (pts[iTop * 3 + A] > aC ? 1 : -1) as 1 | -1
  const span = alongX ? z1 - z0 : x1 - x0, sC = alongX ? (z0 + z1) / 2 : (x0 + x1) / 2
  const fwd = new THREE.Vector3(); fwd.setComponent(A, -tailDir)
  const leftSign = Math.sign(new THREE.Vector3(0, 1, 0).cross(fwd).getComponent(S)) || 1
  const P = (a: number, y: number, s: number) => { const o = new THREE.Vector3(); o.setComponent(A, a); o.y = y; o.setComponent(S, s); return o }
  const aNose = tailDir > 0 ? a0 : a1, aTail = tailDir > 0 ? a1 : a0
  const along = (f: number) => aNose + tailDir * L * f                 // f = 0 at the nose, 1 at the tail
  // wingtips: the outermost points each side
  let tipLo = 0, tipHi = 0, sLo = Infinity, sHi = -Infinity
  for (let i = 0; i < n; i++) { const s = pts[i * 3 + S]; if (s < sLo) { sLo = s; tipLo = i } if (s > sHi) { sHi = s; tipHi = i } }
  const at = (i: number) => P(pts[i * 3 + A], pts[i * 3 + 1], pts[i * 3 + S])
  const tipL = leftSign < 0 ? at(tipLo) : at(tipHi), tipR = leftSign < 0 ? at(tipHi) : at(tipLo)
  const aWing = (tipL.getComponent(A) + tipR.getComponent(A)) / 2
  // exact surface points: rays against the model's own triangles (vertex sampling misses sparse skins)
  const rc = new THREE.Raycaster(), meshes: THREE.Mesh[] = []
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible && m.geometry?.attributes?.position && !(m as unknown as { isPoints?: boolean }).isPoints) meshes.push(m) })
  const toWorld = (p: THREE.Vector3) => p.clone().applyMatrix4(root.matrixWorld), toRoot = (p: THREE.Vector3) => p.clone().applyMatrix4(inv)
  const cast = (from: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Vector3 | null => {
    const o = toWorld(from), d = toWorld(from.clone().add(dir)).sub(o).normalize()
    rc.set(o, d); rc.far = far * 2; const h = rc.intersectObjects(meshes, false)[0]
    return h ? toRoot(h.point) : null
  }
  const hUp = (y1 - y0) * 3
  const crownBelly = (f: number) => {
    const a = aNose + tailDir * L * f
    const top = cast(P(a, y1 + hUp, sC), new THREE.Vector3(0, -1, 0), hUp * 2), bot = cast(P(a, y0 - hUp, sC), new THREE.Vector3(0, 1, 0), hUp * 2)
    return top && bot && top.y - bot.y > L * 0.03 ? { top: top.y, bot: bot.y } : null
  }
  // the cabin: crown and belly on the centre line over the forward fuselage (18-32 % back from the nose: behind the nose
  // gear, ahead of wings and engines); the fuselage is round, so its radius is half that height
  let yTopC = -Infinity, yBotC = Infinity
  for (let i = 0; i < n; i++) { const f = (pts[i * 3 + A] - aNose) * tailDir / L, s = Math.abs(pts[i * 3 + S] - sC); if (f > 0.18 && f < 0.32 && s < Math.max(span * 0.008, L * 0.006)) { yTopC = Math.max(yTopC, pts[i * 3 + 1]); yBotC = Math.min(yBotC, pts[i * 3 + 1]) } }
  { const cb = [0.2, 0.25, 0.3].map(crownBelly).filter((x): x is { top: number; bot: number } => !!x)
    if (cb.length) { cb.sort((a, b) => (a.top - a.bot) - (b.top - b.bot)); const m = cb[Math.floor(cb.length / 2)]; yTopC = m.top; yBotC = m.bot } }
  if (!isFinite(yTopC) || !(yTopC - yBotC > L * 0.03)) { yTopC = y0 + L * 0.15; yBotC = y0 + L * 0.05 }
  const r = (yTopC - yBotC) / 2, yc = (yTopC + yBotC) / 2
  // crown / belly at a fuselage station: the highest and lowest skin points near the centre line (gear below the belly excluded)
  const section = (f: number) => {
    let top = -Infinity, bot = Infinity
    for (let i = 0; i < n; i++) { const ff = (pts[i * 3 + A] - aNose) * tailDir / L, s = Math.abs(pts[i * 3 + S] - sC), y = pts[i * 3 + 1]; if (Math.abs(ff - f) < 0.015 && s < r * 0.35) { top = Math.max(top, y); if (y > yc - r * 1.2) bot = Math.min(bot, y) } }
    return { top: isFinite(top) ? top : yc + r, bot: isFinite(bot) ? bot : yc - r }
  }
  const fWing = (aWing - aNose) * tailDir / L
  const crown = crownBelly(Math.max(0.3, fWing - 0.06)) ?? { top: section(Math.max(0.3, fWing - 0.06)).top, bot: 0 }
  const belly = crownBelly(Math.max(0.25, fWing - 0.12)) ?? { top: 0, bot: section(Math.max(0.25, fWing - 0.12)).bot }
  // nose gear: the forward-most parts below the belly; the taxi light sits on its strut, a little above the wheels
  let gA = Infinity, gYmin = Infinity, gYmax = -Infinity, gs = 0, gn = 0
  for (let i = 0; i < n; i++) { const f = (pts[i * 3 + A] - aNose) * tailDir / L, y = pts[i * 3 + 1]; if (f < 0.3 && y < yc - r * 1.08) { gA = Math.min(gA, f); gn++ } }
  if (gn > 3) for (let i = 0; i < n; i++) { const f = (pts[i * 3 + A] - aNose) * tailDir / L, y = pts[i * 3 + 1]; if (f < gA + 0.04 && y < yc - r * 1.08) { gYmin = Math.min(gYmin, y); gYmax = Math.max(gYmax, y); gs += f } }
  let nose = gn > 3 ? P(along(gA), gYmin + (yc - r - gYmin) * 0.45, sC) : P(along(0.1), yc - r * 0.95, sC)
  if (gn > 3) {
    // on the strut: a ray from ahead, along the centre line at lamp height, hits the strut (or its door) front
    const back = new THREE.Vector3(); back.setComponent(A, tailDir)
    const h = cast(P(aNose - tailDir * L * 0.05, nose.y, sC), back, L * 0.5)
    if (h && Math.abs((h.getComponent(A) - aNose) * tailDir / L - gA) < 0.05) nose = h.add(fwd.clone().multiplyScalar(L * 0.001))
  }
  // landing lights: the wing roots' leading edge, just outboard of the fuselage (the most forward point of that slice)
  const wingRoot = (side: number) => {
    const sT = sC + side * (r * 1.25 + span * 0.02)
    const back = new THREE.Vector3(); back.setComponent(A, tailDir)
    let hit: THREE.Vector3 | null = null
    for (let k = 0; k <= 8; k++) {
      const y = yc - r * 1.05 + (r * 0.9) * k / 8, h = cast(P(aNose - tailDir * L * 0.05, y, sT), back, L * 1.2)
      if (h && (h.getComponent(A) - aNose) * tailDir / L > 0.15 && (!hit || (h.getComponent(A) - hit.getComponent(A)) * tailDir < 0)) hit = h
    }
    if (hit) return hit.add(fwd.clone().multiplyScalar(L * 0.0008))
    let best = -1, bestF = Infinity
    for (let i = 0; i < n; i++) { const s = pts[i * 3 + S], y = pts[i * 3 + 1], f = (pts[i * 3 + A] - aNose) * tailDir / L; if (Math.abs(s - sT) < span * 0.012 && y < yc + r * 0.2 && y > y0 + (yc - r - y0) * 0.5 && f > 0.2 && f < bestF) { bestF = f; best = i } }
    return best >= 0 ? at(best).add(fwd.clone().multiplyScalar(L * 0.004)) : P(along(fWing - 0.08), yc - r * 0.75, sT)
  }
  const landL = wingRoot(leftSign), landR = wingRoot(-leftSign)
  // runway turnoff lights: the same roots, a little outboard
  const turnL = landL.clone().setComponent(S, landL.getComponent(S) + leftSign * span * 0.015), turnR = landR.clone().setComponent(S, landR.getComponent(S) - leftSign * span * 0.015)
  // tail light: the rearmost point of the tail cone (below the fin)
  let tA = aNose, tY = yc
  for (let i = 0; i < n; i++) { const a = pts[i * 3 + A], y = pts[i * 3 + 1], s = Math.abs(pts[i * 3 + S] - sC); if (s < r * 0.6 && y < yc + r * 1.6 && (a - tA) * tailDir > 0) { tA = a; tY = y } }
  const spec: LightSpec = {
    tipL, tipR, tail: P(tA + tailDir * L * 0.002, tY, sC),
    beaconTop: P(along(Math.max(0.3, fWing - 0.06)), crown.top + L * 0.006, sC),
    beaconBot: P(along(Math.max(0.25, fWing - 0.12)), belly.bot - L * 0.006, sC),
    nose, landL, landR, turnL, turnR,
  }
  return { spec, frame: { A, S, tailDir, leftSign, sC, L, span, yc, r, aNose, aTail, aWing, y0 } }
}
/** Light positions only (see measureAircraft). */
export const measureLights = (root: THREE.Object3D): LightSpec => measureAircraft(root).spec
/** The direction the aircraft faces (unit, horizontal). */
export const forwardOf = (f: AircraftFrame) => { const v = new THREE.Vector3(); v.setComponent(f.A, -f.tailDir); return v }

/* ── light beams: a soft additive cone from the lamp, brightest at the lamp and fading with distance ── */
const BEAM_VERT = /* glsl */ `varying float vT; varying vec2 vUv; void main() { vUv = uv; vT = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const BEAM_FRAG = /* glsl */ `uniform vec3 uColor; uniform float uI; varying vec2 vUv;
  void main() { float t = 1.0 - vUv.y; float a = pow(1.0 - t, 2.2) * uI; gl_FragColor = vec4(uColor * a, a); }`
/** A beam `len` long with half-angle `ang` (rad); aim it with beam.position (the lamp) + beam.lookAt(target). */
export function makeBeam(len: number, ang: number, color = 0xfff3dc): THREE.Mesh {
  const g = new THREE.ConeGeometry(Math.tan(ang) * len, len, 40, 1, true)
  g.translate(0, -len / 2, 0); g.rotateX(-Math.PI / 2)                  // apex at the origin, opening along +z
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, uniforms: { uColor: { value: new THREE.Color(color) }, uI: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }))
  m.frustumCulled = false; m.renderOrder = 25
  return m
}

/* ── cabin: warm light through the passenger windows ── */
const CAB_VERT = /* glsl */ `varying vec2 vP; void main() { vP = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const CAB_FRAG = /* glsl */ `
  uniform float uWin, uLen, uPitch; varying vec2 vP;
  float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  void main() {
    if (uWin < 0.01) discard;
    float k = vP.x * uLen / uPitch, id = floor(k), f = fract(k), fw = fwidth(k);
    // a rounded window, ~45 % of the pitch wide; a few blinds down, a few dimmer (real cabins are never even)
    float wx = smoothstep(0.24, 0.30, f) * (1.0 - smoothstep(0.66, 0.72, f));
    float wy = smoothstep(0.08, 0.28, vP.y) * (1.0 - smoothstep(0.72, 0.92, vP.y));
    float h = hash(id + floor(vP.x * 3.0) * 17.0);
    float shade = h < 0.12 ? 0.08 : h < 0.3 ? 0.6 : 1.0;
    float door = step(0.985, hash(id * 3.7));                          // the odd door gap
    float win = wx * wy * shade * (1.0 - door);
    win = mix(win, 0.38 * wy, smoothstep(0.35, 0.9, fw));              // finer than a pixel: an even glow
    vec3 col = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.86, 0.66), h);   // warm cabin white (~3000 K)
    gl_FragColor = vec4(col * win * uWin, 1.0);
  }`
/** A row of lit windows down each side of the cabin (from just behind the cockpit to ahead of the tail), on the skin at
 *  window height. Add it to the same parent the frame was measured in; set .material.uniforms.uWin (0-1). */
export function makeCabin(f: AircraftFrame, lengthM = f.L): THREE.Mesh {
  const yW = f.yc + f.r * 0.22, h = f.r * 0.2, x = Math.sqrt(Math.max(0, f.r * f.r - (yW - f.yc) ** 2)) * 1.01 + f.L * 0.0006
  const fa = 0.13, fb = 0.74, pos: number[] = [], uv: number[] = []
  const P = (fr: number, y: number, s: number) => { const o = [0, y, 0]; o[f.A] = f.aNose + f.tailDir * f.L * fr; o[f.S] = f.sC + s; return o }
  for (const side of [-1, 1]) {
    const q = [P(fa, yW - h / 2, side * x), P(fb, yW - h / 2, side * x), P(fb, yW + h / 2, side * x), P(fa, yW + h / 2, side * x)]
    const t = [[0, 0], [1, 0], [1, 1], [0, 1]]
    for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...q[i]); uv.push(t[i][0], t[i][1]) }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  const mat = new THREE.ShaderMaterial({ vertexShader: CAB_VERT, fragmentShader: CAB_FRAG, uniforms: { uWin: { value: 0 }, uLen: { value: lengthM * (fb - fa) }, uPitch: { value: 0.53 } },   // a window every 0.53 m
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  const m = new THREE.Mesh(geo, mat); m.name = 'cabin'; m.frustumCulled = false; m.renderOrder = 2
  return m
}

/* ── cabin: the livery's own painted windows, lit ──────────────────────────
   The fleet liveries paint the passenger windows into the texture (there is no window geometry or lightmap), so the
   windows are found in the texture: the fuselage triangles in the window band (cabin height, on the side of the
   fuselage, nose to tail cone) are drawn in UV space as a mask; inside it, the pixels clearly darker than the band's
   own colour are windows (thin door outlines removed by an open: erode then dilate). The result is an emissive map, so
   exactly the painted windows glow. Returns null when the texture shows no window row (the strip from makeCabin is the
   fallback). */
export function cabinWindowMask(root: THREE.Object3D, f: AircraftFrame, mat: THREE.Material, img: CanvasImageSource & { width: number; height: number }): THREE.CanvasTexture | null {
  const W0 = img.width, H0 = img.height; if (!W0 || !H0) return null
  const k = Math.min(1, 2048 / Math.max(W0, H0)), W = Math.round(W0 * k), H = Math.round(H0 * k)
  // passenger windows: cabin height on the fuselage sides; cockpit: the upper nose
  const cabin = windowPixels(root, f, mat, img, W, H, (fr, dy, ds) => fr >= 0.09 && fr <= 0.9 && dy >= -0.2 && dy <= 0.65 && ds >= 0.55 && ds <= 1.2, true)
  const cockpit = windowPixels(root, f, mat, img, W, H, (fr, dy, ds) => fr < 0.1 && dy > -0.1 && dy < 1.05 && ds < 1.2, false)
  if (!cabin && !cockpit) return null
  // the emissive map carries the colour: cabin warm white (~3000 K), cockpit a dim instrument glow
  const oc = document.createElement('canvas'); oc.width = W; oc.height = H
  const og = oc.getContext('2d')!, od = og.createImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    const c = cabin?.[i] ? [255, 190, 118] : [0, 0, 0]
    od.data[i * 4] = c[0]; od.data[i * 4 + 1] = c[1]; od.data[i * 4 + 2] = c[2]; od.data[i * 4 + 3] = 255
  }
  og.putImageData(od, 0, 0)
  // cockpit: each pane lit evenly over its whole outline (the painted glass has sky / cloud reflections; lighting only
  // its dark pixels looks blotchy), a dim instrument glow
  if (cockpit) {
    og.fillStyle = 'rgb(58, 70, 80)'
    for (const hull of paneHulls(cockpit, W, H)) { og.beginPath(); hull.forEach(([x, y], i) => (i ? og.lineTo(x + 0.5, y + 0.5) : og.moveTo(x + 0.5, y + 0.5))); og.closePath(); og.fill() }
  }
  const soft = document.createElement('canvas'); soft.width = W; soft.height = H
  const sg = soft.getContext('2d')!; sg.filter = 'blur(0.6px)'; sg.drawImage(oc, 0, 0)
  const t = new THREE.CanvasTexture(soft); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace
  return t
}
/** The convex outline of each blob of `mask` (a windscreen pane is convex): monotone chain over the blob's pixels. */
function paneHulls(mask: Uint8Array, W: number, H: number): [number, number][][] {
  const seen = new Uint8Array(W * H), out: [number, number][][] = []
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue
    const pts: [number, number][] = [], st = [i]; seen[i] = 1
    while (st.length) {
      const j = st.pop()!, x = j % W, y = (j - x) / W; pts.push([x, y])
      for (const q of [j - 1, j + 1, j - W, j + W]) if (q >= 0 && q < W * H && mask[q] && !seen[q] && Math.abs((q % W) - x) <= 1) { seen[q] = 1; st.push(q) }
    }
    if (pts.length < 6) continue
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const lo: [number, number][] = [], up: [number, number][] = []
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p) }
    for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p) }
    out.push([...lo.slice(0, -1), ...up.slice(0, -1)])
  }
  return out
}
/** The window pixels of `mat`'s texture inside a band of the fuselage (`inBand(fraction nose->tail, height above the
 *  cabin centre / r, distance off the centre line / r)`): dark against the band, opened, and for passenger windows
 *  (`row`) only the blobs shaped like the row's windows (livery lettering and logos are bigger or another shape). */
function windowPixels(root: THREE.Object3D, f: AircraftFrame, mat: THREE.Material, img: CanvasImageSource, W: number, H: number, inBandFn: (fr: number, dy: number, ds: number) => boolean, row: boolean): Uint8Array | null {
  // 1. the window band in UV space
  const band = document.createElement('canvas'); band.width = W; band.height = H
  const bg = band.getContext('2d', { willReadFrequently: true })!; bg.fillStyle = '#fff'
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), mm = new THREE.Matrix4()
  let tris = 0
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh || !m.geometry?.attributes?.uv) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]; if (!mats.includes(mat)) return
    const g = m.geometry, pos = g.attributes.position, uv = g.attributes.uv, idx = g.index
    const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }]
    mm.multiplyMatrices(inv, m.matrixWorld)
    for (const gr of groups) {
      if (mats[gr.materialIndex ?? 0] !== mat) continue
      for (let t = gr.start; t + 2 < gr.start + gr.count; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2
        a.fromBufferAttribute(pos, i0).applyMatrix4(mm); b.fromBufferAttribute(pos, i1).applyMatrix4(mm); c.fromBufferAttribute(pos, i2).applyMatrix4(mm)
        const cx = (a.getComponent(f.A) + b.getComponent(f.A) + c.getComponent(f.A)) / 3, cy = (a.y + b.y + c.y) / 3, cs = (a.getComponent(f.S) + b.getComponent(f.S) + c.getComponent(f.S)) / 3
        const fr = (cx - f.aNose) * f.tailDir / f.L, dy = (cy - f.yc) / f.r, ds = Math.abs(cs - f.sC) / f.r
        if (!inBandFn(fr, dy, ds)) continue
        bg.beginPath()
        bg.moveTo(uv.getX(i0) * W, uv.getY(i0) * H); bg.lineTo(uv.getX(i1) * W, uv.getY(i1) * H); bg.lineTo(uv.getX(i2) * W, uv.getY(i2) * H)
        bg.closePath(); bg.fill(); tris++
      }
    }
  })
  if (!tris) return null
  const bandPx = bg.getImageData(0, 0, W, H).data
  // 2. the livery's pixels
  const tc = document.createElement('canvas'); tc.width = W; tc.height = H
  const tg = tc.getContext('2d', { willReadFrequently: true })!; tg.drawImage(img, 0, 0, W, H)
  const px = tg.getImageData(0, 0, W, H).data
  const lum = new Float32Array(W * H), inBand = new Uint8Array(W * H), hist = new Uint32Array(256); let nb = 0
  for (let i = 0; i < W * H; i++) {
    if (bandPx[i * 4 + 3] < 128) continue
    const l = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255
    lum[i] = l; inBand[i] = 1; hist[Math.round(l * 255)]++; nb++
  }
  if (nb < 200) return null
  let acc = 0, med = 0.5; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= nb / 2) { med = v / 255; break } }
  const thr = row ? Math.min(med * 0.62, med - 0.14) : med * 0.88      // cockpit glass: anything clearly darker than the paint
  // 3. dark against the band = window; open (3x3 erode, then dilate) to drop thin door lines and specks
  let win = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    if (!inBand[i] || lum[i] >= thr) continue
    // windows are grey / black glass: coloured paint (red, navy lettering) is not
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (!row || lum[i] < 0.08 || (mx - mn) / Math.max(1, mx) < 0.42) win[i] = 1
  }
  const morph = (src: Uint8Array, erode: boolean) => {
    const out = new Uint8Array(W * H)
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let v = erode ? 1 : 0
      for (let dy = -1; dy <= 1 && (erode ? v : !v); dy++) for (let dx = -1; dx <= 1; dx++) { const s = src[(y + dy) * W + x + dx]; if (erode ? !s : s) { v = erode ? 0 : 1; break } }
      out[y * W + x] = v
    }
    return out
  }
  win = morph(morph(win, true), false)
  // 4. blobs (4-connected): keep the ones shaped like windows
  const lab = new Int32Array(W * H), blobs: { n: number; x0: number; x1: number; y0: number; y1: number; cy: number }[] = [{ n: 0, x0: 0, x1: 0, y0: 0, y1: 0, cy: 0 }]
  const stack: number[] = []
  for (let i = 0; i < W * H; i++) {
    if (!win[i] || lab[i]) continue
    const id = blobs.length, bl = { n: 0, x0: W, x1: 0, y0: H, y1: 0, cy: 0 }; blobs.push(bl); lab[i] = id; stack.push(i)
    while (stack.length) {
      const j = stack.pop()!, x = j % W, y = (j - x) / W
      bl.n++; bl.cy += y; if (x < bl.x0) bl.x0 = x; if (x > bl.x1) bl.x1 = x; if (y < bl.y0) bl.y0 = y; if (y > bl.y1) bl.y1 = y
      for (const q of [j - 1, j + 1, j - W, j + W]) if (q >= 0 && q < W * H && win[q] && !lab[q] && Math.abs((q % W) - x) <= 1) { lab[q] = id; stack.push(q) }
    }
    bl.cy /= bl.n
  }
  const keep = new Uint8Array(blobs.length)
  if (row) {
    // the windows are the many same-sized blobs: their median size and shape; lettering / logos differ
    const real = blobs.slice(1).filter((b) => b.n >= 4)
    if (real.length < 8) return null
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const mA = med(real.map((b) => b.n)), mW = med(real.map((b) => b.x1 - b.x0 + 1)), mH = med(real.map((b) => b.y1 - b.y0 + 1))
    blobs.forEach((b, id) => {
      if (!id) return
      const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, fill = b.n / (w * h)
      if (b.n >= mA * 0.5 && b.n <= mA * 1.8 && w <= mW * 1.45 && h <= mH * 1.45 && w >= mW * 0.6 && h >= mH * 0.6 && fill > 0.5) keep[id] = 1
    })
    // a window row: at least 20 of them, evenly spaced along a line (door gaps are whole multiples of the pitch);
    // lettering on a freighter is fewer, uneven and not on one line
    const kept = blobs.map((b, id) => ({ b, id })).filter(({ id }) => keep[id])
    const cx = (b: typeof blobs[0]) => (b.x0 + b.x1) / 2
    const spreadX = Math.max(...kept.map(({ b }) => cx(b))) - Math.min(...kept.map(({ b }) => cx(b))), spreadY = Math.max(...kept.map(({ b }) => b.cy)) - Math.min(...kept.map(({ b }) => b.cy))
    const along = (b: typeof blobs[0]) => (spreadX >= spreadY ? cx(b) : b.cy), across = (b: typeof blobs[0]) => (spreadX >= spreadY ? b.cy : cx(b))
    // rows per side (UV islands): group by the across coordinate, judge each row on its own
    const rowsOk = new Set<number>()
    const byAcross = [...kept].sort((p, q) => across(p.b) - across(q.b))
    let start = 0
    for (let i = 1; i <= byAcross.length; i++) {
      if (i < byAcross.length && Math.abs(across(byAcross[i].b) - across(byAcross[i - 1].b)) < mH * 1.2) continue
      const grp = byAcross.slice(start, i).sort((p, q) => along(p.b) - along(q.b)); start = i
      if (grp.length < 20) continue
      const gaps = grp.slice(1).map((g, k) => along(g.b) - along(grp[k].b)).filter((x) => x > 0)
      const pitch = med([...gaps])
      const even = gaps.filter((x) => { const m = x / pitch; return Math.abs(m - Math.round(m)) < 0.2 && Math.round(m) <= 6 }).length / Math.max(1, gaps.length)
      if (even >= 0.75) for (const g of grp) rowsOk.add(g.id)
    }
    keep.fill(0); for (const id of rowsOk) keep[id] = 1
  } else {
    // cockpit: the dark panes, not big dark areas (a dark nose / radome)
    blobs.forEach((b, id) => { if (id && b.n >= 6 && b.n < nb * 0.08) keep[id] = 1 })
  }
  let count = 0
  for (let i = 0; i < W * H; i++) { win[i] = lab[i] && keep[lab[i]] ? 1 : 0; count += win[i] }
  if (count < (row ? 60 : 10) || count > nb * 0.5) return null
  return win
}
/** Warm cabin light (~3000 K) for the window emissive. */
export const CABIN_COLOR = new THREE.Color(1, 0.74, 0.46)

/* ── which lights are on when: airline SOP (Airbus / Boeing FCOM practice, FAA AC 91-73B / ICAO) ──────────────────
   parked at the gate, boarding   nav on (aircraft powered); cabin lit
   startup (doors closed)         + beacon ON before engine start / pushback: "engines about to run, keep clear"
   pushback                       nav, beacon; no taxi light (it would dazzle the ground crew); cabin dimmed
   taxi                           + taxi light while moving (off when stopped, so it does not dazzle others); strobes OFF
   hold short                     taxi light off; ready
   line up / takeoff roll         + strobes, landing lights, nose takeoff light, runway turnoff lights (taxi light off)
   climb                          nose and turnoff lights go with the gear (off once airborne ~400 ft); landing lights
                                  off passing 10 000 ft; cabin back up above 10 000 ft
   cruise                         nav, beacon, strobes
   descent / approach             landing lights on below 10 000 ft; nose + turnoff lights with the gear (~2 500 ft)
   landing / rollout              everything on; cabin dimmed
   taxi in (after vacating)       strobes and landing lights off; taxi light while moving; cabin back up
   arrived at the gate            taxi light off before the turn in, beacon off once the engines are shut down, nav on
   departed / cold                all off */
export interface PhaseState { phase: string; kind?: string; altitude: number; speed: number }
export interface LightPlan { nav: boolean; strobe: boolean; beacon: boolean; landing: boolean; taxi: boolean; takeoff: boolean; cabin: number }
export function lightsForPhase(a: PhaseState): LightPlan {
  const alt = a.altitude, moving = a.speed > 3, gearDown = alt < 2500, below10k = alt < 10000
  const L = (p: Partial<LightPlan>): LightPlan => ({ nav: true, strobe: false, beacon: false, landing: false, taxi: false, takeoff: false, cabin: 0.35, ...p })
  switch (a.phase) {
    case 'parked': return L({ cabin: 1 })
    case 'startup': return L({ beacon: true, cabin: 1 })
    case 'pushback': return L({ beacon: true })
    case 'taxi': return L({ beacon: true, taxi: moving, cabin: a.kind === 'arrival' ? 1 : 0.35 })
    case 'hold_short': return L({ beacon: true })
    case 'lineup': case 'takeoff': return L({ beacon: true, strobe: true, landing: true, takeoff: true })
    case 'climb': case 'go_around': return L({ beacon: true, strobe: true, landing: below10k, takeoff: alt < 400, cabin: below10k ? 0.35 : 1 })
    case 'cruise': return L({ beacon: true, strobe: true, landing: below10k, cabin: 1 })
    case 'descent': return L({ beacon: true, strobe: true, landing: below10k, cabin: below10k ? 0.35 : 1 })
    case 'approach': return L({ beacon: true, strobe: true, landing: below10k, takeoff: gearDown })
    case 'landing': case 'rollout': return L({ beacon: true, strobe: true, landing: true, takeoff: true })
    case 'arrived': return L({ cabin: 1 })
    default: return L({ nav: false, cabin: 0 })                   // departed / cold and dark
  }
}
/** The plan as the switches applyLights takes (takeoff = nose light at takeoff power + runway turnoff lights). */
export const planToOn = (p: LightPlan): LightsOn => ({ nav: p.nav, strobe: p.strobe, beacon: p.beacon, landing: p.landing, taxi: p.taxi, takeoff: p.takeoff, cabin: p.cabin > 0 })

/** Light a material's cabin windows from a mask (cabinWindowMask) through its own shader term, so the material's
 *  emissive stays free for selection / hover tints. Returns the brightness uniform (0-1). */
export function addCabinGlow(mat: THREE.MeshStandardMaterial, mask: THREE.Texture): { value: number } {
  const u = { value: 0 }
  // chain the material's own hook (the fleet's night lift): replacing it left these aircraft darker than the ones
  // without painted windows, so whites differed from plane to plane
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey?.() ?? ''
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r)
    sh.uniforms.cabinMap = { value: mask }; sh.uniforms.uCabin = u
    sh.fragmentShader = 'uniform sampler2D cabinMap;\nuniform float uCabin;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_MAP\n  totalEmissiveRadiance += texture2D(cabinMap, vMapUv).rgb * uCabin;\n#endif')
  }
  mat.customProgramCacheKey = () => `${prevKey}|cabinGlow`
  mat.needsUpdate = true
  return u
}

const measuredBy = new Map<string, { spec: LightSpec; frame: AircraftFrame }>()
const masksBy = new Map<string, THREE.Texture | null>()
/** An aircraft model in the game: its light positions and frame (measured once per `key`, in the model's own frame)
 *  and its cabin light: the livery's painted windows lit (as in the hangar), or a measured window strip when the
 *  livery has none; freighters (`cargo`) get none. Hides the model's older window strip. set(level 0-1) each frame. */
export function dressCabin(model: THREE.Group, key: string, lengthM: number, cargo: boolean): { spec: LightSpec; frame: AircraftFrame; set: (level: number) => void } {
  key = (model.userData.airframe as string | undefined) ?? key   // one type can fly as different airframes (fleet file, community model)
  let m = measuredBy.get(key)
  if (!m) { m = measureAircraft(model); measuredBy.set(key, m) }
  const { spec, frame } = m
  const old = model.getObjectByName('windows'); if (old) { old.visible = false; old.name = 'windows-old' }
  const strip = cargo ? null : makeCabin(frame, lengthM); if (strip) model.add(strip)
  const glows: { value: number }[] = []
  if (!cargo) model.traverse((o) => {
    const mesh = o as THREE.Mesh; if (!mesh.isMesh || mesh.userData.gear) return
    for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
      if (!mat.map) continue
      let tries = 0
      const go = () => {
        const img = mat.map?.image as (HTMLImageElement & ImageBitmap) | undefined
        if (!img || !img.width) { if (tries++ < 40) setTimeout(go, 500); return }
        const k = `${key}|${mat.map!.uuid}`
        if (!masksBy.has(k)) { try { masksBy.set(k, cabinWindowMask(model, frame, mat, img)) } catch { masksBy.set(k, null) } }
        const mk = masksBy.get(k); if (mk) glows.push(addCabinGlow(mat, mk))
      }
      go()
    }
  })
  return {
    spec, frame,
    set(level: number) {
      for (const g of glows) g.value = level * 1.1
      if (strip) { (strip.material as THREE.ShaderMaterial).uniforms.uWin.value = level; strip.visible = glows.length === 0 && level > 0.01 }
    },
  }
}
/** Freighter or cargo airline (no lit cabin): ICAO type ending in F (B77F, A33F...) or a cargo operator's callsign. */
export const isCargo = (type: string, callsign = '') => /F$/i.test(type) || /^(FDX|UPS|GTI|CLX|ABX|ATN|DHK|BCS|DHL|CKS|PAC|ABW|BOX|NCA|CAO|CKK|AJT|KYE|TPA|MPH|LCO|ICV|CLU|SQC|CPA9|ETD9)/.test(callsign.toUpperCase())
