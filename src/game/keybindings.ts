'use client'
/*
  Key bindings: every shell shortcut (the talk key first) can be set to any key or chord in Settings > Keys.
  Stored per device as overrides of the defaults; the dispatcher (useShellHotkeys), the help table and the on-screen
  hints all read the current binding from here. Esc, Tab, Enter and the page keys stay fixed.
  Chords are written "Ctrl+Shift+K", "F1", "Space", "[" - from the physical key (e.code), so they do not shift with
  the layout's glyphs.
*/
import * as React from 'react'

export type BindId =
  | 'ptt' | 'ptt-alt' | 'tower' | 'approach' | 'pos-prev' | 'pos-next' | 'log' | 'atis' | 'vehicles' | 'bay'
  | 'pause' | 'rate-1' | 'rate-2' | 'rate-4' | 'rate-down' | 'rate-up' | 'cmd' | 'cmd-alt' | 'last-callsign'
  | 'undo' | 'undo-alt' | 'help' | 'centre'

export interface Binding {
  id: BindId
  label: string
  group: 'Radio' | 'Seat' | 'Panels' | 'Time' | 'Calls' | 'Map'
  def: string
  /** Also fires while typing in a text field (only when the chord has Ctrl / Alt or is an F key). */
  typing?: boolean
  /** Also fires with a picker / slider focused. */
  picker?: boolean
  /** Not while a button or link has focus (Space / Enter / letters belong to it). */
  notOnButtons?: boolean
}

export const BINDINGS: readonly Binding[] = [
  { id: 'ptt', label: 'Talk (hold and speak)', group: 'Radio', def: 'Space', picker: true },
  { id: 'ptt-alt', label: 'Talk, also while typing', group: 'Radio', def: 'Ctrl+Space', typing: true, picker: true },
  { id: 'cmd', label: 'Focus the call field', group: 'Calls', def: '/' },
  { id: 'cmd-alt', label: 'Focus the call field (anywhere)', group: 'Calls', def: 'Ctrl+K', typing: true, picker: true },
  { id: 'last-callsign', label: 'Call the last plane again', group: 'Calls', def: 'Shift+R' },
  { id: 'undo', label: 'Undo the last call', group: 'Calls', def: 'U' },
  { id: 'undo-alt', label: 'Undo the last call (alt)', group: 'Calls', def: 'Ctrl+Z', picker: true },
  { id: 'tower', label: 'Tower seat', group: 'Seat', def: 'F1', typing: true, picker: true },
  { id: 'approach', label: 'Approach seat', group: 'Seat', def: 'F2', typing: true, picker: true },
  { id: 'pos-prev', label: 'Previous seat', group: 'Seat', def: '[' },
  { id: 'pos-next', label: 'Next seat', group: 'Seat', def: ']' },
  { id: 'pause', label: 'Pause / resume', group: 'Time', def: 'P', notOnButtons: true },
  { id: 'rate-1', label: 'Speed 1×', group: 'Time', def: '1' },
  { id: 'rate-2', label: 'Speed 2×', group: 'Time', def: '2' },
  { id: 'rate-4', label: 'Speed 4×', group: 'Time', def: '4' },
  { id: 'rate-down', label: 'Slower', group: 'Time', def: ',' },
  { id: 'rate-up', label: 'Faster', group: 'Time', def: '.' },
  { id: 'log', label: 'Radio log', group: 'Panels', def: 'F8', typing: true, picker: true },
  { id: 'atis', label: 'ATIS / weather', group: 'Panels', def: 'F9', typing: true, picker: true },
  { id: 'vehicles', label: 'Vehicles', group: 'Panels', def: 'F10', typing: true, picker: true },
  { id: 'bay', label: 'Strip bay (classic layout)', group: 'Panels', def: 'F4', typing: true, picker: true },
  { id: 'help', label: 'Help', group: 'Panels', def: 'Shift+/' },
  { id: 'centre', label: 'Centre on the selected plane', group: 'Map', def: 'Alt+F' },
]
export const BIND: Record<BindId, Binding> = Object.fromEntries(BINDINGS.map((b) => [b.id, b])) as Record<BindId, Binding>

