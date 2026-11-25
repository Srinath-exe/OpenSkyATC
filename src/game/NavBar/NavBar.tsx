'use client'
/* Top bar (UX 04 §2.1 / §10 "Top bar", design 01 §4.9, A11.8, A11.9, A15). */
import { IATA } from '@/game/Board/flightInfo'
import * as React from 'react'
import Link from 'next/link'
import styles from './NavBar.module.css'
import { Tabs, Pill, IconButton, Segmented, Tooltip, LogoMark, IconPause, IconPlay, IconBell, IconSettings, Icon, cx, useCountUp, formatThousands } from '@/design'
import type { PlayerPosition, Sector } from '@/lib/sim/types'
import { sectorAi, sectorPatch } from '@/components/atc/simStore'
import { HIGHLIGHT_STYLES, getHighlightStyle, setHighlightStyle, type HighlightStyle } from '@/components/atc/MapboxMap/highlight'
import { openTaxiMap } from '@/game/TaxiMap/feed'
import { openReport } from '../Report/Report'
import { RunwayPicker } from './RunwayPicker'
import { sim, useSim } from '../hooks/useSimSelector'
import { formatSimClock } from '../hooks/useSimSelector'
import { useUtcClock } from '../hooks/useClock'
import { useShell } from '../shellContext'
import { useLayout } from '../layout'
import { TxIndicator, useTxLit } from '../TxIndicator/TxIndicator'

const POSITIONS: PlayerPosition[] = ['tower', 'approach']

/** Position tabs: the design-system Tabs primitive plus `aria-pressed` mirrored from `aria-selected` (05 §3.1 convention). */
function PositionTabs() {
  const position = useSim((s) => s.position)
  const hasRadar = useSim((s) => !!s.radar)
  const icao = useSim((s) => s.icao)
  const ai = useSim((s) => {
    const m = s.settings.autoMode; const llm = s.llm.mode === 'control' ? s.llm.positions : []
    return `${s.settings.autoGround || (m && s.position !== 'ground') || llm.includes('ground') ? 'g' : ''}${s.settings.autoTower || (m && s.position !== 'tower') || llm.includes('tower') ? 't' : ''}${s.settings.autoApproach || (m && s.position !== 'approach') || llm.includes('approach') ? 'a' : ''}${llm.length ? '|llm' : ''}`
  })
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
      b.setAttribute('aria-pressed', b.getAttribute('aria-selected') === 'true' ? 'true' : 'false')
      // a dot on positions an AI assist is working (settings: AI assist)
      const id = b.dataset.testid ?? ''
      const on = (id.endsWith('tower') && ai.includes('g') && ai.includes('t')) || (id.endsWith('approach') && ai.includes('a'))
      b.setAttribute('data-ai', on ? 'true' : 'false')
      b.title = on ? (ai.includes('|llm') ? 'An AI assist or the edge LLM is working this position' : 'AI assist is active on this position') : ''
    })
  }, [position, hasRadar, ai])
  const items = POSITIONS.map((p) => ({ id: p, label: TAB_LABEL[p], testId: `mode-tab-${p}`, disabled: p === 'approach' && !hasRadar }))
  const tabs = (
    <div ref={ref} className={styles.tabs} data-testid="position-tabs">
      <Tabs ariaLabel="Position" items={items} value={position} onChange={(id) => sim.setPosition(id as PlayerPosition)} />
    </div>
  )
  if (hasRadar) return tabs
  return <Tooltip content={`No radar airspace for ${icao || 'this airport'}`} placement="bottom">{tabs}</Tooltip>
}

const SECTOR_LABEL: Record<Sector, string> = { airfield: 'Tower', approach: 'Approach' }
const SECTOR_SHORT: Record<Sector, string> = { airfield: 'TWR', approach: 'APP' }
const SECTOR_JOB: Record<Sector, string> = { airfield: 'ground and runway', approach: 'arrivals and departures on radar' }
/** View tabs, one per job: TOWER (ground + runway, the 3D field) and APPROACH (the radar). */
const TAB_LABEL: Record<PlayerPosition, string> = { ground: 'GROUND', tower: 'TOWER', approach: 'APPROACH' }

