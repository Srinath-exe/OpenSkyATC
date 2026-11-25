/*
  The map's look: 'cinematic' (a filmic finish: bloom on the sun and the lights, a highlight roll-off, teal shadows and
  warm highlights, a gentle S-curve, lens fringing toward the corners, a deeper vignette and fine moving grain), always.
  'standard' (the plain grade) is only reachable through the test hook.
*/
import { useSyncExternalStore } from 'react';

export type Look = 'standard' | 'cinematic';
const subs = new Set<() => void>();
// Always cinematic (2026-11-21: the Standard option and the first-run question are gone). setLook stays for the
// page's test hook (__worldLook) and lasts for the session only.
let cached: Look | null = null;
export const getLook = (): Look => cached ?? 'cinematic';
export function setLook(l: Look): void { cached = l; for (const f of subs) f(); }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useLook(): Look { return useSyncExternalStore(subscribe, getLook, () => 'cinematic' as Look); }
export const onLook = subscribe;

/** The cinematic finish (linear light in and out; the bloom runs before it, on the HDR frame). */
export const CINE = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uNight: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uNight; varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 roll(vec3 c) { vec3 k = 0.7 + 0.3 * (1.0 - exp(-(c - 0.7) / 0.3)); return mix(c, k, step(0.7, c)); }
    void main() {
      vec2 dc = vUv - 0.5; float r2 = dot(dc, dc);
      vec2 off = dc * r2 * 0.01;
      vec3 c = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      c = roll(max(c, 0.0));
      vec3 s = pow(c, vec3(1.0 / 2.2));
      float l = luma(s);
      s += mix(vec3(-0.014, 0.004, 0.022), vec3(0.028, 0.008, -0.026), smoothstep(0.18, 0.72, l)) * (1.0 - 0.4 * uNight);
      s = mix(s, s * s * (3.0 - 2.0 * s), 0.3);
      s = mix(vec3(luma(s)), s, 1.1);
      s *= 1.0 - smoothstep(0.12, 0.62, r2 * 1.5) * 0.42;
      s += (hash(gl_FragCoord.xy + fract(uTime * 7.31) * 311.0) - 0.5) * 0.03 * (1.0 - 0.5 * l);
      gl_FragColor = vec4(pow(clamp(s, 0.0, 1.0), vec3(2.2)), 1.0);
    }`,
};
