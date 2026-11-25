/*
  What the flight card says on Approach. Arrivals: the arrival plan (lib/sim/arrivals.ts: who lands after whom and when,
  speed before distance, a longer way round before a hold), one call at a time. Departures: up, clear of the arrivals, and
  on to the centre.
*/
import type { SimEngine } from '@/lib/sim/engine'
import type { AircraftState } from '@/lib/sim/types'
import { arrivalPlan, arrivalEnd, type ArrPlan } from '@/lib/sim/arrivals'
import type { NextCall } from './nextCall'

export { arrivalEnd }
const NM = 1852
const wrap = (d: number) => ((d % 360) + 540) % 360 - 180
const hdg3 = (h: number) => String(((Math.round(h / 10) * 10) % 360 + 360) % 360 || 360).padStart(3, '0')
const hdg5 = (h: number) => String(((Math.round(h / 5) * 5) % 360 + 360) % 360 || 360).padStart(3, '0')
const ord = (n: number) => (n === 1 ? 'next to land' : `number ${n}`)
const late = (p: ArrPlan) => { const s = Math.max(0, p.slack); return s < 20 ? '' : s < 90 ? ` About ${Math.round(s / 10) * 10} s to lose.` : ` About ${Math.round(s / 30) / 2} min to lose.` }

export function approachCall(e: SimEngine, a: AircraftState): NextCall {
  const cs = a.callsign, p = arrivalPlan(e, a)
  if (!p) return { wait: 'No runway assigned yet.' }
  // somebody in the way: that first
  const adv = e.airAdvice(a), mag = (t: number) => t - (e.magVar ?? 0)
  if (adv) return adv.cmd ? { cmd: adv.cmd, why: 'Traffic: it would pass too close to another one. Move it out of the way now.' } : { wait: 'Held clear of traffic. It goes on in a moment.' }
  const cur = a.cmdAltitude ?? a.targetAltitude, behind = p.lead ? ` behind ${p.lead.callsign}` : ''
  if (p.clear) return { cmd: `${cs} cleared ILS runway ${p.rwy} approach`, why: 'Pointed at the beam, below the glideslope, far enough behind the one ahead: clear the ILS. It flies itself down.' }
  // ── the turn ──
  const now = a.navMode === 'heading' ? a.targetHeading : a.heading, turn = wrap(p.hdg - now), fine = p.leg === 'final'
  const why: Record<ArrPlan['leg'], string> = {
    inbound: `To the downwind for ${p.rwy}, ${ord(p.place + 1)}${behind}.${late(p)}`,
    downwind: p.slack > 12 && p.x > 10 ? `Downwind a little longer: it is ${ord(p.place + 1)}${behind}.${late(p)}` : `Downwind for ${p.rwy}, ${ord(p.place + 1)}${behind}.`,
    outbound: `Out again for its place in the line, ${ord(p.place + 1)}${behind}.${late(p)}`,
    wide: `A long way round to wait for its turn, ${ord(p.place + 1)}${behind}.${late(p)}`,
    dogleg: `A vector off to the side to open the gap${behind}.${late(p)}`,
    base: `Base leg for ${p.rwy}, ${ord(p.place + 1)}${behind}.`,
    final: `Cuts on to the ${p.rwy} localizer at a gentle angle.`,
    out: `Too near the final to turn in: out to a downwind first.`,
    established: `On the ${p.rwy} localizer.`,
  }
  if (Math.abs(turn) > (fine ? 7 : p.leg === 'base' ? 18 : 14) && !e.turnBlocked(a, p.hdg)) return { cmd: `${cs} fly heading ${(fine ? hdg5 : hdg3)(mag(p.hdg))}`, why: why[p.leg] }
  // ── down ──
  if (!p.go && (p.leg === 'out' || cur < 2900) && cur < 3900) { const up = e.safeClimb(a, 4000); if (up > cur + 400) return { cmd: `${cs} climb and maintain ${up}`, why: 'Back up, out of the way of the next one on the final.' } }
  const to = e.safeDescent(a, p.level)
  if (to < cur - 400) return { cmd: `${cs} descend and maintain ${to}`, why: p.go ? 'Down to the height the glideslope is met from below.' : to > p.level ? 'Down as far as the traffic below allows.' : 'A thousand feet above the one before it until that one is on the beam.' }
  // ── slower ──
  if (p.kt && a.cmdIas !== p.kt && a.targetSpeed > p.kt + 9 && a.altitude < 10500) return { cmd: `${cs} reduce speed to ${p.kt}`, why: p.slack > 25 ? `Slower, to lose time on the way.${late(p)}` : 'Slow enough to turn on to the final and keep the spacing.' }
  if (p.kt && a.cmdIas != null && p.kt > a.cmdIas + 15 && !p.go) return { cmd: `${cs} increase speed to ${p.kt}`, why: 'Its turn is coming up: no need to be this slow.' }
  return { wait: to > p.level && to >= cur - 400 && p.level < cur - 400 ? `${why[p.leg]} Lower once the level below is free.` : why[p.leg] }
}

/** A departure on the radar frequency: up (clear of the arrivals), and on to the centre before it leaves the airspace. */
export function departureCall(e: SimEngine, a: AircraftState): NextCall {
  const cs = a.callsign, top = Math.max(9000, a.plan.cruiseAlt ?? 9000), cmd = a.cmdAltitude ?? a.targetAltitude, out = Math.hypot(a.pos.x - e.centerXY.x, a.pos.y - e.centerXY.y) / NM
  if (a.handedTo != null) return { wait: 'Handed over.' }
  const adv = e.airAdvice(a)
  if (adv) return adv.cmd ? { cmd: adv.cmd, why: 'Traffic: it would pass too close to another one. Move it out of the way now.' } : { wait: 'Held clear of traffic. Climb it on in a moment.' }
  const to = cmd < top - 100 ? e.safeClimb(a, top) : cmd
  if (to > cmd + 500) return { cmd: `${cs} climb and maintain ${to >= 18000 ? `FL${Math.round(to / 100)}` : to}`, why: to < top ? 'Up as far as the traffic above allows.' : 'Clear to climb: up out of the arrivals.' }
  if (a.altitude >= 7500 || out > 20) return { cmd: `${cs} contact centre`, why: 'High enough and on its way: hand it to the centre before it leaves your airspace.' }
  return { wait: cmd < top - 100 ? 'Held below traffic above it. Climb it on once that has passed.' : 'Climbing out. Hand it to the centre above 7,500 ft.' }
}