/** Who works each sector — click to hand it to the AI or take it back, mid-shift included. */
function SectorChips() {
  const hasRadar = useSim((s) => !!s.radar)
  const airfield = useSim((s) => sectorAi(s.settings, 'airfield'))
  const approach = useSim((s) => sectorAi(s.settings, 'approach'))
  const chip = (sector: Sector, ai: boolean) => (
    <Tooltip key={sector} content={ai ? `AI is running ${SECTOR_LABEL[sector]} (${SECTOR_JOB[sector]}). Click to take it over.` : `You are running ${SECTOR_LABEL[sector]} (${SECTOR_JOB[sector]}). Click to hand it to the AI.`} placement="bottom">
      <Pill size="s" tone={ai ? 'orange' : 'outline'} interactive selected={ai} aria-pressed={ai} onClick={() => sim.setSectorAi(sector, !ai)} testId={`sector-${sector}`} data-state={ai ? 'ai' : 'you'}>
        <span className={styles.sectorFull}>{SECTOR_LABEL[sector]}</span><span className={styles.sectorShort}>{SECTOR_SHORT[sector]}</span> · {ai ? 'AI' : 'You'}
      </Pill>
    </Tooltip>
  )
  return (
    <div className={styles.sectors} data-testid="sector-chips">
      {chip('airfield', airfield)}
      {hasRadar ? chip('approach', approach) : null}
    </div>
  )
}

function AtisChip() {
  const shell = useShell()
  const atis = useSim((s) => s.atis())
  const rwys = useSim((s) => s.runways())
  const open = !!shell.open.atis
  // more than two ends: "27R/27L +2" keeps the chip from clipping mid-token at 1600 px (full list in the ATIS panel)
  const short = (list: string[]) => (list.length > 2 ? `${list.slice(0, 2).join('/')} +${list.length - 2}` : list.join('/')) || '—'
  const dep = short(atis?.activeDep?.length ? atis.activeDep : rwys.filter((r) => r.activeDep).map((r) => r.name))
  const arr = short(atis?.activeArr?.length ? atis.activeArr : rwys.filter((r) => r.activeArr).map((r) => r.name))
  const wind = atis ? `${String(Math.round(atis.wind.dir)).padStart(3, '0')}/${String(Math.round(atis.wind.kts)).padStart(2, '0')}${atis.wind.gust ? `G${Math.round(atis.wind.gust)}` : ''}` : '—'
  return (
    <Pill
      size="m"
      tone="glass"
      interactive
      selected={open}
      tabular
      icon={<Icon name="radio" size={16} />}
      iconTone={atis ? 'orange' : 'none'}
      className={styles.atisChip}
      onClick={() => shell.toggle('atis')}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-dropdown-trigger="atis"
      testId="atis-chip"
    >
      <span className={styles.atisLetter}>ATIS {atis?.letter ?? '—'}</span>
      <span className={cx(styles.atisSep, styles.atisWide)}>·</span>
      <span className={cx(styles.atisPart, styles.atisWide)}>{dep === arr ? dep : `${dep} / ${arr}`}</span>
      <span className={cx(styles.atisSep, styles.atisMid)}>·</span>
      <span className={cx(styles.atisPart, styles.atisMid)} data-testid="wind">{wind}</span>
      <span className={cx(styles.atisSep, styles.atisWideQnh)}>·</span>
      <span className={cx(styles.atisPart, styles.atisWideQnh)}>Q{atis?.qnh ?? '—'}</span>
      {atis?.cloud ? <span className={cx(styles.atisSep, styles.atisWideCloud)}>·</span> : null}
      {atis?.cloud ? <span className={cx(styles.atisPart, styles.atisWideCloud)}>{atis.cloud}</span> : null}
    </Pill>
  )
}

