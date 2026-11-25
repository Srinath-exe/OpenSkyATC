/* The player's audio devices: which microphone push-to-talk records from and which output the game plays through
   (Settings > Voice & input). Kept in localStorage; a change is broadcast so open audio graphs switch at once:
   - mic: createMicCapture (asr-capture.ts) asks getUserMedia for this device; it reopens on a change
   - output: every AudioContext the game makes calls applySink (Chrome / Edge AudioContext.setSinkId; elsewhere the
     system default is used and the setting says so) */

const MIC_KEY = 'skycontrol_mic_device', OUT_KEY = 'skycontrol_out_device'
export const EV_AUDIO_DEVICES = 'skycontrol-audio-devices'

const read = (k: string) => { try { return localStorage.getItem(k) || '' } catch { return '' } }
const write = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* private mode */ } }

export const micDeviceId = () => read(MIC_KEY)
export const outDeviceId = () => read(OUT_KEY)
export function setMicDevice(id: string) { write(MIC_KEY, id); window.dispatchEvent(new Event(EV_AUDIO_DEVICES)) }
export function setOutDevice(id: string) { write(OUT_KEY, id); window.dispatchEvent(new Event(EV_AUDIO_DEVICES)) }

/** getUserMedia audio constraints with the chosen microphone (falls back to any mic if that one is gone). */
export function micConstraints(base: MediaTrackConstraints | true): MediaTrackConstraints | true {
  const id = micDeviceId(); if (!id) return base
  return { ...(base === true ? {} : base), deviceId: { ideal: id } }
}

type SinkCtx = AudioContext & { setSinkId?: (id: string | { type: 'none' }) => Promise<void> }
export const canPickOutput = () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
/** Route an AudioContext to the chosen output, now and whenever the choice changes. */
export function applySink(ctx: AudioContext): void {
  const c = ctx as SinkCtx; if (!c.setSinkId) return
  // only when a device was chosen (or to go back to the default after one was): an untouched context stays as the
  // browser made it
  let routed = false
  const go = () => { const id = outDeviceId(); if (!id && !routed) return; routed = !!id; void c.setSinkId!(id || '').catch(() => { /* device gone: stays on the current one */ }) }
  go(); window.addEventListener(EV_AUDIO_DEVICES, go)
}

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unsupported'
export async function micPermission(): Promise<MicPermission> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported'
  try { const s = await navigator.permissions.query({ name: 'microphone' as PermissionName }); return s.state as MicPermission } catch { return 'prompt' }
}
/** Ask for the microphone (the browser's prompt); true when allowed. */
export async function askMic(): Promise<boolean> {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(true) }); s.getTracks().forEach((t) => t.stop()); return true } catch { return false }
}
export async function listDevices(): Promise<{ mics: MediaDeviceInfo[]; outs: MediaDeviceInfo[] }> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return { mics: all.filter((d) => d.kind === 'audioinput'), outs: all.filter((d) => d.kind === 'audiooutput') }
  } catch { return { mics: [], outs: [] } }
}
