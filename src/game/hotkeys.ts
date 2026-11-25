/* Single hotkey table (UX 04 G6): the dispatcher, the help tab and the tooltips all read from here so they cannot drift.
   The shell keys come from keybindings.ts (the player can rebind them in Settings > Keys). */
import { ACTION_DEFS, type ActionId } from '@/lib/sim/commandTree'
import { BINDINGS, chordIsModded, currentBindings, type BindId, type Binding } from './keybindings'

export type HotkeyRegion = 'global' | 'bay' | 'panel' | 'map' | 'log'

export interface Hotkey {
  /** Display form ("F1", "Space", "Shift+/", "M,A"). */
  key: string
  region: HotkeyRegion
  action: string
  when: string
  /** Stable id for testids (`help-hotkey-row-{id}`). */
  id: string
}

/** Row ids kept from the fixed table (help-hotkey-row-{id} testids). */
const ROW_ID: Partial<Record<BindId, string>> = {
  ptt: 'space', 'ptt-alt': 'ctrl-space', tower: 'f1', approach: 'f2', 'pos-prev': 'bracket-left', 'pos-next': 'bracket-right',
  bay: 'f4', log: 'f8', atis: 'f9', vehicles: 'f10', cmd: 'slash', 'cmd-alt': 'ctrl-k', 'last-callsign': 'shift-r',
  'undo-alt': 'ctrl-z', centre: 'alt-f',
}
const ACTION_TEXT: Partial<Record<BindId, string>> = {
  ptt: 'Speech to text (hold and talk)', 'ptt-alt': 'Speech to text (hold), also while typing',
}
const REGION_OF: Record<Binding['group'], HotkeyRegion> = { Radio: 'global', Seat: 'global', Panels: 'global', Time: 'global', Calls: 'log', Map: 'map' }

/** The shell's keys with the player's current bindings (Settings > Keys), then the fixed ones. */
export function shellHotkeys(keys: Record<BindId, string> = currentBindings()): Hotkey[] {
  const bound = BINDINGS.filter((b) => keys[b.id]).map<Hotkey>((b) => ({
    id: ROW_ID[b.id] ?? b.id, key: keys[b.id], region: REGION_OF[b.group], action: ACTION_TEXT[b.id] ?? b.label,
    when: b.typing && chordIsModded(keys[b.id]) ? 'Always' : 'Not typing in a text field',
  }))
  return [...bound,
    { id: 'esc', key: 'Esc', region: 'global', action: 'Blur input → close overlay → deselect → pause menu', when: 'Always' },
    { id: 'tab', key: 'Tab', region: 'bay', action: 'Next strip (alerts → requests → bay order)', when: 'No picker focused' },
    { id: 'shift-tab', key: 'Shift+Tab', region: 'bay', action: 'Previous strip', when: 'No picker focused' },
    { id: 'enter-req', key: 'Enter', region: 'panel', action: 'Open the highlighted answer to a pending request', when: 'Aircraft with a request selected' },
  ]
}
/** The default table (no player bindings). */
export const SHELL_HOTKEYS: readonly Hotkey[] = shellHotkeys(Object.fromEntries(BINDINGS.map((b) => [b.id, b.def])) as Record<BindId, string>)

/** Action letters from the command tree (UX 1.3 / G2), rendered in the help tab after the shell keys. */
export function actionHotkeys(): Hotkey[] {
  const rows: Hotkey[] = []
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    const def = ACTION_DEFS[id]
    if (!def.key) continue
    rows.push({ id, key: def.key, region: 'panel', action: def.label, when: `Aircraft selected · ${def.group}` })
  }
  return rows
}

export const ALL_HOTKEYS = (): Hotkey[] => [...shellHotkeys(), ...actionHotkeys()]