function Clock() {
  const utc = useUtcClock()
  const simT = useSim((s) => Math.floor(s.engine?.time ?? 0))
  const rate = useSim((s) => s.rate)
  const paused = useSim((s) => s.paused)
  const [open, setOpen] = React.useState(false)
  const wrap = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); e.stopPropagation() } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={wrap} className={styles.clockWrap}>
      <button type="button" className={styles.clock} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" data-testid="clock-utc" title="Sim time and rate">
        <span data-testid="clock"><Digits text={utc ? `${utc}Z` : '--:--:--Z'} /></span>
        <span className={styles.clockSim}><Digits text={formatSimClock(simT)} /></span>
      </button>
      {open ? (
        <div className={styles.popover} role="dialog" aria-label="Sim time" data-testid="clock-popover">
          <div className={styles.popRow}><span>UTC</span><strong>{utc}Z</strong></div>
          <div className={styles.popRow}><span>Session</span><strong>{formatSimClock(simT)}</strong></div>
          <div className={styles.popRow}><span>Rate</span><strong>{paused ? 'Paused' : `${rate}×`}</strong></div>
        </div>
      ) : null}
    </div>
  )
}

function RateControl() {
  const rate = useSim((s) => s.rate)
  const paused = useSim((s) => s.paused)
  const [ff, setFf] = React.useState(false)
  const prevRate = React.useRef<1 | 2 | 4>(1)
  const startFf = () => { if (ff) return; prevRate.current = sim.rate; setFf(true); sim.setRate(4); if (sim.paused) sim.setPaused(false) }
  const stopFf = () => { if (!ff) return; setFf(false); sim.setRate(prevRate.current) }
  return (
    <div className={styles.rateGroup} role="group" aria-label="Sim rate">
      <Tooltip content={paused ? 'Resume' : 'Pause'} kbd={['Space']} placement="bottom">
        <IconButton
          size={32}
          variant="ghost"
          label={paused ? 'Resume' : 'Pause'}
          icon={paused ? <IconPlay size={16} /> : <IconPause size={16} />}
          active={paused}
          aria-pressed={paused}
          data-state={paused ? 'paused' : 'running'}
          onClick={() => sim.togglePause()}
          testId="rate-pause"
        />
      </Tooltip>
      <Segmented
        ariaLabel="Rate"
        tabular
        value={String(rate)}
        onChange={(id) => sim.setRate(Number(id) as 1 | 2 | 4)}
        items={[
          { id: '1', label: '1×', testId: 'rate-1x' },
          { id: '2', label: '2×', testId: 'rate-2x' },
          { id: '4', label: '4×', testId: 'rate-4x' },
        ]}
      />
      <Tooltip content="Hold to fast-forward" placement="bottom">
        <button
          type="button"
          className={styles.ff}
          aria-label="Fast forward (hold)"
          data-state={ff ? 'on' : 'off'}
          data-testid="rate-ff"
          onPointerDown={startFf}
          onPointerUp={stopFf}
          onPointerLeave={stopFf}
          onPointerCancel={stopFf}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startFf() } }}
          onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') stopFf() }}
        >
          <Icon name="zap" size={16} />
        </button>
      </Tooltip>
      <span className={styles.rateSep} aria-hidden="true" />
      <AutopilotButton />
    </div>
  )
}

/** Autopilot: the AI works both sectors — the game plays itself (the sector chips hand over one sector at a time;
 *  this is the one-click "watch it run" form). */
function AutopilotButton() {
  const all = useSim((s) => sectorAi(s.settings, 'airfield') && sectorAi(s.settings, 'approach'))
  const toggle = () => sim.updateSettings({ ...sectorPatch('airfield', !all), ...sectorPatch('approach', !all) })
  return (
    <Tooltip content={all ? 'Autopilot on — the AI is working every position. Click to take over.' : 'Autopilot — let the AI work every position (watch mode)'} placement="bottom">
      <IconButton size={32} variant="ghost" label={all ? 'Autopilot on' : 'Autopilot'} icon={<Icon name="sparkles" size={16} />} active={all} accentIcon={all} aria-pressed={all} onClick={toggle} testId="nav-autopilot" data-state={all ? 'on' : 'off'} />
    </Tooltip>
  )
}

