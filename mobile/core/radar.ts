/*
  The approach scope on the phone: what the web's ApproachView paints (src/components/atc/ApproachView/render.ts), as
  data in the engine's metres (x east, y north) for the app's own painter.
    scene()  once per session: rings centre and radius, boundary, restricted areas, runways with their ILS (feather,
             extended centreline, glideslope-intercept marks), entry points, fixes
    frame()  every update: the airborne traffic with the data block lines render.ts builds (blockLines), the selected
             aircraft's turn prediction / direct line / ILS intercept, the conflict pairs
*/
import { sim } from '../../src/components/atc/simStore'
import { POSITION_OWNER } from '../../src/lib/sim/types'
import type { AircraftState, Position } from '../../src/lib/sim/types'
import { NM_TO_M, advance, angleDelta } from '../../src/lib/sim/projection'
import { ILS_CONST, gsDistM, distAlongFwd } from '../../src/lib/sim/ils'
import { isAirborne } from '../../src/lib/sim/aircraft'
import { turnPredictor, magnetic, hdg3, alt100 } from '../../src/components/atc/ApproachView/geometry'

const r0 = (v: number) => Math.round(v)
const xy = (p: { x: number; y: number }) => [r0(p.x), r0(p.y)]

export function scene(): string {
  const e = sim.engine, radar = sim.radar
  if (!e) return 'null'
  const centre = radar ? radar.centerXY : e.centerXY
  const radiusM = radar ? radar.radiusM : e.airspaceRadiusM
  const ils = new Map(e.ilsRunways.map((r) => [r.name, r] as const))
  const runways = (radar?.runways ?? []).map((rw) => {
    const app = (rw.course + 180) % 360, I = ils.get(rw.name)
    return {
      name: rw.name, thr: xy(rw.thr), end: xy(advance(rw.thr, rw.course, rw.lengthM)), course: rw.course,
      label: xy(advance(rw.thr, app, 420)),
      gs: I ? [2000, 3000, 4000].map((ft) => ({ ft, nm: Math.round(gsDistM(ft, I) / NM_TO_M * 100) / 100 })) : [],
    }
  })
  return JSON.stringify({
    centre: xy(centre), radiusM: r0(radiusM), field: xy(e.centerXY ?? centre),
    areas: (radar?.areas ?? []).map((a) => ({ shape: a.shape, name: a.name ?? null, altFt: a.altFt, c: a.center ? xy(a.center) : null, r: a.radiusM ?? null, pts: a.points.map(xy) })),
    runways,
    entries: (radar?.entries ?? []).map((p) => ({ at: xy(p), hdg: p.heading, beacon: p.beacon ?? null, label: xy(advance(p, (p.heading + 180) % 360, 1500)) })),
    fixes: (radar?.beacons ?? []).map((b) => ({ id: b.id, at: xy(b) })),
    magVar: e.magVar ?? 0, captureDeg: ILS_CONST.captureDeg, gsRangeNM: ILS_CONST.gsRangeNM,
  })
}

const tagFor = (p: Position) => p === 'tower' ? 'TWR' : p === 'ground' ? 'GND' : p === 'external' ? 'EXT' : p === 'departure' ? 'DEP' : 'APP'
const pend = (a: AircraftState, kind: string) => [...a.pendingCmds].reverse().find((p) => p.kind === kind)

