// ============================================================
//  Canvas painter for the approach scope (01 A10 + 04 §2.2/§4). Pure: takes a
//  Frame, paints, and returns the hit geometry the input layer needs. All
//  coordinates are CSS px (the caller sets the DPR transform). Colours come
//  only from RadarTheme (tokens), never literals.
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import type { EAirport } from '@/lib/airspace/eairport';
import type { AircraftState, Alert, Position, Stage } from '@/lib/sim/types';
import { POSITION_OWNER, WAKE_FINAL_NM } from '@/lib/sim/types';
import type { XY } from '@/lib/sim/projection';
import { NM_TO_M, advance, angleDelta, KTS_TO_MPS } from '@/lib/sim/projection';
import { ILS_CONST, gsDistM, distAlongFwd, crossTrackM } from '@/lib/sim/ils';
import { isAirborne } from '@/lib/sim/aircraft';
import type { RadarScene } from '../simStore';
import type { RadarTheme } from './theme';
import { font } from './theme';
import type { RadarCamera } from './camera';
import type { PositionHistory } from './history';
import { LabelPlacer, SYMBOL_R, type BlockRequest } from './labels';
import { turnPredictor, racetrack, turnRadiusM, cpa, magnetic, hdg3, alt100, distNM, bearingTrue } from './geometry';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
/** This frame's on-screen spread of parallel approaches (metres, by runway name). The runways stay where they are; the
 *  approach lines ease apart over the first SPREAD_NM and run parallel from there, and an aircraft on one moves with it. */
const rwShift = new Map<string, { x: number; y: number; thr: XY; course: number }>();
const SPREAD_NM = 5.6;
const spreadAt = (dNM: number) => { const u = Math.max(0, Math.min(1, dNM / SPREAD_NM)); return u * (2 - u); };
const shown = (a: AircraftState): XY => {
  const r = (a.ilsCaptured || a.ilsArmed) ? rwShift.get((a.assignedRunway ?? a.plan.runway ?? '').toUpperCase()) : undefined
  if (!r) return a.pos
  // (it slides over as it closes on its localizer: full on it, none a mile and a half to the side)
  const c = r.course * Math.PI / 180, ex = a.pos.x - r.thr.x, ey = a.pos.y - r.thr.y
  const lat = Math.abs(ex * Math.cos(c) - ey * Math.sin(c)) / NM_TO_M, out = -(ex * Math.sin(c) + ey * Math.cos(c)) / NM_TO_M
  const u = Math.max(0, Math.min(1, (1.5 - lat) / 1.1)), w = u * u * (3 - 2 * u) * spreadAt(out)
  return { x: a.pos.x + r.x * w, y: a.pos.y + r.y * w }
};
/** Screen boxes of what the chart wrote this frame: data blocks keep off them. */
const chartBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];

// ── public frame contract ──────────────────────────────────────────────────────
export interface ProjectedRoute { name: string; kind: 'sid' | 'star'; runways: string[]; beacon: string | null; pts: XY[] }
export interface Measure { a: XY; b: XY; aId: number | null; bId: number | null }
export interface HeadingDrag { id: number; cursor: XY; hdgTrue: number; dir: 'L' | 'R' | null; snap: { kind: 'fix'; name: string; xy: XY } | { kind: 'ils'; runway: string } | null }

export interface Frame {
  ctx: CanvasRenderingContext2D;
  t: RadarTheme;
  cam: RadarCamera;
  now: number;
  engine: SimEngine;
  radar: RadarScene | null;
  airspace: EAirport | null;
  routes: ProjectedRoute[];
  boundary: XY[] | null;
  fieldXY: XY;
  position: Position;
  selectedId: number | null;
  hoveredId: number | null;
  showRings: boolean;
  ringsCentre: 'field' | 'selected';
  history: PositionHistory;
  placer: LabelPlacer;
  alerts: Alert[];
  stageOf: (a: AircraftState) => Stage;
  drag: HeadingDrag | null;
  draftHeading: { id: number; hdgTrue: number; dir: 'L' | 'R' | null } | null;
  measures: Measure[];
  liveMeasure: Measure | null;
  reducedMotion: boolean;
  /** The hover compass (owned by the view, animated here). */
  compass: CompassState;
}

/** A heading rose round the hovered aircraft: the tick under the pointer swells and reads out its heading. */
export interface CompassState {
  /** The aircraft the pointer is on or near (set by the view); `id` is the one drawn (it changes once closed). */
  target: number | null;
  id: number | null;
  mx: number; my: number;
  open: number;
  ticks: Float32Array;
  last: number;
}
export const COMPASS_R = 58;
export const newCompass = (): CompassState => ({ target: null, id: null, mx: 0, my: 0, open: 0, ticks: new Float32Array(72).fill(1), last: 0 });

export interface HitGeometry {
  /** Screen position of every aircraft (CSS px). */
  symbols: Map<number, { x: number; y: number; airborne: boolean }>;
  /** Data-block rects for label hit testing. */
  labels: Map<number, { x: number; y: number; w: number; h: number }>;
  /** Midpoints of measure readouts (for the DOM pills). */
  measureMid: Array<{ x: number; y: number; text: string }>;
  /** Fix screen positions (drag snap). */
  fixes: Array<{ name: string; x: number; y: number; xy: XY }>;
}

// ── text measurement cache ─────────────────────────────────────────────────────
const widthCache = new Map<string, number>();
function textW(ctx: CanvasRenderingContext2D, f: string, s: string): number {
  const key = f + '|' + s;
  let w = widthCache.get(key);
  if (w == null) { ctx.font = f; w = ctx.measureText(s).width; if (widthCache.size > 4000) widthCache.clear(); widthCache.set(key, w); }
  return w;
}

// ── main entry ─────────────────────────────────────────────────────────────────
export function paint(fr: Frame): HitGeometry {
  const { ctx, t, cam } = fr;
  const W = cam.width, H = cam.height;
  const hit: HitGeometry = { symbols: new Map(), labels: new Map(), measureMid: [], fixes: [] };

  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.textBaseline = 'middle';

  drawChart(fr, hit);
  drawTraffic(fr, hit);
  drawCompass(fr);
  drawMeasures(fr, hit);
  drawDrag(fr);
  return hit;
}

