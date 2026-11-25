/*
  The next call a controller would give a flight, read from its state: what the AI would do, as a line the player can
  say (or type) themselves. Shown on the flight card so a newcomer learns the calls in the flow of the game.
  Returns the command as typed ("UAL214 runway 28L cleared to land") or, when nothing is due, what the flight is doing.
*/
import type { SimEngine } from '@/lib/sim/engine'
import type { AircraftState, PlayerPosition } from '@/lib/sim/types'
import { POSITION_OWNER, SECTOR_OF } from '@/lib/sim/types'
import { approachCall, departureCall } from './approachCall'
import { ledgerOf } from '@/lib/sim/ledger'

export type NextCall = { cmd: string; why: string } | { wait: string }

const NM = 1852
const wrap = (d: number) => ((d % 360) + 540) % 360 - 180
const hdg3 = (h: number) => String(((Math.round(h / 10) * 10) % 360 + 360) % 360 || 360).padStart(3, '0')
const open = (a: AircraftState, ...kinds: string[]) => a.requests.find((r) => r.answeredAt == null && kinds.includes(r.kind))
const sameRunway = (e: SimEngine, x: string | null | undefined, y: string | null | undefined) => {
  if (!x || !y) return false
  const rx = e.runwayByEnd(x), ry = e.runwayByEnd(y)
  return !!rx && !!ry && rx.rw.ref === ry.rw.ref
}

/** Another departure lined up on this runway, or cleared to (its line-up still on the way): one at a time. */
function otherLineup(e: SimEngine, a: AircraftState, rwy: string): AircraftState | null {
  return e.aircraft.find((x) => x !== a && x.plan.kind === 'departure' && sameRunway(e, x.plan.runway, rwy)
    && (x.phase === 'lineup' || x.pendingCmds.some((c) => c.kind === 'lineup' && !(x.phase === 'hold_short' && x.path?.holds?.[0] && !x.path.holds[0].isDepartureEntry)))) ?? null
}
/** Metres along the runway from its threshold (who is further down). */
function alongRwy(e: SimEngine, rwy: string, p: { x: number; y: number }): number {
  const t = e.thresholdXY(rwy), end = e.runwayByEnd(rwy); if (!t || !end) return 0
  const h = end.end.trueHdg * Math.PI / 180
  return (p.x - t.x) * Math.sin(h) + (p.y - t.y) * Math.cos(h)
}

/** Why a runway is not free right now, in a few words. */
function busyWhy(e: SimEngine, rwy: string, except?: number, crossing?: AircraftState): string {
  const roll = e.rollingDeparture(rwy); if (roll) return `${roll} is rolling`
  const cross = e.crossingTraffic(rwy); if (cross) return `${cross} is crossing it`
  const occ = e.runwayOccupant(rwy, except); if (occ) return `${occ} is on the runway`
  const fin = e.arrivalOnFinal(rwy, 4); if (fin) return `${fin.callsign} lands in about ${Math.max(10, Math.round(fin.nm * 1852 / Math.max(46, fin.a.speed * 0.5144) / 10) * 10)} s`
  const by = crossing ? e.crossBlocker(crossing) : null
  if (by) return by.how === 'takeoff' ? `${by.cs} is cleared for take-off on it` : `${by.cs} is stopped on the other side, with no room behind it`
  return 'another aircraft is too close to it'
}

/** Whether the player works this flight now (its frequency belongs to the player's sector). */
export function isMine(a: AircraftState, position: PlayerPosition): boolean {
  const owner = POSITION_OWNER[a.onFrequency]
  return owner != null && SECTOR_OF[owner] === SECTOR_OF[position]
}

