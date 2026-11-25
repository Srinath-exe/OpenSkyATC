'use client'
/*
  The taxi map: the airport drawn plainly (runways, taxiways, stands and their names) with the running session's traffic on
  it, for a second screen. Zoom, pan, turn; sizes of everything; drag a tag out of the way. On the right, every flight on
  the ground with its way spelled out, big enough to read aloud. Fed by the game's window (feed.ts).
*/
import * as React from 'react'
import { TAXI_CHANNEL, type TaxiCall, type TaxiCraft, type TaxiField, type TaxiFinal, type TaxiMsg, type TaxiNow } from './feed'
import { openReport } from '@/game/Report/Report'
import s from './TaxiMap.module.css'

interface Opts { icon: number; tag: number; dist: number; line: number; twy: number; rwy: number; stand: number; turn: number; tags: boolean; stands: boolean; buildings: boolean; air: boolean; routes: 'all' | 'sel' | 'off'; list: boolean; final: boolean }
const DEF: Opts = { icon: 1, tag: 1, dist: 1, line: 1, twy: 1, rwy: 1, stand: 1, turn: 0, tags: true, stands: true, buildings: true, air: false, routes: 'all', list: true, final: true }
const KEY = 'skycontrol_taximap_v1'
const load = (): Opts => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return DEF } }
const C = { dep: '#f7b26a', arr: '#6fd0ff', sel: '#ffffff', twy: '#39424e', lane: '#262d36', rwy: '#59636f', rwyIn: '#12161c', text: '#e8c65a', build: '#12171e', buildEdge: '#1e2630', route: '#4fe08a', hold: '#ff6b5e' }
const inAir = (a: TaxiCraft) => a.alt > 30
const ORDER = ['hold_short', 'taxi', 'pushback', 'lineup', 'rollout', 'landing', 'takeoff', 'startup', 'parked']

