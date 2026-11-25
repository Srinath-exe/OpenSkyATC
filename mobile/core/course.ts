/*
  The tutorial on the phone: the web course (src/game/Tutorial/course.ts STEPS, lessons.ts missions, runner.ts coach)
  run unchanged in the core, with the step flow of Course.tsx (open a step's scene, its cues, a finished mission moves
  on after 2 s, a mission that is not running is opened again). The app draws the card, the map cues and plays the
  narrator; this returns everything as JSON with positions in lng/lat.
*/
import { sim } from '../../src/components/atc/simStore'
import { coach } from '../../src/game/Tutorial/runner'
import { CHAPTERS, COURSE_CS, tourScene, type Cue } from '../../src/game/Tutorial/lessons'
import { STEPS, SECTIONS, firstOf, routeNames, type Step } from '../../src/game/Tutorial/course.ts'
import { spokenLine } from '../../src/lib/sim/dispatch'
import type { XY } from '../../src/lib/sim/projection'
import { drainCues, sendCue } from './tutor'
import { clockMs } from './shims'

const KEY = 'skycontrol_course_v1'
const OK = ['ok-1', 'ok-2', 'ok-3', 'ok-4']

// the phone's words for the radio controls (the web's talk about clicking and the Space key)
const PHONE_BODY: Record<string, string[]> = {
  controls: ['Tap the call on the card to send it.', 'Or type it: the keyboard button.', 'Or hold the mic button and say it.'],
}

type Anchor = { kind: 'xy'; xy: XY } | { kind: 'cs' } | { kind: 'cmd' } | { kind: 'none' }

let i = 0
let anchor: Anchor = { kind: 'none' }
let doneAt: number | null = null
let misses = 0, lastCheck = 0
let said: { goal: string | null; met: number } = { goal: null, met: 0 }
const narration: string[] = []
const sfx: string[] = []
let started = false

const now = clockMs   // app time: pauses with the app, and runs at test speed headless
const ll = (p: XY): [number, number] => { const q = sim.engine!.proj.toLngLat(p.x, p.y); return [Math.round(q.lng * 1e7) / 1e7, Math.round(q.lat * 1e7) / 1e7] }
const safe = <T>(fn: () => T, d: T): T => { try { return fn() } catch { return d } }

function readStep(): number { try { const n = Number(localStorage.getItem(KEY)); return Number.isFinite(n) && n > 0 && n < STEPS.length ? n : 0 } catch { return 0 } }

/** Open the step's scene (Course.tsx's step effect). */
function openStep(): void {
  const e = sim.engine; if (!e) return
  const step = STEPS[i]
  doneAt = null; said = { goal: null, met: 0 }
  if (step.mission) { anchor = { kind: 'cs' }; coach.open(step.mission, { story: false, fresh: step.fresh }); return }
  if (coach.state.chapter) coach.stop()
  if (sim.position !== 'ground' && sim.position !== 'tower') sim.setPosition('ground')
  sim.autoSpawn = false
  const a = e.find(COURSE_CS)
  if (step.sec === 'airport' || step.sec === 'radio') { if (!a || a.phase !== 'parked') { tourScene(e); sim.select(null); sim.emit() } }
  sendCue({ kind: 'clear' })
  const cues = safe(() => step.cues?.(e) ?? [], [] as Cue[])
  const xy = safe(() => step.anchor?.(e) ?? null, null as XY | null)
  const cam = cues.find((q): q is Extract<Cue, { kind: 'camera' }> => q.kind === 'camera')
  anchor = step.point === 'cmd' ? { kind: 'cmd' } : xy ? { kind: 'xy', xy } : cam ? { kind: 'xy', xy: cam.at } : { kind: 'none' }
  for (const c of cues) sendCue(c)
}

function go(n: number): void {
  i = Math.max(0, Math.min(STEPS.length - 1, n))
  try { localStorage.setItem(KEY, String(i)) } catch { /* */ }
  openStep()
}

export function start(fromStart = false): void {
  if (!started) { coach.init(); started = true }
  i = fromStart ? 0 : readStep()
  openStep()
}

/** Called with the panels (a few times a second): auto-advance, reopen a lost mission, narrator cues. */
function update(): void {
  const step = STEPS[i]; const st = coach.state
  const live = !!step.mission && st.chapter?.id === step.mission
  const done = live && st.stage === 'done'
  if (done) { doneAt ??= now(); if (now() - doneAt > 2000) { go(i + 1); return } } else doneAt = null
  // a mission step whose mission is not running opens it again (Course.tsx)
  if (step.mission && now() - lastCheck > 1500) {
    lastCheck = now()
    if (st.chapter?.id === step.mission || !sim.engine) misses = 0
    else if (++misses >= 2) { misses = 0; coach.open(step.mission, { story: false }) }
  }
  // the narrator: a word when something is done, then the next objective
  const ch = st.chapter
  if (!ch || st.stage !== 'live') { said = { goal: null, met: 0 }; return }
  const cur = coach.current(), metN = st.met.size
  const prev = said; said = { goal: cur?.id ?? null, met: metN }
  if (metN > prev.met) { sfx.push('chime'); narration.push(OK[Math.floor(Math.random() * OK.length)]) }
  if (cur && cur.id !== prev.goal) narration.push(`g-${ch.id}-${cur.id}`)
}

