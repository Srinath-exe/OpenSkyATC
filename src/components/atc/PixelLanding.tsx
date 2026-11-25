'use client'
/*
  The loader: a pixel-art night landing on a loop (72 x 40 pixels). Stars, the approach lights' running strobe, the runway
  edge lights, and a jet that flares, touches down and rolls out. The phone's twin: mobile/lib/src/game/airport_map.dart.
*/
import * as React from 'react'

const W = 72, H = 40, RWY = 30, THR = 26
const PLANE = ['W...............', 'WW..............', 'WWWWWWWWWWWWWW..', 'WooooooooooooWW.', '.WWWWWWWWWWWWWWW', '.....gggg.......']
const STARS: [number, number][] = [[3, 4], [11, 9], [17, 2], [26, 6], [33, 12], [41, 3], [49, 8], [57, 4], [64, 11], [69, 2], [8, 15], [22, 17], [37, 19], [53, 16], [61, 20], [30, 1], [45, 14], [14, 21]]

export function PixelLanding({ scale = 5 }: { scale?: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null)
  React.useEffect(() => {
    const c = ref.current?.getContext('2d'); if (!c) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let raf = 0; const t0 = performance.now()
    const px = (x: number, y: number, col: string) => { if (x < 0 || x >= W || y < 0 || y >= H) return; c.fillStyle = col; c.fillRect(x, y, 1, 1) }
    const draw = () => {
      const t = still ? 0.5 : ((performance.now() - t0) / 4200) % 1
      c.clearRect(0, 0, W, H)
      STARS.forEach(([x, y], i) => { const tw = (Math.sin((t * 2 + i * 0.37) * Math.PI * 2) + 1) / 2; px(x, y, `rgba(255,255,255,${i % 3 === 0 ? 0.2 + 0.6 * tw : 0.35})`) })
      c.fillStyle = '#101114'; c.fillRect(0, RWY + 2, W, H)
      for (let x = THR; x < W; x++) { px(x, RWY + 1, (x - THR) % 4 === 1 ? '#5a5c62' : '#2a2b2e'); if ((x - THR) % 6 === 0) px(x, RWY, '#ffd58a') }
      px(THR, RWY, '#57cd50')
      const rabbit = Math.floor(((t * 8) % 1) * 10)
      for (let i = 0; i < 10; i++) px(THR - 22 + i * 2, RWY + 1, i === rabbit ? '#fff' : 'rgba(255,255,255,0.33)')
      let x: number, y: number
      if (t < 0.62) { const a = t / 0.62, f = a > 0.85 ? (a - 0.85) / 0.15 : 0; x = -18 + (THR + 20) * a; y = 2 + (RWY - 8) * a - 1.5 * Math.sin(f * Math.PI / 2) * (1 - f) }
      else { const a = (t - 0.62) / 0.38; x = THR + 2 + 34 * (1 - (1 - a) ** 2); y = RWY - 6 }
      const ox = Math.floor(x), oy = Math.round(y)
      PLANE.forEach((row, r) => { for (let k = 0; k < row.length; k++) if (row[k] !== '.') px(ox + k, oy + r, row[k] === 'o' ? '#f5933f' : row[k] === 'g' ? '#8a8d93' : '#ececee') })
      if ((t * 6) % 1 < 0.18) px(ox, oy - 1, '#fff')
      if ((t * 3) % 1 < 0.5) px(ox + 8, oy + 5, '#ff5a4e')
      if (t < 0.62) px(ox + 16, oy + 4, '#fff2c0')
      if (!still) raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} width={W} height={H} style={{ width: W * scale, height: H * scale, imageRendering: 'pixelated', display: 'block' }} aria-hidden="true" />
}

const NAMES: Record<string, string> = { KSFO: 'San Francisco International', KJFK: 'New York JFK', KLAX: 'Los Angeles International', KBOS: 'Boston Logan', EGLL: 'London Heathrow', LFPG: 'Paris Charles de Gaulle', OMDB: 'Dubai International', WSSS: 'Singapore Changi', VHHH: 'Hong Kong International', RJTT: 'Tokyo Haneda', YSSY: 'Sydney Kingsford Smith', VIDP: 'Delhi Indira Gandhi' }
/** Over the map until the airfield is drawn, instead of the bare daytime basemap; fades away. */
export function MapCover({ icao, open, step }: { icao: string; open: boolean; step: string }) {
  const [gone, setGone] = React.useState(!open)
  React.useEffect(() => { if (open) { setGone(false); return } const t = window.setTimeout(() => setGone(true), 650); return () => window.clearTimeout(t) }, [open])
  if (gone) return null
  return (
    <div data-testid="map-cover" style={{ position: 'absolute', inset: 0, zIndex: 4, display: 'grid', placeItems: 'center', background: '#0b0b0c', opacity: open ? 1 : 0, transition: 'opacity 0.6s ease', pointerEvents: open ? 'auto' : 'none' }}>
      <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <PixelLanding />
        <b style={{ marginTop: 18, font: '500 30px/1 var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.04em', color: '#fff' }}>{icao}</b>
        <span style={{ font: '500 14px/1.4 var(--font)', color: '#a2a2a7' }}>{NAMES[icao] ?? ''}</span>
        <span style={{ marginTop: 8, font: '500 12px/1 var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#f5933f' }}>{step}</span>
      </div>
    </div>
  )
}
