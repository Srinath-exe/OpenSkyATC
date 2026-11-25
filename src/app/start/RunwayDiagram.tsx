'use client';
/*
  The airfield from above, to scale: every runway between its real thresholds, the ends in use lit with chevrons in the
  direction traffic flows (landing and taking off toward the end's heading), each end's label a switch, and the wind
  on a small compass. Hovering a runway here or in the list lights both. Interactive: click a runway near the end
  traffic should land on to set the flow that way; drag the wind arrow round the compass to set the wind (the ends into
  the wind follow it live).
*/
import * as React from 'react';
import type { RunwayPair } from '@/lib/runwayManifest';
import s from './home.module.css';

const W = 360, H = 300, PAD = 46;

export function RunwayDiagram({ runways, on, wind, hover, onHover, onToggle, onFlow, onWind }: {
  runways: RunwayPair[]; on: (end: string) => boolean; wind: { dir: number; kts: number };
  hover: string | null; onHover: (ref: string | null) => void; onToggle: (end: string) => void;
  onFlow?: (end: string, other: string) => void; onWind?: (w: { dir: number; kts: number }) => void;
}) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [drag, setDrag] = React.useState(false);
  const CX = W - 44, CY = 44, CR = 30;
  /** SVG coordinates of a pointer event. */
  const pt = (ev: { clientX: number; clientY: number }) => { const sv = svgRef.current; const m = sv?.getScreenCTM(); if (!sv || !m) return null; const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()); return { x: p.x, y: p.y }; };
  /** The wind blows FROM the direction the arrow's tail points at: drag the tail round. */
  const windAt = (ev: { clientX: number; clientY: number }) => { const p = pt(ev); if (!p || !onWind) return; const from = (Math.atan2(p.x - CX, -(p.y - CY)) * 180 / Math.PI + 360) % 360; const dir = Math.round(from / 10) * 10 % 360; if (dir !== wind.dir) onWind({ dir, kts: Math.max(wind.kts, 5) }); };
  const geo = React.useMemo(() => {
    const pts = runways.flatMap((r) => r.ends.map((e) => e.thr));
    const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng0 = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
    const k = Math.cos(lat0 * Math.PI / 180);
    const xy = (p: { lat: number; lng: number }) => ({ x: (p.lng - lng0) * 111320 * k, y: -(p.lat - lat0) * 110540 });
    const all = pts.map(xy);
    const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x)), minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y));
    const sc = Math.min((W - 2 * PAD) / Math.max(1, maxX - minX), (H - 2 * PAD) / Math.max(1, maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const map = (p: { lat: number; lng: number }) => { const q = xy(p); return { x: W / 2 + (q.x - cx) * sc, y: H / 2 + (q.y - cy) * sc }; };
    return { map, sc };
  }, [runways]);

  const windTo = (wind.dir + 180) * Math.PI / 180;
  return (
    <svg ref={svgRef} className={s.diagram} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Runway layout, ends in use and wind" data-drag={drag || undefined}
      onPointerMove={(ev) => { if (drag) windAt(ev); }} onPointerUp={() => setDrag(false)} onPointerLeave={() => setDrag(false)}>
      <defs>
        <pattern id="rd-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="currentColor" strokeOpacity="0.05" /></pattern>
      </defs>
      <rect width={W} height={H} fill="url(#rd-grid)" className={s.diagramGrid} />
      {runways.map((r) => {
        const a = geo.map(r.ends[0].thr), b = geo.map(r.ends[1].thr);
        const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const width = Math.max(7, 45 * geo.sc);
        const live = r.ends.filter((e) => on(e.name));
        const lit = hover === r.ref;
        return (
          <g key={r.ref} onMouseEnter={() => onHover(r.ref)} onMouseLeave={() => onHover(null)} data-active={live.length > 0} className={s.diagramRwy} data-hover={lit || undefined}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={width} className={s.rwyBody} strokeLinecap="butt" />
            {onFlow ? <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.max(22, width + 12)} className={s.rwyHit} strokeLinecap="butt"
              onClick={(ev) => { const p = pt(ev); if (!p) return; const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len; const [e0, e1] = r.ends; if (t < 0.5) onFlow(e0.name, e1.name); else onFlow(e1.name, e0.name); }}>
              <title>{`Click near the end traffic lands on: ${r.ends[0].name} or ${r.ends[1].name}`}</title>
            </line> : null}
            <line x1={a.x + ux * 6} y1={a.y + uy * 6} x2={b.x - ux * 6} y2={b.y - uy * 6} strokeWidth={1} strokeDasharray="6 6" className={s.rwyCentre} />
            {live.map((e) => {
              // traffic on end E rolls from E's threshold toward the other: chevrons pointing that way
              const fromA = e.name === r.ends[0].name; const dx = fromA ? ux : -ux, dy = fromA ? uy : -uy; const o = fromA ? a : b;
              return [0.2, 0.35, 0.5, 0.65, 0.8].map((t) => {
                const px = o.x + dx * len * t, py = o.y + dy * len * t, nx = -dy, ny = dx, c = width * 0.42;
                return <path key={`${e.name}-${t}`} d={`M${px - dx * c + nx * c} ${py - dy * c + ny * c} L${px} ${py} L${px - dx * c - nx * c} ${py - dy * c - ny * c}`} className={s.rwyFlow} style={{ animationDelay: `${t * 1.2}s` }} />;
              });
            })}
            {r.ends.map((e, i) => {
              const p = i === 0 ? a : b; const out = i === 0 ? -1 : 1;
              // parallels share a threshold line: L sits to the left of the direction of travel, R to the right
              const hx = -ux * out, hy = -uy * out; const side = /L$/.test(e.name) ? 1 : /R$/.test(e.name) ? -1 : 0;
              const lx = p.x + ux * out * 22 + hy * side * 13, ly = p.y + uy * out * 22 - hx * side * 13;
              const active = on(e.name);
              return (
                <g key={e.name} className={s.endTag} data-on={active || undefined} role="button" tabIndex={0} aria-pressed={active} aria-label={`Runway ${e.name} ${active ? 'in use' : 'not in use'}`}
                  onClick={() => onToggle(e.name)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(e.name); } }} data-testid={`diagram-end-${e.name}`}>
                  <rect x={lx - 18} y={ly - 10} width={36} height={20} rx={10} />
                  <text x={lx} y={ly + 4} textAnchor="middle">{e.name}</text>
                </g>
              );
            })}
          </g>
        );
      })}
      <g transform={`translate(${CX} ${CY})`} className={s.compass} data-live={onWind ? true : undefined}
        onPointerDown={(ev) => { if (!onWind) return; (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId); setDrag(true); windAt(ev); }}
        onPointerMove={(ev) => { if (drag) windAt(ev); }} onPointerUp={() => setDrag(false)}
        role={onWind ? 'slider' : undefined} aria-label="Wind direction: drag" aria-valuenow={wind.dir} aria-valuemin={0} aria-valuemax={359} tabIndex={onWind ? 0 : -1}
        onKeyDown={(ev) => { if (!onWind) return; if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { ev.preventDefault(); onWind({ dir: (wind.dir + 10) % 360, kts: Math.max(wind.kts, 5) }); } if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { ev.preventDefault(); onWind({ dir: (wind.dir + 350) % 360, kts: Math.max(wind.kts, 5) }); } }}>
        <circle r={CR + 8} className={s.compassHalo} />
        <circle r={CR} />
        {[0, 90, 180, 270].map((d) => <line key={d} x1={Math.sin(d * Math.PI / 180) * (CR - 5)} y1={-Math.cos(d * Math.PI / 180) * (CR - 5)} x2={Math.sin(d * Math.PI / 180) * CR} y2={-Math.cos(d * Math.PI / 180) * CR} className={s.compassTick} />)}
        <text y={-CR - 4} textAnchor="middle" className={s.compassN}>N</text>
        {wind.kts > 0 ? <path d={`M${-Math.sin(windTo) * (CR - 6)} ${Math.cos(windTo) * (CR - 6)} L${Math.sin(windTo) * (CR - 6)} ${-Math.cos(windTo) * (CR - 6)}`} className={s.windArrow} markerEnd="url(#rd-arrow)" /> : <circle r="3" className={s.windCalm} />}
        {wind.kts > 0 ? <circle cx={-Math.sin(windTo) * (CR - 6)} cy={Math.cos(windTo) * (CR - 6)} r="5" className={s.windKnob} /> : null}
        <defs><marker id="rd-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" className={s.windHead} /></marker></defs>
      </g>
      <text x={CX} y={CY + CR + 18} textAnchor="middle" className={s.compassLabel}>{wind.kts > 0 ? `${String(wind.dir).padStart(3, '0')}° ${wind.kts} kt` : 'Calm'}</text>
      {onWind ? <text x={CX} y={CY + CR + 31} textAnchor="middle" className={s.compassHint}>drag</text> : null}
    </svg>
  );
}
