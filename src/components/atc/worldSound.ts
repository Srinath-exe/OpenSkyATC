/*
  The game's sounds from files (public/sounds, built by mobile/tool/sound): the airfield as heard from the camera
  (lib/audio/soundscape.ts), the place (the field at night, the radar room), and the interface's clicks. Plays into the
  sound engine's own output (sound.ts), so the Sound switch, the Volume slider and the chosen speaker apply.

  Everything here falls silent while the player transmits (the speaker would reach the microphone and the recogniser), and
  the airfield steps back while a pilot or the narrator speaks.
*/
import { Soundscape, type Ear, type LoopWant, type SoundAircraft } from '@/lib/audio/soundscape';
import { radioBusy } from './pilotVoice';
import { sound } from './sound';

const LS_KEY = 'skycontrol_world_volume';
const FT = 0.3048;
type Voice = { src: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode | null; sample: string };
interface Source { time: number; paused: boolean; aircraft: SoundAircraft[]; scope: boolean }

class WorldSound {
  /** 0..1: the airfield's share (Settings > Audio). */
  volume = 0.8;
  /** Where the camera listens from (the map keeps it current). */
  ear: Ear | null = null;
  private scape = new Soundscape();
  private bufs = new Map<string, Promise<AudioBuffer | null>>(); private ready = new Map<string, AudioBuffer>();
  private voices = new Map<string, Voice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private get: (() => Source | null) | null = null;
  private out: GainNode | null = null;
  private lastUi = 0; private lastCue = new Map<string, number>();

  constructor() { try { const v = Number(localStorage.getItem(LS_KEY)); if (localStorage.getItem(LS_KEY) != null && Number.isFinite(v)) this.volume = Math.max(0, Math.min(1, v)); } catch { /* no storage */ } }
  setVolume(v: number): void { this.volume = Math.max(0, Math.min(1, v)); try { localStorage.setItem(LS_KEY, String(this.volume)); } catch { /* */ } }

  /** The game is on screen: hear it ten times a second. */
  start(get: () => Source | null): () => void {
    this.get = get; this.scape.reset();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
    return () => { if (this.get !== get) return; this.get = null; if (this.timer) { clearInterval(this.timer); this.timer = null; } for (const k of [...this.voices.keys()]) this.drop(k, 0.3); };
  }

