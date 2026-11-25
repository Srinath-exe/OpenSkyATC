'use client'
/*
  GameShell — the single game screen (00-MASTER-PLAN §2.5, UX 04 §2).
  Grid: NavBar / full-bleed map or radar with floating glass panels / comm log.
  Owns the ShellContext (panel collapse, overlays, focus region, PTT), the
  keyboard dispatcher, the <body data-*> mirrors and the overlay hosts.
*/
import * as React from 'react'
import { MapCover } from '@/components/atc/PixelLanding'
import { ModelUpdate } from '@/game/ModelUpdate/ModelUpdate'
import { installTapSounds, soundAircraft, worldSound } from '@/components/atc/worldSound'
import dynamic from 'next/dynamic'
import styles from './GameShell.module.css'
import { Pill, GlassPanel, Button, IconPause } from '@/design'
import { sim, useSim } from '../hooks/useSimSelector'
import { setRadioKey } from '@/components/atc/pilotVoice'
import { FlightBoard, FlightCard } from '@/game/Board/Board'
import { StripBay } from '@/game/StripBay'
import type { StripBayHandle } from '@/game/StripBay'
import { CommandPanel } from '@/game/CommandPanel'
import { useLayout, getLayout } from '@/game/layout'
import { usePersistedState } from '../hooks/usePersistedState'
import { LS } from '../persist'
import { ShellContext, useOverlayState } from '../shellContext'
import type { ShellState } from '../shellContext'
import { NavBar } from '../NavBar/NavBar'
import { AlertStack, AlertsDrawer } from '../AlertStack/AlertStack'
import { RunwayBars } from '../RunwayBars/RunwayBars'
import { hasWorld, prefetchWorld } from '@/components/atc/WorldMap/worldList'
import { AtisWeather } from '../AtisWeather/AtisWeather'
import { RunwayConfigDialog } from '../AtisWeather/RunwayConfigDialog'
import { VehiclePanel } from '@/game/VehiclePanel'
import { CommLog } from '../CommLog/CommLog'
import { StatsPanel } from '../StatsPanel/StatsPanel'
import { HelpOverlay } from '../HelpOverlay/HelpOverlay'
import { OnboardingTips } from '../HelpOverlay/OnboardingTips'
import { PauseMenu } from '../PauseMenu/PauseMenu'
import { SettingsModal } from '../SettingsModal/SettingsModal'
import { HoldingScreen } from '../HoldingScreen/HoldingScreen'
import { ToastHost } from './ToastHost'
import { LeaveConfirm } from './LeaveConfirm'
import { LiquidGlassDefs } from './LiquidGlassDefs'
import { useShellHotkeys } from './useShellHotkeys'
import { CloudVeil } from './CloudVeil'
import { startTaxiFeed } from '@/game/TaxiMap/feed'
import { cloudGate } from '@/components/atc/cloudGate'
import { useMapEngine } from '@/components/atc/MapboxMap/engine'

const GroundView = dynamic(() => import('@/components/atc/GroundView'), { ssr: false, loading: () => <div className={styles.viewPending}>Loading map</div> })
// the 3D world (three.js + the map code) is its own chunk: the shell is interactive while it downloads, and its world
// files are fetched in parallel with it (prefetchWorld)
const WorldMap = dynamic(() => import('@/components/atc/WorldMap/WorldMap').then((m) => m.WorldMap), { ssr: false, loading: () => <div className={styles.viewPending}>Building the world</div> })
const MapboxMap = dynamic(() => import('@/components/atc/MapboxMap/MapboxMap').then((m) => m.MapboxMap), { ssr: false, loading: () => <MapCover icao={sim.icao || 'KSFO'} open step="Loading the map" /> })
// the Tower <-> Approach transition's signals (kept in step with MapboxMap.tsx; importing them would pull the map in eagerly)
const VIEW_EVENT = 'atc-view-transition', MAP_READY_EVENT = 'atc-map-ready'
const setIntroFromRadar = () => { void import('@/components/atc/MapboxMap/MapboxMap').then((m) => { m.viewIntro.fromRadar = true }) }
const ApproachView = dynamic(() => import('@/components/atc/ApproachView'), { ssr: false, loading: () => <div className={styles.viewPending}>Loading radar</div> })

