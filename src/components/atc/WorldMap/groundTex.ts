/*
  Photo textures of the airfield's ground (public/ground, CC0), mixed so that no two places look alike: every texture is
  read at two sizes and angles, blended by a noise that never repeats, with slab-by-slab tones on the concrete, sealed
  cracks and repairs on the asphalt, dry patches and mowing bands in the grass, and worn paint. The plain generated
  surfaces show until the images have arrived (and on Low graphics, which never asks for them).
*/
import * as THREE from 'three'

const NAMES = ['asphalt', 'stain', 'concrete', 'concrete2', 'grass', 'grass2', 'dry'] as const
type Name = (typeof NAMES)[number]
const blank = () => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); t.needsUpdate = true; return t as THREE.Texture }
export const ground = {
  tex: Object.fromEntries(NAMES.map((n) => [n, { value: blank() }])) as Record<Name, { value: THREE.Texture }>,
  /** 0 until every image is in. */
  ready: { value: 0 },
  /** 0 dry .. 1 wet. */
  wet: { value: 0 },
}
let asked = false
export function loadGround(onReady?: () => void): void {
  if (asked || typeof window === 'undefined') { if (ground.ready.value) onReady?.(); return }
  asked = true
  const small = window.matchMedia?.('(pointer: coarse)').matches
  const L = new THREE.TextureLoader()
  void Promise.all(NAMES.map(async (n) => {
    const t = await L.loadAsync(`/ground/${n}${small ? '-s' : ''}.webp`)
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = small ? 4 : 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter
    if (n === 'asphalt' || n === 'stain' || n === 'concrete' || n === 'concrete2') t.format = THREE.RedFormat   // one channel is read: a quarter of the memory
    t.colorSpace = n === 'grass' || n === 'grass2' || n === 'dry' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    ground.tex[n].value = t
  })).then(() => { ground.ready.value = 1; onReady?.() }).catch(() => { asked = false })
}

