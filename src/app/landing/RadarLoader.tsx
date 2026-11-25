'use client';
/*
  The landing's loading screen: a full-screen radar scope, drawn in code on one canvas (no images, no libraries), live
  from the first frame while the film loads behind it.
  - the scope: a few faint rings and a quiet bearing ring (drawn once per size into an offscreen canvas)
  - the sweep, and a handful of returns painted as it passes them, fading until the next turn (green in, amber out)
  - the centre: a thin progress ring and the percentage. Kept deliberately sparse.
  The page's engine writes the load progress into data-p and marks the root data-ready on its first film frame; the
  scope then sweeps fast once, opens out and fades, and stops drawing.
*/
import * as React from 'react';
import s from './landing.module.css';

const G = '92,255,176', A = '255,184,77';
const CS = ['DAL40', 'UAL1549', 'ETD24', 'ASA331', 'SWA2210', 'AAL17', 'JBU915', 'SKW5521', 'UAL837', 'BAW285', 'CPA873', 'QFA74', 'ANA7', 'KAL213',
  'EVA18', 'SIA31', 'AFR84', 'DLH455', 'VIR41', 'ACA759', 'FFT1902', 'NKS671', 'HAL11', 'JAL1', 'UAE225', 'SJX12', 'THY79', 'AIC173'];
const W_SWEEP = (Math.PI * 2) / 2.6;          // one turn in 2.6 s

interface Paint { x: number; y: number; t: number }
interface Tgt { cs: string; x: number; y: number; vx: number; vy: number; dep: boolean; alt: number; kt: number; paints: Paint[] }

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
function spawn(dep: boolean, scatter: boolean): Tgt {
  const cs = CS[(Math.random() * CS.length) | 0];
  if (dep) {
    // off runway 1L/1R or 28, climbing out and turning
    const h = [14, 14, 284][(Math.random() * 3) | 0] * Math.PI / 180 + rnd(-0.25, 0.25), r = scatter ? rnd(0.05, 0.7) : 0.03, v = rnd(0.028, 0.04);
    return { cs, x: Math.sin(h) * r, y: -Math.cos(h) * r, vx: Math.sin(h) * v, vy: -Math.cos(h) * v, dep, alt: 0, kt: 0, paints: [] };
  }
  const b = rnd(0, Math.PI * 2), r = scatter ? rnd(0.25, 1.15) : rnd(1.0, 1.2), v = rnd(0.016, 0.028), sw = rnd(0.35, 0.75) * (Math.random() < 0.5 ? 1 : -1);
  const x = Math.sin(b) * r, y = -Math.cos(b) * r;
  const ix = -x / r, iy = -y / r, c = Math.cos(sw), sn = Math.sin(sw);    // inbound, turned off the centre: spirals in
  return { cs, x, y, vx: (ix * c - iy * sn) * v, vy: (ix * sn + iy * c) * v, dep, alt: 0, kt: 0, paints: [] };
}