  // ── files ──
  private ctx(): AudioContext | null { const o = sound.output(); if (!o) return null; if (!this.out || this.out.context !== o.ctx) { this.out = o.ctx.createGain(); this.out.connect(o.out); } return o.ctx; }
  private load(name: string): Promise<AudioBuffer | null> {
    let p = this.bufs.get(name);
    if (!p) {
      p = fetch(`/sounds/${name}.flac`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); }).then((b) => this.ctx()!.decodeAudioData(b)).then((b) => { this.ready.set(name, b); return b; }).catch(() => null);
      this.bufs.set(name, p);
    }
    return p;
  }

  // ── the interface ──
  /** A cue from a file; false while it has not loaded (the caller's own tone plays instead). */
  ui(name: string, gain = 1): boolean {
    const ctx = this.ctx(); if (!ctx || ctx.state !== 'running' || !sound.enabled) return false;
    const now = performance.now(), b = this.ready.get(name);
    if (!b) { void this.load(name); return false; }
    const gap = name.startsWith('alert') || name === 'emergency' ? 400 : 70;
    if (now - (this.lastCue.get(name) ?? -1e9) < gap) return true;
    this.lastCue.set(name, now); this.lastUi = now;
    if (radioBusy() && !name.startsWith('alert') && name !== 'emergency') return true;   // nothing over the player's own voice
    this.once(ctx, b, gain, 1, 0); return true;
  }
  noteCue(): void { this.lastUi = performance.now(); }
  /** A button with no sound of its own: the click, unless the press already made one. */
  tapAfter(pressed: number): void { if (this.lastUi < pressed) this.ui('tap'); }
  private once(ctx: AudioContext, b: AudioBuffer, gain: number, speed: number, pan: number): void {
    const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = speed;
    const g = ctx.createGain(); g.gain.value = gain; s.connect(g);
    let n: AudioNode = g; if (ctx.createStereoPanner && pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); n = p; }
    n.connect(this.out!); s.start(); s.onended = () => { s.disconnect(); g.disconnect(); if (n !== g) n.disconnect(); };
  }

  // ── the world ──
  private tick(): void {
    const src = this.get?.() ?? null, ctx = sound.enabled ? this.ctx() : null;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!ctx || ctx.state !== 'running' || !src) { for (const k of [...this.voices.keys()]) this.drop(k, 0.2); return; }
    const k = hidden || radioBusy() ? 0 : this.volume * 1.35 * (sound.radioBusy ? 0.38 : 1);
    const want = new Map<string, LoopWant>();
    const ear = this.ear;
    const s = ear ? this.scape.update(src.time, src.aircraft, ear, 0.1, src.paused) : null;   // kept going on the scope: nothing fires late on the way back
    if (k > 0) {
      let busy = 0;
      if (s && !src.scope) { for (const [key, w] of s.loops) { want.set(key, { ...w, gain: w.gain * k }); busy += w.gain; } for (const x of s.shots) { const b = this.ready.get(x.sample); if (b) this.once(ctx, b, x.gain * k, x.speed, x.pan); } }
      want.set('bed', src.scope ? { sample: 'amb_scope', gain: 0.3 * k, speed: 1, pan: 0 } : { sample: 'amb_field', gain: 0.46 * (1 - 0.4 * Math.min(1, busy)) * k, speed: 1, pan: 0 });
    }
    for (const key of [...this.voices.keys()]) if (!want.has(key) || want.get(key)!.sample !== this.voices.get(key)!.sample) this.drop(key, k === 0 ? 0.03 : 0.25);
    for (const [key, w] of want) this.tune(ctx, key, w);
    if (s) for (const n of ['touch_s', 'touch_m', 'touch_h', 'spool_up', 'spool_down']) void this.load(n);
  }
  private tune(ctx: AudioContext, key: string, w: LoopWant): void {
    let v = this.voices.get(key); const t = ctx.currentTime;
    if (!v) {
      const b = this.ready.get(w.sample); if (!b) { void this.load(w.sample); return; }
      const src = ctx.createBufferSource(); src.buffer = b; src.loop = true; src.playbackRate.value = w.speed;
      const gain = ctx.createGain(); gain.gain.value = 0; src.connect(gain);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (pan) { pan.pan.value = w.pan; gain.connect(pan); pan.connect(this.out!); } else gain.connect(this.out!);
      src.start(t, Math.random() * b.duration);
      v = { src, gain, pan, sample: w.sample }; this.voices.set(key, v);
    }
    v.gain.gain.setTargetAtTime(w.gain, t, 0.08); v.src.playbackRate.setTargetAtTime(w.speed, t, 0.1); v.pan?.pan.setTargetAtTime(w.pan, t, 0.1);
  }
  private drop(key: string, tau: number): void {
    const v = this.voices.get(key); if (!v) return; this.voices.delete(key);
    const ctx = v.src.context as AudioContext, t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t); v.gain.gain.setTargetAtTime(0, t, tau / 3); v.src.stop(t + tau + 0.1);
    v.src.onended = () => { v.src.disconnect(); v.gain.disconnect(); v.pan?.disconnect(); };
  }
  /** Diagnostics: the loops playing now. */
  get playing(): string[] { return [...this.voices.values()].map((v) => v.sample); }
}

export const worldSound = new WorldSound();
// the sound engine's cues (sound.ts) from files, its own tones until they have loaded
sound.file = (cue) => { const n = cue === 'tick' ? 'key' : cue.replace('-', '_'); const ok = worldSound.ui(n); if (!ok) worldSound.noteCue(); return ok; };

/** The engine's aircraft as the mixer wants them. */
export function soundAircraft(list: { id: number; perf: { icaoCode: string; lengthMeters: number }; pos: { x: number; y: number }; altitude: number; heading: number; speed: number; phase: string }[], selectedId: number | null): SoundAircraft[] {
  return list.filter((a) => a.phase !== 'departed').map((a) => ({ id: a.id, type: a.perf.icaoCode, lengthM: a.perf.lengthMeters, x: a.pos.x, y: a.pos.y, altM: Math.max(0, a.altitude) * FT, heading: a.heading, knots: a.speed ?? 0, phase: a.phase, onGround: a.altitude < 5, selected: a.id === selectedId }));
}

/** Every button clicks: a press on something tappable plays the tap, unless what it did made a sound of its own. */
export function installTapSounds(): () => void {
  let pressed = 0;
  const down = () => { pressed = performance.now(); };
  const click = (ev: Event) => {
    const el = (ev.target as Element | null)?.closest?.('button, a[href], summary, select, label, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], input[type="checkbox"], input[type="radio"], input[type="range"]');
    if (!el || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
    const at = pressed || performance.now() - 5; window.setTimeout(() => worldSound.tapAfter(at), 30);
  };
  const key = (ev: KeyboardEvent) => { const t = ev.target as HTMLElement | null; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) worldSound.ui('key', 0.8); };
  document.addEventListener('pointerdown', down, true); document.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
  return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); };
}