/** Value noise and helpers (world metres in, so it never repeats on a field). */
export const GROUND_NOISE = /* glsl */ `
float gHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(gHash(i), gHash(i+vec2(1.,0.)), f.x), mix(gHash(i+vec2(0.,1.)), gHash(i+vec2(1.,1.)), f.x), f.y); }
float gFbm(vec2 p) { return gNoise(p)*.55 + gNoise(p*2.17+7.3)*.29 + gNoise(p*4.6+3.1)*.16; }
vec2 gRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c*p.x - s*p.y, s*p.x + c*p.y); }
`
function attach(m: THREE.MeshLambertMaterial, kind: string, names: Name[], decl: string, body: string): void {
  m.onBeforeCompile = (sh) => {
    for (const n of names) sh.uniforms[`t_${n}`] = ground.tex[n]
    sh.uniforms.gReady = ground.ready; sh.uniforms.gWet = ground.wet
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGp;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGp = (modelMatrix * vec4(position, 1.)).xz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGp; uniform float gReady, gWet;\n${names.map((n) => `uniform sampler2D t_${n};`).join('\n')}\n${GROUND_NOISE}\n${decl}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${body}`)
  }
  m.customProgramCacheKey = () => `ground-${kind}`
}

/** Runways and taxiways. */
export function dressAsphalt(m: THREE.MeshLambertMaterial): void {
  attach(m, 'asphalt', ['asphalt', 'stain'], '', /* glsl */ `
  if (gReady > .5) {
    vec2 w = vGp; float px = max(length(dFdx(w)), length(dFdy(w)));            // metres a pixel
    float pick = smoothstep(.4, .6, gFbm(w / 31.));
    float d = mix(texture2D(t_asphalt, w / 5.3).r, texture2D(t_asphalt, gRot(w, 1.1) / 7.9 + .37).r, pick) * 2.;
    float st = mix(texture2D(t_stain, w / 37.).r, texture2D(t_stain, gRot(w, 2.2) / 53. + .2).r, .5) * 2.;
    float big = gFbm(w / 120. + 4.), mid = gFbm(gRot(w, .6) / 17.);
    float k = mix(1., d, .85) * mix(1., st, .4) * (.82 + .34 * big) * (.93 + .14 * mid);
    // sealed cracks: thin dark lines wandering over it (gone once thinner than a pixel), more of them where it is old
    float cr = abs(gFbm(w / 11. + 9.) - .5), line = (1. - smoothstep(.0, .0075 + px * .004, cr)) * smoothstep(.48, .62, big) * (1. - smoothstep(.25, .8, px));
    k *= 1. - .42 * line;
    // repairs: a few newer, darker rectangles
    vec2 cell = gRot(w, .49) / vec2(19., 8.5), id = floor(cell), f = fract(cell); float has = step(.955, gHash(id + 3.7));
    float box = step(.06, f.x) * step(f.x, .9) * step(.1, f.y) * step(f.y, .88); k *= 1. - .09 * has * box;
    diffuseColor.rgb = diffuse * .86 * k * mix(vec3(1.), vec3(1.035, 1., .955), big);
    float pud = smoothstep(.52, .7, gFbm(w / 14. + 20.)); diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .58, gWet * .8); diffuseColor.rgb += gWet * pud * vec3(.045, .055, .07);
  }`)
}
/** Aprons and stands. */
export function dressConcrete(m: THREE.MeshLambertMaterial): void {
  attach(m, 'concrete', ['concrete', 'concrete2'], '', /* glsl */ `
  if (gReady > .5) {
    vec2 w = vGp, s = w / 7.5, id = floor(s), f = fract(s); float px = max(length(dFdx(w)), length(dFdy(w)));
    float h = gHash(id), h2 = gHash(id + 41.); vec2 q = gRot(w, floor(h * 4.) * 1.5708) + h2 * 37.;   // each slab its own piece of the photo, turned
    float a = textureGrad(t_concrete, q / 8.5, dFdx(w) / 8.5, dFdy(w) / 8.5).r * 2., b = textureGrad(t_concrete2, q / 4.6, dFdx(w) / 4.6, dFdy(w) / 4.6).r * 2.;
    float d = mix(a, b, .25 + .5 * smoothstep(.35, .7, gFbm(w / 40.)));
    float big = gFbm(w / 95. + 2.), near = 1. - smoothstep(.5, 2.2, px);
    float k = mix(1., d, .8) * (.86 + .26 * big) * (1. + (h - .5) * .1 * mix(.25, 1., near));
    float jw = .006 + px * .05 / 7.5, e = min(min(f.x, 1. - f.x), min(f.y, 1. - f.y)), joint = (1. - smoothstep(jw, jw * 2.2, e)) * near;
    k *= 1. - .26 * joint;
    k *= 1. - .10 * (1. - smoothstep(.0, .12, e)) * near * gNoise(w / 2.3);              // dirt along the joints
    float oil = smoothstep(.66, .86, gFbm(w / 6.5 + 11.)) * smoothstep(.45, .7, gFbm(w / 60. + 5.)); k *= 1. - .3 * oil;
    k *= h2 > .975 ? mix(1.02, 1.08, near) : h2 < .03 ? mix(.97, .9, near) : 1.;                               // a slab relaid now and then
    diffuseColor.rgb = diffuse * .93 * k * mix(vec3(1.02, 1., .965), vec3(.985, 1., 1.015), gNoise(w / 55.));
    float pud = smoothstep(.55, .72, gFbm(w / 12. + 30.)); diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .64, gWet * .8); diffuseColor.rgb += gWet * pud * vec3(.05, .06, .075);
  }`)
}
/** Paint: worn thin in patches, the aggregate showing through, rubbed by tyres. (Mixed, not see-through: paint keeps its place in the draw order.) */
export function dressPaint(m: THREE.MeshLambertMaterial): void {
  attach(m, 'paint', ['asphalt'], '', /* glsl */ `
  if (gReady > .5) {
    float lum = dot(diffuse, vec3(.33)); vec2 w = vGp;
    float grain = texture2D(t_asphalt, w / 2.6).r, old = gFbm(w / 9. + 3.), far = gFbm(w / 70. + 8.);
    float wear = smoothstep(.40, .78, old * .7 + grain * .5) * (.30 + .45 * far);
    if (lum > .1) diffuseColor.rgb = mix(diffuseColor.rgb * (.9 + .14 * far), vec3(.085, .085, .09), clamp(wear, 0., .55));
    diffuseColor.rgb *= 1. - .2 * gWet;
  }`)
}
export const GRASS_DECL = /* glsl */ `uniform sampler2D t_grass, t_grass2, t_dry; uniform float gReady, gWet;\n${GROUND_NOISE}`
/** col (the plain grass) -> the photo grass. `mow`: metres along and across the mowing. */
export const GRASS_BODY = /* glsl */ `
    if (gReady > .5) {
      vec2 w = vWorld.xz; float p1 = smoothstep(.38, .62, gFbm(w / 23.)), p2 = gFbm(w / 140. + 3.), p3 = gFbm(gRot(w, .8) / 46. + 6.);
      vec3 a = mix(texture2D(t_grass, w / 4.7).rgb, texture2D(t_grass, gRot(w, 1.3) / 7.1 + .3).rgb, p1);
      vec3 b = mix(texture2D(t_grass2, gRot(w, .5) / 5.6).rgb, texture2D(t_grass2, w / 8.3 + .6).rgb, 1. - p1);
      vec3 dr = mix(texture2D(t_dry, w / 6.2).rgb, texture2D(t_dry, gRot(w, 2.) / 9.4).rgb, p1);
      vec3 g = mix(a * 1.5, b * 1.05, smoothstep(.36, .66, p2 * .6 + p3 * .4));          // lush here, olive there
      float dry = smoothstep(.56, .80, p3 * .55 + p2 * .3 + .22 * gNoise(w / 5.)) * .75;
      g = mix(g, dr * vec3(1.0, .92, .72), dry);
      vec2 mw = vec2(dot(w, uMow), dot(w, vec2(-uMow.y, uMow.x)));
      float band = smoothstep(-.25, .25, sin(mw.y * .2618));                              // 12 m mowing bands
      g *= mix(.95, 1.05, band) * (.86 + .28 * gFbm(w / 300.)) * (.94 + .12 * gNoise(w / 9.));
      col = mix(col, g, .9) * (1. - .18 * gWet);
    }
`
