'use client'
/*
  The course on the map (course.ts), drawn in the world: one bubble that sits on the thing being taught (a runway, a
  hold line, the aircraft you are talking to), joined to it by a line, its lines appearing one by one. The camera flies
  to each thing first. Missions: the call to make is a button in the bubble on the aircraft; the course moves on by
  itself when the aircraft has done it. A thin bar at the top shows the five parts and the way out.
*/
import * as React from 'react'
import Link from 'next/link'
import c from './Course.module.css'
import { useShell } from '@/game/shellContext'
import { sim } from '@/components/atc/simStore'
import { sound as radio } from '@/components/atc/sound'
import { mapListening, sendCue } from '@/components/atc/WorldMap/tutor'
import { coach, useCoach } from './runner'
import { sound } from './audio'
import { CHAPTERS, COURSE_CS, tourScene, type Cue } from './lessons'
import { STEPS, SECTIONS, firstOf, routeNames, type Step, type Visual } from './course'
import type { XY } from '@/lib/sim/projection'
import { spokenLine } from '@/lib/sim/dispatch'
import { keyFor, keyLabel } from '../keybindings'

const KEY = 'skycontrol_course_v1'
const readStep = () => { try { const n = Number(localStorage.getItem(KEY)); return Number.isFinite(n) && n > 0 && n < STEPS.length ? n : 0 } catch { return 0 } }
const OK = ['ok-1', 'ok-2', 'ok-3', 'ok-4']
const BEAT_MS = 900

/** Send cues once the map is listening (a freshly mounted map needs a moment before the camera can fly smoothly). */
function sendWhenReady(list: Cue[], alive: () => boolean, tries = 60) {
  if (!alive()) return
  if (!mapListening()) { if (tries > 0) window.setTimeout(() => sendWhenReady(list, alive, tries - 1), 250); return }
  if (tries === 60) { window.setTimeout(() => sendWhenReady(list, alive, 59), 350); return }
  for (const q of list) sendCue(q)
}

// ---------------------------------------------------------------------------------------------------------------------
// the narrator never talks over the radio: each line waits for the pilots to be quiet, and stops if one starts
// ---------------------------------------------------------------------------------------------------------------------
const narr = { gen: 0, playing: null as null | { stop(): void } }
const quietFor = (ms: number, alive: () => boolean) => new Promise<boolean>((res) => {
  let since = 0
  const t = window.setInterval(() => {
    if (!alive()) { window.clearInterval(t); res(false); return }
    if (radio.radioBusy) since = 0; else if ((since += 120) >= ms) { window.clearInterval(t); res(true) }
  }, 120)
})
function narrate(ids: string[]): void {
  const my = ++narr.gen, alive = () => narr.gen === my
  narr.playing?.stop(); narr.playing = null
  void (async () => {
    for (const id of ids) {
      if (!sound.line(id)) continue
      if (!(await quietFor(700, alive))) return
      const p = await sound.say(id); if (!p || !alive()) { p?.stop(); return }
      narr.playing = p
      // the radio comes first: a pilot starting to talk cuts the narrator
      const end = performance.now() + (p.dur + 0.2) * 1000
      while (performance.now() < end) {
        await new Promise((r) => window.setTimeout(r, 120))
        if (!alive()) return
        if (radio.radioBusy) { p.stop(); narr.playing = null; return }
      }
      narr.playing = null
    }
  })()
}
function hush(): void { narr.gen++; narr.playing?.stop(); narr.playing = null }

type Anchor = { kind: 'xy'; xy: XY } | { kind: 'cs'; side?: 'left' | 'right' } | { kind: 'cmd' } | { kind: 'none' }

