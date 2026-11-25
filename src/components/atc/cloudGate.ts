/*
  The cloud passage between the airport and the radar: what the two views and the shell share.
  Zooming out of the airport past its limit (or into the airport on the radar) pushes into the clouds: `push` adds to the
  pressure, clouds gather as it builds, it drains when the player stops, and at 1 the view changes sides.
  Kept free of WebGL and of the map so either view can import it.
*/
export type CloudDir = 'out' | 'in'                       // out: airport -> radar, in: radar -> airport
export type CloudLight = 'day' | 'dawn' | 'dusk' | 'night'

export const cloudGate = {
  /** Built-up push, 0..1, and which way. */
  pressure: 0, dir: 'out' as CloudDir,
  /** The light outside, so the clouds match the map. */
  light: 'day' as CloudLight,
  /** A passage is running: pushes are ignored. */
  busy: false,
  /** The shell's: may the view change now, and change it. */
  pass: null as ((dir: CloudDir) => boolean) | null,
  last: 0, wake: null as (() => void) | null,
  push(dir: CloudDir, amount: number): void {
    if (this.busy || !this.pass || !(amount > 0)) return
    if (dir !== this.dir) { this.dir = dir; this.pressure = 0 }
    this.pressure = Math.min(1, this.pressure + amount); this.last = performance.now(); this.wake?.()
    if (this.pressure >= 1) { if (!this.pass(dir)) this.pressure = 0.99 }
  },
  /** One frame: drains a moment after the last push. */
  drain(now: number, dt: number): void { if (!this.busy && now - this.last > 220) this.pressure = Math.max(0, this.pressure - dt * 0.9) },
}
/** A wheel event's push: about a second of steady scrolling, the same on a notched wheel and a trackpad. */
export function wheelPush(ev: WheelEvent): number { const px = Math.abs(ev.deltaY) * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1); return Math.min(0.2, px / 900) }