export function RadarLoader() {
  const host = React.useRef<HTMLDivElement>(null);
  const cv = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const el = host.current!, canvas = cv.current!, ctx = canvas.getContext('2d')!;
    const root = (el.closest('[data-loader-root]') as HTMLElement | null) ?? el.parentElement!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const font = getComputedStyle(el).fontFamily || 'ui-monospace, monospace';
    let w = 0, h = 0, dpr = 1, R = 1, Rb = 1, cx = 0, cy = 0, raf = 0, dead = false;
    const stat = document.createElement('canvas'), sctx = stat.getContext('2d')!;
    const tg: Tgt[] = [...Array.from({ length: 9 }, () => spawn(false, true)), ...Array.from({ length: 2 }, () => spawn(true, true))];

    const layout = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = el.clientWidth; h = el.clientHeight; cx = w / 2; cy = h / 2;
      R = Math.hypot(w, h) / 2 * 1.02; Rb = Math.min(w, h) * 0.44;
      for (const c of [canvas, stat]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      // the static scope
      const g = sctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      glow.addColorStop(0, `rgba(${G},0.05)`); glow.addColorStop(0.5, `rgba(${G},0.015)`); glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
      g.lineWidth = 1;
      for (let k = 1; k <= 4; k++) { g.strokeStyle = `rgba(${G},0.06)`; g.beginPath(); g.arc(cx, cy, (Rb * k) / 4, 0, Math.PI * 2); g.stroke(); }
      // bearing ring
      g.strokeStyle = `rgba(${G},0.14)`; g.beginPath(); g.arc(cx, cy, Rb, 0, Math.PI * 2); g.stroke();
      for (let d = 0; d < 360; d += 10) {
        const a = d * Math.PI / 180, l = d % 90 === 0 ? 8 : 4, sa = Math.sin(a), ca = -Math.cos(a);
        g.strokeStyle = `rgba(${G},${d % 90 === 0 ? 0.35 : 0.16})`; g.beginPath(); g.moveTo(cx + sa * Rb, cy + ca * Rb); g.lineTo(cx + sa * (Rb - l), cy + ca * (Rb - l)); g.stroke();
      }
    };
    layout();
    const ro = new ResizeObserver(layout); ro.observe(el);

    const t0 = performance.now(); let last = t0, th = -Math.PI / 2, out = -1;
    const frame = (now: number) => {
      if (dead) return;
      const t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000); last = now;
      const p = Math.max(0, Math.min(1, Number(el.dataset.p || 0)));
      const ready = root.dataset.ready === '1';
      if (out < 0 && ready && t > 1.3) out = t;                        // ready (and seen for a moment): open out
      const e = out < 0 ? 0 : Math.min(1, (t - out) / 0.9), ee = e * e * (3 - 2 * e);
      const prev = th; th += W_SWEEP * dt * (reduce ? 0.35 : 1 + ee * 3);
      // traffic: move continuously, painted when the sweep crosses its bearing
      for (let i = 0; i < tg.length; i++) {
        const a = tg[i]; a.x += a.vx * dt; a.y += a.vy * dt;
        if (!a.dep) { const vv = 1 + 0.25 * dt; a.vx = a.vx * vv - a.x * 0.004 * dt; a.vy = a.vy * vv - a.y * 0.004 * dt; }   // drawn in
        const r = Math.hypot(a.x, a.y);
        a.alt = a.dep ? Math.min(19000, r * 26000) : 900 + r * 12000; a.kt = a.dep ? 160 + r * 300 : 140 + r * 160;
        if ((!a.dep && r < 0.035) || r > 1.3) { tg[i] = spawn(a.dep, false); continue; }
        const b = Math.atan2(a.x, -a.y) - Math.PI / 2;                   // canvas angle of its bearing
        const crossed = ((b - prev) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) < th - prev;
        if (crossed) { a.paints.push({ x: a.x, y: a.y, t }); if (a.paints.length > 7) a.paints.shift(); }
      }
      const c = ctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
      c.save();
      if (ee > 0) { const k = 1 + ee * 0.45; c.translate(cx, cy); c.scale(k, k); c.translate(-cx, -cy); c.globalAlpha = 1 - ee; }
      c.drawImage(stat, 0, 0, w, h);
      // the sweep: a phosphor wedge behind the beam, then the beam
      const trail = 1.25;
      const cg = c.createConicGradient(th - trail, cx, cy);
      cg.addColorStop(0, `rgba(${G},0)`); cg.addColorStop(trail / (Math.PI * 2) * 0.7, `rgba(${G},0.05)`); cg.addColorStop(trail / (Math.PI * 2), `rgba(${G},0.13)`); cg.addColorStop(trail / (Math.PI * 2) + 0.0005, `rgba(${G},0)`); cg.addColorStop(1, `rgba(${G},0)`);
      c.fillStyle = cg; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
      const bx = Math.cos(th) * R, by = Math.sin(th) * R;
      c.lineCap = 'round';
      for (const [lw, al] of [[3, 0.08], [1, 0.6]] as const) { c.strokeStyle = `rgba(${G},${al})`; c.lineWidth = lw; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + bx, cy + by); c.stroke(); }
      // traffic: last paints fading, the newest bright with its data block
      for (const a of tg) {
        const P = a.paints; if (!P.length) continue;
        const col = a.dep ? A : G;
        for (let k = Math.max(0, P.length - 3); k < P.length - 1; k++) { const q = P[k]; c.fillStyle = `rgba(${col},0.14)`; c.beginPath(); c.arc(cx + q.x * R, cy + q.y * R, 1.4, 0, Math.PI * 2); c.fill(); }
        const q = P[P.length - 1], br = Math.exp(-(t - q.t) / 1.6), x = cx + q.x * R, y = cy + q.y * R;
        c.fillStyle = `rgba(${col},${0.08 + 0.18 * br})`; c.beginPath(); c.arc(x, y, 4 + 4 * br, 0, Math.PI * 2); c.fill();
        c.fillStyle = `rgba(${col},${0.4 + 0.6 * br})`; c.beginPath(); c.arc(x, y, 2, 0, Math.PI * 2); c.fill();
      }
      // the centre: progress ring and percentage
      const r0 = Math.max(46, Math.min(w, h) * 0.085), shown = out < 0 ? Math.min(p, 0.97 + 0.03 * Number(ready)) : 1;
            c.lineWidth = 1; c.strokeStyle = `rgba(${G},0.12)`; c.beginPath(); c.arc(cx, cy, r0, 0, Math.PI * 2); c.stroke();
      c.lineWidth = 1.5; c.strokeStyle = `rgba(${G},0.85)`; c.beginPath(); c.arc(cx, cy, r0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * shown); c.stroke();
      const ea = -Math.PI / 2 + Math.PI * 2 * shown; c.fillStyle = `rgb(${G})`; c.beginPath(); c.arc(cx + Math.cos(ea) * r0, cy + Math.sin(ea) * r0, 2, 0, Math.PI * 2); c.fill();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(236,244,240,0.9)'; c.font = `300 ${Math.round(r0 * 0.42)}px ${font}`; c.fillText(String(Math.round(shown * 100)), cx, cy);
      c.restore();
      if (e >= 1) { el.dataset.gone = '1'; return; }                   // done: stop drawing
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { dead = true; cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div ref={host} data-el="loader" className={s.loader} aria-hidden="true">
      <canvas ref={cv} />
    </div>
  );
}