/** Score with a live delta float (UX 04 §7.1 "Score"): number rolls, `+n` floats up, `−n` shakes in red. */
function ScoreChip() {
  const shell = useShell()
  const score = useSim((s) => s.score())
  const hi = useSim((s) => s.highScore)
  const shown = useCountUp(score, 600, { animateDecrease: false })
  const prev = React.useRef(score)
  const [delta, setDelta] = React.useState<{ v: number; k: number } | null>(null)
  React.useEffect(() => {
    const d = score - prev.current
    prev.current = score
    if (d === 0) return
    setDelta({ v: d, k: Date.now() })
    const t = setTimeout(() => setDelta(null), 1300)
    return () => clearTimeout(t)
  }, [score])
  const open = !!shell.open.stats
  return (
    <button type="button" className={styles.score} onClick={() => shell.toggle('stats')} aria-expanded={open} aria-haspopup="dialog" data-open={open} data-dropdown-trigger="stats" data-testid="score-chip" title="Score breakdown">
      <span className={styles.scoreLabel}>Score</span>
      <span className={styles.scoreValue} data-testid="score" data-value={score}><span key={delta?.k ?? 0} className={delta ? styles.scoreBump : undefined}>{formatThousands(shown)}</span></span>
      {hi > 0 ? <span className={styles.scoreHi} data-testid="score-hi">HI {formatThousands(hi)}</span> : null}
      {delta ? <span key={delta.k} className={styles.scoreDelta} data-neg={delta.v < 0} aria-hidden="true">{delta.v > 0 ? `+${formatThousands(delta.v)}` : `−${formatThousands(-delta.v)}`}</span> : null}
    </button>
  )
}

function AlertsBell() {
  const shell = useShell()
  const unacked = useSim((s) => s.alerts().filter((a) => !a.ack && a.severity !== 'info').length)
  const [pulseKey, setPulseKey] = React.useState(0)
  const prev = React.useRef(unacked)
  React.useEffect(() => { if (unacked > prev.current) setPulseKey((k) => k + 1); prev.current = unacked }, [unacked])
  const open = !!shell.open.alerts
  return (
    <Tooltip content="Alerts" placement="bottom">
      <IconButton
        size={40}
        variant="glass"
        label={unacked ? `Alerts, ${unacked} unacknowledged` : 'Alerts'}
        icon={<IconBell size={20} />}
        badge={unacked || undefined}
        badgePulse={pulseKey > 0}
        active={open}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-dropdown-trigger="alerts"
        data-count={unacked}
        onClick={() => shell.toggle('alerts')}
        testId="alerts-bell"
      />
    </Tooltip>
  )
}

export function NavBar() {
  const shell = useShell()
  const icao = useSim((s) => s.icao)
  const name = useSim((s) => s.airspace?.name ?? s.engine?.airportName ?? s.icao)
  const escalated = useSim((s) => {
    const t = s.engine?.time ?? 0
    return s.alerts().some((a) => a.severity === 'critical' && !a.ack && t - a.createdAt > 10)
  })
  const position = useSim((s) => s.position)
  const layout = useLayout()
  if (layout === 'classic') return <ClassicNav name={name} icao={icao} escalated={escalated} position={position} />
  return (
    <nav className={styles.nav} data-layout="board" data-escalated={escalated} aria-label="Top bar">
      {/* three floating pills (the map shows between them): where you are, the time, how it is going */}
      <div className={styles.pill}>
        <Link href="/start" prefetch={false} className={styles.brand} data-testid="brand-home" onClick={(e) => { if (sim.engine) { e.preventDefault(); shell.show('leaveConfirm') } }} title={name && name !== icao ? `${name} · Home` : 'Home'}>
          <span className={styles.brandMark}><LogoMark size={24} /></span>
          <span className={styles.brandApt}>{icao ? (icao.length === 4 && icao[0] === 'K' ? icao.slice(1) : IATA[icao] ?? icao) : '—'}</span>
        </Link>
        <PositionSwitch />
      </div>
      <div className={styles.mid}>
        <div className={styles.pill}>
          <Clock />
          <span className={styles.vsep} aria-hidden="true" />
          <RunwayPicker />
          <Speed />
        </div>
        <button type="button" className={styles.taxiMap} onClick={() => openTaxiMap()} title="Taxi map in its own window, for a second screen" data-testid="open-taxi-map">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20V9a3 3 0 0 1 3-3h10" /><path d="M4 14h8a3 3 0 0 1 3 3v3" /><path d="M14 3l3 3-3 3" /></svg>
          <span>Taxi map</span>
        </button>
      </div>
      <div className={styles.pill}>
        <ScoreChip />
        <span className={styles.vsep} aria-hidden="true" />
        <AlertsButton />
        <ReportButton />
        <SettingsButton />
        <VoiceButton />
        <MoreMenu />
      </div>
      <span className="sr-only" aria-live="polite">{position} position</span>
    </nav>
  )
}