export function TaxiMap() {
  const canvas = React.useRef<HTMLCanvasElement>(null), box = React.useRef<HTMLDivElement>(null)
  const field = React.useRef<TaxiField | null>(null), now = React.useRef<TaxiNow | null>(null), prev = React.useRef<Map<number, { x: number; y: number; h: number; at: number }>>(new Map())
  const [opts, setOpts] = React.useState<Opts>(DEF), o = React.useRef(opts); o.current = opts
  const [panel, setPanel] = React.useState(true), [follow, setFollow] = React.useState(false), fol = React.useRef(false); fol.current = follow
  const [list, setList] = React.useState<TaxiCraft[]>([]), [finals, setFinals] = React.useState<TaxiFinal[]>([]), [call, setCall] = React.useState<TaxiCall | null>(null), [sel, setSel] = React.useState<number | null>(null), [link, setLink] = React.useState<'wait' | 'live' | 'lost'>('wait'), [meta, setMeta] = React.useState({ icao: '', time: 0, paused: false, hidden: false })
  const cam = React.useRef({ x: 0, y: 0, k: 0.1 }), off = React.useRef(new Map<string, { x: number; y: number }>()), tagRects = React.useRef<Array<{ id: number; cs: string; x: number; y: number; w: number; h: number }>>([]), fitted = React.useRef('')
  const ch = React.useRef<BroadcastChannel | null>(null)
  React.useEffect(() => { setOpts(load()); try { if (localStorage.getItem(KEY + '_panel') === '0' || window.innerWidth < 760) setPanel(false) } catch { /* storage blocked */ } }, [])
  const fold = () => setPanel((v) => { try { localStorage.setItem(KEY + '_panel', v ? '0' : '1') } catch { /* storage blocked */ } return !v })
  const set = (p: Partial<Opts>) => setOpts((v) => { const n = { ...v, ...p }; try { localStorage.setItem(KEY, JSON.stringify(n)) } catch { /* storage blocked */ } return n })
  const pick = (id: number | null) => { ch.current?.postMessage({ t: 'select', id } satisfies TaxiMsg); setSel(id); if (now.current) now.current.sel = id }

  const fit = React.useCallback(() => {
    const f = field.current, c = canvas.current; if (!f || !c) return
    const a = o.current.turn * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const put = (x: number, y: number) => { const u = x * cs + y * sn, v = -x * sn + y * cs; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v) }
    for (const r of f.runways) { put(...r.a); put(...r.b) } for (const t of f.taxi) put(t.p[0], t.p[1])
    const u = (x0 + x1) / 2, v = (y0 + y1) / 2; cam.current = { x: u * cs - v * sn, y: u * sn + v * cs, k: Math.min(c.clientWidth / (x1 - x0), c.clientHeight / (y1 - y0)) * 0.92 }
  }, [])
  React.useEffect(() => { fit() }, [opts.turn, fit])

  // the game's window
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const c = new BroadcastChannel(TAXI_CHANNEL); ch.current = c; let heard = 0, lastUi = 0
    const hello = () => { c.postMessage({ t: 'hello', want: field.current?.key ?? '' } satisfies TaxiMsg); setLink((l) => (l === 'live' && performance.now() - heard > 10000 ? 'lost' : l)) }
    c.onmessage = (ev: MessageEvent<TaxiMsg>) => {
      const m = ev.data
      if (m.t === 'field') { field.current = m; if (fitted.current !== m.icao) { fitted.current = m.icao; fit() } off.current.clear() }
      else if (m.t === 'now') {
        heard = performance.now(); const p = new Map<number, { x: number; y: number; h: number; at: number }>(); for (const a of now.current?.ac ?? []) { const q = drawn(a); p.set(a.id, { ...q, at: heard }) }
        prev.current = p; now.current = m; setLink('live'); if (field.current?.key !== m.key) hello()
        setCall((c) => ((c?.line ?? '') === (m.call?.line ?? '') ? c : m.call))
        if (heard - lastUi > 350) { lastUi = heard; setFinals(m.finals); setSel(m.sel); setMeta({ icao: field.current?.icao ?? '', time: m.time, paused: m.paused, hidden: m.hidden }); setList([...m.ac].filter((a) => o.current.air || !inAir(a)).sort((a, b) => (ORDER.indexOf(a.phase) + 99) % 99 - (ORDER.indexOf(b.phase) + 99) % 99 || a.cs.localeCompare(b.cs))) }
      } else if (m.t === 'bye') setLink('lost')
    }
    hello(); const t = window.setInterval(hello, 2000)
    return () => { window.clearInterval(t); c.close(); ch.current = null }
  }, [fit])
  // between two reports (8 a second) an aircraft glides from where it was drawn to where it is
  const drawn = (a: TaxiCraft) => { const p = prev.current.get(a.id); if (!p) return { x: a.x, y: a.y, h: a.h }; const k = Math.min(1, (performance.now() - p.at) / 130); const dh = ((a.h - p.h + 540) % 360) - 180; return { x: p.x + (a.x - p.x) * k, y: p.y + (a.y - p.y) * k, h: p.h + dh * k } }

  const toS = (x: number, y: number) => { const c = canvas.current!, a = o.current.turn * Math.PI / 180, dx = x - cam.current.x, dy = y - cam.current.y, u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a); return [c.clientWidth / 2 + u * cam.current.k, c.clientHeight / 2 - v * cam.current.k] as [number, number] }
  const toW = (sx: number, sy: number) => { const c = canvas.current!, a = o.current.turn * Math.PI / 180, u = (sx - c.clientWidth / 2) / cam.current.k, v = -(sy - c.clientHeight / 2) / cam.current.k; return [cam.current.x + u * Math.cos(a) - v * Math.sin(a), cam.current.y + u * Math.sin(a) + v * Math.cos(a)] as [number, number] }

  React.useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current, f = field.current; if (!c) return
      const dpr = Math.min(2, window.devicePixelRatio || 1), W = c.clientWidth, H = c.clientHeight
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
      const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#080a0d'; g.fillRect(0, 0, W, H); if (!f) return
      const op = o.current, N = now.current, selId = N?.sel ?? null
      if (fol.current && N) { const a = N.ac.find((x) => x.id === selId); if (a) { const q = drawn(a); cam.current.x = q.x; cam.current.y = q.y } }
      const k = cam.current.k; g.lineCap = 'round'; g.lineJoin = 'round'
      if (op.buildings) { g.fillStyle = C.build; g.strokeStyle = C.buildEdge; g.lineWidth = 1; for (const b of f.buildings) { g.beginPath(); b.forEach((p, i) => { const [x, y] = toS(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y) }); g.closePath(); g.fill(); g.stroke() } }
      for (const lane of [true, false]) {
        g.strokeStyle = lane ? C.lane : C.twy; g.lineWidth = (lane ? 1 : Math.max(1.6, Math.min(9, 14 * k))) * op.line; g.beginPath()
        for (const t of f.taxi) { if (t.lane !== lane) continue; const [x, y] = toS(t.p[0], t.p[1]), [u, v] = toS(t.p[2], t.p[3]); g.moveTo(x, y); g.lineTo(u, v) } g.stroke()
      }
      for (const r of f.runways) { const [x, y] = toS(...r.a), [u, v] = toS(...r.b), w = Math.max(5, 52 * k); g.lineCap = 'butt'; g.strokeStyle = C.rwy; g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(u, v); g.stroke(); if (w > 9) { g.strokeStyle = C.rwyIn; g.lineWidth = w - 3; g.stroke(); g.strokeStyle = '#4a545f'; g.lineWidth = 1; g.setLineDash([10, 9]); g.stroke(); g.setLineDash([]) } }
      g.lineCap = 'round'
      const boxes: Array<[number, number, number, number]> = []
      const clash = (x: number, y: number, w: number, h: number) => boxes.some((b) => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1])
      const chip = (txt: string, x: number, y: number, size: number, fill: string, ink: string, force = false) => { g.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`; const w = g.measureText(txt).width + size * 0.8, h = size * 1.45, X = x - w / 2, Y = y - h / 2; if (X > W || Y > H || X + w < 0 || Y + h < 0) return; if (!force && clash(X - 2, Y - 2, w + 4, h + 4)) return; boxes.push([X, Y, w, h]); g.fillStyle = fill; g.beginPath(); g.roundRect(X, Y, w, h, size * 0.3); g.fill(); g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, x, y + size * 0.04) }
      for (const r of f.runways) { const dx = r.b[0] - r.a[0], dy = r.b[1] - r.a[1], L = Math.hypot(dx, dy) || 1, out = 26 / k / L; chip(r.an, ...toS(r.a[0] - dx * out, r.a[1] - dy * out), 14 * op.rwy, '#e9edf2', '#0b0d10', true); chip(r.bn, ...toS(r.b[0] + dx * out, r.b[1] + dy * out), 14 * op.rwy, '#e9edf2', '#0b0d10', true) }
      // the ways to go
      const way = (pts: Array<[number, number]>, col: string, w: number, dash: number[] = []) => { if (pts.length < 2) return; g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); pts.forEach((p, i) => { const [x, y] = toS(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y) }); g.stroke(); g.setLineDash([]) }
      if (N && op.routes !== 'off') for (const pass of [0, 1]) for (const a of N.ac) {
        const is = a.id === selId; if ((pass === 1) !== is || (op.routes === 'sel' && !is) || a.path.length < 2) continue
        const w = (is ? 4 : 2.2) * op.line
        way(a.beyond, 'rgba(120,135,150,0.4)', w * 0.7, [3, 7]); way(a.path, is ? C.route : 'rgba(79,224,138,0.55)', w)
        if (a.hold && a.path.length > 1) { const [x, y] = toS(...a.path[a.path.length - 1]), [u, v] = toS(...a.path[a.path.length - 2]), an = Math.atan2(y - v, x - u); g.strokeStyle = C.hold; g.lineWidth = 3.5; g.beginPath(); g.moveTo(x - Math.sin(an) * 9, y + Math.cos(an) * 9); g.lineTo(x + Math.sin(an) * 9, y - Math.cos(an) * 9); g.stroke() }
      }
      // the call being made: what has been said so far, bright; where it would go from there, faint; a runway named, lit
      const live = N?.call ?? null, said = new Set(live?.via ?? [])
      if (live) {
        for (const r of f.runways) if (live.runways.includes(r.an) || live.runways.includes(r.bn)) way([r.a, r.b], 'rgba(255,211,74,0.55)', Math.max(6, 52 * k) * 0.5)
        way(live.rest, 'rgba(59,224,255,0.5)', 3 * op.line, [7, 7]); way(live.said, '#3be0ff', 5.5 * op.line)
      }
      // taxiway names, spread along each; the ones being said first, then the selected flight's own
      // (a name lights only where the way itself runs along that taxiway, not all over the airport)
      const mineA = N?.ac.find((a) => a.id === selId), on = new Set((mineA?.route ?? []).map((x) => x.toUpperCase()))
      const along = (pts: Array<[number, number]>, x: number, y: number) => { for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], dx = pts[i][0] - ax, dy = pts[i][1] - ay, L = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)); if ((ax + dx * u - x) ** 2 + (ay + dy * u - y) ** 2 < 196) return true } return false }
      const onWay = mineA ? [...mineA.path, ...mineA.beyond] : [], sayWay = live?.said ?? []
      const rankOf = new Map<TaxiField['taxi'][number], number>(); for (const t of f.taxi) { if (!t.n || t.lane) continue; const n = t.n.toUpperCase(), x = (t.p[0] + t.p[2]) / 2, y = (t.p[1] + t.p[3]) / 2; rankOf.set(t, said.has(n) && along(sayWay, x, y) ? 2 : on.has(n) && along(onWay, x, y) ? 1 : 0) }
      const gap = 190 / k, put = new Map<string, Array<[number, number]>>(), size = 11.5 * op.twy
      for (const rank of [2, 1, 0]) for (const t of f.taxi) {
        if (!t.n || t.lane) continue
        if (rankOf.get(t) !== rank) continue
        const mx = (t.p[0] + t.p[2]) / 2, my = (t.p[1] + t.p[3]) / 2, l = put.get(t.n) ?? []; if (l.some((q) => Math.hypot(q[0] - mx, q[1] - my) < gap)) continue
        const n = boxes.length; chip(t.n, ...toS(mx, my), rank === 2 ? size * 1.35 : size, rank === 2 ? '#3be0ff' : rank ? C.route : '#1c232c', rank === 2 ? '#04222a' : rank ? '#06210f' : C.text); if (boxes.length > n) { l.push([mx, my]); put.set(t.n, l) }
      }
      if (op.stands && k > 0.16) { g.font = `600 ${10 * op.stand}px ui-sans-serif, system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; for (const st of f.stands) { const [x, y] = toS(st.x, st.y); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue; const w = st.ref.length * 6 * op.stand, h = 11 * op.stand; if (clash(x - w / 2, y - h / 2, w, h)) continue; boxes.push([x - w / 2, y - h / 2, w, h]); g.fillStyle = '#77828e'; g.fillText(st.ref, x, y) } }
      // final: each landing runway's approach, a tick a mile, and who is on it (zoom out to see it all)
      const finalNm = new Map<number, { nm: number; sec: number }>()
      if (op.final && N) for (const fn of N.finals) {
        for (const a of fn.arr) finalNm.set(a.id, a)
        if (!fn.lands && !fn.arr.length) continue
        const h = (fn.hdg + 180) * Math.PI / 180, at = (nm: number, side = 0): [number, number] => [fn.thr[0] + Math.sin(h) * nm * 1852 + Math.cos(h) * side, fn.thr[1] + Math.cos(h) * nm * 1852 - Math.sin(h) * side]
        const first = fn.arr[0], col = first && first.nm < 3 ? '#ff6b5e' : first && first.nm < 6.5 ? '#ffb454' : 'rgba(111,208,255,0.55)'
        way([at(0.1), at(8)], col, 1.6 * op.line, [9, 8])
        for (let nm = 1; nm <= 8; nm++) { way([at(nm, -60 - 4 / k), at(nm, 60 + 4 / k)], col, nm === 3 || nm === 6 ? 2.6 : 1.3); if (nm % 2 === 0 || nm === 3) { const [x, y] = toS(...at(nm, 140 + 14 / k)); g.font = '600 11px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#8a94a0'; g.fillText(`${nm}`, x, y) } }
      }
      // traffic
      const rects: typeof tagRects.current = []
      for (const a of [...(N?.ac ?? [])].sort((p, q) => (p.id === selId ? 1 : 0) - (q.id === selId ? 1 : 0))) {
        const fin = finalNm.get(a.id)
        if (inAir(a) && !op.air && !fin) continue
        const q = drawn(a), [x, y] = toS(q.x, q.y), is = a.id === selId, col = is ? C.sel : a.kind === 'arrival' ? C.arr : C.dep
        const L = Math.max(13 * op.icon, a.len * k), r = (q.h + op.turn) * Math.PI / 180
        if (x > -60 && y > -60 && x < W + 60 && y < H + 60) {
          g.save(); g.translate(x, y); g.rotate(r); g.scale(L, L); g.fillStyle = col; g.beginPath()
          // seen from above, nose up, the nose wheel at the origin
          g.moveTo(0, -0.12); g.quadraticCurveTo(0.055, -0.08, 0.055, 0.02); g.lineTo(0.055, 0.26); g.lineTo(0.48, 0.5); g.lineTo(0.48, 0.57); g.lineTo(0.055, 0.46); g.lineTo(0.04, 0.72); g.lineTo(0.2, 0.83); g.lineTo(0.2, 0.89); g.lineTo(0, 0.86)
          g.lineTo(-0.2, 0.89); g.lineTo(-0.2, 0.83); g.lineTo(-0.04, 0.72); g.lineTo(-0.055, 0.46); g.lineTo(-0.48, 0.57); g.lineTo(-0.48, 0.5); g.lineTo(-0.055, 0.26); g.lineTo(-0.055, 0.02); g.quadraticCurveTo(-0.055, -0.08, 0, -0.12); g.fill(); g.restore()
        }
        if (!op.tags && !is) continue
        const d = off.current.get(a.cs) ?? { x: 30, y: -30 }, tx = x + d.x * op.dist, ty = y + d.y * op.dist, fs = 12 * op.tag
        g.font = `700 ${fs}px ui-monospace, monospace`; const l1 = a.cs, l2 = fin ? `${fin.nm.toFixed(1)} NM  ${Math.floor(fin.sec / 60)}:${String(Math.floor(fin.sec % 60)).padStart(2, '0')}` : `${a.type} ${a.spd}kt${a.kind === 'departure' ? (a.rwy ? ` ${a.rwy}` : '') : a.gate ? ` ${a.gate}` : ''}`
        const w = Math.max(g.measureText(l1).width, g.measureText(l2).width * 0.86) + fs * 0.9, h = fs * 2.55, X = d.x < 0 ? tx - w : tx, Y = ty - h / 2
        g.strokeStyle = is ? '#fff' : 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(tx, ty); g.stroke()
        g.fillStyle = is ? '#f2f4f7' : 'rgba(12,15,19,0.92)'; g.beginPath(); g.roundRect(X, Y, w, h, 4); g.fill(); if (!is) { g.strokeStyle = a.mine ? col : 'rgba(255,255,255,0.14)'; g.stroke() }
        g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = is ? '#0b0d10' : col; g.fillText(l1, X + fs * 0.45, Y + fs * 0.82); g.font = `500 ${fs * 0.86}px ui-monospace, monospace`; g.fillStyle = is ? '#3a424c' : '#aeb7c2'; g.fillText(l2, X + fs * 0.45, Y + fs * 1.84)
        rects.push({ id: a.id, cs: a.cs, x: X, y: Y, w, h })
      }
      tagRects.current = rects
      // north, and a scale
      const nx = 34, ny = H - 40, na = op.turn * Math.PI / 180; g.save(); g.translate(nx, ny); g.rotate(na); g.strokeStyle = '#8a94a0'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, 13); g.lineTo(0, -11); g.moveTo(-4, -5); g.lineTo(0, -12); g.lineTo(4, -5); g.stroke(); g.restore(); g.fillStyle = '#8a94a0'; g.font = '600 10px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('N', nx - 3 + Math.sin(na) * 20, ny - Math.cos(na) * 20)
      const step = [50, 100, 200, 500, 1000, 2000].find((m) => m * k > 70) ?? 2000; g.strokeStyle = '#8a94a0'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(70, ny + 8); g.lineTo(70, ny + 13); g.lineTo(70 + step * k, ny + 13); g.lineTo(70 + step * k, ny + 8); g.stroke(); g.fillText(step >= 1000 ? `${step / 1000} km` : `${step} m`, 72, ny + 2)
    }
    raf = requestAnimationFrame(draw); return () => cancelAnimationFrame(raf)
  }, [])

  // hands: wheel zooms at the pointer, drag pans, a tag drags, a click picks
  React.useEffect(() => {
    const c = canvas.current!; const pts = new Map<number, { x: number; y: number }>(); let drag: null | { tag?: string; moved: number; pinch?: number } = null
    const at = (ev: PointerEvent | WheelEvent) => { const r = c.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top } }
    const zoom = (f: number, x: number, y: number) => { const [wx, wy] = toW(x, y); cam.current.k = Math.max(0.03, Math.min(6, cam.current.k * f)); const [nx, ny] = toW(x, y); cam.current.x += wx - nx; cam.current.y += wy - ny }
    const wheel = (ev: WheelEvent) => { ev.preventDefault(); const p = at(ev); zoom(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.04 : 0.0014)), p.x, p.y) }
    const down = (ev: PointerEvent) => { c.setPointerCapture(ev.pointerId); const p = at(ev); pts.set(ev.pointerId, p); const t = [...tagRects.current].reverse().find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h); drag = { tag: pts.size === 1 ? t?.cs : undefined, moved: 0 } }
    const move = (ev: PointerEvent) => {
      const old = pts.get(ev.pointerId), p = at(ev); if (!old || !drag) { const t = tagRects.current.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h); c.style.cursor = t ? 'move' : 'grab'; return }
      pts.set(ev.pointerId, p); const dx = p.x - old.x, dy = p.y - old.y; drag.moved += Math.abs(dx) + Math.abs(dy)
      if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y); if (drag.pinch) zoom(d / drag.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2); drag.pinch = d; return }
      if (drag.tag) { const q = off.current.get(drag.tag) ?? { x: 30, y: -30 }; off.current.set(drag.tag, { x: q.x + dx / o.current.dist, y: q.y + dy / o.current.dist }) }
      else { const [x0, y0] = toW(old.x, old.y), [x1, y1] = toW(p.x, p.y); cam.current.x += x0 - x1; cam.current.y += y0 - y1; if (drag.moved > 6) setFollow(false) }
    }
    const up = (ev: PointerEvent) => {
      const p = at(ev); pts.delete(ev.pointerId); if (!drag || drag.moved > 5) { if (!pts.size) drag = null; return }
      const t = [...tagRects.current].reverse().find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
      let id: number | null = t?.id ?? null; if (id == null) { let bd = 22; for (const a of now.current?.ac ?? []) { if (inAir(a) && !o.current.air) continue; const [x, y] = toS(a.x, a.y), d = Math.hypot(x - p.x, y - p.y); if (d < bd) { bd = d; id = a.id } } }
      pick(id); drag = null
    }
    const key = (ev: KeyboardEvent) => { if ((ev.target as HTMLElement)?.closest?.('input')) return; const m = { x: c.clientWidth / 2, y: c.clientHeight / 2 }; if (ev.key === '+' || ev.key === '=') zoom(1.25, m.x, m.y); else if (ev.key === '-') zoom(0.8, m.x, m.y); else if (ev.key === '0') fit(); else if (ev.key === 'f') setFollow((v) => !v); else if (ev.key === 'Escape') pick(null) }
    c.addEventListener('wheel', wheel, { passive: false }); c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); window.addEventListener('keydown', key)
    ;(c as unknown as { __zoom?: (f: number) => void }).__zoom = (f) => zoom(f, c.clientWidth / 2, c.clientHeight / 2)
    return () => { c.removeEventListener('wheel', wheel); c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); window.removeEventListener('keydown', key) }
  }, [fit])
  const zoomBtn = (f: number) => (canvas.current as unknown as { __zoom?: (f: number) => void })?.__zoom?.(f)
  const go = (a: TaxiCraft) => { pick(a.id); cam.current.x = a.x; cam.current.y = a.y; if (cam.current.k < 0.35) cam.current.k = 0.35 }
  const hhmm = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t) % 60).padStart(2, '0')}`
  const slide = (label: string, k: keyof Opts, min: number, max: number, step: number, unit = '×') => <label className={s.slide}><span>{label}<b>{unit === '×' ? `${(opts[k] as number).toFixed(2)}×` : `${opts[k]}${unit}`}</b></span><input type="range" min={min} max={max} step={step} value={opts[k] as number} onChange={(ev) => set({ [k]: Number(ev.target.value) } as Partial<Opts>)} style={{ ['--p' as string]: `${((opts[k] as number) - min) / (max - min) * 100}%` }} /></label>
  const tog = (label: string, k: 'tags' | 'stands' | 'buildings' | 'air') => <button type="button" className={s.tog} data-on={opts[k] || undefined} aria-pressed={opts[k]} onClick={() => set({ [k]: !opts[k] } as Partial<Opts>)}>{label}</button>

  return (
    <div className={s.root} data-testid="taxi-map" data-link={link}>
      <header className={s.top}>
        <b className={s.name}>{meta.icao || 'Taxi map'}</b><span className={s.clock}>{link === 'live' ? hhmm(meta.time) : '--:--:--'}</span>
        <span className={s.state} data-s={link === 'live' ? (meta.hidden ? 'warn' : meta.paused ? 'pause' : 'live') : 'wait'}>{link === 'live' ? (meta.hidden ? 'Game window is hidden' : meta.paused ? 'Paused' : 'Live') : link === 'lost' ? 'Session ended' : 'Waiting for the game'}</span>
        <span className={s.grow} />
        <div className={s.seg} role="group" aria-label="Routes">{(['all', 'sel', 'off'] as const).map((r) => <button key={r} type="button" data-on={opts.routes === r || undefined} onClick={() => set({ routes: r })}>{r === 'all' ? 'All routes' : r === 'sel' ? 'Selected' : 'No routes'}</button>)}</div>
        <button type="button" className={s.btn} data-on={opts.final || undefined} onClick={() => set({ final: !opts.final })}>Final</button>
        <button type="button" className={s.btn} data-on={follow || undefined} disabled={sel == null} onClick={() => setFollow((v) => !v)}>Follow</button>
        <button type="button" className={s.btn} data-on={opts.list || undefined} onClick={() => set({ list: !opts.list })}>Flights</button>
        <button type="button" className={s.btn} onClick={openReport} data-report-anchor="" title="Report something on this screen">Report</button>
      </header>
      <div className={s.body}>
        <div ref={box} className={s.map}>
          <canvas ref={canvas} className={s.canvas} />
          <div className={s.zoom}><button type="button" aria-label="Zoom in" onClick={() => zoomBtn(1.35)}>+</button><button type="button" aria-label="Zoom out" onClick={() => zoomBtn(0.74)}>−</button><button type="button" aria-label="Whole airport" onClick={fit}>⤢</button></div>
          {call ? <div className={s.call} data-testid="taxi-call"><small>You are saying</small>{call.line}</div> : null}
          <section className={s.panel} data-open={panel || undefined} aria-label="Display settings">
            <button type="button" className={s.fold} aria-expanded={panel} onClick={fold} data-testid="taxi-display"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M2 4.5h6M12 4.5h2M2 11.5h2M8 11.5h6" /><circle cx="10" cy="4.5" r="1.8" /><circle cx="6" cy="11.5" r="1.8" /></svg><b>Display</b><svg className={s.chev} viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg></button>
            {panel ? <div className={s.sheet}>
            {slide('Turn the map', 'turn', 0, 359, 1, '°')}{slide('Aircraft', 'icon', 0.5, 3, 0.05)}{slide('Flight tags', 'tag', 0.7, 2.2, 0.05)}{slide('Tag distance', 'dist', 0.4, 3, 0.05)}{slide('Taxiway names', 'twy', 0.6, 2.4, 0.05)}{slide('Runway names', 'rwy', 0.6, 2.4, 0.05)}{slide('Stand names', 'stand', 0.6, 2.4, 0.05)}{slide('Line thickness', 'line', 0.5, 3, 0.05)}
            <div className={s.togs}>{tog('Tags', 'tags')}{tog('Stands', 'stands')}{tog('Buildings', 'buildings')}{tog('Airborne', 'air')}<button type="button" className={s.tog} onClick={() => { off.current.clear(); set(DEF); fit() }}>Reset</button></div>
            <p className={s.tip}>Scroll to zoom, drag to move. Drag a tag to put it out of the way. + − 0 zoom, F follow.</p>
            </div> : null}
          </section>
          {link !== 'live' ? <div className={s.cover}><b>{link === 'lost' ? 'The game window has closed or left the session' : 'Waiting for a running session'}</b><p>Start a shift in this browser. This map picks it up by itself.</p></div> : meta.hidden ? <div className={s.hint}>The game&apos;s tab is in the background, so it has stopped. Keep both windows in view.</div> : null}
        </div>
        {opts.list || opts.final ? <aside className={s.list} aria-label="Finals and flights">
          {opts.final ? <section className={s.finals} aria-label="Short final" data-testid="taxi-finals">
            {finals.length ? finals.map((f) => (
              <div key={f.rwy} className={s.fin} data-tone={f.tone}>
                <p className={s.finTop}><b>{f.rwy}</b><span>{f.verdict}</span></p>
                {f.lands || f.arr.length ? <div className={s.strip} role="img" aria-label={f.arr.length ? f.arr.map((a) => `${a.cs} ${a.nm.toFixed(1)} miles`).join(', ') : 'Nobody on final'}>
                  <i className={s.z3} /><i className={s.z6} />{[2, 4, 6, 8, 10].map((n) => <em key={n} style={{ left: `${n * 10}%` }}>{n}</em>)}
                  {f.arr.filter((a) => a.nm <= 10).map((a) => <button key={a.id} type="button" className={s.plane} data-sel={a.id === sel || undefined} style={{ left: `${a.nm * 10}%` }} onClick={() => pick(a.id)} title={`${a.cs} ${a.type}`}>◀</button>)}
                </div> : null}
                {f.arr.map((a) => <button key={a.id} type="button" className={s.finRow} data-sel={a.id === sel || undefined} onClick={() => pick(a.id)}><b>{a.cs}</b><em>{a.type}</em><span>{a.nm.toFixed(1)} NM</span><strong>{Math.floor(a.sec / 60)}:{String(Math.floor(a.sec % 60)).padStart(2, '0')}</strong><small data-ok={a.cleared || undefined}>{a.cleared ? 'cleared to land' : 'not cleared'}</small></button>)}
                {f.cross ? <p className={s.finX}>{f.cross}</p> : null}
                {f.dep.map((d) => <button key={d.id} type="button" className={s.finDep} data-sel={d.id === sel || undefined} onClick={() => pick(d.id)}><span><b>{d.cs}</b> {d.phase.toLowerCase()}</span><em data-go={d.say ? true : undefined}>{d.say || d.note}</em></button>)}
              </div>)) : <p className={s.none}>No runway in use.</p>}
          </section> : null}
          {opts.list ? <>
          {list.length ? list.map((a) => (
            <button key={a.id} type="button" className={s.row} data-sel={a.id === sel || undefined} data-kind={a.kind} onClick={() => go(a)}>
              <span className={s.rowTop}><b>{a.cs}</b><em>{a.type}</em><i>{a.kind === 'departure' ? (a.rwy ? `to ${a.rwy}` : 'no runway yet') : `to ${a.gate || 'stand'}`}</i></span>
              <span className={s.rowSt}>{a.status}{a.moving ? ` · ${a.spd} kt` : ''}{a.mine ? '' : ' · AI'}</span>
              {a.route.length ? <span className={s.way} >{a.route.map((r, i) => <React.Fragment key={i}>{i ? <u>›</u> : null}<b>{r}</b></React.Fragment>)}{a.hold ? <strong>hold short {a.hold}</strong> : null}</span> : null}
              {a.id === sel && a.say ? <span className={s.say}><small>Say next</small>{a.say}</span> : a.id === sel && a.note ? <span className={s.note}>{a.note}</span> : null}
            </button>)) : <p className={s.none}>Nobody is moving on the ground.</p>}
          </> : null}
        </aside> : null}
      </div>
    </div>
  )
}
