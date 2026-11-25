// Stand-in for src/components/atc/WorldMap/tutor.ts in the phone core: the tutorial's map cues (camera, lit routes,
// marks) are queued here; core/course.ts hands them to the app in lng/lat.
import type { Cue } from '../../src/game/Tutorial/lessons'

export const TUTOR_EVENT = 'atc:tutor'
export const cues: Cue[] = []
export const mapListening = () => true
export function markListening(_on: boolean): void { /* the app's map is always listening */ }
export function sendCue(c: Cue): void { cues.push(c) }
export const drainCues = (): Cue[] => cues.splice(0, cues.length)