/** The two jobs, each with its own AI switch: click the name to work it, the AI chip to hand it to the AI (or take
 *  it back). A sector the AI is running glows green. */
function PositionSwitch() {
  const position = useSim((s) => s.position)
  const hasRadar = useSim((s) => !!s.radar)
  const aiTwr = useSim((s) => sectorAi(s.settings, 'airfield'))
  const aiApp = useSim((s) => sectorAi(s.settings, 'approach'))
  const tab = (p: PlayerPosition, sector: Sector, ai: boolean, disabled: boolean) => {
    const on = position === p || (p === 'tower' && position === 'ground')
    const flip = () => sim.updateSettings(sectorPatch(sector, !ai))
    // the sector you are not on is always the AI's (so both keep working); its chip shows that, and its switch is
    // for when you go there
    const auto = !on && !ai
    ai = ai || !on
    return (
      <div className={styles.posTab} data-on={on || undefined} data-ai={ai || undefined} data-disabled={disabled || undefined}>
        <button type="button" className={styles.posBtn} disabled={disabled} onClick={() => sim.setPosition(p)} aria-pressed={on} data-testid={`mode-tab-${p}`}
          title={disabled ? 'No radar for this airport' : on ? `You are on ${SECTOR_LABEL[sector]}` : `Switch to ${SECTOR_LABEL[sector]}`}>{TAB_LABEL[p]}</button>
        {disabled ? null : (
          <span role="switch" tabIndex={0} aria-checked={ai} aria-label={`AI on ${SECTOR_LABEL[sector]}`} className={styles.aiSw} data-on={ai || undefined} data-auto={auto || undefined}
            title={auto ? `The AI is running ${SECTOR_LABEL[sector]} (${SECTOR_JOB[sector]}) while you are on the other one. Click to keep it with the AI when you switch.` : ai ? `AI is running ${SECTOR_LABEL[sector]} (${SECTOR_JOB[sector]}). Click to take it over.` : `Hand ${SECTOR_LABEL[sector]} (${SECTOR_JOB[sector]}) to the AI`}
            onClick={auto ? () => sim.updateSettings(sectorPatch(sector, true)) : flip} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (auto ? () => sim.updateSettings(sectorPatch(sector, true)) : flip)() } }} data-testid={`sector-ai-${sector}`}>
            <span className={styles.aiLbl}>{ai ? 'AI ON' : 'AI OFF'}</span>
          </span>
        )}
      </div>
    )
  }
  return (
    <div className={styles.posSwitch} data-testid="position-tabs">
      {tab('tower', 'airfield', aiTwr, false)}
      {tab('approach', 'approach', aiApp, !hasRadar)}
    </div>
  )
}