// ── chart ──────────────────────────────────────────────────────────────────────
function drawChart(fr: Frame, hit: HitGeometry): void {
  const { ctx, t, cam, radar, engine } = fr;
  const k = cam.k;
  const centre = radar ? radar.centerXY : engine.centerXY;
  const radiusM = radar ? radar.radiusM : engine.airspaceRadiusM;
  const c = cam.toScreen(centre);
  const ringsOn = fr.showRings;

  // Range rings every 5 NM (1px .08) with label-xs --text-5 labels at 45°.
  if (ringsOn) {
    const rc = fr.ringsCentre === 'selected' && fr.selectedId != null ? engine.byId(fr.selectedId) : null;
    const rcs = rc ? cam.toScreen(rc.pos) : c;
    const steps = rc ? [3, 5, 10] : rangeSteps(radiusM, cam);
    ctx.strokeStyle = t.w08; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.fillStyle = t.text5; ctx.font = font(t, 11); ctx.textAlign = 'left';
    for (const nm of steps) {
      const r = nm * NM_TO_M * k;
      if (r < 12 || r > Math.hypot(cam.width, cam.height)) continue;
      ctx.beginPath(); ctx.arc(rcs.x, rcs.y, r, 0, TAU); ctx.stroke();
      const lx = rcs.x + r * Math.SQRT1_2 + 4, ly = rcs.y - r * Math.SQRT1_2 - 4;
      if (lx > 0 && lx < cam.width && ly > 0 && ly < cam.height) ctx.fillText(`${nm} nm`, lx, ly);
    }
  }

  // Airspace boundary: 1px .14 dashed 2 6 (polygon when the file has one, else the retire circle).
  ctx.strokeStyle = t.w14; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
  if (fr.boundary && fr.boundary.length > 2) {
    ctx.beginPath();
    fr.boundary.forEach((p, i) => { const s = cam.toScreen(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
    ctx.closePath(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(c.x, c.y, radiusM * k, 0, TAU); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Restricted areas: red tint fill, hairline dashed red .25, name + altitude in --text-4.
  if (radar) for (const a of radar.areas) {
    ctx.beginPath();
    let lx = 0, ly = 0, n = 0;
    if (a.shape === 'circle' && a.center && a.radiusM) {
      const s = cam.toScreen(a.center); ctx.arc(s.x, s.y, a.radiusM * k, 0, TAU); lx = s.x; ly = s.y; n = 1;
    } else if (a.points.length) {
      a.points.forEach((p, i) => { const s = cam.toScreen(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); lx += s.x; ly += s.y; n++; });
      ctx.closePath();
    } else continue;
    // Half the .08 tint per polygon: CTR/TMA areas overlap several deep at EGLL and the fills stack.
    // faint: the areas are context, not traffic (design A10 — map overlays stay under the data); outline carries the shape
    ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = t.redTint08; ctx.fill(); ctx.restore();
    ctx.strokeStyle = t.redBorder25; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    if (cam.pxPerNM > 14) {
      ctx.fillStyle = t.text4; ctx.font = font(t, 11); ctx.textAlign = 'center';
      ctx.fillText(`${a.name ?? 'Restricted'}${a.altFt ? ` · ${fmtAlt(a.altFt)}` : ''}`, lx / n, ly / n);
    }
  }

  // SIDs / STARs related to the selected aircraft (faint).
  const sel = fr.selectedId != null ? engine.byId(fr.selectedId) : null;
  if (sel && fr.routes.length) {
    const rwy = (sel.assignedRunway ?? sel.plan.runway ?? '').toUpperCase();
    const fix = (sel.plan.fix ?? sel.directTargetName ?? sel.holdFixName ?? '').toUpperCase();
    const kind = sel.plan.kind === 'arrival' ? 'star' : 'sid';
    const related = fr.routes.filter(r => r.kind === kind && (!rwy || r.runways.some(n => n.toUpperCase() === rwy)) && (!fix || (r.beacon ?? '').toUpperCase() === fix || r.name.toUpperCase().startsWith(fix)));
    ctx.strokeStyle = t.w10; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.fillStyle = t.w18;
    for (const r of related.slice(0, 6)) {
      ctx.beginPath();
      r.pts.forEach((p, i) => { const s = cam.toScreen(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.stroke();
      for (const p of r.pts) { const s = cam.toScreen(p); ctx.beginPath(); ctx.arc(s.x, s.y, 1.5, 0, TAU); ctx.fill(); }
      const end = cam.toScreen(r.pts[kind === 'sid' ? r.pts.length - 1 : 0]);
      ctx.fillStyle = t.text5; ctx.font = font(t, 11); ctx.textAlign = 'left';
      ctx.fillText(r.name, end.x + 6, end.y);
      ctx.fillStyle = t.w18;
    }
  }

  // ILS feathers + extended centrelines + GS-intercept circles, only on the runways taking arrivals; runways.
  const activeArr = engine.arrivalRunwaysInUse();
  const ilsByName = new Map(engine.ilsRunways.map(r => [r.name, r] as const));
  // parallel approaches are ~230-1300 m apart: zoomed out they draw as one line. The approach LINES of the runways in use
  // are spread to at least GAP_PX on screen; the runways themselves keep their true places
  const GAP_PX = 38; rwShift.clear(); chartBoxes.length = 0;
  const pair = new Map<string, { side: number; gap: number }>();
  const all = radar ? radar.runways : [];
  for (const rw of all) {
    if (!activeArr.has(rw.name)) continue;
    const c = rw.course * DEG, nx = Math.cos(c), ny = -Math.sin(c);
    const o = all.find(q => q !== rw && activeArr.has(q.name) && Math.abs(angleDelta(q.course, rw.course)) < 5 && Math.abs((rw.thr.x - q.thr.x) * nx + (rw.thr.y - q.thr.y) * ny) < 2000);
    if (!o) continue;
    const cross = (rw.thr.x - o.thr.x) * nx + (rw.thr.y - o.thr.y) * ny, gapPx = Math.abs(cross) * cam.k;
    if (Math.abs(cross) < 1) continue;
    pair.set(rw.name, { side: -Math.sign(cross), gap: Math.max(gapPx, GAP_PX) / cam.k });
    if (gapPx < GAP_PX) { const m = (GAP_PX - gapPx) / 2 / cam.k * Math.sign(cross); rwShift.set(rw.name, { x: nx * m, y: ny * m, thr: rw.thr, course: rw.course }); }
  }
  for (const rw of all) {
    if (!activeArr.has(rw.name)) continue;
    const ils = ilsByName.get(rw.name), app = (rw.course + 180) % 360, sh = rwShift.get(rw.name), mate = pair.get(rw.name), c = rw.course * DEG;
    const featherNM = ILS_CONST.gsRangeNM, tanC = Math.tan(ILS_CONST.captureDeg * DEG);
    /** A point `d` NM out on the approach as drawn, `off` metres to its right (looking along the landing course). */
    const at = (d: number, off = 0) => { const p = advance(rw.thr, app, d * NM_TO_M), w = sh ? spreadAt(d) : 0; return cam.toScreen({ x: p.x + (sh ? sh.x * w : 0) + Math.cos(c) * off, y: p.y + (sh ? sh.y * w : 0) - Math.sin(c) * off }); };
    const steps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.6, 8, 10];
    // localizer wedge +-2.5 deg, fill only; beside a parallel one it stops half way to it, so they do not lie on each other
    const edge = (side: number) => [...steps, featherNM].map(d => { const lim = mate && mate.side === side ? Math.max(0, mate.gap / 2 * Math.max(spreadAt(d), 0.1) - 2 / cam.k) : Infinity; return at(d, side * Math.min(lim, d * NM_TO_M * tanC)); });
    ctx.fillStyle = t.limeFeather; ctx.beginPath(); const L = edge(-1), Rr = edge(1).reverse(); [...L, ...Rr].forEach((p, k) => k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill();
    // extended centreline 10 NM
    ctx.strokeStyle = t.lime; ctx.lineWidth = 2; ctx.setLineDash([10, 6]);
    ctx.beginPath(); steps.forEach((d, k) => { const p = at(d); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.stroke(); ctx.setLineDash([]);
    const side = mate ? -mate.side : 1, ox = Math.cos(c) * side, oy = Math.sin(c) * side;   // outward on screen (y down)
    const note = (p: { x: number; y: number }, txt: string, px: number, color: string) => {
      ctx.font = font(t, px, 500); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = textW(ctx, ctx.font, txt) + 10, h = px + 7, x = p.x + ox * (12 + Math.abs(ox) * w / 2), y = p.y + oy * (12 + Math.abs(oy) * h / 2);
      ctx.fillStyle = t.bg; roundRect(ctx, x - w / 2, y - h / 2, w, h, 5); ctx.fill(); ctx.fillStyle = color; ctx.fillText(txt, x, y + 0.5);
      chartBoxes.push({ x: x - w / 2, y: y - h / 2, w, h });
    };
    // its name on its own line, where the lines have come apart
    if (cam.pxPerNM > 9) note(at(Math.max(3.4, 60 / cam.pxPerNM)), rw.name, 14, t.text1);
    // 2000/3000/4000 ft glideslope intercepts: bright, across the line, named on the outer side
    if (ils && cam.pxPerNM > 8) for (const ft of [2000, 3000, 4000]) {
      const p = at(gsDistM(ft, ils) / NM_TO_M);
      ctx.strokeStyle = t.limeBright; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x - ox * 7, p.y - oy * 7); ctx.lineTo(p.x + ox * 7, p.y + oy * 7); ctx.stroke();
      if (cam.pxPerNM > 13) note(p, String(ft), 13, t.limeBright);
    }
  }
  // Runway strokes (true place and length); the other names only close up, each where it has room.
  ctx.strokeStyle = t.w70; ctx.lineWidth = 2;
  for (const rw of all) { const a = cam.toScreen(rw.thr), b = cam.toScreen(advance(rw.thr, rw.course, rw.lengthM)); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  if (cam.pxPerNM > 32) for (const rw of all) {
    if (activeArr.has(rw.name)) continue;
    const p = cam.toScreen(advance(rw.thr, (rw.course + 180) % 360, 16 / cam.k)); ctx.font = font(t, 12, 500); const w = textW(ctx, ctx.font, rw.name) + 4, b = { x: p.x - w / 2, y: p.y - 8, w, h: 16 };
    if (chartBoxes.some(q => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y)) continue;
    chartBoxes.push(b); ctx.fillStyle = t.w55; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(rw.name, p.x, p.y);
  }
  if (cam.pxPerNM <= 20) {
    const f = cam.toScreen(fr.fieldXY);
    ctx.strokeStyle = t.w55; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, 7, 0, TAU); ctx.stroke();
  }

  // Entry points: inbound chevron at the boundary + beacon name.
  if (radar) for (const ep of radar.entries) {
    const s = cam.toScreen(ep);
    if (s.x < -40 || s.y < -40 || s.x > cam.width + 40 || s.y > cam.height + 40) continue;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(ep.heading * DEG);
    ctx.strokeStyle = t.w35; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-4, 4); ctx.lineTo(0, -4); ctx.lineTo(4, 4); ctx.stroke();
    ctx.restore();
    if (ep.beacon && cam.pxPerNM > 4) {
      ctx.fillStyle = t.text4; ctx.font = font(t, 11); ctx.textAlign = 'center';
      const lp = advance(ep, (ep.heading + 180) % 360, 14 / k);
      const ls = cam.toScreen(lp);
      ctx.fillText(ep.beacon, ls.x, ls.y);
    }
  }

  // Fixes: thin diamonds 8 px .55 + label-xs --text-3 name 6 px right.
  if (radar) {
    ctx.strokeStyle = t.w55; ctx.lineWidth = 1;
    ctx.fillStyle = t.text3; ctx.font = font(t, 11); ctx.textAlign = 'left';
    for (const b of radar.beacons) {
      const s = cam.toScreen(b);
      hit.fixes.push({ name: b.id, x: s.x, y: s.y, xy: { x: b.x, y: b.y } });
      if (s.x < -20 || s.y < -20 || s.x > cam.width + 20 || s.y > cam.height + 20) continue;
      ctx.beginPath(); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x + 4, s.y); ctx.lineTo(s.x, s.y + 4); ctx.lineTo(s.x - 4, s.y); ctx.closePath(); ctx.stroke();
      if (cam.pxPerNM > 3.5) ctx.fillText(b.id, s.x + 8, s.y);
    }
  }
}

function rangeSteps(radiusM: number, cam: RadarCamera): number[] {
  const maxNM = Math.max(radiusM / NM_TO_M, (Math.hypot(cam.width, cam.height) / 2) / cam.pxPerNM);
  const step = cam.pxPerNM < 6 ? 10 : 5;
  const out: number[] = [];
  for (let nm = step; nm <= maxNM + step; nm += step) out.push(nm);
  return out;
}

// ── traffic ────────────────────────────────────────────────────────────────────
interface Seg { text?: string; arrow?: 'up' | 'down'; color: string; weight?: 400 | 500 }
interface Block { id: number; lines: Seg[][]; w: number; h: number; bg: string; border: string | null; dim: boolean }
const LINE_H = 13;
const PAD_X = 8;
const PAD_Y = 5;
const ARROW_W = 9;

function drawTraffic(fr: Frame, hit: HitGeometry): void {
  const { ctx, t, cam, engine, now } = fr;
  const k = cam.k;
  const aircraft = engine.aircraft;
  const myPos = fr.position;
  const pulse = fr.reducedMotion ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((now / 1200) * TAU));
  const crawl = fr.reducedMotion ? 0 : -((now / 1000) * 8) % 8;
  const stcaPairs = pairsFromAlerts(fr.alerts, engine);
  const conflictIds = new Set<number>();
  for (const a of aircraft) if (a.conflict) conflictIds.add(a.id);
  for (const p of stcaPairs) { conflictIds.add(p.a.id); conflictIds.add(p.b.id); }

  const isMine = (a: AircraftState) => POSITION_OWNER[a.onFrequency] === myPos;
  const selected = fr.selectedId != null ? engine.byId(fr.selectedId) ?? null : null;

  // ── underlays: hold ovals, wake arcs, separation ring, direct / ILS guides, turn predictor ──
  for (const a of aircraft) {
    const air = isAirborne(a);
    if (!air) continue;
    const isSel = a.id === fr.selectedId;
    const s = cam.toScreen(shown(a));

    // Hold: predicted racetrack (dashed) + actual flown track (solid)
    if (a.navMode === 'hold' && a.holdFix) {
      const rM = turnRadiusM(a.speed, a.perf.turnRateAir);
      const legM = a.holdLegNM != null ? a.holdLegNM * NM_TO_M : Math.max(60, a.holdLegMin * 60) * Math.max(60, a.speed) * KTS_TO_MPS;
      const oval = racetrack(a.holdFix, a.holdInboundHdg, a.holdTurnDir, legM, rM);
      ctx.strokeStyle = isSel ? t.orange40 : t.w25; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); oval.forEach((p, i) => { const q = cam.toScreen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.stroke();
      ctx.setLineDash([]);
      const track = fr.history.holdTrack(a.id);
      if (track.length > 1) {
        ctx.strokeStyle = isSel ? t.orange60 : t.w35; ctx.lineWidth = 1;
        ctx.beginPath(); track.forEach((p, i) => { const q = cam.toScreen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
        ctx.lineTo(s.x, s.y); ctx.stroke();
      }
      const fs = cam.toScreen(a.holdFix);
      ctx.fillStyle = isSel ? t.orange : t.text3; ctx.font = font(t, 11); ctx.textAlign = 'center';
      ctx.fillText(`HLD ${a.holdFixName ?? ''}`.trim(), fs.x, fs.y - 12);
    }

    // Wake arc behind HEAVY / SUPER on final
    const onFinal = a.ilsCaptured || a.phase === 'approach' || a.phase === 'landing';
    if (onFinal && (a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER')) {
      const nm = WAKE_FINAL_NM[a.wakeCategory].MEDIUM;
      const rPx = nm * NM_TO_M * k;
      const back = (a.heading + 180) % 360;
      const a0 = (back - 30) * DEG - Math.PI / 2, a1 = (back + 30) * DEG - Math.PI / 2;
      ctx.strokeStyle = t.orange40; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(s.x, s.y, rPx, a0, a1); ctx.stroke();
      if (cam.pxPerNM > 6) {
        const lp = cam.toScreen(advance(a.pos, back, nm * NM_TO_M));
        ctx.fillStyle = t.text4; ctx.font = font(t, 11); ctx.textAlign = 'center';
        ctx.fillText(`${nm} nm`, lp.x, lp.y + (back > 90 && back < 270 ? 9 : -9));
      }
    }

    // Direct-to line
    if (a.navMode === 'direct' && a.directTargetXY) {
      const d = cam.toScreen(a.directTargetXY);
      ctx.strokeStyle = isSel ? t.orange40 : t.w18; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(d.x, d.y); ctx.stroke(); ctx.setLineDash([]);
    }

    if (isSel) {
      // Separation ring 3 NM (wake-aware would need the trailer; 3 NM is the radar minimum)
      const rPx = 3 * NM_TO_M * k;
      ctx.strokeStyle = conflictIds.has(a.id) ? t.red : t.w25; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.lineDashOffset = crawl * 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, rPx, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;

      // ILS intercept guide when armed and not yet captured
      if (a.ilsArmed && !a.ilsCaptured && a.assignedRunway) {
        const ils = engine.ilsRunways.find(r => r.name === a.assignedRunway);
        if (ils) {
          const along = Math.max(0, distAlongFwd(a.pos, ils));
          const foot = advance(ils.thrXY, (ils.rwdHdg + 180) % 360, along);
          const f = cam.toScreen(foot);
          ctx.strokeStyle = t.lime50; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(f.x, f.y); ctx.stroke(); ctx.setLineDash([]);
        }
      }

      // Turn predictor: live drag > draft bubble > pending / commanded heading
      let target: number | null = null, dir: 'L' | 'R' | null = a.turnDir;
      if (fr.drag && fr.drag.id === a.id) { target = fr.drag.hdgTrue; dir = fr.drag.dir; }
      else if (fr.draftHeading && fr.draftHeading.id === a.id) { target = fr.draftHeading.hdgTrue; dir = fr.draftHeading.dir; }
      else {
        const pend = [...a.pendingCmds].reverse().find(p => p.kind === 'heading');
        if (pend) { target = pend.value; dir = (pend.ast && pend.ast.kind === 'heading' ? pend.ast.dir : null) ?? dir; }
        else if (a.navMode === 'heading' && Math.abs(angleDelta(a.heading, a.targetHeading)) > 2) target = a.targetHeading;
      }
      if (target != null && Math.abs(angleDelta(a.heading, target)) > 1) {
        const pts = turnPredictor(a.pos, a.heading, target, dir, a.speed, a.perf.turnRateAir, 60);
        ctx.strokeStyle = t.orange; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
        ctx.beginPath(); pts.forEach((p, i) => { const q = cam.toScreen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.stroke();
        const end = cam.toScreen(pts[pts.length - 1]);
        ctx.fillStyle = t.orange; ctx.beginPath(); ctx.arc(end.x, end.y, 2, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ── STCA / conflict pair lines with CPA prediction ──
  ctx.lineWidth = 1;
  for (const p of stcaPairs) {
    const sa = cam.toScreen(shown(p.a)), sb = cam.toScreen(shown(p.b));
    ctx.strokeStyle = t.red; ctx.globalAlpha = pulse; ctx.setLineDash([4, 4]); ctx.lineDashOffset = crawl;
    ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.globalAlpha = 1;
    const c = cpa(p.a, p.b, 120);
    if (c && c.t > 3) {
      const pa = cam.toScreen(c.pa), pb = cam.toScreen(c.pb);
      ctx.strokeStyle = t.red40; ctx.setLineDash([1, 4]);
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(pa.x, pa.y); ctx.moveTo(sb.x, sb.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = t.red; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(pa.x, pa.y, 3, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(pb.x, pb.y, 3, 0, TAU); ctx.stroke();
      ctx.fillStyle = t.text3; ctx.font = font(t, 10); ctx.textAlign = 'center';
      ctx.fillText(`CPA ${Math.round(c.t)} s`, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 10);
    }
    const dNM = distNM(p.a.pos, p.b.pos), dFt = Math.abs(p.a.altitude - p.b.altitude);
    pill(ctx, t, (sa.x + sb.x) / 2, (sa.y + sb.y) / 2, `${dNM.toFixed(1)} nm / ${Math.round(dFt / 100) * 100} ft`, t.red, t.bg3, t.redTint);
  }

  // ── trails, vectors, symbols, rings ──
  const blocks: Block[] = [];
  const reqs: BlockRequest[] = [];
  const magVar = engine.magVar;
  for (const a of aircraft) {
    const s = cam.toScreen(shown(a)), real = cam.toScreen(a.pos), sx = s.x - real.x, sy = s.y - real.y;   // (its trail and vector move with it)
    const air = isAirborne(a);
    hit.symbols.set(a.id, { x: s.x, y: s.y, airborne: air });
    if (s.x < -80 || s.y < -80 || s.x > cam.width + 80 || s.y > cam.height + 80) continue;
    const isSel = a.id === fr.selectedId;
    const isHover = a.id === fr.hoveredId;
    const mine = isMine(a);
    const conflict = conflictIds.has(a.id);
    const emerg = !!a.emergency && a.emergency.status !== 'resolved';
    const dim = air && !mine && !isSel;

    if (!air) {
      // Landed / on the ground: tiny .55 dot, block only on hover / selection
      ctx.fillStyle = isSel ? t.orange : t.w55;
      ctx.beginPath(); ctx.arc(s.x, s.y, isSel ? 2.5 : 1.75, 0, TAU); ctx.fill();
      if (isSel || isHover) {
        const lines: Seg[][] = [[{ text: a.callsign, color: t.text1, weight: 500 }], [{ text: fr.stageOf(a).replace(/_/g, ' '), color: t.text3 }]];
        pushBlock(ctx, t, blocks, reqs, a.id, s, lines, isSel ? t.bg4 : t.dataBlock, isSel ? t.w18 : null, true, isSel ? 100 : 70);
      }
      continue;
    }

    // history dots (5 sweeps), .35 fading to .05
    const dots = fr.history.dots(a.id, 5);
    ctx.fillStyle = dim ? t.w45 : t.text1;
    for (let i = 0; i < dots.length; i++) {
      const q = cam.toScreen(dots[i]);
      ctx.globalAlpha = 0.05 + 0.30 * ((i + 1) / dots.length) * (dim ? 0.5 : 1);
      ctx.beginPath(); ctx.arc(q.x + sx, q.y + sy, 1, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 1-minute vector
    if (!dim || isSel) {
      const v = cam.toScreen(advance(a.pos, a.heading, a.speed * KTS_TO_MPS * 60));
      v.x += sx; v.y += sy;
      const dx = v.x - s.x, dy = v.y - s.y, len = Math.hypot(dx, dy);
      if (len > SYMBOL_R + 1) {
        ctx.strokeStyle = isSel ? t.orange60 : t.w35; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(s.x + (dx / len) * SYMBOL_R, s.y + (dy / len) * SYMBOL_R); ctx.lineTo(v.x, v.y); ctx.stroke();
      }
    }

    // rings: selected puck Ø40, conflict Ø24 red pulse, emergency Ø32 red pulse, hover halo Ø28
    if (isSel) {
      ctx.fillStyle = t.orangeTint08; ctx.beginPath(); ctx.arc(s.x, s.y, 20, 0, TAU); ctx.fill();
      ctx.strokeStyle = t.orangeBorder; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(s.x, s.y, 20, 0, TAU); ctx.stroke();
    } else if (isHover) {
      ctx.strokeStyle = t.w12; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(s.x, s.y, 14, 0, TAU); ctx.stroke();
    }
    if (emerg) {
      ctx.strokeStyle = t.red; ctx.lineWidth = 1.5; ctx.globalAlpha = pulse;
      ctx.beginPath(); ctx.arc(s.x, s.y, 16, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (conflict) {
      ctx.strokeStyle = t.red; ctx.lineWidth = 1.5; ctx.globalAlpha = pulse;
      ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    }

    // symbol: navigation chevron 10 px, 1.5 px stroke
    const col = emerg ? t.red : isSel ? t.orange : dim ? t.w45 : t.text1;
    chevron(ctx, s.x, s.y, a.heading, isHover ? 1.15 : 1, col);

    // data block
    const lines = blockLines(a, fr, t, dim, magVar, conflict, emerg);
    const bg = emerg ? t.red85 : isSel ? t.bg4 : isHover ? t.bg3 : dim ? t.handedBlock : conflict ? t.bg3 : t.dataBlock;
    const priority = isSel ? 100 : emerg ? 90 : conflict ? 80 : isHover ? 70 : mine ? 50 : 10;
    pushBlock(ctx, t, blocks, reqs, a.id, s, lines, bg, isSel ? t.w18 : null, dim, priority, conflict && !emerg ? t.redTint : null);
  }

  // ── place + paint data blocks ──
  const placed = fr.placer.place(reqs, cam.width, now, chartBoxes);
  for (const b of blocks) {
    const p = placed.get(b.id); if (!p) continue;
    const s = hit.symbols.get(b.id)!;
    hit.labels.set(b.id, { x: p.x, y: p.y, w: b.w, h: b.h });
    // leader from the symbol edge to the block attach point
    const dx = p.ax - s.x, dy = p.ay - s.y, len = Math.hypot(dx, dy) || 1;
    ctx.strokeStyle = b.id === fr.selectedId ? t.orange60 : b.id === fr.hoveredId ? t.w55 : t.w35; ctx.lineWidth = b.id === fr.hoveredId ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(s.x + (dx / len) * SYMBOL_R, s.y + (dy / len) * SYMBOL_R); ctx.lineTo(p.ax, p.ay); ctx.stroke();
    roundRect(ctx, p.x, p.y, b.w, b.h, 8);
    ctx.fillStyle = b.bg; ctx.fill();
    if (b.border) { ctx.strokeStyle = b.border; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.textAlign = 'left';
    let y = p.y + PAD_Y + LINE_H / 2;
    for (const line of b.lines) {
      let x = p.x + PAD_X;
      for (const seg of line) {
        if (seg.arrow) { arrow(ctx, x + 4, y, seg.arrow, seg.color); x += ARROW_W; continue; }
        if (!seg.text) continue;
        const f = font(t, 11, seg.weight ?? 400);
        ctx.font = f; ctx.fillStyle = seg.color;
        ctx.fillText(seg.text, x, y + 0.5);
        x += textW(ctx, f, seg.text);
      }
      y += LINE_H;
    }
  }
  void selected;
}

function blockLines(a: AircraftState, fr: Frame, t: RadarTheme, dim: boolean, magVar: number, conflict: boolean, emerg: boolean): Seg[][] {
  const c1 = emerg ? t.text1 : conflict ? t.red : dim ? t.text3 : t.text1;
  const c2 = emerg ? t.text1 : dim ? t.text4 : t.text2;
  const c3 = emerg ? t.text1 : dim ? t.text4 : t.text3;
  const dot = { text: ' · ', color: emerg ? t.text1 : t.text4 } as Seg;
  // handed off (on another controller's frequency): "→ TWR" in green, selected or not, so it reads as done
  const tag = POSITION_OWNER[a.onFrequency] !== fr.position ? tagFor(a.onFrequency) : null;
  const l1: Seg[] = [{ text: a.callsign, color: c1, weight: 500 }];
  if (tag) l1.push({ text: '  → ' + tag, color: t.green, weight: 500 });
  if (!dim && a.requests.length && a.requests[0].answeredAt == null) l1.push({ text: '  REQ', color: t.orange, weight: 500 });
  if (emerg) l1.push({ text: '  EM', color: t.text1, weight: 500 });
  if (dim) return [l1, [{ text: alt100(a.altitude), color: c2 }]];

  // line 2: altitude -> commanded (pending values in orange until executed)
  const pendAlt = [...a.pendingCmds].reverse().find(p => p.kind === 'altitude');
  const cmdAlt = pendAlt ? pendAlt.value : a.cmdAltitude;
  const l2: Seg[] = [{ text: alt100(a.altitude), color: c2 }];
  if (cmdAlt != null && Math.abs(cmdAlt - a.altitude) > 150) {
    l2.push({ arrow: cmdAlt > a.altitude ? 'up' : 'down', color: pendAlt ? t.orange : c2 });
    l2.push({ text: alt100(cmdAlt), color: pendAlt ? t.orange : c2 });
  }
  if (a.expedite) l2.push({ text: ' EXPD', color: t.orange });

  // line 3: GS (tens) · wake · mode
  const pendSpd = [...a.pendingCmds].reverse().find(p => p.kind === 'speed');
  const pendHdg = [...a.pendingCmds].reverse().find(p => p.kind === 'heading');
  const wake = a.wakeCategory === 'SUPER' ? 'J' : a.wakeCategory[0];
  const mode = a.gsCaptured ? 'ILS' : a.ilsCaptured ? 'LOC' : a.ilsArmed ? 'ARM' : a.goAround ? 'GA'
    : a.navMode === 'hold' ? `HLD ${a.holdFixName ?? ''}`.trim() : a.navMode === 'direct' ? `DCT ${a.directTargetName ?? ''}`.trim()
    : a.navMode === 'sid' ? `SID${a.plan.fix ? ' ' + a.plan.fix : ''}` : pendHdg ? `H${hdg3(magnetic(pendHdg.value, magVar))}` : a.navMode === 'heading' && Math.abs(angleDelta(a.heading, a.targetHeading)) > 2 ? `H${hdg3(magnetic(a.targetHeading, magVar))}` : '';
  const l3: Seg[] = [{ text: String(Math.round(a.speed / 10)).padStart(2, '0'), color: c2 }];
  if (pendSpd) l3.push({ arrow: pendSpd.value > a.speed ? 'up' : 'down', color: t.orange }, { text: String(Math.round(pendSpd.value / 10)).padStart(2, '0'), color: t.orange });
  else if (a.cmdIas != null && Math.abs(a.cmdIas - a.speed) > 12) l3.push({ arrow: a.cmdIas > a.speed ? 'up' : 'down', color: c2 }, { text: String(Math.round(a.cmdIas / 10)).padStart(2, '0'), color: c2 });
  l3.push(dot, { text: wake, color: c2 });
  if (mode) l3.push(dot, { text: mode, color: pendHdg && mode.startsWith('H') ? t.orange : c3 });

  // line 4: runway (arrivals) / destination or SID fix (departures)
  const l4text = a.plan.kind === 'arrival' ? (a.assignedRunway ?? a.plan.runway ?? null) : (a.plan.dest ?? a.plan.fix ?? a.plan.runway ?? null);
  const lines = [l1, l2, l3];
  if (l4text) lines.push([{ text: l4text, color: c3 }]);
  return lines;
}

function tagFor(p: Position): string {
  switch (p) { case 'tower': return 'TWR'; case 'ground': return 'GND'; case 'external': return 'EXT'; case 'departure': return 'DEP'; default: return 'APP'; }
}

function pushBlock(ctx: CanvasRenderingContext2D, t: RadarTheme, blocks: Block[], reqs: BlockRequest[], id: number, s: { x: number; y: number }, lines: Seg[][], bg: string, border: string | null, dim: boolean, priority: number, tint: string | null = null): void {
  let w = 0;
  for (const line of lines) {
    let lw = 0;
    for (const seg of line) lw += seg.arrow ? ARROW_W : seg.text ? textW(ctx, font(t, 11, seg.weight ?? 400), seg.text) : 0;
    w = Math.max(w, lw);
  }
  w = Math.ceil(w + PAD_X * 2); const h = lines.length * LINE_H + PAD_Y * 2;
  blocks.push({ id, lines, w, h, bg: tint ? tint : bg, border, dim });
  reqs.push({ id, sx: s.x, sy: s.y, w, h, priority });
  if (tint) blocks[blocks.length - 1].bg = bg; // tint painted as an overlay on --bg-3 below
  if (tint) blocks[blocks.length - 1].border = t.redBorder25;
}

function pairsFromAlerts(alerts: Alert[], engine: SimEngine): Array<{ a: AircraftState; b: AircraftState }> {
  const out: Array<{ a: AircraftState; b: AircraftState }> = [];
  const seen = new Set<string>();
  for (const al of alerts) {
    if (al.kind !== 'stca' && al.kind !== 'wake') continue;
    if (al.resolvedAt != null || al.subjects.length < 2) continue;
    const a = engine.find(al.subjects[0]), b = engine.find(al.subjects[1]);
    if (!a || !b) continue;
    const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ a, b });
  }
  // engine separation_loss flags without an alert record: pair the closest conflicting aircraft
  const conf = engine.aircraft.filter(a => a.conflict && isAirborne(a));
  for (let i = 0; i < conf.length; i++) for (let j = i + 1; j < conf.length; j++) {
    const a = conf[i], b = conf[j];
    if (distNM(a.pos, b.pos) > 6 || Math.abs(a.altitude - b.altitude) > 1500) continue;
    const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ a, b });
  }
  return out;
}

// ── measures + drag ────────────────────────────────────────────────────────────
function drawMeasures(fr: Frame, hit: HitGeometry): void {
  const { ctx, t, cam, engine } = fr;
  const all = fr.liveMeasure ? [...fr.measures, fr.liveMeasure] : fr.measures;
  for (const m of all) {
    const a = cam.toScreen(m.a), b = cam.toScreen(m.b);
    ctx.strokeStyle = t.w55; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, TAU); ctx.stroke(); }
    const nm = distNM(m.a, m.b);
    const brg = magnetic(bearingTrue(m.a, m.b), engine.magVar), rev = (brg + 180) % 360;
    let text = `${nm.toFixed(1)} nm · ${hdg3(brg)}° / ${hdg3(rev)}°`;
    const ac = m.aId != null ? engine.byId(m.aId) : m.bId != null ? engine.byId(m.bId) : null;
    if (ac && ac.speed > 30) { const s = (nm / ac.speed) * 3600; text += ` · ${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`; }
    hit.measureMid.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text });
  }
}

function drawCompass(fr: Frame): void {
  const st = fr.compass, { ctx, t, cam } = fr;
  const dt = Math.min(0.05, Math.max(0, (fr.now - (st.last || fr.now)) / 1000)); st.last = fr.now;
  const ease = (rate: number) => fr.reducedMotion ? 1 : 1 - Math.exp(-dt * rate);
  // open on the target; a different target: close this one first, then open on the new one
  if (st.target !== st.id && st.open < 0.04) { st.id = st.target; st.ticks.fill(1); }
  st.open += ((st.id != null && st.id === st.target ? 1 : 0) - st.open) * ease(14);
  if (st.id == null || st.open < 0.01) return;
  const a = fr.engine.byId(st.id); if (!a) { st.id = null; return; }
  const s = cam.toScreen(shown(a)), mv = fr.engine.magVar;
  const o = st.open, R = COMPASS_R * (0.82 + 0.18 * o);
  const dx = st.mx - s.x, dy = st.my - s.y, near = Math.hypot(dx, dy) > SYMBOL_R + 6 && st.id === st.target;
  const ptrMag = ((Math.atan2(dx, -dy) * 180 / Math.PI - mv) % 360 + 360) % 360;   // the pointer's bearing, magnetic
  const dir = (mag: number) => { const r = (mag + mv) * Math.PI / 180; return { x: Math.sin(r), y: -Math.cos(r) }; };
  ctx.save(); ctx.globalAlpha = o;
  // the ring
  ctx.strokeStyle = t.w25; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.stroke();
  // ticks every 5 degrees; the ones near the pointer swell (each eases to its size: smooth as the pointer sweeps)
  const k = ease(16);
  for (let i = 0; i < 72; i++) {
    const m = i * 5, d = Math.abs(angleDelta(m, ptrMag));
    const want = near ? 1 + 1.8 * Math.exp(-(d * d) / (2 * 6 * 6)) : 1;
    st.ticks[i] += (want - st.ticks[i]) * k;
    const sc = st.ticks[i], v = dir(m);
    const len = (m % 30 === 0 ? 9 : m % 10 === 0 ? 6 : 3.5) * sc;
    const hot = Math.min(1, (sc - 1) / 1.2);
    ctx.strokeStyle = hot > 0.15 ? t.orange : m % 30 === 0 ? t.w55 : t.w35;
    ctx.globalAlpha = o * (hot > 0.15 ? 0.45 + 0.55 * hot : 1);
    ctx.lineWidth = m % 30 === 0 ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(s.x + v.x * R, s.y + v.y * R); ctx.lineTo(s.x + v.x * (R + len), s.y + v.y * (R + len)); ctx.stroke();
    if (m % 30 === 0) {
      const lr = R + 17 + 4 * (sc - 1);
      ctx.globalAlpha = o * (0.55 + 0.45 * hot); ctx.fillStyle = hot > 0.3 ? t.orange : t.text3;
      ctx.font = font(t, Math.round(9 + 3 * (sc - 1)), hot > 0.3 ? 500 : 400); ctx.textAlign = 'center';
      ctx.fillText(String(m === 0 ? 36 : m / 10).padStart(2, '0'), s.x + v.x * lr, s.y + v.y * lr);
    }
  }
  ctx.globalAlpha = o;
  // where it is pointing now: a filled marker on the ring
  const cur = magnetic(a.heading, mv), cv = dir(cur);
  ctx.fillStyle = t.text1; ctx.beginPath();
  ctx.moveTo(s.x + cv.x * (R - 1), s.y + cv.y * (R - 1));
  ctx.lineTo(s.x + cv.x * (R - 8) - cv.y * 3.5, s.y + cv.y * (R - 8) + cv.x * 3.5);
  ctx.lineTo(s.x + cv.x * (R - 8) + cv.y * 3.5, s.y + cv.y * (R - 8) - cv.x * 3.5); ctx.closePath(); ctx.fill();
  // the pointer's heading: a line out to the ring and the readout beyond it
  if (near) {
    const snap = Math.round(ptrMag / 5) * 5 % 360, v = dir(snap);
    ctx.strokeStyle = t.orange; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(s.x + v.x * (SYMBOL_R + 3), s.y + v.y * (SYMBOL_R + 3)); ctx.lineTo(s.x + v.x * R, s.y + v.y * R); ctx.stroke(); ctx.setLineDash([]);
    const tr = R + 36, tx = s.x + v.x * tr, ty = s.y + v.y * tr, label = `${hdg3(snap)}°`;
    ctx.font = font(t, 13, 500); const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = t.bg; ctx.globalAlpha = o * 0.85; ctx.beginPath(); ctx.roundRect(tx - w / 2, ty - 10, w, 20, 6); ctx.fill();
    ctx.globalAlpha = o; ctx.fillStyle = t.orange; ctx.textAlign = 'center'; ctx.fillText(label, tx, ty + 0.5);
    const turn = angleDelta(cur, snap);
    if (Math.abs(turn) >= 5) { ctx.font = font(t, 10); ctx.fillStyle = t.text3; ctx.fillText(`${turn < 0 ? 'left' : 'right'} ${Math.round(Math.abs(turn))}°`, tx, ty + 17); }
  }
  ctx.restore();
}

function drawDrag(fr: Frame): void {
  const { ctx, t, cam, engine, drag } = fr;
  if (!drag) return;
  const a = engine.byId(drag.id); if (!a) return;
  const s = cam.toScreen(shown(a));
  const c = cam.toScreen(drag.cursor);
  ctx.strokeStyle = drag.snap ? t.lime : drag.dir ? t.orange : t.w55; ctx.lineWidth = 1; ctx.setLineDash(drag.snap ? [] : [6, 4]);
  ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.setLineDash([]);
  if (drag.snap?.kind === 'fix') {
    const f = cam.toScreen(drag.snap.xy);
    ctx.strokeStyle = t.lime; ctx.beginPath(); ctx.arc(f.x, f.y, 9, 0, TAU); ctx.stroke();
  }
}

// ── primitives ─────────────────────────────────────────────────────────────────
function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, hdg: number, scale: number, color: string): void {
  ctx.save(); ctx.translate(x, y); ctx.rotate(hdg * DEG); ctx.scale(scale, scale);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5 / scale;
  ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(4.2, 4.5); ctx.lineTo(0, 2.2); ctx.lineTo(-4.2, 4.5); ctx.closePath(); ctx.stroke();
  ctx.restore();
}
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: 'up' | 'down', color: string): void {
  ctx.fillStyle = color; ctx.beginPath();
  if (dir === 'up') { ctx.moveTo(x, y - 3.5); ctx.lineTo(x + 3, y + 2); ctx.lineTo(x - 3, y + 2); }
  else { ctx.moveTo(x, y + 3.5); ctx.lineTo(x + 3, y - 2); ctx.lineTo(x - 3, y - 2); }
  ctx.closePath(); ctx.fill();
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function pill(ctx: CanvasRenderingContext2D, t: RadarTheme, cx: number, cy: number, text: string, color: string, bg: string, tint: string | null): void {
  const f = font(t, 11, 500);
  const w = textW(ctx, f, text) + 20, h = 24;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 12);
  ctx.fillStyle = bg; ctx.fill();
  if (tint) { ctx.fillStyle = tint; ctx.fill(); }
  ctx.font = f; ctx.fillStyle = color; ctx.textAlign = 'center';
  ctx.fillText(text, cx, cy + 0.5);
}
function fmtAlt(ft: number): string { return ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${Math.round(ft).toLocaleString('en-US')} ft`; }

/** Localizer hit for drag-to-ILS: inside the ±2.5° wedge within 12 NM on the approach side. */
export function ilsUnderCursor(engine: SimEngine, w: XY): string | null {
  for (const r of engine.ilsRunways) {
    const along = distAlongFwd(w, r);
    if (along < 500 || along > ILS_CONST.gsRangeNM * NM_TO_M) continue;
    const dev = Math.atan2(Math.abs(crossTrackM(w, r)), along) / DEG;
    if (dev <= ILS_CONST.captureDeg * 1.4) return r.name;
  }
  return null;
}
