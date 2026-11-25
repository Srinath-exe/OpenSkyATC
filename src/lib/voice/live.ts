/*
  The live reading of a call while it is being made (spoken: the live transcript; typed: the command line as it is now).
  Turns what has been said so far into a command line ("UAL214 taxi to runway 01R via C E"), finds the aircraft being
  called, and pulls out a taxi clearance so far (destination, the taxiways named in order) so the map can draw the route
  as it is given. Nothing here has to parse: half a call is the normal case.
*/
import type { SimEngine } from '../sim/engine'
import type { AircraftState } from '../sim/types'
import { AIRLINE_TELEPHONY } from '../sim/phraseology'
import { normaliseTokens, repairTranscript, runDigits, type AsrAircraft } from './asr-repair'

const PHON: Record<string, string> = Object.fromEntries('alpha alfa bravo charlie delta echo foxtrot golf hotel india juliet juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey whisky xray yankee zulu'.split(' ').map((w) => [w, w[0].toUpperCase()]))
const NUM = new Set('zero one two three four five six seven eight nine niner ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand'.split(' '))
const SIDE: Record<string, string> = { left: 'L', right: 'R', center: 'C', centre: 'C' }

export interface LiveTaxi {
  /** Where to: a runway end, a stand, or null (not said yet: the aircraft's own plan is used). */
  dest: { kind: 'runway'; runway: string } | { kind: 'stand'; ref: string } | null
  /** Taxiways named so far, in order. */
  via: string[]
}
export interface LiveRead {
  /** The call so far as a command line. */
  line: string
  aircraft: AircraftState | null
  taxi: LiveTaxi | null
  /** Runway ends named in the call. */
  runways: string[]
}

function names(e: SimEngine): AsrAircraft[] {
  return e.aircraft.map((a) => {
    const m = a.callsign.match(/^([A-Z]{3})(\d+[A-Z]{0,2})$/); const tel = m ? AIRLINE_TELEPHONY[m[1]] : undefined
    return { callsign: a.callsign, name: tel && m ? `${tel} ${m[2]}`.toLowerCase() : a.callsign.toLowerCase() }
  })
}