/** The bar's one button: 34 px round, an 18 px line icon. Rest: quiet; hover: lit; active (on / open): solid white. */
function NavButton({ label, icon, active, badge, onClick, testId, ...rest }: { label: string; icon: React.ReactNode; active?: boolean; badge?: number; onClick: () => void; testId?: string } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button type="button" className={styles.nb} data-active={active || undefined} aria-label={label} title={label} aria-pressed={rest['aria-expanded'] == null ? !!active : undefined} onClick={onClick} data-testid={testId} {...rest}>
      {icon}{badge ? <em className={styles.nbBadge}>{badge > 9 ? '9+' : badge}</em> : null}
    </button>
  )
}
/** A ticking number that never changes width: every digit in its own fixed slot (the face's figures are proportional). */
function Digits({ text }: { text: string }) {
  return <>{text.split('').map((c, i) => <span key={i} className={/[0-9]/.test(c) ? styles.dg : c === ':' ? styles.dgColon : undefined}>{c}</span>)}</>
}
/** Pause and the three speeds: one control. */
function Speed() {
  const rate = useSim((s) => s.rate)
  const paused = useSim((s) => s.paused)
  return (
    <div className={styles.speed} role="group" aria-label="Game speed">
      <NavButton label={paused ? 'Resume (P)' : 'Pause (P)'} icon={paused ? <IconPlay size={16} /> : <IconPause size={16} />} active={paused} onClick={() => sim.togglePause()} testId="rate-pause" data-state={paused ? 'paused' : 'running'} />
      <span className={styles.speedSeg}>
        {([1, 2, 4] as const).map((r) => (
          <button key={r} type="button" className={styles.speedBtn} data-on={(!paused && rate === r) || undefined} aria-pressed={rate === r} onClick={() => { sim.setRate(r); if (sim.paused) sim.setPaused(false) }} data-testid={`rate-${r}x`}><span className={styles.speedNum}>{r}</span><span className={styles.speedX}>×</span></button>
        ))}
      </span>
    </div>
  )
}
function SettingsButton() {
  const shell = useShell()
  return <NavButton label="Settings" icon={<IconSettings size={18} />} active={!!shell.open.settings} aria-expanded={!!shell.open.settings} onClick={() => shell.toggle('settings')} testId="settings-btn" />
}
function AlertsButton() {
  const shell = useShell()
  const unacked = useSim((s) => s.alerts().filter((a) => !a.ack && a.severity !== 'info').length)
  return <NavButton label={unacked ? `Alerts, ${unacked} new` : 'Alerts'} icon={<IconBell size={18} />} badge={unacked} active={!!shell.open.alerts} aria-expanded={!!shell.open.alerts} data-dropdown-trigger="alerts" onClick={() => shell.toggle('alerts')} testId="alerts-bell" />
}
/** Show us what is wrong on this screen: a recording, a screenshot or one part of it (src/feedback). */
function ReportButton() {
  return <NavButton label="Report something on this screen (Ctrl Shift U)" icon={<Icon name="report" size={18} />} onClick={openReport} testId="report-btn" aria-haspopup="menu" data-report-anchor="" />
}
/** Pilot and ATC voices on / off; a red dot while anyone is transmitting. */
function VoiceButton() {
  const shell = useShell()
  const tts = useSim((s) => s.settings.tts)
  const on = useTxLit()
  return (
    <span className={styles.voiceWrap} data-tx={shell.ptt || undefined}>
      <NavButton label={tts ? 'Voices on' : 'Voices off'} icon={<Icon name={tts ? 'volume-2' : 'volume-x'} size={18} />} active={!tts} onClick={() => sim.toggleTTS()} testId="tx-indicator"
        aria-pressed={tts} data-voice={tts ? 'on' : 'off'} data-state={on ? 'tx' : 'idle'} />
    </span>
  )
}

