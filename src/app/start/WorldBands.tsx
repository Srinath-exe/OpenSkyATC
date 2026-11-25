'use client';
/* The world, cut into one band of longitude per airport. Pointing at a band lights its land up, outwards from the pin. */
import * as React from 'react';
import { AIRPORT_BY_ICAO, LISTED_AIRPORTS, runwaysOf } from '../_lib/airports';
import { loadPickWorld, type PickWorld } from './pickMap';
import s from './picker.module.css';

const at = (icao: string): { lat: number; lng: number } => { const e = runwaysOf(icao).flatMap((r) => r.ends.map((x) => x.thr)); return { lat: e.reduce((a, p) => a + p.lat, 0) / Math.max(1, e.length), lng: e.reduce((a, p) => a + p.lng, 0) / Math.max(1, e.length) }; };
const LNG0 = -170, LNG1 = 190, LAT0 = 74, LAT1 = -56;
/** West to east, each with the stretch of the world nearest it. */
const BANDS = (() => {
  const list = LISTED_AIRPORTS.map((a) => ({ icao: a.icao, ...at(a.icao) })).sort((a, b) => a.lng - b.lng);
  return list.map((a, i) => ({ ...a, from: i ? (list[i - 1].lng + a.lng) / 2 : LNG0, to: i < list.length - 1 ? (a.lng + list[i + 1].lng) / 2 : LNG1 }));
})();

export interface BandGeom { pin: (icao: string) => [number, number] | null }
interface Fit { W: number; H: number; k: number; x0: number; y0: number }
const x = (f: Fit, lng: number) => f.x0 + (lng - LNG0) * f.k, y = (f: Fit, lat: number) => f.y0 + (LAT0 - lat) * f.k;

