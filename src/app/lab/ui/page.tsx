'use client'
/* /lab/ui?v=1..10: ten arrangements of the game's HUD over a still of the SFO map (public/lab/ui/map.jpg), for picking
   elements to combine. Mock data; the aircraft pictures are the real ones (aircraftThumb.ts: each type in its
   airline's livery, side profile). Every variant uses the aircraft card (small in lists, large as the detail). */
import * as React from 'react'
import { useAircraftThumb } from '@/components/atc/aircraftThumb'
import s from './ui.module.css'

type Stage = 'PARKED' | 'PUSH' | 'TAXI' | 'HOLD' | 'LINED UP' | 'AIRBORNE' | 'FINAL' | 'TAXI IN'
interface Ac { cs: string; type: string; name: string; airline: string; reg: string; stand: string; rwy: string; stage: Stage; dep: boolean; alt?: number; spd?: number; req?: string; alert?: string; timer: string; done: number }
const AC: Ac[] = [
  { cs: 'SWA2210', type: 'B737', name: 'Boeing 737-700', airline: 'Southwest', reg: 'N7880D', stand: 'C11', rwy: '01R', stage: 'PARKED', dep: true, req: 'Push and start', timer: '0:42', done: 1 },
  { cs: 'UAL214', type: 'B77W', name: 'Boeing 777-300ER', airline: 'United', reg: 'N2749U', stand: 'G9', rwy: '28L', stage: 'TAXI', dep: true, timer: '1:58', done: 3 },
  { cs: 'DAL40', type: 'A359', name: 'Airbus A350-900', airline: 'Delta', reg: 'N501DN', stand: 'E8', rwy: '28R', stage: 'FINAL', dep: false, alt: 2400, spd: 152, timer: '0:15', done: 2 },
  { cs: 'ASA331', type: 'A320', name: 'Airbus A320', airline: 'Alaska', reg: 'N627VA', stand: 'B13', rwy: '28L', stage: 'HOLD', dep: true, req: 'Ready for departure', timer: '0:31', done: 4 },
  { cs: 'ETD24', type: 'A388', name: 'Airbus A380-800', airline: 'Etihad', reg: 'A6-APA', stand: 'A6', rwy: '28R', stage: 'PUSH', dep: true, timer: '2:10', done: 2 },
  { cs: 'JBU915', type: 'A321', name: 'Airbus A321', airline: 'JetBlue', reg: 'N923JB', stand: 'A11', rwy: '28L', stage: 'TAXI IN', dep: false, timer: '0:58', done: 5 },
  { cs: 'BAW285', type: 'B744', name: 'Boeing 747-400', airline: 'British Airways', reg: 'G-CIVB', stand: 'A3', rwy: '28R', stage: 'AIRBORNE', dep: true, alt: 3100, spd: 210, alert: 'STCA', timer: '0:08', done: 5 },
]
const SEL = AC[1]
const STEPS = ['Pushback', 'Taxi', 'Hold short', 'Line up', 'Takeoff']
const RWYS: [string, string][] = [['28L', 'DEP'], ['28R', 'ARR'], ['01R', 'FREE'], ['01L', 'FREE'], ['10L', 'CLOSED'], ['10R', 'FREE']]
const LOG = [
  { who: 'ATC', t: 'United two one four, taxi to runway two eight left via alpha, hold short of runway two eight right' },
  { who: 'UAL214', t: 'Taxi two eight left via alpha, hold short two eight right, United two one four' },
  { who: 'ASA331', t: 'Tower, Alaska three three one, holding short two eight left, ready' },
]

// ── building blocks ──
function Thumb({ ac, className }: { ac: Ac; className?: string }) {
  const u = useAircraftThumb(ac.type, ac.cs)
  return <span className={`${s.thumb} ${className ?? ''}`}>{u ? <img src={u} alt="" /> : <i className={s.thumbPh} />}</span>
}
const stageTone = (st: Stage) => (st === 'HOLD' || st === 'LINED UP' ? 'warn' : st === 'FINAL' || st === 'AIRBORNE' ? 'air' : st === 'PARKED' ? 'idle' : 'go')
function StagePill({ st }: { st: Stage }) { return <span className={s.pill} data-tone={stageTone(st)}>{st}</span> }
function Boxes({ n }: { n: number }) { return <span className={s.boxes}>{'PTWOF'.split('').map((c, i) => <i key={c} data-done={i < n || undefined}>{c}</i>)}</span> }

