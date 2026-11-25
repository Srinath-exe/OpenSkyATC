'use client'
/*
  Keyboard dispatcher for the shell (UX 04 §G6, hotkeys.ts SHELL_HOTKEYS).
  Panel-local keys (action letters, pickers, the command line) run first on
  their own elements and call preventDefault; this hook only sees the rest.
*/
import * as React from 'react'
import { sim } from '@/components/atc/simStore'
import type { PlayerPosition } from '@/lib/sim/types'
import { REQUEST_ANSWER } from '@/lib/sim/commandTree'
import { requestOpenAction } from '@/game/CommandPanel/bus'
import { useHotkeys, keyChord, isEditableTarget, isPickerTarget } from '../hooks/useHotkeys'
import type { ShellState } from '../shellContext'
import { cycleStrip } from './stripCycle'
import { BIND, actionForChord, baseKey, bindChord, chordIsModded, keyFor, mouseChord, type BindId } from '../keybindings'

const POSITIONS: PlayerPosition[] = ['tower', 'approach']
const RATES: Array<1 | 2 | 4> = [1, 2, 4]

/** Buttons, links, tabs, switches: Space / Enter belong to them, never to the shell. */
function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], [role="menuitem"], summary')
}

function stepPosition(dir: 1 | -1, hasRadar: boolean): void {
  const list = hasRadar ? POSITIONS : POSITIONS.filter((p) => p !== 'approach')
  const i = list.indexOf(sim.position)
  const next = list[(Math.max(i, 0) + dir + list.length) % list.length]
  sim.setPosition(next)
}

function stepRate(dir: 1 | -1): void {
  const i = RATES.indexOf(sim.rate)
  const next = RATES[Math.min(RATES.length - 1, Math.max(0, i + dir))]
  sim.setRate(next)
}

/** Enter on a selected aircraft with an open request: open the highlighted answer at the confirm step (G6). */
function openRequestAnswer(): boolean {
  const a = sim.selected()
  if (!a) return false
  const req = a.requests.find((r) => r.answeredAt == null)
  if (!req || sim.time() < a.standbyUntil) return false
  const actionId = REQUEST_ANSWER[req.kind] ?? null
  requestOpenAction({ aircraftId: a.id, actionId, confirm: true })
  return true
}

export interface ShellHotkeyOptions {
  hasRadar: boolean
  openPause: () => void
}

export function useShellHotkeys(shell: ShellState, { hasRadar, openPause }: ShellHotkeyOptions): void {
  const shellRef = React.useRef(shell)
  shellRef.current = shell

  /** Runs a bound action. */
  const run = (id: BindId, e: KeyboardEvent): boolean => {
    const s = shellRef.current
    switch (id) {
      case 'tower': sim.setPosition('tower'); return true
      case 'approach': if (hasRadar) sim.setPosition('approach'); return true
      case 'bay': s.toggleBay(); return true
      case 'log': s.toggleLog(); return true
      case 'atis': s.toggle('atis'); return true
      case 'vehicles': if (sim.position !== 'approach') s.toggle('vehicles'); return true
      case 'cmd': case 'cmd-alt': s.focusCmd(); return true
      // speech to text: hold the talk key (a focused button lets go of it, so the release does not click it)
      case 'ptt': case 'ptt-alt': if (id === 'ptt') (e.target as HTMLElement | null)?.blur?.(); pttHeld.current = id; s.setPtt(true); return true
      case 'undo': case 'undo-alt': sim.undo(); return true
      case 'pause': sim.togglePause(); return true
      case 'rate-1': sim.setRate(1); return true
      case 'rate-2': sim.setRate(2); return true
      case 'rate-4': sim.setRate(4); return true
      case 'rate-down': stepRate(-1); return true
      case 'rate-up': stepRate(1); return true
      case 'pos-prev': stepPosition(-1, hasRadar); return true
      case 'pos-next': stepPosition(1, hasRadar); return true
      case 'help': s.toggle('help'); return true
      case 'last-callsign': if (sim.lastCallsign) s.focusCmd(`${sim.lastCallsign} `); return true
      case 'centre': if (sim.selectedId != null) sim.centerOn(sim.selectedId); return true
    }
  }
  const pttHeld = React.useRef<BindId | null>(null)
  const runRef = React.useRef(run); runRef.current = run

  useHotkeys((e) => {
    const s = shellRef.current
    const chord = keyChord(e)
    const editable = isEditableTarget(e.target)
    const picker = isPickerTarget(e.target)

    // ---- fixed keys: Esc, then the player's bindings, then Tab / Enter / page keys ----
    if (chord === 'Escape') {
      if (editable) { (e.target as HTMLElement).blur?.(); return true }
      if (document.querySelector('[data-map-floating="1"]')) return false   // the map closes its own popover / menu / bubble first
      if (s.closeTop()) return true
      if (sim.selectedId != null) { sim.select(null); return true }
      openPause()
      return true
    }

    const bc = bindChord(e)
    const id = bc ? actionForChord(bc) : null
    if (id) {
      const b = BIND[id]
      if (editable && !(b.typing && chordIsModded(bc!))) return false
      if (picker && !b.picker) return false
      if (b.notOnButtons && isInteractiveTarget(e.target)) return false
      return run(id, e)
    }

    if (editable) return false
    if (picker) {
      if (chord === 'PageDown') return cycleStrip(1)
      if (chord === 'PageUp') return cycleStrip(-1)
      return false
    }
    switch (chord) {
      case 'Enter': if (isInteractiveTarget(e.target)) return false; return openRequestAnswer()
      case 'Tab': return cycleStrip(1)
      case 'Shift+Tab': return cycleStrip(-1)
      case 'PageDown': return cycleStrip(1)
      case 'PageUp': return cycleStrip(-1)
      default: return false
    }
  })

  // speech to text: release when the held talk key (or one of its modifiers) comes up
  React.useEffect(() => {
    const MOD: Record<string, string> = { Control: 'Ctrl', Meta: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
    const onUp = (e: KeyboardEvent) => {
      const held = pttHeld.current
      if (!held) return
      const parts = keyFor(held).split('+')
      const base = MOD[e.key] ?? baseKey(e)
      if (parts.includes(base)) { pttHeld.current = null; shellRef.current.setPtt(false) }
    }
    const onBlur = () => { pttHeld.current = null; shellRef.current.setPtt(false) }
    // mouse buttons bound to an action (middle, side buttons): down runs it, up lets go of the talk key
    const onDown = (e: MouseEvent) => {
      const c = mouseChord(e); const id = c ? actionForChord(c) : null
      if (!id || e.defaultPrevented) return
      e.preventDefault(); runRef.current(id, e as unknown as KeyboardEvent)
    }
    const onMUp = (e: MouseEvent) => {
      const c = mouseChord(e); if (!c) return
      if (actionForChord(c)) e.preventDefault()   // no browser back / forward
      const held = pttHeld.current
      if (held && keyFor(held).split('+').pop() === c.split('+').pop()) { pttHeld.current = null; shellRef.current.setPtt(false) }
    }
    const block = (e: MouseEvent) => { const c = mouseChord(e); if (c && actionForChord(c)) e.preventDefault() }
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('mousedown', onDown); window.addEventListener('mouseup', onMUp); window.addEventListener('auxclick', block)
    return () => {
      window.removeEventListener('keyup', onUp); window.removeEventListener('blur', onBlur)
      window.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onMUp); window.removeEventListener('auxclick', block)
    }
  }, [])
}
