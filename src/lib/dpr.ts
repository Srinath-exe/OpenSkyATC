/** The screen's own pixel ratio. */
export const screenDpr = (): number => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