/** The strip: a small version of the aircraft card. size: card (list), mini (avatar chip), row (table), dock (tall). */
function Strip({ ac, size = 'card', sel }: { ac: Ac; size?: 'card' | 'mini' | 'row' | 'dock'; sel?: boolean }) {
  if (size === 'mini') return <div className={s.mini} data-sel={sel || undefined}><Thumb ac={ac} /><b>{ac.cs}</b>{ac.req ? <i className={s.dot} /> : null}</div>
  if (size === 'row') return (
    <div className={s.row} data-sel={sel || undefined}>
      <Thumb ac={ac} /><b>{ac.cs}</b><span>{ac.type}</span><span>{ac.dep ? ac.stand : 'ARR'}</span><span>{ac.rwy}</span><StagePill st={ac.stage} /><span className={s.mono}>{ac.timer}</span>
    </div>
  )
  return (
    <div className={size === 'dock' ? s.dockCard : s.card} data-sel={sel || undefined} data-alert={ac.alert ? 'y' : undefined}>
      <div className={s.cardTop}><b className={s.cs}>{ac.cs}</b><span className={s.badge}>{ac.type}</span><StagePill st={ac.stage} /></div>
      <Thumb ac={ac} className={s.cardImg} />
      <div className={s.cardBot}>
        <span className={s.route}>{ac.dep ? `${ac.stand} → ${ac.rwy}` : `${ac.alt ? `${ac.alt} ft · ${ac.spd} kt · ` : ''}RWY ${ac.rwy}`}</span>
        {ac.req ? <span className={s.req}>{ac.req}</span> : ac.alert ? <span className={s.alert}>{ac.alert}</span> : <Boxes n={ac.done} />}
      </div>
    </div>
  )
}
/** The detail: the full aircraft card (the reference layout) with the clearances and the actions. */
function Detail({ ac = SEL, compact }: { ac?: Ac; compact?: boolean }) {
  return (
    <div className={s.detail} data-compact={compact || undefined}>
      <div className={s.dHead}><div><h3>{ac.name}</h3><p>{ac.airline} · {ac.cs}</p></div><span className={s.badge}>{ac.type}</span></div>
      <Thumb ac={ac} className={s.dImg} />
      <div className={s.dFacts}>
        <div><small>Registration</small><b>{ac.reg}</b></div><div><small>Stand</small><b>{ac.stand}</b></div><div><small>Runway</small><b>{ac.rwy}</b></div>
      </div>
      {!compact ? <div className={s.steps}>{STEPS.map((t, i) => <span key={t} data-done={i < ac.done - 1 || undefined} data-now={i === ac.done - 1 || undefined}>{t}</span>)}</div> : null}
      <div className={s.actions}>{['Hold short', 'Line up', 'Takeoff', 'Follow'].map((t) => <button key={t} type="button">{t}</button>)}</div>
    </div>
  )
}
function TopBar({ mode = 'full' }: { mode?: 'full' | 'pill' | 'split' | 'compact' }) {
  const brand = <span className={s.brand}><i className={s.logo} />OpenATC<small>KSFO</small></span>
  const pos = <span className={s.seg}><b>TOWER</b><span>APPROACH · AI</span></span>
  const atis = <span className={s.atis}>ATIS A · 28R/10L · 300/13 · Q1011</span>
  const clock = <span className={s.clock}>21:55:09Z</span>
  const rate = <span className={s.rate}><i>▶</i><b>1×</b><span>2×</span><span>4×</span></span>
  const score = <span className={s.score}>Score <b>480</b></span>
  const icons = <span className={s.icons}><i>🔔</i><i>⚙</i><i>?</i></span>
  if (mode === 'pill') return <div className={s.topPill}>{clock}<em />{atis}<em />{score}</div>
  if (mode === 'split') return (<><div className={`${s.island} ${s.tl}`}>{brand}{pos}</div><div className={`${s.island} ${s.tc}`}>{clock}{rate}</div><div className={`${s.island} ${s.tr}`}>{score}{icons}</div></>)
  if (mode === 'compact') return <div className={s.topCompact}>{brand}{pos}<span className={s.grow} />{clock}{score}{icons}</div>
  return <div className={s.top}>{brand}{pos}{atis}{clock}{rate}{score}{icons}</div>
}
function Comms({ mode = 'log' }: { mode?: 'log' | 'subtitle' | 'ticker' | 'panel' }) {
  if (mode === 'subtitle') return <div className={s.subtitle}><b>{LOG[1].who}</b> {LOG[1].t}</div>
  if (mode === 'ticker') return <div className={s.ticker}>{LOG.map((l, i) => <span key={i}><b>{l.who}</b> {l.t}</span>)}</div>
  return (
    <div className={mode === 'panel' ? s.commsPanel : s.comms}>
      {mode === 'panel' ? <p className={s.h}>Radio</p> : null}
      {LOG.map((l, i) => <p key={i} data-atc={l.who === 'ATC' || undefined}><b>{l.who}</b>{l.t}</p>)}
      <div className={s.input}>Callsign then a command, e.g. UAL214 taxi 28L via A<kbd>Space</kbd></div>
    </div>
  )
}
function Runways({ mode = 'chips' }: { mode?: 'chips' | 'list' }) {
  return <div className={mode === 'list' ? s.rwyList : s.rwyChips}>{RWYS.map(([r, st]) => <span key={r} data-st={st}><b>{r}</b>{st}</span>)}</div>
}
function MapTools({ mode = 'stack' }: { mode?: 'stack' | 'row' | 'one' }) {
  if (mode === 'one') return <div className={s.toolOne}>◎</div>
  return <div className={mode === 'row' ? s.toolsRow : s.tools}>{['+', '−', '◎', '⌖', '👁', '⌂'].map((t) => <i key={t}>{t}</i>)}</div>
}
const PTT = ({ label = 'Hold Space to talk' }: { label?: string }) => <div className={s.ptt}><i />{label}</div>

