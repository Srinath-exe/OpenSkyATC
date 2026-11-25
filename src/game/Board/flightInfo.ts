/*
  What the flight board shows about a flight that the sim does not model: where it is going or coming from, and its
  schedule. Both are derived and stable per flight: the city from the airline's network (picked by the callsign), the
  scheduled time from when the flight entered the game (with a small per-flight offset, so some run early), and the
  expected time from the delay the engine has measured (delay.totalDelayS).
*/
import type { AircraftState, Stage } from '@/lib/sim/types'

type Port = [code: string, city: string]
const NET: Record<string, Port[]> = {
  UAL: [['ORD', 'Chicago'], ['EWR', 'Newark'], ['DEN', 'Denver'], ['IAH', 'Houston'], ['NRT', 'Tokyo Narita'], ['LHR', 'London Heathrow'], ['HNL', 'Honolulu'], ['IAD', 'Washington Dulles']],
  DAL: [['ATL', 'Atlanta'], ['JFK', 'New York JFK'], ['MSP', 'Minneapolis'], ['SLC', 'Salt Lake City'], ['DTW', 'Detroit'], ['SEA', 'Seattle']],
  AAL: [['DFW', 'Dallas'], ['CLT', 'Charlotte'], ['MIA', 'Miami'], ['PHX', 'Phoenix'], ['ORD', 'Chicago'], ['JFK', 'New York JFK']],
  SWA: [['LAS', 'Las Vegas'], ['PHX', 'Phoenix'], ['SAN', 'San Diego'], ['DEN', 'Denver'], ['BUR', 'Burbank'], ['SNA', 'Santa Ana']],
  ASA: [['SEA', 'Seattle'], ['PDX', 'Portland'], ['ANC', 'Anchorage'], ['SNA', 'Santa Ana'], ['BOI', 'Boise']],
  JBU: [['BOS', 'Boston'], ['JFK', 'New York JFK'], ['FLL', 'Fort Lauderdale']],
  SKW: [['SBA', 'Santa Barbara'], ['RNO', 'Reno'], ['FAT', 'Fresno'], ['EUG', 'Eugene'], ['MFR', 'Medford']],
  FFT: [['DEN', 'Denver'], ['LAS', 'Las Vegas']], NKS: [['LAS', 'Las Vegas'], ['LAX', 'Los Angeles']], HAL: [['HNL', 'Honolulu'], ['OGG', 'Maui']],
  DLH: [['FRA', 'Frankfurt'], ['MUC', 'Munich']], BAW: [['LHR', 'London Heathrow']], VIR: [['LHR', 'London Heathrow']], AFR: [['CDG', 'Paris']],
  KLM: [['AMS', 'Amsterdam']], ETD: [['AUH', 'Abu Dhabi']], UAE: [['DXB', 'Dubai']], QTR: [['DOH', 'Doha']], SIA: [['SIN', 'Singapore']],
  CPA: [['HKG', 'Hong Kong']], ANA: [['NRT', 'Tokyo Narita'], ['HND', 'Tokyo Haneda']], JAL: [['HND', 'Tokyo Haneda']], KAL: [['ICN', 'Seoul']],
  EVA: [['TPE', 'Taipei']], CAL: [['TPE', 'Taipei']], QFA: [['SYD', 'Sydney']], ANZ: [['AKL', 'Auckland']], ACA: [['YVR', 'Vancouver'], ['YYZ', 'Toronto']],
  AMX: [['MEX', 'Mexico City']], VOI: [['GDL', 'Guadalajara']], AIC: [['DEL', 'Delhi']], TAI: [['SAL', 'San Salvador']], CCA: [['PEK', 'Beijing']],
  SWR: [['ZRH', 'Zurich'], ['GVA', 'Geneva']], EIN: [['DUB', 'Dublin']], EZY: [['LGW', 'London Gatwick'], ['MXP', 'Milan'], ['GVA', 'Geneva']], RYR: [['DUB', 'Dublin'], ['STN', 'London Stansted']], TRA: [['AMS', 'Amsterdam'], ['RTM', 'Rotterdam']], THY: [['IST', 'Istanbul']],
  SCO: [['SIN', 'Singapore']], HKE: [['HKG', 'Hong Kong']], CES: [['PVG', 'Shanghai']], IGO: [['DEL', 'Delhi'], ['BOM', 'Mumbai']], FDB: [['DXB', 'Dubai']], VOZ: [['MEL', 'Melbourne'], ['BNE', 'Brisbane']], JST: [['MEL', 'Melbourne'], ['SYD', 'Sydney']],
  FDX: [['MEM', 'Memphis']], UPS: [['SDF', 'Louisville']],
}
export const IATA: Record<string, string> = { LFPG: 'CDG', WSSS: 'SIN', RJTT: 'HND', EGLL: 'LHR', OMDB: 'DXB', VHHH: 'HKG', YSSY: 'SYD', VIDP: 'DEL' }
/** Where the home carriers of a field outside the US fly (and any carrier with no network of its own). */
const FROM: Record<string, Port[]> = {
  CDG: [['NCE', 'Nice'], ['TLS', 'Toulouse'], ['LHR', 'London Heathrow'], ['MAD', 'Madrid'], ['FCO', 'Rome'], ['JFK', 'New York JFK'], ['HND', 'Tokyo Haneda'], ['BCN', 'Barcelona']],
  SIN: [['KUL', 'Kuala Lumpur'], ['BKK', 'Bangkok'], ['CGK', 'Jakarta'], ['HKG', 'Hong Kong'], ['SYD', 'Sydney'], ['LHR', 'London Heathrow'], ['HND', 'Tokyo Haneda'], ['DPS', 'Bali']],
  HND: [['CTS', 'Sapporo'], ['FUK', 'Fukuoka'], ['ITM', 'Osaka Itami'], ['OKA', 'Okinawa'], ['KOJ', 'Kagoshima'], ['HIJ', 'Hiroshima'], ['GMP', 'Seoul Gimpo'], ['LAX', 'Los Angeles']],
  LHR: [['EDI', 'Edinburgh'], ['DUB', 'Dublin'], ['CDG', 'Paris'], ['JFK', 'New York JFK'], ['DXB', 'Dubai']],
  DXB: [['LHR', 'London Heathrow'], ['BOM', 'Mumbai'], ['SIN', 'Singapore'], ['JFK', 'New York JFK']],
  HKG: [['TPE', 'Taipei'], ['SIN', 'Singapore'], ['NRT', 'Tokyo Narita'], ['LHR', 'London Heathrow']],
  SYD: [['MEL', 'Melbourne'], ['BNE', 'Brisbane'], ['AKL', 'Auckland'], ['SIN', 'Singapore']],
  DEL: [['BOM', 'Mumbai'], ['BLR', 'Bengaluru'], ['DXB', 'Dubai'], ['LHR', 'London Heathrow']],
}
const DOMESTIC: Port[] = [['LAX', 'Los Angeles'], ['SEA', 'Seattle'], ['ORD', 'Chicago'], ['JFK', 'New York JFK'], ['DEN', 'Denver'], ['LAS', 'Las Vegas'], ['PHX', 'Phoenix'], ['BOS', 'Boston'], ['ATL', 'Atlanta'], ['DFW', 'Dallas']]
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

