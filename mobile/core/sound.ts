/*
  Stand-in for src/components/atc/sound.ts in the phone core (the build aliases it): the store's sound calls are
  queued here and the app plays them natively (pilot voices through the phone's text-to-speech, cues as sounds).
*/
export interface SoundEvent { kind: 'speak' | 'cue' | 'alert' | 'stop'; text?: string; who?: string; callsign?: string; variant?: string; cue?: string; severity?: string }

export const queue: SoundEvent[] = []
export const drain = (): SoundEvent[] => queue.splice(0, queue.length)

const known = {
  speak(text: string, o: { who?: string; callsign?: string; variant?: string } = {}) { queue.push({ kind: 'speak', text, who: o.who, callsign: o.callsign, variant: o.variant }) },
  play(cue: string) { queue.push({ kind: 'cue', cue }) },
  alert(severity: string) { queue.push({ kind: 'alert', severity }) },
  stopSpeech() { queue.push({ kind: 'stop' }) },
}
// every other method of the web sound engine (volume, prefetch, unlock, ...) is a no-op here
export const sound: Record<string, (...a: unknown[]) => unknown> = new Proxy(known as Record<string, (...a: unknown[]) => unknown>, {
  get: (t, k: string) => t[k] ?? (() => undefined),
})
export type PilotVoicePref = 'neural' | 'browser'
export const pilotVoicePref = (): PilotVoicePref => 'browser'
