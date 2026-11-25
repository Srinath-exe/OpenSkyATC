/*
  What the airfield sounds like from where the camera is: pure bookkeeping (no audio), the twin of the phone's
  mobile/lib/src/audio/soundscape.dart - keep the two the same.

  Each aircraft has engines (idle whine, jet roar, a far-away rumble), its airframe in the air, its wheels on the ground,
  reverse thrust on the roll-out and the tug at pushback; its size picks the recordings, how loud they are and how far they
  carry. update() turns the traffic and the listener into the loops that should be playing and the one-shots to fire.
*/
import type { FlightPhase } from '../sim/types';

export interface Ear { x: number; y: number; bearing: number; pitch: number; distanceM: number }
export interface SoundAircraft { id: number; type: string; lengthM: number; x: number; y: number; altM: number; heading: number; knots: number; phase: FlightPhase | string; onGround: boolean; selected: boolean }
export interface LoopWant { sample: string; gain: number; speed: number; pan: number }
export interface Shot extends LoopWant {}

/** Mapbox: the camera sits 1.5 screen heights (in pixels at that zoom) from the point it looks at. */
export const cameraDistance = (zoom: number, lat: number, heightPx: number): number => 1.5 * heightPx * 40075016.7 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** zoom);

interface EngineClass { key: 'prop' | 's' | 'm' | 'h'; loud: number; carry: number; refLen: number }
const PROP: EngineClass = { key: 'prop', loud: 0.6, carry: 0.65, refLen: 27 }, SMALL: EngineClass = { key: 's', loud: 0.62, carry: 0.72, refLen: 31 }, MEDIUM: EngineClass = { key: 'm', loud: 0.8, carry: 1, refLen: 39 }, HEAVY: EngineClass = { key: 'h', loud: 1, carry: 1.35, refLen: 64 };
export function engineClass(type: string, lengthM: number): EngineClass {
  if (/^(AT4|AT7|DH8|C208|PC12|BE)/i.test(type)) return PROP;
  return lengthM < 36.6 ? SMALL : lengthM < 50 ? MEDIUM : HEAVY;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** What an engine is asked for, 0..1. */
export function thrustFor(a: SoundAircraft, prevKt: number): number {
  switch (a.phase) {
    case 'parked': case 'arrived': return 0;
    case 'startup': return 0.13;
    case 'pushback': return 0.14;
    case 'taxi': return a.knots > 1 && a.knots < 9 && a.knots > prevKt ? 0.34 : 0.18;   // breaking away takes a push
    case 'hold_short': case 'lineup': return 0.15;
    case 'takeoff': case 'go_around': return 1;
    case 'climb': return a.altM < 900 ? 0.9 : 0.75;
    case 'descent': case 'cruise': return 0.3;
    case 'approach': return 0.42;
    case 'landing': return a.onGround ? 0.16 : 0.34;
    case 'rollout': return 0.16;
    default: return a.onGround ? 0.15 : 0.35;
  }
}

const FLOOR = 0.006, MAX_LOOPS = 20;
export class Soundscape {
  private ac = new Map<number, { thrust: number; ground: boolean | null; phase: string; kt: number }>();
  private t = -1;
  reset(): void { this.ac.clear(); this.t = -1; }

  update(time: number, list: SoundAircraft[], ear: Ear, dt: number, paused = false): { loops: Map<string, LoopWant>; shots: Shot[] } {
    const shots: Shot[] = [], all: [number, string, LoopWant][] = [], seen = new Set<number>();
    if (time < this.t - 1) this.reset();   // a new shift
    this.t = time;
    // the ear sits a quarter of the way back along the view: close enough to hear what the picture shows
    const d0 = ear.distanceM * 0.25, pr = ear.pitch * Math.PI / 180, br = ear.bearing * Math.PI / 180;
    const up = d0 * Math.cos(pr), back = d0 * Math.sin(pr), ex = -Math.sin(br) * back, ey = -Math.cos(br) * back;
    for (const a of list) {
      seen.add(a.id);
      let s = this.ac.get(a.id); const fresh = !s;
      if (!s) { s = { thrust: 0, ground: null, phase: '', kt: 0 }; this.ac.set(a.id, s); }
      const c = engineClass(a.type, a.lengthM), huge = c === HEAVY && /^(A38|B74)/.test(a.type);
      const loud = c.loud * (huge ? 1.12 : 1) * (a.selected ? 1.2 : 1), carry = c.carry * (huge ? 1.2 : 1);
      const want = thrustFor(a, s.kt);
      if (fresh) s.thrust = want;
      s.thrust += (want - s.thrust) * (1 - Math.exp(-dt / (want > s.thrust ? 1.3 : 2)));   // engines spool
      const dx = a.x - ear.x - ex, dy = a.y - ear.y - ey, dz = a.altM - up, flat = Math.hypot(dx, dy), d = Math.max(8, Math.hypot(flat, dz));
      const pan = clamp(Math.sin(Math.atan2(dx, dy) - br) * flat / d * 0.8, -0.8, 0.8);
      const near = (ref: number) => 1 / (1 + (d / (ref * carry)) ** 1.5);
      const hr = a.heading * Math.PI / 180, v = a.knots * 0.514, closing = -(Math.sin(hr) * v * dx + Math.cos(hr) * v * dy) / d;
      const dop = clamp(340 / (340 - clamp(closing, -60, 60)), 0.85, 1.18);
      const size = clamp((c.refLen / Math.max(12, a.lengthM)) ** 0.35, 0.8, 1.2) * (huge ? 0.92 : 1), own = 1 + ((a.id * 37) % 11 - 5) * 0.004;
      if (!fresh && !paused) {
        if (s.ground === false && a.onGround && a.knots > 50) shots.push({ sample: `touch_${c === PROP ? 's' : c.key}`, gain: clamp(near(420) * loud * 1.25, 0, 1), speed: size * own, pan });
        if (s.phase === 'parked' && a.phase === 'startup' && c !== PROP) shots.push({ sample: 'spool_up', gain: near(150) * loud * 0.8, speed: size * own, pan });
        if (s.phase !== a.phase && (a.phase === 'arrived' || a.phase === 'parked') && c !== PROP) shots.push({ sample: 'spool_down', gain: near(150) * loud * 0.8, speed: size * own, pan });
      }
      const add = (layer: string, sample: string, gain: number, speed: number) => { const g = paused ? 0 : gain * loud; if (g > FLOOR) all.push([g, `${a.id}:${layer}`, { sample, gain: clamp(g, 0, 1), speed: clamp(speed * own * dop, 0.5, 1.8), pan }]); };
      const th = s.thrust;
      if (th > 0.02) {
        if (c === PROP) {
          const p = clamp(th, 0, 1);
          add('idle', 'prop_idle', near(150) * 0.75 * (1 - p * 0.7), size * (0.95 + 0.15 * p)); add('roar', 'prop_power', near(620) * 0.95 * p ** 1.1, size * (0.9 + 0.15 * p));
        } else {
          add('idle', `idle_${c.key}`, near(150) * 0.72 * Math.min(1, th / 0.15) * (1 - th * 0.45), size * (0.88 + 0.55 * th)); add('roar', `roar_${c.key}`, near(760) * 1.05 * th ** 1.5, size * (0.82 + 0.26 * th));
        }
        add('rumble', 'rumble', near(1500) * 0.6 * (d / (d + 1400)) * th ** 1.2, size * (0.9 + 0.1 * th));   // only the low end arrives from far away
      }
      if (!a.onGround) add('air', 'air', near(380) * 0.42 * clamp(a.knots / 160, 0, 1.3) ** 2, 0.9 + 0.2 * clamp(a.knots / 200, 0, 1.2));
      else if (a.knots > 3 && a.phase !== 'pushback') add('roll', 'roll', near(130) * 0.5 * Math.min(1, a.knots / 40), 0.75 + a.knots / 160);
      if (a.onGround && (a.phase === 'rollout' || a.phase === 'landing') && a.knots > 55) add('rev', c === PROP ? 'prop_power' : `rev_${c.key}`, near(700) * 0.95 * clamp((a.knots - 55) / 55, 0, 1), size);
      if (a.phase === 'pushback') add('tug', 'tug', near(110) * 0.55 / loud, 1);
      if (a.phase === 'parked' || a.phase === 'startup') add('apu', 'apu', near(75) * 0.35, size);
      s.ground = a.onGround; s.phase = a.phase; s.kt = a.knots;
    }
    for (const id of this.ac.keys()) if (!seen.has(id)) this.ac.delete(id);
    all.sort((p, q) => q[0] - p[0]);
    return { loops: new Map(all.slice(0, MAX_LOOPS).map(([, k, w]) => [k, w])), shots };
  }
}