export interface Route { from: string; fromCity: string; to: string; toCity: string; dep: boolean }
export function routeOf(a: AircraftState, homeIcao: string, homeName: string): Route {
  const home = homeIcao.length === 4 && homeIcao[0] === 'K' ? homeIcao.slice(1) : IATA[homeIcao] ?? homeIcao
  const city = homeName.replace(/\s+(International|Intl\.?|Airport)\b.*$/i, '').trim() || home
  // (never to or from the field itself)
  const own = (NET[a.callsign.slice(0, 3)] ?? []).filter((p) => p[0] !== home), net = own.length ? own : (FROM[home] ?? DOMESTIC).filter((p) => p[0] !== home)
  const [code, name] = net[hash(a.callsign) % net.length]
  const dep = a.plan.kind !== 'arrival'
  return dep ? { from: home, fromCity: city, to: code, toCity: name, dep } : { from: code, fromCity: name, to: home, toCity: city, dep }
}

export type Tone = 'ok' | 'late' | 'early' | 'done'
export interface Times { sched: number; est: number; actual: number | null; lateMin: number; tone: Tone; label: string; status: string }
/** Sim-second times; `label` names the event (Departs / Departed / Lands / Landed). */
export function timesOf(a: AircraftState): Times {
  const dep = a.plan.kind !== 'arrival'
  // flights that start the session together still leave at different times: a slot 0-16 min after the base, and the
  // schedule a few minutes either side of the slot (so some run early, some late before any delay of yours)
  const base = a.spawnedAt + (dep ? 900 : 660) + (hash(a.callsign + '#s') % 5) * 240
  const sched = base + ((hash(a.callsign + '#t') % 9) - 4) * 60
  const est = base + a.delay.totalDelayS
  const actual = dep ? a.delay.airborneAt : a.delay.touchdownAt
  const lateMin = Math.round(((actual ?? est) - sched) / 60)
  const tone: Tone = lateMin > 5 ? 'late' : lateMin < -2 ? 'early' : 'ok'
  const label = dep ? (actual != null ? 'Departed' : 'Departs') : (actual != null ? 'Landed' : 'Lands')
  const status = tone === 'late' ? `Delayed ${lateMin} min` : tone === 'early' ? `Early ${-lateMin} min` : 'On time'
  return { sched, est, actual, lateMin, tone, label, status }
}

