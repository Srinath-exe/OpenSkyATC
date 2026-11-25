'use client'
/* First-run coach marks (UX 04 §8): five skippable tips that advance on their own when the player does the thing; persisted once seen. */
import * as React from 'react'
import styles from './HelpOverlay.module.css'
import { GlassPanel, Button, Kbd } from '@/design'
import { onboardingSeen, setOnboardingSeen } from '@/components/atc/persist'
import { sim, useSim } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'
import { keyParts, useKey } from '../keybindings'

export const EV_REPLAY_TIPS = 'atc:replay-tips'
const STEPS = 5

export function OnboardingTips() {
  const talk = useKey('ptt'), undoK = useKey('undo'), helpK = useKey('help')
  const shell = useShell()
  const hasEngine = useSim((s) => !!s.engine)
  const testMode = useSim((s) => s.testMode)
  const selectedId = useSim((s) => s.selectedId)
  const atcLines = useSim((s) => s.radio.reduce((n, l) => n + (l.who === 'ATC' ? 1 : 0), 0))
  const pilotLines = useSim((s) => s.radio.reduce((n, l) => n + (l.who === 'PILOT' && l.status !== undefined ? 1 : 0), 0))
  const firstDep = useSim((s) => s.aircraft().find((a) => a.plan.kind === 'departure')?.callsign ?? null)
  const depRunway = useSim((s) => s.runways().find((r) => r.activeDep)?.name ?? null)
  const delayS = useSim((s) => s.settings.pilotDelayS ?? 3)

  const [visible, setVisible] = React.useState(false)
  const [step, setStep] = React.useState(0)
  const stepRef = React.useRef(0)
  stepRef.current = step
  const base = React.useRef({ atc: 0, pilot: 0 })

  React.useEffect(() => {
    if (!hasEngine || testMode) return
    if (!onboardingSeen()) { setVisible(true); setStep(0) }
  }, [hasEngine, testMode])
  React.useEffect(() => {
    const replay = () => { setOnboardingSeen(false); setVisible(true); setStep(0) }
    window.addEventListener(EV_REPLAY_TIPS, replay)
    return () => window.removeEventListener(EV_REPLAY_TIPS, replay)
  }, [])

  const finish = React.useCallback(() => { setVisible(false); setOnboardingSeen(true) }, [])
  const next = React.useCallback(() => {
    base.current = { atc: sim.radio.filter((l) => l.who === 'ATC').length, pilot: sim.radio.filter((l) => l.who === 'PILOT' && l.status !== undefined).length }
    if (stepRef.current + 1 >= STEPS) finish()
    else setStep(stepRef.current + 1)
  }, [finish])

  // Auto-advance when the tip's action happened.
  React.useEffect(() => {
    if (!visible) return
    if (step === 0 && selectedId != null) next()
    else if (step === 1 && atcLines > base.current.atc) next()
    else if (step === 2 && pilotLines > base.current.pilot) next()
    else if (step === 3 && pilotLines > base.current.pilot) next()
  }, [visible, step, selectedId, atcLines, pilotLines, next])

  // Enter = next, Esc = skip (capture so the shell dispatcher does not also act); never while a panel or input has focus.
  const rendered = visible && hasEngine && !shell.open.help && !shell.open.pause
  React.useEffect(() => {
    if (!rendered) return   // the tip is not on screen while help / pause is open: Esc belongs to them
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      // only when nothing in a panel owns the keyboard (body or the map surface)
      const free = !t || t === document.body || !!t.closest?.('[data-region="map"], [data-onboarding]')
      if (!free) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish() }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [rendered, finish, next])

  if (!visible || !hasEngine || shell.open.help || shell.open.pause) return null
  const cs = firstDep ?? 'the first departure'
  const rwy = depRunway ?? 'the active runway'
  const text: React.ReactNode[] = [
    <>This is <strong>{cs}</strong>. Click it on the map or in the departures list on the left: its card opens on the right.</>,
    <>Give it a call: hold <Kbd keys={keyParts(talk)} /> and say it, or type it in the call field at the bottom, e.g. <strong>{cs} pushback approved</strong>, then <Kbd>Enter</Kbd>.</>,
    <>Wind favours <strong>{rwy}</strong>. After a call you have <strong>{delayS} s</strong> to undo it with <Kbd keys={keyParts(undoK)} />.</>,
    <>The pilot reads it back. The flight's card on the right keeps its whole conversation with you.</>,
    <>Next, the taxi: <strong>{cs} taxi to runway {rwy} via</strong> the taxiways. <Kbd keys={keyParts(helpK)} /> opens the full help.</>,
  ]
  return (
    <GlassPanel variant="lit" padding="tile" radius="inner" className={styles.tips} role="status" aria-live="polite" data-step={step} data-onboarding="true" testId={`tip-${step + 1}`}>
      <div className={styles.tipBody}>
        <span className={styles.tipText}>{text[step]}</span>
        <div className={styles.tipFoot}>
          <span className={styles.tipDots} aria-label={`Tip ${step + 1} of ${STEPS}`}>
            {Array.from({ length: STEPS }, (_, i) => <span key={i} className={styles.tipDot} data-on={i === step} data-done={i < step} data-testid={`tip-progress-${i + 1}`} />)}
          </span>
          <Button size="sm" variant="ghost" onClick={finish} testId="tip-skip-all">Skip</Button>
          <Button size="sm" variant="accent" onClick={next} testId="tip-next">{step + 1 >= STEPS ? 'Done' : 'Next'}</Button>
        </div>
      </div>
    </GlassPanel>
  )
}