export function CourseOverlay({ ready }: { ready: boolean }) {
  const [i, setI] = React.useState(0)
  React.useEffect(() => { setI(readStep()) }, [])
  const step = STEPS[i]
  const go = React.useCallback((n: number) => { const k = Math.max(0, Math.min(STEPS.length - 1, n)); setI(k); try { localStorage.setItem(KEY, String(k)) } catch { /* */ } }, [])
  const st = useCoach((x) => x)
  const shell = useShell()
  const anchor = React.useRef<Anchor>({ kind: 'none' })

  // the coach on its first use: its command runner and the sim's event feed
  React.useEffect(() => { if (!ready) return; coach.init(); return () => { coach.dispose(); hush() } }, [ready])

  // the step's scene: a mission is the coach's; a tour step shows the airport with the 747 on its stand
  const gen = React.useRef(0)
  React.useEffect(() => {
    if (!ready || !sim.engine) return
    const my = ++gen.current, alive = () => gen.current === my
    sound.unlock(); hush()
    if (step.mission) { anchor.current = { kind: 'cs', side: CHAPTERS.find(ch => ch.id === step.mission)?.card }; coach.open(step.mission, { story: false, fresh: step.fresh }); return }
    if (coach.state.chapter) coach.stop()
    const e = sim.engine
    if (sim.position !== 'ground' && sim.position !== 'tower') sim.setPosition('ground')
    sim.autoSpawn = false
    const a = e.find(COURSE_CS)
    if (step.sec === 'airport' || step.sec === 'radio') { if (!a || a.phase !== 'parked') { tourScene(e); sim.select(null); sim.emit() } }
    sendCue({ kind: 'clear' })
    let cues: Cue[] = []; try { cues = step.cues?.(e) ?? [] } catch { cues = [] }
    let xy: XY | null = null; try { xy = step.anchor?.(e) ?? null } catch { xy = null }
    const cam = cues.find((q): q is Extract<Cue, { kind: 'camera' }> => q.kind === 'camera')
    if (step.point === 'cmd') anchor.current = { kind: 'cmd' }
    else if (xy) anchor.current = { kind: 'xy', xy }
    else if (cam) anchor.current = { kind: 'xy', xy: cam.at }
    else anchor.current = { kind: 'none' }
    sendWhenReady(cues, alive)
  }, [ready, i])   // eslint-disable-line react-hooks/exhaustive-deps

  // a mission step whose mission is not running (the coach was reset under it: a hot reload, a missed open) opens it
  // again instead of sitting on "Getting the aircraft ready" for ever
  React.useEffect(() => {
    if (!ready || !step.mission) return
    let misses = 0
    const t = window.setInterval(() => {
      if (coach.state.chapter?.id === step.mission || !sim.engine) { misses = 0; return }
      if (++misses < 2) return
      misses = 0; coach.init(); coach.open(step.mission!, { story: false })
    }, 1500)
    return () => window.clearInterval(t)
  }, [ready, i])   // eslint-disable-line react-hooks/exhaustive-deps

  // the game stays minimal: strip bay folded, comm log down to its last line (restored on the way out)
  const was = React.useRef<{ bay: boolean; log: boolean } | null>(null)
  React.useEffect(() => {
    if (!ready) return
    if (!was.current) was.current = { bay: shell.bayCollapsed, log: shell.logCollapsed }
    if (!shell.bayCollapsed) shell.toggleBay()
    if (!shell.logCollapsed) shell.setLogCollapsed(true)
  }, [ready, i, shell])   // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => () => { const w = was.current; if (!w) return; if (!w.bay) shell.toggleBay(); if (!w.log) shell.setLogCollapsed(false) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // point at the command box
  React.useEffect(() => {
    const el = step.point === 'cmd' ? document.querySelector('[data-testid="cmd-form"]') : null
    el?.classList.add(c.pointed); return () => el?.classList.remove(c.pointed)
  }, [step.point, i])

  // a tour step's lines appear one by one
  const [shown, setShown] = React.useState(1)
  React.useEffect(() => {
    setShown(1)
    if (step.mission) return
    const ts = step.body.slice(1).map((_, k) => window.setTimeout(() => setShown(k + 2), 400 + BEAT_MS * (k + 1)))
    return () => ts.forEach((t) => window.clearTimeout(t))
  }, [i, step])
  const allShown = shown >= step.body.length

  // a finished mission moves the course on
  const live = !!step.mission && st.chapter?.id === step.mission
  const done = live && st.stage === 'done'
  React.useEffect(() => { if (!done) return; const t = window.setTimeout(() => go(i + 1), 2000); return () => window.clearTimeout(t) }, [done, i, go])

  const send = React.useCallback((phrase: string) => { sound.unlock(); radio.unlock(); hush(); void sound.sfx('tick', 0, 0.5); sim.command(phrase) }, [])
  const next = React.useCallback(() => { if (!step.mission && !allShown) setShown(step.body.length); else go(i + 1) }, [step, allShown, go, i])

  // keys: Enter / → next (on a mission, Enter sends the call shown), ← back; not while typing a call
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (ev.key === 'Enter' || ev.key === 'ArrowRight') {
        if (!step.mission || done) { ev.preventDefault(); next(); return }
        if (ev.key === 'Enter') { const ph = live && st.stage === 'live' ? coach.phrase(coach.current()) : null; if (ph) { ev.preventDefault(); send(ph) } }
      } else if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(i - 1) }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [i, step.mission, done, go, next, send, live, st.stage])

  const secIdx = SECTIONS.findIndex((x) => x.id === step.sec)
  const inSec = STEPS.filter((x) => x.sec === step.sec), nInSec = inSec.indexOf(step) + 1
  const last = i === STEPS.length - 1
  return (
    <>
      <nav className={c.bar} aria-label="Tutorial parts" data-testid="course-bar">
        {SECTIONS.map((x, k) => {
          const all = STEPS.filter((y) => y.sec === x.id)
          const frac = k < secIdx ? 1 : k > secIdx ? 0 : (nInSec - (done ? 0 : 1)) / all.length
          return (
            <button key={x.id} className={c.part} data-on={k === secIdx} onClick={() => go(firstOf(x.id))} data-testid={`course-part-${x.id}`}>
              <span className={c.partName}>{x.title}</span>
              <span className={c.partBar}><i style={{ transform: `scaleX(${frac})` }} /></span>
            </button>
          )
        })}
        <Link className={c.exit} href="/play?icao=KSFO" data-testid="course-exit">Skip tutorial ✕</Link>
      </nav>
      <Bubble anchor={anchor}>
        <section className={c.card} data-testid="course-card" data-step={step.id}>
          <div className={c.body} key={step.id}>
            <p className={c.kicker}>{SECTIONS[secIdx].title} · {nInSec}/{inSec.length}</p>
            <h2 className={c.title}>{step.title}</h2>
            {step.mission ? <p className={c.brief}>{step.body[0]}</p> : step.body.slice(0, shown).map((p, k) => <p key={k} className={c.beat}>{p}</p>)}
            {step.visual && allShown ? <div className={c.beat}><Aid v={step.visual} /></div> : null}
            {step.mission ? <Mission step={step} send={send} /> : null}
          </div>
          <footer className={c.foot}>
            <button className={c.back} onClick={() => go(i - 1)} disabled={i === 0} data-testid="course-back" aria-label="Back"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>Back</button>
            {last ? null : step.mission && !done ? (
              <button className={c.skip} onClick={() => go(i + 1)} data-testid="course-skip">Skip</button>
            ) : (
              <button className={c.next} onClick={next} data-testid="course-next" autoFocus>{allShown ? 'Next' : 'More'} <kbd>↵</kbd></button>
            )}
          </footer>
        </section>
      </Bubble>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// the bubble: placed every frame next to its anchor on the screen, a line from it to the anchor
// ---------------------------------------------------------------------------------------------------------------------
function anchorPoint(A: Anchor): { x: number; y: number } | null {
  if (A.kind === 'cmd') { const r = document.querySelector('[data-testid="cmd-form"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top - 30 } : null }
  if (A.kind === 'none') return null
  let xy: XY | null = A.kind === 'xy' ? A.xy : null, alt = 0
  if (A.kind === 'cs') {
    // the aircraft the call is to (the phrase starts with its callsign), else the chapter's aircraft
    const e = sim.engine; if (!e) return null
    const ph = coach.phrase(coach.current())
    const a = (ph ? e.find(ph.split(' ')[0]) : null) ?? e.find(coach.target() ?? '')
    if (a && a.phase !== 'departed') { xy = a.pos; alt = a.altitude }
  }
  const q = xy ? sim.screenProject(xy, alt) : null
  if (!q || !Number.isFinite(q.x)) return null
  const view = document.querySelector('[data-region="map"]')?.getBoundingClientRect()
  return { x: (view?.left ?? 0) + q.x, y: (view?.top ?? 0) + q.y }
}

function Bubble({ anchor, children }: { anchor: React.MutableRefObject<Anchor>; children: React.ReactNode }) {
  const box = React.useRef<HTMLDivElement>(null)
  const hover = React.useRef(false)
  const stem = React.useRef<SVGLineElement>(null), dot = React.useRef<SVGCircleElement>(null), halo = React.useRef<SVGCircleElement>(null)
  React.useEffect(() => {
    type Side = 'above' | 'below' | 'right' | 'left'
    let raf = 0, cur: { x: number; y: number } | null = null, goal: { x: number; y: number } | null = null, side: Side | null = null, lastA: Anchor | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = box.current; if (!el) return
      const W = window.innerWidth, H = window.innerHeight, A = anchor.current
      const p = anchorPoint(A)
      const onScreen = !!p && p.x > 8 && p.y > 8 && p.x < W - 8 && p.y < H - 8
      const w = el.offsetWidth, h = el.offsetHeight, M = 12, top = 52
      const gap = A.kind === 'cmd' ? 8 : A.kind === 'cs' ? 120 : 90, bottom = A.kind === 'cmd' ? H : H - 110
      let tx: number, ty: number
      if (p && onScreen) {
        // beside the aircraft (it stays visible in the middle), above / below a place; keep the side while it fits
        // off to one side on a diagonal, not centred on the thing: the line and dot do the pointing, the focus stays clear
        const dx = A.kind === 'cmd' ? -w / 2 : p.x + 70 + w <= W - M ? 70 : -70 - w
        const at = (s: Side) => s === 'above' ? { x: p.x + dx, y: p.y - gap - h } : s === 'below' ? { x: p.x + dx, y: p.y + gap } : s === 'right' ? { x: p.x + gap, y: p.y - h - 40 } : { x: p.x - gap - w, y: p.y - h - 40 }
        const fits = (s: Side) => { const q = at(s); return s === 'above' || s === 'below' ? q.y >= top && q.y + h <= bottom : q.x >= M && q.x + w <= W - M }
        const order: Side[] = A.kind === 'cs' ? (A.side === 'left' ? ['left', 'right', 'above', 'below'] : ['right', 'left', 'above', 'below']) : A.kind === 'cmd' ? ['above'] : ['above', 'below', 'right', 'left']
        if (!side || !order.includes(side) || !fits(side)) side = order.find(fits) ?? order[0]
        ;({ x: tx, y: ty } = at(side))
      } else { side = null; tx = W / 2 - w / 2; ty = H * 0.42 - h / 2 }
      tx = Math.max(M, Math.min(W - w - M, tx)); ty = Math.max(top, Math.min(bottom - h, ty))
      // the bubble holds still while its aircraft moves nearby (only the line follows), so its buttons stay easy to hit;
      // it moves when the aircraft gets far from it or under it, and never while the pointer is on it
      const covers = !!p && p.x > (goal?.x ?? 0) - 10 && p.x < (goal?.x ?? 0) + w + 10 && p.y > (goal?.y ?? 0) - 10 && p.y < (goal?.y ?? 0) + h + 10
      if (!goal || (!hover.current && (Math.hypot(tx - goal.x, ty - goal.y) > 160 || covers || A !== lastA))) goal = { x: tx, y: ty }
      lastA = A
      cur = cur ? { x: cur.x + (goal.x - cur.x) * 0.2, y: cur.y + (goal.y - cur.y) * 0.2 } : { ...goal }
      el.style.transform = `translate3d(${cur.x.toFixed(1)}px, ${cur.y.toFixed(1)}px, 0)`
      const s = stem.current, d = dot.current, o = halo.current
      if (!s || !d || !o) return
      const inside = !!p && p.x > cur.x - 6 && p.x < cur.x + w + 6 && p.y > cur.y - 6 && p.y < cur.y + h + 6
      const show = !!p && onScreen && A.kind !== 'cmd' && !inside
      for (const n of [s, d, o]) n.style.visibility = show ? 'visible' : 'hidden'
      if (!show || !p) return
      // the line leaves the bubble's nearest edge
      const sx = p.x < cur.x ? cur.x : p.x > cur.x + w ? cur.x + w : Math.max(cur.x + 28, Math.min(cur.x + w - 28, p.x))
      const sy = p.y < cur.y ? cur.y : p.y > cur.y + h ? cur.y + h : Math.max(cur.y + 24, Math.min(cur.y + h - 24, p.y))
      s.setAttribute('x1', sx.toFixed(1)); s.setAttribute('y1', sy.toFixed(1)); s.setAttribute('x2', p.x.toFixed(1)); s.setAttribute('y2', p.y.toFixed(1))
      for (const n of [d, o]) { n.setAttribute('cx', p.x.toFixed(1)); n.setAttribute('cy', p.y.toFixed(1)) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [anchor])
  return (
    <>
      <svg className={c.stemLayer} aria-hidden>
        <line ref={stem} className={c.stem} />
        <circle ref={halo} className={c.halo} r="18" />
        <circle ref={dot} className={c.dot} r="5" />
      </svg>
      <div ref={box} className={c.bubble} onPointerEnter={() => { hover.current = true }} onPointerLeave={() => { hover.current = false }}>{children}</div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// a live mission: the coach's current objective, the call as a button
// ---------------------------------------------------------------------------------------------------------------------
function Mission({ step, send }: { step: Step; send: (phrase: string) => void }) {
  const st = useCoach((x) => x)
  const shell = useShell()
  const ch = st.chapter
  const live = ch?.id === step.mission && (st.stage === 'live' || st.stage === 'done')
  const cur = live ? coach.current() : null
  const metN = st.met.size
  // the narrator: a word when something is done, then the next objective (recorded lines, where there are any)
  const said = React.useRef<{ goal: string | null; met: number }>({ goal: null, met: 0 })
  React.useEffect(() => {
    if (!ch || st.stage !== 'live') { said.current = { goal: null, met: 0 }; return }
    const prev = said.current; said.current = { goal: cur?.id ?? null, met: metN }
    const ids: string[] = []
    if (metN > prev.met) { void sound.sfx('chime', 0, 0.6); ids.push(OK[Math.floor(Math.random() * OK.length)]) }
    if (cur && cur.id !== prev.goal) ids.push(`g-${ch.id}-${cur.id}`)
    if (ids.length) narrate(ids)
  }, [cur?.id, metN, st.stage, ch]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!live || !ch) return <div className={c.mission}><p className={c.watch}>Getting the aircraft ready…</p></div>
  const required = ch.goals.filter((g) => !g.optional)
  const phrase = coach.phrase(cur)
  const talk = keyLabel(keyFor('ptt'))
  // the call as it is said on the radio ("Lufthansa four five five, pushback approved"): what to read out
  const spoken = phrase && sim.engine ? spokenLine(sim.engine as never, phrase) : null
  const note = [...st.notes].reverse().find((n) => n.tone !== 'done')
  return (
    <div className={c.mission} data-testid="course-mission">
      <div className={c.goals} aria-hidden>{required.map((g) => <i key={g.id} data-met={st.met.has(g.id)} data-now={cur?.id === g.id} />)}{coach.fast ? <span className={c.fast}>⏩ Fast-forward</span> : null}</div>
      {st.stage === 'done' ? (
        <p className={c.goalTitle}>✓ Done</p>
      ) : cur ? (
        <div className={c.goal} key={cur.id}>
          <p className={c.goalTitle}>{cur.title}</p>
          <p className={c.why}>{cur.why}</p>
          {phrase ? (
            <>
              <button className={c.call} onClick={() => send(phrase)} data-testid="course-send">
                <span className={c.callWords}><span className={c.callSay}>{spoken ?? phrase}</span>{spoken ? <span className={c.callText}>{phrase}</span> : null}</span><span className={c.callGo}>Send <kbd>↵</kbd></span>
              </button>
              <p className={c.hint}>or <button className={c.link} onClick={() => { sound.unlock(); shell.focusCmd(phrase) }} data-testid="course-use">type it</button>, or hold <kbd>{talk}</kbd> and say it</p>
            </>
          ) : <p className={c.watch}>Watch the aircraft…</p>}
        </div>
      ) : <p className={c.watch}>Watch the aircraft…</p>}
      {note ? <div className={c.note} data-tone={note.tone} onClick={() => coach.dismissNote(note.id)}>{note.text}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// the small diagrams on reading steps
// ---------------------------------------------------------------------------------------------------------------------
const NATO: Record<string, string> = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu' }
const DIG = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner']
const sayName = (n: string) => n.split('').map((ch) => NATO[ch] ?? DIG[Number(ch)] ?? ch).map((w, k) => (k ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')

function Aid({ v }: { v: Visual }) {
  const e = sim.engine
  if (v === 'compass') return (
    <svg className={c.compass} viewBox="0 0 240 100" aria-hidden>
      <circle cx="50" cy="50" r="40" className={c.ring} />
      {['N', 'E', 'S', 'W'].map((d, k) => <text key={d} x={50 + Math.sin(k * Math.PI / 2) * 31} y={54 - Math.cos(k * Math.PI / 2) * 31} className={c.dir}>{d}</text>)}
      <line x1="50" y1="50" x2={50 + Math.sin(280 * Math.PI / 180) * 38} y2={50 - Math.cos(280 * Math.PI / 180) * 38} className={c.arrow} />
      <text x="108" y="56" className={c.big}>280° → 28</text>
    </svg>
  )
  if (v === 'journey') return (
    <ol className={c.journey}>{['Gate', 'Taxi', 'Takeoff', 'Radar', 'Landing'].map((x, k) => <li key={x} data-k={k < 3 ? 'dep' : 'arr'}>{x}</li>)}</ol>
  )
  if (v === 'plan') return (
    <div className={c.chips}><span className={c.chip} data-tone="go"><b>Take off</b> 01L · 01R</span><span className={c.chip} data-tone="arr"><b>Land</b> 28L · 28R</span></div>
  )
  if (v === 'taxiways') {
    const names = e ? routeNames(e) : []
    return <div className={c.chips}>{(names.length ? names : ['A', 'M', 'M1']).map((n) => <span key={n} className={c.chip}><b>{n}</b> {sayName(n)}</span>)}</div>
  }
  if (v === 'words') return (
    <table className={c.table}><tbody>
      {[['Pushback approved', 'Back out of the gate'], ['Taxi to runway…', 'Drive there, by this route'], ['Hold position', 'Stop now'], ['Cross runway…', 'Drive across it'], ['Contact tower', 'Talk to the next controller'], ['Cleared for takeoff', 'Go'], ['Cleared to land', 'Land']].map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}
    </tbody></table>
  )
  if (v === 'numbers') return (
    <table className={c.table}><tbody>
      {[['M1', 'Mike One'], ['01R', 'zero one right'], ['9', 'niner'], ['5000 ft', 'five thousand']].map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}
    </tbody></table>
  )
  if (v === 'anatomy') {
    const via = (e ? routeNames(e) : []).slice(0, 3)
    return (
      <div className={c.anatomy}>
        <div className={c.parts3}><span data-k="who"><small>Who</small>DLH455</span><span data-k="what"><small>What</small>taxi to runway 01R</span><span data-k="where"><small>Where</small>via {via.length ? via.join(' ') : 'A M'}</span></div>
        <p className={c.readback}><small>Pilot</small>“Taxi runway zero one right via {via.map(sayName).join(', ') || 'Alpha, Mike'}, Lufthansa four five five.”</p>
      </div>
    )
  }
  if (v === 'finish') return (
    <div className={c.finish}>
      <Link className={c.next} href="/play?icao=KSFO" data-testid="course-play">Start a shift at SFO</Link>
      <button className={c.skip} onClick={() => coach.freePlay()}>Free play here</button>
      <button className={c.skip} onClick={() => { try { localStorage.removeItem(KEY) } catch { /* */ } window.location.reload() }}>Start over</button>
    </div>
  )
  return null
}