/** Sim seconds as a wall-clock time: the session's sim second 0 is pinned to the moment the page first asked. */
let anchor: { t: number; wall: number } | null = null
export function clockOf(simT: number, nowSimT: number): string {
  if (!anchor || nowSimT < anchor.t - 1) anchor = { t: nowSimT, wall: Date.now() }
  const d = new Date(anchor.wall + (simT - anchor.t) * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const STAGE: Partial<Record<Stage, string>> = {
  parked: 'At gate', startup: 'Starting', pushback: 'Pushback', taxi_out: 'Taxi', taxi_in: 'Taxi in', hold_short_dep: 'Holding', hold_short_cross: 'Holding',
  lineup: 'Lined up', takeoff_roll: 'Takeoff', takeoff_air: 'Airborne', rollout: 'Landing', arrived: 'At gate', dep_climb: 'Climbing', dep_level: 'Climbing',
  go_around: 'Go-around', arr_inbound: 'Inbound', arr_armed: 'Approach', arr_established: 'On the ILS', arr_final: 'Final', arr_short_final: 'Short final',
}
export const stageLabel = (s: Stage): string => STAGE[s] ?? s.replace(/_/g, ' ')
export const stageTone = (s: Stage): 'idle' | 'go' | 'warn' | 'air' =>
  s === 'parked' || s === 'arrived' ? 'idle' : s.startsWith('hold') || s === 'lineup' || s === 'go_around' ? 'warn' : s.startsWith('arr_') || s.startsWith('dep_') || s === 'takeoff_air' ? 'air' : 'go'

const REQ: Partial<Record<string, string>> = { clearance: 'Wants clearance', pushback: 'Wants pushback', startup: 'Wants start-up', taxi: 'Wants taxi', cross: 'Wants to cross', ready: 'Ready for departure', with_you: 'Checking in', higher: 'Wants higher', lower: 'Wants lower', direct: 'Wants direct', taxi_in: 'Wants taxi in', runway_vacated: 'Runway vacated', going_around: 'Going around', confirm_cleared: 'Confirm cleared?' }
/** The flight's open request, in words (null when it is not waiting on you). */
export function requestOf(a: AircraftState): string | null {
  const r = a.requests.find((q) => q.answeredAt == null)
  return r ? REQ[r.kind] ?? r.kind.replace(/_/g, ' ') : null
}
