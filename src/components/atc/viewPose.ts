/*
  Where an aircraft is DRAWN. The simulation moves in fixed steps (30 a second) and the screen does not, so a position read
  straight from it goes forward two steps in one frame and none in the next. Here it runs on at its own speed for the
  part of a step that has not been taken yet. While the camera is locked on an aircraft, the camera and the aircraft must
  be drawn from one and the same position (`lock`), or it jumps back and forth by a step.
*/
import type { XY } from '@/lib/sim/projection'

interface Craft { id: number; pos: XY; altitude: number; heading: number }
interface Clock { time: number }
export interface Pose { x: number; y: number; alt: number; hdg: number }
interface Rec { t: number; x: number; y: number; alt: number; hdg: number; vx: number; vy: number; va: number; vh: number }

const recs = new WeakMap<object, Rec>()
let locked: { id: number; pose: Pose; at: number } | null = null

/** The camera's position for this frame: the aircraft is drawn exactly there. */
export function lockPose(id: number, pose: Pose): void { locked = { id, pose, at: performance.now() } }
export function unlockPose(): void { locked = null }

export function viewPose(e: Clock, a: Craft): Pose {
  if (locked && locked.id === a.id && performance.now() - locked.at < 250) return locked.pose
  return freshPose(e, a)
}
export function freshPose(e: Clock, a: Craft): Pose {
  let r = recs.get(a)
  if (!r) { r = { t: e.time, x: a.pos.x, y: a.pos.y, alt: a.altitude, hdg: a.heading, vx: 0, vy: 0, va: 0, vh: 0 }; recs.set(a, r) }
  else if (e.time !== r.t) {
    const dt = e.time - r.t, dx = a.pos.x - r.x, dy = a.pos.y - r.y
    if (dt > 0 && dt < 1 && Math.hypot(dx, dy) < 200 * dt + 2) {
      r.vx = dx / dt; r.vy = dy / dt; r.va = (a.altitude - r.alt) / dt; r.vh = (((a.heading - r.hdg + 540) % 360) - 180) / dt
    } else r.vx = r.vy = r.va = r.vh = 0   // it was moved, not driven
    r.t = e.time; r.x = a.pos.x; r.y = a.pos.y; r.alt = a.altitude; r.hdg = a.heading
  }
  const left = Math.max(0, Math.min(0.05, (e as unknown as { acc?: number }).acc ?? 0))
  return { x: r.x + r.vx * left, y: r.y + r.vy * left, alt: Math.max(0, r.alt + r.va * left), hdg: (r.hdg + r.vh * left + 360) % 360 }
}