export function frame(): string {
  const e = sim.engine; if (!e) return '{"ac":[]}'
  const me = sim.position, magVar = e.magVar ?? 0
  const conflict = new Set<number>()
  for (const a of e.aircraft) if (a.conflict) conflict.add(a.id)
  const pairs: number[][] = []
  for (const al of sim.alerts()) {
    const ids = al.subjectIds.filter((id) => e.byId(id))
    if (ids.length >= 2) { pairs.push([ids[0], ids[1]]); ids.forEach((id) => conflict.add(id)) }
  }
  const activeArr = [...e.arrivalRunwaysInUse()]   // the runways taking arrivals: the scope draws the ILS on these only
  const ac = e.aircraft.filter((a) => isAirborne(a) && a.phase !== 'departed').map((a) => {
    const mine = POSITION_OWNER[a.onFrequency] === me
    const emerg = !!a.emergency
    const tag = POSITION_OWNER[a.onFrequency] !== me ? tagFor(a.onFrequency) : null
    const pA = pend(a, 'altitude'), cmdAlt = pA ? pA.value : a.cmdAltitude
    const pS = pend(a, 'speed'), pH = pend(a, 'heading')
    const mode = a.gsCaptured ? 'ILS' : a.ilsCaptured ? 'LOC' : a.ilsArmed ? 'ARM' : a.goAround ? 'GA'
      : a.navMode === 'hold' ? `HLD ${a.holdFixName ?? ''}`.trim() : a.navMode === 'direct' ? `DCT ${a.directTargetName ?? ''}`.trim()
      : a.navMode === 'sid' ? `SID${a.plan.fix ? ' ' + a.plan.fix : ''}` : pH ? `H${hdg3(magnetic(pH.value, magVar))}`
      : a.navMode === 'heading' && Math.abs(angleDelta(a.heading, a.targetHeading)) > 2 ? `H${hdg3(magnetic(a.targetHeading, magVar))}` : ''
    const sel = a.id === sim.selectedId
    const out: Record<string, unknown> = {
      id: a.id, cs: a.callsign, ty: a.perf.icaoCode, arr: a.plan.kind === 'arrival' ? 1 : 0, p: xy(a.pos), hdg: Math.round(a.heading), kt: Math.round(a.speed), mine: mine ? 1 : 0, sel: sel ? 1 : 0,
      conf: conflict.has(a.id) ? 1 : 0, emg: emerg ? 1 : 0, tag, req: a.requests.some((q) => q.answeredAt == null) ? 1 : 0,
      alt: alt100(a.altitude), to: cmdAlt != null && Math.abs(cmdAlt - a.altitude) > 150 ? { up: cmdAlt > a.altitude, v: alt100(cmdAlt), pend: !!pA } : null,
      expd: a.expedite ? 1 : 0,
      spd: String(Math.round(a.speed / 10)).padStart(2, '0'),
      spdTo: pS ? { up: pS.value > a.speed, v: String(Math.round(pS.value / 10)).padStart(2, '0'), pend: true } : a.cmdIas != null && Math.abs(a.cmdIas - a.speed) > 12 ? { up: a.cmdIas > a.speed, v: String(Math.round(a.cmdIas / 10)).padStart(2, '0'), pend: false } : null,
      wake: a.wakeCategory === 'SUPER' ? 'J' : a.wakeCategory[0], mode, modePend: !!pH && mode.startsWith('H') ? 1 : 0,
      ils: a.ilsCaptured || a.ilsArmed ? (a.assignedRunway ?? a.plan.runway ?? '').toUpperCase() : null,   // drawn on that approach line
      l4: a.plan.kind === 'arrival' ? (a.assignedRunway ?? a.plan.runway ?? null) : (a.plan.dest ?? a.plan.fix ?? a.plan.runway ?? null),
    }
    if (sel) {
      let target: number | null = null, dir: 'L' | 'R' | null = a.turnDir
      if (pH) { target = pH.value; dir = (pH.ast && pH.ast.kind === 'heading' ? (pH.ast as { dir?: 'L' | 'R' | null }).dir : null) ?? dir }
      else if (a.navMode === 'heading' && Math.abs(angleDelta(a.heading, a.targetHeading)) > 2) target = a.targetHeading
      if (target != null && Math.abs(angleDelta(a.heading, target)) > 1) out.turn = turnPredictor(a.pos, a.heading, target, dir, a.speed, a.perf.turnRateAir, 60).map(xy)
      if (a.navMode === 'direct' && a.directTargetXY) out.direct = xy(a.directTargetXY)
      if (a.ilsArmed && !a.ilsCaptured && a.assignedRunway) {
        const I = e.ilsRunways.find((r) => r.name === a.assignedRunway)
        if (I) out.ilsFoot = xy(advance(I.thrXY, (I.rwdHdg + 180) % 360, Math.max(0, distAlongFwd(a.pos, I))))
      }
    }
    return out
  })
  return JSON.stringify({ ac, pairs, activeArr })
}
