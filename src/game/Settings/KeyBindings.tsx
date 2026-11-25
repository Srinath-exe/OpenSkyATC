'use client'
/*
  Settings > Keys: every shell shortcut, the talk key first. Click a key, press the new one (any key or chord, or a
  mouse side / middle button); Esc cancels. A key already in use swaps over to the other action.
*/
import * as React from 'react'
import { ListRow, Button, Kbd } from '@/design'
import { BINDINGS, BIND, RESERVED, bindChord, mouseChord, setBinding, resetBinding, resetAllBindings, useBindings, keyParts, type BindId } from '../keybindings'
import s from './KeyBindings.module.css'
import t from './SettingsTabs.module.css'

/** The key button: shows the chord; click and press a key to rebind. */
export function KeyCapture({ id, compact }: { id: BindId; compact?: boolean }) {
  const keys = useBindings()
  const [listening, setListening] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)
  const btn = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (!listening) return
    const done = (chord: string | null) => {
      setListening(false)
      if (!chord) return
      const r = setBinding(id, chord)
      setMsg(r.ok ? (r.swapped ? `${chord} was ${BIND[r.swapped].label.toLowerCase()}: that now uses ${keys[id] || 'no key'}` : null) : r.reason)
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation()
      if (e.type !== 'keydown' || e.repeat) return
      if (e.key === 'Escape') { done(null); return }
      const c = bindChord(e)
      if (c) done(c)
    }
    const onMouse = (e: MouseEvent) => {
      const c = mouseChord(e)
      if (!c) { if (e.target !== btn.current) done(null); return }   // a left click elsewhere cancels
      e.preventDefault(); e.stopImmediatePropagation(); done(c)
    }
    const block = (e: MouseEvent) => { if (mouseChord(e)) e.preventDefault() }   // no browser back / forward on side buttons
    window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKey, true)
    window.addEventListener('mousedown', onMouse, true); window.addEventListener('mouseup', block, true); window.addEventListener('auxclick', block, true)
    return () => {
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('mousedown', onMouse, true); window.removeEventListener('mouseup', block, true); window.removeEventListener('auxclick', block, true)
    }
  }, [listening, id, keys])
  const k = keys[id]
  return (
    <span className={s.cap} data-compact={compact || undefined}>
      <button ref={btn} type="button" className={s.key} data-listening={listening || undefined} aria-label={`${BIND[id].label}: ${k || 'not set'}. Click to change`}
        onClick={() => { setMsg(null); setListening((v) => !v) }} data-testid={`key-${id}`} data-hotkeys="off">
        {listening ? <span className={s.press}>Press a key…</span> : k ? <Kbd keys={keyParts(k)} /> : <span className={s.none}>Not set</span>}
      </button>
      {k !== BIND[id].def && !listening ? <button type="button" className={s.reset} onClick={() => { resetBinding(id); setMsg(null) }} title={`Back to ${BIND[id].def}`} data-testid={`key-reset-${id}`}>Reset</button> : null}
      {msg ? <span className={s.msg} role="status">{msg}</span> : null}
    </span>
  )
}

const GROUPS = ['Radio', 'Calls', 'Seat', 'Time', 'Panels', 'Map'] as const
const HINT: Record<(typeof GROUPS)[number], string> = {
  Radio: 'Hold to talk. Any key, a chord like Ctrl+Space, or a mouse side button.',
  Calls: 'The call field and undo',
  Seat: 'Switch between Tower and Approach',
  Time: 'Pause and sim speed',
  Panels: 'Open and close panels',
  Map: 'Camera',
}

export function KeyBindings({ Group }: { Group: (p: { title: string; hint?: string; children: React.ReactNode; span?: boolean; testId?: string }) => React.ReactElement }) {
  const keys = useBindings()
  const changed = BINDINGS.some((b) => keys[b.id] !== b.def)
  return (
    <>
      {GROUPS.map((g) => (
        <Group key={g} title={g} hint={HINT[g]} testId={`keys-${g.toLowerCase()}`}>
          {BINDINGS.filter((b) => b.group === g).map((b) => (
            <ListRow key={b.id} flush title={b.label} subtitle={b.def !== keys[b.id] ? `Default ${b.def}` : undefined} trailing={<KeyCapture id={b.id} />} />
          ))}
        </Group>
      ))}
      <div className={t.right}>
        <span className={t.note} style={{ marginRight: 'auto' }}>Fixed: {[...RESERVED].slice(0, 6).join(', ')}. Click a key, then press the new one; Esc cancels.</span>
        <Button variant="ghost" size="sm" disabled={!changed} onClick={resetAllBindings} testId="keys-reset-all">Reset all keys</Button>
      </div>
    </>
  )
}