/** Keys that keep their job and cannot be bound: Esc, Tab, Enter, the page keys, and the browser's own (F5, F11, F12). */
export const RESERVED = new Set(['Escape', 'Tab', 'Shift+Tab', 'Enter', 'PageUp', 'PageDown', 'F5', 'F11', 'F12', 'Ctrl+R', 'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+L', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A'])
const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

const CODE_GLYPH: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Backquote: '`', Comma: ',', Period: '.', Slash: '/', Space: 'Space', IntlBackslash: '\\',
}

/** The key itself, without modifiers ("K", "1", "[", "F1", "Space", "ArrowUp", "Num5"). */
export function baseKey(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  const c = e.code || ''
  let m: RegExpExecArray | null
  if ((m = /^Key([A-Z])$/.exec(c))) return m[1]
  if ((m = /^Digit(\d)$/.exec(c))) return m[1]
  if ((m = /^Numpad(\d)$/.exec(c))) return `Num${m[1]}`
  if (CODE_GLYPH[c]) return CODE_GLYPH[c]
  if (e.key === ' ') return 'Space'
  if (e.key.length === 1) return e.key.toUpperCase()
  return e.key
}

export const isModifierKey = (e: Pick<KeyboardEvent, 'key'>) => MODS.has(e.key)

/** The chord a key press makes, in binding form ("Ctrl+Shift+K"). Null for a lone modifier. */
export function bindChord(e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (MODS.has(e.key)) return null
  const p: string[] = []
  if (e.ctrlKey || e.metaKey) p.push('Ctrl')
  if (e.altKey) p.push('Alt')
  if (e.shiftKey) p.push('Shift')
  p.push(baseKey(e))
  return p.join('+')
}

/** A mouse button as a chord: middle (Mouse3) and the side buttons (Mouse4, Mouse5). Left and right stay the map's. */
export function mouseChord(e: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  const b = ({ 1: 'Mouse3', 3: 'Mouse4', 4: 'Mouse5' } as Record<number, string>)[e.button]
  if (!b) return null
  const p: string[] = []
  if (e.ctrlKey || e.metaKey) p.push('Ctrl')
  if (e.altKey) p.push('Alt')
  if (e.shiftKey) p.push('Shift')
  p.push(b)
  return p.join('+')
}

/** Whether a chord is safe to fire while the player types (needs Ctrl / Alt, or is an F key). */
export const chordIsModded = (c: string) => /^(Ctrl|Alt)\+/.test(c) || /^F\d{1,2}$/.test(c)

// ── store ──
const KEY = 'skycontrol_keys_v1'
const EV = 'skycontrol:keys'
type Overrides = Partial<Record<BindId, string>>
let cache: Overrides | null = null
function read(): Overrides {
  if (cache) return cache
  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') as Overrides } catch { cache = {} }
  return cache!
}
function write(o: Overrides) {
  cache = o
  try { localStorage.setItem(KEY, JSON.stringify(o)) } catch { /* private mode: this session only */ }
  window.dispatchEvent(new Event(EV))
}

/** The current chord for an action ('' = unbound). */
export function keyFor(id: BindId): string {
  if (typeof window === 'undefined') return BIND[id].def
  const o = read()
  return o[id] ?? BIND[id].def
}

/** All current bindings, id -> chord. */
export function currentBindings(): Record<BindId, string> {
  return Object.fromEntries(BINDINGS.map((b) => [b.id, keyFor(b.id)])) as Record<BindId, string>
}

/** The action a chord is bound to now, if any. */
export function actionForChord(chord: string): BindId | null {
  for (const b of BINDINGS) if (keyFor(b.id) === chord) return b.id
  return null
}

export type SetResult = { ok: true; swapped?: BindId } | { ok: false; reason: string }

/** Bind an action to a chord. A chord already in use moves over: the other action takes this one's old key. */
export function setBinding(id: BindId, chord: string): SetResult {
  if (RESERVED.has(chord)) return { ok: false, reason: `${chord} is reserved` }
  const o = { ...read() }
  const old = keyFor(id)
  const other = BINDINGS.find((b) => b.id !== id && keyFor(b.id) === chord)?.id
  const put = (k: BindId, v: string) => { if (v === BIND[k].def) delete o[k]; else o[k] = v }
  put(id, chord)
  if (other) put(other, old)
  write(o)
  return { ok: true, swapped: other }
}
export function clearBinding(id: BindId) { const o = { ...read(), [id]: '' }; write(o) }
export function resetBinding(id: BindId) { const o = { ...read() }; delete o[id]; write(o) }
export function resetAllBindings() { write({}) }

/** Re-renders on any binding change; returns the chord for one action (or all, with no id). */
export function useKey(id: BindId): string {
  const sub = React.useCallback((cb: () => void) => {
    const on = () => { cache = null; cb() }
    window.addEventListener(EV, on); window.addEventListener('storage', on)
    return () => { window.removeEventListener(EV, on); window.removeEventListener('storage', on) }
  }, [])
  return React.useSyncExternalStore(sub, () => keyFor(id), () => BIND[id].def)
}
export function useBindings(): Record<BindId, string> {
  const sub = React.useCallback((cb: () => void) => {
    const on = () => { cache = null; cb() }
    window.addEventListener(EV, on); window.addEventListener('storage', on)
    return () => { window.removeEventListener(EV, on); window.removeEventListener('storage', on) }
  }, [])
  const snap = React.useSyncExternalStore(sub, () => JSON.stringify(read()), () => '{}')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => currentBindings(), [snap])
}

/** Human form of a chord ("Space", "Ctrl + K", "Shift + /"); "Not set" when empty. */
export const keyLabel = (c: string) => (c ? c.split('+').join(' + ') : 'Not set')
/** The parts of a chord, for <Kbd keys>. */
export const keyParts = (c: string) => (c ? c.split('+') : [])