// ── top bars: six cleaner takes on the game's current bar (same contents: airport, position, ATIS, time, speed,
// score, alerts, settings), shown stacked on one page (v=12) to compare ──
const Logo = () => <i className={s.logo} />
const PosSeg = ({ ai }: { ai?: boolean }) => <span className={s.tSeg}><b>Tower</b><span>Approach{ai ? <i className={s.aiDot} /> : null}</span></span>
const Rate = () => <span className={s.tRate}><i>❚❚</i><b>1×</b><span>2×</span><span>4×</span></span>
const Bell = ({ n = 2 }: { n?: number }) => <span className={s.tIcon}>🔔{n ? <em>{n}</em> : null}</span>
const More = () => <span className={s.tIcon}>⋯</span>
const TOPS: { name: string; idea: string; el: () => React.ReactNode }[] = [
  { name: 'Trimmed', idea: 'Today\'s bar with the extras taken out: one logo, the airport once, settings and help folded into one menu.', el: () => (
    <div className={s.tBar}><Logo /><b className={s.tApt}>SFO</b><PosSeg /><span className={s.grow} /><span className={s.tAtis}>ATIS A · 28L/01R · 300/13</span><span className={s.grow} /><span className={s.tClock}>21:55Z</span><Rate /><span className={s.tScore}>480</span><Bell /><More /></div>) },
  { name: 'Two clusters', idea: 'Where you are on the left, how it is going on the right. Nothing in the middle, so the map stays open.', el: () => (
    <div className={s.tBar}><span className={s.tGroup}><Logo /><b className={s.tApt}>San Francisco</b><PosSeg /></span><span className={s.grow} /><span className={s.tGroup}><span className={s.tMuted}>ATIS A</span><span className={s.tClock}>21:55Z</span><Rate /><span className={s.tScore}><small>Score</small>480</span><Bell /><More /></span></div>) },
  { name: 'Three pills', idea: 'Floating pills instead of a bar: the airport and position, the time and speed in the middle, score and alerts on the right.', el: () => (
    <div className={s.tPills}><span className={s.tPill}><Logo /><b className={s.tApt}>SFO</b><PosSeg /></span><span className={s.tPill}><span className={s.tClock}>21:55:09Z</span><Rate /></span><span className={s.tPill}><span className={s.tScore}>480</span><Bell /><More /></span></div>) },
  { name: 'Text only', idea: 'No boxes or chips: plain words separated by thin dots, one accent colour for the position you are working.', el: () => (
    <div className={`${s.tBar} ${s.tPlain}`}><Logo /><b>SFO</b><em>·</em><b className={s.tOn}>Tower</b><span className={s.tMuted}>Approach</span><span className={s.grow} /><span className={s.tMuted}>ATIS A  300/13  Q1011</span><em>·</em><span className={s.tClock}>21:55Z</span><em>·</em><span>1×</span><em>·</em><span className={s.tScore}>480</span><span className={s.grow} /><Bell n={0} /><More /></div>) },
  { name: 'Slim', idea: 'A 40 px strip: the smallest bar that still has everything, numbers in mono so nothing jumps.', el: () => (
    <div className={`${s.tBar} ${s.tSlim}`}><Logo /><b className={s.tApt}>KSFO</b><PosSeg /><span className={s.grow} /><span className={s.tMono}>A · 28L/01R · 300/13 · Q1011</span><span className={s.tMono}>21:55:09Z</span><Rate /><span className={s.tMono}>480</span><Bell /><More /></div>) },
  { name: 'By purpose', idea: 'Four labelled groups: Airport, Weather, Time, You. Each group reads as one thing, so the eye knows where to look.', el: () => (
    <div className={s.tBar}><span className={s.tBlock}><small>Airport</small><span><Logo /><b>SFO</b><PosSeg ai /></span></span><span className={s.tBlock}><small>Weather</small><span>ATIS A · 300/13</span></span><span className={s.grow} /><span className={s.tBlock}><small>Time</small><span><span className={s.tClock}>21:55Z</span><Rate /></span></span><span className={s.tBlock}><small>You</small><span><span className={s.tScore}>480</span><Bell /><More /></span></span></div>) },
]
/** The bars in place: the flight board screen with one bar across the top, a switcher in the corner (← → or A-F). */
function TopBars() {
  const [i, setI] = React.useState(0)
  React.useEffect(() => {
    const q = (new URLSearchParams(location.search).get('top') ?? '').toUpperCase().charCodeAt(0) - 65; if (q >= 0 && q < TOPS.length) setI(q)
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase()
      if (e.key === 'ArrowRight') setI((n) => (n + 1) % TOPS.length)
      else if (e.key === 'ArrowLeft') setI((n) => (n + TOPS.length - 1) % TOPS.length)
      else if (k.length === 1 && k >= 'A' && k < String.fromCharCode(65 + TOPS.length)) setI(k.charCodeAt(0) - 65)
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  const T = TOPS[i]
  return (<>
    <div key={i} className={s.topSlot}>{T.el()}</div>
    <div className={s.withTop}><FlightBoard /><div className={s.fRight}><FlightCard /></div></div>
    <TalkBar />
    <div className={s.presenter}>
      <div className={s.pTabs}>{TOPS.map((x, n) => <button key={x.name} type="button" data-on={n === i || undefined} onClick={() => setI(n)}>{String.fromCharCode(65 + n)}</button>)}</div>
      <b>{String.fromCharCode(65 + i)}. {T.name}</b><p>{T.idea}</p><small>← → or A–F to switch</small>
    </div>
  </>)
}

// ── v11: the flight board. Where each flight is going or coming from, its times, on time or late; no instruction
// buttons (calls are spoken or typed); the selected flight's own radio history ──
interface Sched { from: string; fromCity: string; to: string; toCity: string; sched: string; est: string; late: number; label: string }
const SCHED: Record<string, Sched> = {
  SWA2210: { from: 'SFO', fromCity: 'San Francisco', to: 'LAS', toCity: 'Las Vegas', sched: '22:05', est: '22:05', late: 0, label: 'Departs' },
  UAL214: { from: 'SFO', fromCity: 'San Francisco', to: 'NRT', toCity: 'Tokyo Narita', sched: '21:50', est: '22:02', late: 12, label: 'Departs' },
  ASA331: { from: 'SFO', fromCity: 'San Francisco', to: 'SEA', toCity: 'Seattle', sched: '21:58', est: '21:58', late: 0, label: 'Departs' },
  ETD24: { from: 'SFO', fromCity: 'San Francisco', to: 'AUH', toCity: 'Abu Dhabi', sched: '22:15', est: '22:40', late: 25, label: 'Departs' },
  BAW285: { from: 'SFO', fromCity: 'San Francisco', to: 'LHR', toCity: 'London Heathrow', sched: '21:45', est: '21:47', late: 2, label: 'Departed' },
  DAL40: { from: 'JFK', fromCity: 'New York JFK', to: 'SFO', toCity: 'San Francisco', sched: '21:56', est: '21:52', late: -4, label: 'Lands' },
  JBU915: { from: 'BOS', fromCity: 'Boston', to: 'SFO', toCity: 'San Francisco', sched: '21:40', est: '21:49', late: 9, label: 'Landed' },
}
const status = (x: Sched) => x.late > 5 ? { t: `Delayed ${x.late} min`, tone: 'late' } : x.late < -2 ? { t: `Early ${-x.late} min`, tone: 'early' } : { t: 'On time', tone: 'ok' }
const HIST: Record<string, { who: string; at: string; t: string }[]> = {
  UAL214: [
    { who: 'UAL214', at: '21:52:40', t: 'Ground, United two one four, stand G9, request push and start' },
    { who: 'ATC', at: '21:52:48', t: 'United two one four, push and start approved, facing east' },
    { who: 'UAL214', at: '21:52:53', t: 'Push and start approved, facing east, United two one four' },
    { who: 'UAL214', at: '21:56:10', t: 'United two one four, ready to taxi' },
    { who: 'ATC', at: '21:56:15', t: 'United two one four, taxi to runway two eight left via alpha, hold short of runway two eight right' },
    { who: 'UAL214', at: '21:56:21', t: 'Taxi two eight left via alpha, hold short two eight right, United two one four' },
  ],
}
function FlightRow({ ac, sel }: { ac: Ac; sel?: boolean }) {
  const x = SCHED[ac.cs], st = status(x)
  return (
    <div className={s.fRow} data-sel={sel || undefined}>
      <Thumb ac={ac} className={s.fImg} />
      <div className={s.fMid}><b>{ac.cs}</b><span>{ac.dep ? `to ${x.toCity}` : `from ${x.fromCity}`}</span></div>
      <div className={s.fEnd}><b className={s.mono}>{x.est}</b><span data-tone={st.tone}>{st.tone === 'ok' ? 'On time' : st.t.replace(' min', 'm')}</span></div>
    </div>
  )
}
function FlightBoard() {
  const deps = AC.filter((a) => a.dep), arrs = AC.filter((a) => !a.dep)
  return (
    <div className={s.board}>
      <section><p className={s.h}>Departures <em>{deps.length}</em></p>{deps.map((a) => <FlightRow key={a.cs} ac={a} sel={a === SEL} />)}</section>
      <section><p className={s.h}>Arrivals <em>{arrs.length}</em></p>{arrs.map((a) => <FlightRow key={a.cs} ac={a} />)}</section>
    </div>
  )
}
function FlightCard({ ac = SEL }: { ac?: Ac }) {
  const x = SCHED[ac.cs], st = status(x), hist = HIST[ac.cs] ?? []
  return (
    <div className={s.fCard}>
      <div className={s.fcHead}><div><h3>{ac.cs}</h3><p>{ac.airline} · {ac.name}</p></div><StagePill st={ac.stage} /></div>
      <Thumb ac={ac} className={s.fcImg} />
      <div className={s.fcRoute}>
        <div><b>{x.from}</b><span>{x.fromCity}</span></div>
        <i className={s.fcLine}><span>✈</span></i>
        <div data-r><b>{x.to}</b><span>{x.toCity}</span></div>
      </div>
      <div className={s.fcTimes}>
        <div><small>Scheduled</small><b className={s.mono}>{x.sched}</b></div>
        <div><small>{ac.dep ? 'Expected off' : 'Expected in'}</small><b className={s.mono}>{x.est}</b></div>
        <div><small>{st.tone === 'late' ? 'Delayed' : st.tone === 'early' ? 'Early' : 'Status'}</small><b data-tone={st.tone}>{st.tone === 'ok' ? 'On time' : `${st.tone === 'late' ? '+' : '−'}${Math.abs(x.late)} min`}</b></div>
      </div>
      <div className={s.fcFacts}>
        <div><small>Stand</small><b>{ac.stand}</b></div><div><small>Runway</small><b>{ac.rwy}</b></div><div><small>Type</small><b>{ac.type}</b></div><div><small>Reg</small><b>{ac.reg}</b></div>
      </div>
      <p className={s.h}>Radio with {ac.cs}</p>
      <div className={s.fcLog}>{hist.map((l, i) => <p key={i} data-atc={l.who === 'ATC' || undefined}><small className={s.mono}>{l.at.slice(0, 5)}</small><span><b>{l.who === 'ATC' ? 'You' : 'Pilot'}</b>{l.t}</span></p>)}</div>
    </div>
  )
}
/** The radio bar: the last transmission above, and one text field below it. Speaking fills the field with the
 *  transcript (fix a word before it goes, or just let it send); clicking it lets you type the call instead. */
function TalkBar() {
  const [text, setText] = React.useState('UAL214 taxi to runway 28L via A, hold short of 28R')
  const [sent, setSent] = React.useState<string | null>(null)
  const [focus, setFocus] = React.useState(false)
  const send = () => { if (!text.trim()) return; setSent(text.trim()); setText('') }
  return (
    <div className={s.talkBar}>
      <div className={s.lastCall}><b>{sent ? 'You' : LOG[1].who}</b>{sent ?? LOG[1].t}</div>
      <form className={s.callField} data-focus={focus || undefined} onSubmit={(e) => { e.preventDefault(); send() }}>
        <span className={s.micDot} title="Hold Space to talk" />
        <input value={text} onChange={(e) => setText(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} placeholder="Type a call, or hold Space and say it" spellCheck={false} aria-label="Call" />
        {text ? <button type="submit" className={s.sendBtn}>Send <kbd>↵</kbd></button> : <span className={s.hint}>Hold <kbd>Space</kbd> to talk</span>}
      </form>
    </div>
  )
}

// ── the ten layouts ──
const VARIANTS: { name: string; idea: string; el: () => React.ReactNode }[] = [
  { name: 'Classic+', idea: 'Today\'s layout with the new aircraft cards: full top bar, strip column on the left, detail on the right, runways and radio at the bottom.', el: () => (<>
    <TopBar /><div className={s.leftCol}><p className={s.h}>Strips · 7</p>{AC.map((a) => <Strip key={a.cs} ac={a} sel={a === SEL} />)}</div>
    <div className={s.rightCol}><Detail /></div><div className={s.bottomCenter}><Runways /></div><div className={s.bottom}><Comms /></div><MapTools /></>) },
  { name: 'Zen', idea: 'Almost nothing on screen: one pill for time, ATIS and score; aircraft as small picture chips; one talk button with the last call as a subtitle.', el: () => (<>
    <TopBar mode="pill" /><div className={s.chipCol}>{AC.map((a) => <Strip key={a.cs} ac={a} size="mini" sel={a === SEL} />)}</div>
    <div className={s.zenBottom}><Comms mode="subtitle" /><PTT /></div><MapTools mode="one" /></>) },
  { name: 'Dock', idea: 'The traffic lives in a dock along the bottom, like an app switcher: big pictures, swipe through. Detail floats top right.', el: () => (<>
    <TopBar mode="compact" /><div className={s.dock}>{AC.map((a) => <Strip key={a.cs} ac={a} size="dock" sel={a === SEL} />)}</div>
    <div className={s.rightFloat}><Detail compact /></div><div className={s.leftFloat}><Comms mode="panel" /></div><MapTools mode="row" /></>) },
  { name: 'Command centre', idea: 'Three fixed columns: strips, map, a full-height detail with radio under it. Runways become a status list. Everything visible at once.', el: () => (<>
    <TopBar mode="compact" /><div className={`${s.leftCol} ${s.solid}`}><p className={s.h}>Strips · 7</p>{AC.map((a) => <Strip key={a.cs} ac={a} sel={a === SEL} />)}</div>
    <div className={`${s.rightFull} ${s.solid}`}><Detail /><Runways mode="list" /><Comms mode="panel" /></div></>) },
  { name: 'Islands', idea: 'The top bar breaks into three floating islands; every panel is its own card with air around it, the map shows through the gaps.', el: () => (<>
    <TopBar mode="split" /><div className={s.leftIslands}>{AC.slice(0, 5).map((a) => <Strip key={a.cs} ac={a} sel={a === SEL} />)}</div>
    <div className={s.rightFloat2}><Detail /></div><div className={s.blIsland}><Comms /></div><div className={s.bcIsland}><Runways /></div><MapTools /></>) },
  { name: 'Lanes', idea: 'A flight\'s life left to right across the top: Gate, Push, Taxi, Hold, Runway, Air. Cards move along the lanes, so the queue at each step is obvious.', el: () => (<>
    <TopBar mode="compact" /><div className={s.lanes}>{(['PARKED', 'PUSH', 'TAXI', 'HOLD', 'FINAL', 'AIRBORNE', 'TAXI IN'] as Stage[]).map((st) => (
      <div key={st} className={s.lane}><p className={s.h}>{st}</p>{AC.filter((a) => a.stage === st).map((a) => <Strip key={a.cs} ac={a} sel={a === SEL} />)}</div>))}</div>
    <div className={s.rightLow}><Detail compact /></div><div className={s.leftLow}><Comms mode="panel" /></div><MapTools /></>) },
  { name: 'Console', idea: 'A controller\'s table: one line per aircraft with a small picture, sortable columns, monospace numbers. Most information per pixel.', el: () => (<>
    <TopBar /><div className={`${s.table} ${s.solid}`}><div className={s.thead}><span /><b>CALLSIGN</b><span>TYPE</span><span>STAND</span><span>RWY</span><span>STAGE</span><span>T</span></div>{AC.map((a) => <Strip key={a.cs} ac={a} size="row" sel={a === SEL} />)}<Runways mode="list" /></div>
    <div className={s.rightFloat2}><Detail compact /></div><div className={s.bottom}><Comms /></div><MapTools /></>) },
  { name: 'Rail', idea: 'A thin icon rail on the left for navigation; traffic moves to the right edge; the detail sits bottom-left by the radio, near your eyes when you talk.', el: () => (<>
    <div className={s.rail}>{['◉', 'TWR', 'APP', '🔔', '⚙', '?'].map((t) => <i key={t}>{t}</i>)}</div><TopBar mode="pill" />
    <div className={s.rightStrips}>{AC.map((a) => <Strip key={a.cs} ac={a} sel={a === SEL} />)}</div>
    <div className={s.blDetail}><Detail compact /><Comms mode="panel" /></div><MapTools mode="row" /></>) },
  { name: 'Spotlight', idea: 'One aircraft at a time: a big hero card with its clearance steps and the next actions; everyone else is a queue of pictures waiting their turn.', el: () => (<>
    <TopBar mode="pill" /><div className={s.queue}>{AC.filter((a) => a !== SEL).map((a) => <Strip key={a.cs} ac={a} size="mini" />)}</div>
    <div className={s.hero}><Detail /></div><div className={s.brComms}><Comms mode="panel" /></div><MapTools /></>) },
  { name: 'Sheet', idea: 'Phone-first: a header, a pull-up sheet with Strips / Radio / Runways tabs, and a big talk button. Works the same on a laptop.', el: () => (<>
    <TopBar mode="compact" /><div className={s.sheet}><div className={s.grab} /><div className={s.tabs}><b>Strips 7</b><span>Radio</span><span>Runways</span></div>
      <div className={s.sheetBody}>{AC.slice(0, 4).map((a) => <Strip key={a.cs} ac={a} sel={a === SEL} />)}</div></div>
    <div className={s.fab}><PTT label="Talk" /></div><div className={s.rightFloat}><Detail compact /></div></>) },
  { name: 'Flight board', idea: 'Top: three pills (C). Left: departures and arrivals, each with where it goes or comes from, its time and on time or late. Right: the selected flight in full, with its schedule and its own radio history, no buttons. Bottom: the last call and the talk key.', el: () => (<>
    <div className={s.topSlot}>{TOPS[2].el()}</div><div className={s.withTop}><FlightBoard /><div className={s.fRight}><FlightCard /></div></div><TalkBar /></>) },
  { name: 'Top bars', idea: 'Six cleaner versions of the current top bar, stacked to compare.', el: () => <TopBars /> },
]

export default function UiLab() {
  const [v, setV] = React.useState(0)   // 0 until the URL is read: the server's first render must match the browser's
  const [shot, setShot] = React.useState(false)
  React.useEffect(() => { const u = new URLSearchParams(location.search); const q = Number(u.get('v')); setV(q >= 1 && q <= VARIANTS.length ? q : 1); setShot(u.has('shot')) }, [])
  if (!v) return <main className={s.root}><div className={s.map} /></main>
  const V = VARIANTS[v - 1]
  return (
    <main className={s.root} data-variant={v}>
      <div className={s.map} />
      {V.el()}
      {shot ? null : (
        <nav className={s.picker}>{VARIANTS.map((x, i) => <button key={x.name} type="button" data-on={i + 1 === v || undefined} onClick={() => { setV(i + 1); history.replaceState(null, '', `?v=${i + 1}`) }}>{i + 1}. {x.name}</button>)}</nav>
      )}
    </main>
  )
}
