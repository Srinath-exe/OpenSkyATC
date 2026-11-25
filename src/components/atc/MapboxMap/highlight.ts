/* The selected aircraft's highlight style (the traffic layer draws it; the ⋯ menu picks it). Kept apart from layers.ts
   so the top bar does not pull three.js in. */
// ── the selected aircraft's highlight: five styles to choose from (the ⋯ menu), drawn in the traffic layer so it moves
// with the aircraft every frame (the old ring was a map layer updated four times a second and lagged behind) ──
export type HighlightStyle = 'lit' | 'none' | 'ring' | 'glow' | 'brackets' | 'pin' | 'tint'
export const HIGHLIGHT_STYLES: Array<{ id: HighlightStyle; label: string }> = [{ id: 'lit', label: 'Lit' }, { id: 'none', label: 'None' }, { id: 'ring', label: 'Ring' }, { id: 'glow', label: 'Glow' }, { id: 'brackets', label: 'Brackets' }, { id: 'pin', label: 'Pin' }, { id: 'tint', label: 'Tint' }]
const HL_KEY = 'skycontrol_highlight_v3'   // (v3: the default is lit - the aircraft in its own daylight, nothing drawn on it)
let hlStyle: HighlightStyle = (() => { try { const v = localStorage.getItem(HL_KEY) as HighlightStyle | null; return v && HIGHLIGHT_STYLES.some((x) => x.id === v) ? v : 'lit' } catch { return 'lit' } })()
export const getHighlightStyle = (): HighlightStyle => hlStyle
export function setHighlightStyle(v: HighlightStyle): void { hlStyle = v; try { localStorage.setItem(HL_KEY, v) } catch { /* */ } if (typeof window !== 'undefined') window.dispatchEvent(new Event('atc:highlight')) }