/** Read a call in progress. `spoken`: words from a recogniser (numbers as words, the airline's radio name). */
export function liveRead(raw: string, e: SimEngine, spoken: boolean): LiveRead {
  const empty: LiveRead = { line: raw, aircraft: null, taxi: null, runways: [] }
  if (!raw.trim()) return empty
  const list = names(e)
  let text = raw, cs: string | null = null
  if (spoken) { const r = repairTranscript(raw, list); text = r.text || raw; cs = r.callsign }
  let w = normaliseTokens(text)
  // the callsign at the front: the code typed (ual214), or the radio name and its digits
  if (w.length) {
    const code = list.find((x) => x.callsign.toLowerCase() === w[0])
    if (code) { cs = code.callsign; w = w.slice(1) }
    else {
      const hit = (cs ? list.filter((x) => x.callsign === cs) : list).find((x) => { const t = x.name.split(' ').slice(0, -1); return t.length > 0 && t.every((y, i) => w[i] === y) })
      if (hit) {
        const t = hit.name.split(' ').length - 1; let k = t; while (k < w.length && NUM.has(w[k])) k++
        cs = cs ?? hit.callsign; w = w.slice(k)
      }
    }
  }
  const twy = new Set(e.air.taxiwayNames.map((n) => n.toUpperCase()))
  const ends = new Set(e.runways.map((r) => r.name))
  // words -> tokens: digit runs as numbers, "runway one right" -> 01R, "november one five" -> N15
  const out: string[] = []
  for (let i = 0; i < w.length; i++) {
    const x = w[i]
    if (x === 'runway') {
      let j = i + 1; const run: string[] = []; while (j < w.length && NUM.has(w[j])) run.push(w[j++])
      const side = SIDE[w[j]] ?? ''; if (side) j++
      if (run.length) {
        const d = runDigits(run.map((r) => (r === 'niner' ? 'nine' : r)))
        const n = `${d.padStart(2, '0')}${side}`, m = `${d}${side}`
        out.push('runway', ends.has(n) ? n : ends.has(m) ? m : n); i = j - 1; continue
      }
      out.push('runway'); continue
    }
    if (PHON[x]) {
      let j = i + 1; const run: string[] = []; while (j < w.length && NUM.has(w[j]) && run.length < 2) run.push(w[j++])
      const cand = PHON[x] + (run.length ? runDigits(run.map((r) => (r === 'niner' ? 'nine' : r))) : '')
      if (run.length && twy.has(cand)) { out.push(cand); i = j - 1; continue }
      out.push(PHON[x]); continue
    }
    if (NUM.has(x)) {
      let j = i; const run: string[] = []; while (j < w.length && NUM.has(w[j])) run.push(w[j++])
      const d = runDigits(run.map((r) => (r === 'niner' ? 'nine' : r)))
      // "zero one right" (a runway named without the word): 01R
      if (SIDE[w[j]] && d.length <= 2) { const n = `${d.padStart(2, '0')}${SIDE[w[j]]}`; out.push(ends.has(n) ? n : `${d}${SIDE[w[j]]}`); i = j; continue }
      out.push(d); i = j - 1; continue
    }
    if (/^[a-z]\d{0,2}$/.test(x) && twy.has(x.toUpperCase())) { out.push(x.toUpperCase()); continue }
    if (/^\d{1,2}[lrc]$/.test(x)) { out.push(x.toUpperCase()); continue }
    out.push(x)
  }
  const aircraft = cs ? e.find(cs) ?? null : null
  const line = [cs ?? '', ...out].filter(Boolean).join(' ')
  // a taxi clearance so far
  let taxi: LiveTaxi | null = null
  const ti = out.indexOf('taxi')
  if (ti >= 0) {
    taxi = { dest: null, via: [] }
    let viaOn = false
    for (let i = ti + 1; i < out.length; i++) {
      const t = out[i]
      if (t === 'runway' && out[i + 1] && ends.has(out[i + 1])) { taxi.dest = { kind: 'runway', runway: out[i + 1] }; i++; viaOn = false; continue }
      if ((t === 'stand' || t === 'gate') && out[i + 1]) { taxi.dest = { kind: 'stand', ref: out[i + 1].toUpperCase() }; i++; viaOn = false; continue }
      if (ends.has(t)) { taxi.dest = { kind: 'runway', runway: t }; viaOn = false; continue }
      if (t === 'via') { viaOn = true; continue }
      if (viaOn && twy.has(t.toUpperCase())) { taxi.via.push(t.toUpperCase()); continue }
      if (viaOn && (t === 'and' || t === 'then')) continue
      if (['hold', 'cross', 'short', 'contact', 'expect'].includes(t)) break
      viaOn = viaOn && t === 'to'
    }
  }
  return { line, aircraft, taxi, runways: out.filter((t) => ends.has(t)) }
}

/** The route of a taxi clearance so far: the whole planned path, and how far along it the named taxiways reach. */
export function liveRoute(e: SimEngine, a: AircraftState, t: LiveTaxi): { pts: Array<{ x: number; y: number }>; cum: number[]; total: number; named: number } | null {
  const dest = t.dest ?? (a.plan.runway && a.plan.kind === 'departure' ? { kind: 'runway' as const, runway: a.plan.runway } : a.plan.gateRef ? { kind: 'stand' as const, ref: a.plan.gateRef } : null)
  if (!dest) return null
  // the longest prefix of the taxiways named that still makes a route (the last one may be half-heard)
  for (let n = t.via.length; n >= 0; n--) {
    const pv = e.previewTaxi(a, dest.kind === 'runway' ? { kind: 'runway', runway: dest.runway, intersection: null } : { kind: 'stand', ref: dest.ref }, t.via.slice(0, n))
    if (!pv) continue
    const P = pv.path
    let named = 0
    if (n > 0) {
      // through the last leg of the last taxiway named (legs in order; each named taxiway after the one before)
      let k = 0
      for (const name of t.via.slice(0, n)) { const at = pv.legs.findIndex((l, i) => i >= k && l.name.toUpperCase() === name); if (at >= 0) { let z = at; while (z + 1 < pv.legs.length && pv.legs[z + 1].name.toUpperCase() === name) z++; named = pv.legs[z].s1; k = z + 1 } }
    }
    if (n === 0 && t.dest) named = P.total   // only the runway (or stand) said: the usual route is the clearance
    return { pts: P.pts, cum: P.cum, total: P.total, named: Math.min(named, P.total) }
  }
  return null
}
