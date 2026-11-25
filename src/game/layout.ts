'use client'
/* The game screen's layout: 'board' (the default: flight board, flight card, floating bars) or 'classic' (the strip
   bay, the command panel with its instruction buttons, the full top bar). Classic stays for the browser tests written
   against it and for players who want the buttons; set with localStorage skycontrol_layout = classic. */
import * as React from 'react'
export type Layout = 'board' | 'classic'
const KEY = 'skycontrol_layout'
// ?layout=board|classic wins; a test-mode session (?test=1, the browser tests) is classic unless it says otherwise
const read = (): Layout => {
  try {
    const q = new URLSearchParams(location.search), v = q.get('layout')
    if (v === 'classic' || v === 'board') return v
    if (q.get('test') === '1') return 'classic'
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'board'
  } catch { return 'board' }
}
export const getLayout = read
export function useLayout(): Layout {
  return React.useSyncExternalStore((cb) => { window.addEventListener('storage', cb); return () => window.removeEventListener('storage', cb) }, read, () => 'board')
}