/** Everything the bar used to show as its own button: weather, runways, autopilot, settings, help. */
function MoreMenu() {
  const shell = useShell()
  const [open, setOpen] = React.useState(false)
  const wrap = React.useRef<HTMLDivElement>(null)
  const auto = useSim((s) => sectorAi(s.settings, 'airfield') && sectorAi(s.settings, 'approach'))
  const [hl, setHl] = React.useState<HighlightStyle>('none')
  React.useEffect(() => { setHl(getHighlightStyle()) }, [open])
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); e.stopPropagation() } }
    document.addEventListener('pointerdown', onDown); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const item = (label: string, hint: string | null, on: () => void, testId: string) => (
    <button type="button" className={styles.menuItem} onClick={() => { setOpen(false); on() }} data-testid={testId}><span>{label}</span>{hint ? <small>{hint}</small> : null}</button>
  )
  return (
    <div ref={wrap} className={styles.moreWrap}>
      <NavButton label="More" icon={<Icon name="more-horizontal" size={18} />} active={open} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)} testId="nav-more" />
      {open ? (
        <div className={styles.menu} role="menu">
          {item('Weather and ATIS', null, () => shell.toggle('atis'), 'atis-chip')}
          {item('Runways and airport', null, () => shell.show('runwayConfig'), 'airport-badge')}
          {item(auto ? 'Autopilot: on' : 'Autopilot', auto ? 'AI is working every position' : 'Let the AI play', () => sim.updateSettings({ ...sectorPatch('airfield', !auto), ...sectorPatch('approach', !auto) }), 'nav-autopilot')}
          <span className={styles.menuSep} />
          <div className={styles.menuGroup}><small>Selected aircraft</small>
            <div className={styles.menuChips}>{HIGHLIGHT_STYLES.map((h) => <button key={h.id} type="button" data-on={hl === h.id || undefined} onClick={() => { setHighlightStyle(h.id); setHl(h.id) }} data-testid={`highlight-${h.id}`}>{h.label}</button>)}</div>
          </div>
          <span className={styles.menuSep} />
          {item('Help', '?', () => shell.toggle('help'), 'help-btn')}
        </div>
      ) : null}
    </div>
  )
}

/** The classic layout's top bar (with the strip bay and the command panel): the original full-width bar. */
function ClassicNav({ name, icao, escalated, position }: { name: string | null | undefined; icao: string | null | undefined; escalated: boolean; position: string }) {
  const shell = useShell()
  return (
    <nav className={styles.nav} data-layout="classic" data-escalated={escalated} aria-label="Top bar">
      <div className={styles.left}>
        <Link href="/start" prefetch={false} className={styles.brand} data-testid="brand-home" onClick={(e) => { if (sim.engine) { e.preventDefault(); shell.show('leaveConfirm') } }} title="Home">
          <span className={styles.brandMark}><LogoMark size={28} /></span>
          <span className={styles.brandText}>
            <span className={styles.brandWord}>OpenATC</span>
            <span className={styles.brandSub}>{name && name !== icao ? `${name} · ${icao}` : icao || 'No airport'}</span>
          </span>
        </Link>
        <Pill size="s" tone="outline" interactive tabular onClick={() => shell.show('runwayConfig')} testId="airport-badge" title="Airport and runway configuration">{icao || '—'}</Pill>
        <span className={styles.divider} aria-hidden="true" />
        <PositionTabs />
        <SectorChips />
      </div>
      <div className={styles.center}>
        <AtisChip />
      </div>
      <div className={styles.right}>
        <Clock />
        <RateControl />
        <ScoreChip />
        <AlertsBell />
        <Tooltip content="Report" placement="bottom">
          <IconButton size={40} variant="glass" label="Report something on this screen" icon={<Icon name="report" size={20} />} onClick={openReport} testId="report-btn" data-report-anchor="" />
        </Tooltip>
        <TxIndicator />
        <Tooltip content="Settings" placement="bottom">
          <IconButton size={40} variant="glass" label="Settings" icon={<IconSettings size={20} />} active={!!shell.open.settings} onClick={() => shell.toggle('settings')} testId="settings-btn" />
        </Tooltip>
        <Tooltip content="Help" kbd={['?']} placement="bottom">
          <IconButton size={40} variant="glass" label="Help" icon={<Icon name="help-circle" size={20} />} active={!!shell.open.help} onClick={() => shell.toggle('help')} testId="help-btn" />
        </Tooltip>
      </div>
      <span className="sr-only" aria-live="polite">{position} position</span>
    </nav>
  )
}