function cueOut(c: Cue): Record<string, unknown> {
  switch (c.kind) {
    case 'camera': {
      const a = c.follow != null ? sim.engine?.byId(c.follow) : null
      return { kind: 'camera', at: ll(a ? a.pos : c.at), dist: c.dist, yaw: c.yaw ?? null, pitch: c.pitch ?? null, ms: c.ms ?? 1600, follow: c.follow ?? null }
    }
    case 'route': return { kind: 'route', id: c.id, c: c.pts.map(ll), color: c.color ?? '#3bea7a' }
    case 'mark': return { kind: 'mark', id: c.id, at: ll(c.at), label: c.label, tone: c.tone }
    case 'clear': return { kind: 'clear', id: c.id ?? null }
  }
}

function anchorOut(): Record<string, unknown> | null {
  const e = sim.engine; if (!e) return null
  if (anchor.kind === 'cmd') return { kind: 'cmd' }
  if (anchor.kind === 'xy') return { kind: 'xy', at: ll(anchor.xy), alt: 0 }
  if (anchor.kind === 'cs') {
    const ph = coach.phrase(coach.current())
    const a = (ph ? e.find(ph.split(' ')[0]) : null) ?? e.find(coach.target() ?? '')
    if (a && a.phase !== 'departed') return { kind: 'cs', at: ll(a.pos), alt: Math.round(Math.max(0, a.altitude) * 0.3048), id: a.id }
  }
  return null
}

/** Everything the app draws for the course now. */
export function state(): string {
  update()
  const e = sim.engine
  const step: Step = STEPS[i]
  const st = coach.state
  const secIdx = SECTIONS.findIndex((x) => x.id === step.sec)
  const inSec = STEPS.filter((x) => x.sec === step.sec), nInSec = inSec.indexOf(step) + 1
  const live = !!step.mission && st.chapter?.id === step.mission && (st.stage === 'live' || st.stage === 'done')
  const done = live && st.stage === 'done'
  let mission: Record<string, unknown> | null = null
  if (step.mission) {
    const ch = st.chapter
    const cur = live ? coach.current() : null
    const phrase = live ? coach.phrase(cur) : null
    const note = [...st.notes].reverse().find((n) => n.tone !== 'done')
    mission = {
      live, stage: st.stage, fast: coach.fast,
      goals: live && ch ? ch.goals.filter((g) => !g.optional).map((g) => ({ id: g.id, met: st.met.has(g.id), now: cur?.id === g.id })) : [],
      cur: cur ? { id: cur.id, title: cur.title, why: cur.why ?? '', phrase, spoken: phrase && e ? safe(() => spokenLine(e as never, phrase), null) : null } : null,
      note: note ? { id: note.id, text: note.text, tone: note.tone } : null,
    }
  }
  return JSON.stringify({
    i, n: STEPS.length, last: i === STEPS.length - 1,
    sections: SECTIONS.map((x, k) => {
      const all = STEPS.filter((y) => y.sec === x.id)
      return { id: x.id, title: x.title, on: k === secIdx, frac: k < secIdx ? 1 : k > secIdx ? 0 : (nInSec - (done ? 0 : 1)) / all.length, first: firstOf(x.id) }
    }),
    step: { id: step.id, sec: step.sec, kicker: `${SECTIONS[secIdx].title} · ${nInSec}/${inSec.length}`, title: step.title, body: PHONE_BODY[step.id] ?? step.body, visual: step.visual ?? null, mission: step.mission ?? null, point: step.point ?? null },
    routeNames: e ? safe(() => routeNames(e), [] as string[]) : [],
    mission, done,
    cues: e ? drainCues().map(cueOut) : [],
    anchor: anchorOut(),
    narrate: narration.splice(0, narration.length),
    sfx: sfx.splice(0, sfx.length),
    chapterCard: step.mission ? CHAPTERS.find((c) => c.id === step.mission)?.card ?? null : null,
  })
}

export const next = () => go(i + 1)
export const back = () => go(i - 1)
export const goTo = (n: number) => go(n)
export const goSection = (sec: string) => go(firstOf(sec as never))
export function send(phrase: string): string {
  sfx.push('tick')
  const r = sim.command(phrase)
  return JSON.stringify({ ok: r.ok, error: (r as { error?: string }).error ?? null })
}
export function freePlay(): void { coach.freePlay() }
export function restartCourse(): void { try { localStorage.removeItem(KEY) } catch { /* */ } go(0) }
export function dismissNote(id: number): void { coach.dismissNote(id) }
export function stop(): void { if (started) { coach.dispose(); started = false } }