interface PanelPrefs { bay: boolean; log: boolean }
const DEFAULT_PANELS: PanelPrefs = { bay: false, log: false }

type FocusRegion = ShellState['focusRegion']

export interface GameShellProps {
  /** Airport data is being fetched (page-owned so the overlay sits over the map, not the nav). */
  loading?: boolean
  loadError?: string | null
  onRetry?: () => void
  /** Drawn over the map inside the shell (the tutorial's coach and story); replaces the first-run tips. */
  overlay?: React.ReactNode
  /** Training: only the map, the aircraft, the overlay and the command line. */
  minimal?: boolean
}

export function GameShell({ loading = false, loadError = null, onRetry, overlay, minimal = false }: GameShellProps) {
  const overlays = useOverlayState()
  const { open, isOpen, show, hide, toggle, closeTop } = overlays
  const layout = useLayout()
  // a first visit is read before usePersistedState's effects run (they write the default back straight away)
  const firstVisit = React.useRef(false)
  React.useLayoutEffect(() => { try { firstVisit.current = localStorage.getItem(LS.panels) == null } catch { /* */ } }, [])
  const [panels, setPanels] = usePersistedState<PanelPrefs>(LS.panels, DEFAULT_PANELS)
  // the board's radio bar is the collapsed log: collapse it on a first visit (after mount: the server cannot know the
  // layout, and a different first render broke hydration)
  React.useEffect(() => { if (firstVisit.current && getLayout() === 'board') setPanels((p) => ({ ...p, log: true })) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  /** StripBay handle (classic layout: focusNext / focusPrev / focusStrip; the bay registers the shell cycler used by Tab). */
  const bayRef = React.useRef<StripBayHandle>(null)
  const [ptt, setPttState] = React.useState(false)
  const [focusRegion, setFocusRegion] = React.useState<FocusRegion>('map')
  const cmdFocus = React.useRef<((prefill?: string) => void) | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)

  const position = useSim((s) => s.position)
  const paused = useSim((s) => s.paused)
  const rate = useSim((s) => s.rate)
  const hasRadar = useSim((s) => !!s.radar)
  const hasEngine = useSim((s) => !!s.engine)
  const selectedId = useSim((s) => s.selectedId)
  const icao = useSim((s) => s.icao)

  const toggleBay = React.useCallback(() => setPanels((p) => ({ ...p, bay: !p.bay })), [setPanels])
  const toggleLog = React.useCallback(() => setPanels((p) => ({ ...p, log: !p.log })), [setPanels])
  const setLogCollapsed = React.useCallback((b: boolean) => setPanels((p) => (p.log === b ? p : { ...p, log: b })), [setPanels])
  const setPtt = React.useCallback((b: boolean) => { setRadioKey(b); setPttState((prev) => (prev === b ? prev : b)) }, [])   // (others wait while the player transmits)
  const focusCmd = React.useCallback((prefill?: string) => {
    if (panels.log && getLayout() === 'classic') {
      // classic: let a collapsed log expand before focusing (the board's radio bar keeps its call field)
      setPanels((p) => ({ ...p, log: false }))
      window.setTimeout(() => cmdFocus.current?.(prefill), 0)
      return
    }
    cmdFocus.current?.(prefill)
  }, [panels.log, setPanels])
  const registerCmdFocus = React.useCallback((fn: ((prefill?: string) => void) | null) => { cmdFocus.current = fn }, [])

  const shell = React.useMemo<ShellState>(() => ({
    bayCollapsed: panels.bay,
    logCollapsed: panels.log,
    toggleBay, toggleLog, setLogCollapsed,
    open, isOpen, show, hide, toggle, closeTop,
    focusCmd, registerCmdFocus,
    ptt, setPtt,
    focusRegion,
  }), [panels.bay, panels.log, toggleBay, toggleLog, setLogCollapsed, open, isOpen, show, hide, toggle, closeTop, focusCmd, registerCmdFocus, ptt, setPtt, focusRegion])

  const openPause = React.useCallback(() => show('pause'), [show])
  useShellHotkeys(shell, { hasRadar, openPause })

  // <body data-mode data-focus-region data-paused data-rate> (UX G12) + data-ptt for the TX indicator styling.
  React.useEffect(() => {
    const b = document.body
    b.setAttribute('data-mode', position)
    b.setAttribute('data-paused', paused ? 'true' : 'false')
    b.setAttribute('data-rate', String(rate))
    b.setAttribute('data-focus-region', focusRegion)
    b.setAttribute('data-ptt', ptt ? 'true' : 'false')
    return () => { for (const k of ['data-mode', 'data-paused', 'data-rate', 'data-focus-region', 'data-ptt']) b.removeAttribute(k) }
  }, [position, paused, rate, focusRegion, ptt])

  // Focus model (G6): the region owning keyboard focus, from the nearest [data-region]; selecting an aircraft moves it to the panel.
  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null
      const region = el?.closest?.('[data-region]')?.getAttribute('data-region') as FocusRegion | null | undefined
      if (region) setFocusRegion(region)
    }
    root.addEventListener('focusin', onFocus)
    return () => root.removeEventListener('focusin', onFocus)
  }, [])
  React.useEffect(() => { if (selectedId != null) setFocusRegion('panel') }, [selectedId])
  // the airfield's sound and the buttons' clicks (worldSound.ts), while the game is on screen
  React.useEffect(() => {
    const stop = worldSound.start(() => { const e = sim.engine; return e ? { time: e.time, paused: sim.paused, scope: sim.position === 'approach', aircraft: soundAircraft(e.aircraft as never, sim.selectedId) } : null })
    const off = installTapSounds()
    return () => { stop(); off() }
  }, [])

  // The map toolbar's truck button asks the shell to toggle the vehicles panel (GroundView bridge event).
  React.useEffect(() => {
    const onToggle = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean }>).detail?.open
      if (want == null) toggle('vehicles')
      else if (want) show('vehicles')
      else hide('vehicles')
    }
    window.addEventListener('atc:toggle-vehicles-panel', onToggle)
    return () => window.removeEventListener('atc:toggle-vehicles-panel', onToggle)
  }, [toggle, show, hide])
  const vehiclesOpen = !!open.vehicles && position !== 'approach'
  React.useEffect(() => { (sim as unknown as { vehiclesPanelOpen?: boolean }).vehiclesPanelOpen = vehiclesOpen }, [vehiclesOpen])

  // Approach tab without radar airspace falls back to tower (G10).
  React.useEffect(() => { if (hasEngine && !hasRadar && position === 'approach') sim.setPosition('tower') }, [hasEngine, hasRadar, position])

  const view = position === 'approach' && hasRadar ? 'radar' : 'ground'
  // the procedural 3D world is the ground/tower map; the 2D map remains the tested surface (test mode, or ?world=2d)
  // and the fallback for an airport without baked world data
  const worldAvailable = hasWorld(icao)
  const [worldPref] = React.useState<'3d' | '2d' | 'auto'>(() => {
    if (typeof window === 'undefined') return 'auto'
    const q = new URLSearchParams(window.location.search)
    const w = q.get('world')
    if (w === '3d') return '3d'
    if (w === '2d' || q.get('test') === '1' || q.get('test') === 'true') return '2d'
    return 'auto'
  })
  // sim.testMode is set by load(), after this component first mounts — read it at render time (the map only mounts once the engine exists)
  const use3d = worldAvailable && (worldPref === '3d' || (worldPref === 'auto' && !sim.testMode))
  const mapEngine = useMapEngine()
  // ── Tower <-> Approach: through the clouds (CloudVeil) ──
  //  to the radar: the map camera climbs, clouds close over it, the views swap where nothing can be seen, and the clouds
  //  break up over the radar. back to the tower: the radar zooms in on the airport, the clouds close, and they open over
  //  the field as the map flies down - whatever loading there is happens inside the cloud.
  //  The map is kept (hidden, drawing nothing) while the player is on the radar, so coming back is immediate.
  const animView = use3d && mapEngine === 'mapbox'
  const [tr, setTr] = React.useState<'toRadar' | 'toGround' | null>(null)
  const [covered, setCovered] = React.useState(false)
  const [opening, setOpening] = React.useState(false)
  const [farReady, setFarReady] = React.useState(false)
  const keepMap = React.useMemo(() => typeof window !== 'undefined' && !window.matchMedia?.('(pointer: coarse)').matches && ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) >= 4, [])
  const hadMap = React.useRef(false)
  const lastView = React.useRef(view)
  // the render right after the switch, before the effect below has set `tr`: already in transition (else the map would
  // unmount for one render and come back as a fresh map)
  const switching = animView && hasEngine && lastView.current !== view
  const effTr = tr ?? (switching ? (view === 'radar' ? 'toRadar' : 'toGround') : null)
  const isCovered = switching ? false : covered
  React.useEffect(() => {
    if (lastView.current === view) return
    const from = lastView.current; lastView.current = view
    const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!animView || still || !hasEngine) { setTr(null); return }
    setCovered(false); setOpening(false); setFarReady(view === 'radar')
    setTr(view === 'radar' ? 'toRadar' : 'toGround')
    if (view === 'radar' && from === 'ground') { window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: 'toRadar' })); return }
    // the map gets ready behind the radar and the clouds: the kept one at once, a fresh one as soon as it has loaded
    const ready = () => setFarReady(true)
    window.addEventListener(MAP_READY_EVENT, ready, { once: true })
    if ((window as unknown as { __mbx?: { ready: boolean } }).__mbx?.ready) window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: 'toGround' }))
    else setIntroFromRadar()
    return () => window.removeEventListener(MAP_READY_EVENT, ready)
  }, [view, animView, hasEngine])
  const onCovered = React.useCallback(() => setCovered(true), [])
  const onOpen = React.useCallback(() => { setOpening(true); if (lastView.current === 'ground') window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: 'open' })) }, [])
  const onTrDone = React.useCallback(() => { setTr(null); setCovered(false); setOpening(false) }, [])
  // zooming past the edge of either view changes sides (the same as the Tower / Approach tabs)
  React.useEffect(() => {
    if (!animView || !hasEngine || !hasRadar) return
    cloudGate.pass = (dir) => {
      if ((dir === 'out') !== (view === 'ground')) return false
      sim.setPosition(dir === 'out' ? 'approach' : 'tower'); return true
    }
    return () => { cloudGate.pass = null }
  }, [animView, hasEngine, hasRadar, view])
  const mapOn = view === 'ground' || effTr === 'toRadar' || (keepMap && hadMap.current)
  if (animView && hasEngine && mapOn) hadMap.current = true
  if (!keepMap && view === 'radar' && !effTr) hadMap.current = false
  const mapShown = view === 'ground' ? effTr !== 'toGround' || isCovered : effTr === 'toRadar' && !isCovered
  const radarOn = view === 'radar' || (effTr === 'toGround' && !isCovered)
  const radarShown = effTr !== 'toRadar' || isCovered
  React.useEffect(() => startTaxiFeed(), [])   // the taxi map's window, if one is open
  React.useEffect(() => { if (worldAvailable && worldPref !== '2d' && mapEngine !== 'mapbox' && !sim.testMode) prefetchWorld(icao) }, [icao, worldAvailable, worldPref, mapEngine])

  return (
    <ShellContext.Provider value={shell}>
      <div
        ref={rootRef}
        className={styles.shell}
        data-testid="game-shell"
        data-mode={position}
        data-paused={paused}
        data-bay-collapsed={panels.bay}
        data-log-collapsed={panels.log}
        data-has-panel={selectedId != null && !minimal}
        data-minimal={minimal || undefined}
        data-layout={layout}
      >
        <NavBar />

        <main className={styles.main} aria-label="Map and panels">
          <div className={styles.view} data-region="map" data-view={view} data-testid={`view-${view}`}>
            {hasEngine ? (animView ? (
              // the 3D map and the radar both mounted while one hands over to the other (see the transition above)
              <>
                {mapOn ? <div className={styles.mapLayer} data-hidden={!mapShown || undefined}><MapboxMap key={`mapbox-${icao}`} hidden={!mapShown} /></div> : null}
                {radarOn ? <div className={styles.radarLayer} data-tr={effTr ?? undefined} data-hidden={!radarShown || undefined} data-open={opening || undefined}><ApproachView key={`radar-${icao}`} /></div> : null}
                <CloudVeil mode={effTr} ready={farReady} onCovered={onCovered} onOpen={onOpen} onDone={onTrDone} />
              </>
            ) : view === 'radar' ? <ApproachView key={`radar-${icao}`} /> : use3d ? (mapEngine === 'mapbox' ? <MapboxMap key={`mapbox-${icao}`} /> : <WorldMap key={`world-${icao}`} />) : <GroundView key={`ground-${icao}`} />) : null}
          </div>

          {paused ? (
            <div className={styles.paused}>
              <Pill size="s" tone="solid" icon={<IconPause size={14} />} iconTone="white" className={styles.pausedPill} testId="paused-pill">Paused</Pill>
            </div>
          ) : null}

          <AlertStack />
          <RunwayBars />

          {/* departures and arrivals on the left, the selected flight on the right (no instruction buttons: calls are
              spoken or typed); the old strip bay and command panel stay in the code base, unused */}
          <div className={styles.bay} data-region="bay">
            {layout === 'classic' ? <StripBay ref={bayRef} /> : <FlightBoard />}
          </div>
          <div className={styles.panel} data-region="panel">
            {layout === 'classic' ? <CommandPanel /> : <FlightCard />}
          </div>

          {vehiclesOpen ? (
            <div className={styles.vehicles} data-region="panel">
              <VehiclePanel />
            </div>
          ) : null}

          {open.atis ? <AtisWeather /> : null}
          {open.alerts ? <AlertsDrawer /> : null}
          {open.stats ? <StatsPanel /> : null}

          <ToastHost />
          {overlay ?? <OnboardingTips />}
          {minimal ? null : <ModelUpdate />}

          {loading || (!hasEngine && !loadError) ? (
            <div className={styles.loadWrap} data-testid="load-overlay">
              <div data-testid="loading-overlay" style={{ position: 'absolute', inset: 0 }}><MapCover icao={icao || 'KSFO'} open step="Loading the airport" /></div>
            </div>
          ) : null}
          {loadError && !loading ? (
            <div className={styles.loadError} role="alert">
              <GlassPanel variant="solid" title="Airport failed to load" subtitle={icao || undefined} className={styles.loadErrorCard} testId="loading-error-card">
                <div className={styles.loadErrorBody}>
                  <p className={styles.loadErrorText} data-testid="loading-error">{loadError}</p>
                  <div className={styles.loadErrorActions}>
                    <Button variant="accent" onClick={onRetry} testId="loading-retry">Retry</Button>
                    <Button variant="ghost" onClick={() => show('leaveConfirm')} testId="loading-home">Home</Button>
                  </div>
                </div>
              </GlassPanel>
            </div>
          ) : null}
        </main>

        <div className={styles.logRow} data-region="log">
          <CommLog />
        </div>

        <RunwayConfigDialog open={!!open.runwayConfig} onClose={() => hide('runwayConfig')} />
        <HelpOverlay />
        <PauseMenu />
        <SettingsModal />
        <LeaveConfirm />
        <HoldingScreen />
        <LiquidGlassDefs />
      </div>
    </ShellContext.Provider>
  )
}
