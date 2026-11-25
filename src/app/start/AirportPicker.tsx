'use client';
/* Choosing the airport, as a list of names or on the world. Pointing at one opens a drop with that airport's map in it,
   choosing one flies through the drop until the map is the screen, and the shift set-up opens on top of it. */
import * as React from 'react';
import { Segmented } from '@/design';
import { LISTED_AIRPORTS, longestRunwayFt, runwaysOf, formatFeet, type AirportMeta } from '../_lib/airports';
import { capY, drawPickMap, dropSize, loadPickMap, MAP_BG } from './pickMap';
import { WorldBands, type BandGeom } from './WorldBands';
import s from './picker.module.css';

const GROUPS: [string, string[]][] = [['North America', ['KSFO', 'KJFK', 'KLAX', 'KBOS']], ['Europe', ['EGLL', 'LFPG']], ['Middle East', ['OMDB']], ['Asia Pacific', ['WSSS', 'RJTT', 'VHHH', 'VIDP', 'YSSY']]];
const ZONE: Record<string, string> = { KSFO: 'America/Los_Angeles', KLAX: 'America/Los_Angeles', KJFK: 'America/New_York', KBOS: 'America/New_York', EGLL: 'Europe/London', LFPG: 'Europe/Paris', OMDB: 'Asia/Dubai', WSSS: 'Asia/Singapore', RJTT: 'Asia/Tokyo', VHHH: 'Asia/Hong_Kong', VIDP: 'Asia/Kolkata', YSSY: 'Australia/Sydney' };
const ROWS: AirportMeta[] = GROUPS.flatMap(([, list]) => LISTED_AIRPORTS.filter((a) => list.includes(a.icao)));

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
type Sp = { x: number; v: number };
const spring = (o: Sp, to: number, w: number, dt: number, z = 1) => { for (let i = 0, d = dt / 2; i < 2; i++) { o.v += (w * w * (to - o.x) - 2 * z * w * o.v) * d; o.x += o.v * d; } if (Math.abs(to - o.x) < 0.0004 && Math.abs(o.v) < 0.004) { o.x = to; o.v = 0; } };
const sq = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 0.62);   // 1 = oval, 0 = rectangle
interface Drop { cx: number; cy: number; rx: number; ry: number; t: number; amp: number; vx: number; vy: number; wob: number; ox?: number; oy?: number; s?: number }
/** A drop: a wobbling rounded oval that stretches along its own movement. */
function blob({ cx, cy, rx, ry, t, amp, vx, vy, wob, ox = 0, oy = 0, s: k = 1 }: Drop): string {
  const M = 64, st = clamp(Math.hypot(vx, vy) / 4200, 0, 0.09) * amp, av = Math.atan2(vy, vx), pts: [number, number][] = [];
  for (let n = 0; n < M; n++) {
    const th = n / M * Math.PI * 2, m = 1 + amp * ((0.014 + wob * 0.03) * Math.sin(2 * th + t * 1.9) + (0.01 + wob * 0.025) * Math.sin(3 * th - t * 2.4) + 0.006 * Math.sin(5 * th + t * 3.1)) + st * Math.cos(2 * (th - av));
    pts.push([(cx + sq(Math.cos(th)) * rx * m - ox) / k, (cy + sq(Math.sin(th)) * ry * m - oy) / k]);
  }
  const mid = (p: [number, number], q: [number, number]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], p0 = mid(pts[M - 1], pts[0]); let d = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}`;
  for (let n = 0; n < M; n++) { const q = mid(pts[n], pts[(n + 1) % M]); d += `Q${pts[n][0].toFixed(1)} ${pts[n][1].toFixed(1)} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`; }
  return `${d}Z`;
}

type View = 'list' | 'map';
const VIEWS: { id: View; label: string }[] = [{ id: 'list', label: 'List' }, { id: 'map', label: 'Map' }];
const MAP_DROP = 0.6;   // the drop beside a pin is smaller than the one over the list

function useLocalTimes(): Record<string, string> {
  const [t, setT] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    const tick = () => setT(Object.fromEntries(ROWS.map((a) => { try { return [a.icao, new Intl.DateTimeFormat('en-GB', { timeZone: ZONE[a.icao], hour: '2-digit', minute: '2-digit' }).format(new Date())]; } catch { return [a.icao, '']; } })));
    tick(); const id = window.setInterval(tick, 15_000); return () => window.clearInterval(id);
  }, []);
  return t;
}

export function AirportPicker({ onPick }: { onPick: (icao: string) => void }) {
  const times = useLocalTimes();
  const rootRef = React.useRef<HTMLDivElement>(null), roomRef = React.useRef<HTMLDivElement>(null), baseRef = React.useRef<HTMLDivElement>(null), rimRef = React.useRef<SVGPathElement>(null);
  const rows = React.useRef<(HTMLButtonElement | null)[]>([]), screens = React.useRef<(HTMLDivElement | null)[]>([]), canvases = React.useRef<(HTMLCanvasElement | null)[]>([]);
  const [hot, setHot] = React.useState(-1);
  const [view, setView] = React.useState<View>('list');
  const geom = React.useRef<BandGeom | null>(null);
  React.useEffect(() => { try { if (localStorage.getItem('skycontrol_airport_view') === 'map') setView('map'); } catch { /* */ } }, []);
  const changeView = (v: View) => { setView(v); point(-1); try { localStorage.setItem('skycontrol_airport_view', v); } catch { /* */ } };
  const st = React.useRef({ view: 'list' as View, hot: -1, open: -1, ptr: { x: 0, y: 0, inside: false }, wake: () => { /* set below */ } });
  const pick = React.useRef(onPick); pick.current = onPick; st.current.view = view;
  const touch = React.useRef(false);

  const point = React.useCallback((i: number) => { const S = st.current; if (S.open >= 0) return; S.hot = i; setHot(i); S.wake(); }, []);
  const choose = (i: number) => {
    const S = st.current; if (S.open >= 0) return;
    if (touch.current && S.hot !== i) { point(i); return; }   // a finger has no hover: the first tap shows it, the second takes it
    let still = false; try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
    if (still) { pick.current(ROWS[i].icao); return; }
    S.hot = i; S.open = i; setHot(i); S.wake();
  };

  // the maps: drawn for this screen size, again when it changes
  React.useEffect(() => {
    let off = false, timer = 0;
    const draw = () => {
      const r = rootRef.current; if (!r) return; const W = r.clientWidth, H = r.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      r.style.setProperty('--cap-y', `${capY(W, H).toFixed(0)}px`);
      ROWS.forEach((a, i) => { const cv = canvases.current[i]; if (!cv) return; void loadPickMap(a.icao).then((m) => { if (!off) drawPickMap(cv, a.icao, m, W, H, dpr); }); });
    };
    const later = () => { window.clearTimeout(timer); timer = window.setTimeout(draw, 120); };
    draw(); void document.fonts?.ready.then(() => { if (!off) draw(); }); window.addEventListener('resize', later);
    return () => { off = true; window.clearTimeout(timer); window.removeEventListener('resize', later); };
  }, []);

  // one frame loop, only while a drop is on the screen
  React.useEffect(() => {
    const S = st.current, X: Sp = { x: 0, v: 0 }, Y: Sp = { x: 0, v: 0 }, C: Sp = { x: 0, v: 0 }, G: Sp = { x: 0, v: 0 }, K: Sp = { x: 0, v: 0 };
    let raf = 0, last = 0, placed = false, lead = -1, wob = 0, done = false, still = false;
    try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
    const home = (i: number, W: number, H: number): [number, number] => {
      const root = rootRef.current; if (!root) return [W / 2, H / 2];
      if (S.view === 'map') { const p = geom.current?.pin(ROWS[i].icao); return p ?? [W / 2, H / 2]; }
      const b = rows.current[i]; if (!b) return [W / 2, H / 2];
      const v = root.getBoundingClientRect(), r = b.getBoundingClientRect(), n = (b.firstElementChild as HTMLElement).getBoundingClientRect(); return [n.right - v.left, r.top - v.top + r.height / 2];
    };
    const frame = (now: number) => {
      raf = 0; const root = rootRef.current, room = roomRef.current; if (!root || !room) return;
      const dt = Math.min(0.04, last ? (now - last) / 1000 : 0.016), t = still ? 0 : now / 1000; last = now;
      const W = root.clientWidth, H = root.clientHeight, narrow = W <= 760, D = dropSize(W, H), q = S.view === 'map' && !narrow ? MAP_DROP : 1, RX = D.rx * q, RY = D.ry * q, s0 = D.s0 * q, cur = S.open, on = cur >= 0 ? cur : S.hot;
      if (on >= 0 && on !== lead) { lead = on; wob = still ? 0 : 1; } wob *= Math.exp(-dt * 2.2);
      const place = (): [number, number] => {
        if (narrow) return [W / 2, H - RY - 58];
        const bx = (x: number) => clamp(x, RX * 1.12, W - RX * 1.1), by = (y: number) => clamp(y, RY * 1.06 + 122, H - RY * 1.1 - 30);
        // on the world it stands beside the pin, on the side with the room, and never over it
        if (S.view === 'map') { const p = home(Math.max(0, on), W, H), side = p[0] < W * 0.56 ? 1 : -1; return [clamp(p[0] + side * (RX * 1.08 + 34), RX * 1.12, W - RX * 1.12), clamp(p[1] + RY * 0.25, RY * 1.1 + 120, H - RY * 1.1 - 128)]; }
        if (S.ptr.inside) return [bx(S.ptr.x + RX * 0.95), by(S.ptr.y)];
        const q = home(Math.max(0, on), W, H); return [bx(Math.max(q[0] + RX * 1.02, W * 0.6)), by(q[1])];
      };
      if (!placed && on >= 0) { const q = narrow || still ? place() : home(on, W, H); X.x = q[0]; Y.x = q[1]; X.v = Y.v = 0; C.x = on; C.v = 0; placed = true; }
      if (still) G.x = S.hot >= 0 ? 1 : 0; else spring(G, S.hot >= 0 ? 1 : 0, 8.5, dt, 0.66);
      if (placed && on < 0 && G.x < 0.01) placed = false;
      if (placed && cur < 0 && S.hot >= 0) { const [gx, gy] = place(); if (still) { X.x = gx; Y.x = gy; } else for (const [o, to] of [[X, gx], [Y, gy]] as [Sp, number][]) for (let n = 0; n < 2; n++) { o.v += (90 * (to - o.x) - 13 * o.v) * dt / 2; o.x += o.v * dt / 2; } }
      else { X.v *= 0.8; Y.v *= 0.8; }
      if (lead >= 0) { if (still) C.x = lead; else spring(C, lead, 7, dt); }
      spring(K, cur >= 0 ? 1 : 0, 4.8, dt);
      // the flight: one zoom, the map far behind the drop, the names close to you
      const k = clamp(K.x), Zm = 1 / s0, Z = Math.pow(Zm, k), f = (Z - 1) / (Zm - 1), sc = s0 * Z, cx = lerp(X.x, W / 2, f), cy = lerp(Y.x, H / 2, f), Zn = Math.pow(Z, 3), full = Math.hypot(W, H) / 2 * 1.12;
      room.style.transform = k > 0 ? `translate3d(${(cx - X.x * Zn).toFixed(1)}px,${(cy - Y.x * Zn).toFixed(1)}px,0) scale(${Zn.toFixed(4)})` : 'none'; room.style.opacity = (1 - sstep(0.35, 0.8, k)).toFixed(3);
      const g = Math.max(0, lerp(G.x, 1, sstep(0, 0.35, k))), rx = RX * Math.pow(full / RX, k) * g, ry = RY * Math.pow(full / RY, k) * g, shown = placed && rx > 3, drop: Drop = { cx, cy, rx, ry, t, amp: still ? 0 : 1 - k, vx: X.v, vy: Y.v, wob };
      ROWS.forEach((_, i) => {
        const el = screens.current[i]; if (!el) return; const d = i - C.x;
        if (!shown || Math.abs(d) > 1.2) { el.style.visibility = 'hidden'; return; }
        const ox = cx - W * sc / 2, oy = cy - H * sc / 2 + d * H * 1.04 * sc;
        el.style.visibility = 'visible'; el.style.transform = `translate3d(${ox.toFixed(2)}px,${oy.toFixed(2)}px,0) scale(${sc.toFixed(5)})`; el.style.clipPath = `path("${blob({ ...drop, ox, oy, s: sc })}")`; el.style.zIndex = i === lead ? '3' : '2';
        const cap = el.lastElementChild as HTMLElement | null; if (cap) cap.style.opacity = (1 - sstep(0.05, 0.4, k)).toFixed(3);
      });
      const base = baseRef.current, rim = rimRef.current, d0 = shown ? blob(drop) : '';
      if (base) { base.style.visibility = shown ? 'visible' : 'hidden'; if (shown) base.style.clipPath = `path("${d0}")`; }
      if (rim) { rim.setAttribute('d', d0); rim.style.opacity = (clamp(G.x + k) * (1 - sstep(0.75, 1, k))).toFixed(3); }
      if (cur >= 0 && k > 0.998 && !done) { done = true; pick.current(ROWS[cur].icao); return; }
      if (placed || on >= 0 || G.x > 0.001) raf = requestAnimationFrame(frame); else last = 0;
    };
    S.wake = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
    const re = () => S.wake(); window.addEventListener('resize', re);
    return () => { cancelAnimationFrame(raf); raf = -1; window.removeEventListener('resize', re); };
  }, []);

  const move = (e: React.PointerEvent) => { const r = rootRef.current?.getBoundingClientRect(); touch.current = e.pointerType === 'touch'; if (!r || touch.current) return; st.current.ptr = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true }; };
  let last = '';
  return (
    <div ref={rootRef} className={s.root} data-testid="airport-picker" data-view={view} onPointerMove={move} onPointerDown={move} onPointerLeave={() => { st.current.ptr.inside = false; if (!touch.current) point(-1); }}>
      <div ref={roomRef} className={s.room}>
        <header className={s.head}>
          <h1 className={s.title}>Choose an airport</h1>
          <Segmented ariaLabel="Show airports as" value={view} onChange={(v) => changeView(v as View)} items={VIEWS} testId="airport-view" />
        </header>
        {view === 'map' ? (
          <WorldBands hot={hot >= 0 ? ROWS[hot].icao : null} times={times} geom={geom}
            onPoint={(icao) => { if (!touch.current || icao == null) point(icao == null ? -1 : ROWS.findIndex((a) => a.icao === icao)); }} onFocus={(icao) => { st.current.ptr.inside = false; point(ROWS.findIndex((a) => a.icao === icao)); }} onChoose={(icao) => choose(ROWS.findIndex((a) => a.icao === icao))} isTouch={() => touch.current} />
        ) : (
          <ol className={s.names} aria-label="Airports" onPointerLeave={() => { if (!touch.current) point(-1); }}>
            {ROWS.map((a, i) => {
              const g = GROUPS.find(([, l]) => l.includes(a.icao))![0], head = g !== last; last = g;
              const n = runwaysOf(a.icao).length;
              return (
                <React.Fragment key={a.icao}>
                  {head ? <li className={s.group}><span>{g}</span></li> : null}
                  <li className={s.item}>
                    <button ref={(el) => { rows.current[i] = el; }} type="button" className={s.row} data-hot={hot === i || undefined} data-dim={(hot >= 0 && hot !== i) || undefined} data-testid={`airport-card-${a.icao}`} data-icao={a.icao}
                      onPointerEnter={(e) => { if (e.pointerType !== 'touch') point(i); }} onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) { st.current.ptr.inside = false; point(i); } }} onClick={() => choose(i)}
                      aria-label={`${a.city}, ${a.name} (${a.icao}), ${n} runways`}>
                      <b>{a.city}</b>
                      <span className={s.kind}>{a.name} · {n} runways, longest {formatFeet(longestRunwayFt(a.icao))}</span>
                      <span className={s.code}><b>{a.iata}</b><i>{times[a.icao] ? `${times[a.icao]} local` : ''}</i></span>
                    </button>
                  </li>
                </React.Fragment>
              );
            })}
          </ol>
        )}
      </div>
      <svg className={s.rim} aria-hidden="true"><path ref={rimRef} d="" /></svg>
      <div className={s.maps} aria-hidden="true">
        <div ref={baseRef} className={s.base} style={{ background: MAP_BG }} />
        {ROWS.map((a, i) => (
          <div key={a.icao} ref={(el) => { screens.current[i] = el; }} className={s.screen}>
            <canvas ref={(el) => { canvases.current[i] = el; }} />
            <p className={s.cap}>{a.name}, {a.iata}</p>
          </div>
        ))}
      </div>
      <p className={s.cue}><span className={s.cueMouse}>Point at an airport to see it, click to choose</span><span className={s.cueTouch}>Tap an airport to see it, tap again to choose</span></p>
    </div>
  );
}

/** The chosen airport's map as the screen behind the set-up; `fade` lets the night video take over. */
export function MapBackdrop({ icao, fade }: { icao: string; fade: boolean }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    let off = false; const draw = () => { const cv = ref.current; if (cv) void loadPickMap(icao).then((m) => { if (!off) drawPickMap(cv, icao, m, window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1)); }); };
    draw(); window.addEventListener('resize', draw); return () => { off = true; window.removeEventListener('resize', draw); };
  }, [icao]);
  return <canvas ref={ref} className={s.backdrop} data-fade={fade || undefined} aria-hidden="true" />;
}