export function nextCall(e: SimEngine, a: AircraftState): NextCall {
  const cs = a.callsign, dep = a.plan.kind === 'departure'
  const rwy = a.plan.runway ?? a.assignedRunway ?? ''
  // the taxiways, and "hold short of" the first runway in the way (an FAA clearance across a runway without it is incomplete)
  const taxiTo = (dest: Parameters<SimEngine['previewTaxi']>[1], what: string) => {
    let names: string[] = [], hold = ''
    try { const p = e.previewTaxi(a, dest); names = p?.names ?? []; const x = p?.crossings[0]; if (x && e.settings.region === 'FAA') hold = ` hold short of runway ${x.runway}` } catch { /* no route from here */ }
    return `${cs} taxi to ${what}${names.length ? ` via ${names.join(' ')}` : ''}${hold}`
  }

  // the pilot asked something, or offered another way: yes (or say it again / "negative" to have it done as told)
  const asked = ledgerOf(e).pending(cs, e.time)
  if (asked && /^(taxi|air)_/.test(asked.rule)) {
    if (asked.offer) return { cmd: `${cs} approved`, why: `They asked: “${asked.question}?” Approve it${asked.hard ? ', or give another instruction.' : ', or say “negative” and they do as you said.'}` }
    if (!asked.hard) return { cmd: `${cs} affirm`, why: `They asked: “${asked.question}?” Confirm it, or give a new instruction.` }
    return { wait: `They asked: “${asked.question}?” Give another instruction.` }
  }

  // held by traffic on the ground: a queue sorts itself out; a standoff needs a way round (or the other one moved)
  const adv = e.groundAdvice(a)
  if (adv) return adv.cmd ? { cmd: adv.cmd, why: adv.text } : { wait: adv.text }

  // a runway in the way: cross it (departures at their own runway line up instead, below)
  // (one whose way to the threshold first crosses that same runway crosses it, too: the hold line it stands at is not its entry)
  const h0 = a.path?.holds?.[0], crossFirst = !!h0 && !h0.isDepartureEntry && a.path!.holds!.some((h) => h.isDepartureEntry && h !== h0)
  if (a.phase === 'hold_short' && a.holdShortRunway && !(dep && sameRunway(e, a.holdShortRunway, rwy) && !crossFirst)) {
    if (!e.crossAdvised(a) || e.runwayOccupied(a.holdShortRunway, a.id)) return { wait: `Holding short of ${a.holdShortRunway}: ${busyWhy(e, a.holdShortRunway, undefined, a)}. Cross it once that has passed.` }
    return { cmd: `${cs} cross runway ${a.holdShortRunway}`, why: `Holding short of ${a.holdShortRunway}, and nothing is landing or rolling: cross it.` }
  }

  // stopped at the limit of its taxi clearance (or a point it was told to hold at), not at a runway: the rest of the way
  if (a.phase === 'hold_short' && !a.holdShortRunway) {
    const dest = dep ? { kind: 'runway', runway: rwy, intersection: null } : a.plan.gateRef ? { kind: 'stand', ref: a.plan.gateRef } : null
    if (dest && (dep ? rwy : true)) {
      return { cmd: taxiTo(dest as never, dep ? `runway ${rwy}` : `stand ${a.plan.gateRef}`), why: 'Stopped where its clearance ends: give it the rest of the way.' }
    }
  }

  if (dep) {
    switch (a.phase) {
      case 'parked': {
        const expect = a.plan.runway ? ` expect runway ${a.plan.runway}` : ''
        if (a.needsPushback && !e.pushLaneClear(a)) return { wait: 'Traffic is passing behind it (or a neighbour is pushing). Approve the pushback once the lane is clear.' }
        return a.needsPushback
          ? { cmd: `${cs} pushback approved${expect}`, why: 'At the gate, nose in: it needs a push back. Tell it the runway to expect.' }
          : { cmd: `${cs} start-up approved${expect}`, why: 'At a stand it can leave forwards: approve the start-up and tell it the runway to expect.' }
      }
      case 'pushback': return { wait: 'Pushing back. It calls you when the engines are running.' }
      case 'startup': {
        if (!a.startup?.enginesStable && !open(a, 'taxi')) return { wait: 'Starting engines. It calls you when it is ready to taxi.' }
        const coming = e.taxiComing(a)
        if (coming) return { wait: `Ready to taxi, but ${coming.callsign} is taxiing in on the same lane. Let it by first.` }
        return { cmd: taxiTo({ kind: 'runway', runway: rwy, intersection: null } as never, `runway ${rwy}`), why: `Ready to taxi: the runway, then the taxiways in order.` }
      }
      case 'taxi': return { wait: `Taxiing to ${rwy}. It stops by itself at every runway on the way.` }
      case 'hold_short': {
        // lining up in front of an arrival inside 6.5 NM (under three minutes) leaves it no landing clearance: it goes around
        const fin = e.arrivalOnFinal(rwy, 8)
        if (e.runwayOccupied(rwy, a.id) || e.rollingDeparture(rwy) || e.crossingTraffic(rwy) || (fin && fin.nm < 6.5)) return { wait: `At ${rwy}, ready: ${busyWhy(e, rwy, a.id)}. Line it up once that has passed.` }
        const lin = otherLineup(e, a, rwy)
        if (lin) return { wait: `At ${rwy}, ready: ${lin.callsign} is lining up. One on the runway at a time: line this one up once ${lin.callsign} is rolling.` }
        return { cmd: `${cs} runway ${rwy} line up and wait`, why: `At ${rwy} and the runway is free: line up.` }
      }
      case 'lineup': {
        const fin = e.arrivalOnFinal(rwy, 6), wake = e.wakeTimerRemainingS(rwy, a.wakeCategory)
        // two lined up (at different entries): the one further down goes first; the one behind waits for it
        const lin = otherLineup(e, a, rwy)
        if (lin && lin.phase === 'lineup') {
          if (alongRwy(e, rwy, lin.pos) > alongRwy(e, rwy, a.pos)) return { wait: `Lined up behind ${lin.callsign}: clear ${lin.callsign} for takeoff first.` }
          if (!e.rollingDeparture(rwy) && !e.crossingTraffic(rwy) && !(fin && fin.nm < 3) && wake <= 5 && !e.departureAlongside(rwy, a)) return { cmd: `${cs} runway ${rwy} cleared for takeoff`, why: `Lined up ahead of ${lin.callsign}: it goes first.` }
        }
        if (e.runwayOccupied(rwy, a.id) || e.rollingDeparture(rwy) || e.crossingTraffic(rwy) || (fin && fin.nm < 3)) return { wait: `Lined up: ${busyWhy(e, rwy, a.id)}. Clear it for takeoff once the runway is free.` }
        const along = e.departureAlongside(rwy, a)
        if (along) return { wait: along.plan.kind === 'departure' ? `Lined up: ${along.callsign} is just off ${along.plan.runway} ahead of it. Clear it for takeoff once that one is two and a half miles out.` : `Lined up: ${along.callsign} is going around alongside. Clear it for takeoff once that has gone by.` }
        if (e.climbOutBusy(rwy)) return { wait: 'Lined up: an arrival is crossing its climb-out low down. Clear it for takeoff once that has passed.' }
        if (wake > 5) return { wait: `Lined up: wake turbulence from the last departure, ${Math.ceil(wake)} s to go.` }
        return { cmd: `${cs} runway ${rwy} cleared for takeoff`, why: 'Lined up and the runway is free: clear it for takeoff.' }
      }
      case 'takeoff': case 'climb':
        if (a.onFrequency === 'approach' || a.onFrequency === 'departure') return departureCall(e, a)
        if (a.onFrequency === 'tower' && a.altitude > 300) return { cmd: `${cs} contact departure`, why: 'Airborne: hand it to departure.' }
        return { wait: 'Taking off.' }
      default: return a.altitude > 100 && (a.onFrequency === 'approach' || a.onFrequency === 'departure') ? departureCall(e, a) : { wait: 'On its way out.' }
    }
  }

  // arrivals
  switch (a.phase) {
    case 'cruise': case 'descent': case 'approach': case 'go_around': case 'landing': {
      if (a.onFrequency === 'tower') {
        if (a.phase === 'go_around') return { cmd: `${cs} fly runway heading, climb and maintain 3000`, why: 'Going around: give it a heading and an altitude.' }
        if (!a.landingCleared) {
          const occ = e.runwayOccupant(rwy, a.id), roll = e.rollingDeparture(rwy)
          // the one before it lands first (outside the US only one at a time is cleared to land): keep it coming meanwhile
          const first = e.landsFirst(a, rwy), nm = e.distToThresholdNM(a, rwy) ?? 9
          if ((first || (occ && !roll)) && nm < 3.6 && nm > 1.2 && !e.continuing(a)) return { cmd: `${cs} continue approach`, why: `${first ?? occ} is still landing ahead. Keep it coming: it goes around only if ${rwy} is not free by about a mile out.` }
          if (first) return { wait: `On final behind ${first}, who is cleared to land. Clear it to land once ${first} is off ${rwy}.` }
          if (occ || roll) return { wait: `On final, but ${occ ?? roll} is on ${rwy}. Clear it to land as soon as the runway is free (it goes around if it is not cleared by about a mile out).` }
          return { cmd: `${cs} runway ${rwy} cleared to land`, why: 'On final and the runway is free: clear it to land, or it goes around.' }
        }
        return { wait: a.phase === 'landing' ? `Cleared to land on ${rwy}: landing.` : `Cleared to land on ${rwy}.` }
      }
      if (a.phase === 'landing') return { wait: 'Landing.' }
      if (a.ilsCaptured) return { cmd: `${cs} contact tower`, why: 'Established on the localizer: hand it to the tower.' }
      if (a.ilsArmed) return { wait: 'Cleared for the ILS. Hand it to the tower once it is established on the beam.' }
      return approachCall(e, a)
    }
    case 'climb':
      // a go-around climbing out on the tower frequency: back to approach for another go
      if (a.onFrequency === 'tower') return { cmd: `${cs} contact approach`, why: 'Climbing out after the go-around: hand it back to approach for another approach.' }
      return approachCall(e, a)
    case 'rollout': {
      if (a.exitTaxiway) return { wait: `Rolling out, turning off at ${a.exitTaxiway}.` }
      // the exit it can make from its speed, on its stand's side (the next one along was often too close to slow down for)
      const x = e.exitsAhead(a).find((q) => q.engineDefault)
      return x ? { cmd: `${cs} exit at ${x.taxiway}`, why: 'On the rollout: tell it where to turn off.' } : { wait: 'Rolling out.' }
    }
    case 'taxi': case 'hold_short': {
      if (a.path && a.phase === 'taxi' && !open(a, 'taxi_in')) return { wait: 'Taxiing in.' }
      const st = a.reservedStand ?? a.plan.gateRef
      if (!st) return { wait: 'Waiting for a stand.' }
      return { cmd: taxiTo({ kind: 'stand', ref: st } as never, `stand ${st}`), why: 'Off the runway: the stand, then the taxiways in order.' }
    }
    case 'arrived': case 'parked': return { wait: 'At the gate.' }
    default: return { wait: 'On its way.' }
  }
}