export function WorldBands({ hot, times, geom, onPoint, onFocus, onChoose, isTouch }: {
  hot: string | null; times: Record<string, string>; geom: React.MutableRefObject<BandGeom | null>;
  onPoint: (icao: string | null) => void; onFocus: (icao: string) => void; onChoose: (icao: string) => void; isTouch: () => boolean;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null), cvRef = React.useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = React.useState<Fit | null>(null);
  const [world, setWorld] = React.useState<PickWorld | null>(null);
  const hotRef = React.useRef(hot), wake = React.useRef<() => void>(() => { /* set below */ });

  React.useEffect(() => { let off = false; void loadPickWorld().then((w) => { if (!off) setWorld(w); }); return () => { off = true; }; }, []);
  React.useLayoutEffect(() => {
    const el = boxRef.current; if (!el) return;
    const size = () => { const W = el.clientWidth, H = el.clientHeight, foot = W <= 760 ? 58 : 92, k = Math.min(W / (LNG1 - LNG0), (H - foot) / (LAT0 - LAT1)); setFit({ W, H, k, x0: (W - (LNG1 - LNG0) * k) / 2, y0: Math.max(0, (H - foot - (LAT0 - LAT1) * k) / 2) }); };
    size(); const ro = new ResizeObserver(size); ro.observe(el); return () => ro.disconnect();
  }, []);
  React.useEffect(() => {
    geom.current = fit ? { pin: (icao) => { const b = BANDS.find((q) => q.icao === icao), el = boxRef.current, root = el?.closest<HTMLElement>('[data-view]'); if (!b || !el || !root) return null; const r = el.getBoundingClientRect(), v = root.getBoundingClientRect(); return [r.left - v.left + x(fit, b.lng), r.top - v.top + y(fit, b.lat)]; } } : null;
    return () => { geom.current = null; };
  }, [fit, geom]);

  // the land: every dot once, each band with its own light (0 off, 1 all lit), spreading from its pin
  React.useEffect(() => {
    const cv = cvRef.current; if (!cv || !fit || !world) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.round(fit.W * dpr); cv.height = Math.round(fit.H * dpr);
    const c = cv.getContext('2d'); if (!c) return; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    let still = false; try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
    const dots: { px: number; py: number; b: number; d: number }[] = [], far = BANDS.map(() => 1);
    world.rows.forEach((hex, r) => { for (let col = 0; col < world.cols; col++) { if (!(parseInt(hex[col >> 2], 16) & (8 >> (col & 3)))) continue; const lng = world.lng0 + (col + 0.5) * world.step, lat = world.lat0 - (r + 0.5) * world.step, b = Math.max(0, BANDS.findIndex((q) => lng >= q.from && lng < q.to)), d = Math.hypot(lng - BANDS[b].lng, lat - BANDS[b].lat); far[b] = Math.max(far[b], d); dots.push({ px: x(fit, lng), py: y(fit, lat), b, d }); } });
    const light = BANDS.map(() => 0), rad = Math.max(0.9, fit.k * world.step * 0.3); let raf = 0, last = 0, dim = 0;
    const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
    const OFF = [62, 72, 84], LOW = [38, 45, 54], NEAR = [255, 150, 78], FAR = [196, 206, 217];
    const draw = (now: number) => {
      raf = 0; const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now; let busy = false;
      const want = hotRef.current ? 1 : 0; dim += (want - dim) * (still ? 1 : 1 - Math.exp(-dt * 7)); if (Math.abs(want - dim) > 0.01) busy = true; else dim = want;
      BANDS.forEach((q, i) => { const to = q.icao === hotRef.current ? 1 : 0; light[i] = still ? to : to ? Math.min(1, light[i] + dt * 1.5) : Math.max(0, light[i] - dt * 3.2); if (light[i] !== to) busy = true; });
      c.clearRect(0, 0, fit.W, fit.H);
      for (const o of dots) {
        const L = light[o.b], e = 1 - Math.pow(1 - L, 3), front = e * (far[o.b] + 14), on = L > 0 ? Math.max(0, Math.min(1, (front - o.d) / 14)) : 0, n = Math.min(1, o.d / 34);
        const base = [0, 1, 2].map((i) => OFF[i] + (LOW[i] - OFF[i]) * dim), lit = [0, 1, 2].map((i) => NEAR[i] + (FAR[i] - NEAR[i]) * n);
        c.fillStyle = mix(base, lit, on); const r = rad * (1 + 0.18 * on); c.beginPath(); c.arc(o.px, o.py, r, 0, 6.2832); c.fill();
      }
      if (busy) raf = requestAnimationFrame(draw); else last = 0;
    };
    wake.current = () => { if (!raf) { last = 0; raf = requestAnimationFrame(draw); } };
    wake.current(); return () => { cancelAnimationFrame(raf); raf = -1; };
  }, [fit, world]);
  React.useEffect(() => { hotRef.current = hot; wake.current(); }, [hot]);

  return (
    <div ref={boxRef} className={s.world} onPointerLeave={() => { if (!isTouch()) onPoint(null); }}>
      <canvas ref={cvRef} className={s.dots} aria-hidden="true" />
      {fit ? BANDS.map((q, i) => {
        const a = AIRPORT_BY_ICAO[q.icao], l = i ? x(fit, q.from) : 0, r = i < BANDS.length - 1 ? x(fit, q.to) : fit.W;
        return (
          <button key={q.icao} type="button" className={s.band} style={{ left: l, width: r - l }} data-hot={hot === q.icao || undefined} data-dim={(hot != null && hot !== q.icao) || undefined} data-testid={`airport-card-${q.icao}`} data-icao={q.icao}
            onPointerEnter={(e) => { if (e.pointerType !== 'touch') onPoint(q.icao); }} onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) onFocus(q.icao); }} onClick={() => onChoose(q.icao)}
            aria-label={`${a.city}, ${a.name} (${q.icao}), ${runwaysOf(q.icao).length} runways`}>
            <span className={s.pin} style={{ left: x(fit, q.lng) - l, top: y(fit, q.lat) }}><i /></span>
            <span className={s.bandText}><b>{a.city}</b><small><em>{a.iata}</em>{times[q.icao] ? <span>{times[q.icao]} local</span> : null}</small></span>
          </button>
        );
      }) : null}
    </div>
  );
}
