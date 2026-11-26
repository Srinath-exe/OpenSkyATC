// ============================================================
//  SimEngine — owns aircraft, runways, stands, the fixed-timestep loop,
//  spawning, drivable paths with hold-short PLACES, ground traffic rules,
//  separation / incursion detection, ILS + landing-clearance logic, the
//  pilot-delay command queue (EngineCommandApi), pilot requests, readbacks,
//  scoring, and the hooks into the systems modules (weather, vehicles,
//  emergencies, alerts, phraseology).
//
//  Pure TypeScript: no DOM, no React. All randomness via rng.ts.
//  Master plan §2.2 / 06-CONTRACTS §7 are the binding contracts.
// ============================================================
import { stepArrivals, arrivalPlan } from './arrivals';
import { flyHold, holdSpeedKt, publishedHold } from './holds';
import {
  LocalProjection, XY, dist, headingTo, advance, chaikin, smoothPath, filletCorners, straightenJogs, angleDelta,
  dedupeBacktracks, arcLengths, resample, distToSegment, projectOntoPath, alongTrack, crossTrack, sampleAlong,
  segmentIntersection, NM_TO_M, FT_TO_M, KTS_TO_MPS,
} from './projection';
import { OsmAirport, OsmRunway, OsmRunwayEnd, OsmStand, findPath, pathCache, routeVia as osmRouteVia, taxiwaysForPath, holdsOnPath, isHoldNodeForRunway as osmIsHoldNode, holdForRunwayEntry } from '../osmAirport';
import { getPerformance, randomCommercialTypeOf, spokenTypeOf, v1Kt, WeightClass } from './aircraftDB';
import {
  AircraftState, DrivePath, PathHold, SimEvent, SimEventType, SimEventData, FlightKind, FlightPhase, PendingCmd, PendingCondition,
  PilotRequest, PilotRequestKind, Position, PlayerPosition, POSITION_OWNER, SECTOR_OF, NEXT_POSITION, RunwayState, RunwayStatus, RunwayOccupant,
  RunwayOccupantKind, GateState, ParkedAircraft, SessionStats, ScoreCode, ScoreEvent, SCORE_TABLE, emptySessionStats, Stage, WakeCategory,
  WAKE_DEPARTURE_S, WAKE_FINAL_NM, WAKE_CATEGORY_BY_CLASS, newAircraftFields, Emergency, EmergencyType, ReadbackStatus,
  VehicleTarget, VehicleType, WeatherState, Vehicle, Alert, defaultPushback, defaultStartup, EVENT_WHO,
} from './types';
import { stepAircraft, isAirborne, StepCtx, HOLD_BUFFER_M, DEP_TURN_FT, TAXI_DECEL, EMERG_DECEL, takeoffAccelKts, approachVal, brakingDistM, wheelbaseM } from './aircraft';
import { ILSRunway, canCaptureLoc, overshootsLoc, locTargetHdg, gsAltFt, gsDistM, distAlongFwd, crossTrackM, featherHdg, aboveGlideslope, ilsFromGeometry, ILS_CONST } from './ils';
import { rng, rnd, ri, rf, chance, subStream } from './rng';
import { AIRLINE_BY_ICAO, pickCarrier, pickType, profileOf, sizeFits } from './airlines';
import { StandPlan, planSig, pushRaw, tightestTurn } from './pushPlan';
import { standPlanOf, standShowOnly, standUnused } from './standPlans';
import { makeNameBook, putNames, renameMemories, renameState, type NameBook, type Naming } from './naming';
import type { StandSize } from '../osmAirport';
import { stage as deriveStage, StageCtx, distToThresholdFromPathNM } from './stage';
import type {
  CommandAST, EngineOutcome, CommandResult, TaxiDest, HoldShortTarget, PushDir, TurnDir, ExitSpec, ExpediteScope, ContactWhen,
  ApproachType, CorrectionField, UnableReason, ReportKind, EmergencyInfoKind, HoldAllScope, ResultCode,
} from './commandAst';
import { describe, IMMEDIATE_KINDS, makeAst } from './commandAst';
import type { EngineCommandApi } from './dispatch';
import { SILENT_CODES } from './dispatch';
import { WeatherModel, defaultWeather, windComponents, applyWind } from './weather';
import { VehicleFleet, defaultStations, VehicleStepCtx, VehicleStations } from './vehicles';
import { AlertEngine, AlertStepCtx } from './alerts';
import { mindOf } from './pilotmind';
import { taxiLimitsOf } from './taxiLimits';
import { Poly, outlineOf, outlineGap } from './outline';
import { airMindOf } from './airmind';
import { crewLifeOf } from './crewlife';
import { personaOf, stressOf, delayFactor, errorFactor, personaLine } from './persona';
import {
  EMERGENCY_CATALOGUE, EmergencyEngineView, EmergencySetting, createEmergency, maybeDeclare, onDeclared, stepEmergency,
  handleLanded, completeChecklistItem, scoreOnResolved, ackReplyLine, SOULS_BY_CLASS,
} from './emergencies';
import { PhraseCtx, spokenFix, spokenRunway, spokenTaxiway, telephony as telephonyOf, readback as phraseReadback, pilotRequestLine } from './phraseology';
import type { RunwayEnd } from '../runwayManifest';
import type { AircraftView, SpawnSpec } from './testApi';

// ──────────────────────────────────────────────────────────────────────────────
//  Constants (03 §8 / §H, 06 §7)
// ──────────────────────────────────────────────────────────────────────────────
export const FIXED = 1 / 30;
export const MAX_SUBSTEPS = 6;
const VERT_SEP_FT = 1000, HORIZ_SEP_NM = 3, REDUCED_FINAL_NM = 2.5;
const FT_PER_M = 1 / FT_TO_M;
/** Landing phase begins (approach path built) inside this distance once established. */
const LANDING_PHASE_NM = 8;
/** Arrival auto-handoff APP -> TWR when established (03 §3.14). */
const TOWER_HANDOFF_NM = 10;
/** Forced go-around table (03 §B1) + the engine brief (no clearance at 2 NM). */
export const FORCED_GA = { noClearanceNM: 2.0, noClearanceFt: 300, occupiedNM: 1.0, crossingNM: 0.7, precedingNM: 0.5, closedNM: 3.0 } as const;
/** 4 NM: pilot "confirm cleared to land?" query. */
const CONFIRM_CLEARED_NM = 4;
/** Sharpest turn a taxi route may make at one node (deg): an airliner cannot reverse on a taxiway (route planning). */
const TAXI_MAX_TURN_DEG = 120;
/** Centreline turn radius at a corner of a taxi route: on a taxiway (the arc must stay on the pavement) and where a
 *  stand's lead-in meets its lane on the apron (taxi-in and pushback). A leg too short for it gets what fits. */
const TAXI_TURN_RADIUS_M = 20, APRON_TURN_RADIUS_M = 30;
/** Turning onto a runway (line up, rolling takeoff): one wide arc, so an acute entry is a sweep, not a pivot. */
const RUNWAY_ENTRY_RADIUS_M = 32;
/** Arrival descents (AI approach): nobody in the band within this distance now or at the 2-minute closest point. */
const DESCENT_CLEAR_NM = 4;
/** AI ground: held this long (s) behind a stationary aircraft before a deadlock is broken by a re-route. */
const DEADLOCK_S = 25;
/** Two aircraft jammed nose to nose this long (s) with no way round: a ramp tug tows one back into a side taxiway. */
const TOW_AFTER_S = 70;
const TOW_SPEED_MPS = 1.4;
interface TowState { pts: XY[]; cum: number[]; total: number; d: number; forId: number; forCs: string; dest: TaxiDest; doneAt: number | null; startedAt: number; /** Turned round at the end of the tow, to this heading: it goes another way. */ spin?: number; waiting?: number; gaveUp?: boolean }
/** Taxi routing: cost multiplier for an edge other taxiing traffic is using in the opposite direction. */
/** Route cost of a taxiway the aircraft is too wide for (taxiLimits.ts). */
const TOO_WIDE_COST = 12;
const AGAINST_FLOW_COST = 4;
/** Flow control: arrivals in the TMA not yet established, per runway direction in use. */
const ARR_FLOW_PER_FAMILY = 7;   // (was 5; holding at the arrival fixes takes the longer waits)
/** Departure metering (AI ground): pushbacks approved while fewer than this many departures per active departure runway are moving on the field. */
const DEP_QUEUE_PER_RUNWAY = 4;
/** AI conflict net: look-ahead (s) and the predicted closest distance it acts on (NM). */
const AI_CPA_S = 100, AI_CPA_NM = 3.8;
/** AI tower: initial climb for a departure (ft). */
const DEP_INITIAL_FT = 7000;
/** AI intercept angle to the localizer (deg): under the 30 deg capture limit with room for the whole-degree heading (a
 *  30 deg vector rounded to 30.1 and flew straight through the localizer, never capturing). */
const AI_INTERCEPT_DEG = 27;
/** Longest downwind extension the AI approach flies (NM past the shortest base point); more delay is held in a racetrack. */
const TROMBONE_MAX_NM = 3;
/** Runway geometry: physical strip half-width (on the runway) and hold-line distance from the centreline. */
const STRIP_HALF_M = 45, HOLD_LINE_M = 90;
/** Line-up: stop this far past the entry point along the runway. */
const LINEUP_ADVANCE_M = 50;
const MISSED_APPROACH_ALT_FT = 3000;
const LUAW_QUERY_S = 90;
const READBACK_MISMATCH_WINDOW_S = 15;
const INCIDENT_DEDUPE_S = 60;
const EVENT_RING = 500;

const CITIES = ['MUC', 'FRA', 'CDG', 'AMS', 'MAD', 'DXB', 'SIN', 'HKG', 'JFK', 'LAX', 'ORD', 'DEL', 'SYD', 'NRT', 'GVA', 'VIE', 'LIS', 'DUB', 'ZRH', 'IST'];
const DEFAULT_FREQ: Record<Position, string> = { ground: '121.900', tower: '118.500', departure: '125.200', approach: '119.700', external: '127.100' };

export type AirportData = OsmAirport;

export interface AirspaceEntry { x?: number; y?: number; heading: number; altFt: number; beacon?: string; weight: number }

export interface AirspaceConfig {
  radiusM: number;
  ilsRunways: ILSRunway[];
  beacons: Array<{ id: string; x: number; y: number; holdHeading?: number }>;
  /** Airspace centre in engine XY (B3). Default {0,0} = OSM airport centre. */
  centerXY?: XY;
  /** Boundary entry points (weighted); positions computed from centre+radius when x/y absent. */
  entries?: AirspaceEntry[];
  magVar?: number;
  transitionAltFt?: number;
  airportName?: string;
  frequencies?: Partial<Record<Position, string>>;
  missedApproachAltFt?: number;
}

export interface EngineSettings {
  /** AI tower assist: routine clearances 8 s after they become valid (UX §G5.10). */
  autoTower: boolean;
  /** Auto taxi-in after vacating (set-auto-taxi-in). */
  autoGround: boolean;
  /** AI approach assist: radar contact, descent, sequencing vectors and ILS clearances for arrivals on the approach frequency. */
  autoApproach: boolean;
  /** Auto mode: every position the player is not working is run by its AI (the explicit assists above add to this). */
  autoMode: boolean;
  /** Auto-handoff at 1000 ft AGL / 10 NM established. */
  autoHandoff: boolean;
  /** Flow control on generated traffic: spawnArrival() declines while the TMA is full (ARR_FLOW_PER_FAMILY). */
  arrivalFlow?: boolean;
  emergencyRate: EmergencySetting;
  /** Wrong-readback probability (0 / 0.02 / 0.05). */
  pilotErrorRate: number;
  /** Crews have characters (persona.ts): reply speed, error rate, hesitation and "say again" differ per callsign. Off = every crew is the same. */
  personas?: boolean;
  /** Two crews talking at once and callsigns that sound alike (crewlife.ts). */
  radioRealism?: boolean;
  /** A scripted lesson: crews do not chat, and ask only when they cannot do a thing. */
  quietCrews?: boolean;
  strictFrequencies: boolean;
  arcadeIntercept: boolean;
  reducedFinalSep: boolean;
  region: 'ICAO' | 'FAA';
  /** Test hook: fixed pilot delay in s (null = realistic 2-4 s air / 4-8 s ground). */
  pilotDelayOverride: number | null;
  /** Despawn parked arrivals after 120-300 s. */
  despawnParked: boolean;
}

interface ExitPlan { runwayNodeId: string; twyNodeId: string; at: number; speedKt: number; taxiway: string | null; angleDeg: number }
interface RunwayExit { runwayNodeId: string; twyNodeId: string; xy: XY; taxiway: string | null }

/** Private per-aircraft timers/scratch (not part of AircraftState). */
interface Scratch {
  pull: { forId: number; since: number; held: boolean } | null;   // a pushback being pulled back in to let another by
  pass: { id: number; until: number } | null;   // has room past this one by its outline: goes on (see applyTraffic)
  pushJoin: string | null;                  // lane node the last pushback left the nose pointing at
  /** The controller has told it its runway. */
  rwyTold?: boolean;
  preclearedHolds?: PathHold[];
  /** The player's clearance ends here (a taxiway, or the far side of a runway): what the pilot says on stopping at it. */
  limitSay?: string | null;
  /** Taxiing with no path since. */
  noPathSince?: number;
  /** The crew has asked for another runway over the tailwind. */
  tailwindSaid?: boolean;
  nextRequestAt: number | null;
  nextRequestKind: PilotRequestKind | null;
  rollAt: number | null;
  handoffAt: number | null;
  handoffTo: Position | null;
  exitPlan: ExitPlan | null;
  taxiDest: TaxiDest | null;
  crossingRef: string | null;
  onRunwayRef: string | null;
  luawAt: number | null;
  gaAt: number | null;
  stoppedSince: number | null;
  continueApproach: boolean;
  /** Tutorial: the game waits (frozen) for this aircraft's landing clearance; no forced go-around for want of it. */
  awaitClearance?: boolean;
  queried4NM: boolean;
  vacated: boolean;
  passedFixes: Set<string>;
  lastStage: Stage | null;
  emergNoticeAt: number;
  crosswindChecked: boolean;
  despawnAt: number | null;
  rtoRecoverAt: number | null;
  lastLevelAt: number;
  overshootSaid: boolean;
  /** Asked for further clearance once its EFC had passed (holds.ts). */
  efcAsked: boolean;
  locMinXtM: number | null;   // smallest |cross-track| seen while armed and not captured (divergence detection)
  aiNextAt: number;           // AI approach assist: next time this aircraft is looked at
  aiAlt: number | null;       // last altitude the assist assigned
  aiHdg: number | null;       // last heading the assist assigned
  aiRank: number | null;      // place in the assist's queue (hysteresis on re-ordering)
  aiLevel: number | null;     // committed stack level (ft)
  aiGate: number | null;      // intercept gate being flown (NM)
  aiSide: 1 | -1 | null;      // pattern side (sign of the cross-track), sticky
  aiBase: number | null;      // base-turn point being flown (NM along the final)
  aiOrbitAt: number | null;   // orbit for spacing started at
  exitPts?: { node: string; ref: string; pts: XY[] } | null;               // the way off the runway it is rolling out to
  coming?: { at: number; id: number };                 // who it waits for before it taxis out
  airAdvice?: { cmd: string; until: number } | null;   // avoiding action for the flight card (player on Approach)
  aiMode: string | null;      // leg of the pattern being flown
  aiJoin: number | null;      // downwind join point (NM along the final)
  heldSince: number | null;   // held by traffic since
  blockedById: number | null; // the aircraft it is held behind
  lastRerouteAt: number;      // AI ground deadlock re-route bookkeeping
  rerouteAvoidNodes: Set<string> | null;   // nodes the pending re-route must avoid
  adviceAvoid: Set<string> | null;         // the way round a standoff offered to the player (used by their next taxi)
  adviceAt: number;                         // when groundAdvice last planned it
  advice: GroundAdvice | null;              // its cached answer
  stuckSaid: number | null;                 // the aircraft the crew already reported being stuck with
  tow: TowState | null;                     // a ramp tug pulling it back clear of a standoff (towStep)
  aiMovedAt?: number; lastTowAt: number;
  aiAvoidUntil: number;       // avoiding action in force until (normal vectoring suppressed)
  aiAvoidFrom: number;        // when the avoiding turn was given (a turn is held 90 s at most)
  aiDeferFrom: number | null; aiWhy?: string; aiAltWhy?: string; routeIds?: string[] | null; aiAltHoldUntil?: number; directAsked?: boolean; aiClearedAt?: number; towerOffApprSince?: number | null; // when the sequencer first withheld a vector for a neighbour (30 s at most)
  holdReason: string | null;  // why applyTraffic is holding this aircraft (debug / tooltip)
  arffDispatchedAt: number | null;
  handoffLateScored: boolean;
  wakeWarned: Set<number>;
  entryKey: string | null;
  touchdownDone: boolean;
  /** Crossing bookkeeping: has the aircraft physically entered the strip since the cross clearance; closest approach so far (m). */
  crossingEntered: boolean;
  crossingMinD: number;
  /** Arrival has been inside the airspace boundary at least once (retire logic ignores queued spawns still inbound). */
  enteredAirspace: boolean;
}
function newScratch(): Scratch {
  return {
    pull: null, pass: null, pushJoin: null, nextRequestAt: null, nextRequestKind: null, rollAt: null, handoffAt: null, handoffTo: null, exitPlan: null, taxiDest: null,
    crossingRef: null, onRunwayRef: null, luawAt: null, gaAt: null, stoppedSince: null, continueApproach: false, queried4NM: false,
    vacated: false, passedFixes: new Set(), lastStage: null, emergNoticeAt: 0, crosswindChecked: false, despawnAt: null, rtoRecoverAt: null,
    lastLevelAt: 0, overshootSaid: false, efcAsked: false, locMinXtM: null, aiNextAt: 0, aiAlt: null, aiHdg: null, aiRank: null, aiLevel: null, aiGate: null, aiSide: null, aiBase: null, aiOrbitAt: null, aiMode: null, aiJoin: null, heldSince: null, blockedById: null, lastRerouteAt: -1e9, rerouteAvoidNodes: null, adviceAvoid: null, adviceAt: -1e9, advice: null, stuckSaid: null, tow: null, lastTowAt: -1e9, aiAvoidUntil: 0, aiAvoidFrom: -1e9, aiDeferFrom: null, holdReason: null, arffDispatchedAt: null, handoffLateScored: false, wakeWarned: new Set(), entryKey: null, touchdownDone: false,
    crossingEntered: false, crossingMinD: Infinity, enteredAirspace: false,
  };
}

interface ScheduledReadback { at: number; aircraftId: number; status: ReadbackStatus; text: string; ast: CommandAST | null; refused: string[]; mismatch: { field: string; expected: string; read: string } | null }

const OK: EngineOutcome = { ok: true, code: 'ok', applied: true };
const isNotImpl = (e: unknown) => e instanceof Error && /not implemented|not initialised|not initialized/i.test(e.message);
const upper = (s: string) => s.toUpperCase();
const hdg3 = (h: number) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, '0');
const NUMERIC_KINDS = new Set<string>(['heading', 'altitude', 'speed']);
const SURFACE_FACTOR: Record<WeatherState['runwayCondition'], number> = { dry: 1, wet: 0.65, contaminated: 0.4 };

// ──────────────────────────────────────────────────────────────────────────────
//  The engine
// ──────────────────────────────────────────────────────────────────────────────
/** A held ground flight explained for the controller (engine.groundAdvice). */
export interface GroundAdvice { kind: 'wait' | 'reroute' | 'stuck'; text: string; cmd?: string; other?: string }

export class SimEngine implements EngineCommandApi, StageCtx {
  readonly air: AirportData;
  readonly proj: LocalProjection;
  aircraft: AircraftState[] = [];
  time = 0;
  paused = false;
  /** Position tab the player is working (strict-frequency policy). */
  playerPosition: PlayerPosition = 'tower';
  settings: EngineSettings = {
    autoTower: false, autoGround: false, autoApproach: false, autoMode: false, autoHandoff: true, emergencyRate: 'normal', pilotErrorRate: 0.02,
    strictFrequencies: false, arcadeIntercept: false, reducedFinalSep: true, region: 'ICAO', pilotDelayOverride: null, despawnParked: true,
  };
  stats: SessionStats = emptySessionStats(0);
  /** Systems owned by the engine (06 §2). */
  readonly weather = new WeatherModel();
  readonly fleet = new VehicleFleet();
  readonly alerts = new AlertEngine();
  /** Per-END runway state (both ends of a physical runway share status / occupants). */
  runways: RunwayState[] = [];
  gates: GateState[] = [];
  /** Static parked population (airlines.ts profiles): aircraft on stands that are not in the sim's traffic — they fill
   *  the aprons, block their stands, and departures are "activated" from them (the parked airframe becomes the flight). */
  parked: ParkedAircraft[] = [];
  private parkedByRef = new Map<string, ParkedAircraft>();
  private parkedEnabled = false;
  private nextParkedId = -1;
  /** Airspace centre in engine XY (B3). */
  centerXY: XY = { x: 0, y: 0 };
  airspaceRadiusM = 30 * NM_TO_M;
  ilsRunways: ILSRunway[] = [];
  beacons: Array<{ id: string; x: number; y: number; holdHeading?: number }> = [];
  entries: Array<Required<Pick<AirspaceEntry, 'x' | 'y' | 'heading' | 'altFt' | 'weight'>> & { beacon?: string; key: string }> = [];
  magVar = 0;
  transitionAltFt = 6000;
  airportName: string;
  frequencies: Record<Position, string> = { ...DEFAULT_FREQ };
  missedApproachAltFt = MISSED_APPROACH_ALT_FT;
  /** Ring buffer of the last 500 events (test API). */
  events: SimEvent[] = [];
  /** Current runway-config suggestion from the weather model (UI "Change runway" prompt), null = current config is best. */
  suggestedRunways: { dep: string[]; arr: string[]; reason: string } | null = null;
  private aiRunwaySugAt: number | null = null;   // AI tower: when the present runway suggestion first stood
  /** Emergency "hold all traffic" order (R24). */
  holdAllActive: { scope: HoldAllScope; runway: string | null } | null = null;

  private acc = 0;
  private idc = 0;
  private pendingEvents: SimEvent[] = [];
  private conflictPairs = new Set<string>();
  private xyCache = new Map<string, XY>();
  private grid = new Map<string, string[]>();
  private readonly GRID = 150;
  private scratch = new Map<number, Scratch>();
  private readbacks: ScheduledReadback[] = [];
  private lastSecond = -1;
  private frameEvents: SimEvent[] = [];
  private incidentLog = new Map<string, number>();
  private entryLast = new Map<string, { at: number; id: number }>();
  private sys = { weather: true, fleet: true, alerts: true, emergencies: true, phrase: true };
  private wxRng = subStream('weather');
  private emergRng = subStream('emergencies');
  private lastSuggestionKey = '';
  /** Physical runway -> centreline node ids / hold nodes / exits. */
  private runwayNodes = new Map<string, Set<string>>();
  private holdNodes = new Map<string, Set<string>>();
  private holdNodeInfo = new Map<string, { ref: string; runwayNodeId: string }>();
  private exitsCache = new Map<string, RunwayExit[]>();
  private squawkPool = new Set<string>();
  private lastRunwayCheck = 0;

  constructor(air: OsmAirport) {
    this.air = air as AirportData;
    this.proj = new LocalProjection(air.center.lat, air.center.lng);
    this.airportName = air.icao;
    this.settings.region = /^K/.test(air.icao) ? 'FAA' : 'ICAO';
    this.buildGrid();
    this.buildRunways();
    this.buildGates();
    this.initSystems();
  }

  // ── legacy accessors (simStore / tests) ─────────────────────────────────────
  get score(): number { return this.stats.points; }
  set score(v: number) { this.stats.points = v; }
  get skill(): number { return this.stats.skill; }
  set skill(v: number) { this.stats.skill = Math.max(0, Math.min(12, v)); }
  get autoTower(): boolean { return this.settings.autoTower; }
  set autoTower(v: boolean) { this.settings.autoTower = v; }
  get autoGround(): boolean { return this.settings.autoGround; }
  set autoGround(v: boolean) { this.settings.autoGround = v; }
  /** Is an AI working this position: the explicit assist toggle, or auto mode on a position the player is not on. */
  aiOn(pos: PlayerPosition): boolean {
    const s = this.settings;
    const explicit = pos === 'ground' ? s.autoGround : pos === 'tower' ? s.autoTower : s.autoApproach;
    // the positions the player is not working are the AI's (autoMode); the game seats a player on tower for ground too
    // (one airfield sector), so then ground is the player's as well. Without this nobody vectored the arrivals while
    // the player was on tower
    // (either way round: a player seated on ground works the runways too)
    return explicit || (s.autoMode && pos !== this.playerPosition && SECTOR_OF[pos] !== SECTOR_OF[this.playerPosition]);
  }

  // ── configuration ───────────────────────────────────────────────────────────
  setAirspaceConfig(cfg: AirspaceConfig) {
    this.airspaceRadiusM = cfg.radiusM;
    this.ilsRunways = cfg.ilsRunways.map(r => ({ ...r }));
    this.beacons = cfg.beacons;
    this.centerXY = cfg.centerXY ? { ...cfg.centerXY } : { x: 0, y: 0 };
    this.magVar = cfg.magVar ?? 0;
    this.transitionAltFt = cfg.transitionAltFt ?? 6000;
    if (cfg.airportName) this.airportName = cfg.airportName;
    if (cfg.frequencies) this.frequencies = { ...this.frequencies, ...cfg.frequencies };
    this.missedApproachAltFt = cfg.missedApproachAltFt ?? MISSED_APPROACH_ALT_FT;
    this.entries = (cfg.entries ?? []).map(e => {
      const p = e.x != null && e.y != null ? { x: e.x, y: e.y } : advance(this.centerXY, (e.heading + 180) % 360, this.airspaceRadiusM);
      return { x: p.x, y: p.y, heading: e.heading, altFt: e.altFt, weight: e.weight, beacon: e.beacon, key: `${e.heading}|${e.beacon ?? ''}` };
    });
    for (const rs of this.runways) {
      const ils = this.ilsRunways.find(r => r.name === rs.name);
      rs.hasIls = true; rs.ilsEstimated = !ils || !!ils.estimated;
    }
  }

  /** Restrict active ends (home-page runway config). Pass null/empty to activate every end for both roles. */
  setActiveRunwayEnds(ends: string[] | null) {
    const set = ends && ends.length ? new Set(ends.map(upper)) : null;
    for (const rs of this.runways) { rs.activeDep = !set || set.has(rs.name); rs.activeArr = rs.activeDep; }
    // at boot (home-page config) this is the initial information, not a runway change
    this.regenAtis('runway change', this.time < 1);
  }
  /** Explicit dep/arr split (runway-change dialog / weather suggestion applied). */
  setActiveRunways(dep: string[], arr: string[]) {
    const d = new Set(dep.map(upper)), a = new Set(arr.map(upper));
    for (const rs of this.runways) { rs.activeDep = d.has(rs.name); rs.activeArr = a.has(rs.name); }
    this.suggestedRunways = null; this.lastSuggestionKey = '';
    this.regenAtis('runway change');
    this.emit('info', null, `Runway change: departures ${dep.join('/') || '-'}, arrivals ${arr.join('/') || '-'}`);
  }
  activeEnds(role: 'dep' | 'arr'): RunwayState[] { return this.runways.filter(r => (role === 'dep' ? r.activeDep : r.activeArr)); }
  /** The runways taking arrivals now: the open, into-wind active arrival ends, plus any runway an airborne arrival has
   *  been given. The approach scope draws the ILS on these only. Read-only (the direction of operations is not set). */
  arrivalRunwaysInUse(): Set<string> {
    const keep = this.opsHeading;
    const out = new Set(this.windFiltered(this.activeEnds('arr').filter(r => r.status === 'open')).map(r => r.name));
    this.opsHeading = keep;
    for (const a of this.aircraft) {
      const rw = a.assignedRunway ?? a.plan.runway;
      if (a.plan.kind === 'arrival' && rw && isAirborne(a)) out.add(rw);
    }
    return out;
  }
  /** Ends without a tailwind above 10 kt (when the player left every end active, traffic still uses the into-wind ends). */
  private windFiltered(ends: RunwayState[]): RunwayState[] {
    if (ends.length < 2) return ends;
    const ok = ends.filter(r => this.windFor(r.headingTrue).headKt >= -10);
    if (!ok.length) return ends;
    // The direction of operations is sticky: once traffic flows one way it keeps flowing that way (arrivals and
    // departures alike) until the tailwind on it exceeds 10 kt - a wind shift never puts a departure head-on with
    // the arrivals already inbound to the reciprocal end.
    if (this.opsHeading != null) {
      const same = ok.filter(r => Math.abs(angleDelta(r.headingTrue, this.opsHeading!)) < 45);
      if (same.length) return same;
    }
    // prefer the best headwind: keep ends within 8 kt of the best
    // one direction family only (all ends within 45 degrees of the best-headwind end)
    const anchor = ok.reduce((b, r) => (this.windFor(r.headingTrue).headKt > this.windFor(b.headingTrue).headKt ? r : b));
    this.opsHeading = anchor.headingTrue;
    return ok.filter(r => Math.abs(angleDelta(r.headingTrue, anchor.headingTrue)) < 45);
  }
  /** Runway heading (true) traffic is currently flowing on; null until the first spawn picks one. */
  private opsHeading: number | null = null;
  private endActive(name: string, role: 'dep' | 'arr' = 'dep'): boolean {
    const rs = this.runwayState(name); if (!rs) return false;
    return role === 'dep' ? rs.activeDep : rs.activeArr;
  }

  /** Per-runway-end allowed weight classes. Pass null to allow every class everywhere. */
  setRunwayWeightAllow(map: Record<string, WeightClass[]> | null) {
    for (const rs of this.runways) rs.weightAllow = null;
    if (!map) return;
    for (const [k, v] of Object.entries(map)) { const rs = this.runwayState(k); if (rs) rs.weightAllow = [...v]; }
  }
  private weightsFor(endName: string): Set<WeightClass> | null {
    const w = this.runwayState(endName)?.weightAllow;
    return w && w.length ? new Set(w) : null;
  }
  weightAllowed(endName: string, wc: WeightClass): boolean { const w = this.weightsFor(endName); return !w || w.has(wc); }
  /** The player's choice of aircraft sizes for NEW traffic (Settings > Traffic); null = every size. */
  spawnSizes: Set<WeightClass> | null = null;
  /** The weight classes a new flight on this end may be: the runway's own list narrowed by the player's choice. */
  private spawnWeights(endName: string): Set<WeightClass> | null {
    const base = this.weightsFor(endName), g = this.spawnSizes;
    if (!g || !g.size) return base;
    const x = new Set([...(base ?? g)].filter(c => g.has(c)));
    return x.size ? x : base;
  }

  // ── geometry ───────────────────────────────────────────────────────────────
  nodeXY(nodeId: string): XY | null {
    const c = this.xyCache.get(nodeId);
    if (c) return c;
    const n = this.air.nodes.get(nodeId);
    if (!n) return null;
    const xy = this.proj.toXY(n.lat, n.lng);
    this.xyCache.set(nodeId, xy);
    return xy;
  }
  endXY(e: { lat: number; lng: number }): XY { return this.proj.toXY(e.lat, e.lng); }
  private gridKey(x: number, y: number) { return `${Math.floor(x / this.GRID)},${Math.floor(y / this.GRID)}`; }
  private buildGrid() {
    for (const id of this.air.nodes.keys()) {
      const xy = this.nodeXY(id)!;
      const k = this.gridKey(xy.x, xy.y);
      const cell = this.grid.get(k); if (cell) cell.push(id); else this.grid.set(k, [id]);
    }
  }
  /** Nearest graph node to a point (spatial grid, B17). */
  nearestNodeId(p: XY, maxM = 1500): string | null {
    const cx = Math.floor(p.x / this.GRID), cy = Math.floor(p.y / this.GRID);
    let best: string | null = null, bestD = maxM * maxM;
    const maxR = Math.ceil(maxM / this.GRID);
    for (let r = 0; r <= maxR; r++) {
      let found = false;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cell = this.grid.get(`${cx + dx},${cy + dy}`); if (!cell) continue;
        for (const id of cell) { const xy = this.nodeXY(id)!; const d = (xy.x - p.x) ** 2 + (xy.y - p.y) ** 2; if (d < bestD) { bestD = d; best = id; found = true; } }
      }
      if (best && r >= 1 && bestD <= ((r - 1) * this.GRID) ** 2) break;
      if (found && r >= 1) break;
    }
    return best;
  }

  runwayByEnd(endName: string): { rw: OsmRunway; end: OsmRunwayEnd; other: OsmRunwayEnd } | null {
    const u = upper(endName);
    for (const rw of this.air.runways) {
      const e = rw.ends.find(x => upper(x.name) === u);
      if (e) return { rw, end: e, other: rw.ends.find(x => x !== e)! };
    }
    return null;
  }
  runwayState(endName: string): RunwayState | undefined { const u = upper(endName); return this.runways.find(r => r.name === u); }
  runwayHeading(endName: string): number { return this.runwayState(endName)?.headingTrue ?? 0; }
  /** Landing threshold XY of a runway end (ILS record when present, else the OSM displaced threshold). */
  thresholdXY(endName: string): XY | null {
    const ils = this.ilsRunways.find(r => r.name === upper(endName));
    if (ils) return ils.thrXY;
    const r = this.runwayByEnd(endName); return r ? this.proj.toXY(r.end.thr.lat, r.end.thr.lng) : null;
  }
  private runwaySegment(ref: string): { a: XY; b: XY } | null {
    const rw = this.air.runways.find(r => r.ref === ref); if (!rw) return null;
    return { a: this.endXY(rw.ends[0]), b: this.endXY(rw.ends[1]) };
  }
  /** Distance from a point to a physical runway centreline. */
  /** Tutorial: this arrival waits for its landing clearance (the game is held still until it is given). */
  awaitClearance(a: AircraftState): void { this.sc(a).awaitClearance = true; }
  distToRunway(p: XY, ref: string): number { const s = this.runwaySegment(ref); return s ? distToSegment(p, s.a, s.b) : Infinity; }
  /** Physical runway refs whose strip contains the point. */
  runwaysAt(p: XY, halfWidth = STRIP_HALF_M): string[] { return this.air.runways.filter(rw => this.distToRunway(p, rw.ref) < halfWidth).map(rw => rw.ref); }

  private buildRunways() {
    // Orientation safety net (B2): the DATA loader orients ends by geometry; re-check so a stale file cannot flip a runway.
    for (const rw of this.air.runways) {
      const [e0, e1] = rw.ends;
      const b = headingTo(this.endXY(e0), this.endXY(e1));
      const num = parseInt(e0.name, 10);
      if (isFinite(num) && Math.abs(angleDelta(num * 10 + this.air.magVar, b)) > 90) { rw.ends = [e1, e0]; }
    }
    for (const rw of this.air.runways) {
      const seg = this.runwaySegment(rw.ref)!;
      const set = new Set<string>(rw.nodeIds ?? []);
      if (!set.size) for (const [id, n] of this.air.nodes) { if (n.edges.some(e => e.type === 'runway') && distToSegment(this.nodeXY(id)!, seg.a, seg.b) < 30) set.add(id); }
      this.runwayNodes.set(rw.ref, set);
      const holds = new Set<string>();
      for (const h of this.air.holdingPositions ?? []) {
        if (!h.runwayRefs.includes(rw.ref)) continue;
        holds.add(h.nodeId);
        if (!this.holdNodeInfo.has(h.nodeId)) {
          // runway centreline node this hold leads to: nearest runway node of the ref
          const hx = this.nodeXY(h.nodeId)!;
          let best: string | null = null, bd = Infinity;
          for (const rid of set) { const d = dist(hx, this.nodeXY(rid)!); if (d < bd) { bd = d; best = rid; } }
          if (best) this.holdNodeInfo.set(h.nodeId, { ref: rw.ref, runwayNodeId: best });
        }
      }
      // Fallback when the loader found no hold for an entry: the taxiway neighbour nearest 90 m from the centreline.
      if (!holds.size) for (const rid of set) {
        const n = this.air.nodes.get(rid)!;
        for (const e of n.edges) {
          if (e.type === 'runway' || set.has(e.to)) continue;
          let best: string | null = null, bestScore = Infinity, prev = rid, cur = e.to;
          for (let k = 0; k < 4 && cur; k++) {
            const xy = this.nodeXY(cur)!; const d = distToSegment(xy, seg.a, seg.b);
            if (d > 260) break;
            const score = Math.abs(d - HOLD_LINE_M) + (d < 40 ? 200 : 0);
            if (score < bestScore) { bestScore = score; best = cur; }
            const cn = this.air.nodes.get(cur)!;
            const next = cn.edges.filter(x => x.to !== prev && x.type !== 'runway' && !set.has(x.to));
            if (next.length !== 1) break;
            prev = cur; cur = next[0].to;
          }
          const chosen = best ?? e.to;
          holds.add(chosen);
          if (!this.holdNodeInfo.has(chosen)) this.holdNodeInfo.set(chosen, { ref: rw.ref, runwayNodeId: rid });
        }
      }
      this.holdNodes.set(rw.ref, holds);
    }
    // Intersections between physical runways (loader data, else segment intersection).
    const inter = new Map<string, string[]>();
    for (const a of this.air.runways) {
      if (a.intersects && a.intersects.length) { inter.set(a.ref, [...a.intersects]); continue; }
      for (const b of this.air.runways) {
        if (a === b) continue;
        const sa = this.runwaySegment(a.ref)!, sb = this.runwaySegment(b.ref)!;
        // crossing centrelines, or strips that touch (a runway ending on another in a T: the junction is shared)
        const touch = segmentIntersection(sa.a, sa.b, sb.a, sb.b) || Math.min(distToSegment(sa.a, sb.a, sb.b), distToSegment(sa.b, sb.a, sb.b), distToSegment(sb.a, sa.a, sa.b), distToSegment(sb.b, sa.a, sa.b)) < 2 * STRIP_HALF_M + 30;
        if (touch) { const l = inter.get(a.ref) ?? []; l.push(b.ref); inter.set(a.ref, l); }
      }
    }
    this.runways = [];
    for (const rw of this.air.runways) {
      const [e0, e1] = rw.ends;
      const len = rw.lengthM || dist(this.endXY(e0), this.endXY(e1));
      const occupants: RunwayOccupant[] = [];
      const allHolds = [...(this.holdNodes.get(rw.ref) ?? [])];
      const mk = (end: OsmRunwayEnd, other: OsmRunwayEnd): RunwayState => ({
        name: upper(end.name), ref: rw.ref, reciprocal: upper(other.name),
        headingTrue: headingTo(this.endXY(end), this.endXY(other)), headingMag: 0, lengthM: len,
        status: 'open', statusReason: '', statusUntil: null, surface: 'dry', activeDep: true, activeArr: true, weightAllow: null,
        occupiedBy: occupants, wakeTimer: null, landingClearances: [], takeoffClearance: null, lastDeparture: null, lastArrival: null,
        holdNodes: end.holdNodeIds && end.holdNodeIds.length ? [...end.holdNodeIds, ...allHolds.filter(h => !end.holdNodeIds.includes(h))] : allHolds,
        hasIls: false, ilsEstimated: true, intersects: inter.get(rw.ref) ?? [], windHeadKt: 0, windCrossKt: 0,
      });
      this.runways.push(mk(e0, e1), mk(e1, e0));
    }
    this.magVar = this.air.magVar ?? 0;
    for (const rs of this.runways) rs.headingMag = ((rs.headingTrue - this.magVar) % 360 + 360) % 360;
  }

  private buildGates() {
    const byRef = new Map<string, GateState>();
    const add = (ref: string, nodeId: string, needsPushback: boolean, terminal: string | undefined, closed = false) => {
      if (byRef.has(ref)) return;
      byRef.set(ref, { ref, nodeId, terminal: terminal ?? (/^[A-Z]/i.test(ref) ? ref[0].toUpperCase() : 'STANDS'), occupiedBy: null, reservedFor: null, needsPushback, closed });
    };
    // a remote stand is driven out of forward only when the way out is ahead of (or beside) the parked nose; one whose
    // only link leaves from behind the parked aircraft is nose-in and needs a push - driven out it went forward into the
    // end of the apron and looped round (R57)
    const outBehind = (st: OsmStand) => {
      const n = this.air.nodes.get(st.nodeId); if (!n || n.edges.length !== 1) return false
      const sx = this.proj.toXY(st.lat, st.lng), nb = this.nodeXY(n.edges[0].to); if (!nb) return false
      return Math.abs(angleDelta((st.headingIn + 180) % 360, headingTo(sx, nb))) < 60
    }
    for (const st of this.air.stands ?? []) add(st.ref, st.nodeId, st.type !== 'remote' || /^[0-9]/.test(st.ref) || outBehind(st), st.terminal);
    for (const g of this.air.gates) { const n = this.air.nodes.get(g.nodeId); add(g.ref, g.nodeId, /^[0-9]/.test(g.ref) || (n ? n.edges.length <= 1 : true), undefined); }
    this.gates = [...byRef.values()];
    for (const g of this.gates) if (standShowOnly(this.air.icao, g.ref)) g.closed = true;
    this.standSig = planSig(this.air);
    const plan = standPlanOf(this.air.icao);
    if (plan && plan.sig === this.standSig && !SimEngine.noStandPlans) this.applyStandPlan(plan); else if (!SimEngine.noStandPlans) this.dropBlockedStands();
  }
  /** Set by scripts/gatelab while it makes a plan: build the field without one. */
  static noStandPlans = false;
  standSig = '';
  private standPlan: StandPlan | null = null;
  private clashOf = new Map<string, Set<string>>();
  /** The airport's stand plan: stands that are not real ones go, sizes are what fits, and pushes are the checked ones. */
  applyStandPlan(plan: StandPlan): void {
    this.standPlan = plan; this.clashOf.clear();
    for (const st of this.air.stands ?? []) { const z = plan.size[st.ref]; if (z) st.size = z as typeof st.size; }
    for (const [a, b] of plan.clash) for (const [x, y] of [[a, b], [b, a]]) { let c = this.clashOf.get(x); if (!c) this.clashOf.set(x, c = new Set()); c.add(y); }
    const gone = (ref: string) => ref in plan.drop || standUnused(this.air.icao, ref);
    this.droppedStands = [...new Set([...Object.keys(plan.drop), ...(this.air.stands ?? []).map(s => s.ref).filter(gone)])].sort(); this.droppedWhy = this.droppedStands.map(r => `${r}: ${plan.drop[r] ?? 'not used'}`);
    this.gates = this.gates.filter(g => !gone(g.ref));
    this.air.stands = (this.air.stands ?? []).filter(st => !gone(st.ref));
    this.air.gates = this.air.gates.filter(g => !gone(g.ref));
  }
  // ── names: the airport's real ones, or the simple set (naming.ts) ──
  naming: Naming = 'real';
  private names: NameBook | null = null;
  /** Off only in scripts/wiresim's NAMING=swap (one name in, one name out: a session must come out identical). */
  nameLoose = true;
  /** The airport's own name of a stand, whichever set is on (the stand plans are keyed by it). */
  private realStand(ref: string): string { return this.naming === 'simple' ? this.names?.standToReal.get(ref) ?? ref : ref; }
  private showOnly(ref: string): boolean { return standShowOnly(this.air.icao, this.realStand(ref)); }
  /** Switches every taxiway and stand name, also in the middle of a session: the map's lines and stands, the plans keyed by
   *  them, and everything already said, planned or pending. Nothing an aircraft is doing changes. */
  setNaming(to: Naming): boolean {
    if (to === this.naming) return false;
    if (!this.names) { taxiLimitsOf(this.air); this.names = makeNameBook(this.air, { extra: this.nameLoose }); }     // (the limits are read off the real names)
    const b = this.names, simple = to === 'simple', tw = simple ? b.twyToSimple : b.twyToReal, st = simple ? b.standToSimple : b.standToReal, s = (r: string) => st.get(r) ?? r;
    putNames(this.air, b, to); this.naming = to; taxiLimitsOf(this.air).realName = simple ? (n) => b.twyToReal.get(n) ?? n : null;
    for (const g of this.gates) g.ref = s(g.ref);
    for (const p of this.parked) p.standRef = s(p.standRef);
    const parked = [...this.parkedByRef]; this.parkedByRef.clear(); for (const [r, p] of parked) this.parkedByRef.set(s(r), p);
    // (entries of stands that are not used go: their old number may be another stand's new one)
    const has = (r: string) => st.has(r), clash = [...this.clashOf]; this.clashOf.clear(); for (const [r, set] of clash) if (has(r)) this.clashOf.set(s(r), new Set([...set].filter(has).map(s)));
    if (this.standPlan) this.standPlan = { ...this.standPlan, push: Object.fromEntries(Object.entries(this.standPlan.push).filter(([r]) => has(r)).map(([r, v]) => [s(r), v])) };
    this.exitsCache.clear(); this.standIdx = null; if (pathCache.map) pathCache.map.clear();
    const done = new WeakSet<object>(); for (const x of [this.aircraft, this.scratch, this.readbacks]) renameState(x, tw, st, done);
    renameMemories(this, tw, st, done);
    this.onNaming?.(tw, st);
    return true;
  }
  /** Others that keep names of their own (the ledger, the store) rename theirs here. */
  onNaming: ((tw: Map<string, string>, st: Map<string, string>) => void) | null = null;
  /** The other set's name of a taxiway, for someone who still uses it ("BD6 is C4 now"). */
  otherName(name: string, stand = false): string | null { const b = this.names; if (!b) return null; const s = this.naming === 'simple'; return (stand ? (s ? b.standToSimple : b.standToReal) : s ? b.twyToSimple : b.twyToReal).get(upper(name)) ?? null; }
  /** A stand whose push or way in needs this one empty is in use (or about to be). */
  private clashBusy(ref: string, except?: number): boolean {
    for (const o of this.clashOf.get(ref) ?? []) {
      if (this.parkedByRef.has(o)) return true;
      const g = this.gateByRef(o); if (g && ((g.occupiedBy != null && g.occupiedBy !== except) || (g.reservedFor != null && g.reservedFor !== except))) return true;
    }
    return false;
  }
  /** Stands no aircraft could use: one whose way in (its lead-in line) runs through another stand's parked aircraft
   *  (stands back to back, or in a line along one lead-in), or one whose parked aircraft would overlap another's. The
   *  blocked / smaller one goes, from the game and from the map's markings. Removed refs: `this.droppedStands`. */
  droppedStands: string[] = [];
  droppedWhy: string[] = [];
  private dropBlockedStands(): void {
    const stands = this.air.stands ?? []; if (stands.length < 2) return
    const SPAN: Record<string, number> = { A: 15, B: 24, C: 36, D: 52, E: 65, F: 80 }, LEN: Record<string, number> = { A: 16, B: 26, C: 40, D: 55, E: 70, F: 76 }
    // a parked aircraft's box: from the stand point (the nose) back along the stand's heading
    const box = (st: OsmStand) => {
      const p = this.proj.toXY(st.lat, st.lng), h = st.headingIn * Math.PI / 180, fx = Math.sin(h), fy = Math.cos(h)
      return { p, fx, fy, len: LEN[st.size] ?? 40, half: (SPAN[st.size] ?? 36) / 2 }
    }
    const inside = (b: ReturnType<typeof box>, q: XY, shrink = 0.8) => {
      const dx = q.x - b.p.x, dy = q.y - b.p.y, along = -(dx * b.fx + dy * b.fy), across = Math.abs(dx * b.fy - dy * b.fx)
      return along > b.len * (1 - shrink) / 2 && along < b.len * (1 + shrink) / 2 && across < b.half * shrink
    }
    const boxes = new Map(stands.map(st => [st.ref, box(st)] as const))
    const leadIn = (st: OsmStand): XY[] => {      // the lead-in line, from the stand back to the taxilane
      const out: XY[] = []; let id = st.nodeId, prev = ''
      for (let k = 0; k < 40; k++) {
        const n = this.air.nodes.get(id); if (!n) break
        const xy = this.nodeXY(id); if (xy) out.push(xy)
        const nx = n.edges.filter(e => e.leadIn && e.to !== prev); if (nx.length !== 1) break
        prev = id; id = nx[0].to
      }
      // sampled every 4 m
      const pts: XY[] = []; for (let i = 1; i < out.length; i++) { const a = out[i - 1], b = out[i], L = dist(a, b); for (let s = 0; s < L; s += 4) pts.push({ x: a.x + (b.x - a.x) * s / L, y: a.y + (b.y - a.y) * s / L }) }
      return pts
    }
    const drop = new Set<string>()
    const rank = (st: OsmStand) => (SPAN[st.size] ?? 36) * 10 - (st.ref.length) // bigger stands, then shorter refs, stay
    for (const a of stands) {
      if (drop.has(a.ref)) continue
      const ba = boxes.get(a.ref)!
      for (const b of stands) {
        if (a === b || drop.has(b.ref)) continue
        const bb = boxes.get(b.ref)!
        if (dist(ba.p, bb.p) > 160) continue
        // a's way in crosses b's parked aircraft (beyond a few metres from a's own stand point): a is blocked
        if (leadIn(a).some((q, i) => i > 3 && inside(bb, q, 0.7))) {
          // remote behind remote: the blocked one goes; a remote stand in a real gate's way: the remote one goes; two
          // real gates: both stay (their lead-ins run between parked aircraft by design, and the box is approximate)
          const ra = a.type === 'remote', rb = b.type === 'remote'
          if (ra && rb) { drop.add(a.ref); this.droppedWhy.push(`${a.ref}: way in through ${b.ref}`); break }
          if (!ra && rb) { drop.add(b.ref); this.droppedWhy.push(`${b.ref}: in the way of gate ${a.ref}`); continue }
          continue
        }
        // the two parked aircraft overlap: keep the bigger one
        if (inside(bb, ba.p, 0.75) || inside(ba, bb.p, 0.75)) { const d = rank(a) >= rank(b) ? b : a; drop.add(d.ref); this.droppedWhy.push(`${d.ref}: overlaps ${d === a ? b.ref : a.ref} (${a.size}/${b.size}, ${Math.round(dist(ba.p, bb.p))} m)`); if (drop.has(a.ref)) break }
      }
    }
    if (!drop.size) return
    this.droppedStands = [...drop].sort()
    this.gates = this.gates.filter(g => !drop.has(g.ref))
    this.air.stands = stands.filter(st => !drop.has(st.ref))
    this.air.gates = this.air.gates.filter(g => !drop.has(g.ref))
  }
  gateStates(): GateState[] { return this.gates; }
  runwayStates(): RunwayState[] { return this.runways; }
  gateByRef(ref: string): GateState | undefined { const u = upper(ref); return this.gates.find(g => g.ref.toUpperCase() === u); }
  private standIdx: { of: unknown; m: Map<string, OsmStand> } | null = null;
  private standOf(g: GateState): OsmStand | undefined {
    const l = this.air.stands; if (!l) return undefined;
    if (this.standIdx?.of !== l) { const m = new Map<string, OsmStand>(); for (const st of l) if (!m.has(st.ref)) m.set(st.ref, st); this.standIdx = { of: l, m }; }
    return this.standIdx!.m.get(g.ref);
  }
  /** Is any gate within 90 m? Gates on a 100 m grid (asked for every taxiing aircraft 30 times a second: measuring the way
   *  to every gate each time was half of all the simulation's work). */
  private gateGrid: { of: unknown; m: Map<number, XY[]> } | null = null;
  private nearGate(p: XY): boolean {
    if (this.gateGrid?.of !== this.gates) {
      const m = new Map<number, XY[]>();
      for (const g of this.gates) { const q = this.gateXY(g), k = Math.floor(q.x / 100) * 4096 + Math.floor(q.y / 100); const c = m.get(k); if (c) c.push(q); else m.set(k, [q]); }
      this.gateGrid = { of: this.gates, m };
    }
    const gx = Math.floor(p.x / 100), gy = Math.floor(p.y / 100);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const c = this.gateGrid!.m.get((gx + i) * 4096 + gy + j); if (c) for (const q of c) if (dist(q, p) < 90) return true; }
    return false;
  }
  gateXY(g: GateState): XY {
    const s = this.standOf(g);
    if (s) return this.proj.toXY(s.lat, s.lng);
    const og = this.air.gates.find(x => x.ref === g.ref);
    if (og) return this.proj.toXY(og.lat, og.lng);
    return this.nodeXY(g.nodeId) ?? { x: 0, y: 0 };
  }
  /** Nose heading of a parked aircraft (bearing of the lead-in, i.e. nose-in). */
  private standHeading(g: GateState): number {
    const s = this.standOf(g);
    if (s) return s.headingIn;
    const gx = this.gateXY(g), nx = this.nodeXY(g.nodeId);
    if (nx && dist(gx, nx) > 3) return headingTo(nx, gx);
    const n = this.air.nodes.get(g.nodeId);
    const e = n?.edges[0]; const ex = e ? this.nodeXY(e.to) : null;
    return ex && nx ? (headingTo(nx, ex) + 90) % 360 : 0;
  }

  private initSystems() {
    const ends = this.manifestEnds();
    this.safe('weather', () => this.weather.init({
      icao: this.air.icao, time: this.time, initial: null, script: [], ends,
      activeDep: this.activeEnds('dep').map(r => r.name), activeArr: this.activeEnds('arr').map(r => r.name), airportName: this.airportName,
    }, this.wxRng), undefined);
    const st = this.stationsXY();
    this.safe('fleet', () => this.fleet.init(this.air, st), undefined);
  }
  private manifestEnds(): RunwayEnd[] {
    return this.runways.map(r => { const e = this.runwayByEnd(r.name)!; return { name: r.name, hdg: r.headingTrue, thr: { lat: e.end.thr.lat, lng: e.end.thr.lng }, lengthFt: Math.round(r.lengthM / FT_TO_M) }; });
  }
  private stationsXY(): VehicleStations {
    const d = defaultStations({ x: 0, y: 0 });
    const s = this.air.stations;
    if (!s) return d;
    const conv = (p: { lng: number; lat: number } | undefined, fb: XY): XY => (p ? this.proj.toXY(p.lat, p.lng) : fb);
    return { fire: conv(s.arff, d.fire), ops: conv(s.ops, d.ops), tugPool: conv(s.tugDepot, d.tugPool), fuelFarm: conv(s.fuelFarm, d.fuelFarm), deicePad: conv(s.deice?.[0], d.deicePad), apron: conv(s.followMeBase, d.apron) };
  }
  /** Run a systems-module call; a "not implemented" stub disables that hook for the session instead of crashing the sim. */
  private safe<T>(name: keyof SimEngine['sys'], fn: () => T, fallback: T): T {
    if (!this.sys[name]) return fallback;
    try { return fn(); } catch (e) { if (isNotImpl(e)) { this.sys[name] = false; return fallback; } throw e; }
  }
  /** Why ground traffic logic is holding an aircraft (null = not held). */
  holdReasonOf(id: number): string | null { const a = this.byId(id); return a ? this.sc(a).holdReason : null; }
  /** Whether a pushback from this stand has a clear lane behind it now (no one taxiing through it or pushing into it). */
  pushLaneClear(a: AircraftState): boolean { return !this.pushLaneBusy(a); }
  /**
   * A flight held on the ground, explained for the controller: why it stopped and what to do. Queues and crossings
   * sort themselves out ("wait"); a standoff (nose to nose, a ring, stuck behind one that will not move) needs the
   * controller: a way round is planned the way the AI ground does it ("reroute", with the clearance to give, which
   * then plans round the blocker), or, with no way round, the other one has to move first ("stuck").
   */
  /** Being towed (or parked by the tug, waiting for the other one to pass): what the flight card says. */
  towNote(a: AircraftState): string | null {
    const t = this.sc(a).tow; if (!t) return null;
    return t.doneAt == null ? `A ramp tug is towing it back clear of ${t.forCs}: neither could pass.` : `Towed clear. It continues to its ${t.dest.kind === 'runway' ? `runway (${t.dest.runway})` : 'stand'} once ${t.forCs} has passed.`;
  }
  /** Jammed pairs: find them (every few seconds), then move the tugs and release the towed aircraft. */
  private wallPolys: XY[][] | null = null;
  /** Is every point of a line at least `m` metres from every terminal and hangar? */
  private clearOfWalls(pts: XY[], m: number): boolean {
    this.wallPolys ??= (this.air.buildings ?? []).filter(b => b.kind === 'terminal' || b.kind === 'hangar').map(b => b.polygon.map(q => this.proj.toXY(q.lat, q.lng)));
    const { cum, total } = arcLengths(pts);
    for (let d = 0; d <= total; d += 10) { const p = sampleAlong(pts, cum, d).pos; for (const g of this.wallPolys) for (let i = 0; i < g.length; i++) if (distToSegment(p, g[i], g[(i + 1) % g.length]) < m) return false; }
    return true;
  }
  private outline(a: AircraftState): Poly[] { return outlineOf(a.perf, a.pos, a.heading); }
  /** Can x go on along its path for `m` metres without its outline coming within `gap` of y where y stands now? (Not
   *  counting a gap it already has.) */
  private clearPast(x: AircraftState, y: AircraftState, m: number, gap = 2.5, strict = false): boolean {
    const p = x.path; if (!p) return false;
    const Y = this.outline(y), now = outlineGap(this.outline(x), Y), need = strict ? (now > gap + 0.2 ? gap : now - 0.01) : Math.min(gap, now - 0.2), wb = wheelbaseM(x), push = x.phase === 'pushback';
    let h = x.heading; const end = Math.min(p.total, x.distAlong + m);
    for (let d = x.distAlong; d <= end; d += 4) {
      const q = sampleAlong(p.pts, p.cum, d);
      if (push) h = (q.heading + 180) % 360; else { const dd = angleDelta(h, q.heading); h = (h + Math.sign(dd) * Math.min(Math.abs(dd), Math.abs(Math.sin(dd * Math.PI / 180)) * 4 / wb * 57.3 + 0.2) + 360) % 360; }
      const pos = push ? advance(q.pos, h, wb) : q.pos;
      if (dist(pos, y.pos) > 110) continue;
      if (outlineGap(outlineOf(x.perf, pos, h), Y) < need) return false;
    }
    return true;
  }
  /** Whether `a`, standing, would roll its next metres into `b`, which is moving past (outlines, the next six seconds). */
  private movesInto(a: AircraftState, b: AircraftState): boolean {
    const pa = a.path, pb = b.path; if (!pa || !pb) return false;
    const v = b.speed * KTS_TO_MPS, now = outlineGap(this.outline(a), this.outline(b));
    const mine = [6, 12, 20].map(m => { const q = sampleAlong(pa.pts, pa.cum, Math.min(pa.total, a.distAlong + m)); const t = Math.sqrt(2 * m / 0.5); return { t, o: outlineOf(a.perf, q.pos, q.heading) }; });
    for (const k of [0, 1.5, 3, 4.5, 6]) {
      const q = sampleAlong(pb.pts, pb.cum, Math.min(pb.total, b.distAlong + v * k)); const o = k === 0 ? this.outline(b) : outlineOf(b.perf, q.pos, q.heading);
      for (const m of mine) if (Math.abs(m.t - k) < 3.5 && outlineGap(m.o, o) < Math.min(3, now - 0.3)) return true;
    }
    return false;
  }
  /** Pushbacks being pulled back in toward their stand to let a taxiing aircraft by, then pushed again. */
  private pullStep(dt: number) {
    for (const a of this.aircraft) {
      const s = this.sc(a), t = s.pull; if (!t) continue;
      if (a.phase !== 'pushback' || a.pushback.stage !== 'pushing' || !a.path) { s.pull = null; continue; }
      const b = this.byId(t.forId);
      const gone = !b || isAirborne(b) || dist(b.pos, a.pos) > 170 || (dist(b.pos, a.pos) > 70 && Math.abs(angleDelta(b.heading, headingTo(b.pos, a.pos))) > 110 && this.clearPast(b, a, 60, 2)) || b.phase === 'parked' || b.phase === 'arrived' || this.time - t.since > 160;
      if (gone) { s.pull = null; continue; }
      a.trafficHold = true; a.speed = 0; s.holdReason = `letting ${b!.callsign} by`;
      if (t.held && b!.speed < 0.3 && a.distAlong > 0 && !this.clearPast(b!, a, 60, 2)) t.held = false;   // not enough after all: further in
      if (t.held || a.distAlong <= 0 || this.clearPast(b!, a, 170)) { t.held = true; continue; }
      a.distAlong = Math.max(0, a.distAlong - 0.9 * dt);
      const q = sampleAlong(a.path.pts, a.path.cum, a.distAlong), dd = angleDelta(a.heading, (q.heading + 180) % 360);
      a.heading = (a.heading + Math.sign(dd) * Math.min(Math.abs(dd), 8 * 0.9 * dt + 0.02) + 360) % 360;
      a.pos = advance(q.pos, a.heading, wheelbaseM(a));
    }
  }
  private towStep(dt: number) {
    this.pullStep(dt);
    for (const a of this.aircraft) {
      const s = this.sc(a), t = s.tow; if (!t) continue;
      if (isAirborne(a) || a.phase !== 'taxi') { s.tow = null; this.manualHold.delete(a.id); continue; }
      a.trafficHold = true; s.holdReason = 'under tow';
      if (t.doneAt == null) {
        // (the ramp crew looks round: not a metre, nor a degree, into somebody standing there)
        { const nd = Math.min(t.total, t.d + 1.5), q = sampleAlong(t.pts, t.cum, nd), swing = t.d >= t.total - 0.01 && t.spin != null ? t.spin : (q.heading + 180) % 360, k = angleDelta(a.heading, swing), nh = (a.heading + Math.sign(k) * Math.min(Math.abs(k), 6) + 360) % 360, O = outlineOf(a.perf, q.pos, nh), now = this.outline(a);
          if (this.aircraft.some(x => x !== a && !isAirborne(x) && dist(x.pos, a.pos) < 120 && (() => { const X = this.outline(x), g = outlineGap(O, X); return g < 1 && g < outlineGap(now, X) - 0.01; })())) {
            a.speed = 0; t.waiting ??= this.time;
            // forty seconds and no room that way: turned round where it stands, or let go and tried again in a minute
            if (this.time - t.waiting > 40) { const sp = t.spin == null ? this.spinHere(a) : null; if (sp != null) { t.total = t.d; t.spin = sp; t.waiting = undefined; } else { t.doneAt = this.time; t.spin ??= a.heading; t.gaveUp = true; } }
            continue;
          } }
        t.waiting = undefined; t.d = Math.min(t.total, t.d + TOW_SPEED_MPS * dt);
        const p = sampleAlong(t.pts, t.cum, t.d);
        a.pos = p.pos; a.speed = TOW_SPEED_MPS / KTS_TO_MPS;
        const want = t.d >= t.total - 0.01 && t.spin != null ? a.heading : (p.heading + 180) % 360, dd = angleDelta(a.heading, want);   // tail first
        a.heading = (a.heading + Math.sign(dd) * Math.min(Math.abs(dd), 10 * dt) + 360) % 360;
        if (t.d >= t.total - 0.01 && t.spin != null && Math.abs(angleDelta(a.heading, t.spin)) > 2) { a.speed = 0; const k = angleDelta(a.heading, t.spin); a.heading = (a.heading + Math.sign(k) * Math.min(Math.abs(k), 6 * dt) + 360) % 360; continue; }
        if (t.d >= t.total - 0.01) { a.speed = 0; t.doneAt = this.time; { const f = this.byId(t.forId); if (f && f.giveWayTo === a.id) f.giveWayTo = null; }   // (room has been made for it: it goes, it no longer gives way)
          this.emit('info', a, `Ramp: ${a.callsign} towed clear, ${t.forCs} can pass`); }
        continue;
      }
      a.speed = 0;
      const b = this.byId(t.forId);
      const away = (x: AircraftState) => { if (dist(x.pos, a.pos) < 140) return false; const p = x.path; if (!p) return true; for (let d = x.distAlong; d <= p.total; d += 12) if (dist(sampleAlong(p.pts, p.cum, d).pos, a.pos) < 70) return false; return true; };
      if (!b || isAirborne(b) || b.phase === 'arrived' || b.phase === 'parked' || t.spin != null || away(b) || this.time - t.doneAt > 130 || (this.time - t.doneAt > 45 && b.trafficHold && this.sc(b).blockedById === a.id && (t.gaveUp = true))) {
        // the way on from here starts behind it: the tug turns it round before letting go
        if (t.spin == null && !t.gaveUp) { const q = this.planTaxi(a, t.dest, []); const f = 'code' in q ? null : q.path.pts.find(z => dist(z, a.pos) > 25); const sp = f && Math.abs(angleDelta(a.heading, headingTo(a.pos, f))) > 100 ? this.spinHere(a) : null; if (sp != null) { t.spin = sp; t.doneAt = null; t.waiting = undefined; t.d = t.total; continue; } }
        s.tow = null; this.manualHold.delete(a.id); a.trafficHold = false; s.lastTowAt = t.gaveUp ? this.time - 240 : this.time; s.heldSince = null;
        // a fresh route from where the tug left it (the old one ran through the other aircraft)
        a.path = null; a.distAlong = 0;
        const plan = this.planTaxi(a, t.dest, []);
        const hs = 'code' in plan ? null : plan.path.holds!.find(h => !h.isDepartureEntry) ?? null;
        const r = this.cmdTaxi(a, t.dest, [], true, hs ? { kind: 'runway', runway: hs.runway } : null, [], false);
        const via = 'code' in plan ? [] : taxiwaysForPath(this.air, plan.ids).slice(0, 4);
        this.emit('info', a, r.ok ? `Ramp: ${a.callsign} released by the tug, continuing${via.length ? ` via ${via.join(' ')}` : ''}` : `Ramp: ${a.callsign} released by the tug: give it a new taxi clearance`);
      }
    }
    if (Math.floor(this.time / 5) === Math.floor((this.time - dt) / 5)) return;
    for (const a of this.aircraft) {
      const s = this.sc(a);
      // left with no way to go (a tow that ended where no route could be made at once): the crew asks for one
      if (a.phase === 'taxi' && !a.path && !s.tow && a.speed < 0.5 && !a.pendingCmds.length && !a.requests.some(q => q.answeredAt == null) && !this.manualHold.has(a.id)) { s.noPathSince ??= this.time; if (this.time - s.noPathSince > 15) { s.noPathSince = this.time; this.raiseRequest(a, a.plan.kind === 'departure' ? 'taxi' : 'taxi_in'); } } else s.noPathSince = undefined;
      // a pushback told to give way stands in the way itself: pulled back in
      if (a.phase === 'taxi' && a.trafficHold && s.heldSince != null && this.time - s.heldSince > 25 && s.blockedById != null) { const b = this.byId(s.blockedById); if (b && b.phase === 'pushback' && b.pushback.stage === 'pushing' && b.giveWayTo === a.id && !this.sc(b).pull && b.speed < 0.3) { b.giveWayTo = null; this.sc(b).pull = { forId: a.id, since: this.time, held: false }; this.emit('info', b, `Ramp: ${b.callsign} pulled back in, ${a.callsign} to pass`); } }
      // two holding short of the same runway from both sides of one taxiway: neither can ever be cleared across
      const face = !s.tow && a.phase === 'hold_short' && !a.holdReleased && s.stoppedSince != null && this.time - s.stoppedSince > 100 && this.time - s.lastTowAt > 300 ? this.farSideBlocker(a) : null;
      if (face && face.phase === 'hold_short' && face.id > a.id && Math.abs(angleDelta(a.heading, face.heading)) > 120 && (this.sc(face).stoppedSince ?? this.time) < this.time - 60 && !this.aircraft.some(x => this.sc(x).tow && dist(x.pos, a.pos) < 400)) {
        const plans = [a, face].map(x => ({ x, o: x === a ? face : a, t: this.towPlan(x, x === a ? face : a) })).filter(q => q.t).sort((p, q) => p.t!.total - q.t!.total)[0];
        if (plans) { const xs = this.sc(plans.x); plans.x.phase = 'taxi'; plans.x.holdShortRunway = null; plans.x.holdShortNode = null; xs.tow = plans.t; this.manualHold.add(plans.x.id); plans.x.pendingCmds.length = 0; this.emit('info', plans.x, `Ramp: ${plans.x.callsign} and ${plans.o.callsign} face each other across the runway; a tug is towing ${plans.x.callsign} back clear`); continue; }
      }
      if (s.tow || !(a.phase === 'taxi' || (a.phase === 'rollout' && s.vacated)) || !a.trafficHold || s.heldSince == null || this.time - s.heldSince < TOW_AFTER_S || this.time - s.lastTowAt < 300 || s.blockedById == null) continue;
      const b = this.byId(s.blockedById); if (!b || isAirborne(b) || b.speed > 0.5 || this.sc(b).tow) continue;
      // three or four round a junction, each waiting for the next: one that is being pushed goes back in, else a tow
      const ring: AircraftState[] = []; { let c: AircraftState | undefined = a; for (let k = 0; k < 6 && c && c.trafficHold; k++) { ring.push(c); const nx: number | null = this.sc(c).blockedById; c = nx == null ? undefined : this.byId(nx); if (c === a) break; if (c && ring.includes(c)) { c = undefined; } } if (c !== a) ring.length = 0; }
      const push = ring.find(x => x.phase === 'pushback' && x.pushback.stage === 'pushing' && !this.sc(x).pull);
      if (push) { const behind = ring.find(x => this.sc(x).blockedById === push.id); if (behind && behind.phase === 'taxi') { this.sc(push).pull = { forId: behind.id, since: this.time, held: false }; this.emit('info', push, `Ramp: ${push.callsign} pulled back in, ${behind.callsign} to pass`); continue; } }
      const mutual = ring.length > 2 || this.sc(b).blockedById === a.id || Math.abs(angleDelta(a.heading, b.heading)) > 120;
      if (!mutual) continue;
      if (this.aircraft.some(x => this.sc(x).tow && dist(x.pos, a.pos) < 400)) continue;   // one tug at a time round here
      const plans = [a, b].filter(x => x.phase === 'taxi' || (x.phase === 'hold_short' && !x.holdReleased && x.speed < 0.5)).map(x => ({ x, o: x === a ? b : a, t: this.towPlan(x, x === a ? b : a) })).filter(p => p.t);
      // the one with nobody behind it moves (towing the head of a queue only brings up the next in it)
      const best = plans.sort((p, q) => this.queueBehind(p.x, p.o) - this.queueBehind(q.x, q.o) || p.t!.total - q.t!.total)[0]; if (!best) continue;
      if (this.queueBehind(best.x, best.o) > this.queueBehind(best.o, best.x) && this.time - s.heldSince < 125) continue;      // (that one may still be turned round: a little longer)
      const xs = this.sc(best.x);
      if (best.x.phase === 'hold_short') { best.x.phase = 'taxi'; best.x.holdShortRunway = null; best.x.holdShortNode = null; }
      xs.tow = best.t; this.manualHold.add(best.x.id); best.x.pendingCmds.length = 0;
      // the other one goes first now: a give-way it was told to make to the towed one kept it waiting for nobody
      if (best.o.giveWayTo === best.x.id) best.o.giveWayTo = null;
      if (best.x.giveWayTo === best.o.id) best.x.giveWayTo = null;
      this.emit('info', best.x, `Ramp: ${best.x.callsign} and ${best.o.callsign} are stuck nose to nose; a tug is towing ${best.x.callsign} back clear`);
    }
  }
  /** Where a tug could pull `x` to let `o` by: tail first along the lanes behind it (the graph, not its route - a route
   *  re-planned on the spot has nothing behind it) to the first junction, then into a side lane the other one does not
   *  use, 60 m in. Null when there is none within 300 m. */
  private towPlan(x: AircraftState, o: AircraftState): TowState | null {
    const on = new Set(this.runwaysAt(x.pos, HOLD_LINE_M)), since = this.sc(x).heldSince ?? (x.phase === 'hold_short' ? this.sc(x).stoppedSince : null);
    return this.towPlanAny(x, o, pts => {
      // straight back first: a tow that starts across the aircraft swings its tail round on the spot
      { const k = pts.findIndex(q => dist(q, pts[0]) > 12); if (k > 0 && Math.abs(angleDelta((x.heading + 180) % 360, headingTo(pts[0], pts[k]))) > 42) return false; }
      if (!this.clearOfWalls(pts, x.perf.wingspanMeters / 2 + 3)) return false;
      // never onto (or into the protected zone of) a runway it is not in already
      const into = [...new Set(pts.flatMap(q => this.runwaysAt(q, HOLD_LINE_M)))].filter(r => !on.has(r));
      if (!into.length) return true;
      // two and a half minutes nose to nose and no other way (SFO, A and H beside 01L): past the hold line, never on to the
      // strip, with nobody using or coming to that runway
      if (since == null || this.time - since < 150) return false;
      if (pts.some(q => this.runwaysAt(q, STRIP_HALF_M + x.perf.wingspanMeters / 2).some(r => !on.has(r)))) return false;
      return !into.some(ref => this.bothEnds(ref).some(r => !!this.arrivalOnFinal(r.name, 8) || r.occupiedBy.length > 0 || !!this.rollingDeparture(r.name)));
    });
  }
  /** How many aircraft stand waiting behind this one (through one another), the other of the pair left out. */
  private queueBehind(x: AircraftState, not: AircraftState): number {
    const q = new Set<number>([x.id]); for (let n = 0; n !== q.size && q.size < 12;) { n = q.size; for (const y of this.aircraft) if (y !== not && y.trafficHold && !q.has(y.id) && y.phase === 'taxi') { const b = this.sc(y).blockedById; if (b != null && q.has(b)) q.add(y.id); } }
    return q.size - 1;
  }
  /** The heading to turn an aircraft round to on the spot, or null when its wings or tail would reach something. */
  private spinHere(x: AircraftState): number | null {
    if (!this.clearOfWalls([x.pos], x.perf.lengthMeters * 0.75 + 8)) return null;
    const others = [...this.aircraft.filter(y => y !== x && !isAirborne(y) && dist(y.pos, x.pos) < 130).map(y => this.outline(y)), ...this.parked.filter(y => dist(y.pos, x.pos) < 130).map(y => outlineOf(getPerformance(y.type), y.pos, y.heading))];
    for (const dir of [1, -1]) {
      let free = true; for (let k = 15; k <= 180 && free; k += 15) { const O = outlineOf(x.perf, x.pos, (x.heading + dir * k + 360) % 360); free = others.every(Y => outlineGap(O, Y) > 1.5); }
      if (free) return (x.heading + dir * 178 + 360) % 360;
    }
    return null;
  }
  private towPlanAny(x: AircraftState, o: AircraftState, ok: (pts: XY[]) => boolean): TowState | null {
    const dest = this.sc(x).taxiDest; if (!dest) return null;
    const oNear = (q: XY, r: number) => { const op = o.path; if (dist(q, o.pos) < r) return true; if (!op) return false; for (let d = o.distAlong; d <= op.total; d += 10) if (dist(sampleAlong(op.pts, op.cum, d).pos, q) < r) return true; return false; };
    const blocked = (q: XY, r: number) => this.aircraft.some(y => y !== x && y !== o && !isAirborne(y) && dist(y.pos, q) < r);
    const lanes = (id: string, from: string | null) => this.air.nodes.get(id)!.edges.filter(e => e.to !== from && e.type !== 'runway' && !e.runway && !e.leadIn);
    /** Follow a lane from `prevId`->`curId` up to `maxM`, straightest continuation within 45 deg at each node. */
    const follow = (start: XY, prevId: string, curId: string, maxM: number): { pts: XY[]; ids: string[]; run: number } => {
      const pts: XY[] = [start], ids: string[] = []; let run = 0;
      for (let g = 0; g < 60 && run < maxM; g++) {
        const a0 = pts[pts.length - 1], c = this.nodeXY(curId)!, L = dist(a0, c);
        if (run + L >= maxM) { pts.push({ x: a0.x + (c.x - a0.x) * (maxM - run) / L, y: a0.y + (c.y - a0.y) * (maxM - run) / L }); run = maxM; break; }
        pts.push(c); ids.push(curId); run += L;
        const h0 = headingTo(a0, c);
        const on = lanes(curId, prevId).filter(e => Math.abs(angleDelta(h0, headingTo(c, this.nodeXY(e.to)!))) < 45);
        if (!on.length) break;
        const nx = on.reduce((b, e) => (Math.abs(angleDelta(h0, headingTo(c, this.nodeXY(e.to)!))) < Math.abs(angleDelta(h0, headingTo(c, this.nodeXY(b.to)!))) ? e : b));
        prevId = curId; curId = nx.to;
      }
      return { pts, ids, run };
    };
    const onLanes = (): TowState | null => {
    // the lane node behind the tail: nearest node, then the edge out of it that points most nearly backwards
    const startId = this.nearestNodeId(x.pos, 40); if (!startId) return null;
    const back = (x.heading + 180) % 360, sx = this.nodeXY(startId)!;
    let first = lanes(startId, null).filter(e => Math.abs(angleDelta(back, headingTo(sx, this.nodeXY(e.to)!))) < 50)
      .sort((p, q) => Math.abs(angleDelta(back, headingTo(sx, this.nodeXY(p.to)!))) - Math.abs(angleDelta(back, headingTo(sx, this.nodeXY(q.to)!))))[0];
    if (!first) return null;
    // the node may be just behind the aircraft already (or just ahead): either way the walk starts from it
    const walk = follow({ ...x.pos }, startId, first.to, 300);
    const path = [{ ...x.pos }]; if (dist(x.pos, sx) > 3 && Math.abs(angleDelta(back, headingTo(x.pos, sx))) < 90) path.push(sx);
    let prev = startId;
    for (let k = 0; k < walk.ids.length; k++) {
      const id = walk.ids[k], j = this.nodeXY(id)!; path.push(j);
      if (blocked(j, 30)) return null;                       // someone behind it: no room to tow back
      const along = dist(x.pos, j); const inH = headingTo(this.nodeXY(prev)!, j); prev = id;
      if (along < 20) continue;
      for (const e of lanes(id, walk.ids[k - 1] ?? startId)) {
        const t = Math.abs(angleDelta(inH, headingTo(j, this.nodeXY(e.to)!)));
        if (t < 25 || t > 155) continue;                     // along the line itself (G leaves A at 25-30 deg at SFO)
        const br = follow(j, id, e.to, 60);
        if (br.run < 45) continue;
        const end = br.pts[br.pts.length - 1], mid = sampleAlong(br.pts, arcLengths(br.pts).cum, br.run / 2).pos;
        if (oNear(end, 40) || oNear(mid, 30) || blocked(end, 60)) continue;
        const pts = [...path, ...br.pts.slice(1)];
        if (!ok(pts)) continue;
        const { cum, total } = arcLengths(pts);
        return { pts, cum, total, d: 0, forId: o.id, forCs: o.callsign, dest, doneAt: null, startedAt: this.time };
      }
    }
    // no side lane (SFO G leaves A at 14 degrees): straight back along its own lane, past where the other one's route
    // turns off it, to the first point 45 m clear of that route with no one within 60 m
    for (let k = 0; k < walk.ids.length; k++) {
      const j = this.nodeXY(walk.ids[k])!; if (dist(x.pos, j) < 50) continue;
      if (blocked(j, 30)) return null;
      if (oNear(j, 45) || blocked(j, 60)) continue;
      const pts = path.slice(0, path.findIndex(q => q.x === j.x && q.y === j.y) + 1);
      if (pts.length < 2 || !ok(pts)) continue;
      const { cum, total } = arcLengths(pts);
      return { pts, cum, total, d: 0, forId: o.id, forCs: o.callsign, dest, doneAt: null, startedAt: this.time };
    }
    return null; };
    const lane = onLanes(); if (lane) return lane;
    const mine = new Set(this.runwaysAt(x.pos, HOLD_LINE_M));      // (a hold line it stands at is inside that runway's zone already)
    // nothing on the lanes: back the way it came, as far as it takes to be out of the other one's way
    const rev: XY[] = [{ ...x.pos }]; let run = 0;
    for (let k = x.trail.length - 1; k >= 0 && run < 800; k--) {
      const q = x.trail[k], l = rev[rev.length - 1], step = dist(q, l); if (step < 4) continue; if (step > 60) break;
      if (blocked(q, 55) || this.runwaysAt(q, HOLD_LINE_M).some(r => !mine.has(r))) break;
      rev.push({ x: q.x, y: q.y }); run += step;
      if (run > 60 && !oNear(q, 45) && ok(rev)) { const { cum, total } = arcLengths(rev); return { pts: rev, cum, total, d: 0, forId: o.id, forCs: o.callsign, dest, doneAt: null, startedAt: this.time }; }
    }
    // nowhere to wait clear of the other one's way (two on a lane with no side lane for half a mile): after three minutes
    // the tug takes it back far enough to swing, turns it round and it goes another way
    const since = this.sc(x).heldSince ?? (x.phase === 'hold_short' ? this.sc(x).stoppedSince : null) ?? this.sc(o).heldSince ?? this.time; if (this.time - since < (this.queueBehind(x, o) < this.queueBehind(o, x) ? 60 : 125)) return null;
    // (past a hold line only with nobody using that runway or coming to it, and never on to the strip)
    const quiet = (ref: string) => !this.bothEnds(ref).some(r => !!this.arrivalOnFinal(r.name, 5) || r.occupiedBy.length > 0 || !!this.rollingDeparture(r.name));
    const back: XY[] = [{ ...x.pos }]; let m = 0; const need = (x.perf.lengthMeters + o.perf.lengthMeters) * 0.5 + 25;
    for (let k = x.trail.length - 1; k >= 0; k--) {
      const q = x.trail[k], l = back[back.length - 1], step = dist(q, l); if (step < 4) continue; if (step > 60) break;
      if (blocked(q, 60) || this.runwaysAt(q, HOLD_LINE_M).some(r => !mine.has(r) && !quiet(r)) || this.runwaysAt(q, STRIP_HALF_M + x.perf.wingspanMeters / 2).some(r => !mine.has(r))) break;
      back.push({ x: q.x, y: q.y }); m += step;
      if (m > need && Math.abs(angleDelta((x.heading + 180) % 360, headingTo(back[0], back[1]))) < 42 && this.clearOfWalls([q], x.perf.lengthMeters * 0.75 + 8)) { const { cum, total } = arcLengths(back), n = back.length; return { pts: back, cum, total, d: 0, forId: o.id, forCs: o.callsign, dest, doneAt: null, startedAt: this.time, spin: headingTo(back[n - 2], back[n - 1]) }; }
    }
    // just pushed back, or somebody right behind it: turned round where it stands, if its wings and tail clear everything
    const turn = this.spinHere(x);
    if (turn != null) { const pts = [{ ...x.pos }, advance(x.pos, (x.heading + 180) % 360, 0.6)], { cum, total } = arcLengths(pts); return { pts, cum, total, d: 0, forId: o.id, forCs: o.callsign, dest, doneAt: null, startedAt: this.time, spin: turn }; }
    return null;
  }
  groundAdvice(a: AircraftState): GroundAdvice | null {
    if (isAirborne(a) || !a.trafficHold) return null;
    const s = this.sc(a), reason = s.holdReason ?? 'traffic';
    const tn = this.towNote(a); if (tn) return { kind: 'wait', text: tn };
    { const o = s.blockedById != null ? this.byId(s.blockedById) : undefined; if (o && ((this.sc(o).tow?.forId === a.id) || (this.sc(o).pull?.forId === a.id))) return { kind: 'wait', text: `${o.callsign} is being moved out of its way by a tug. It goes on as soon as there is room.`, other: o.callsign }; }
    if (s.pull) { const o = this.byId(s.pull.forId); return { kind: 'wait', text: `Pulled back in by the tug so ${o?.callsign ?? 'the other one'} can pass. The pushback goes on after that.` }; }
    if (this.manualHold.has(a.id)) return { kind: 'wait', text: 'Held on your instruction. Give it a taxi clearance or "continue" to move it.' };
    const b = s.blockedById != null ? this.byId(s.blockedById) : undefined;
    if (!b) return { kind: 'wait', text: `Held: ${reason}. It moves on by itself.` };
    const bs = this.sc(b), heldFor = s.heldSince != null ? this.time - s.heldSince : 0;
    const headOn = Math.abs(angleDelta(a.heading, b.heading)) > 120;
    let ring = false; { let c: AircraftState | undefined = b; for (let k = 0; k < 6 && c; k++) { const nx = this.sc(c).blockedById; if (nx == null || !c.trafficHold) break; if (nx === a.id) { ring = true; break; } c = this.byId(nx); } }
    const stuck = b.speed < 0.5 && (ring || bs.blockedById === a.id || (headOn && (b.phase === 'hold_short' || b.phase === 'parked' || b.phase === 'arrived' || (b.trafficHold && heldFor > 15))));
    if (!stuck) return { kind: 'wait', text: `Held: ${reason}. It moves on once ${b.callsign} is clear.`, other: b.callsign };
    if (s.advice && this.time - s.adviceAt < 3) return s.advice;
    let out: GroundAdvice | null = null;
    // a give-way already given and still no one moves: there is no room to pass, so the one giving way goes another way
    const yielder = a.giveWayTo === b.id ? a : b.giveWayTo === a.id ? b : null;
    if (yielder && yielder !== a) {
      out = { kind: 'wait', other: b.callsign, text: `${b.callsign} is giving way, but there is no room to pass. Send ${b.callsign} another way (its card has the route).` };
      s.advice = out; s.adviceAt = this.time;
      return out;
    }
    if (!headOn && !yielder) {
      // two meeting at an angle (an intersection): one gives way and the other goes first - the later one in id order
      // yields, so both flight cards show the same call
      const [yields, first] = a.id > b.id ? [a, b] : [b, a];
      out = { kind: 'reroute', other: b.callsign, cmd: `${yields.callsign} give way to ${first.callsign}`,
        text: `${a.callsign} and ${b.callsign} are waiting for each other at the junction. Tell ${yields.callsign} to give way: ${first.callsign} goes first.` };
      s.advice = out; s.adviceAt = this.time;
      return out;
    }
    const dest = s.taxiDest;
    if (dest && dest.kind !== 'node') {
      const avoid = new Set<string>();
      const standing = this.aircraft.filter(x => x !== a && !isAirborne(x) && x.speed < 0.5 && !['parked', 'arrived', 'startup'].includes(x.phase) && x.phase !== 'pushback');
      for (const id of this.air.nodes.keys()) { const xy = this.nodeXY(id); if (!xy) continue; if (dist(xy, b.pos) < 70 || standing.some(x => x !== b && dist(xy, x.pos) < 50)) avoid.add(id); }
      this.rerouteAvoid = avoid; const plan = this.planTaxi(a, dest, []); this.rerouteAvoid = null;
      const remaining = a.path ? a.path.total - a.distAlong : 0;
      // a way round only if it really goes round: the new route must keep clear of the blocker
      const clearOfB = !('code' in plan) && !plan.path.pts.some((p, i) => plan.path.cum[i] > 20 && dist(p, b.pos) < (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.75);
      if (!('code' in plan) && clearOfB && plan.path.total <= remaining * 5 + 3000) {
        const names = taxiwaysForPath(this.air, plan.ids);
        s.adviceAvoid = avoid;
        const where = dest.kind === 'runway' ? `runway ${dest.runway}` : `stand ${dest.ref}`;
        out = { kind: 'reroute', other: b.callsign, cmd: `${a.callsign} taxi to ${where}${names.length ? ` via ${names.join(' ')}` : ''}`,
          text: `Stuck ${headOn ? 'nose to nose with' : 'behind'} ${b.callsign}: neither can pass. Send ${a.callsign} round the other way.` };
      }
    }
    out ??= { kind: 'stuck', other: b.callsign, text: `Stuck ${headOn ? 'nose to nose with' : 'behind'} ${b.callsign} and there is no way round from here: move ${b.callsign} first (a new taxi route for it).` };
    s.advice = out; s.adviceAt = this.time;
    return out;
  }
  /** Which systems are live (test API `features()`). */
  systemsAvailable(): Record<'weather' | 'fleet' | 'alerts' | 'emergencies' | 'phrase', boolean> { return { ...this.sys }; }

  // ── weather accessors (stub-tolerant) ──────────────────────────────────────
  wx(): WeatherState { return this.safe('weather', () => this.weather.state(), defaultWeather(this.time)); }
  atisLetter(): string | null { return this.safe('weather', () => this.weather.atis().letter, null); }
  private regenAtis(reason: string, silent = false) {
    this.safe('weather', () => {
      // weather.regenerateAtis queues the `atis` SimEvent itself ("ATIS X — reason"); emitting a second one here doubled the comm-log line.
      this.weather.regenerateAtis(reason, this.activeEnds('dep').map(r => r.name), this.activeEnds('arr').map(r => r.name), this.atisRemarks(), { silent });
    }, undefined);
  }
  private atisRemarks(): string[] {
    const r: string[] = [];
    for (const rs of this.runways) if (rs.status !== 'open' && rs.name < rs.reciprocal) r.push(`Runway ${rs.ref} ${rs.status}`);
    return r;
  }
  windFor(rwyHdgTrue: number): { headKt: number; crossKt: number; crossFrom: 'L' | 'R' } {
    const w = this.wx();
    return windComponents(w.windDirTrue, w.windKt, rwyHdgTrue);
  }
  windSpoken(): { dir: number; kts: number; gust: number } { const w = this.wx(); return { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt }; }

  // ── events / lookup ────────────────────────────────────────────────────────
  emit(type: SimEventType, ac: AircraftState | null, message: string, data?: SimEventData, who?: SimEvent['who']): SimEvent {
    const ev: SimEvent = { type, id: ac?.id ?? -1, callsign: ac?.callsign ?? 'SYSTEM', message, at: this.time, data };
    if (who) ev.who = who;
    if (ac) ev.position = ac.onFrequency;
    // Position reports the pilot makes on his own (holding short, airborne, touchdown, vacated, going around) count as
    // pilot calls for the strip timer, exactly like requests and readbacks do.
    if (ac && (who ?? EVENT_WHO[type]) === 'PILOT' && type !== 'request' && type !== 'readback') ac.lastTransmissionAt = this.time;
    this.pushEvent(ev);
    return ev;
  }
  private pushEvent(ev: SimEvent) {
    this.pendingEvents.push(ev);
    this.events.push(ev);
    if (this.events.length > EVENT_RING) this.events.splice(0, this.events.length - EVENT_RING);
  }
  find(cs: string): AircraftState | undefined { const u = upper(cs); return this.aircraft.find(a => a.callsign === u || a.flightNo === u); }
  byId(id: number): AircraftState | undefined { return this.aircraft.find(a => a.id === id); }
  /** Nodes the next taxi plan must avoid (set around a deadlocked pair by the AI ground for one re-route). */
  private rerouteAvoid: Set<string> | null = null;
  private sc(a: AircraftState): Scratch { let s = this.scratch.get(a.id); if (!s) { s = newScratch(); this.scratch.set(a.id, s); } return s; }
  stageOf(a: AircraftState): Stage { return deriveStage(a, this); }
  telephony(cs: string): string { return telephonyOf(cs, this.settings.region); }

  // ── StageCtx ───────────────────────────────────────────────────────────────
  distToThresholdNM(a: AircraftState, runway: string): number | null {
    if (a.phase === 'landing' && a.path) return distToThresholdFromPathNM(a);
    const thr = this.thresholdXY(runway); if (!thr) return null;
    const ils = this.ilsFor(runway);
    if (ils && a.ilsCaptured) return Math.max(0, distAlongFwd(a.pos, ils)) / NM_TO_M;
    return dist(a.pos, thr) / NM_TO_M;
  }
  isHoldNodeForRunway(nodeId: string, runway: string): boolean {
    const rs = this.runwayState(runway); if (!rs) return false;
    if (this.holdNodes.get(rs.ref)?.has(nodeId)) return true;
    return this.air.holdByNode ? osmIsHoldNode(this.air, nodeId, rs.name) : false;
  }

  counts() {
    let dep = 0, arr = 0, air = 0, gnd = 0, conf = 0;
    for (const a of this.aircraft) {
      if (a.plan.kind === 'departure') dep++; else arr++;
      if (isAirborne(a)) air++; else gnd++;
      if (a.conflict) conf++;
    }
    return { total: this.aircraft.length, dep, arr, air, gnd, conf };
  }

  // ── identity / base ────────────────────────────────────────────────────────
  private bigStand: StandSize | null | undefined;
  /** The largest stand the field has (null: no sizes known). */
  private biggestStand(): StandSize | null {
    if (this.bigStand === undefined) { const z = this.air.stands.map(s => s.size).filter(Boolean).sort(); this.bigStand = z.length ? z[z.length - 1] : null; }
    return this.bigStand;
  }
  private newIdentity(type?: string, allowedWeights?: Set<WeightClass> | null, callsign?: string, stand?: StandSize | null) {
    // two draws whatever happens, so scripted spawns (explicit callsign) read the same seeded stream as always
    const r1 = rng(), r2 = rng();
    let cs = callsign ? upper(callsign) : '';
    let carrier = cs ? AIRLINE_BY_ICAO[cs.slice(0, 3)] ?? null : null;
    if (!cs) {
      carrier = pickCarrier(this.air.icao, r1, r2);
      const fno = 1 + Math.floor(r2 * 998);
      cs = `${carrier.icao}${fno}`;
      let guard = 0;
      const alike = crewLifeOf(this).alike(carrier.icao, this.aircraft.map(a => a.callsign)); if (alike) cs = alike;
      while (this.aircraft.some(a => a.callsign === cs) && guard++ < 20) { carrier = pickCarrier(this.air.icao, rng(), rng()); cs = `${carrier.icao}${1 + ri(998)}`; }
    }
    let m = cs.match(/^([A-Z]{3})(\d+)/);
    let alr = m ? AIRLINE_BY_ICAO[m[1]] ?? null : null;
    // the type comes from the carrier's fleet when it has one that the runway and the stand allow
    const want = { weights: allowedWeights ?? null, stand: stand ?? this.biggestStand(), icao: this.air.icao };   // (never one no stand here can take)
    let fleetType = type ? null : carrier ? pickType(carrier, rng(), want) : null;
    // an airline with nothing that fits is not given some other airline's aircraft: another airline comes
    if (!type && !callsign) for (let k = 0; !fleetType && k < 12; k++) { const c = pickCarrier(this.air.icao, rng() * (k < 8 ? 0.65 : 1), rng()), t = pickType(c, rng(), want); if (t) { carrier = c; fleetType = t; cs = `${c.icao}${1 + ri(998)}`; if (this.aircraft.some(a => a.callsign === cs)) fleetType = null; } }
    m = cs.match(/^([A-Z]{3})(\d+)/); alr = m ? AIRLINE_BY_ICAO[m[1]] ?? null : null;
    const perf = getPerformance(type ?? fleetType ?? randomCommercialTypeOf(allowedWeights));
    return { callsign: cs, flightNo: alr ? `${alr.iata}${m![2]}` : cs, airline: alr?.name ?? (m ? m[1] : 'GA'), perf };
  }
  private base(ident: ReturnType<SimEngine['newIdentity']>, kind: FlightKind, pos: XY, heading: number): AircraftState {
    const a: AircraftState = {
      id: ++this.idc, callsign: ident.callsign, flightNo: ident.flightNo, airline: ident.airline, perf: ident.perf,
      phase: 'parked', plan: { kind }, pos: { ...pos }, heading, speed: 0, altitude: 0,
      targetHeading: heading, targetSpeed: 0, targetAltitude: 0,
      path: null, distAlong: 0, holdReleased: false, trafficHold: false, thresholdDist: 0, takeoffCleared: false,
      navMode: 'heading',
      ilsArmed: false, ilsCaptured: false, gsCaptured: false, assignedRunway: null,
      directTargetXY: null, directTargetName: null, turnDir: null,
      holdFix: null, holdFixName: null, holdInboundHdg: 0, holdTurnDir: 'R',
      holdPhase: 'to_fix', holdTimer: 0,
      cmdAltitude: null, cmdIas: null, expedite: false,
      pendingCmds: [], underControl: false, attention: false,
      route: [], routeIndex: 0, holdingShort: false,
      trail: [{ ...pos }], spawnedAt: this.time,
      ...newAircraftFields(ident.perf.weightClass, this.time),
    };
    a.squawk = this.newSquawk();
    a.clearance.squawk = a.squawk;
    return a;
  }
  private newSquawk(): string {
    for (let i = 0; i < 20; i++) {
      const code = [ri(8), ri(8), ri(8), ri(8)].join('');
      if (/^(7500|7600|7700|1200|2000|0000|1000|1202|7000|7001|7400|7777)$/.test(code) || code.endsWith('00') || this.squawkPool.has(code)) continue;
      this.squawkPool.add(code); return code;
    }
    return '4' + String(ri(700) + 100);
  }

  // ── stands ─────────────────────────────────────────────────────────────────
  /** A stand that is free (not occupied, not reserved, not closed) and has no aircraft parked within 45 m. */
  private freeStand(opts: { prefer?: string | null; needsPushback?: boolean; type?: string } = {}): GateState | null {
    if (opts.prefer) { const g = this.gateByRef(opts.prefer); if (g && !g.closed && g.occupiedBy == null && g.reservedFor == null) { this.evictParked(g.ref); return g; } }
    const free = this.gates.filter(g => !g.closed && g.occupiedBy == null && g.reservedFor == null && !this.parkedByRef.has(g.ref) && (opts.needsPushback == null || g.needsPushback === opts.needsPushback));
    // one the aircraft fits, not blocked by a neighbour in use (and not a widebody's stand for a small one while others are free)
    const fit = opts.type ? free.filter(g => { const z = this.standOf(g)?.size; return !z || sizeFits(opts.type!, z); }) : free;
    // not one somebody is still being pushed out of, or past: it is free from the moment the push is approved, and a 777 was
    // put on A3 while the 737 was still swinging out of it
    const pushing = this.aircraft.filter(a => a.phase === 'pushback' || (a.phase === 'startup' && a.pushback.stage !== 'none'));
    const clear = (g: GateState) => !pushing.some(a => a.plan.gateRef === g.ref || dist(a.pos, this.gateXY(g)) < 120);
    const open = fit.filter(g => !this.clashBusy(g.ref) && clear(g)), okFit = open.length ? open : fit.filter(clear);
    // only parked airframes stand where it would fit: one of them has gone (an A380 was sent to a 777's stand, into the
    // aircraft next to it)
    if (!okFit.length && opts.type) {
      const under = this.gates.filter(g => { const z = this.standOf(g)?.size; return !!z && sizeFits(opts.type!, z) && !g.closed && g.occupiedBy == null && g.reservedFor == null && this.parkedByRef.has(g.ref) && (opts.needsPushback == null || g.needsPushback === opts.needsPushback) && !this.clashBusy(g.ref) && clear(g); });
      if (under.length) { const g = rnd(under); this.evictParked(g.ref); return g; }
    }
    // nothing it fits: the biggest there is
    const z = (g: GateState) => 'ABCDEF'.indexOf(this.standOf(g)?.size ?? 'C');
    const spare = okFit.length ? [] : free.filter(clear), top = spare.length ? Math.max(...spare.map(z)) : 0;
    const cands = okFit.length ? okFit : spare.length ? spare.filter(g => z(g) === top) : fit.length ? fit : free;
    if (!cands.length) return null;
    for (let tries = 0; tries < 12; tries++) {
      const g = rnd(cands);
      const xy = this.gateXY(g);
      if (!this.aircraft.some(a => !isAirborne(a) && dist(a.pos, xy) < 45)) {
        // every stand it fits is next to one it would touch: the parked airframe there has gone
        for (const o of this.clashOf.get(g.ref) ?? []) if (this.parkedByRef.has(o)) this.evictParked(o);
        return g;
      }
    }
    return null;
  }
  private reserveStand(g: GateState, a: AircraftState) { g.reservedFor = a.id; a.reservedStand = g.ref; a.plan.gateRef = g.ref; }
  private occupyStand(g: GateState, a: AircraftState) { g.occupiedBy = a.id; g.reservedFor = null; a.reservedStand = g.ref; a.plan.gateRef = g.ref; }
  private releaseStands(a: AircraftState) { for (const g of this.gates) { if (g.occupiedBy === a.id) g.occupiedBy = null; if (g.reservedFor === a.id) g.reservedFor = null; } }
  // ── static parked population ───────────────────────────────────────────────
  /** Fill the stands the way the airport's traffic profile says they are at the start of a shift (own RNG stream, so
   *  scripted scenarios are untouched). Idempotent. */
  populateParked(scale = 1, max = 180): void {
    this.parkedEnabled = true;
    if (this.parked.length) return;
    const r = subStream('parked');
    const prof = profileOf(this.air.icao);
    const used = new Set(this.aircraft.map(a => a.callsign));
    for (const g of this.gates) {
      if ((g.closed && !this.showOnly(g.ref)) || g.occupiedBy != null || g.reservedFor != null || this.clashBusy(g.ref)) continue;
      const st = this.standOf(g); if (!st) continue;
      const share = (st.type === 'gate' ? prof.occupancy.gate : st.type === 'stand' ? prof.occupancy.stand : prof.occupancy.remote) * scale;
      if (r() >= share) continue;
      const xy = this.gateXY(g);
      if (this.aircraft.some(a => !isAirborne(a) && dist(a.pos, xy) < 45)) continue;
      // a carrier whose fleet fits the stand (Emirates has nothing for a code-C stand: try a few times)
      let carrier = pickCarrier(this.air.icao, r(), r()), type = pickType(carrier, r(), { stand: st.size, icao: this.air.icao });
      for (let t = 0; !type && t < 4; t++) { carrier = pickCarrier(this.air.icao, t < 3 ? r() * 0.65 : r(), r()); type = pickType(carrier, r(), { stand: st.size, icao: this.air.icao }); }
      if (!type) continue;
      let cs = `${carrier.icao}${1 + Math.floor(r() * 998)}`; let guard = 0;
      while ((used.has(cs) || this.parkedByRef.size > 0 && this.parked.some(p => p.callsign === cs)) && guard++ < 10) cs = `${carrier.icao}${1 + Math.floor(r() * 998)}`;
      used.add(cs);
      this.addParked({ id: this.nextParkedId--, callsign: cs, airline: carrier.name, type, standRef: g.ref, pos: xy, heading: this.standHeading(g) });
      if (this.parked.length >= max) break;
    }
  }
  private addParked(p: ParkedAircraft): void { this.parked.push(p); this.parkedByRef.set(p.standRef, p); }
  private evictParked(ref: string): ParkedAircraft | null {
    const p = this.parkedByRef.get(ref); if (!p) return null;
    this.parkedByRef.delete(ref); this.parked = this.parked.filter(x => x !== p); return p;
  }
  /** An arrival that has sat at its stand long enough is retired from the traffic but stays on the apron as a parked airframe. */
  private retireToParked(a: AircraftState): void {
    if (!this.parkedEnabled || !a.plan.gateRef || this.parkedByRef.has(a.plan.gateRef) || this.parked.length >= 180) return;
    const g = this.gateByRef(a.plan.gateRef); if (!g) return;
    const fno = 1 + ri(998); const al = a.callsign.slice(0, 3);
    this.addParked({ id: this.nextParkedId--, callsign: `${al}${fno}`, airline: a.airline, type: a.perf.icaoCode, standRef: g.ref, pos: this.gateXY(g), heading: this.standHeading(g) });
  }
  standOccupant(ref: string): string | null {
    const g = this.gateByRef(ref); if (!g) return null;
    const id = g.occupiedBy ?? g.reservedFor; if (id == null) return null;
    return this.byId(id)?.callsign ?? null;
  }

  // ── spawning ───────────────────────────────────────────────────────────────
  /** Departure spawned PARKED at a reserved stand (master plan §2.2). `atHold` = sandbox "+DEP at hold". */
  spawnDeparture(opts: { atHold?: boolean; type?: string; callsign?: string; stand?: string; runway?: string } = {}): AircraftState | null {
    if (!this.gates.length || !this.air.runways.length) return null;
    const active = this.windFiltered(this.activeEnds('dep').filter(r => r.status === 'open'));
    // with several parallel ends in use, departures gravitate to the one with the fewest arrivals planned (segregated
    // operations happen by themselves: arrivals on one runway, departures on the other)
    const arrOn = (name: string) => this.aircraft.filter(x => x.plan.kind === 'arrival' && isAirborne(x) && x.plan.runway === name).length;
    const leastArr = active.length ? active.reduce((b, r) => (arrOn(r.name) < arrOn(b.name) ? r : b)) : null;
    const endName = opts.runway ? upper(opts.runway) : leastArr ? rnd(active.filter(r => arrOn(r.name) === arrOn(leastArr.name))).name : rnd(this.runways).name;
    const weights = this.spawnWeights(endName);
    // a scripted spawn keeps its own identity; free traffic mostly wakes up a parked airframe (its stand, type, airline)
    let woken: ParkedAircraft | null = null;
    if (!opts.type && !opts.callsign && !opts.stand && this.parked.length && chance(0.8)) {
      const cands = this.parked.filter(p => !this.showOnly(p.standRef) && (!weights || weights.has(getPerformance(p.type).weightClass)) && !this.aircraft.some(a => a.callsign === p.callsign));
      if (cands.length) { woken = rnd(cands); this.evictParked(woken.standRef); }
    }
    const ident = woken ? this.newIdentity(woken.type, weights, woken.callsign) : this.newIdentity(opts.type, weights, opts.callsign);
    const gate = this.freeStand({ prefer: woken?.standRef ?? opts.stand ?? null, type: ident.perf.icaoCode }); if (!gate) { if (woken) this.addParked(woken); return null; }
    const pos = this.gateXY(gate);
    const a = this.base(ident, 'departure', pos, this.standHeading(gate));
    this.occupyStand(gate, a);
    a.needsPushback = gate.needsPushback;
    a.plan.runway = endName;
    a.plan.fix = this.beacons.length > 0 ? rnd(this.beacons).id : rnd(CITIES);
    a.plan.dest = rnd(CITIES);
    a.plan.cruiseAlt = 13000;
    a.plan.taxiRoute = [];
    a.onFrequency = 'ground';
    a.phase = 'parked';
    this.aircraft.push(a);
    const s = this.sc(a);
    s.nextRequestAt = this.time + rf(20, 90);
    s.nextRequestKind = a.needsPushback ? 'pushback' : 'startup';
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) stand ${gate.ref}, departure to ${a.plan.dest} via ${a.plan.fix}, runway ${endName}`);
    if (opts.atHold) this.placeAtHold(a, endName);
    return a;
  }

  /** Arrival at a weighted boundary entry with spacing/weight filtering (B11) and a reserved stand (B21). Falls back to a short final without airspace. */
  spawnArrival(opts: { type?: string; callsign?: string; entryKey?: string } = {}): AircraftState | null {
    if (!this.entries.length) return this.spawnArrivalShortFinal(opts);
    const arrEnds = this.activeEnds('arr').filter(r => r.status === 'open');
    // flow control: the centre holds further arrivals outside while the TMA has ARR_FLOW_PER_FAMILY not yet established
    // per runway direction in use (the level ladder has seven rungs; beyond that the whole stack seized, 16 arrivals
    // circling at 3-17,000 ft and nobody landing)
    if (!opts.callsign && this.settings.arrivalFlow) {
      const fams: number[] = []; for (const r of arrEnds) if (!fams.some(h => Math.abs(angleDelta(h, r.headingTrue)) < 15)) fams.push(r.headingTrue);
      const inbound = this.aircraft.filter(a => a.plan.kind === 'arrival' && isAirborne(a) && !a.ilsCaptured && a.phase !== 'landing').length;
      if (fams.length && inbound >= ARR_FLOW_PER_FAMILY * fams.length) return null;
    }
    // weight filter: the type must be allowed on at least one active arrival runway
    let allowed: Set<WeightClass> | null = null;
    if (arrEnds.length && arrEnds.some(r => r.weightAllow && r.weightAllow.length)) {
      allowed = new Set<WeightClass>();
      for (const r of arrEnds) for (const w of (r.weightAllow ?? ['L', 'M', 'H', 'S'] as WeightClass[])) allowed.add(w);
    }
    const ident = this.newIdentity(opts.type, allowed, opts.callsign);
    // weighted entry pick, avoiding an entry that had a spawn < 120 s / < 4 NM ago
    const order = this.weightedEntries();
    let entry = opts.entryKey ? this.entries.find(e => e.key === opts.entryKey) ?? order[0] : order[0];
    let pos = { x: entry.x, y: entry.y };
    for (const cand of (opts.entryKey ? [entry] : order)) {
      const last = this.entryLast.get(cand.key);
      const lastAc = last ? this.byId(last.id) : undefined;
      const tooClose = last && lastAc && isAirborne(lastAc) && (this.time - last.at < 120 || dist(lastAc.pos, { x: cand.x, y: cand.y }) < 4 * NM_TO_M);
      if (!tooClose) { entry = cand; pos = { x: cand.x, y: cand.y }; break; }
      // queue behind the previous spawn on the inbound track: radar minimum + 1 NM, or the wake minimum + 1 NM behind a heavier leader (B11: never co-located)
      const lead: WakeCategory = lastAc!.perf.b757 ? 'HEAVY' : lastAc!.wakeCategory;
      const needNM = Math.max(4, WAKE_FINAL_NM[lead][WAKE_CATEGORY_BY_CLASS[ident.perf.weightClass]] + 1);
      const along = alongTrack(lastAc!.pos, { x: cand.x, y: cand.y }, cand.heading); // + = already inside the boundary
      const gap = Math.max(0, needNM * NM_TO_M - along);
      entry = cand; pos = advance({ x: cand.x, y: cand.y }, (cand.heading + 180) % 360, gap);
    }
    // vertical stagger: an arrival entering at an altitude already flown by another inbound gets +1000 ft (up to +2000),
    // so converging entries stay separated until the controller sequences them (real STARs are level-separated the same way).
    let altFt = entry.altFt;
    const inbound = this.aircraft.filter(x => x.plan.kind === 'arrival' && isAirborne(x) && !x.ilsCaptured);
    for (let k = 0; k < 2 && inbound.some(x => Math.abs(x.altitude - altFt) < 900); k++) altFt += 1000;
    // (somebody holding at the entry's fix: the centre sends it in above the top of that stack)
    const top = this.aircraft.reduce((m, x) => x.navMode === 'hold' && x.holdFixName === entry.beacon ? Math.max(m, x.cmdAltitude ?? x.targetAltitude) : m, 0);
    if (top && altFt < top + 1000) altFt = Math.min(16000, top + 1000);
    const a = this.spawnArrivalAtEntry(pos, entry.heading, altFt, entry.beacon, { ident, entryKey: entry.key });
    return a;
  }
  private weightedEntries() {
    const list = [...this.entries];
    const out: typeof list = [];
    while (list.length) {
      const total = list.reduce((s, e) => s + e.weight, 0);
      let pick = rng() * total; let idx = 0;
      for (let i = 0; i < list.length; i++) { pick -= list[i].weight; if (pick <= 0) { idx = i; break; } }
      out.push(list.splice(idx, 1)[0]);
    }
    return out;
  }

  /** Spawn an arrival at a boundary entry point (approach-radar style). */
  spawnArrivalAtEntry(pos: XY, heading: number, altFt: number, beacon?: string, opts: { ident?: ReturnType<SimEngine['newIdentity']>; entryKey?: string; type?: string; callsign?: string } = {}): AircraftState | null {
    if (!this.gates.length) return null;
    const ident = opts.ident ?? this.newIdentity(opts.type, null, opts.callsign);
    const a = this.base(ident, 'arrival', pos, heading);
    a.altitude = altFt; a.targetAltitude = altFt;
    a.speed = Math.min(250, a.perf.maxAirspeedTMA);
    a.targetSpeed = a.speed;
    a.phase = 'approach';
    a.plan.fix = beacon ?? rnd(CITIES);
    a.plan.dest = this.air.icao;
    a.navMode = 'heading';
    a.attention = true;
    a.cmdAltitude = altFt;
    a.onFrequency = 'approach';
    a.fuelMin = Math.round(rf(45, 120));
    const gate = this.freeStand({ type: a.perf.icaoCode });
    if (gate) this.reserveStand(gate, a); else a.plan.gateRef = rnd(this.gates).ref;
    // expected runway: best active arrival end for the class (nearest to the entry heading)
    const cands = this.windFiltered(this.activeEnds('arr').filter(r => r.status === 'open' && this.weightAllowed(r.name, a.perf.weightClass)));
    // ... and arrivals to the parallel end with the fewest departures on it (nearest heading among equals)
    const depOn = (name: string) => this.aircraft.filter(x => x.plan.kind === 'departure' && !isAirborne(x) && x.plan.runway === name).length;
    const fewest = cands.length ? Math.min(...cands.map(r => depOn(r.name))) : 0;
    const pool = cands.filter(r => depOn(r.name) === fewest);
    if (pool.length) a.plan.runway = pool.reduce((best, r) => (Math.abs(angleDelta(heading, r.headingTrue)) < Math.abs(angleDelta(heading, best.headingTrue)) ? r : best)).name;
    this.aircraft.push(a);
    const s = this.sc(a);
    if (opts.entryKey) { s.entryKey = opts.entryKey; this.entryLast.set(opts.entryKey, { at: this.time, id: a.id }); }
    s.nextRequestAt = this.time + 2; s.nextRequestKind = 'with_you';
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) inbound via ${a.plan.fix}, ${Math.round(altFt)} ft, hdg ${hdg3(heading)}, stand ${a.plan.gateRef}`);
    return a;
  }

  /** Fallback (no airspace data): arrival on an 11 km final of an active end. */
  spawnArrivalShortFinal(opts: { type?: string; callsign?: string; /** Metres to run (11 km unless given). */ distM?: number } = {}): AircraftState | null {
    if (!this.gates.length || !this.air.runways.length) return null;
    const ends = this.activeEnds('arr').filter(r => r.status === 'open' && !this.runwayOccupied(r.name));
    const end = ends.length ? rnd(ends) : rnd(this.runways);
    const ident = this.newIdentity(opts.type, this.spawnWeights(end.name), opts.callsign);
    const thr = this.thresholdXY(end.name)!;
    const distM = opts.distM ?? 11000, altFt = opts.distM ? Math.max(1200, Math.round(distM * 0.0524 * 3.281 / 100) * 100) : 2000;   // on the 3 degree path
    const start = advance(thr, (end.headingTrue + 180) % 360, distM);
    const a = this.base(ident, 'arrival', start, end.headingTrue);
    a.plan.runway = end.name; a.plan.fix = rnd(CITIES); a.plan.dest = this.air.icao;
    const gate = this.freeStand({ type: a.perf.icaoCode }); if (gate) this.reserveStand(gate, a); else a.plan.gateRef = rnd(this.gates).ref;
    a.altitude = altFt; a.targetAltitude = altFt; a.speed = 180; a.targetSpeed = 180; a.phase = 'approach';
    a.onFrequency = 'tower'; a.fuelMin = Math.round(rf(45, 120));
    this.aircraft.push(a);
    this.execILS(a, end.name);
    a.ilsCaptured = true; a.gsCaptured = true;
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) ${Math.round(distM / 1852)} NM final runway ${end.name}`);
    return a;
  }

  /** Place a departure at the full-length hold node of `endName` in hold_short (sandbox / spawnAt). */
  private placeAtHold(a: AircraftState, endName: string) {
    const rs = this.runwayState(endName); const r = this.runwayByEnd(endName);
    if (!rs || !r) return;
    const thr = this.endXY(r.end);
    const holds = [...(this.holdNodes.get(rs.ref) ?? [])];
    if (!holds.length) return;
    const entry = this.air.holdByNode ? holdForRunwayEntry(this.air, rs.name, r.end.nodeId) : null;
    const holdId = entry && this.holdNodeInfo.has(entry.nodeId) ? entry.nodeId : holds.reduce((best, id) => (dist(this.nodeXY(id)!, thr) < dist(this.nodeXY(best)!, thr) ? id : best));
    const info = this.holdNodeInfo.get(holdId)!;
    const hx = this.nodeXY(holdId)!, rx = this.nodeXY(info.runwayNodeId)!;
    const back = advance(hx, headingTo(rx, hx), 60);
    const path = this.buildPath([back, hx, rx], 'taxi');
    const at = projectOntoPath(path.pts, path.cum, hx).at;
    path.holds = [{ nodeId: holdId, runway: rs.name, at, isDepartureEntry: true }];
    path.holdAt = at;
    a.path = path; a.distAlong = Math.max(0, at - HOLD_BUFFER_M); a.holdReleased = false;
    const sm = sampleAlong(path.pts, path.cum, a.distAlong);
    a.pos = { ...sm.pos }; a.heading = sm.heading;
    a.speed = 0; a.phase = 'hold_short'; a.holdShortNode = holdId; a.holdShortRunway = rs.name;
    a.plan.runway = rs.name; a.onFrequency = 'tower';
    a.startup.enginesStable = true; a.startup.startedAt = this.time - 300; a.startup.readyAt = this.time - 120;
    a.pushback.stage = 'complete';
    this.releaseStands(a); a.reservedStand = null;
    this.sc(a).stoppedSince = this.time - 60;
    this.sc(a).nextRequestAt = this.time + 3; this.sc(a).nextRequestKind = 'ready';
  }

  /** Deterministic test factory (05 §2.2 SpawnSpec). */
  spawnAt(spec: SpawnSpec): AircraftState {
    const kind = spec.kind;
    const runway = spec.runway ? upper(spec.runway) : spec.plan?.runway ? upper(spec.plan.runway) : undefined;
    const ident = this.newIdentity(spec.type, null, spec.callsign);
    let a: AircraftState;
    const ground = ['parked', 'startup', 'pushback', 'taxi', 'hold_short', 'lineup', 'takeoff', 'rollout', 'arrived'].includes(spec.phase);
    if (ground && !spec.posRel && !spec.posLL) {
      const gate = spec.gate ? this.gateByRef(spec.gate) ?? null : (!spec.taxiwayNode && ['parked', 'startup', 'pushback', 'taxi'].includes(spec.phase) ? this.freeStand() : null);
      if (spec.gate && gate) this.evictParked(gate.ref);
      const pos = gate ? this.gateXY(gate) : spec.taxiwayNode ? this.nodeXY(spec.taxiwayNode) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
      a = this.base(ident, kind, pos, gate ? this.standHeading(gate) : 0);
      a.synthetic = false;
      a.plan.runway = runway ?? (this.activeEnds(kind === 'departure' ? 'dep' : 'arr')[0]?.name);
      a.plan.fix = spec.plan?.fix ?? (this.beacons[0]?.id ?? rnd(CITIES));
      a.plan.cruiseAlt = spec.plan?.cruiseAlt ?? 13000;
      a.plan.dest = kind === 'arrival' ? this.air.icao : rnd(CITIES);
      this.aircraft.push(a);
      if (gate) { if (kind === 'departure' || spec.phase === 'arrived') this.occupyStand(gate, a); else this.reserveStand(gate, a); a.needsPushback = gate.needsPushback; }
      if (spec.plan?.gateRef) a.plan.gateRef = spec.plan.gateRef;
      a.onFrequency = spec.onFrequency ?? (kind === 'departure' ? 'ground' : 'ground');
      switch (spec.phase) {
        case 'parked': a.phase = 'parked'; break;
        case 'arrived': a.phase = 'arrived'; break;
        case 'startup': this.execStartup(a, a.plan.runway ?? null); break;
        case 'pushback': a.startup.enginesStable = true; a.startup.startedAt = this.time; a.startup.readyAt = this.time; this.execPushback(a, 'any', a.plan.runway ?? null, false, null); break;
        case 'taxi': {
          a.startup.enginesStable = true; a.startup.startedAt = this.time - 200; a.startup.readyAt = this.time - 60; a.pushback.stage = 'complete';
          if (gate) { const st = this.standOf(gate); const nx = this.nodeXY(st?.entryNodeId ?? gate.nodeId); if (nx) { a.pos = { ...nx }; a.heading = st ? (st.pushbackHeading + 180) % 360 : a.heading; } }
          this.releaseStands(a); a.reservedStand = null;
          a.phase = 'taxi';
          const dest = spec.taxiTo ?? runway;
          if (dest) { const g = this.gateByRef(dest); this.execTaxi(a, g ? { kind: 'stand', ref: g.ref } : { kind: 'runway', runway: upper(dest), intersection: null }, [], true, null, [], false); }
          // already rolling along the lane: pointed down the route when nose-in at the entry node would mean swinging
          // round (more than 90 deg - the bicycle model creeps through a U-turn on the spot)
          if (a.path && a.path.total > 5) { const h = sampleAlong(a.path.pts, a.path.cum, 5).heading; if (Math.abs(angleDelta(a.heading, h)) > 90) { a.heading = h; a.targetHeading = h; } }
          break;
        }
        case 'hold_short': if (runway) this.placeAtHold(a, runway); break;
        case 'lineup': case 'takeoff': case 'rollout': {
          if (!runway) break;
          const rs = this.runwayState(runway)!; const thr = this.thresholdXY(runway)!;
          const p = advance(thr, rs.headingTrue, spec.phase === 'rollout' ? 600 : LINEUP_ADVANCE_M);
          a.pos = p; a.heading = rs.headingTrue; a.targetHeading = rs.headingTrue;
          a.startup.enginesStable = true; a.pushback.stage = 'complete'; a.onFrequency = spec.onFrequency ?? 'tower';
          this.releaseStands(a); a.reservedStand = null;
          if (spec.phase === 'lineup') { a.phase = 'lineup'; this.addOccupant(runway, a, 'lineup'); this.sc(a).luawAt = this.time; }
          else if (spec.phase === 'takeoff') { this.beginRoll(a, runway); a.takeoffCleared = true; }
          else { this.startRollout(a, runway, 600); a.speed = spec.speedKts ?? a.perf.approachSpeed - 5; }
          break;
        }
      }
    } else {
      let pos: XY = { x: 0, y: 0 }; let heading = spec.heading ?? 0; let alt = spec.altFt ?? 5000;
      if (spec.posRel) {
        const rs = this.runwayState(spec.posRel.fromRunway); const thr = this.thresholdXY(spec.posRel.fromRunway);
        if (rs && thr) {
          pos = advance(thr, rs.headingTrue, spec.posRel.alongNM * NM_TO_M);
          if (spec.posRel.offsetNM) pos = advance(pos, (rs.headingTrue + 90) % 360, spec.posRel.offsetNM * NM_TO_M);
          heading = spec.heading ?? rs.headingTrue; alt = spec.posRel.altFt;
        }
      } else if (spec.posLL) { pos = this.proj.toXY(spec.posLL.lat, spec.posLL.lng); alt = spec.posLL.altFt; }
      a = this.base(ident, kind, pos, heading);
      a.synthetic = false;
      a.altitude = alt; a.targetAltitude = spec.targets?.alt ?? alt; a.cmdAltitude = a.targetAltitude;
      a.speed = spec.speedKts ?? Math.min(250, a.perf.maxAirspeedTMA); a.targetSpeed = spec.targets?.ias ?? a.speed;
      if (spec.targets?.ias != null) a.cmdIas = spec.targets.ias;
      a.targetHeading = spec.targets?.hdg ?? heading;
      a.phase = spec.phase === 'go_around' ? 'go_around' : 'approach';
      if (spec.phase === 'go_around') a.goAround = true;
      a.plan.runway = runway; a.plan.fix = spec.plan?.fix ?? (this.beacons[0]?.id ?? rnd(CITIES)); a.plan.cruiseAlt = spec.plan?.cruiseAlt ?? 13000;
      a.plan.dest = kind === 'arrival' ? this.air.icao : rnd(CITIES);
      a.onFrequency = spec.onFrequency ?? (kind === 'departure' ? 'departure' : 'approach');
      a.fuelMin = kind === 'arrival' ? 90 : null;
      this.aircraft.push(a);
      if (kind === 'arrival') { const g = spec.plan?.gateRef ? this.gateByRef(spec.plan.gateRef) : this.freeStand(); if (g) this.reserveStand(g, a); }
      if (spec.plan?.gateRef) a.plan.gateRef = spec.plan.gateRef;
      if (kind === 'departure') { a.navMode = 'sid'; a.targetAltitude = spec.targets?.alt ?? Math.max(alt, a.clearance.initialAlt); }
      if (spec.ils) this.execILS(a, upper(spec.ils));
      if (spec.hold) this.execHold(a, upper(spec.hold.fix), spec.hold.inbound ?? null, spec.hold.dir ?? null, null, null, null);
      if (spec.landingCleared && a.plan.runway) { a.landingCleared = true; a.landingClearedAt = this.time; const rs = this.runwayState(a.plan.runway); if (rs) this.setLandingClearance(rs, a.callsign, true); }
      a.underControl = true; a.attention = false;
    }
    if (spec.emergency) this.declareEmergency(a, spec.emergency);
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) test spawn ${spec.phase}`);
    return a;
  }

  remove(id: number, reason: 'arrived' | 'departed' | 'diversion' | 'fuel_exhaustion' | 'collision' | 'test' = 'test') {
    const a = this.byId(id); if (!a) return;
    this.releaseStands(a);
    for (const rs of this.runways) { this.removeOccupant(rs.ref, a.id); rs.landingClearances = rs.landingClearances.filter(c => c !== a.callsign); if (rs.takeoffClearance === a.callsign) rs.takeoffClearance = null; }
    this.scratch.delete(a.id);
    this.readbacks = this.readbacks.filter(r => r.aircraftId !== a.id);
    this.aircraft = this.aircraft.filter(x => x.id !== id);
    this.emit('removed', a, `${a.callsign} removed (${reason})`, { type: 'removed', reason });
  }
  clear() {
    for (const a of [...this.aircraft]) this.remove(a.id, 'test');
    this.aircraft = []; this.conflictPairs.clear(); this.scratch.clear(); this.readbacks = [];
    for (const g of this.gates) { g.occupiedBy = null; g.reservedFor = null; }
    for (const rs of this.runways) { rs.occupiedBy.length = 0; rs.landingClearances = []; rs.takeoffClearance = null; }
    this.entryLast.clear();
  }

  // ── paths ──────────────────────────────────────────────────────────────────
  /** `wide`: corners at these points are on an apron (a stand's lead-in meeting its lane) and take the full turn radius;
   *  elsewhere a corner must stay on a 23 m taxiway. */
  private buildPath(raw: XY[], kind: DrivePath['kind'], holdAtEnd = false, wide: XY[] = []): DrivePath {
    const clean = dedupeBacktracks(kind === 'taxi' ? straightenJogs(this.straightCrossings(raw)) : raw, 3);
    // ground paths: every corner is one circular arc tangent to both legs, then a light pass to settle what is left
    const R = (c: XY) => (wide.some(w => dist(w, c) < 1.5) ? APRON_TURN_RADIUS_M : TAXI_TURN_RADIUS_M);
    const pts = kind === 'taxi' || kind === 'pushback' ? smoothPath(filletCorners(clean, R), 5)
      : kind === 'runway' ? smoothPath(filletCorners(clean, RUNWAY_ENTRY_RADIUS_M), 4)
      : chaikin(resample(clean, 30), 3);
    const { cum, total } = arcLengths(pts);
    return { pts, cum, total, kind, holdAt: holdAtEnd ? total : undefined };
  }
  /** A pushback path from its corner points. */
  pushPathOf(raw: XY[], r: number): DrivePath {
    const pts = smoothPath(filletCorners(dedupeBacktracks(raw, 2), r), 5), { cum, total } = arcLengths(pts);
    return { pts, cum, total, kind: 'pushback' };
  }
  /** A runway crossing goes straight across: the points on the runway between one either side of it are dropped. The
   *  graph's crossing node on the centreline often sits off the line between the two sides, and the path bulged up
   *  the runway to reach it. */
  private straightCrossings(raw: XY[]): XY[] {
    const out: XY[] = [];
    for (let i = 0; i < raw.length; i++) {
      out.push(raw[i]);
      for (const rw of this.air.runways) {
        const sg = this.runwaySegment(rw.ref); if (!sg) continue;
        const on = (p: XY) => distToSegment(p, sg.a, sg.b) < 40;
        if (on(raw[i])) continue;
        let k = i + 1; while (k < raw.length && on(raw[k])) k++;
        if (k === i + 1 || k >= raw.length) continue;
        const side = (p: XY) => Math.sign((sg.b.x - sg.a.x) * (p.y - sg.a.y) - (sg.b.y - sg.a.y) * (p.x - sg.a.x));
        // only a crossing that is nearly straight already (the bulge to an off-line centreline node): a taxiway meeting
        // the runway on a slant (SFO Q onto K across 28R) was cut off as one chord 40 m across the grass
        let bulge = 0; for (let m = i + 1; m < k; m++) bulge = Math.max(bulge, distToSegment(raw[m], raw[i], raw[k]));
        if (side(raw[i]) !== side(raw[k]) && bulge < 12) { i = k - 1; break; }
      }
    }
    return out;
  }
  /** A route that runs out along one curve of a junction and doubles straight back (its start node lay on the wrong fillet)
   *  is driven as the turn itself: the spur is left out. `from` / `heading`: where the aircraft stands and points. */
  private cutSpurs(ids: string[], from?: XY, heading?: number): string[] {
    const id = [...(from ? [''] : []), ...ids], P = id.map(q => (q ? this.nodeXY(q) : from) ?? null);
    if (P.some(p => !p) || P.length < 4) return ids;
    const X = P as XY[];
    for (let t = 1; t < X.length - 2 && t < 400; t++) {
      if (dist(X[t - 1], X[t]) < 0.5 || dist(X[t], X[t + 1]) < 0.5 || Math.abs(angleDelta(headingTo(X[t - 1], X[t]), headingTo(X[t], X[t + 1]))) < 105) continue;
      if (this.runwaysAt(X[t], 60).length) continue;
      // the widest cut that joins up: from a point before the tip to one after it, near each other, turning no more than 100
      let cut: [number, number] | null = null;
      for (let i = t - 1, out = 0; i >= 0; i--) {
        out += dist(X[i], X[i + 1]); if (out > 80) break;
        const inH = i > 0 ? headingTo(X[i - 1], X[i]) : heading; if (inH == null) break;
        for (let j = t + 1, back = 0; j < X.length; j++) {
          back += dist(X[j - 1], X[j]); if (back > 115) break;
          const d = dist(X[i], X[j]); if (d < 6 || d > (i === 0 ? 75 : 45)) continue;
          if (Math.abs(angleDelta(inH, headingTo(X[i], X[j]))) > 85) continue;
          if (j + 1 < X.length && Math.abs(angleDelta(headingTo(X[i], X[j]), headingTo(X[j], X[j + 1]))) > 80) continue;
          cut = [i, j];
        }
      }
      if (!cut) continue;
      X.splice(cut[0] + 1, cut[1] - cut[0] - 1); id.splice(cut[0] + 1, cut[1] - cut[0] - 1); t = Math.max(0, cut[0] - 1);
    }
    return id.filter(q => q !== '');
  }
  /** Build a taxi DrivePath through node ids (also used by the vehicle fleet). Holds are derived from the route. */
  pathFromNodes(ids: string[], holdAtEnd = false, from?: XY, turn?: { heading: number; radiusM: number }): DrivePath | null {
    const raw: XY[] = [], all = ids;
    if (turn && this.air.icao === 'WSSS') ids = this.cutSpurs(ids, from, turn.heading);   // (Changi's zigzags; the other fields' lines were settled without it)
    if (from) raw.push({ ...from });
    // a route that starts behind the nose (no forward way out): the aircraft turns round on a half circle toward the
    // side the route lies on instead of pivoting on its nose wheel
    if (from && turn) {
      const first = ids.map(id => this.nodeXY(id)).find((p): p is XY => !!p && dist(from, p) > 25);
      if (first && Math.abs(angleDelta(turn.heading, headingTo(from, first))) > 110) {
        const side = angleDelta(turn.heading, headingTo(from, first)) >= 0 ? 1 : -1;
        const centre = advance(from, (turn.heading + side * 90 + 360) % 360, turn.radiusM);
        const start = headingTo(centre, from);
        for (let k = 1; k <= 12; k++) raw.push(advance(centre, (start + side * k * 15 + 360) % 360, turn.radiusM));
        // rejoin the route at its first node ahead of the turned-round nose (the ones beside / behind it are passed)
        const end = raw[raw.length - 1], back = (turn.heading + 180) % 360;
        let k0 = ids.findIndex(id => { const xy = this.nodeXY(id); return !!xy && dist(end, xy) > 10 && dist(end, xy) < 150 && Math.abs(angleDelta(back, headingTo(end, xy))) < 60; });
        // none ahead within 150 m: the first one roughly ahead, else the route node nearest the turned-round aircraft (the
        // fallback to the LAST node drew one straight line from the turn to the stand, across the terminal)
        if (k0 < 0) k0 = ids.findIndex(id => { const xy = this.nodeXY(id); return !!xy && dist(end, xy) > 10 && Math.abs(angleDelta(back, headingTo(end, xy))) < 60; });
        if (k0 < 0) { let bd = Infinity; ids.forEach((id, k) => { const xy = this.nodeXY(id); if (xy && dist(end, xy) < bd) { bd = dist(end, xy); k0 = k; } }); }
        for (const id of ids.slice(k0)) { const xy = this.nodeXY(id); if (xy) raw.push(xy); }
        const path = this.buildPath(raw, 'taxi', holdAtEnd);
        path.holds = this.computeHolds(all, path);
        path.holdAt = path.holds.length ? path.holds[0].at : (holdAtEnd ? path.total : undefined);
        return path;
      }
    }
    // route nodes just behind the nose (the push ends a few metres past the lane node) are passed already: stepping
    // back to one drew a hook that swung 30 m off the line
    let s0 = 0;
    if (from && turn) while (s0 < ids.length - 1) { const xy = this.nodeXY(ids[s0]); if (!xy || dist(from, xy) >= 30 || Math.abs(angleDelta(turn.heading, headingTo(from, xy))) <= 100) break; s0++; }
    for (const id of ids.slice(s0)) { const xy = this.nodeXY(id); if (xy) raw.push(xy); }
    if (raw.length < 2) return null;
    const path = this.buildPath(raw, 'taxi', holdAtEnd);
    path.holds = this.computeHolds(all, path);
    path.holdAt = path.holds.length ? path.holds[0].at : (holdAtEnd ? path.total : undefined);
    return path;
  }
  /** Hold-short PLACES along a node route: one per runway entered (crossing or departure entry) — B4. Arc-lengths re-projected onto the resampled path. */
  private computeHolds(ids: string[], path: DrivePath): PathHold[] {
    const raw = holdsOnPath(this.air, ids);
    const holds: PathHold[] = [];
    let lastAt = 0;
    const scale = path.total / Math.max(1, rawLength(this.air, ids));
    for (const h of raw) {
      const xy = this.nodeXY(h.nodeId); if (!xy) continue;
      // holdsOnPath's `at` is along the raw node polyline; the resampled/smoothed path is slightly shorter, so search a window around the scaled hint
      const hint = h.at * scale;
      const pr = projectOntoPath(path.pts, path.cum, xy, Math.max(lastAt, hint - 250), 500);
      // an OSM hold node drawn inside the runway strip (common where runways cross) would park the aircraft in the
      // incursion zone: pull the hold back along the path until it is clear of the strip
      let at = pr.at;
      const rsH = this.runwayState(h.runway);
      if (rsH) for (let k = 0; k < 70 && at > lastAt + 5 && this.distToRunway(sampleAlong(path.pts, path.cum, at).pos, rsH.ref) < STRIP_HALF_M + 18; k++) at -= 5;
      holds.push({ nodeId: h.nodeId, runway: h.isDepartureEntry ? upper(h.runway) : this.endInUse(this.refOf(h.runway))?.name ?? upper(h.runway), at, isDepartureEntry: h.isDepartureEntry });
      lastAt = at;
      if (!this.holdNodeInfo.has(h.nodeId)) {
        const rs = this.runwayState(h.runway);
        if (rs) { const set = this.runwayNodes.get(rs.ref); let best: string | null = null, bd = Infinity; for (const rid of set ?? []) { const d = dist(xy, this.nodeXY(rid)!); if (d < bd) { bd = d; best = rid; } } if (best) this.holdNodeInfo.set(h.nodeId, { ref: rs.ref, runwayNodeId: best }); }
      }
    }
    // Geometric safety net: where the path enters a runway strip without a hold from the OSM topology (a crossing
    // drawn without a shared node, a taxiway cutting a corner of the strip), add a hold at the strip edge.
    const step = 8;
    let inside = new Set<string>();
    for (let at = 0; at <= path.total; at += step) {
      const pos = sampleAlong(path.pts, path.cum, at).pos;
      const now = new Set(this.runwaysAt(pos, STRIP_HALF_M + 18));
      if (at > 0) for (const ref of now) {
        if (inside.has(ref)) continue;
        const rs = this.bothEnds(ref)[0]; if (!rs) continue;
        // (a hold line up to 220 m before the edge covers this entry; one further along the path does not - the
        // strip is entered before it)
        if (holds.some(h => this.refOf(h.runway) === ref && at - h.at < 220 && at - h.at > -30)) continue;
        holds.push({ nodeId: this.nearestNodeId(pos, 200) ?? ids[0], runway: this.endInUse(ref)?.name ?? rs.name, at: Math.max(0, at - step), isDepartureEntry: false });
      }
      inside = now;
    }
    holds.sort((x, y) => x.at - y.at);
    return holds;
  }
  private nearestEndName(rw: OsmRunway, p: XY): string {
    const [e0, e1] = rw.ends;
    return dist(p, this.endXY(e0)) <= dist(p, this.endXY(e1)) ? upper(e0.name) : upper(e1.name);
  }
  /** The node ahead on the taxi line the aircraft stands on (within 3 m of it, pointing along it). */
  private lineAhead(a: AircraftState): string | null {
    let best: string | null = null, bd = 3, bt = 90;
    for (const n of this.air.nodes.values()) {
      const p = this.nodeXY(n.id)!; if (Math.abs(p.x - a.pos.x) > 420 || Math.abs(p.y - a.pos.y) > 420) continue;
      for (const e of n.edges) {
        if (e.type === 'runway' || e.leadIn) continue; const q = this.nodeXY(e.to); if (!q) continue;
        const L = dist(p, q); if (L < 1) continue; const t = Math.abs(angleDelta(a.heading, headingTo(p, q))); if (t > 25) continue;
        const u = ((a.pos.x - p.x) * (q.x - p.x) + (a.pos.y - p.y) * (q.y - p.y)) / L / L; if (u < -2 / L || (1 - u) * L < 3) continue;
        const d = distToSegment(a.pos, p, q); if (d > bd + 0.3 || (d > bd - 0.3 && t > bt)) continue;
        bd = Math.min(bd, d); bt = t; best = e.to;
      }
    }
    return best;
  }
  /** Start node for a route from the aircraft's current position: nearest node, preferring one ahead of the nose. */
  private startNodeFor(a: AircraftState): string | null {
    const near = this.nearestNodeId(a.pos, 1500); if (!near) return null;
    const n = this.air.nodes.get(near)!;
    // just pushed back: the node the tug left the nose pointing at (the nearest one ahead can be on the lane beside it)
    const j = this.sc(a).pushJoin, jx = j ? this.nodeXY(j) : null;
    if (j && jx && !this.rerouteAvoid && !(a.phase === 'taxi' && a.distAlong > 5)) { const d = dist(a.pos, jx); if (d > 3 && d < 160 && Math.abs(angleDelta(a.heading, headingTo(a.pos, jx))) < 32) return j; }
    if (this.rerouteAvoid) {
      // a re-route around a blocker: start from the nearest node within two hops that is not next to the blocker
      const cands = new Set<string>([near]); for (const e of n.edges) { cands.add(e.to); for (const f of this.air.nodes.get(e.to)?.edges ?? []) cands.add(f.to); }
      let best: string | null = null, bestScore = Infinity;
      for (const id of cands) { if (this.rerouteAvoid.has(id)) continue; const sc = this.scoreStart(a, id); if (sc < bestScore) { bestScore = sc; best = id; } }
      return best;
    }
    // standing (or rolling) on a line: the node ahead on that line. The nearest one ahead can be on the curve beside it, and
    // the route then began with a circle back on to the line the aircraft was on (RJTT T7, WSSS T1)
    if (a.phase === 'taxi' || a.phase === 'hold_short') { const on = this.lineAhead(a); if (on) return on; }
    // the nearest node ahead of the nose (within two hops): a route that starts behind the aircraft turns it on the spot
    const cands = new Set<string>([near]); for (const e of n.edges) { cands.add(e.to); for (const f of this.air.nodes.get(e.to)?.edges ?? []) cands.add(f.to); }
    let ahead: string | null = null, aheadScore = Infinity;
    for (const id of cands) {
      const xy = this.nodeXY(id)!; const d = dist(a.pos, xy);
      const rel = d > 3 ? Math.abs(angleDelta(a.heading, headingTo(a.pos, xy))) : 0;
      if (rel > 70) continue;
      const sc = d * (1 + rel / 60); if (sc < aheadScore) { aheadScore = sc; ahead = id; }
    }
    if (ahead) return ahead;
    let best = near; let bestScore = this.scoreStart(a, near);
    for (const e of n.edges) { const s = this.scoreStart(a, e.to); if (s < bestScore) { bestScore = s; best = e.to; } }
    return best;
  }
  /** Direction-aware routing from where the aircraft stands: it arrives at the start node along its nose, and no step of
   *  the route turns sharper than TAXI_MAX_TURN_DEG (no U-turn on the spot; a wrong-way push goes forward and round). */
  private taxiDir(a: AircraftState, startId: string): { maxTurnDeg: number; startHeading: number } {
    const xy = this.nodeXY(startId)!;
    return { maxTurnDeg: TAXI_MAX_TURN_DEG, startHeading: dist(a.pos, xy) > 3 ? headingTo(a.pos, xy) : a.heading };
  }
  private scoreStart(a: AircraftState, id: string): number {
    const xy = this.nodeXY(id)!; const d = dist(a.pos, xy);
    const rel = Math.abs(angleDelta(a.heading, headingTo(a.pos, xy)));
    return d + (d > 3 && rel > 100 ? 120 : 0);
  }
  private routeVia(startId: string, viaNames: string[], goalId: string): string[] | null {
    return osmRouteVia(this.air, startId, viaNames.map(upper), goalId, { avoidRunways: this.closedRunwayRefs(), edgeMult: this.againstFlow });
  }
  /** Route cost multiplier for the taxi being planned: an edge that other taxiing traffic is using the other way costs
   *  AGAINST_FLOW_COST times as much (opposite flows on one taxiway met nose to nose - a third of all taxi time at
   *  high density was spent in those standoffs); set by planTaxi for the duration of one plan. */
  private againstFlow: ((from: string, to: string) => number) | undefined = undefined;
  private tooWide: ((from: string, to: string) => number) | undefined = undefined;
  private flowEdges(a: AircraftState): Set<string> {
    const used = new Set<string>();
    for (const b of this.aircraft) {
      if (b === a || isAirborne(b) || (b.phase !== 'taxi' && b.phase !== 'hold_short')) continue;
      const ids = this.sc(b).routeIds; if (!ids) continue;
      for (let i = 1; i < ids.length; i++) used.add(`${ids[i - 1]}>${ids[i]}`);
    }
    return used;
  }
  /** The forward-only version of `plain` (no reversal on the spot): it may not touch a runway the plain route does not
   *  (turning round on a runway is an incursion), nor detour more than max(500 m, half the route) - a lap of the apron
   *  meets the traffic behind head-on; otherwise the plain route stands. */
  /** The forward way out may cross a runway the direct way does not (planTaxi: rather than taxi along the departure runway). */
  private mayCross = false;
  private forwardRoute(plain: string[], search: (dir: { maxTurnDeg: number; startHeading: number; turnWindowM?: number }, avoidRunways: string[]) => string[] | null, a: AircraftState, startId: string): string[] {
    // a re-route around a blocker (head-on deadlock) has to turn away from it: forward-only kept it nosing into the
    // same aircraft for half an hour
    if (this.rerouteAvoid) return plain;
    // only when the plain route starts by doubling back past the nose: forward-only everywhere sent aircraft round loops
    // against the flow and into head-on deadlocks
    const first = plain.map(id => this.nodeXY(id)!).find(p => dist(a.pos, p) > 25);
    // ... or by turning back on itself a little further on (the end of a connector it happened to be facing)
    let hair = false; { let m = 0; const P = plain.map(id => this.nodeXY(id)!); for (let i = 1; i < P.length - 1 && m < 400 && !hair; i++) { m += dist(P[i - 1], P[i]); const e = this.air.nodes.get(plain[i])?.edges.find(x => x.to === plain[i + 1]); if (!e?.leadIn && Math.abs(angleDelta(headingTo(P[i - 1], P[i]), headingTo(P[i], P[i + 1]))) > 125) hair = true; } }
    if (!hair && (!first || Math.abs(angleDelta(a.heading, headingTo(a.pos, first))) <= 100)) return plain;
    const used = this.runwayRefsOn(plain);
    const avoid = [...new Set([...this.closedRunwayRefs(), ...(this.mayCross ? [] : this.runways.map(r => r.ref).filter(r => !used.has(r)))])];
    const fwd = search(this.mayCross ? { ...this.taxiDir(a, startId), turnWindowM: 60 } : this.taxiDir(a, startId), avoid);
    const len = this.routeLengthM(plain);
    // the alternative is turning an airliner round on the spot (a half circle off the lines, through whatever is beside
    // the taxiway): a forward way out round the block is taken up to five times as long
    // ... but never one with more runway crossings than the direct way (a 5 km loop across 28L and 28R six times)
    const behind = !!first && Math.abs(angleDelta(a.heading, headingTo(a.pos, first))) > 100;
    const good = (f: string[] | null): f is string[] => !!f && this.routeLengthM(f) <= (behind ? len * 5 + 1500 : len * 1.5 + 300) && this.runwayEntries(f) <= this.runwayEntries(plain) + (this.mayCross ? 2 : 0);
    if (good(fwd)) return fwd;
    // a tighter way round the block (two parallel taxiways 80 m apart) before turning on the spot
    for (const turnWindowM of [60, 35]) { const f = search({ ...this.taxiDir(a, startId), turnWindowM }, avoid); if (good(f)) return f; }
    return plain;
  }
  /** How many times a node route goes onto a runway (crossings plus the departure entry). */
  private runwayEntries(ids: string[]): number {
    let n = 0, on = false;
    for (let i = 1; i < ids.length; i++) { const e = this.air.nodes.get(ids[i - 1])?.edges.find(x => x.to === ids[i]); const r = e?.type === 'runway'; if (r && !on) n++; on = r; }
    return n;
  }
  private runwayRefsOn(ids: string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 1; i < ids.length; i++) { const e = this.air.nodes.get(ids[i - 1])?.edges.find(x => x.to === ids[i]); if (e?.type === 'runway' && e.runway) out.add(e.runway); }
    return out;
  }
  private routeLengthM(ids: string[]): number { let m = 0; for (let i = 1; i < ids.length; i++) m += dist(this.nodeXY(ids[i - 1])!, this.nodeXY(ids[i])!); return m; }
  private closedRunwayRefs(): string[] { return this.runways.filter(r => r.status === 'sterile' && r.name < r.reciprocal).map(r => r.ref); }
  /** Resolve a taxi destination to a goal node. */
  private resolveTaxiGoal(dest: TaxiDest): { goalId: string; runway: string | null; stand: string | null } | { code: ResultCode; reason: string } {
    if (dest.kind === 'runway') {
      const rs = this.runwayState(dest.runway); const r = this.runwayByEnd(dest.runway);
      if (!rs || !r) return { code: 'unknown_runway', reason: `Unknown runway ${dest.runway}` };
      if (dest.intersection) {
        const tw = upper(dest.intersection);
        const nodes = this.air.taxiwayNodes.get(tw);
        const hold = [...(this.holdNodes.get(rs.ref) ?? [])].find(h => nodes?.includes(h));
        if (hold) return { goalId: this.holdNodeInfo.get(hold)!.runwayNodeId, runway: rs.name, stand: null };
      }
      return { goalId: r.end.nodeId, runway: rs.name, stand: null };
    }
    if (dest.kind === 'stand') {
      const g = this.gateByRef(dest.ref); if (!g) return { code: 'unknown_stand', reason: `Unknown stand ${dest.ref}` };
      return { goalId: g.nodeId, runway: null, stand: g.ref };
    }
    if (!this.air.nodes.has(dest.nodeId)) return { code: 'invalid_param', reason: `Unknown node ${dest.label}` };
    return { goalId: dest.nodeId, runway: null, stand: null };
  }
  /** Route + DrivePath for a taxi clearance from the aircraft's current position. */
  private planTaxi(a: AircraftState, dest: TaxiDest, via: string[]): { ids: string[]; path: DrivePath; runway: string | null; stand: string | null } | { code: ResultCode; reason: string } {
    // told the very way it would go by itself: that way, whole
    if (via.length > 1 && !this.rerouteAvoid) {
      const own = this.planTaxi(a, dest, []), said = via.map(upper).filter((v, i, l) => v !== l[i - 1]).join(' ');
      if (!('code' in own) && taxiwaysForPath(this.air, own.ids).map(upper).join(' ') === said) return own;
    }
    const goal = this.resolveTaxiGoal(dest);
    if ('code' in goal) return goal;
    const startId = this.startNodeFor(a); if (!startId) return { code: 'no_route', reason: 'No route' };
    const flows = this.flowEdges(a);
    // a wide one keeps off the taxiways it does not fit (taxiLimits.ts): dear, not barred, so there is always a way
    const lim = taxiLimitsOf(this.air), span = a.perf.wingspanMeters;
    this.tooWide = lim.any(span) || lim.anyTight(span) ? (from: string, to: string) => (lim.tooWide(from, to, span) ? TOO_WIDE_COST : lim.tight(from, to, span) ? 3 : 1) : undefined;
    const wide = this.tooWide;
    this.againstFlow = flows.size || wide ? (from: string, to: string) => (flows.has(`${to}>${from}`) ? AGAINST_FLOW_COST : 1) * (wide ? wide(from, to) : 1) : undefined;
    if (this.againstFlow && !flows.size) (this.againstFlow as { memoKey?: string }).memoKey = `w${span}`;
    try {
      const p = this.planTaxiInner(a, dest, via, goal, startId);
      if (dest.kind !== 'runway' || 'code' in p) return p;
      // the way there ran along the departure runway itself (JFK: in at H, 1650 m up 22L to its threshold): taxiways instead
      const onRwy = (x: { path: DrivePath }) => { const h = x.path.holds?.find(k => k.isDepartureEntry); return h ? x.path.total - h.at : 0; };
      if (onRwy(p) < 600 || !goal.runway) return p;
      const ref = this.refOf(goal.runway), end = this.nodeXY(goal.goalId); if (!ref || !end) return p;
      const off: string[] = []; for (const n of this.air.nodes.values()) if (n.edges.some(x => x.type === 'runway' && x.runway === ref) && dist(this.nodeXY(n.id)!, end) > 450) off.push(n.id);
      this.offRwy = off;
      this.mayCross = true;
      const q = this.planTaxiInner(a, dest, via, goal, startId);
      return !('code' in q) && onRwy(q) < onRwy(p) - 200 ? q : p;
    } finally { this.againstFlow = undefined; this.tooWide = undefined; this.mayCross = false; this.offRwy = null; }
  }
  private offRwy: string[] | null = null;
  /** The way a clearance without a "via" goes. */
  private directRoute(a: AircraftState, goal: { goalId: string }, startId: string): string[] | null {
    // turns cost (maxTurnDeg 180 bars nothing): at equal length the route that goes straight through a junction, not the
    // one that swings onto a fillet and back
    const opts = { avoidRunways: this.closedRunwayRefs(), avoidNodes: this.rerouteAvoid ? [...this.rerouteAvoid] : this.offRwy ?? undefined, edgeMult: this.againstFlow, maxTurnDeg: 180 };
    let plain = findPath(this.air, startId, goal.goalId, opts);
    // keeping with the traffic flow never buys extra runway crossings (against the flow costs 4x, and a 1 km stretch
    // of it was dodged by crossing 28L and 28R four more times)
    if (plain && opts.edgeMult) { const direct = findPath(this.air, startId, goal.goalId, { ...opts, edgeMult: this.tooWide }); if (direct && this.runwayEntries(direct) < this.runwayEntries(plain)) plain = direct; }
    // ... nor a weave round it: where the two ways part and meet again within 320 m, the straight one (traffic coming the
    // other way on A sent a departure round the fillets of a side lane and back)
    if (plain && opts.edgeMult) { const d = findPath(this.air, startId, goal.goalId, { ...opts, edgeMult: this.tooWide }); if (d) plain = this.unweave(plain, d); }
    return plain && this.forwardRoute(plain, (dir, avoid) => findPath(this.air, startId, goal.goalId, { ...opts, avoidRunways: avoid, ...dir }), a, startId);
  }
  private unweave(way: string[], direct: string[]): string[] {
    const at = new Map(direct.map((id, i) => [id, i] as const)); const out: string[] = [way[0]]; let i = 0;
    while (i < way.length - 1) {
      const di = at.get(way[i]); let j = i + 1;
      if (di != null && !(at.get(way[j]) === di + 1)) {
        let m = this.routeLengthM([way[i], way[j]]); while (j < way.length - 1 && !((at.get(way[j]) ?? -1) > di) && m < 320) { j++; m += this.routeLengthM([way[j - 1], way[j]]); }
        const dj = at.get(way[j]);
        if (m < 320 && dj != null && dj > di) { out.push(...direct.slice(di + 1, dj + 1)); i = j; continue; }
        j = i + 1;
      }
      out.push(way[j]); i = j;
    }
    return out;
  }
  /** Off a taxiway and back on to it within 320 m, round the fillets of a side lane nobody named: along the taxiway instead. */
  private stayOn(ids: string[], via: string[]): string[] {
    const named = new Set(via.map(upper));
    const edge = (p: string, q: string) => this.air.nodes.get(p)?.edges.find(e => e.to === q);
    const name = (i: number) => upper(edge(ids[i], ids[i + 1])?.taxiway ?? '');
    for (let i = 1; i < ids.length - 2; i++) {
      const t = name(i - 1); if (!t || name(i) === t) continue;
      let m = 0, j = i, off = false;
      while (j < ids.length - 1 && m < 320) { const n = name(j); if (n === t) break; if (n && named.has(n)) off = true; m += edge(ids[j], ids[j + 1])?.meters ?? 999; j++; }
      if (off || j >= ids.length - 1 || m >= 320 || name(j) !== t) continue;
      const from = ids[i], to = ids[j], best = new Map<string, { m: number; p: string | null }>([[from, { m: 0, p: null }]]), q = [from];
      while (q.length) {
        const id = q.shift()!, c = best.get(id)!.m;
        for (const e of this.air.nodes.get(id)?.edges ?? []) {
          if (upper(e.taxiway ?? '') !== t || e.type === 'runway' || this.tooWide && this.tooWide(id, e.to) > 1) continue;
          const nm = c + e.meters; if (nm > m * 1.25 + 20 || nm >= (best.get(e.to)?.m ?? Infinity)) continue;
          best.set(e.to, { m: nm, p: id }); q.push(e.to);
        }
      }
      if (!best.has(to)) continue;
      const way: string[] = []; for (let c: string | null = to; c; c = best.get(c)!.p) way.push(c); way.reverse();
      ids = [...ids.slice(0, i), ...way, ...ids.slice(j + 1)]; i += way.length - 1;
    }
    return ids;
  }
  private planTaxiInner(a: AircraftState, dest: TaxiDest, via: string[], goal: { goalId: string; runway: string | null; stand: string | null }, startId: string): { ids: string[]; path: DrivePath; runway: string | null; stand: string | null } | { code: ResultCode; reason: string } {
    void dest;
    let ids: string[] | null;
    if (via.length) {
      const bad = via.find(v => !this.air.taxiwayNodes.has(upper(v)));
      if (bad) return { code: 'unknown_taxiway', reason: `No taxiway ${upper(bad)} here` };
      let plain = this.routeVia(startId, via, goal.goalId);
      if (!plain) return { code: 'unable_route', reason: `Unable, ${via.map(upper).join(' ')} does not connect` };
      if (this.againstFlow) { const d = osmRouteVia(this.air, startId, via.map(upper), goal.goalId, { avoidRunways: this.closedRunwayRefs(), edgeMult: this.tooWide }); if (d) plain = this.unweave(plain, d); }
      ids = this.forwardRoute(plain, (dir, avoid) => osmRouteVia(this.air, startId, via.map(upper), goal.goalId, { avoidRunways: avoid, edgeMult: this.againstFlow, ...dir }), a, startId);
      // the taxiways named are the ones of the way it would go by itself: that way, whole (searched for again name by name
      // it came out up to 900 m longer than the route that had been suggested)
      const own = this.directRoute(a, goal, startId), up = via.map(upper);
      if (own && ids && taxiwaysForPath(this.air, own).join(' ') === up.filter((v, i) => v !== up[i - 1]).join(' ') && this.runwayEntries(own) <= this.runwayEntries(ids)) ids = own;
    } else {
      ids = this.directRoute(a, goal, startId);
    }
    if (ids && !this.rerouteAvoid) ids = this.stayOn(ids, via);
    if (!ids || ids.length < 2) {
      if (ids && ids.length === 1 && dist(a.pos, this.nodeXY(ids[0])!) > 5) ids = [ids[0]]; else return { code: 'no_route', reason: 'No route' };
    }
    // a way round a blocker that starts by turning back on the taxiway is no way round (the tug moves one of them instead)
    if (this.rerouteAvoid) { const f = ids.map(id => this.nodeXY(id)).find((p): p is XY => !!p && dist(a.pos, p) > 25); if (f && Math.abs(angleDelta(a.heading, headingTo(a.pos, f))) > 110) return { code: 'no_route', reason: 'No way round without turning back' }; }
    const path = this.pathFromNodes(ids, !!goal.runway, a.pos, { heading: a.heading, radiusM: Math.max(20, wheelbaseM(a) * 1.2) });
    if (!path) return { code: 'no_route', reason: 'No route' };
    // standing on a runway (stopped on it after the rollout): its own hold line at the start of the route is behind it -
    // "hold short of 16L" to an aircraft on 16L kept it there and the runway closed to arrivals
    const onRef = this.runwaysAt(a.pos, STRIP_HALF_M)[0] ?? null;
    if (onRef && path.holds) { path.holds = path.holds.filter(h => !(this.refOf(h.runway) === onRef && h.at < 250 && !h.isDepartureEntry)); path.holdAt = path.holds.length ? path.holds[0].at : undefined; }
    if (goal.runway) {
      const rs = this.runwayState(goal.runway)!;
      // the departure entry is the last hold line of that runway on the route (an earlier one is a crossing of it on
      // the way round), preferring one with enough runway ahead for the take-off
      const cands = path.holds!.filter(h => this.runwayState(h.runway)?.ref === rs.ref);
      const depHold = [...cands].reverse().find(h => this.runwayAheadFromM(sampleAlong(path.pts, path.cum, h.at).pos, rs) >= this.takeoffRunNeededM(a)) ?? cands[cands.length - 1];
      if (depHold) {
        depHold.isDepartureEntry = true; depHold.runway = rs.name;
        // a second hold of the same runway within 100 m of the entry is the same hold line seen twice (the OSM hold
        // node and the strip edge), not a crossing to be cleared across
        path.holds = path.holds!.filter(h => h === depHold || this.runwayState(h.runway)?.ref !== rs.ref || Math.abs(h.at - depHold.at) >= 100);
        for (const h of path.holds) if (h !== depHold) h.isDepartureEntry = false;
      }
      else { path.holds!.push({ nodeId: ids[ids.length - 1], runway: rs.name, at: path.total, isDepartureEntry: true }); }
      path.holdAt = path.holds![0].at;
    }
    return { ids, path, runway: goal.runway, stand: goal.stand };
  }

  /** Pushback path for the MAIN GEAR (a wheelbase behind the parked nose wheel; aircraft.ts puts the nose a wheelbase
   *  ahead of the point on the path): stand -> lead-in (reversed) -> along the taxiway in the direction that leaves the
   *  nose facing `dir`, far enough for the nose wheel to end on the lane too. */
  private pushbackPath(a: AircraftState, dir: PushDir): DrivePath | null {
    const g = a.reservedStand ? this.gateByRef(a.reservedStand) : a.plan.gateRef ? this.gateByRef(a.plan.gateRef) : undefined;
    const stand = g ? this.standOf(g) : undefined;
    const wb = wheelbaseM(a);
    const raw: XY[] = [advance(a.pos, (a.heading + 180) % 360, wb)];
    let entryId: string | null = null;
    if (stand && stand.leadInPts.length >= 2) {
      const pts = [...stand.leadInPts].reverse().map(p => this.proj.toXY(p.lat, p.lng)); // stand -> entry
      for (const p of pts) if (dist(raw[raw.length - 1], p) > 2 && dist(a.pos, p) > wb + 2) raw.push(p);
      entryId = stand.entryNodeId;
    } else {
      const nodeId = g?.nodeId ?? this.nearestNodeId(a.pos, 400); if (!nodeId) return null;
      const nx = this.nodeXY(nodeId)!;
      if (dist(a.pos, nx) > wb + 3) raw.push(nx); else raw.push(advance(raw[0], (a.heading + 180) % 360, 12));
      let cur = nodeId, prev: string | null = null, hops = 0;
      while (hops++ < 3) {
        const n = this.air.nodes.get(cur)!;
        if (n.edges.length >= 3 || n.edges.some(e => e.taxiway)) break;
        const next = n.edges.find(e => e.to !== prev); if (!next) break;
        prev = cur; cur = next.to; raw.push(this.nodeXY(cur)!);
      }
      entryId = cur;
    }
    const jn = this.air.nodes.get(entryId); const jx = this.nodeXY(entryId);
    if (!jn || !jx) return null;
    if (dist(raw[raw.length - 1], jx) > 2) raw.push(jx);
    const wantFace = dir === 'N' ? 0 : dir === 'E' ? 90 : dir === 'S' ? 180 : dir === 'W' ? 270 : null;
    let pushHdg: number | null = null;
    // 'any': the lane whose push leaves the shortest FORWARD taxi to the departure runway (nose toward the junction,
    // no reversal anywhere on the way) - the first step of an undirected route was not enough, a push could still
    // leave the nose pointing away from the only way out
    const goalNode = wantFace == null && a.plan.runway ? this.runwayByEnd(a.plan.runway)?.end.nodeId ?? null : null;
    // forward taxi length from a node with the nose on a heading; a way out that crosses another runway counts too, at
    // 400 m extra (avoiding them all left most SFO stands with no forward way out at all, and a larger penalty faced
    // the nose down a 7 km loop while the taxi then took the 3 km way behind it)
    // priced like the taxi plan itself (against the traffic flow costs 4x): unpriced, the push faced the nose one way and
    // the taxi then went the other, turning round behind it
    const flows = this.flowEdges(a);
    const em = flows.size ? (f: string, t: string) => (flows.has(`${t}>${f}`) ? AGAINST_FLOW_COST : 1) : undefined;
    const costM = (ids: string[]) => { let m = 0; for (let i = 1; i < ids.length; i++) m += dist(this.nodeXY(ids[i - 1])!, this.nodeXY(ids[i])!) * (em ? em(ids[i - 1], ids[i]) : 1); return m; };
    const fwdFrom = (from: string, hdg: number): number => {
      if (!goalNode) return Infinity;
      const depRef = this.runwayState(a.plan.runway!)?.ref;
      const opts = { maxTurnDeg: TAXI_MAX_TURN_DEG, startHeading: hdg, edgeMult: em };
      const own = findPath(this.air, from, goalNode, { ...opts, avoidRunways: [...this.closedRunwayRefs(), ...this.runways.map(r => r.ref).filter(r => r !== depRef)] });
      const crossing = findPath(this.air, from, goalNode, { ...opts, avoidRunways: this.closedRunwayRefs() });
      const c = crossing ? costM(crossing) + 400 : Infinity;
      return own ? Math.min(costM(own), c) : c;
    };
    const forwardCost = (to: string): number => fwdFrom(entryId!, headingTo(this.nodeXY(to)!, jx));
    if (wantFace != null) pushHdg = (wantFace + 180) % 360;
    else if (goalNode) {
      // the way the taxi plan itself will go (priced the same, against-flow included): the push faces the nose along it
      const ids = findPath(this.air, entryId, goalNode, { avoidRunways: this.closedRunwayRefs(), edgeMult: em });
      if (ids && ids.length > 1) pushHdg = (headingTo(jx, this.nodeXY(ids[1])!) + 180) % 360;
    }
    // the stand's checked pushes (standplans/): the one that leaves the shortest forward taxi, facing the way the plan goes
    const options = stand && this.standPlan?.push[stand.ref];
    if (stand && options?.length && dist(a.pos, this.proj.toXY(stand.lat, stand.lng)) < 6) {
      const lead = [...stand.leadInPts].reverse().map(p => this.proj.toXY(p.lat, p.lng));
      let best: { pts: XY[]; r: number; at: string; score: number } | null = null;
      options.forEach((o, i) => {
        const pts = pushRaw(this.proj.toXY(stand.lat, stand.lng), a.heading, wb, lead, o), n = pts.length;
        const nose = headingTo(pts[n - 1], pts[n - 2]); let score = i + (o.p ?? 0);      // the first listed is the cleanest
        if (tightestTurn(this.pushPathOf(pts, o.r).pts) > 75) score += 5000;                       // spun round on the spot: only when nothing else will do
        if (wantFace != null) score += Math.abs(angleDelta(wantFace, nose)) * 100;
        else if (goalNode) {
          const fc = fwdFrom(o.at, nose);
          const ids = findPath(this.air, o.at, goalNode, { avoidRunways: this.closedRunwayRefs(), edgeMult: em });
          const along = ids && ids.length > 1 && Math.abs(angleDelta(nose, headingTo(this.nodeXY(o.at)!, this.nodeXY(ids[1])!))) > 100 ? 1e5 : 0;
          score += Number.isFinite(fc) ? fc + along : 1e6;
        }
        if (!best || score < best.score) best = { pts, r: o.r, at: o.at, score };
      });
      const b = best as { pts: XY[]; r: number; at: string; score: number } | null;
      if (b && (b.score < 1e6 || wantFace != null || !goalNode)) return { ...this.pushPathOf(b.pts, b.r), join: b.at };
    }
    const inHdg = headingTo(raw[raw.length - 2] ?? a.pos, jx);
    let bestTo: string | null = null, bestDiff = Infinity;
    // Prefer a real taxiway edge at the junction; when the junction only continues as a shared lead-in lane
    // (long apron lead-ins), push along that lane rather than off the graph into the grass.
    for (const pass of [0, 1]) {
      for (const e of jn.edges) {
        if (e.type === 'runway' || (pass === 0 && e.leadIn)) continue;
        const h = headingTo(jx, this.nodeXY(e.to)!);
        if (Math.abs(angleDelta(inHdg, h)) > 150) continue; // never push back up the lead-in
        const diff = pushHdg == null ? Math.abs(angleDelta(inHdg, h)) : Math.abs(angleDelta(pushHdg, h));
        const fc = forwardCost(e.to);
        // a lane with a forward way out always beats one without; among those, a push that doubles back on the lead-in
        // (a hairpin of over 110 degrees) is only taken when nothing else leaves the nose pointing at a way out
        // and among those, the one that faces the nose along the taxi plan's own route comes first: a push picked on its
        // forward cost alone could face the nose one way while the plan went the other, turning round behind it (C1)
        const along = wantFace == null && pushHdg != null && Math.abs(angleDelta(pushHdg, h)) < 60 ? 0 : 1e5;
        const score = (Number.isFinite(fc) ? fc + along : 1e6 + diff) + Math.max(0, Math.abs(angleDelta(inHdg, h)) - 110) * 2000;
        if (score < bestDiff) { bestDiff = score; bestTo = e.to; }
      }
      if (bestTo) break;
    }
    // A stand at the head of a dead-end alley (the lane ends at its own lead-in, SFO B2 on M5): no push along the lane
    // leaves the nose pointing at a way out, and the taxi began by swinging round on a 60-100 m half circle across the
    // apron. The tug pushes it tail first down the alley to the first cross lane with a forward way out and turns it
    // onto that, as a real one does.
    let pushFrom = entryId, turnRound = false;
    if (bestTo && goalNode && !Number.isFinite(forwardCost(bestTo))) {
      let prev = entryId, cur = bestTo, acc = dist(jx, this.nodeXY(bestTo)!);
      const walk: XY[] = [this.nodeXY(bestTo)!];
      let found: { j: string; to: string } | null = null;
      for (let guard = 0; guard < 80 && acc < 450 && !found; guard++) {
        const px = this.nodeXY(prev)!, cx = this.nodeXY(cur)!, h0 = headingTo(px, cx);
        const lanes = this.air.nodes.get(cur)!.edges.filter(x => x.to !== prev && !x.leadIn && x.type !== 'runway');
        const turnOf = (x: { to: string }) => Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(x.to)!)));
        if (acc > wb + 10) {
          let best = Infinity;
          for (const x of lanes) {
            const t = turnOf(x); if (t < 35 || t > 145) continue;   // a cross lane, not the alley running on
            const fc = fwdFrom(cur, headingTo(this.nodeXY(x.to)!, cx));
            if (fc < best) { best = fc; found = { j: cur, to: x.to }; }
          }
          if (found) break;
        }
        const on = lanes.filter(x => turnOf(x) <= 35); if (!on.length) break;
        const next = on.reduce((b, x) => (turnOf(x) < turnOf(b) ? x : b));
        prev = cur; cur = next.to; const nx = this.nodeXY(cur)!; walk.push(nx); acc += dist(cx, nx);
      }
      if (found) { for (const p of walk) if (dist(raw[raw.length - 1], p) > 2) raw.push(p); pushFrom = found.j; bestTo = found.to; }
      else turnRound = true;
    }
    if (bestTo) {
      // Push along the lane until the nose wheel is ~20 m past the junction too, walking through short apron segments
      // so the aircraft ends aligned with the lane.
      const pushM = 20 + wb;
      let prev = pushFrom, cur = bestTo, acc = 0, guard = 0;
      while (guard++ < 6) {
        const px = this.nodeXY(prev)!, cx = this.nodeXY(cur)!;
        const segLen = dist(px, cx);
        if (acc + segLen >= pushM) { raw.push(advance(px, headingTo(px, cx), pushM - acc)); break; }
        raw.push(cx); acc += segLen;
        const h0 = headingTo(px, cx);
        const nexts = this.air.nodes.get(cur)!.edges.filter(x => x.to !== prev && x.type !== 'runway');
        const next = nexts.length ? nexts.reduce((b, x) => (Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(x.to)!))) < Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(b.to)!))) ? x : b)) : null;
        if (!next || Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(next.to)!))) > 60) {
          // the lane ends (a stub into a cul-de-sac between piers) before the aircraft is clear: keep the push straight
          // for what is left, up to 30 m, so the turn onto the stub is a full arc and not a hook into its last metres
          raw.push(advance(cx, h0, Math.min(30, pushM - acc))); break;
        }
        prev = cur; cur = next.to;
      }
      // no cross lane either (a long lane closed at this end, SFO M5): the tug turns it round on the lane - drift 8 m
      // to one side, then swing the tail through a half circle of 8 m (the tightest the body follows, 8 deg per metre)
      // so it ends nose out within 8 m of the line, the side away from the nearest terminal wall
      if (turnRound && raw.length >= 2) {
        const L = raw[raw.length - 1], h = headingTo(raw[raw.length - 2], L), RT = 8;
        const walls = (this.air.buildings ?? []).filter(b => b.kind === 'terminal').flatMap(b => b.polygon.map(q => this.proj.toXY(q.lat, q.lng)));
        const room = (side: number) => { const p = advance(advance(L, h, 30 + RT), (h + side * 90 + 360) % 360, RT * 2); return walls.reduce((m, q) => Math.min(m, dist(p, q)), Infinity); };
        const side = room(1) >= room(-1) ? 1 : -1;       // the side the tail swings out to
        for (let k = 1; k <= 6; k++) { const t = k / 6; raw.push(advance(advance(L, h, 30 * t), (h - side * 90 + 360) % 360, RT * (t * t * (3 - 2 * t)))); }
        const C = advance(raw[raw.length - 1], (h + side * 90 + 360) % 360, RT);
        for (let k = 1; k <= 18; k++) raw.push(advance(C, (h - side * 90 + side * k * 10 + 720) % 360, RT));
      }
    } else raw.push(advance(jx, inHdg, 12 + wb));
    const path = this.buildPath(raw, 'pushback', false, [jx]);
    return path.total > 5 ? path : null;
  }

  /** Runway exits of a physical runway: taxiway nodes adjacent to centreline nodes. */
  /** A taxi route as the controller would give it, without giving it: the path, its runway crossings and its named
   *  stretches in order (arc length along the path), for the tutorial's route preview. null when there is no route. */
  previewTaxi(a: AircraftState, dest: TaxiDest, via: string[] = []): { path: DrivePath; names: string[]; legs: Array<{ name: string; s0: number; s1: number }>; crossings: Array<{ runway: string; at: number }> } | null {
    // still on its stand, nose to the terminal: the taxi starts where the tug leaves it, nose out (planning from the stand
    // drew a loop as the route turned the parked aircraft round on the spot)
    let from = a;
    if (a.phase === 'parked' || (a.phase === 'startup' && a.needsPushback && this.atItsStand(a))) {
      const pb = this.pushbackPath(a, 'any');
      if (pb && pb.pts.length >= 2) {
        const P = pb.pts[pb.pts.length - 1], Q = pb.pts[pb.pts.length - 2];
        from = { ...a, pos: { x: P.x, y: P.y }, heading: (Math.atan2(Q.x - P.x, Q.y - P.y) * 180 / Math.PI + 360) % 360 };
        from.pos = advance(from.pos, from.heading, wheelbaseM(a)); this.sc(a).pushJoin = pb.join ?? null;
      }
    }
    const plan = this.planTaxi(from, dest, via);
    if ('code' in plan) return null;
    const path = plan.path, ids = plan.ids;
    const sOf = (p: XY): number => { let best = Infinity, s = 0; for (let i = 1; i < path.pts.length; i++) { const A = path.pts[i - 1], B = path.pts[i]; const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2)); const d = Math.hypot(A.x + dx * t - p.x, A.y + dy * t - p.y); if (d < best) { best = d; s = path.cum[i - 1] + Math.sqrt(L2) * t; } } return s; };
    const legs: Array<{ name: string; s0: number; s1: number }> = [];
    for (let i = 1; i < ids.length; i++) {
      const edge = this.air.nodes.get(ids[i - 1])?.edges.find(x => x.to === ids[i]);
      const name = edge?.taxiway ?? null; if (!name) continue;
      const p0 = this.nodeXY(ids[i - 1]), p1 = this.nodeXY(ids[i]); if (!p0 || !p1) continue;
      const s0 = sOf(p0), s1 = sOf(p1); const last = legs[legs.length - 1];
      if (last && last.name === name) last.s1 = Math.max(last.s1, s1); else legs.push({ name, s0: Math.min(s0, s1), s1: Math.max(s0, s1) });
    }
    for (let i = 0; i < legs.length; i++) { if (i) legs[i].s0 = legs[i - 1].s1; if (i === legs.length - 1) legs[i].s1 = path.total; }
    if (legs.length) legs[0].s0 = 0;
    const crossings = (path.holds ?? []).filter(h => !h.isDepartureEntry).map(h => ({ runway: h.runway, at: h.at }));
    return { path, names: taxiwaysForPath(this.air, ids), legs, crossings };
  }
  /** Has a controller told this departure its runway yet? (Until then `plan.runway` is only what the airport's flow would
   *  give it; nothing shown to the player says so.) Arrivals have theirs from approach. */
  runwayGiven(a: AircraftState): boolean {
    if (a.plan.kind !== 'departure') return true;
    return (a.plan.taxiRoute?.length ?? 0) > 0 || !!this.sc(a).rwyTold || !['parked', 'startup', 'pushback', 'taxi'].includes(a.phase);
  }
  private atItsStand(a: AircraftState): boolean { const g = a.plan.gateRef ? this.gateByRef(a.plan.gateRef) : null; return !!g && dist(a.pos, this.gateXY(g)) < 12; }
  /** The way the tug would take an aircraft still on its stand (the main gear's line), or null. */
  previewPush(a: AircraftState): XY[] | null { return a.needsPushback && (a.phase === 'parked' || a.phase === 'startup') && this.atItsStand(a) ? this.pushbackPath(a, 'any')?.pts ?? null : null; }
  runwayExits(ref: string): RunwayExit[] {
    const c = this.exitsCache.get(ref); if (c) return c;
    const out: RunwayExit[] = [];
    const set = this.runwayNodes.get(ref) ?? new Set<string>();
    for (const rid of set) {
      const n = this.air.nodes.get(rid)!;
      for (const e of n.edges) {
        if (e.type === 'runway' || e.leadIn || set.has(e.to)) continue;
        out.push({ runwayNodeId: rid, twyNodeId: e.to, xy: this.nodeXY(rid)!, taxiway: e.taxiway ?? this.taxiwayNameOf(e.to) });
      }
    }
    this.exitsCache.set(ref, out);
    return out;
  }
  private taxiwayNameOf(nodeId: string): string | null {
    for (const [name, ids] of this.air.taxiwayNodes) if (ids.includes(nodeId)) return name;
    return null;
  }

  // ── runway state / occupancy ───────────────────────────────────────────────
  private bothEnds(ref: string): RunwayState[] { return this.runways.filter(r => r.ref === ref); }
  private refOf(endName: string): string | null { return this.runwayState(endName)?.ref ?? null; }
  addOccupant(endName: string, a: AircraftState | { id: string | number; callsign: string }, kind: RunwayOccupantKind) {
    const rs = this.runwayState(endName); if (!rs) return;
    const ex = rs.occupiedBy.find(o => o.id === a.id);
    if (ex) { ex.kind = kind; return; }
    rs.occupiedBy.push({ id: a.id, callsign: a.callsign, kind, since: this.time });
    if (typeof a.id === 'number') this.sc(a as AircraftState).onRunwayRef = rs.ref;
  }
  removeOccupant(ref: string, id: number | string) {
    const rs = this.bothEnds(ref)[0]; if (!rs) return;
    const i = rs.occupiedBy.findIndex(o => o.id === id);
    if (i >= 0) rs.occupiedBy.splice(i, 1);
    if (typeof id === 'number') { const a = this.byId(id); if (a) { const s = this.sc(a); if (s.onRunwayRef === ref) s.onRunwayRef = null; } }
  }
  /** Occupied for landing/takeoff purposes: any occupant other than `exceptId`, or a runway that is not open (06 §7.9). */
  runwayOccupied(endName: string, exceptId?: number): boolean {
    const rs = this.runwayState(endName); if (!rs) return false;
    if (rs.status !== 'open') return true;
    return rs.occupiedBy.some(o => o.id !== exceptId) || this.safe('fleet', () => this.fleet.onRunway(rs.ref).length > 0, false);
  }
  /** Callsign / vehicle id occupying the runway (excluding `exceptId`), null if free. */
  runwayOccupant(endName: string, exceptId?: number): string | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    const o = rs.occupiedBy.find(x => x.id !== exceptId); if (o) return o.callsign;
    const v = this.safe('fleet', () => this.fleet.onRunway(rs.ref)[0] ?? null, null); if (v) return v.callsign;
    return null;
  }
  /** No aircraft physically on the runway strip other than `exceptId` (B15: strip half-width, not the hold line). */
  runwayPhysicallyClear(endName: string, exceptId: number): boolean {
    const rs = this.runwayState(endName); if (!rs) return false;
    return !this.aircraft.some(ac => ac.id !== exceptId && !isAirborne(ac) && ac.phase !== 'parked' && ac.phase !== 'arrived' && this.distToRunway(ac.pos, rs.ref) < STRIP_HALF_M);
  }
  /** Nearest arrival on final to this runway (either end name) within `nm`. */
  arrivalOnFinal(endName: string, nm: number): { callsign: string; nm: number; a: AircraftState } | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    let best: { callsign: string; nm: number; a: AircraftState } | null = null;
    for (const a of this.aircraft) {
      if (!isAirborne(a) || a.plan.kind !== 'arrival' && !a.ilsArmed) continue;
      const rw = a.plan.runway ?? a.assignedRunway; if (!rw || this.refOf(rw) !== rs.ref) continue;
      if (!(a.ilsCaptured || a.phase === 'landing' || a.navMode === 'visual')) continue;
      const d = this.distToThresholdNM(a, rw); if (d == null || d > nm) continue;
      if (!best || d < best.nm) best = { callsign: a.callsign, nm: d, a };
    }
    return best;
  }
  /** An aircraft cleared to cross this runway (crossing now or about to): nothing may take off or line up meanwhile. */
  crossingTraffic(endName: string): string | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    // on it, or cleared across and about to go (the clearance waits out the pilot's reply before it enters)
    const a = this.aircraft.find(x => !isAirborne(x) && (this.sc(x).crossingRef === rs.ref
      || x.pendingCmds.some(c => c.kind === 'cross' && !c.condition && (c.ast as { runway?: string } | undefined)?.runway != null && this.refOf((c.ast as { runway: string }).runway) === rs.ref)));
    return a?.callsign ?? null;
  }
  rollingDeparture(endName: string): string | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    const a = this.aircraft.find(x => x.phase === 'takeoff' && x.plan.runway && this.refOf(x.plan.runway) === rs.ref);
    return a?.callsign ?? null;
  }
  wakeTimerRemainingS(endName: string, follower?: WakeCategory): number {
    const rs = this.runwayState(endName); const t = rs?.wakeTimer; if (!rs || !t) return 0;
    if (follower) { const need = WAKE_DEPARTURE_S[t.leaderCat][follower]; if (!need) return 0; return Math.max(0, t.startedAt + need - this.time); }
    return Math.max(0, t.expiresAt - this.time);
  }
  private setWakeTimer(endName: string, leader: AircraftState) {
    const rs = this.runwayState(endName); if (!rs) return;
    const cat: WakeCategory = leader.perf.b757 ? 'HEAVY' : leader.wakeCategory;
    const longest = Math.max(...Object.values(WAKE_DEPARTURE_S[cat]));
    const timer = longest > 0 ? { leader: leader.callsign, leaderCat: cat, startedAt: this.time, expiresAt: this.time + longest, ref: 'airborne' as const } : null;
    for (const r of this.bothEnds(rs.ref)) { r.wakeTimer = timer; r.lastDeparture = { callsign: leader.callsign, at: this.time, cat }; }
    if (timer) this.emit('wake', null, `Wake timer runway ${rs.name}: ${leader.callsign} (${cat}) departed, ${Math.round(longest)} s`, { type: 'wake', runway: rs.name, leader: leader.callsign, expiresAt: timer.expiresAt });
  }
  private setLandingClearance(rs: RunwayState, cs: string, on: boolean) {
    for (const r of this.bothEnds(rs.ref)) {
      r.landingClearances = r.landingClearances.filter(c => c !== cs);
      if (on) r.landingClearances.push(cs);
    }
  }
  /** Runway crossing lock (03 §D12): time to threshold of the nearest arrival > pilot delay + crossing time + 20 s, no rolling departure. */
  crossingSafe(endName: string, crossingS = 35, strict = false, behind: XY | null = null): boolean {
    const rs = this.runwayState(endName); if (!rs) return false;
    if (rs.status === 'sterile') return false;
    if (this.rollingDeparture(endName)) return false;
    // a take-off clearance given and not yet used (the crew lining up or about to roll)
    if (this.aircraft.some(x => !isAirborne(x) && x.plan.runway && this.refOf(x.plan.runway) === rs.ref && (x.takeoffCleared || x.pendingCmds.some(c => c.kind === 'takeoff')))) return false;
    // occupants are booked on the end in use: a landing on 26R blocks a crossing of "08L" just the same (an AI
    // controller also waits for a rollout to clear; a pilot crosses on a clearance while the rollout is far down)
    if (this.bothEnds(rs.ref).some(o => o.occupiedBy.some(x => x.kind === 'lineup' || x.kind === 'takeoff' || x.kind === 'landing' || (strict && x.kind === 'rollout' && !(behind && this.rolledPast(x.id, rs, behind)))))) return false;
    const arr = this.arrivalOnFinal(endName, 10);
    if (!arr) return true;
    const gs = Math.max(90, arr.a.speed);
    const ttt = (arr.nm * NM_TO_M) / (gs * KTS_TO_MPS);
    return ttt > 6 + crossingS + (strict && crossingS > 100 ? 50 : 20);      // (one that is on the strip for long must be off it before the arrival is inside two miles)
  }
  /** A landed aircraft still on the runway that has rolled well past this point and is going away from it: an AI may cross behind it. */
  private rolledPast(id: number | string, rs: RunwayState, at: XY): boolean {
    const b = typeof id === 'number' ? this.byId(id) : null; const seg = this.runwaySegment(rs.ref);
    if (!b || !seg || b.phase !== 'rollout' || b.speed < 5) return false;
    const len = dist(seg.a, seg.b) || 1, ux = (seg.b.x - seg.a.x) / len, uy = (seg.b.y - seg.a.y) / len;
    const past = (b.pos.x - at.x) * ux + (b.pos.y - at.y) * uy;
    const along = Math.cos((angleDelta(b.heading, headingTo(seg.a, seg.b)) * Math.PI) / 180);
    return Math.abs(along) > 0.9 && past * Math.sign(along) > 350 + b.perf.lengthMeters;
  }
  /** Change a runway's status (both ends). Reason is free text. */
  setRunwayStatus(runway: string, status: RunwayStatus, reason: string | null): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const prev = rs.status;
    for (const r of this.bothEnds(rs.ref)) { r.status = status; r.statusReason = reason ?? ''; r.statusUntil = null; }
    if (status === 'open') for (const r of this.bothEnds(rs.ref)) { r.occupiedBy.length = 0; }
    if (prev !== status) {
      this.emit('runway_state', null, `Runway ${rs.ref} ${status}${reason ? ` (${reason})` : ''}`, { type: 'runway_state', runway: rs.name, status, previous: prev, reason: reason ?? '' });
      this.safe('alerts', () => { if (status !== 'open') this.alerts.raise('runway_status', [rs.ref], `Runway ${rs.ref} ${status}`, reason ?? '', this.time, { runway: rs.name }); else for (const al of this.alerts.active()) if (al.kind === 'runway_status' && al.subjects[0] === rs.ref) this.alerts.resolve(al.id, this.time); }, undefined);
      this.regenAtis(`runway ${rs.ref} ${status}`);
    }
    return { ...OK, extra: { runway: rs.name, status } };
  }
  reopenRunway(runway: string, afterInspection: boolean): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (rs.status === 'open') return { ok: false, code: 'already', reason: `Runway ${rs.ref} already open` };
    // Emergency aircraft still stopped on it are towed clear
    for (const a of this.aircraft) if (a.emergency && this.sc(a).onRunwayRef === rs.ref && a.phase === 'rollout') this.remove(a.id, 'arrived');
    const out = this.setRunwayStatus(runway, 'open', afterInspection ? 'inspection complete' : 'reopened');
    for (const a of this.aircraft) if (a.emergency && a.emergency.runway && this.refOf(a.emergency.runway) === rs.ref) this.checklist(a, 'runway_reopened');
    if (afterInspection) this.addScore('INSPECTION_CLEAN', 'SYSTEM', null, rs.name, `Runway ${rs.ref} inspected and reopened`);
    return out;
  }

  // ── scoring ────────────────────────────────────────────────────────────────
  /** Ledger entry through SCORE_TABLE; one incident per (code, primary, secondary) per 60 s (03 §B2). */
  addScore(code: ScoreCode, primary: string, secondary: string | null = null, runway: string | null = null, detail = ''): ScoreEvent | null {
    const key = `${code}|${primary}|${secondary ?? ''}`;
    const last = this.incidentLog.get(key);
    if (last != null && this.time - last < INCIDENT_DEDUPE_S) return null;
    this.incidentLog.set(key, this.time);
    const t = SCORE_TABLE[code];
    const ev: ScoreEvent = { code, at: this.time, primary, secondary, runway, points: t.points, skillDelta: t.skill, ref: t.ref, detail };
    return this.applyScore(ev);
  }
  private applyScore(ev: ScoreEvent): ScoreEvent {
    const st = this.stats;
    st.ledger.push(ev);
    st.points += ev.points;
    st.skill = Math.max(0, Math.min(12, st.skill + ev.skillDelta));
    st.score = Math.max(st.score, st.skill);
    st.incidents[ev.code] = (st.incidents[ev.code] ?? 0) + 1;
    if (ev.points < 0) st.streakS = 0;
    const a = this.find(ev.primary) ?? null;
    this.emit('score', a, `${ev.points >= 0 ? '+' : ''}${ev.points} ${ev.code.toLowerCase().replace(/_/g, ' ')}${ev.detail ? ` — ${ev.detail}` : ''}`, { type: 'score', score: ev });
    return ev;
  }
  private recordMovement(a: AircraftState) {
    const st = this.stats;
    st.movements++;
    if (a.plan.kind === 'departure') st.departures++; else st.arrivals++;
    const bucket = Math.floor(this.time / 300) * 300;
    let h = st.movementsHistory[st.movementsHistory.length - 1];
    if (!h || h.at !== bucket) { h = { at: bucket, dep: 0, arr: 0 }; st.movementsHistory.push(h); if (st.movementsHistory.length > 48) st.movementsHistory.shift(); }
    if (a.plan.kind === 'departure') h.dep++; else h.arr++;
    const win = st.movementsHistory.filter(x => x.at >= this.time - 1200);
    const n = win.reduce((s, x) => s + x.dep + x.arr, 0);
    st.movementsPerHour = Math.round(n * 3);
  }
  private recordDelay(a: AircraftState) {
    const d = a.delay;
    const total = d.requestWaitS + d.holdShortWaitS + d.holdingS + d.groundStoppedS;
    d.totalDelayS = total;
    const st = this.stats;
    st.delaySamples.push(total);
    if (st.delaySamples.length > 200) st.delaySamples.shift();
    const sorted = [...st.delaySamples].sort((x, y) => x - y);
    st.delayAvgS = sorted.reduce((s, x) => s + x, 0) / sorted.length;
    st.delayP95S = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    if (total > 900) this.addScore('DELAY_15', a.callsign, null, null, `${Math.round(total / 60)} min delay`);
    if (d.airborneS > 1800 && a.plan.kind === 'arrival') this.addScore('DELAY_30', a.callsign);
  }

  // ── pilot requests (UX §G8) ────────────────────────────────────────────────
  private reqSeq = 0;
  private static RECALL_S: Partial<Record<PilotRequestKind, number>> = { pushback: 45, startup: 45, taxi: 45, cross: 45, ready: 45, taxi_in: 45, higher: 90, lower: 90, direct: 120, say_again: 20, confirm_cleared: 30, runway_vacated: 60, further: 60, wind_check: 60, with_you: 60 };
  raiseRequest(a: AircraftState, kind: PilotRequestKind, param: string | number | null = null, text?: string): PilotRequest {
    if (this.time < a.standbyUntil && kind !== 'going_around' && kind !== 'cancel_mayday') { const s = this.sc(a); s.nextRequestAt = a.standbyUntil + 1; s.nextRequestKind = kind; return a.requests[0]; }
    const open = a.requests[0];
    if (open && open.kind === kind && open.answeredAt == null) return open;
    if (text == null && !open && crewLifeOf(this).blocks(a, kind)) {
      const s = this.sc(a); s.nextRequestAt = this.time + 7 + (a.id % 5); s.nextRequestKind = kind;
      this.emit('info', null, 'Two stations called at the same time', undefined, 'SYS');
      return open;
    }
    if (this.settings.personas) crewLifeOf(this).talking(a);
    const req: PilotRequest = {
      id: ++this.reqSeq, kind, callsign: a.callsign, text: '', param, at: this.time,
      recallAt: this.time + (SimEngine.RECALL_S[kind] ?? 60), recalls: 0,
      expiresAt: kind === 'with_you' ? this.time + 60 : kind === 'going_around' || kind === 'runway_vacated' ? this.time + 90 : null,
      suggestedAction: null, answeredAt: null, answeredBy: null,
    };
    req.text = text ?? this.requestText(a, req);
    if (this.settings.personas && text == null) { const crew = personaOf(a.callsign); if (crew.hesitant) req.text = personaLine(req.text, crew, stressOf(a), rng()); }
    a.requests = [req];
    if (a.delay.firstRequestAt == null) a.delay.firstRequestAt = this.time;
    a.lastTransmissionAt = this.time;
    this.emit('request', a, req.text, { type: 'request', request: req, change: 'raised' });
    return req;
  }
  private requestText(a: AircraftState, req: PilotRequest): string {
    const fromPhrase = this.safe('phrase', () => pilotRequestLine(req, this.phraseCtx(a)), '');
    if (fromPhrase) return fromPhrase;
    const cs = this.telephony(a.callsign);
    const unit = this.unitName(a.onFrequency);
    const atis = this.atisLetter();
    const info = atis ? `, information ${atis}` : '';
    switch (req.kind) {
      case 'pushback': return `${unit}, ${cs}, stand ${a.plan.gateRef ?? ''}, request pushback${info}.`;
      case 'startup': return `${unit}, ${cs}, stand ${a.plan.gateRef ?? ''}, request start-up${info}.`;
      case 'taxi': return `${unit}, ${cs}, request taxi.`;
      case 'cross': return `${cs}, holding short of runway ${req.param ?? ''}, request cross.`;
      case 'ready': return `${unit}, ${cs}, holding point runway ${a.plan.runway ?? ''}, ready for departure.`;
      case 'with_you': return `${unit}, ${cs}, with you${isAirborne(a) ? `, ${Math.round(a.altitude / 100) * 100} feet` : ''}.`;
      case 'higher': return `${cs}, request higher.`;
      case 'lower': return `${cs}, request descent.`;
      case 'direct': return `${cs}, request direct ${req.param ?? ''}.`;
      case 'taxi_in': return `${unit}, ${cs}, runway vacated, request taxi to stand ${a.plan.gateRef ?? ''}.`;
      case 'confirm_cleared': return `${cs}, ${Math.round(req.param as number)} mile final, confirm cleared to land?`;
      case 'runway_vacated': return `${cs}, runway vacated.`;
      case 'going_around': return `${cs}, going around${req.param ? `, ${req.param}` : ''}.`;
      case 'wind_check': return `${cs}, request wind check.`;
      case 'cancel_mayday': return `${cs}, cancel MAYDAY, cancel MAYDAY.`;
      case 'return_to_stand': return `${cs}, request return to stand, technical problem.`;
      case 'say_again': return `${cs}, say again.`;
      case 'radio_check': return `${unit}, ${cs}, radio check.`;
      case 'further': return `${cs}, over ${req.param ?? ''}, request further.`;
      case 'intersection': return `${cs}, request intersection departure ${req.param ?? ''}.`;
      case 'hold': return `${cs}, request hold.`;
      case 'clearance': return `${cs}, request clearance.`;
      case 'concern': return `${cs}, traffic${req.param ? `, ${req.param}` : ''}.`;
    }
  }
  /** Mark the open request as answered when a command of an answering kind arrives. */
  private answerRequest(a: AircraftState, kinds: PilotRequestKind[] | 'any', by: 'player' | 'ai' = 'player') {
    const s = this.sc(a);
    if (s.nextRequestKind && (kinds === 'any' || kinds.includes(s.nextRequestKind))) { s.nextRequestKind = null; s.nextRequestAt = null; }
    const req = a.requests[0]; if (!req || req.answeredAt != null) return;
    if (kinds !== 'any' && !kinds.includes(req.kind)) return;
    req.answeredAt = this.time; req.answeredBy = by;
    if (this.settings.personas) crewLifeOf(this).answered(a, req.recalls, req.kind);
    a.delay.requestWaitS += this.time - req.at;
    const st = this.stats; const n = st.movements + st.unansweredRequests + 1;
    st.responsivenessMeanS = st.responsivenessMeanS + ((this.time - req.at) - st.responsivenessMeanS) / n;
    this.emit('request', a, `${a.callsign} request ${req.kind} answered`, { type: 'request', request: req, change: 'answered' });
    a.requests = [];
  }
  private expireRequest(a: AircraftState) {
    const req = a.requests[0]; if (!req) return;
    req.answeredAt = this.time; req.answeredBy = 'timeout';
    this.emit('request', a, `${a.callsign} request ${req.kind} expired`, { type: 'request', request: req, change: 'expired' });
    a.requests = [];
  }
  private static ANSWERS: Partial<Record<CommandAST['kind'], PilotRequestKind[]>> = {
    pushback: ['pushback', 'startup'], startup: ['startup', 'pushback'], taxi: ['taxi', 'taxi_in', 'return_to_stand', 'intersection'], cross: ['cross'],
    lineup: ['ready'], takeoff: ['ready'], altitude: ['higher', 'lower'], direct: ['direct'], clearedLand: ['confirm_cleared'], continueApproach: ['confirm_cleared'],
    heading: ['further', 'hold'], hold: ['hold', 'further'], ils: ['further'], windCheck: ['wind_check'], roger: ['runway_vacated', 'going_around', 'radio_check'],
    contact: ['runway_vacated'], report: ['radio_check'], emergencyCancelAck: ['cancel_mayday'], radarContact: ['with_you'], goAround: ['going_around'],
    standby: [], unable: [],
  };

  // ── pilot delay / readbacks / transmissions ────────────────────────────────
  /** Pilot delay (s): 2-4 s air, 4-8 s ground, x pilotDelayFactor for incapacitation/hijack (03 §8 / §F4.16). */
  pilotDelayS(a: AircraftState, kind: CommandAST['kind']): number {
    const f = a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.pilotDelayFactor : 1;
    if (this.settings.pilotDelayOverride != null) return this.settings.pilotDelayOverride * f;
    const groundKind = !isAirborne(a) && !['heading', 'altitude', 'speed', 'direct', 'hold', 'ils', 'loc', 'visual', 'goAround', 'clearedLand'].includes(kind);
    void kind;
    const crew = this.settings.personas ? delayFactor(personaOf(a.callsign), stressOf(a)) : 1;
    return (groundKind ? rf(4, 8) : rf(2, 4)) * f * crew;
  }
  unitName(position: Position): string {
    const name = this.airportName;
    switch (position) { case 'ground': return `${name} Ground`; case 'tower': return `${name} Tower`; case 'departure': return `${name} Departure`; case 'approach': return `${name} Approach`; default: return 'Control'; }
  }
  phraseCtx(a: AircraftState | null): PhraseCtx {
    const w = this.wx();
    return {
      variant: this.settings.region,
      telephony: (cs: string) => this.telephony(cs),
      unit: (p: Position) => this.unitName(p),
      freq: (p: Position) => this.frequencies[p] ?? '',
      wind: { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt },
      qnh: w.qnh,
      atisLetter: this.atisLetter(),
      magVar: this.magVar,
      transitionAltFt: this.transitionAltFt,
      time: this.time,
      aircraft: a,
      spokenType: (icao: string) => spokenTypeOf(icao),
    };
  }
  /** Strict-frequency policy (03 §B6): only enforced when the setting is on; every frequency of the player's sector (ground + tower = airfield) is theirs. */
  onPlayerFrequency(a: AircraftState): boolean {
    if (!this.settings.strictFrequencies) return true;
    const owner = POSITION_OWNER[a.onFrequency];
    return owner != null && SECTOR_OF[owner] === SECTOR_OF[this.playerPosition];
  }
  /** Called by dispatch after composing the result: transmission event now, readback event at readbackAt. */
  onTransmission(ast: CommandAST, result: CommandResult, a: AircraftState | null): void {
    this.stats.transmissions++;
    if (a) { a.lastAtcTransmissionAt = this.time; a.readback.lastAst = ast; }
    if (SILENT_CODES.includes(result.code)) return;
    this.emit('transmission', a, result.transmission || describe(ast), { type: 'transmission', ast, result, who: 'player' }, 'ATC');
    if (!a) return;
    const status: ReadbackStatus = result.code === 'partial' ? 'partial' : result.code === 'queried' ? 'say_again' : result.code.startsWith('unable') ? 'unable' : 'ok';
    const at = result.readbackAt ?? this.time + (this.settings.pilotDelayOverride ?? rf(2, 4));
    let text = result.readback || this.fallbackReadback(ast, a, status, result.reason);
    let mismatch: ScheduledReadback['mismatch'] = null;
    const crew = this.settings.personas ? personaOf(a.callsign) : null;
    if (status === 'ok' && this.settings.pilotErrorRate > 0 && chance(this.settings.pilotErrorRate * (crew ? errorFactor(crew, stressOf(a)) : 1))) {
      const m = this.wrongReadback(ast, text, a); if (m) { mismatch = m.mismatch; text = m.text; }
    }
    if (crew?.hesitant) text = personaLine(text, crew, stressOf(a), rng());
    if (status === 'ok' && !mismatch && crew) { const more = crewLifeOf(this).aside(a, ast); if (more && /\.$/.test(text)) text = `${text.slice(0, -1)}, ${more}.`; }
    a.readback = { ...a.readback, status: 'pending', dueAt: at, text: '', mismatch: null, refused: result.refused ?? [] };
    this.readbacks.push({ at, aircraftId: a.id, status: mismatch ? 'mismatch' : status, text, ast, refused: result.refused ?? [], mismatch });
  }
  private fallbackReadback(ast: CommandAST, a: AircraftState, status: ReadbackStatus, reason?: string): string {
    const rb = this.safe('phrase', () => phraseReadback(ast, this.phraseCtx(a)), '');
    if (rb) return rb;
    const cs = this.telephony(a.callsign);
    if (status === 'unable') return `Unable${reason ? `, ${reason.toLowerCase()}` : ''}, ${cs}.`;
    if (status === 'say_again') return `${cs}, ${reason ?? 'say again'}?`;
    return `${describe(ast)}, ${cs}.`;
  }
  /** 2 % wrong readback (03 §G4): re-speak the readback from a perturbed AST (heading/altitude/speed/runway) so the error is audible in the spoken numbers. */
  private wrongReadback(ast: CommandAST, text: string, a: AircraftState): { text: string; mismatch: NonNullable<ScheduledReadback['mismatch']> } | null {
    let wrongAst: CommandAST | null = null; let mismatch: NonNullable<ScheduledReadback['mismatch']> | null = null;
    if (ast.kind === 'heading') { const w = ((ast.hdg + (chance(0.5) ? 10 : -10)) % 360 + 360) % 360 || 360; wrongAst = { ...ast, hdg: w }; mismatch = { field: 'heading', expected: hdg3(ast.hdg), read: hdg3(w) }; }
    else if (ast.kind === 'altitude') { const w = Math.max(1000, ast.ft + (chance(0.5) ? 1000 : -1000)); wrongAst = { ...ast, ft: w }; mismatch = { field: 'altitude', expected: String(ast.ft), read: String(w) }; }
    else if (ast.kind === 'speed' && typeof ast.kts === 'number') { const w = ast.kts + 10; wrongAst = { ...ast, kts: w }; mismatch = { field: 'speed', expected: String(ast.kts), read: String(w) }; }
    else if (ast.kind === 'taxi' && ast.dest.kind === 'runway' || ast.kind === 'lineup' || ast.kind === 'takeoff' || ast.kind === 'clearedLand' || ast.kind === 'ils') {
      const rwy = ast.kind === 'taxi' ? (ast.dest as { runway: string }).runway : (ast as { runway: string }).runway;
      const rs = this.runwayState(rwy); if (!rs) return null;
      const other = this.runways.find(r => r.name !== rs.name && r.ref !== rs.ref && r.name.slice(0, 2) === rs.name.slice(0, 2)) ?? this.runways.find(r => r.ref !== rs.ref);
      if (!other) return null;
      wrongAst = ast.kind === 'taxi' ? { ...ast, dest: { ...ast.dest, runway: other.name } } as CommandAST : { ...ast, runway: other.name } as CommandAST;
      mismatch = { field: 'runway', expected: rs.name, read: other.name };
    }
    if (!wrongAst || !mismatch) return null;
    const spoken = this.safe('phrase', () => phraseReadback(wrongAst!, this.phraseCtx(a)), '');
    if (!spoken || spoken === text) return null;
    return { text: spoken, mismatch };
  }
  private processReadbacks() {
    if (!this.readbacks.length) return;
    const due = this.readbacks.filter(r => r.at <= this.time);
    if (!due.length) return;
    this.readbacks = this.readbacks.filter(r => r.at > this.time);
    for (const r of due) {
      const a = this.byId(r.aircraftId); if (!a) continue;
      if (a.emergency?.type === 'radio_failure') continue;
      a.readback.status = r.status; a.readback.text = r.text; a.readback.at = this.time; a.readback.refused = r.refused;
      a.readback.mismatch = r.mismatch ? { ...r.mismatch, deadline: this.time + READBACK_MISMATCH_WINDOW_S } : null;
      a.lastTransmissionAt = this.time;
      this.emit('readback', a, r.text, { type: 'readback', status: r.status, text: r.text, ast: r.ast, refused: r.refused });
    }
  }
  /** Uncorrected wrong readback after 15 s: the wrong value executes (G4) and READBACK_ERROR_MISSED is scored. */
  private enforceMismatch(a: AircraftState) {
    const m = a.readback.mismatch; if (!m || this.time < m.deadline) return;
    a.readback.mismatch = null;
    this.addScore('READBACK_ERROR_MISSED', a.callsign, null, null, `${m.field} read back ${m.read}, expected ${m.expected}`);
    if (m.field === 'heading') { const v = parseInt(m.read, 10) % 360; const p = a.pendingCmds.find(c => c.kind === 'heading'); if (p) p.value = v; else if (a.navMode === 'heading') a.targetHeading = v; }
    else if (m.field === 'altitude') { const v = parseInt(m.read, 10); const p = a.pendingCmds.find(c => c.kind === 'altitude'); if (p) p.value = v; else { a.targetAltitude = v; a.cmdAltitude = v; } }
    else if (m.field === 'speed') { const v = parseInt(m.read, 10); const p = a.pendingCmds.find(c => c.kind === 'speed'); if (p) p.value = v; else { a.targetSpeed = v; a.cmdIas = v; } }
    this.emit('info', a, `${a.callsign} executing uncorrected readback: ${m.field} ${m.read}`);
  }

  // ── pending queue (UX §G5.1) ───────────────────────────────────────────────
  private enqueue(a: AircraftState, ast: CommandAST, opts: { condition?: PendingCondition | null; value?: number; untilNM?: number | null; cancellable?: boolean; immediate?: boolean } = {}): EngineOutcome {
    const kind = ast.kind as PendingCmd['kind'];
    const immediate = opts.immediate ?? IMMEDIATE_KINDS.includes(ast.kind);
    const delay = immediate ? 0 : this.pilotDelayS(a, ast.kind);
    if (NUMERIC_KINDS.has(kind)) a.pendingCmds = a.pendingCmds.filter(c => c.kind !== kind);
    // The parts of one transmission (same issue time) share one pilot delay and execute in the order they were
    // spoken: "turn right heading 245, cleared ILS" must never arm the ILS before the turn (or cancel it after).
    const sibling = immediate ? undefined : a.pendingCmds.find(c => c.issuedAt === this.time && c.applyAt > this.time);
    const applyAt = sibling ? sibling.applyAt : this.time + delay;
    a.pendingCmds.push({ kind, value: opts.value ?? 0, applyAt, condition: opts.condition ?? undefined, ast, issuedAt: this.time, cancellable: opts.cancellable ?? true, untilNM: opts.untilNM ?? undefined });
    a.underControl = true; a.attention = false;
    return { ok: true, code: opts.condition ? 'ok_conditional' : 'ok_queued', applyAt, applied: false };
  }
  private conditionMet(a: AircraftState, c: PendingCondition | undefined): boolean {
    if (!c) return true;
    const s = this.sc(a);
    switch (c.type) {
      case 'after_pushback': return a.phase !== 'pushback' && (a.pushback.stage === 'complete' || a.pushback.stage === 'none') && a.startup.enginesStable;
      case 'when_ready': return a.startup.enginesStable && a.phase !== 'pushback';
      case 'on_reaching_hold': return a.phase === 'hold_short' && !!a.holdShortNode && !!a.plan.runway && this.isHoldNodeForRunway(a.holdShortNode, a.plan.runway);
      case 'at_or_below_alt': return a.altitude <= c.ft + 50;
      case 'at_or_above_alt': return a.altitude >= c.ft - 50;
      case 'after_fix': return s.passedFixes.has(upper(c.fix));
      case 'after_vacated': return s.vacated;
      case 'behind_aircraft': {
        const b = this.byId(c.id) ?? this.find(c.callsign);
        if (!b) return true;
        // the runway the condition protects: the next hold on the path (a crossing), else the departure runway
        const hold = a.path?.holds?.[0];
        const rw = (hold && hold.runway) || a.holdShortRunway || a.plan.runway;
        const ref = rw ? this.refOf(rw) : null;
        if (isAirborne(b)) { const d = rw ? this.distToThresholdNM(b, rw) : null; return b.plan.kind === 'departure' || (d != null && d > 3 && !b.ilsCaptured); }
        if (b.phase === 'takeoff' || b.phase === 'lineup') return false;
        if (b.phase === 'rollout') {
          // "behind the landing traffic" (03 D12): a crossing may start once the lander has rolled past the crossing
          // point; a line-up behind it waits for the runway to be vacated.
          if (!hold || hold.isDepartureEntry) return false;
          const info = this.holdNodeInfo.get(a.holdShortNode ?? hold.nodeId);
          const rx = info ? this.nodeXY(info.runwayNodeId) : null;
          if (!rx || (ref && this.refOf(hold.runway) !== ref)) return false;
          return alongTrack(b.pos, rx, b.heading) > b.perf.lengthMeters + 150;
        }
        return ref ? this.distToRunway(b.pos, ref) > HOLD_LINE_M : true;
      }
    }
  }
  private drainPending(a: AircraftState) {
    if (!a.pendingCmds.length) return;
    const ready = a.pendingCmds.filter(c => c.applyAt <= this.time && this.conditionMet(a, c.condition));
    if (!ready.length) return;
    a.pendingCmds = a.pendingCmds.filter(c => !ready.includes(c));
    for (const c of ready) {
      if (c.ast) this.applyAst(a, c.ast, c);
      else if (c.kind === 'heading') { a.targetHeading = c.value; a.navMode = 'heading'; }
      else if (c.kind === 'altitude') a.targetAltitude = c.value;
      else if (c.kind === 'speed') a.targetSpeed = c.value;
    }
  }

  // ── AST execution (at applyAt) ─────────────────────────────────────────────
  private applyAst(a: AircraftState, ast: CommandAST, cmd?: PendingCmd) {
    switch (ast.kind) {
      case 'startup': this.execStartup(a, ast.expectRunway); break;
      case 'pushback': this.execPushback(a, ast.dir, ast.expectRunway, ast.startup, ast.tailTo); break;
      case 'taxi': this.execTaxi(a, ast.dest, ast.via, ast.auto, ast.holdShortOf, ast.cross, ast.expedite, ast.limit ?? null); break;
      case 'holdShort': this.execHoldShort(a, ast.of); break;
      case 'holdPosition': this.execHoldPosition(a); break;
      case 'continue': this.execContinue(a, ast.holdShortOf); break;
      case 'cross': this.execCross(a, ast.runway); break;
      case 'giveWay': this.execGiveWay(a, ast.to, ast.mode); break;
      case 'lineup': this.execLineUp(a, ast.runway, ast.intersection); break;
      case 'takeoff': this.execTakeoff(a, ast.runway, { immediate: ast.immediate, afterDepHdg: ast.afterDepHdg, turn: ast.turn, initialAlt: ast.initialAlt, contactDeparture: ast.contactDeparture }); break;
      case 'cancelLineup': this.execCancelLineup(a, ast.via); break;
      case 'exitAt': this.execExitAt(a, ast.exit, ast.expedite, ast.holdShortOf, ast.contactGround); break;
      case 'expedite': this.execExpedite(a, ast.on, ast.scope); break;
      case 'clearedLand': this.execClearedLand(a, ast.runway, ast.lahso, ast.exit); break;
      case 'continueApproach': { const s = this.sc(a); s.continueApproach = true; break; }
      case 'goAround': this.execGoAround(a, ast.heading, ast.alt, ast.contact); break;
      case 'contact': this.execHandoff(a, ast.position); break;
      case 'heading': this.execHeading(a, cmd?.value ?? ast.hdg, ast.dir); break;
      case 'altitude': this.execAltitude(a, cmd?.value ?? ast.ft, ast.expedite); break;
      case 'speed': this.execSpeed(a, ast.kts === 'resume' ? null : (cmd?.value ?? ast.kts), ast.untilNM); break;
      case 'direct': this.execDirect(a, ast.fix, ast.thenHdg); break;
      case 'hold': this.execHold(a, ast.fix, ast.inbound, ast.dir, ast.legTimeMin, ast.legNM, ast.efc); break;
      case 'ils': this.execILS(a, ast.runway, false, null, cmd?.issuedAt); break;
      case 'loc': this.execILS(a, ast.runway, true, ast.maintainAlt, cmd?.issuedAt); break;
      case 'visual': this.execVisual(a, ast.runway); break;
      case 'cancelApproach': this.execCancelApproach(a, ast.hdg, ast.alt, ast.dir); break;
      case 'expectRunway': this.sc(a).rwyTold = true; a.plan.runway = ast.runway; a.assignedRunway = null; break;
      case 'resumeSid': a.navMode = 'sid'; a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; break;
      case 'squawk': a.squawk = ast.code; break;
      case 'ident': a.identUntil = this.time + 10; break;
      case 'radarContact': a.underControl = true; a.attention = false; if (ast.descendTo != null) this.execAltitude(a, ast.descendTo, false); if (ast.expectRunway) a.plan.runway = ast.expectRunway; break;
      case 'priority': this.execPriority(a, ast.runway, ast); break;
      case 'stopOnRunway': if (a.emergency) { a.emergency.stopOnRunway = ast.mode === 'stop'; if (ast.mode === 'vacate_if_able') a.emergency.requests.push('vacate_if_able'); if (ast.via) a.exitTaxiway = upper(ast.via); } break;
      default: break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — ground
  // ═══════════════════════════════════════════════════════════════════════════
  cmdStartup(a: AircraftState, expectRunway: string | null): EngineOutcome {
    if (a.phase !== 'parked') return { ok: false, code: a.startup.startedAt != null ? 'already' : 'invalid_stage', reason: a.startup.startedAt != null ? 'Already started' : 'Not parked' };
    if (a.needsPushback) return { ok: false, code: 'invalid_stage', reason: 'Use Pushback' };
    if (expectRunway && !this.runwayState(expectRunway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${expectRunway}` };
    this.answerRequest(a, SimEngine.ANSWERS.startup!);
    return this.enqueue(a, makeAst('startup', a.callsign, { expectRunway }));
  }
  private execStartup(a: AircraftState, expectRunway: string | null) {
    if (a.startup.startedAt != null) return;
    const [lo, hi] = a.perf.startupS;
    let dur = rf(lo, hi);
    a.startup.startedAt = this.time;
    if (chance(0.04)) { a.startup.failed = true; dur += 300; this.emit('startup', a, `${a.callsign} start aborted, hot start, request five minutes`, undefined, 'PILOT'); }
    a.startup.readyAt = this.time + dur; a.startup.enginesStable = false;
    if (expectRunway) { a.plan.runway = upper(expectRunway); this.sc(a).rwyTold = true; }
    if (a.phase === 'parked') { a.phase = 'startup'; }
    this.emit('startup', a, `${a.callsign} starting engines (${Math.round(dur)} s)`);
  }
  cmdPushback(a: AircraftState, dir: PushDir, expectRunway: string | null, withStartup: boolean, tailTo: string | null): EngineOutcome {
    if (a.phase !== 'parked') return { ok: false, code: a.phase === 'pushback' ? 'already' : 'invalid_stage', reason: a.phase === 'pushback' ? 'Already cleared' : 'Not parked' };
    if (!a.needsPushback) return { ok: false, code: 'invalid_stage', reason: `Pushback not required at stand ${a.plan.gateRef ?? ''}` };
    if (expectRunway && !this.runwayState(expectRunway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${expectRunway}` };
    if (!this.pushbackPath(a, dir)) return { ok: false, code: 'no_route', reason: 'No pushback lane' };
    this.answerRequest(a, SimEngine.ANSWERS.pushback!);
    return { ...this.enqueue(a, makeAst('pushback', a.callsign, { dir, expectRunway, startup: withStartup, tailTo })), extra: { runway: expectRunway ?? a.plan.runway ?? null } };
  }
  private execPushback(a: AircraftState, dir: PushDir, expectRunway: string | null, withStartup: boolean, tailTo: string | null) {
    void tailTo;
    if (a.phase !== 'parked') return;
    if (expectRunway) { a.plan.runway = upper(expectRunway); this.sc(a).rwyTold = true; }   // before the path: 'any' faces the runway the pilot was told to expect
    const path = this.pushbackPath(a, dir); if (!path) return;
    a.pushback = { ...defaultPushback(), stage: 'tug_attach', stageUntil: this.time + rf(20, 40), facing: dir, tugId: 'TUG', totalM: path.total, expectRunway: expectRunway ?? a.plan.runway ?? null };
    a.path = path; a.distAlong = 0; a.holdReleased = true; a.speed = 0;
    a.phase = 'pushback'; this.sc(a).pushJoin = path.join ?? null;
    a.delay.pushbackAt = this.time;
    if (withStartup || a.startup.startedAt == null) this.execStartup(a, expectRunway);
    this.releaseStands(a);
    this.emit('pushback', a, `${a.callsign} pushback: tug connecting`);
  }
  cmdTaxi(a: AircraftState, dest: TaxiDest, via: string[], auto: boolean, holdShortOf: HoldShortTarget | null, cross: string[], expedite: boolean, limit: 'hold' | 'crossed' | null = null): EngineOutcome {
    if (a.phase === 'parked') return { ok: false, code: 'invalid_stage', reason: a.needsPushback ? 'Push back first' : 'Start up first' };
    if (isAirborne(a) || a.phase === 'takeoff' || a.phase === 'lineup' || a.phase === 'landing') return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    if (a.phase === 'arrived' || a.phase === 'departed') return { ok: false, code: 'invalid_stage', reason: 'On stand' };
    if (dest.kind === 'runway' && a.plan.kind === 'departure') {
      const rs = this.runwayState(dest.runway);
      if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${dest.runway}` };
      if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    }
    if (dest.kind === 'stand') { const occ = this.standOccupant(dest.ref); if (occ && occ !== a.callsign) return { ok: false, code: 'unknown_stand', reason: `Stand ${dest.ref} occupied by ${occ}` }; }
    let plan = this.planTaxi(a, dest, via);
    if ('code' in plan) return { ok: false, code: plan.code, reason: plan.reason };
    if (limit === 'hold' && holdShortOf?.kind === 'taxiway' && this.air.taxiwayNodes.has(upper(holdShortOf.taxiway)) && this.taxiwayOnPath(plan.path, upper(holdShortOf.taxiway)) == null) {
      // the limit is not on the usual way: go that way ("hold short of K" says where the aircraft is being sent)
      const round = this.planTaxi(a, dest, [...via, upper(holdShortOf.taxiway)]);
      if ('code' in round || this.taxiwayOnPath(round.path, upper(holdShortOf.taxiway)) == null) return { ok: false, code: 'unable_route', reason: `Unable, ${upper(holdShortOf.taxiway)} is not on our way` };
      plan = round; via = [...via, upper(holdShortOf.taxiway)];
    }
    if (limit === 'crossed') {
      const refs = cross.map(c => this.refOf(c));
      if (!plan.path.holds!.some(h => !h.isDepartureEntry && refs.includes(this.refOf(h.runway)))) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, ${cross.join(' and ')} is not on our way, confirm?` };
    }
    if (holdShortOf?.kind === 'taxiway' && !this.air.taxiwayNodes.has(upper(holdShortOf.taxiway))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(holdShortOf.taxiway)} here` };
    for (const x of cross) if (!this.runwayState(x)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${x}` };
    // (a runway crossing nobody mentioned is an implicit hold short: the crew stops there by itself, and it is not marked against
    // the controller; a call too vague to give a route is refused above, with the reason)
    this.answerRequest(a, cross.length ? [...SimEngine.ANSWERS.taxi!, 'cross'] : SimEngine.ANSWERS.taxi!);
    // a rollout takes the taxi clearance once off the runway - unless it has come to a stop on the runway (no exit
    // found, the end of a short runway): then the taxi is the way off it
    const stoppedOnRunway = a.phase === 'rollout' && a.speed < 1 && !this.sc(a).vacated;
    const condition: PendingCondition | null = a.phase === 'pushback' ? { type: 'after_pushback' } : a.phase === 'startup' && !a.startup.enginesStable ? { type: 'when_ready' } : a.phase === 'rollout' && !stoppedOnRunway ? { type: 'after_vacated' } : null;
    const ast = makeAst('taxi', a.callsign, { dest, via, auto, holdShortOf, cross, expedite, ...(limit ? { limit } : {}) });
    return { ...this.enqueue(a, ast, { condition }), extra: { route: plan.ids.length ? taxiwaysForPath(this.air, plan.ids).join(' ') : '', runway: plan.runway, stand: plan.stand } };
  }
  /** The end of a physical runway that is in use: pilots and controllers call it by that name (28R, not 10L, while landing 28s). */
  private endInUse(ref: string | null | undefined): RunwayState | null {
    if (!ref) return null;
    const ends = this.bothEnds(ref), live = ends.filter(r => r.activeArr || r.activeDep);
    if (live.length === 1) return live[0];
    return this.opsHeading == null ? null : (live.length ? live : ends).find(r => Math.abs(angleDelta(r.headingTrue, this.opsHeading!)) < 90) ?? null;
  }
  /** Arc length at which a path first meets a taxiway ahead (null: it does not). */
  /** Whether the player (not an AI position) works this flight's frequency now. */
  playerWorks(a: AircraftState): boolean { const o = POSITION_OWNER[a.onFrequency]; return o != null && !this.aiOn(o); }
  /** Tailwind on a runway heading, kt (negative: headwind). */
  tailwindKt(headingTrue: number): number { return -this.windFor(headingTrue).headKt; }
  // what the crew looks at before it accepts a taxi (taximind.ts)
  /** The route a taxi clearance would give, with its taxiway names; `avoid` = nodes to keep off. */
  taxiPlan(a: AircraftState, dest: TaxiDest, via: string[], avoid?: Set<string>): { ids: string[]; names: string[]; path: DrivePath } | { code: ResultCode; reason: string } {
    const was = this.rerouteAvoid; if (avoid) this.rerouteAvoid = avoid;
    try { const p = this.planTaxi(a, dest, via); return 'code' in p ? p : { ids: p.ids, names: taxiwaysForPath(this.air, p.ids), path: p.path }; } finally { this.rerouteAvoid = was; }
  }
  /** Arc length at which a path first meets a taxiway beyond `from` (null: it does not). */
  taxiMeets(path: DrivePath, taxiway: string, from = 0): number | null { return this.taxiwayOnPath(path, upper(taxiway), from); }
  /** The rest of a taxiing aircraft's route, as nodes. */
  routeAhead(b: AircraftState): string[] {
    const ids = this.sc(b).routeIds; if (!ids?.length) return [];
    let k = 0, bd = Infinity; ids.forEach((id, i) => { const xy = this.nodeXY(id); const d = xy ? dist(xy, b.pos) : Infinity; if (d < bd) { bd = d; k = i; } });
    return ids.slice(k);
  }
  /** The taxiway an aircraft is on. */
  taxiwayUnder(a: AircraftState): string | null { const id = this.nearestNodeId(a.pos, 60); return id ? this.air.nodes.get(id)?.edges.find(x => x.taxiway)?.taxiway ?? null : null; }
  /** Whether a parked (not playing) aircraft stands on this stand: it makes room for a flight sent there, so it is only "taken" for an offer. */
  parkedOn(ref: string): boolean { return this.parkedByRef.has(ref); }
  spokenType(a: AircraftState): string { return spokenTypeOf(a.perf.icaoCode); }
  private taxiwayOnPath(path: DrivePath, taxiway: string, from = 0): number | null {
    let at: number | null = null;
    for (const id of this.air.taxiwayNodes.get(taxiway) ?? []) {
      const pr = projectOntoPath(path.pts, path.cum, this.nodeXY(id)!, from);
      if (pr.dist < 12 && pr.at > from + 5 && (at == null || pr.at < at)) at = pr.at;
    }
    return at;
  }
  /** Hold once clear of the last of `cross` on the path: the far side of its strip, the whole aircraft past the line. */
  private insertCrossedHold(a: AircraftState, path: DrivePath, crossed: PathHold[]): boolean {
    const last = [...crossed].sort((x, y) => y.at - x.at)[0]; if (!last) return false;
    const ref = this.refOf(last.runway); if (!ref) return false;
    const clear = HOLD_LINE_M - 15 + a.perf.lengthMeters * 0.5;
    let inside = false;
    for (let at = last.at; at < path.total; at += 4) {
      const d = this.distToRunway(sampleAlong(path.pts, path.cum, at).pos, ref);
      if (d < STRIP_HALF_M) inside = true;
      if (inside && d > clear) {
        // a hold line of the next runway that comes first (close parallels) stays the stop
        const p = sampleAlong(path.pts, path.cum, at).pos;
        if (path.holds!.some(h => h.at > last.at && h.at <= at + 5)) return true;
        path.holds!.push({ nodeId: this.nearestNodeId(p, 200) ?? last.nodeId, runway: '', at, isDepartureEntry: false });
        path.holds!.sort((x, y) => x.at - y.at);
        return true;
      }
    }
    return false;
  }
  private execTaxi(a: AircraftState, dest: TaxiDest, via: string[], auto: boolean, holdShortOf: HoldShortTarget | null, cross: string[], expedite: boolean, limit: 'hold' | 'crossed' | null = null) {
    void auto;
    if (isAirborne(a) || a.phase === 'takeoff' || a.phase === 'lineup') return;
    const s = this.sc(a);
    // the way round a standoff that the flight card offered: the player's taxi clearance plans round the blocker too
    if (!s.rerouteAvoidNodes && s.adviceAvoid && this.time - s.adviceAt < 90) s.rerouteAvoidNodes = s.adviceAvoid;
    s.adviceAvoid = null;
    this.rerouteAvoid = s.rerouteAvoidNodes; s.rerouteAvoidNodes = null;
    // a new route voids a crossing clearance not yet begun (the new path has its own hold lines)
    if (s.crossingRef && !s.crossingEntered) { this.removeOccupant(s.crossingRef, a.id); s.crossingRef = null; s.crossingMinD = Infinity; s.onRunwayRef = null; }
    const plan = this.planTaxi(a, dest, via);
    this.rerouteAvoid = null;
    if ('code' in plan) { this.emit('readback', a, `Unable, ${plan.reason.toLowerCase()}, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: plan.reason, ast: null, refused: [] }); return; }
    const path = plan.path;
    // Explicit hold-short target / crossing clearances in the same transmission
    if (holdShortOf?.kind === 'taxiway') this.insertTaxiwayHold(a, path, upper(holdShortOf.taxiway));
    // a further step given before the aircraft has crossed: the crossing already cleared stands
    if (limit) for (const h of s.preclearedHolds ?? []) if (a.path && a.distAlong < h.at - 1 && !cross.some(c => this.refOf(c) === this.refOf(h.runway))) cross = [...cross, h.runway];
    s.preclearedHolds = []; s.limitSay = null;
    for (const c of cross) { const ref = this.refOf(c); const h = path.holds!.find(x => this.refOf(x.runway) === ref && !x.isDepartureEntry); if (h) { path.holds!.splice(path.holds!.indexOf(h), 1); s.preclearedHolds.push(h); } }
    if (limit === 'crossed') this.insertCrossedHold(a, path, s.preclearedHolds);
    path.holdAt = path.holds!.length ? path.holds![0].at : undefined;
    if (limit === 'crossed') s.limitSay = `clear of ${this.spokenRwy(cross[cross.length - 1])}, holding`;
    else if (holdShortOf?.kind === 'taxiway') s.limitSay = `holding short of ${spokenTaxiway(upper(holdShortOf.taxiway))}`;
    // Leaving a runway / a hold node: release runway occupancy bookkeeping
    if (s.onRunwayRef && (a.phase === 'rollout' || a.phase === 'hold_short')) { /* vacate handled by transitions */ }
    a.path = path; a.distAlong = 0; a.holdReleased = false; a.takeoffCleared = false;
    a.holdShortNode = null; a.holdShortRunway = null; a.holdShortTaxiway = holdShortOf?.kind === 'taxiway' ? upper(holdShortOf.taxiway) : null;
    a.plan.taxiRoute = taxiwaysForPath(this.air, plan.ids);
    s.routeIds = plan.ids;
    s.taxiDest = dest;
    if (plan.runway) { this.sc(a).rwyTold = true; a.plan.runway = plan.runway; if (a.plan.kind === 'departure') { a.assignedRunway = null; } }
    if (plan.stand) { a.plan.gateRef = plan.stand; const g = this.gateByRef(plan.stand); if (g) { this.releaseStands(a); this.reserveStand(g, a); } }
    if (expedite) a.expediteTaxiUntil = this.time + 90;
    if (a.delay.taxiStartAt == null) a.delay.taxiStartAt = this.time;
    if (a.phase === 'rollout') { for (const rs of this.runways) this.removeOccupant(rs.ref, a.id); }
    if (a.phase === 'startup') { a.reservedStand = null; this.releaseStands(a); }
    a.phase = 'taxi';
    s.stoppedSince = null;
    this.emit('phase', a, `${a.callsign} -> taxi`);
  }
  private insertTaxiwayHold(a: AircraftState, path: DrivePath, taxiway: string): boolean {
    const nodes = this.air.taxiwayNodes.get(taxiway); if (!nodes) return false;
    let best: { at: number; nodeId: string } | null = null;
    for (const id of nodes) {
      const xy = this.nodeXY(id)!;
      const pr = projectOntoPath(path.pts, path.cum, xy, a.distAlong);
      if (pr.dist < 12 && pr.at > a.distAlong + 5 && (!best || pr.at < best.at)) best = { at: pr.at, nodeId: id };
    }
    if (!best) return false;
    let at = Math.max(a.distAlong + 1, best.at - 15);
    // where it joins on (or beside) a runway the place to stop is the hold line before that runway, not the strip
    { const zone = (m: number) => this.runwaysAt(sampleAlong(path.pts, path.cum, m).pos, HOLD_LINE_M - 4); const start = new Set(zone(a.distAlong)); let m = at; while (m > a.distAlong + 1 && zone(m).some(q => !start.has(q))) m -= 5; at = Math.max(a.distAlong + 1, m); }
    path.holds = path.holds ?? [];
    if (!path.holds.some(h => Math.abs(h.at - at) < 5)) path.holds.push({ nodeId: best.nodeId, runway: '', at, isDepartureEntry: false });
    path.holds.sort((x, y) => x.at - y.at);
    path.holdAt = path.holds[0].at;
    a.holdShortTaxiway = taxiway;
    return true;
  }
  cmdHoldShort(a: AircraftState, of: HoldShortTarget): EngineOutcome {
    if (isAirborne(a) || a.phase === 'takeoff') return { ok: false, code: 'invalid_stage', reason: 'Airborne — use Go around' };
    if (!a.path || (a.phase !== 'taxi' && a.phase !== 'hold_short' && a.phase !== 'rollout')) return { ok: false, code: 'invalid_stage', reason: 'Not moving' };
    if (of.kind === 'runway') {
      const ref = this.refOf(of.runway); if (!ref) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${of.runway}` };
      const h = a.path.holds?.find(x => this.refOf(x.runway) === ref) ?? this.sc(a).preclearedHolds?.find(x => this.refOf(x.runway) === ref && a.distAlong < x.at - 1);
      if (!h) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, unable, ${of.runway} is not on our route` };
      if (a.phase === 'hold_short' && a.path.holds![0] === h) return { ok: false, code: 'already', reason: 'Already holding short' };
    } else if (of.kind === 'taxiway') {
      if (!this.air.taxiwayNodes.has(upper(of.taxiway))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(of.taxiway)} here` };
    }
    return this.enqueue(a, makeAst('holdShort', a.callsign, { of }));
  }
  private execHoldShort(a: AircraftState, of: HoldShortTarget) {
    if (!a.path) return;
    if (of.kind === 'runway') {
      const ref = this.refOf(of.runway);
      let h = a.path.holds?.find(x => this.refOf(x.runway) === ref);
      // a crossing pre-cleared in the taxi clearance can be re-armed while the aircraft is still short of it
      const s = this.sc(a);
      const pre = !h ? s.preclearedHolds?.find(x => this.refOf(x.runway) === ref && a.distAlong < x.at - 1) : undefined;
      if (pre) { s.preclearedHolds = s.preclearedHolds!.filter(x => x !== pre); a.path.holds = [...(a.path.holds ?? []), pre].sort((x, y) => x.at - y.at); a.path.holdAt = a.path.holds[0].at; h = pre; }
      // re-arm a released crossing only while the aircraft can still stop before the line (never pull it back, B5)
      if (h && a.path.holds![0] === h) {
        if (a.distAlong <= h.at - HOLD_BUFFER_M) a.holdReleased = false;
        else if (a.distAlong < h.at - 1) { h.at = Math.max(h.at, a.distAlong + HOLD_BUFFER_M + this.brakingM(a.speed, 2.5)); a.path.holdAt = h.at; a.holdReleased = false; }
        else this.emit('readback', a, `Unable, already crossing ${of.runway}, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: `already crossing ${of.runway}`, ast: null, refused: [] });
      }
    } else if (of.kind === 'taxiway') {
      if (this.insertTaxiwayHold(a, a.path, upper(of.taxiway))) this.sc(a).limitSay = `holding short of ${spokenTaxiway(upper(of.taxiway))}`;
      else this.emit('readback', a, `Unable, already past ${of.taxiway}, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: `already past ${of.taxiway}`, ast: null, refused: [] });
    } else {
      const xy = this.nodeXY(of.nodeId); if (!xy) return;
      const pr = projectOntoPath(a.path.pts, a.path.cum, xy, a.distAlong);
      if (pr.dist < 15) { a.path.holds = a.path.holds ?? []; a.path.holds.push({ nodeId: of.nodeId, runway: '', at: pr.at, isDepartureEntry: false }); a.path.holds.sort((x, y) => x.at - y.at); a.path.holdAt = a.path.holds[0].at; }
    }
    a.takeoffCleared = false;
  }
  cmdHoldPosition(a: AircraftState): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne — use Go around' };
    if (a.phase === 'takeoff') return this.cmdCancelTakeoff(a);
    if (a.phase === 'parked' || a.phase === 'arrived') return { ok: false, code: 'invalid_stage', reason: 'Not moving' };
    return this.enqueue(a, makeAst('holdPosition', a.callsign), { immediate: true });
  }
  private execHoldPosition(a: AircraftState) {
    a.trafficHold = true; this.sc(a).stoppedSince = this.time;
    a.heldByEmergency = a.heldByEmergency || false;
    a.takeoffCleared = false;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'takeoff' && c.kind !== 'lineup' && c.kind !== 'cross');
    // an explicit hold survives the per-tick traffic recompute via holdReleased=false + a manual flag in scratch
    this.sc(a).luawAt = a.phase === 'lineup' ? this.sc(a).luawAt : null;
    this.manualHold.add(a.id);
    if (a.phase === 'pushback' && a.pushback.stage === 'pushing') a.pushback.stage = 'paused';
  }
  private manualHold = new Set<number>();
  cmdContinue(a: AircraftState, holdShortOf: HoldShortTarget | null): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    const nextHold = a.path?.holds?.[0];
    const manual = this.manualHold.has(a.id) || (a.phase === 'pushback' && a.pushback.stage === 'paused');
    const atRunwayHold = a.phase === 'hold_short' && nextHold && nextHold.runway && !a.holdReleased;
    if (atRunwayHold && !manual) return { ok: false, code: 'not_at_hold', reason: nextHold!.isDepartureEntry ? 'At the runway holding point — use Line up / Takeoff' : `Use Cross ${nextHold!.runway}` };
    if (!manual && !(a.phase === 'hold_short' && nextHold && !nextHold.runway)) return { ok: false, code: 'nothing_pending', reason: 'No hold active' };
    return this.enqueue(a, makeAst('continue', a.callsign, { holdShortOf }));
  }
  private execContinue(a: AircraftState, holdShortOf: HoldShortTarget | null) {
    this.manualHold.delete(a.id);
    a.trafficHold = false;
    if (a.phase === 'pushback' && a.pushback.stage === 'paused') a.pushback.stage = 'pushing';
    const h = a.path?.holds?.[0];
    if (a.phase === 'hold_short' && h && !h.runway) { a.holdReleased = true; a.holdShortTaxiway = null; a.phase = 'taxi'; }
    this.answerRequest(a, ['taxi_in', 'taxi']); this.sc(a).limitSay = null;
    if (holdShortOf?.kind === 'taxiway' && a.path && this.insertTaxiwayHold(a, a.path, upper(holdShortOf.taxiway))) this.sc(a).limitSay = `holding short of ${spokenTaxiway(upper(holdShortOf.taxiway))}`;
  }
  private spokenRwy(r: string): string { return `runway ${spokenRunway(upper(r), this.settings.region)}`; }
  cmdCross(a: AircraftState, runway: string, expedite: boolean, behind: string | null): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const h = a.path?.holds?.[0];
    if (!h || !h.runway || this.refOf(h.runway) !== rs.ref) {
      const next = a.path?.holds?.find(x => x.runway), onRoute = a.path?.holds?.some(x => x.runway && this.refOf(x.runway) === rs.ref);
      const later = next && !next.isDepartureEntry && this.refOf(next.runway) === rs.ref ? next : null;   // one runway at a time: only the next one on the route
      // cleared before it gets there: it crosses without stopping (the lines before it still hold)
      if (later && !behind) { if (rs.status === 'sterile') return { ok: false, code: 'held_by_emergency', reason: `Runway ${rs.name} sterile` }; return { ...this.enqueue(a, makeAst('cross', a.callsign, { runway: rs.name, expedite, behind: null })), extra: { runway: rs.name } }; }
      if (onRoute) return { ok: false, code: 'not_at_hold', reason: `Not at the ${rs.name} holding point yet` };
      // just landed, no route yet: across the runway and stop, calling for the next step
      const dest: TaxiDest | null = a.plan.kind === 'arrival' && a.plan.gateRef ? { kind: 'stand', ref: a.plan.gateRef } : a.plan.runway ? { kind: 'runway', runway: a.plan.runway, intersection: null } : null;
      if (dest && !behind && (a.phase === 'rollout' || a.phase === 'taxi')) return this.cmdTaxi(a, dest, [], true, null, [rs.name], expedite, 'crossed');
      return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're not holding short of ${rs.name}, confirm?` };
    }
    if (a.holdReleased) return { ok: false, code: 'already', reason: 'Already cleared to cross' };
    if (h.isDepartureEntry && a.plan.kind === 'departure') return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, ${rs.name} is our departure runway, confirm cross?` };
    if (rs.status === 'sterile') return { ok: false, code: 'held_by_emergency', reason: `Runway ${rs.name} sterile` };
    let condition: PendingCondition | null = null;
    if (behind) { const b = this.find(behind); if (!b) return { ok: false, code: 'not_found', reason: `No aircraft ${behind}` }; condition = { type: 'behind_aircraft', id: b.id, callsign: b.callsign }; }
    if (expedite) a.expediteTaxiUntil = this.time + 90;
    this.answerRequest(a, ['cross']);
    // Crossing under an arrival inside the lock: executed and scored (03 §B5)
    const arr = this.arrivalOnFinal(rs.name, 2);
    if (arr && !condition) this.addScore('RWY_INCURSION', a.callsign, arr.callsign, rs.name, `crossing ${rs.name} with ${arr.callsign} ${arr.nm.toFixed(1)} NM final`);
    return { ...this.enqueue(a, makeAst('cross', a.callsign, { runway: rs.name, expedite, behind }), { condition }), extra: { runway: rs.name } };
  }
  private execCross(a: AircraftState, runway: string) {
    const rs = this.runwayState(runway); const h = a.path?.holds?.[0];
    if (!rs || !h) return;
    if (this.refOf(h.runway) !== rs.ref) {
      const later = a.path!.holds!.find(x => x.runway && this.refOf(x.runway) === rs.ref && !x.isDepartureEntry); if (!later) return;
      a.path!.holds = a.path!.holds!.filter(x => x !== later); a.path!.holdAt = a.path!.holds.length ? a.path!.holds[0].at : undefined;
      (this.sc(a).preclearedHolds ??= []).push(later);
      return;
    }
    a.holdReleased = true; this.manualHold.delete(a.id); a.trafficHold = false;
    if (a.phase === 'hold_short') a.phase = 'taxi';
    const s = this.sc(a); s.crossingRef = rs.ref; s.crossingEntered = false; s.crossingMinD = this.distToRunway(a.pos, rs.ref);
    this.addOccupant(rs.name, a, 'crossing');
  }
  cmdGiveWay(a: AircraftState, to: string, mode: 'give_way' | 'follow'): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    const b = this.find(to); if (!b) return { ok: false, code: 'not_found', reason: `No aircraft ${to}` };
    if (b.id === a.id) return { ok: false, code: 'invalid_param', reason: 'Cannot give way to self' };
    return this.enqueue(a, makeAst('giveWay', a.callsign, { to: b.callsign, mode }));
  }
  private execGiveWay(a: AircraftState, to: string, mode: 'give_way' | 'follow') {
    const b = this.find(to); if (!b) return;
    if (mode === 'follow') { a.followId = b.id; a.giveWayTo = null; } else { a.giveWayTo = b.id; a.followId = null; }
  }
  cmdLineUp(a: AircraftState, runway: string, behind: string | null, intersection: string | null): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (a.phase === 'lineup') return { ok: false, code: 'already', reason: 'Already on the runway' };
    if (a.phase !== 'hold_short' && a.phase !== 'taxi') return { ok: false, code: 'invalid_stage', reason: isAirborne(a) ? 'Airborne' : 'Not at the holding point yet' };
    const atHold = this.atDepartureHold(a, rs);
    if (!atHold) {
      const nearM = this.distToNextHoldM(a, rs);
      if (nearM == null || nearM > 200) return { ok: false, code: 'not_at_hold', reason: 'Not at the holding point yet' };
    }
    if (a.plan.runway && this.refOf(a.plan.runway) !== rs.ref && !this.holdsForRunway(a, rs)) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're holding short of runway ${a.holdShortRunway ?? a.plan.runway}, confirm?` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (rs.status !== 'open') return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    if (this.holdAllBlocks(a, rs)) return { ok: false, code: 'held_by_emergency', reason: 'Traffic hold in effect' };
    const other = rs.occupiedBy.find(o => o.id !== a.id && (o.kind === 'lineup' || o.kind === 'takeoff' || o.kind === 'backtrack'));
    if (other) return { ok: false, code: 'runway_occupied', reason: `Runway ${rs.name} occupied by ${other.callsign}` };
    let condition: PendingCondition | null = atHold ? null : { type: 'on_reaching_hold' };
    if (behind) { const b = this.find(behind); if (!b) return { ok: false, code: 'not_found', reason: `No aircraft ${behind}` }; condition = { type: 'behind_aircraft', id: b.id, callsign: b.callsign }; }
    const arr = this.arrivalOnFinal(rs.name, 2);
    if (arr && !condition) this.addScore('LUAW_UNSAFE', a.callsign, arr.callsign, rs.name, `${arr.callsign} on ${arr.nm.toFixed(1)} NM final`);
    this.answerRequest(a, ['ready']);
    const traffic = this.arrivalOnFinal(rs.name, 6);
    a.plan.runway = rs.name;
    return { ...this.enqueue(a, makeAst('lineup', a.callsign, { runway: rs.name, behind, intersection }), { condition }), extra: { runway: rs.name, trafficInfo: traffic ? `${spokenTypeOf(traffic.a.perf.icaoCode)} ${Math.round(traffic.nm)} mile final` : null } };
  }
  private holdsForRunway(a: AircraftState, rs: RunwayState): boolean { return !!a.holdShortNode && this.isHoldNodeForRunway(a.holdShortNode, rs.name); }
  private atDepartureHold(a: AircraftState, rs: RunwayState): boolean {
    return a.phase === 'hold_short' && this.holdsForRunway(a, rs) && a.speed < 3 && this.runwayAheadM(a, rs) >= this.takeoffRunNeededM(a);
  }
  /** Runway a departure needs from where it stands: the roll to Vr with a 15 % margin, plus room to lift off. */
  takeoffRunNeededM(a: AircraftState): number {
    const vr = a.perf.takeoffRotationSpeed * KTS_TO_MPS, acc = takeoffAccelKts(a) * KTS_TO_MPS;
    return Math.max(900, 1.15 * vr * vr / (2 * acc) + 150);
  }
  /** Runway left in the take-off direction from where the aircraft stands (a crossing hold near the far end has none). */
  runwayAheadM(a: AircraftState, rs: RunwayState): number { return this.runwayAheadFromM(a.pos, rs); }
  runwayAheadFromM(p: XY, rs: RunwayState): number {
    const thr = this.thresholdXY(rs.name); if (!thr) return rs.lengthM;
    const used = (p.x - thr.x) * Math.sin(rs.headingTrue * Math.PI / 180) + (p.y - thr.y) * Math.cos(rs.headingTrue * Math.PI / 180);
    return rs.lengthM - Math.max(0, used);
  }
  private distToNextHoldM(a: AircraftState, rs: RunwayState): number | null {
    const h = a.path?.holds?.find(x => this.refOf(x.runway) === rs.ref); if (!h) return null;
    return h.at - a.distAlong;
  }
  private execLineUp(a: AircraftState, runway: string, intersection: string | null) {
    const rs = this.runwayState(runway); if (!rs) return;
    if (a.phase !== 'hold_short' && a.phase !== 'taxi') return;
    const path = this.lineupPath(a, rs, intersection); if (!path) return;
    a.path = path; a.distAlong = 0; a.holdReleased = true; a.takeoffCleared = false;
    a.holdShortNode = null; a.holdShortRunway = null;
    a.targetHeading = rs.headingTrue; a.plan.runway = rs.name;
    a.phase = 'lineup'; this.manualHold.delete(a.id); a.trafficHold = false;
    this.addOccupant(rs.name, a, 'lineup');
    this.sc(a).luawAt = this.time;
    this.emit('phase', a, `${a.callsign} -> lineup ${rs.name}`);
  }
  /** Path from the hold onto the runway: hold node -> runway node -> 50 m along the runway (threshold + 50 m for a full-length entry). */
  private lineupPath(a: AircraftState, rs: RunwayState, intersection: string | null): DrivePath | null {
    void intersection;
    const info = a.holdShortNode ? this.holdNodeInfo.get(a.holdShortNode) : undefined;
    const thr = this.thresholdXY(rs.name)!;
    let entry: XY;
    if (info && info.ref === rs.ref) entry = this.nodeXY(info.runwayNodeId)!;
    else {
      const r = this.runwayByEnd(rs.name)!; entry = this.endXY(r.end);
      const cands = [...(this.holdNodes.get(rs.ref) ?? [])];
      const near = cands.reduce<{ id: string; d: number } | null>((b, id) => { const d = dist(a.pos, this.nodeXY(id)!); return !b || d < b.d ? { id, d } : b; }, null);
      if (near && near.d < 250) entry = this.nodeXY(this.holdNodeInfo.get(near.id)!.runwayNodeId)!;
    }
    const along = Math.max(0, alongTrack(entry, thr, rs.headingTrue));
    const onLine = advance(thr, rs.headingTrue, along);
    // the body straightens behind the nose wheel over a few wheelbases: a heavy rolls further before it is lined up
    const stop = advance(thr, rs.headingTrue, along + LINEUP_ADVANCE_M + 2.5 * wheelbaseM(a));
    let raw = [{ ...a.pos }, onLine, stop];
    if (dist(entry, onLine) > 8) raw.splice(1, 0, entry);
    // the way on to the runway as it is painted, where that is not a straight line (Paris D1, Haneda B7: a long curve)
    const pa = a.path;
    if (pa && pa.total - a.distAlong > 25 && pa.total - a.distAlong < 700) {
      const way: XY[] = []; let on: XY | null = null;
      for (let d = a.distAlong + 8; d <= pa.total; d += 8) { const q = sampleAlong(pa.pts, pa.cum, d).pos; if (this.distToRunway(q, rs.ref) < 6) { on = q; break; } way.push(q); }
      const off = Math.max(0, ...way.map(q => Math.min(...raw.slice(1).map((r, i) => distToSegment(q, raw[i], r)))));
      if (on && off > 8) {
        const al = Math.max(0, alongTrack(on, thr, rs.headingTrue));
        raw = [{ ...a.pos }, ...way, advance(thr, rs.headingTrue, al + 12), advance(thr, rs.headingTrue, al + LINEUP_ADVANCE_M + 2.5 * wheelbaseM(a))];
      }
    }
    const p = this.buildPath(raw, 'runway', true);
    return p.total > 2 ? p : null;
  }
  cmdTakeoff(a: AircraftState, runway: string, opts: { immediate: boolean; afterDepHdg: number | 'runway' | null; turn: { dir: TurnDir; deg: number } | null; initialAlt: number | null; contactDeparture: boolean }): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (a.phase === 'takeoff') return { ok: false, code: 'already', reason: 'Already cleared' };
    if (!['hold_short', 'lineup', 'taxi'].includes(a.phase)) return { ok: false, code: 'invalid_stage', reason: isAirborne(a) ? 'Airborne' : 'Not at the holding point yet' };
    const lined = a.phase === 'lineup' && a.plan.runway && this.refOf(a.plan.runway) === rs.ref;
    const atHold = this.atDepartureHold(a, rs);
    if (!lined && a.phase === 'hold_short' && this.holdsForRunway(a, rs) && this.runwayAheadM(a, rs) < this.takeoffRunNeededM(a)) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, only ${Math.round(this.runwayAheadM(a, rs))} m of ${rs.name} ahead of us here, unable from this intersection` };
    if (!lined && !atHold) {
      const nearM = this.distToNextHoldM(a, rs);
      if (a.phase === 'lineup') return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're lined up on runway ${a.plan.runway}, confirm ${rs.name}?` };
      if (nearM == null) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're holding short of ${a.holdShortRunway ?? 'the runway'}, confirm ${rs.name}?` };
      if (nearM > 250) return { ok: false, code: 'not_at_hold', reason: 'Not at the holding point yet' };
    }
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (rs.status !== 'open') return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    if (this.holdAllBlocks(a, rs)) return { ok: false, code: 'held_by_emergency', reason: 'Traffic hold in effect' };
    // a departure lined up BEHIND this one (an entry nearer the threshold) is no obstacle: this one rolls away from it
    const thr = this.thresholdXY(rs.name), hr = rs.headingTrue * Math.PI / 180;
    const along = (p: XY) => thr ? (p.x - thr.x) * Math.sin(hr) + (p.y - thr.y) * Math.cos(hr) : 0;
    const behind = (id: number) => { const x = this.byId(id); return !!x && x.phase === 'lineup' && along(x.pos) < along(a.pos) - 30; };
    const occ = rs.occupiedBy.find(x => x.id !== a.id && !(x.kind === 'lineup' && typeof x.id === 'number' && behind(x.id)))?.callsign
      ?? this.safe('fleet', () => this.fleet.onRunway(rs.ref)[0]?.callsign ?? null, null);
    if (occ) return { ok: false, code: 'runway_occupied', reason: `Runway ${rs.name} occupied by ${occ}` };
    if (this.aircraft.some(x => x.id !== a.id && !behind(x.id) && !isAirborne(x) && x.phase !== 'parked' && x.phase !== 'arrived' && this.distToRunway(x.pos, rs.ref) < STRIP_HALF_M)) return { ok: false, code: 'runway_occupied', reason: `Runway ${rs.name} occupied by ${this.aircraft.find(x => x.id !== a.id && this.distToRunway(x.pos, rs.ref) < STRIP_HALF_M)?.callsign ?? 'traffic'}` };
    const cool = this.sc(a).rtoRecoverAt;
    if (a.rto && cool != null && this.time < cool) return { ok: false, code: 'unable', reason: `Unable, brakes cooling after the rejected takeoff, ${Math.ceil((cool - this.time) / 60)} min` };
    const wake = this.wakeTimerRemainingS(rs.name, a.wakeCategory);
    if (wake > 0) return { ok: false, code: 'unable', reason: `Wake turbulence, ${rs.wakeTimer?.leader} departed, ${Math.ceil(wake)} s remaining` };
    const arr = this.arrivalOnFinal(rs.name, 2);
    if (arr) return { ok: false, code: 'unable', reason: `Arrival ${arr.callsign} ${arr.nm.toFixed(1)} NM final` };
    if (opts.immediate && chance(a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 0.10 : 0.04)) return { ok: false, code: 'unable_immediate', reason: 'Unable immediate' };
    const wc = this.windFor(rs.headingTrue);
    if (-wc.headKt > 10) { this.addScore('PERFORMANCE_TAILWIND', a.callsign, null, rs.name, `${Math.round(-wc.headKt)} kt tailwind`); const sc = this.sc(a); if (!sc.tailwindSaid && chance(0.3)) { sc.tailwindSaid = true; return { ok: false, code: 'unable', reason: `Unable, ${Math.round(-wc.headKt)} kt tailwind, request the other runway` }; } }      // (asked once: told again, the crew takes it)
    this.answerRequest(a, ['ready']);
    a.plan.runway = rs.name;
    const condition: PendingCondition | null = lined || atHold ? null : { type: 'on_reaching_hold' };
    for (const r of this.bothEnds(rs.ref)) r.takeoffClearance = a.callsign;
    a.takeoffCleared = false;
    const eff = this.wakeTimerRemainingS(rs.name);
    if (rs.wakeTimer && eff === 0 && this.time - rs.wakeTimer.expiresAt < 10) this.addScore('WAKE_EFFICIENT', a.callsign, null, rs.name);
    const ast = makeAst('takeoff', a.callsign, { runway: rs.name, immediate: opts.immediate, afterDepHdg: opts.afterDepHdg, turn: opts.turn, initialAlt: opts.initialAlt, contactDeparture: opts.contactDeparture });
    return { ...this.enqueue(a, ast, { condition }), extra: { runway: rs.name, windDir: wc.headKt, wind: `${hdg3(this.wx().windDirTrue)}/${Math.round(this.wx().windKt)}` } };
  }
  private execTakeoff(a: AircraftState, runway: string, opts: { immediate: boolean; afterDepHdg: number | 'runway' | null; turn: { dir: TurnDir; deg: number } | null; initialAlt: number | null; contactDeparture: boolean }) {
    const rs = this.runwayState(runway); if (!rs) return;
    if (!['hold_short', 'lineup', 'taxi'].includes(a.phase)) return;
    a.clearance.depHdg = opts.afterDepHdg === 'runway' ? rs.headingTrue : opts.afterDepHdg;
    if (opts.turn) a.clearance.depHdg = ((rs.headingTrue + (opts.turn.dir === 'L' ? -opts.turn.deg : opts.turn.deg)) % 360 + 360) % 360;
    if (opts.initialAlt != null) a.clearance.initialAlt = opts.initialAlt;
    // AI tower: at 1,000 ft (at 3,000 the departure climbed through the pattern levels where the approach assist could not
    // stop it); a player on tower keeps the 3,000 ft default and their own "contact departure"
    a.clearance.autoHandoffAlt = Math.min(this.aiOn('tower') ? 1000 : 3000, a.clearance.initialAlt);
    a.clearance.immediate = opts.immediate;
    const fromLineup = a.phase === 'lineup';
    a.rto = null;
    this.beginRoll(a, rs.name);
    const s = this.sc(a);
    // Spool-up 8-15 s from a standing start; rolling takeoff (from the hold) taxis on and goes without stopping.
    s.rollAt = this.time + (fromLineup ? rf(8, 15) : 0);
    a.holdReleased = true;
    if (!fromLineup) a.takeoffCleared = false;
  }
  /** Build the runway roll path and switch to `takeoff` (roll starts when takeoffCleared flips at rollAt). */
  private beginRoll(a: AircraftState, endName: string) {
    const rs = this.runwayState(endName)!; const r = this.runwayByEnd(endName)!;
    const thr = this.thresholdXY(endName)!;
    const far = advance(this.endXY(r.other), rs.headingTrue, 600);
    const raw: XY[] = [{ ...a.pos }];
    const alongNow = alongTrack(a.pos, thr, rs.headingTrue);
    const onLine = advance(thr, rs.headingTrue, Math.max(alongNow, 0) + 30);
    if (a.phase !== 'lineup') {
      const info = a.holdShortNode ? this.holdNodeInfo.get(a.holdShortNode) : undefined;
      if (info && info.ref === rs.ref) raw.push(this.nodeXY(info.runwayNodeId)!);
    }
    if (dist(raw[raw.length - 1], onLine) > 5) raw.push(onLine);
    raw.push(far);
    a.path = this.buildPath(raw, 'runway');
    a.distAlong = 0; a.holdReleased = true; a.takeoffCleared = false;
    a.holdShortNode = null; a.holdShortRunway = null;
    a.targetHeading = rs.headingTrue; a.plan.runway = rs.name;
    a.phase = 'takeoff'; this.manualHold.delete(a.id); a.trafficHold = false;
    this.addOccupant(rs.name, a, 'takeoff');
    this.sc(a).luawAt = null;
    this.emit('phase', a, `${a.callsign} -> takeoff ${rs.name}`);
  }
  cmdCancelTakeoff(a: AircraftState): EngineOutcome {
    const pending = a.pendingCmds.find(c => c.kind === 'takeoff');
    if (pending) { a.pendingCmds = a.pendingCmds.filter(c => c !== pending); this.clearTakeoffClearance(a); return { ...OK, extra: { phase: 'pending' } }; }
    if (a.phase !== 'takeoff') return { ok: false, code: 'invalid_stage', reason: a.phase === 'lineup' ? 'No takeoff clearance to cancel' : 'Not taking off' };
    if (!a.path) return { ok: false, code: 'past_abort_speed', reason: 'Airborne — use Go around' };
    const v1 = v1Kt(a.perf);
    if (a.speed >= v1) return { ok: false, code: 'past_abort_speed', reason: 'Past abort speed' };
    // < 80 kt: rejected takeoff; 80 kt-V1: high-speed reject (03 §A8)
    const hi = a.speed >= 80;
    a.rto = { at: this.time, speedKt: a.speed };
    a.takeoffCleared = false; a.holdReleased = false;
    this.clearTakeoffClearance(a);
    if (a.path) { a.path.holds = [{ nodeId: '', runway: a.plan.runway ?? '', at: Math.min(a.path.total, a.distAlong + this.brakingM(a.speed, hi ? 3.5 : 3.0) + HOLD_BUFFER_M), isDepartureEntry: false }]; a.path.holdAt = a.path.holds[0].at; }
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'takeoff');
    const s = this.sc(a); s.rollAt = null; s.rtoRecoverAt = this.time + (hi ? 1800 : rf(60, 120));
    this.emit('info', a, `${a.callsign} rejected takeoff at ${Math.round(a.speed)} kt${hi ? ' (high speed: brake cooling 30 min, runway inspection required)' : ''}`);
    if (a.speed > 5) this.addScore('GOOD_CATCH', a.callsign, null, a.plan.runway ?? null, 'takeoff cancelled on the roll');
    const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
    if (hi && rs) this.setRunwayStatus(rs.name, 'inspection', 'high-speed RTO');
    return { ...OK, extra: { speed: Math.round(a.speed) } };
  }
  private brakingM(kt: number, mps2: number): number { const v = kt * KTS_TO_MPS; return (v * v) / (2 * mps2); }
  private clearTakeoffClearance(a: AircraftState) { for (const rs of this.runways) if (rs.takeoffClearance === a.callsign) rs.takeoffClearance = null; }
  cmdCancelLineup(a: AircraftState, via: string | null): EngineOutcome {
    if (a.phase !== 'lineup') return { ok: false, code: 'invalid_stage', reason: 'Not lined up' };
    if (via && !this.air.taxiwayNodes.has(upper(via))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(via)} here` };
    return this.enqueue(a, makeAst('cancelLineup', a.callsign, { via }));
  }
  private execCancelLineup(a: AircraftState, via: string | null) {
    if (a.phase !== 'lineup' || !a.plan.runway) return;
    const rs = this.runwayState(a.plan.runway)!;
    const exit = this.chooseExit(a, rs.ref, rs.headingTrue, 0, via ? upper(via) : null, true);
    if (!exit) { this.emit('readback', a, `Unable, no exit ahead, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: 'no exit', ast: null, refused: [] }); return; }
    this.exitViaTaxiway(a, rs, exit, true);
  }
  cmdExitAt(a: AircraftState, exit: ExitSpec, expedite: boolean, holdShortOf: HoldShortTarget | null, contactGround: boolean): EngineOutcome {
    if (a.phase !== 'landing' && a.phase !== 'rollout' && !(a.phase === 'approach' && a.ilsCaptured)) return { ok: false, code: 'invalid_stage', reason: 'Not landing' };
    if (a.phase === 'landing' && a.altitude < 500 && a.altitude > 0) return { ok: false, code: 'too_low', reason: 'Below 500 ft — too late for exit' };
    if (exit.kind === 'taxiway' && !this.air.taxiwayNodes.has(upper(exit.taxiway))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(exit.taxiway)} here` };
    if (a.phase === 'rollout' && exit.kind === 'taxiway' && a.plan.runway) {
      const rs = this.runwayState(a.plan.runway)!;
      const ex = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, upper(exit.taxiway), false);
      if (!ex) return { ok: false, code: 'unable_exit', reason: `Unable ${upper(exit.taxiway)}, we'll take ${this.sc(a).exitPlan?.taxiway ?? 'the next one'}` };
    }
    return this.enqueue(a, makeAst('exitAt', a.callsign, { exit, expedite, holdShortOf, contactGround }));
  }
  private execExitAt(a: AircraftState, exit: ExitSpec, expedite: boolean, holdShortOf: HoldShortTarget | null, contactGround: boolean) {
    if (exit.kind === 'taxiway') { a.exitTaxiway = upper(exit.taxiway); a.exitDir = null; } else { a.exitDir = exit.dir; a.exitTaxiway = null; }
    if (expedite) a.expediteTaxiUntil = this.time + 90;
    if (holdShortOf?.kind === 'runway') a.lahsoHoldShortOf = upper(holdShortOf.runway);
    const s = this.sc(a);
    if (a.phase === 'rollout' && a.plan.runway && a.path && a.path.kind !== 'taxi') {
      // re-plan the exit and move the braking target with it, otherwise the aircraft keeps the touchdown plan's holdAt/speed.
      // Never once the aircraft is already on the exit path: a runway exit plan on a taxi path leaves it rolling to the
      // path end at the exit speed and it never comes to a stop (-> stuck in rollout).
      const rs = this.runwayState(a.plan.runway)!;
      const ex = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, a.exitTaxiway, false) ?? (a.exitTaxiway ? this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, null, false) : null);
      if (ex) { s.exitPlan = ex; if (a.path) a.path.holdAt = ex.at; a.cmdIas = ex.speedKt; }
    }
    if (contactGround) { s.handoffTo = 'ground'; s.handoffAt = null; a.handedTo = 'ground'; }
  }
  cmdExpedite(a: AircraftState, on: boolean, scope: ExpediteScope): EngineOutcome {
    if (scope === 'climb' || scope === 'descent') { if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' }; }
    else if (isAirborne(a) && a.phase !== 'landing') return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    if (on && scope === 'taxi' && this.wx().runwayCondition !== 'dry') return { ok: false, code: 'unable', reason: 'Unable to expedite, runway wet' };
    return this.enqueue(a, makeAst('expedite', a.callsign, { on, scope }), { immediate: true });
  }
  private execExpedite(a: AircraftState, on: boolean, scope: ExpediteScope) {
    if (scope === 'climb' || scope === 'descent') a.expedite = on; else a.expediteTaxiUntil = on ? this.time + 90 : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — tower
  // ═══════════════════════════════════════════════════════════════════════════
  cmdClearedLand(a: AircraftState, runway: string, lahso: string | null, exit: ExitSpec | null): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'rollout') return { ok: false, code: 'already', reason: 'Already landed' };
    if (a.landingCleared && a.plan.runway && this.refOf(a.plan.runway) === rs.ref) return { ok: false, code: 'already', reason: 'Already cleared' };
    if (!(a.ilsCaptured || a.phase === 'landing' || a.navMode === 'visual')) return { ok: false, code: 'invalid_stage', reason: a.ilsArmed ? 'Not established' : 'Not on approach' };
    const cur = a.plan.runway ?? a.assignedRunway;
    if (cur && this.refOf(cur) !== rs.ref) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're established on ${cur}, confirm runway ${rs.name}?` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (rs.status !== 'open' && !a.emergency) return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    if (this.holdAllBlocks(a, rs)) return { ok: false, code: 'held_by_emergency', reason: 'Traffic hold in effect' };
    if (this.settings.region === 'ICAO' && rs.landingClearances.length && !rs.landingClearances.includes(a.callsign)) return { ok: false, code: 'already', reason: `${rs.landingClearances[0]} already cleared to land — use Continue approach` };
    if (lahso && !this.runwayState(lahso)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${lahso}` };
    // Preconditions are reported and scored, never gated (03 §B4 trap mechanic)
    const occ = this.runwayOccupant(rs.name, a.id);
    if (occ) { this.safe('alerts', () => this.alerts.raise('occupied_runway_clearance', [a.callsign, occ], `Landing clearance with ${rs.name} occupied`, `${occ} on the runway`, this.time, { runway: rs.name }, [a.id]), undefined); }
    const wc = this.windFor(rs.headingTrue);
    if (-wc.headKt > 10) this.addScore('PERFORMANCE_TAILWIND', a.callsign, null, rs.name, `${Math.round(-wc.headKt)} kt tailwind`);
    this.answerRequest(a, ['confirm_cleared']);
    return { ...this.enqueue(a, makeAst('clearedLand', a.callsign, { runway: rs.name, lahso, exit })), extra: { runway: rs.name, occupant: occ, wind: `${hdg3(this.wx().windDirTrue)}/${Math.round(this.wx().windKt)}` } };
  }
  private execClearedLand(a: AircraftState, runway: string, lahso: string | null, exit: ExitSpec | null) {
    const rs = this.runwayState(runway); if (!rs) return;
    a.landingCleared = true; a.landingClearedAt = this.time;
    a.plan.runway = rs.name; if (!a.assignedRunway) a.assignedRunway = rs.name;
    a.lahsoHoldShortOf = lahso ? upper(lahso) : null;
    if (exit) { if (exit.kind === 'taxiway') a.exitTaxiway = upper(exit.taxiway); else a.exitDir = exit.dir; }
    this.setLandingClearance(rs, a.callsign, true);
    this.sc(a).continueApproach = false;
    this.emit('landing_clearance', a, `${a.callsign} cleared to land runway ${rs.name}`, { type: 'landing_clearance', runway: rs.name, cleared: true });
  }
  cmdContinueApproach(a: AircraftState, number: number | null): EngineOutcome {
    if (!isAirborne(a) || !(a.ilsArmed || a.phase === 'landing')) return { ok: false, code: 'invalid_stage', reason: 'Not on approach' };
    if (number != null) a.sequenceNo = number;
    this.answerRequest(a, ['confirm_cleared']);
    return this.enqueue(a, makeAst('continueApproach', a.callsign, { number }));
  }
  cmdGoAround(a: AircraftState, heading: number | 'runway' | null, alt: number | null, contact: Position | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'go_around' && heading == null && alt == null && contact == null) return { ok: false, code: 'already', reason: 'Already going around' };
    if (a.phase === 'rollout') return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    this.answerRequest(a, ['going_around']);
    const arr = a.plan.runway ? this.runwayOccupant(a.plan.runway, a.id) : null;
    const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null;
    if (arr && d != null && d < 1.5 && a.phase !== 'go_around') this.addScore('SAFETY_GA', a.callsign, arr, a.plan.runway, 'go-around ordered with the runway occupied');
    return { ...this.enqueue(a, makeAst('goAround', a.callsign, { heading, alt, contact }), { immediate: a.phase !== 'go_around' }), extra: { alt: alt ?? this.missedApproachAltFt } };
  }
  private execGoAround(a: AircraftState, heading: number | 'runway' | null, alt: number | null, contact: Position | null) {
    if (a.phase !== 'go_around') this.initiateGoAround(a, 'ATC instruction', false);
    const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
    if (heading === 'runway' && rs) a.targetHeading = rs.headingTrue;
    else if (typeof heading === 'number') { a.targetHeading = ((heading % 360) + 360) % 360; a.navMode = 'heading'; a.goAround = false; a.phase = 'climb'; }
    if (alt != null) { a.targetAltitude = alt; a.cmdAltitude = alt; }
    if (contact) this.execHandoff(a, contact);
  }
  /** Go-around: TOGA, runway heading, climb to the missed-approach altitude; `goAround` flag until re-vectored. */
  initiateGoAround(a: AircraftState, reason: string, playerCaused: boolean, scoreCode: ScoreCode | null = null, secondary: string | null = null) {
    const rw = a.plan.runway ?? a.assignedRunway;
    const rs = rw ? this.runwayState(rw) : undefined;
    if (rs) this.setLandingClearance(rs, a.callsign, false);
    a.landingCleared = false; a.landingClearedAt = null;
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false;
    a.navMode = 'heading'; a.path = null; a.distAlong = 0;
    a.targetHeading = rs ? rs.headingTrue : a.heading;
    a.targetAltitude = this.missedApproachAltFt; a.cmdAltitude = this.missedApproachAltFt;
    a.targetSpeed = Math.min(a.perf.maxAirspeedTMA, 200); a.cmdIas = null;
    a.speed = Math.max(a.speed, a.perf.approachSpeed + 10);
    if (a.altitude < 30) a.altitude = 30;
    a.phase = 'go_around'; a.goAround = true; a.goAroundCount++;
    a.turnDir = null;
    for (const r of this.runways) this.removeOccupant(r.ref, a.id);
    const s = this.sc(a); s.gaAt = this.time; s.continueApproach = false; s.queried4NM = false; s.exitPlan = null;
    this.emit('go_around', a, `${a.callsign} going around — ${reason}`);
    this.raiseRequest(a, 'going_around', reason);
    if (playerCaused) { this.stats.goAroundsPlayer++; if (scoreCode) this.addScore(scoreCode, a.callsign, secondary, rw ?? null, reason); }
    else this.stats.goAroundsPilot++;
    this.safe('alerts', () => this.alerts.raise('go_around', [a.callsign], `${a.callsign} going around`, reason, this.time, { runway: rw ?? null }, [a.id]), undefined);
    if (a.goAroundCount >= 2 && a.plan.kind === 'arrival') this.emit('info', a, `${a.callsign}: second go-around, requesting diversion consideration`, undefined, 'PILOT');
  }
  cmdWindCheck(a: AircraftState): EngineOutcome {
    this.answerRequest(a, ['wind_check']);
    const w = this.wx();
    return { ...OK, extra: { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt } };
  }
  cmdHandoff(a: AircraftState, position: Position, when: ContactWhen): EngineOutcome {
    if (a.onFrequency === position && a.handedTo == null) return { ok: false, code: 'already', reason: `Already on ${position}` };
    if (a.emergency?.type === 'radio_failure') return { ok: false, code: 'unable', reason: 'NORDO' };
    let condition: PendingCondition | null = null;
    if (when === 'when_vacated') condition = { type: 'after_vacated' };
    else if (when === 'on_reaching') condition = { type: 'at_or_above_alt', ft: a.clearance.autoHandoffAlt };
    else if (when === 'at_hold') condition = { type: 'on_reaching_hold' };
    this.answerRequest(a, ['runway_vacated']);
    if (position === 'external' && a.plan.kind === 'departure' && isAirborne(a)) this.addScore('DEPARTED_HANDOFF', a.callsign, null, a.plan.runway ?? null);
    if (a.plan.kind === 'arrival' && position === 'tower' && a.ilsCaptured) { const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null; if (d != null && d < 4) this.addScore('HANDOFF_LATE', a.callsign, null, a.plan.runway ?? null, `handoff at ${d.toFixed(1)} NM`); }
    return { ...this.enqueue(a, makeAst('contact', a.callsign, { position, when }), { condition }), extra: { freq: this.frequencies[position] ?? '' } };
  }
  private execHandoff(a: AircraftState, position: Position) {
    a.handedTo = position;
    const s = this.sc(a);
    s.handoffTo = position; s.handoffAt = this.time + (this.settings.pilotDelayOverride != null ? 2 : rf(5, 15));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — approach
  // ═══════════════════════════════════════════════════════════════════════════
  private airborneOnly(a: AircraftState): EngineOutcome | null {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'landing' || (a.ilsCaptured && a.gsCaptured)) return { ok: false, code: 'invalid_stage', reason: 'On the glideslope — use Cancel approach' };
    return null;
  }
  cmdHeading(a: AircraftState, hdg: number, dir: TurnDir | null, when: PendingCondition | null): EngineOutcome {
    const g = this.airborneOnly(a); if (g) return g;
    if (a.phase === 'takeoff' && a.altitude < DEP_TURN_FT) when = when ?? { type: 'at_or_above_alt', ft: DEP_TURN_FT };
    const h = ((Math.round(hdg) % 360) + 360) % 360;
    if (a.emergency?.type === 'radio_failure') return { ok: false, code: 'unable', reason: 'NORDO' };
    a.turnDir = dir;
    this.answerRequest(a, ['further', 'hold']);
    const queried = a.ilsCaptured && chance(0.5);
    if (queried) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're established on the localizer, confirm heading ${hdg3(h)}?` };
    return { ...this.enqueue(a, makeAst('heading', a.callsign, { hdg: h, dir, when }), { condition: when, value: h }), extra: { hdg: h } };
  }
  private execHeading(a: AircraftState, hdg: number, dir: TurnDir | null) {
    if (!isAirborne(a)) return;
    a.turnDir = dir;
    if (a.ilsCaptured || a.ilsArmed) { this.cancelIls(a); }
    a.navMode = 'heading'; a.targetHeading = ((hdg % 360) + 360) % 360;
    a.directTargetXY = null; a.directTargetName = null; a.holdFix = null; a.holdFixName = null;
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
  }
  private cancelIls(a: AircraftState) {
    const rw = a.assignedRunway ?? a.plan.runway; const rs = rw ? this.runwayState(rw) : undefined;
    if (rs) this.setLandingClearance(rs, a.callsign, false);
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false; a.landingCleared = false; a.landingClearedAt = null;
    if (a.phase === 'approach') a.phase = 'cruise';
  }
  cmdAltitude(a: AircraftState, ft: number, expedite: boolean, when: PendingCondition | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'landing' || (a.gsCaptured && a.ilsCaptured)) return { ok: false, code: 'invalid_stage', reason: 'On glideslope — use Cancel approach' };
    const tgt = Math.max(0, Math.round(ft));
    if (tgt > 0 && tgt < 1000 && !a.emergency) return { ok: false, code: 'unable', reason: `Unable ${tgt}, minimum altitude 1000` };
    if (expedite && (Math.abs(tgt - a.altitude) < 300 || (tgt < a.altitude && a.altitude < 3000)) && chance(0.1)) return { ok: false, code: 'unable', reason: 'Unable to expedite' };
    a.cmdAltitude = tgt;
    this.answerRequest(a, ['higher', 'lower']);
    return { ...this.enqueue(a, makeAst('altitude', a.callsign, { ft: tgt, expedite, when }), { condition: when, value: tgt }), extra: { ft: tgt, verb: tgt >= a.altitude ? 'climb' : 'descend' } };
  }
  private execAltitude(a: AircraftState, ft: number, expedite: boolean) {
    a.targetAltitude = Math.max(0, ft); a.cmdAltitude = a.targetAltitude; a.expedite = expedite;
    if (a.goAround && a.phase === 'go_around' && ft !== this.missedApproachAltFt) { /* keeps go_around until a lateral instruction */ }
  }
  cmdSpeed(a: AircraftState, kts: number | 'resume', untilNM: number | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (kts !== 'resume') {
      const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null;
      if (a.ilsCaptured && d != null && d < 5 && untilNM == null) return { ok: false, code: 'unable', reason: 'Unable, five-mile final' };
      if (kts < a.perf.minAirspeedTMA) return { ok: false, code: 'unable_envelope', reason: `Unable ${kts}, minimum clean ${a.perf.minAirspeedTMA}` };
      if (kts > a.perf.maxAirspeedTMA || (kts > 250 && a.altitude < 10000)) return { ok: false, code: 'unable_envelope', reason: `Unable ${kts}, maximum ${Math.min(a.perf.maxAirspeedTMA, a.altitude < 10000 ? 250 : 999)}` };
      if (a.emergency && EMERGENCY_CATALOGUE[a.emergency.type].noDelay && kts < a.speed) return { ok: false, code: 'unable', reason: 'Unable, emergency' };
      a.cmdIas = Math.round(kts);
    } else a.cmdIas = null;
    return { ...this.enqueue(a, makeAst('speed', a.callsign, { kts, untilNM }), { value: kts === 'resume' ? 0 : Math.round(kts), untilNM }), extra: { kts: kts === 'resume' ? null : Math.round(kts) } };
  }
  private execSpeed(a: AircraftState, kts: number | null, untilNM: number | null) {
    if (kts == null) { a.cmdIas = null; a.speedUntilNM = null; a.targetSpeed = a.ilsCaptured ? Math.min(a.targetSpeed, 200) : Math.min(a.perf.maxAirspeedTMA, 250); return; }
    a.targetSpeed = kts; a.cmdIas = kts; a.speedUntilNM = untilNM;
  }
  cmdDirect(a: AircraftState, fix: string, thenHdg: number | null): EngineOutcome {
    const g = this.airborneOnly(a); if (g) return g;
    const b = this.beacons.find(x => x.id === upper(fix));
    if (!b) return { ok: false, code: 'unknown_fix', reason: `Unable, ${upper(fix)} not in our database` };
    this.answerRequest(a, ['direct']);
    return this.enqueue(a, makeAst('direct', a.callsign, { fix: upper(fix), thenHdg }));
  }
  private execDirect(a: AircraftState, fix: string, thenHdg: number | null) {
    const b = this.beacons.find(x => x.id === upper(fix)); if (!b) return;
    a.directTargetXY = { x: b.x, y: b.y }; a.directTargetName = upper(fix);
    a.navMode = 'direct'; a.turnDir = null;
    if (a.ilsArmed) this.cancelIls(a);
    a.holdFix = null; a.holdFixName = null;
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
    if (thenHdg != null) a.pendingCmds.push({ kind: 'heading', value: ((thenHdg % 360) + 360) % 360, applyAt: this.time, condition: { type: 'after_fix', fix: upper(fix) }, ast: makeAst('heading', a.callsign, { hdg: thenHdg }), issuedAt: this.time, cancellable: true });
  }
  cmdHold(a: AircraftState, fix: string, inbound: number | null, dir: TurnDir | null, legTimeMin: number | null, legNM: number | null, efc: number | null): EngineOutcome {
    const g = this.airborneOnly(a); if (g) return g;
    if (a.altitude < 1000) return { ok: false, code: 'too_low', reason: 'Below 1000 ft' };
    const b = this.beacons.find(x => x.id === upper(fix));
    if (!b) return { ok: false, code: 'unknown_fix', reason: `Unable, ${upper(fix)} not in our database` };
    if (a.emergency && EMERGENCY_CATALOGUE[a.emergency.type].noDelay) return { ok: false, code: 'unable', reason: 'Unable to hold, emergency' };
    this.answerRequest(a, ['hold', 'further']);
    return this.enqueue(a, makeAst('hold', a.callsign, { fix: upper(fix), inbound, dir, legTimeMin, legNM, efc }));
  }
  /** The hold at a fix as published (holds.ts), or null when the fix has none. */
  publishedHoldAt(fix: string, altFt = 9000) { const b = this.beacons.find(x => x.id === upper(fix)); return b ? publishedHold(this.air.icao, b, altFt) : null; }
  private execHold(a: AircraftState, fix: string, inbound: number | null, dir: TurnDir | null, legTimeMin: number | null, legNM: number | null, efc: number | null) {
    const b = this.beacons.find(x => x.id === upper(fix)); if (!b) return;
    const pub = publishedHold(this.air.icao, b, a.cmdAltitude ?? a.altitude);
    const inb = inbound ?? pub?.inbound ?? headingTo(a.pos, { x: b.x, y: b.y }), turn = dir ?? (inbound == null ? pub?.dir : null) ?? 'R';
    const legMin = legTimeMin ?? (legNM == null && inbound == null ? pub?.legMin : null) ?? (a.altitude > 14000 ? 1.5 : 1), legMi = legNM ?? (legTimeMin == null && inbound == null ? pub?.legNM ?? null : null);
    this.sc(a).efcAsked = false;
    // (the same hold again, with a new time to expect further clearance: it goes on round as it is)
    if (a.navMode === 'hold' && a.holdFixName === upper(fix) && Math.abs(angleDelta(a.holdInboundHdg, inb)) < 1 && a.holdTurnDir === turn) { a.holdEfc = efc ?? a.holdEfc; a.holdLegMin = legMin; a.holdLegNM = legMi; return; }
    a.holdFix = { x: b.x, y: b.y }; a.holdFixName = upper(fix);
    a.holdInboundHdg = inb;
    a.holdTurnDir = turn; a.holdPhase = 'to_fix'; a.holdTimer = 0; a.holdEntry = null; a.holdLaps = 0; a.holdOutS = undefined;
    a.holdLegMin = legMin; a.holdLegNM = legMi; a.holdEfc = efc;
    a.navMode = 'hold'; a.turnDir = null;
    if (a.ilsArmed) this.cancelIls(a);
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
    // holding speeds (AIM 5-3-8)
    const hs = holdSpeedKt(Math.max(a.altitude, a.cmdAltitude ?? 0));
    if (a.cmdIas == null || a.cmdIas > hs) a.targetSpeed = Math.min(a.targetSpeed, hs);
  }
  private ilsFor(runway: string): ILSRunway | null {
    const u = upper(runway);
    let ils = this.ilsRunways.find(r => r.name === u) ?? null;
    if (!ils) {
      const rs = this.runwayState(u); const r = this.runwayByEnd(u);
      if (!rs || !r) return null;
      ils = ilsFromGeometry(rs.name, this.endXY(r.end), rs.headingTrue, 0);
      this.ilsRunways.push(ils);
    }
    return ils;
  }
  cmdILS(a: AircraftState, runway: string): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'landing') return { ok: false, code: 'already', reason: 'Already on final' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (!rs.activeArr && !a.emergency) return { ok: false, code: 'invalid_param', reason: `Runway ${rs.name} not active for arr` };
    if (rs.status !== 'open' && !a.emergency) return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    const ils = this.ilsFor(rs.name); if (!ils) return { ok: false, code: 'no_ils', reason: 'No ILS on this airport' };
    if (a.ilsArmed && a.assignedRunway === rs.name) return { ok: false, code: 'already', reason: 'Already cleared' };
    if (a.plan.kind === 'arrival') this.answerRequest(a, ['further']);
    const along = distAlongFwd(a.pos, ils) / NM_TO_M;
    const high = along > 0.5 && aboveGlideslope(a.pos, a.altitude, ils);
    return { ...this.enqueue(a, makeAst('ils', a.callsign, { runway: rs.name })), extra: { runway: rs.name, estimated: !!ils.estimated, aboveGlideslope: high, alongNM: Math.round(along * 10) / 10 } };
  }
  private execILS(a: AircraftState, runway: string, locOnly = false, maintainAlt: number | null = null, issuedAt: number | null = null) {
    const rs = this.runwayState(runway); if (!rs) return;
    const ils = this.ilsFor(rs.name); if (!ils) return;
    a.assignedRunway = rs.name; a.plan.runway = rs.name;
    a.ilsArmed = true; a.ilsCaptured = false; a.gsCaptured = false;
    a.navMode = locOnly ? 'loc' : 'ils';
    a.holdFix = null; a.holdFixName = null; a.directTargetXY = null; a.directTargetName = null;
    // An approach clearance supersedes earlier vectors, never the intercept heading given in the same transmission
    // ("turn right heading 245, cleared ILS"): the parts of a sequence draw their own pilot delays, so the ILS part can
    // execute a second before its heading part.
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'heading' || (issuedAt != null && c.issuedAt != null && c.issuedAt >= issuedAt));
    if (maintainAlt != null) { a.targetAltitude = maintainAlt; a.cmdAltitude = maintainAlt; }
    a.landingCleared = false; a.landingClearedAt = null;
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
    a.underControl = true; a.attention = false;
    this.sc(a).overshootSaid = false; this.sc(a).queried4NM = false; this.sc(a).locMinXtM = null;
  }
  cmdLOC(a: AircraftState, runway: string, maintainAlt: number | null): EngineOutcome {
    const r = this.cmdILS(a, runway); if (!r.ok) return r;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'ils');
    return { ...this.enqueue(a, makeAst('loc', a.callsign, { runway: upper(runway), maintainAlt })), extra: r.extra };
  }
  cmdVisual(a: AircraftState, runway: string, follow: string | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const w = this.wx();
    if (w.visM < 4800 || (w.ceilingFt != null && w.ceilingFt < 1500)) return { ok: false, code: 'unable', reason: 'Negative contact, IMC' };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (follow && !this.find(follow)) return { ok: false, code: 'not_found', reason: `No aircraft ${follow}` };
    return this.enqueue(a, makeAst('visual', a.callsign, { runway: rs.name, follow }));
  }
  private execVisual(a: AircraftState, runway: string) {
    // Visual approach: self-navigate to a 4 NM final then join the (estimated) ILS geometry.
    this.execILS(a, runway);
    a.navMode = 'visual';
    const ils = this.ilsFor(runway)!;
    const join = advance(ils.thrXY, (ils.rwdHdg + 180) % 360, 4 * NM_TO_M);
    a.directTargetXY = join; a.directTargetName = `FINAL ${upper(runway)}`;
    a.targetSpeed = Math.min(a.targetSpeed, 180);
    a.targetAltitude = Math.min(a.targetAltitude, 1500);
  }
  cmdCancelApproach(a: AircraftState, hdg: number, alt: number, dir: TurnDir | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (!a.ilsArmed && a.phase !== 'landing') return { ok: false, code: 'invalid_stage', reason: 'Not on approach' };
    const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null;
    if (a.phase === 'landing' && d != null && d < 2) return { ok: false, code: 'invalid_stage', reason: 'Use Go around' };
    return this.enqueue(a, makeAst('cancelApproach', a.callsign, { hdg, alt, dir }));
  }
  private execCancelApproach(a: AircraftState, hdg: number, alt: number, dir: TurnDir | null) {
    if (a.phase === 'landing') { a.path = null; a.distAlong = 0; a.phase = 'climb'; }
    this.cancelIls(a);
    a.assignedRunway = null;
    this.execHeading(a, hdg, dir); this.execAltitude(a, alt, false);
  }
  cmdExpectRunway(a: AircraftState, runway: string, approach: ApproachType): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    return this.enqueue(a, makeAst('expectRunway', a.callsign, { runway: rs.name, approach }));
  }
  cmdResumeSid(a: AircraftState): EngineOutcome {
    if (!isAirborne(a) || a.plan.kind !== 'departure') return { ok: false, code: 'invalid_stage', reason: 'Not a departure' };
    if (a.navMode === 'sid') return { ok: false, code: 'already', reason: 'Already on the SID' };
    return this.enqueue(a, makeAst('resumeSid', a.callsign));
  }
  cmdSquawk(a: AircraftState, code: string): EngineOutcome {
    if (!/^[0-7]{4}$/.test(code)) return { ok: false, code: 'invalid_param', reason: 'Squawk must be four octal digits' };
    return this.enqueue(a, makeAst('squawk', a.callsign, { code }));
  }
  cmdIdent(a: AircraftState): EngineOutcome { return this.enqueue(a, makeAst('ident', a.callsign)); }
  cmdRadarContact(a: AircraftState, descendTo: number | null, expectRunway: string | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (expectRunway && !this.runwayState(expectRunway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${expectRunway}` };
    this.answerRequest(a, ['with_you']);
    a.underControl = true; a.attention = false;
    return this.enqueue(a, makeAst('radarContact', a.callsign, { descendTo, expectRunway }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — meta
  // ═══════════════════════════════════════════════════════════════════════════
  cmdSayAgain(a: AircraftState): EngineOutcome {
    if (a.lastTransmissionAt < 0) return { ok: false, code: 'nothing_pending', reason: 'Nothing to repeat' };
    const text = a.readback.text || a.requests[0]?.text || '';
    if (text) this.readbacks.push({ at: this.time + rf(1.5, 3), aircraftId: a.id, status: a.readback.status === 'none' ? 'ok' : a.readback.status, text: `I say again, ${text}`, ast: a.readback.lastAst, refused: [], mismatch: null });
    return OK;
  }
  cmdCorrection(a: AircraftState, field: CorrectionField, value: number | string): EngineOutcome {
    const m = a.readback.mismatch;
    if (m) { a.readback.mismatch = null; a.readback.status = 'ok'; }
    const kindOf: Partial<Record<CorrectionField, PendingCmd['kind']>> = { heading: 'heading', altitude: 'altitude', speed: 'speed' };
    const kind = kindOf[field];
    if (kind) {
      const num = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!isFinite(num)) return { ok: false, code: 'invalid_param', reason: 'Numeric value required' };
      const p = a.pendingCmds.find(c => c.kind === kind);
      const ast = makeAst(kind as 'heading', a.callsign, kind === 'heading' ? { hdg: num } : kind === 'altitude' ? ({ ft: num } as never) : ({ kts: num } as never));
      if (p) { p.value = num; p.ast = ast; p.applyAt = this.time + this.pilotDelayS(a, kind); p.issuedAt = this.time; }
      else return this.enqueue(a, ast, { value: num });
      return { ok: true, code: 'ok_queued', applyAt: p.applyAt };
    }
    if (!m && !a.readback.lastAst) return { ok: false, code: 'nothing_pending', reason: 'Nothing to correct' };
    return OK;
  }
  cmdDisregard(a: AircraftState): EngineOutcome {
    for (let i = a.pendingCmds.length - 1; i >= 0; i--) {
      const c = a.pendingCmds[i];
      if (c.cancellable === false) continue;
      a.pendingCmds.splice(i, 1);
      // the pilot must not read back an instruction that was just withdrawn
      this.readbacks = this.readbacks.filter(r => !(r.aircraftId === a.id && r.ast?.kind === c.kind));
      if (a.readback.status === 'pending' && !this.readbacks.some(r => r.aircraftId === a.id)) a.readback = { ...a.readback, status: 'none', dueAt: 0 };
      if (c.kind === 'takeoff') this.clearTakeoffClearance(a);
      if (c.kind === 'altitude') a.cmdAltitude = a.targetAltitude;
      if (c.kind === 'speed') a.cmdIas = null;
      return { ...OK, extra: { kind: c.kind } };
    }
    return { ok: false, code: 'nothing_pending', reason: 'Nothing pending' };
  }
  cmdStandby(a: AircraftState): EngineOutcome {
    a.standbyUntil = this.time + 120;
    const req = a.requests[0];
    if (req) { req.recallAt = this.time + 120; }
    return OK;
  }
  cmdUnable(a: AircraftState, reason: UnableReason): EngineOutcome {
    const req = a.requests[0];
    if (!req) return { ok: false, code: 'nothing_pending', reason: 'No request pending' };
    this.answerRequest(a, 'any');
    const s = this.sc(a);
    const delay = reason === 'delay' || reason === 'slot' ? rf(120, 240) : rf(60, 120);
    // (a direct turned down with "expect vectors" is not asked for again: the crew is being vectored)
    s.nextRequestAt = this.time + delay; s.nextRequestKind = req.kind === 'with_you' || req.kind === 'direct' || req.kind === 'concern' ? null : req.kind;   // (a report is not made again because it was turned down)
    return { ...OK, extra: { reason } };
  }
  cmdReport(a: AircraftState, items: ReportKind[]): EngineOutcome {
    const cs = this.telephony(a.callsign);
    const lines: string[] = [];
    for (const it of items.length ? items : ['position' as ReportKind]) {
      switch (it) {
        case 'position': lines.push(isAirborne(a) ? `${Math.round(dist(a.pos, this.centerXY) / NM_TO_M)} miles from the field, ${Math.round(a.altitude / 100) * 100} feet` : `${a.phase === 'parked' ? `stand ${a.plan.gateRef}` : a.holdShortRunway ? `holding short ${a.holdShortRunway}` : 'on the taxiway'}`); break;
        case 'heading': lines.push(`heading ${hdg3(a.heading - this.magVar)}`); break;
        case 'altitude': lines.push(`${a.altitude > a.targetAltitude + 50 ? 'descending through' : a.altitude < a.targetAltitude - 50 ? 'climbing through' : 'maintaining'} ${Math.round(a.altitude / 100) * 100}`); break;
        case 'airspeed': lines.push(`${Math.round(a.speed)} knots`); break;
        case 'pob': lines.push(`${a.emergency?.soulsOnBoard ?? this.soulsFor(a)} on board`); break;
        case 'fuel': lines.push(`fuel ${Math.round(a.fuelMin ?? 90)} minutes`); break;
        case 'nature': lines.push(a.emergency ? a.emergency.type.replace('_', ' ') : 'no emergency'); break;
        case 'dg': lines.push('no dangerous goods'); break;
        case 'intentions': lines.push(a.emergency ? (a.emergency.requests[0] ?? 'request priority landing') : 'as filed'); break;
        case 'established': lines.push(a.ilsCaptured ? `established localizer ${a.assignedRunway}` : 'not yet established'); break;
        case 'vacated': lines.push(this.sc(a).vacated ? 'runway vacated' : 'still on the runway'); break;
        case 'ready': lines.push(a.phase === 'hold_short' ? 'ready for departure' : 'not yet ready'); break;
        case 'reason': lines.push(a.requests[0]?.text ?? 'no reason'); break;
        case 'readyou5': lines.push('read you five'); this.answerRequest(a, ['radio_check']); break;
        case 'four_mile_final': lines.push(`${(a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) ?? 0 : 0).toFixed(0)} mile final`); break;
        case 'rolling': lines.push(a.phase === 'takeoff' ? 'rolling' : 'holding'); break;
        case 'ride': { const r = isAirborne(a) ? crewLifeOf(this).rideOf(a) : 'smooth'; lines.push(isAirborne(a) ? (r === 'smooth' ? 'smooth ride' : `${r} chop`) : 'on the ground'); break; }
      }
    }
    if (a.emergency && items.some(i => i === 'pob' || i === 'fuel')) this.checklist(a, 'souls_fuel');
    this.readbacks.push({ at: this.time + rf(2, 4), aircraftId: a.id, status: 'ok', text: `${lines.join(', ')}, ${cs}.`, ast: null, refused: [], mismatch: null });
    return { ...OK, extra: { items: items.join(',') } };
  }
  private soulsFor(a: AircraftState): number { const [lo, hi] = SOULS_BY_CLASS[a.perf.weightClass]; return lo + ri(hi - lo + 1); }
  cmdRoger(a: AircraftState): EngineOutcome { this.answerRequest(a, 'any'); return OK; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — emergency + system
  // ═══════════════════════════════════════════════════════════════════════════
  private checklist(a: AircraftState, item: Parameters<typeof completeChecklistItem>[1]) {
    if (!a.emergency) return;
    const ev = this.safe('emergencies', () => completeChecklistItem(a, item, this.time), null);
    if (ev) this.applyScore(ev);
    else if (a.emergency.checklist[item] == null) a.emergency.checklist[item] = this.time;
  }
  cmdEmergencyAck(a: AircraftState, ask: EmergencyInfoKind[], squawk: boolean): EngineOutcome {
    const e = a.emergency; if (!e) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    if (e.status === 'declared') e.status = 'acknowledged';
    this.checklist(a, 'acknowledge');
    if (ask.includes('pob') || ask.includes('fuel')) this.checklist(a, 'souls_fuel');
    if (squawk && e.squawk) a.squawk = e.squawk;
    const reply = this.safe('emergencies', () => ackReplyLine(a, this.telephony(a.callsign)), '') || `${e.soulsOnBoard} souls on board, fuel ${Math.round(e.fuelMin ?? a.fuelMin ?? 60)} minutes, ${this.telephony(a.callsign)}.`;
    this.readbacks.push({ at: this.time + rf(2, 4), aircraftId: a.id, status: 'ok', text: reply, ast: null, refused: [], mismatch: null });
    this.emit('emergency', a, `${a.callsign} emergency acknowledged`, { type: 'emergency', emergency: e, change: 'acknowledged' }, 'SYS');
    return OK;
  }
  cmdPriority(a: AircraftState, runway: string, opts: { straightIn: boolean; numberOne: boolean; sterile: boolean; clearIls: boolean }): EngineOutcome {
    const e = a.emergency; if (!e) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    return { ...this.enqueue(a, makeAst('priority', a.callsign, { runway: rs.name, ...opts })), extra: { runway: rs.name } };
  }
  private execPriority(a: AircraftState, runway: string, opts: { straightIn: boolean; numberOne: boolean; sterile: boolean; clearIls: boolean }) {
    const e = a.emergency; const rs = this.runwayState(runway); if (!e || !rs) return;
    e.runway = rs.name; e.priority = true; a.priority = true; a.sequenceNo = opts.numberOne ? 1 : a.sequenceNo;
    a.plan.runway = rs.name;
    this.checklist(a, 'priority_runway');
    if (opts.sterile) { e.sterile = true; this.setRunwayStatus(rs.name, 'sterile', `emergency ${a.callsign}`); this.checklist(a, 'hold_traffic'); }
    if (opts.clearIls) this.execILS(a, rs.name);
    if (e.status === 'declared') e.status = 'acknowledged';
    this.emit('emergency', a, `${a.callsign} priority runway ${rs.name}`, { type: 'emergency', emergency: e, change: 'update' }, 'SYS');
  }
  cmdStopOnRunway(a: AircraftState, mode: 'stop' | 'vacate_if_able', via: string | null): EngineOutcome {
    if (!a.emergency) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    if (via && !this.air.taxiwayNodes.has(upper(via))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(via)} here` };
    return this.enqueue(a, makeAst('stopOnRunway', a.callsign, { mode, via }));
  }
  cmdEmergencyCancelAck(a: AircraftState): EngineOutcome {
    const e = a.emergency; if (!e) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    this.answerRequest(a, ['cancel_mayday']);
    this.resolveEmergency(a, 'cancelled by pilot');
    return OK;
  }
  private resolveEmergency(a: AircraftState, reason: string) {
    const e = a.emergency; if (!e || e.status === 'resolved') return;
    e.status = 'resolved'; e.resolvedAt = this.time;
    a.priority = false;
    // the pilot stops squawking the emergency code (7700/7600/7500) once the emergency is over
    if (a.squawk && ['7700', '7600', '7500'].includes(a.squawk)) a.squawk = a.clearance?.squawk ?? this.newSquawk();
    const evs = this.safe('emergencies', () => scoreOnResolved(a, this.time), null);
    if (evs) for (const ev of evs) this.applyScore(ev); else this.addScore('EMERGENCY_DONE', a.callsign, null, e.runway, reason);
    this.stats.emergenciesResolved++;
    this.emit('emergency', a, `${a.callsign} emergency resolved (${reason})`, { type: 'emergency', emergency: e, change: 'resolved' }, 'SYS');
    this.safe('alerts', () => { for (const al of this.alerts.active()) if (al.kind === 'emergency' && al.subjects[0] === a.callsign) this.alerts.resolve(al.id, this.time); }, undefined);
    if (e.sterile && e.runway) { const rs = this.runwayState(e.runway); if (rs && rs.status === 'sterile') this.setRunwayStatus(rs.name, 'open', 'emergency resolved'); }
  }
  /** Declare an emergency on an aircraft (random hook or test API forceEmergency). */
  declareEmergency(a: AircraftState, type: EmergencyType): Emergency {
    const stage = this.stageOf(a);
    const spec = EMERGENCY_CATALOGUE[type];
    const souls = this.soulsFor(a);
    const fuel = spec.fuelMin ? Math.round(rf(spec.fuelMin[0], spec.fuelMin[1])) : null;
    const rwy = this.bestRunwayFor(a, spec.runwayPreference);
    const e = createEmergency(type, a, stage, this.time, souls, fuel, this.telephony(a.callsign), rwy);
    return this.attachEmergency(a, e);
  }
  private attachEmergency(a: AircraftState, e: Emergency): Emergency {
    a.emergency = e; a.priority = true;
    if (e.squawk) a.squawk = e.squawk;
    if (e.fuelMin != null) a.fuelMin = e.fuelMin;
    this.stats.emergenciesDeclared++;
    const before = this.pendingEvents.length;
    this.safe('emergencies', () => onDeclared(this.emergencyView(), a), undefined);
    const emitted = this.pendingEvents.slice(before).some(ev => ev.type === 'emergency');
    if (!emitted) this.emit('emergency', a, e.pilotLine || `${a.callsign} squawking ${e.squawk ?? '7700'}`, { type: 'emergency', emergency: e, change: 'declared' });
    this.safe('alerts', () => this.alerts.raise('emergency', [a.callsign], `${e.level} ${a.callsign}`, e.type.replace('_', ' '), this.time, { runway: e.runway }, [a.id]), undefined);
    if (a.navMode === 'hold' && EMERGENCY_CATALOGUE[e.type].noDelay) { a.navMode = 'heading'; a.targetHeading = a.heading; }
    return e;
  }
  bestRunwayFor(a: AircraftState, pref: 'nearest' | 'longest' | 'any'): string | null {
    const cands = this.runways.filter(r => r.status === 'open' && this.weightAllowed(r.name, a.perf.weightClass) && (r.activeArr || pref !== 'any'));
    if (!cands.length) return this.runways[0]?.name ?? null;
    if (pref === 'longest') return cands.reduce((b, r) => (r.lengthM > b.lengthM ? r : b)).name;
    const thr = (r: RunwayState) => this.thresholdXY(r.name)!;
    const scored = cands.map(r => ({ r, d: dist(a.pos, thr(r)) + (r.activeArr ? 0 : 3000) + Math.abs(-this.windFor(r.headingTrue).headKt) * 200 }));
    return scored.reduce((b, x) => (x.d < b.d ? x : b)).r.name;
  }
  private emergencyView(): EmergencyEngineView {
    return {
      time: this.time, aircraft: this.aircraft, stageOf: (a) => this.stageOf(a),
      bestRunway: (a, pref) => this.bestRunwayFor(a, pref),
      setRunwayStatus: (rw, st, reason) => { this.setRunwayStatus(rw, st, reason); },
      emit: (ev) => this.pushEvent(ev),
      score: (ev) => { this.applyScore(ev); },
      telephony: (cs) => this.telephony(cs),
    };
  }
  private holdAllBlocks(a: AircraftState, rs: RunwayState): boolean {
    const h = this.holdAllActive; if (!h || a.emergency) return false;
    if (h.runway && this.refOf(h.runway) !== rs.ref) return false;
    return h.scope === 'all' || h.scope === 'departures';
  }
  holdAll(scope: HoldAllScope, runway: string | null): EngineOutcome {
    if (runway && !this.runwayState(runway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    this.holdAllActive = { scope, runway: runway ? upper(runway) : null };
    for (const a of this.aircraft) if (!a.emergency && !isAirborne(a) && a.phase !== 'parked' && a.phase !== 'arrived') { a.heldByEmergency = true; if (scope === 'all' && (a.phase === 'taxi' || a.phase === 'hold_short')) { a.trafficHold = true; this.manualHold.add(a.id); } }
    for (const a of this.aircraft) if (a.emergency) this.checklist(a, 'hold_traffic');
    this.emit('info', null, `All stations, hold position${runway ? `, runway ${runway}` : ''}, emergency in progress.`, undefined, 'ATC');
    return OK;
  }
  resumeAll(): EngineOutcome {
    if (!this.holdAllActive) return { ok: false, code: 'nothing_pending', reason: 'No traffic hold active' };
    this.holdAllActive = null;
    for (const a of this.aircraft) { if (a.heldByEmergency) { a.heldByEmergency = false; this.manualHold.delete(a.id); a.trafficHold = false; } }
    this.emit('info', null, 'All stations, resume normal operations.', undefined, 'ATC');
    return OK;
  }
  dispatchVehicle(type: VehicleType, ids: string[], count: number, target: VehicleTarget): EngineOutcome {
    if (target.kind === 'runway' && !this.runwayState(target.runway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${target.runway}` };
    if (target.kind === 'aircraft' && !this.byId(target.id) && !this.find(target.callsign)) return { ok: false, code: 'not_found', reason: `No aircraft ${target.callsign}` };
    if (target.kind === 'stand' && !this.gateByRef(target.ref)) return { ok: false, code: 'unknown_stand', reason: `Unknown stand ${target.ref}` };
    if (!this.sys.fleet) return { ok: false, code: 'not_implemented', reason: 'Vehicles not available' };
    const res = this.safe('fleet', () => this.fleet.dispatch(type, target, ids, count), null);
    if (!res) return { ok: false, code: 'not_implemented', reason: 'Vehicles not available' };
    if (!res.ok) return { ok: false, code: 'vehicle_unavailable', reason: res.reason ?? 'No vehicle available' };
    for (const v of res.vehicles) this.emit('vehicle', null, `${v.callsign} -> ${describeTarget(target)}${res.etaAt != null ? `, ETA ${Math.round(res.etaAt - this.time)} s` : ''}`, { type: 'vehicle', vehicleId: v.id, state: v.state, target, etaS: res.etaAt != null ? res.etaAt - this.time : null });
    // Emergency checklist hooks
    const subject = target.kind === 'aircraft' ? (this.byId(target.id) ?? this.find(target.callsign)) : this.aircraft.find(a => a.emergency && a.emergency.status !== 'resolved' && (target.kind !== 'runway' || !a.emergency.runway || this.refOf(a.emergency.runway) === this.refOf(target.runway)));
    if (subject?.emergency) {
      const e = subject.emergency; const s = this.sc(subject);
      if (type === 'arff') { e.arff = res.vehicles.length >= 3 ? 'full' : 'local'; if (e.status === 'acknowledged' || e.status === 'declared') e.status = 'services_dispatched'; this.checklist(subject, 'arff'); s.arffDispatchedAt = s.arffDispatchedAt ?? this.time; }
      if (type === 'ambulance') this.checklist(subject, 'ambulance');
      this.emit('emergency', subject, `${subject.callsign}: ${type} dispatched`, { type: 'emergency', emergency: e, change: 'services' }, 'SYS');
    }
    return { ...OK, extra: { count: res.vehicles.length, etaS: res.etaAt != null ? Math.round(res.etaAt - this.time) : null } };
  }
  recallVehicle(id: string): EngineOutcome {
    const v = this.fleet.byId(id); if (!v) return { ok: false, code: 'unknown_vehicle', reason: `Unknown vehicle ${id}` };
    const ok = this.safe('fleet', () => this.fleet.recall(id), false);
    if (!ok) return { ok: false, code: 'already', reason: `${v.callsign} already at station` };
    this.emit('vehicle', null, `${v.callsign} returning to station`, { type: 'vehicle', vehicleId: v.id, state: v.state, target: { kind: 'station' }, etaS: null });
    return OK;
  }
  vehicleOp(id: string, op: 'hold' | 'continue' | 'cross' | 'rtb', runway: string | null): EngineOutcome {
    const v = this.fleet.byId(id); if (!v) return { ok: false, code: 'unknown_vehicle', reason: `Unknown vehicle ${id}` };
    if (op === 'cross' && runway && !this.runwayState(runway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const ok = this.safe('fleet', () => this.fleet.op(id, op, runway), false);
    if (!ok) return { ok: false, code: 'invalid_stage', reason: `${v.callsign}: cannot ${op} now` };
    this.emit('vehicle', null, `${v.callsign} ${op === 'rtb' ? 'return to base' : op === 'cross' ? `cross runway ${runway ?? ''}` : op}`, { type: 'vehicle', vehicleId: v.id, state: v.state, target: v.target, etaS: null });
    return OK;
  }
  broadcast(text: string): EngineOutcome {
    if (!text.trim()) return { ok: false, code: 'invalid_param', reason: 'Empty broadcast' };
    this.emit('info', null, `All stations, ${this.airportName}, ${text}`, undefined, 'ATC');
    for (const a of this.aircraft) if (a.emergency?.type === 'hijack' && /hijack|seven five|7500/i.test(text)) this.addScore('EMERGENCY_CHECKLIST_MISS', a.callsign, null, null, 'hijack discussed on frequency');
    return OK;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main loop
  // ═══════════════════════════════════════════════════════════════════════════
  /** Real-time driver: accumulates dt (clamped, B18) and runs fixed substeps; one post pass per call. */
  update(realDt: number): SimEvent[] {
    if (this.paused) { const out = this.pendingEvents; this.pendingEvents = []; return out; }
    this.acc = Math.min(this.acc + Math.min(realDt, 0.25), FIXED * MAX_SUBSTEPS);
    let steps = 0;
    while (this.acc >= FIXED && steps < MAX_SUBSTEPS) { this.substep(); this.acc -= FIXED; steps++; }
    if (steps > 0) this.postPass(steps * FIXED);
    const out = this.pendingEvents; this.pendingEvents = [];
    return out;
  }
  /** Deterministic driver: exactly `n` fixed substeps, then one post pass. Returns the events. */
  step(n = 1): SimEvent[] {
    for (let i = 0; i < n; i++) this.substep();
    if (n > 0) this.postPass(n * FIXED);
    const out = this.pendingEvents; this.pendingEvents = [];
    return out;
  }
  private substep() {
    const ctx = this.stepCtx();
    for (const a of this.aircraft) this.drainPending(a);
    this.applyNavTargets();
    this.applyTraffic();
    for (const a of this.aircraft) if (!this.sc(a).tow) stepAircraft(a, FIXED, ctx);
    this.towStep(FIXED);
    this.stepSystems();
    this.handleTransitions();
    this.processReadbacks();
    const sec = Math.floor(this.time);
    if (sec !== this.lastSecond) { this.lastSecond = sec; this.perSecond(); }
    this.time += FIXED;
    this.stats.simTime = this.time;
  }
  private postPass(dt: number) {
    this.checkSeparation();
    this.checkIncursions();
    this.stepAlerts(dt);
    this.stats.streakS += dt;
  }
  private stepCtx(): StepCtx {
    const wx = this.wx();
    return {
      time: this.time,
      wind: (hdg, tas) => applyWind(wx, hdg, tas),
      headwindKt: (rwyHdg) => windComponents(wx.windDirTrue, wx.windKt, rwyHdg).headKt,
      surfaceFactor: () => SURFACE_FACTOR[wx.runwayCondition],
      taxiSpeedCapKt: (a) => this.taxiSpeedCap(a),
      emit: (type, a, message, data) => { this.emit(type, a, message, data); },
      setPhase: (a, phase) => { if (a.phase !== phase) { a.phase = phase; this.emit('phase', a, `${a.callsign} -> ${phase}`); } },
    };
  }
  /** Progressive taxi cap: apron 10 kt, crossing a runway 15 kt, expedite +30 % (heavies +15 %), single-engine taxi 30 kt cap. */
  private taxiSpeedCap(a: AircraftState): number {
    let cap = a.perf.maxTaxiSpeed;
    if (a.path) {
      if ((a.plan.kind === 'departure' && a.distAlong < 120) || (a.plan.kind === 'arrival' && a.path.total - a.distAlong < 200) || this.nearGate(a.pos)) cap = Math.min(cap, 10);
    }
    if (this.sc(a).crossingRef) cap = Math.min(cap, 15);
    if (this.time < a.expediteTaxiUntil) cap = Math.min(cap * (a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 1.15 : 1.3), 25);
    if (a.emergency?.type === 'engine_failure') cap = Math.min(cap, 30);
    return cap;
  }
  private stepSystems() {
    // vehicles
    if (this.sys.fleet) {
      const ctx: VehicleStepCtx = {
        time: this.time, air: this.air, nodeXY: (id) => this.nodeXY(id), nearestNodeId: (p) => this.nearestNodeId(p),
        pathFromNodes: (ids) => this.pathFromNodes(ids), runways: this.runways, aircraft: this.aircraft,
        crossingSafe: (rw) => this.crossingSafe(rw, 25), autoCross: false,
      };
      const res = this.safe('fleet', () => this.fleet.step(FIXED, ctx), null);
      if (res) {
        // events the fleet queued between steps (dispatch / recall) carry its last step time: stamp them with the current time so the stream stays monotonic
        for (const ev of res.events) this.pushEvent(ev.at < this.time ? { ...ev, at: this.time } : ev);
        for (const e of res.enteredRunway) { const rs = this.bothEnds(e.runway)[0] ?? this.runwayState(e.runway); const v = this.fleet.byId(e.vehicleId); if (rs && v) this.addOccupant(rs.name, { id: v.id, callsign: v.callsign }, 'vehicle'); }
        for (const e of res.vacatedRunway) { const rs = this.bothEnds(e.runway)[0] ?? this.runwayState(e.runway); if (rs) this.removeOccupant(rs.ref, e.vehicleId); }
        for (const r of res.crossingRequests) {
          const v = this.fleet.byId(r.vehicleId);
          if (v && !this.pendingEvents.some(ev => ev.type === 'request' && ev.callsign === v.id)) {
            const req: PilotRequest = { id: ++this.reqSeq, kind: 'cross', callsign: v.id, text: `Ground, ${v.callsign}, request cross runway ${r.runway}.`, param: r.runway, at: this.time, recallAt: this.time + 45, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null };
            this.pushEvent({ type: 'request', id: -1, callsign: v.id, message: req.text, at: this.time, data: { type: 'request', request: req, change: 'raised' } });
          }
        }
      }
    }
    // weather
    if (this.sys.weather) {
      const res = this.safe('weather', () => this.weather.step(FIXED), null);
      if (res) {
        for (const ev of res.events) this.pushEvent(ev.at < this.time ? { ...ev, at: this.time } : ev);
        if (res.atisChanged || res.suggestion) this.onWeatherChange(res.suggestion);
      }
    }
  }
  private onWeatherChange(suggestion: { dep: string[]; arr: string[]; reason: string } | null) {
    const w = this.wx();
    for (const rs of this.runways) { const c = windComponents(w.windDirTrue, w.windKt, rs.headingTrue); rs.windHeadKt = c.headKt; rs.windCrossKt = c.crossKt; }
    const curDep = this.activeEnds('dep').map(r => r.name).sort(), curArr = this.activeEnds('arr').map(r => r.name).sort();
    let sug = suggestion;
    if (!sug) sug = this.safe('weather', () => this.weather.suggestRunways(this.manifestEnds(), { dep: curDep, arr: curArr }), null);
    if (sug && (sug.dep.slice().sort().join() !== curDep.join() || sug.arr.slice().sort().join() !== curArr.join())) {
      const key = `${sug.dep.join('/')}|${sug.arr.join('/')}`;
      this.suggestedRunways = sug;
      if (key !== this.lastSuggestionKey) {
        this.lastSuggestionKey = key;
        const atis = this.safe('weather', () => this.weather.atis(), null);
        const msg = `Wind ${hdg3(w.windDirTrue)}/${Math.round(w.windKt)}${w.gustKt ? `G${Math.round(w.gustKt)}` : ''} — runway ${sug.arr.join('/')} recommended (current ${curArr.join('/')}). ${sug.reason}`;
        if (atis) this.emit('atis', null, msg, { type: 'atis', atis, reason: `runway change suggested: ${sug.reason}` });
        const rs = this.runwayState(sug.dep[0] ?? sug.arr[0]);
        if (rs) this.emit('runway_state', null, msg, { type: 'runway_state', runway: rs.name, status: rs.status, previous: rs.status, reason: `suggested: ${sug.reason}` });
      }
    } else { this.suggestedRunways = null; this.lastSuggestionKey = ''; }
  }
  /** Force a wind change (test hook / scenario); re-evaluates the runway suggestion immediately. */
  setWind(dirTrue: number, kts: number, gust = 0) {
    this.safe('weather', () => this.weather.setWind(dirTrue, kts, gust), undefined);
    if (!this.sys.weather) { const w = this.weather.state(); w.windDirTrue = dirTrue; w.windKt = kts; w.gustKt = gust; w.updatedAt = this.time; }
    this.onWeatherChange(null);
  }

  // ── nav targets (every substep, before physics) ─────────────────────────────
  private applyNavTargets() {
    for (const a of this.aircraft) {
      if (!isAirborne(a) || a.phase === 'landing') continue;
      const s = this.sc(a);
      // --- HOLD pattern (holds.ts: the entry from the heading at the fix, wind flown out, the inbound leg timed) ---
      if (a.navMode === 'hold' && a.holdFix) {
        const w = this.wx(); flyHold(a, FIXED, { dirTrue: w.windDirTrue, kt: w.windKt });
        a.delay.holdingS += FIXED;
        if (a.holdEfc != null && this.time > a.holdEfc + 60 && !s.efcAsked) { s.efcAsked = true; this.raiseRequest(a, 'further', null, `${this.telephony(a.callsign)}, holding at ${spokenFix(a.holdFixName ?? '')}, our expect further clearance time has passed, request further clearance.`); }
      }
      // --- DCT ---
      if ((a.navMode === 'direct' || a.navMode === 'visual') && a.directTargetXY) {
        a.targetHeading = headingTo(a.pos, a.directTargetXY);
        if (dist(a.pos, a.directTargetXY) < (a.navMode === 'visual' ? 600 : 1500)) {
          if (a.directTargetName) s.passedFixes.add(a.directTargetName);
          if (a.navMode === 'direct') { a.navMode = 'heading'; a.directTargetXY = null; s.nextRequestAt = this.time + 30; s.nextRequestKind = 'further'; }
          else { a.directTargetXY = null; }
        }
      }
      // --- SID ---
      if (a.navMode === 'sid' && a.plan.fix) {
        const b = this.beacons.find(x => x.id === a.plan.fix);
        if (b) { a.targetHeading = headingTo(a.pos, { x: b.x, y: b.y }); if (dist(a.pos, { x: b.x, y: b.y }) < 2000) { a.navMode = 'heading'; s.passedFixes.add(b.id); } }
      }
      // --- ILS / LOC / visual final ---
      if ((a.navMode === 'ils' || a.navMode === 'loc' || a.navMode === 'visual') && a.ilsArmed && a.assignedRunway) {
        const r = this.ilsFor(a.assignedRunway); if (!r) continue;
        if (!a.ilsCaptured) {
          const arcade = this.settings.arcadeIntercept || a.navMode === 'visual';
          if (canCaptureLoc(a.pos, a.heading, r, arcade)) {
            if (!aboveGlideslope(a.pos, a.altitude, r)) {
              a.ilsCaptured = true; a.turnDir = null; a.holdFix = null;
              if ((a.cmdIas ?? a.targetSpeed) > 200) { a.targetSpeed = 200; a.cmdIas = null; }
              this.addScore('ESTABLISHED', a.callsign, null, a.assignedRunway);
              this.emit('info', a, `${a.callsign} established localizer ${a.assignedRunway}`, undefined, 'PILOT');
            } else if (!s.overshootSaid) { s.overshootSaid = true; this.raiseRequest(a, 'further', null, `${this.telephony(a.callsign)}, unable to capture, we're above the glideslope for ${r.name}, request vectors.`); }
          } else if (!s.overshootSaid && overshootsLoc(a.pos, a.heading, r, arcade)) { s.overshootSaid = true; this.raiseRequest(a, 'further', null, `${this.telephony(a.callsign)}, we're through the localizer for ${r.name}, request vectors back.`); }
          else if (!s.overshootSaid) {
            // Cleared on a heading that never reaches the beam (or drifting away after missing it): once the cross-track
            // has opened by 0.4 NM from the closest point seen since the clearance, the crew asks for vectors instead
            // of flying on to the airspace boundary.
            const xt = Math.abs(crossTrackM(a.pos, r));
            if (s.locMinXtM == null || xt < s.locMinXtM) s.locMinXtM = xt;
            else if (xt > s.locMinXtM + 0.4 * NM_TO_M && xt > 1500 && distAlongFwd(a.pos, r) > 0 && Math.abs(angleDelta(a.heading, r.locCourse)) > 12) { s.overshootSaid = true; this.raiseRequest(a, 'further', null, `${this.telephony(a.callsign)}, we're not going to intercept the localizer for ${r.name} on this heading, request vectors.`); }
          }
        }
        if (a.ilsCaptured) {
          // Track the localizer: the LOC law gives a desired TRACK; convert to a heading with the wind-correction angle
          // so a crosswind does not hold the aircraft off the centreline (the engine moves along the wind-corrected track).
          const trk = locTargetHdg(a.pos, r);
          const w = this.wx();
          const rel = ((w.windDirTrue - trk) + 540) % 360 - 180; // + = wind from the right
          const xw = Math.sin(rel * Math.PI / 180) * w.windKt;
          const wca = Math.asin(Math.max(-0.5, Math.min(0.5, xw / Math.max(80, a.speed)))) * 180 / Math.PI;
          a.targetHeading = (trk + wca + 360) % 360;
          const along = distAlongFwd(a.pos, r);
          const gs = gsAltFt(along, r);
          // GS capture from slightly below (the slope comes down to a level aircraft) or within the above-slope tolerance
          // the LOC capture allowed; the aircraft then descends onto the slope (stepLanding converges without an altitude
          // jump). Well below the slope it stays level until the slope reaches it - it never climbs to the glideslope.
          if (!a.gsCaptured && a.navMode !== 'loc' && a.altitude >= gs - 150 && a.altitude <= gs + ILS_CONST.aboveGsFt && along > 500) a.gsCaptured = true;
          const distNM = along / NM_TO_M;
          if (a.gsCaptured) {
            if (distNM < 4) a.targetSpeed = a.perf.approachSpeed;
            else if (distNM < 6 && a.targetSpeed > 160) a.targetSpeed = 160;
            if (a.speedUntilNM != null && distNM <= a.speedUntilNM) { a.speedUntilNM = null; a.cmdIas = null; }
            a.targetAltitude = Math.max(0, Math.min(gs, a.altitude));       // never up to the slope: level until it comes down
          }
        }
      }
      // --- 15 NM auto-slow (220 kt) unless a speed was assigned ---
      const fieldDist = dist(a.pos, this.centerXY);
      if (fieldDist < 15 * NM_TO_M && a.cmdIas == null && a.targetSpeed > 220 && !a.ilsCaptured && a.plan.kind === 'arrival') a.targetSpeed = 220;
      // --- departure: turn to the after-departure heading above 400 ft, SID otherwise ---
      if (a.plan.kind === 'departure' && a.phase === 'takeoff' && a.altitude >= DEP_TURN_FT) {
        a.phase = 'climb';
        if (a.clearance.depHdg != null) { a.navMode = 'heading'; a.targetHeading = a.clearance.depHdg; }
        else a.navMode = 'sid';
        a.targetAltitude = a.clearance.initialAlt; a.cmdAltitude = a.clearance.initialAlt;
        this.emit('phase', a, `${a.callsign} -> climb`);
      }
    }
  }

  // ── ground traffic rules (B14: tie-break after all rules; give-way; parked excluded) ──
  private applyTraffic() {
    const moving = this.aircraft.filter(a => ['taxi', 'pushback', 'lineup', 'rollout', 'hold_short'].includes(a.phase) || (a.phase === 'takeoff' && a.path && !a.takeoffCleared));
    // Static aircraft at their stand (parked / starting up nose-in) do not block the apron lane next to them; an aircraft
    // that has pushed back and is waiting for its engines on the lane does.
    const blockers = this.aircraft.filter(a => !isAirborne(a) && a.phase !== 'parked' && a.phase !== 'arrived' && !(a.phase === 'startup' && a.pushback.stage !== 'complete'));
    // Direction of travel: a pushback moves tail-first, so it looks behind itself for traffic.
    const travelHdg = (a: AircraftState) => (a.phase === 'pushback' ? (a.heading + 180) % 360 : a.heading);
    const blockedBy = new Map<number, number>();
    // pulled or towed out of this one's way, or found to leave room: passed by its real outline, not kept off by its circle
    const aside = (x: AircraftState, y: AircraftState) => { const sx = this.sc(x), pl = sx.pull, tw = sx.tow, ps = this.sc(y).pass; return (!!pl?.held && pl.forId === y.id) || (tw?.doneAt != null && tw.forId === y.id) || (!!ps && ps.id === x.id && this.time < ps.until); };
    // pushed back and starting up: it is not moving, so nothing holds it (a hold left over from the push hid its taxi call
    // behind "give way" for good)
    for (const a of this.aircraft) if (a.phase === 'startup' && a.trafficHold && !this.manualHold.has(a.id)) { a.trafficHold = false; this.sc(a).holdReason = null; this.sc(a).heldSince = null; this.sc(a).blockedById = null; }
    // (cleared for take-off while it stood for somebody: it is no longer looked at here, so the hold went with it for good)
    for (const a of this.aircraft) if (a.phase === 'takeoff' && a.takeoffCleared && a.trafficHold && !this.manualHold.has(a.id)) { a.trafficHold = false; this.sc(a).holdReason = null; this.sc(a).heldSince = null; this.sc(a).blockedById = null; }
    for (const a of moving) { this.sc(a).holdReason = null; if (!this.manualHold.has(a.id)) a.trafficHold = false; else { a.trafficHold = true; this.sc(a).holdReason = 'manual hold'; } }
    for (const a of moving) {
      // a rollout on the strip never stops for traffic; once on the exit taxiway (vacated) it queues like any other
      if (a.phase === 'hold_short' || (a.phase === 'rollout' && !this.sc(a).vacated) || this.manualHold.has(a.id)) continue;
      let zone: boolean | null = null;
      for (const b of blockers) {
        if (b === a) continue;
        const d = dist(a.pos, b.pos); if (d < 1) continue;
        if (aside(b, a)) { if (!this.clearPast(a, b, 60, 2)) { a.trafficHold = true; blockedBy.set(a.id, b.id); this.sc(a).holdReason ??= `no room past ${b.callsign}`; } continue; }
        // b was told to give way to a and is waiting for it: a goes on unless they would actually touch (both stopping for
        // each other is the deadlock the instruction exists to prevent)
        if (b.giveWayTo === a.id && d > (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.62) continue;
        const hs = b.wakeCategory === 'HEAVY' || b.wakeCategory === 'SUPER' ? 20 : 0;
        // still inside a runway's protected zone (just crossed it): close up to the minimum so the tail clears the strip
        const inZone = (zone ??= this.runwaysAt(a.pos, HOLD_LINE_M).length > 0);
        const gap = inZone ? (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.62 + 6 : a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 14 + a.speed * 0.9 + hs;
        if (d < gap) {
          const rel = Math.abs(angleDelta(travelHdg(a), headingTo(a.pos, b.pos)));
          if (rel < 48 && !((b.phase === 'hold_short' || a.phase === 'lineup') && b.speed < 0.5 && a.path && this.clearPast(a, b, 90, 3))) { a.trafficHold = true; blockedBy.set(a.id, b.id); this.sc(a).holdReason ??= `traffic ahead: ${b.callsign}`; }
        }
      }
      // give way / follow
      if (a.giveWayTo != null) {
        const b = this.byId(a.giveWayTo);
        if (!b || isAirborne(b) || (['parked', 'arrived'] as string[]).includes(b.phase)) a.giveWayTo = null;   // (one that has reached its stand was waited for, for ever)
        else {
          const d = dist(a.pos, b.pos);
          const bRel = Math.abs(angleDelta(b.heading, headingTo(b.pos, a.pos)));
          // holds while the other is close and coming this way; the instruction stands until it has gone by (heading away),
          // so it can be given early: dropped at once when the other was still 200 m out, it left both to meet nose to nose
          if (d < 160 && bRel < 100) { a.trafficHold = true; this.sc(a).holdReason ??= `giving way to ${b.callsign}`; }
          else if ((bRel > 120 && d > 40) || d > 1500) a.giveWayTo = null;
        }
      }
      if (a.followId != null) {
        const b = this.byId(a.followId);
        if (!b || isAirborne(b) || b.phase === 'parked' || b.phase === 'arrived') a.followId = null;
        else if (dist(a.pos, b.pos) < a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 20 || b.speed < 0.5 && dist(a.pos, b.pos) < 120) { a.trafficHold = true; this.sc(a).holdReason ??= `following ${b.callsign}`; }
      }
    }
    // the exit a landing aircraft is turning off at is kept free: nobody taxis on to it nose to nose with it (it cannot stop
    // on the runway for them); one that is on it already goes on and clears it
    const offs: Array<{ b: AircraftState; pts: XY[] }> = [];
    for (const b of this.aircraft) {
      const s = this.sc(b);
      // off the runway and still on its way off it (waiting for its taxi call, say): until it has gone on from there
      if (s.exitPts && (b.phase === 'taxi' || (b.phase === 'rollout' && (s.vacated || !s.exitPlan || b.path?.kind === 'taxi')))) {
        const P = s.exitPts.pts; if (P.every(q => dist(q, b.pos) > 55)) { s.exitPts = null; continue; }
        const on: XY[] = []; if (b.path) for (let d = 0; d <= 80 && b.distAlong + d < b.path.total; d += 20) on.push(sampleAlong(b.path.pts, b.path.cum, b.distAlong + d).pos); else on.push(b.pos, advance(b.pos, b.heading, 30));
        offs.push({ b, pts: [...P, ...on] }); continue;
      }
      if (b.phase !== 'rollout') { s.exitPts = null; continue; }
      const plan = s.exitPlan, rs = b.plan.runway ? this.runwayState(b.plan.runway) : null; if (!plan || !rs || s.vacated) continue;
      if (b.path && b.path.kind !== 'taxi' && plan.at - b.distAlong > 1300) continue;
      if (s.exitPts?.node !== plan.twyNodeId) s.exitPts = { node: plan.twyNodeId, ref: rs.ref, pts: this.exitWalk(rs, plan, HOLD_LINE_M + b.perf.lengthMeters * 0.5 + 45).ids.slice(1).map(id => this.nodeXY(id)!) };
      if (s.exitPts.pts.length > 1) offs.push({ b, pts: s.exitPts.pts });
    }
    if (offs.length) for (const a of moving) {
      if (a.phase !== 'taxi' || a.trafficHold || !a.path || this.sc(a).tow || this.runwaysAt(a.pos, HOLD_LINE_M).length) continue;
      const off = (q: XY, pts: XY[]) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(q, pts[i - 1], pts[i])); return d; };
      for (const o of offs) {
        if (o.b === a || off(a.pos, o.pts) < 30) continue; let meets = false, n = 0;
        for (let d = 10; d <= 70 && a.distAlong + d < a.path.total; d += 10) { const q = sampleAlong(a.path.pts, a.path.cum, a.distAlong + d); if (off(q.pos, o.pts) < 16) { meets = true; const k = o.pts.length - 1; if (Math.abs(angleDelta(q.heading, headingTo(o.pts[k], o.pts[0]))) < 75) n++; } }
        // (only one that would go down it towards the runway; crossing its end is the ordinary rule's business)
        if (meets && n >= 2) { a.trafficHold = true; blockedBy.set(a.id, o.b.id); this.sc(a).holdReason ??= `letting ${o.b.callsign} off the runway`; break; }
      }
    }
    // Path look-ahead: crossing traffic. The cone test above only sees traffic ahead of the nose; two aircraft
    // converging on a taxiway intersection from the side (or one taxiing into a stopped aircraft round a bend) are
    // caught by sampling the next few seconds of each path. The one that would reach the meeting point later
    // gives way; an aircraft already committed (< 15 m from the point) is never stopped.
    const ahead = (x: AircraftState): { s: number; p: XY }[] => {
      const p = x.path; if (!p) return [];
      const look = Math.min(p.total - x.distAlong, brakingDistM(x.speed, TAXI_DECEL) + 35 + x.speed * KTS_TO_MPS * 3);
      const out: { s: number; p: XY }[] = [];
      for (let d = 0; d <= look; d += 7) out.push({ s: d, p: sampleAlong(p.pts, p.cum, x.distAlong + d).pos });
      return out;
    };
    const aheadOf = new Map<number, { s: number; p: XY }[]>();
    for (const a of moving) if (a.phase !== 'hold_short' && !(a.phase === 'rollout' && !this.sc(a).vacated) && !this.manualHold.has(a.id) && a.path) aheadOf.set(a.id, ahead(a));
    for (const a of moving) {
      const sa = aheadOf.get(a.id); if (!sa || a.trafficHold) continue;
      for (const b of blockers) {
        if (b === a || a.followId === b.id || aside(b, a)) continue;
        // about to move off while somebody is going by: not into its side (the cone looks ahead only, and it is abeam)
        if (a.phase === 'taxi' && a.speed < 0.5 && b.speed > 3 && b.path && dist(a.pos, b.pos) < 95 && this.movesInto(a, b)) {
          a.trafficHold = true; this.sc(a).holdReason ??= `${b.callsign} going by`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); break;
        }
        const sb = aheadOf.get(b.id);
        const gap = a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters;
        // standing still or being pushed: what counts is whether the wings and tail pass it, not how far its nose wheel is
        if (a.phase === 'taxi' && b.speed < 5 && (b.phase === 'pushback' || b.phase === 'startup' || ((b.phase === 'hold_short' || (b.phase === 'taxi' && b.giveWayTo !== a.id)) && b.speed < 0.5)) && dist(a.pos, b.pos) < 130 && !this.clearPast(a, b, Math.min(70, brakingDistM(a.speed, TAXI_DECEL) + 22), 2)) {
          a.trafficHold = true; this.sc(a).holdReason ??= `no room past ${b.callsign}`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); break;
        }
        if (b.giveWayTo === a.id) {
          // b waits for a: a goes by unless its path would actually touch b
          // (b stands still for it: passing in front of a stopped nose needs less room than two moving aircraft)
          // stuck a minute and a half even so: it is guided past, wing-walkers on both sides (the last resort before a tow)
          const sq = this.sc(a).heldSince != null && this.time - this.sc(a).heldSince! > 90 ? 0.3 : b.speed < 0.5 ? 0.45 : 0.62;
          if (sa.some(q => q.s > 5 && dist(q.p, b.pos) < gap * sq) || (b.speed < 0.5 && dist(a.pos, b.pos) < 110 && !this.clearPast(a, b, Math.min(70, brakingDistM(a.speed, TAXI_DECEL) + 22), 0.5))) {
            a.trafficHold = true; this.sc(a).holdReason ??= `no room past ${b.callsign}`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id);
            // it would really touch what is waiting for it: then the other one goes first, or they stand there for good
            if (this.sc(a).heldSince != null && this.time - this.sc(a).heldSince! > 20 && b.speed < 0.5 && b.path && (this.clearPast(b, a, 40, 0.5) || this.time - this.sc(a).heldSince! > 60)) b.giveWayTo = null;
            break;
          }
          continue;
        }
        if (!sb || b.speed < 1) {
          // stopped (or path-less) aircraft on the way: stop short of it
          const dNow = dist(a.pos, b.pos);
          const near = dNow > 8 && sa.find(q => q.s > 12 && dist(q.p, b.pos) < Math.min(dNow, gap * 0.65 + 8));
          if (near && Math.abs(angleDelta(travelHdg(a), headingTo(a.pos, b.pos))) < 120) { a.trafficHold = true; this.sc(a).holdReason ??= `${b.callsign} stopped on the way`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); break; }
          continue;
        }
        let hit: { i: number; j: number } | null = null;
        for (let i = 0; i < sa.length && !hit; i++) for (let j = 0; j < sb.length; j++) if (dist(sa[i].p, sb[j].p) < gap * 0.75 + 6) { hit = { i, j }; break; }
        if (!hit) continue;
        const tA = sa[hit.i].s / Math.max(3, a.speed), tB = sb[hit.j].s / Math.max(3, b.speed);
        const later = tA > tB + 0.5 || (Math.abs(tA - tB) <= 0.5 && a.id > b.id);
        if (later && sa[hit.i].s > 15) { a.trafficHold = true; this.sc(a).holdReason ??= `giving way to ${b.callsign} (crossing)`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); break; }
      }
    }
    // close pairs facing each other both stop; then break mutual blocks by lower id (B14). A pushback is a fixed
    // manoeuvre (it cannot be "released" into the aircraft behind it), so a pair involving one is never broken.
    for (let i = 0; i < moving.length; i++) for (let j = i + 1; j < moving.length; j++) {
      const a = moving[i], b = moving[j];
      if (aside(b, a) || aside(a, b)) continue;
      if (dist(a.pos, b.pos) >= a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 7) continue;
      const aSeesB = Math.abs(angleDelta(travelHdg(a), headingTo(a.pos, b.pos)));
      const bSeesA = Math.abs(angleDelta(travelHdg(b), headingTo(b.pos, a.pos)));
      const room = (x: AircraftState, y: AircraftState) => (y.phase === 'hold_short' || x.phase === 'lineup') && y.speed < 0.5 && !!x.path && this.clearPast(x, y, 90, 3);      // (one waiting at its hold line beside the way)
      if (aSeesB < 90 && a.phase !== 'hold_short' && b.giveWayTo !== a.id && !room(a, b)) { a.trafficHold = true; this.sc(a).holdReason ??= `nose to nose with ${b.callsign}`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); }
      if (bSeesA < 90 && b.phase !== 'hold_short' && a.giveWayTo !== b.id && !room(b, a)) { b.trafficHold = true; this.sc(b).holdReason ??= `nose to nose with ${a.callsign}`; if (!blockedBy.has(b.id)) blockedBy.set(b.id, a.id); }
    }
    // ... and while the tug works on one, the one it makes room for stays where it is
    for (const x of this.aircraft) { const t = this.sc(x).tow; if (!t || t.doneAt != null) continue; const o = this.byId(t.forId); if (o && o.phase === 'taxi' && !this.sc(o).tow && dist(o.pos, x.pos) < 220) { o.trafficHold = true; this.sc(o).holdReason ??= `the tug is moving ${x.callsign}`; blockedBy.set(o.id, x.id); } }
    // while one goes past, the other stands still for it
    for (const a of moving) { const ps = this.sc(a).pass; if (!ps || this.time >= ps.until) continue; const b = this.byId(ps.id); if (!b || isAirborne(b) || dist(a.pos, b.pos) > 190) { this.sc(a).pass = null; continue; } if ((b.phase === 'taxi' || b.phase === 'pushback') && !this.sc(b).pass) { b.trafficHold = true; this.sc(b).holdReason = `letting ${a.callsign} by`; this.sc(b).blockedById = a.id; } }
    for (const a of moving) {
      const bId = blockedBy.get(a.id); if (bId == null || this.manualHold.has(a.id)) continue;
      const b = this.byId(bId);
      if (b && blockedBy.get(bId) === a.id && a.id < bId && this.time - Math.max(this.sc(a).heldSince ?? this.time, this.sc(b).heldSince ?? this.time) > 6) {
        // both standing for each other: whichever has room by the other's real outline goes. A pushback and a taxiing
        // aircraft with room for neither: the tug pulls the pushback back in until the other one can pass
        const free = (x: AircraftState, y: AircraftState) => { x.trafficHold = false; this.sc(x).holdReason = null; this.sc(x).pass = { id: y.id, until: this.time + 30 }; blockedBy.delete(x.id); };
        const only = (x: AircraftState) => [...blockers].every(y => y === x || y === a || y === b || dist(x.pos, y.pos) > 110 || this.clearPast(x, y, 45, 2));
        const push = a.phase === 'pushback' ? a : b.phase === 'pushback' ? b : null, other = push === a ? b : a;
        const can = (x: AircraftState, y: AircraftState) => x.phase !== 'hold_short' && !this.manualHold.has(x.id) && x.giveWayTo !== y.id && this.clearPast(x, y, 170) && only(x);
        if (!this.sc(a).pull && !this.sc(b).pull) {
          if (push && can(other, push)) { free(other, push); continue; }
          if (push && can(push, other)) { free(push, other); continue; }
          if (push && other.phase === 'taxi' && this.time - Math.max(this.sc(a).heldSince ?? this.time, this.sc(b).heldSince ?? this.time) > 20) { this.sc(push).pull = { forId: other.id, since: this.time, held: false }; this.emit('info', push, `Ramp: ${push.callsign} pulled back in, ${other.callsign} to pass`); continue; }
          if (!push && can(a, b)) { free(a, b); continue; }
          if (!push && can(b, a)) { free(b, a); continue; }
        }
      }
      if (b && blockedBy.get(bId) === a.id && a.id < bId && a.phase !== 'pushback' && b.phase !== 'pushback') {
        // never release into a collision: the path ahead must clear the other aircraft
        const sa = aheadOf.get(a.id) ?? ahead(a);
        const clearance = (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.62;
        if (!sa.some(q => dist(q.p, b.pos) < clearance)) { a.trafficHold = false; this.sc(a).holdReason = null; }
      }
    }
    // the last guard: nobody rolls its next metres into somebody else's outline, whatever the rules above made of the two
    for (const a of moving) {
      if (a.trafficHold || !a.path || a.phase === 'hold_short' || (a.phase === 'rollout' && !this.sc(a).vacated && a.speed > 30) || this.manualHold.has(a.id)) continue;
      const m = Math.min(60, brakingDistM(a.speed, TAXI_DECEL) + 9);
      for (const b of blockers) {
        if (b === a || dist(a.pos, b.pos) > (a.perf.lengthMeters + b.perf.lengthMeters) * 0.62 + m) continue;
        let ok = this.clearPast(a, b, m, 0.8, true);      // (closer than that already: not a centimetre more)
        // both rolling: the next metres of one into the next metres of the other
        if (ok && a.id > b.id && b.path && !b.trafficHold && b.speed > 0.2 && b.phase !== 'hold_short' && dist(a.pos, b.pos) < (a.perf.lengthMeters + b.perf.lengthMeters) * 0.62 + 30) {
          const next = (x: AircraftState) => [4, 9, 15].map(d => { const q = sampleAlong(x.path!.pts, x.path!.cum, Math.min(x.path!.total, x.distAlong + d)); if (x.phase !== 'pushback') return outlineOf(x.perf, q.pos, q.heading); const h = (q.heading + 180) % 360; return outlineOf(x.perf, advance(q.pos, h, wheelbaseM(x)), h); });
          const A = next(a), B = next(b); if (A.some(p => B.some(q => outlineGap(p, q) < 0.3))) ok = false;
        }
        if (ok) continue;
        a.trafficHold = true; this.sc(a).holdReason ??= `no room past ${b.callsign}`; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); break;
      }
    }
    // ... nor into an aircraft standing on a stand (an A380 along a lane drawn for smaller ones): that one has been towed off
    if (this.parked.length && Math.floor(this.time) !== Math.floor(this.time - FIXED)) for (const a of moving) {
      if (a.phase !== 'taxi' || !a.path || a.speed < 1) continue;
      for (const p of [...this.parked]) {
        const perf = getPerformance(p.type); if (dist(a.pos, p.pos) > (a.perf.lengthMeters + perf.lengthMeters) * 0.62 + 45) continue;
        const P = outlineOf(perf, p.pos, p.heading);
        for (let d = 6; d <= 45; d += 6) { const q = sampleAlong(a.path.pts, a.path.cum, Math.min(a.path.total, a.distAlong + d)); if (outlineGap(outlineOf(a.perf, q.pos, q.heading), P) <= 0.2) { this.evictParked(p.standRef); break; } }
      }
    }
    // active-runway protection: ground traffic (not cleared onto it) stays clear of a runway with a landing/rolling movement
    const active = new Map<string, { a: XY; b: XY }>();
    for (const a of this.aircraft) {
      if (!a.plan.runway) continue;
      const rolling = a.phase === 'takeoff' && a.path, landing = a.phase === 'landing' && a.plan.runway && (this.distToThresholdNM(a, a.plan.runway) ?? 99) < 2;
      if (!rolling && !landing) continue;
      const rs = this.runwayState(a.plan.runway); if (!rs) continue;
      active.set(rs.ref, this.runwaySegment(rs.ref)!);
    }
    if (active.size) for (const ac of moving) {
      if (ac.phase === 'takeoff' || ac.phase === 'rollout' || ac.phase === 'lineup') continue;
      const s = this.sc(ac);
      const ahead = advance(ac.pos, ac.heading, 28);
      for (const [ref, seg] of active) {
        if (s.crossingRef === ref || s.onRunwayRef === ref) continue;
        const dNow = distToSegment(ac.pos, seg.a, seg.b), dAhead = distToSegment(ahead, seg.a, seg.b);
        // already inside the protected zone (just crossed, tail still on the strip): keep going and clear it - stopping
        // there is the one thing that must not happen
        if (dNow < HOLD_LINE_M && dAhead >= dNow - 1) continue;
        // (its own hold line for that runway is close ahead: it goes on up to it and stops there)
        { const h = ac.path?.holds?.[0]; if (h && this.refOf(h.runway) === ref && h.at - ac.distAlong > 0 && h.at - ac.distAlong < 130 && !ac.holdReleased) continue; }
        if (dNow < HOLD_LINE_M || dAhead < HOLD_LINE_M) { if (!(ac.holdReleased && ac.path?.holds?.[0] && this.refOf(ac.path.holds[0].runway) === ref)) { ac.trafficHold = true; this.sc(ac).holdReason ??= `runway ${ref} active`; } break; }
      }
    }
    for (const a of moving) if (a.trafficHold && a.speed < 0.5 && a.phase !== 'hold_short') a.delay.groundStoppedS += FIXED;
    // a crew stuck in a standoff on a frequency the player works says so, once per blocker (the AI ground re-routes its own)
    for (const a of moving) {
      const s = this.sc(a);
      if (!a.trafficHold || s.heldSince == null || this.time - s.heldSince < 45 || this.manualHold.has(a.id)) continue;
      const owner = POSITION_OWNER[a.onFrequency]; if (owner == null || this.aiOn(owner)) continue;
      const adv = this.groundAdvice(a); if (!adv || adv.kind === 'wait') continue;
      const b = s.blockedById != null ? this.byId(s.blockedById) : undefined; if (!b || s.stuckSaid === b.id) continue;
      s.stuckSaid = b.id;
      const head = Math.abs(angleDelta(a.heading, b.heading)) > 120;
      this.raiseRequest(a, 'concern', b.callsign, `${this.telephony(a.callsign)}, ${head ? `we're nose to nose with ${this.telephony(b.callsign)}` : `we're stuck behind ${this.telephony(b.callsign)}`}, request a way round.`);
    }
    // how long each aircraft has been held by traffic and by whom (the AI ground breaks deadlocks with a re-route)
    for (const a of moving) { const s = this.sc(a); if (a.trafficHold) { s.heldSince ??= this.time; s.blockedById = blockedBy.get(a.id) ?? s.blockedById; } else { s.heldSince = null; s.blockedById = null; } }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Transitions (state machine that needs engine data)
  // ═══════════════════════════════════════════════════════════════════════════
  private handleTransitions() {
    for (const a of this.aircraft) {
      const s = this.sc(a);
      switch (a.phase) {
        case 'parked': break;
        case 'startup': this.trStartup(a, s); break;
        case 'pushback': this.trPushback(a, s); break;
        case 'taxi': case 'hold_short': this.trTaxi(a, s); break;
        case 'lineup': this.trLineup(a, s); break;
        case 'takeoff': this.trTakeoff(a, s); break;
        case 'landing': this.trLanding(a, s); break;
        case 'rollout': this.trRollout(a, s); break;
        case 'go_around': this.trGoAround(a, s); break;
        case 'arrived': break;
        default: this.trAirborne(a, s); break;
      }
      // pushed back with somebody waiting for the lane behind it: the crew hurries the start (it stood there four minutes and more)
      if (a.phase === 'startup' && a.pushback.stage === 'complete' && !a.startup.enginesStable && a.startup.readyAt != null && a.startup.readyAt > this.time + 20 && this.aircraft.some(x => x !== a && x.trafficHold && this.sc(x).blockedById === a.id && this.sc(x).heldSince != null && this.time - this.sc(x).heldSince! > 25)) a.startup.readyAt = this.time + 20;
      // engines become stable (any ground phase)
      if (!a.startup.enginesStable && a.startup.readyAt != null && this.time >= a.startup.readyAt) {
        a.startup.enginesStable = true;
        this.emit('startup', a, `${a.callsign} engines stable`);
        if (a.phase === 'startup' && (a.pushback.stage === 'complete' || a.pushback.stage === 'none') && !a.requests.length) { s.nextRequestAt = this.time + rf(5, 20); s.nextRequestKind = 'taxi'; }
      }
      // at the end of a step-by-step clearance: the pilot calls for the next step
      if (s.limitSay && a.phase === 'hold_short' && a.speed < 0.5 && a.path?.holds?.[0] && !a.path.holds[0].runway && !a.holdReleased && !a.requests.some(r => r.answeredAt == null) && !a.pendingCmds.length) {
        const said = s.limitSay; s.limitSay = null;
        if (!this.aiOn('ground')) this.raiseRequest(a, a.plan.kind === 'arrival' ? 'taxi_in' : 'taxi', null, `${this.telephony(a.callsign)}, ${said}, request further taxi.`);
      }
      // frequency change completes
      if (s.handoffAt != null && this.time >= s.handoffAt && s.handoffTo) this.completeHandoff(a, s);
      // established on the ILS: approach -> tower handoff at 10 NM
      // (not with an instruction still pending: a break-off from the approach went out on the tower frequency nobody vectors)
      if (a.ilsCaptured && this.settings.autoHandoff && (a.onFrequency === 'approach' || a.onFrequency === 'departure') && a.handedTo == null && a.assignedRunway && !a.pendingCmds.length) {
        const d = this.distToThresholdNM(a, a.assignedRunway);
        if (d != null && d <= TOWER_HANDOFF_NM) this.execHandoff(a, 'tower');
      }
    }
    this.retire();
  }
  private completeHandoff(a: AircraftState, s: Scratch) {
    const from = a.onFrequency, to = s.handoffTo!;
    a.onFrequency = to; a.handedTo = null; a.delay.handoffAt = this.time;
    s.handoffAt = null; s.handoffTo = null;
    this.emit('handoff', a, `${a.callsign} contact ${this.unitName(to)} ${this.frequencies[to] ?? ''}`.trim(), { type: 'handoff', from, to });
    if (to === 'external') {
      if (isAirborne(a)) { a.phase = 'departed'; this.emit('departed', a, `${a.callsign} handed off, leaving the TMA`); s.despawnAt = this.time + 90; }
      return;
    }
    // First call on the new frequency: a departure at the holding point checks in "ready for departure"; everyone else "with you".
    // A request already scheduled for the new frequency (e.g. taxi-in after vacating) IS the first call - never clobber it with "with you".
    const atDepHold = a.phase === 'hold_short' && !!a.holdShortNode && !!a.plan.runway && this.isHoldNodeForRunway(a.holdShortNode, a.plan.runway);
    if (s.nextRequestKind && s.nextRequestKind !== 'with_you') {
      s.nextRequestAt = s.nextRequestKind === 'ready' && to === 'tower' ? this.time + 4 : Math.max(s.nextRequestAt ?? 0, this.time + 4);
      return;
    }
    const open = a.requests[0];
    if (open && open.answeredAt == null && open.kind !== 'with_you') return;
    s.nextRequestAt = this.time + 4; s.nextRequestKind = atDepHold && to === 'tower' ? 'ready' : 'with_you';
  }
  private trStartup(a: AircraftState, s: Scratch) { void a; void s; }
  private trPushback(a: AircraftState, s: Scratch) {
    const p = a.pushback;
    switch (p.stage) {
      case 'tug_attach':
        if (this.time >= p.stageUntil) { p.stage = 'pushing'; this.emit('pushback', a, `${a.callsign} pushing back`); }
        break;
      case 'pushing':
        if (a.path && a.distAlong >= a.path.total - 0.6 && a.speed < 0.5) { p.stage = 'tug_disconnect'; p.stageUntil = this.time + rf(20, 30); this.emit('pushback', a, `${a.callsign} pushback complete, tug disconnecting`); }
        break;
      case 'tug_disconnect':
        if (this.time >= p.stageUntil) {
          p.stage = 'complete'; p.tugId = null;
          a.path = null; a.distAlong = 0; a.speed = 0; a.phase = 'startup';
          this.emit('pushback', a, `${a.callsign} tug disconnected`);
          this.emit('phase', a, `${a.callsign} -> startup`);
          if (a.startup.enginesStable) { s.nextRequestAt = this.time + rf(5, 20); s.nextRequestKind = 'taxi'; }
        }
        break;
      default: break;
    }
  }
  private trTaxi(a: AircraftState, s: Scratch) {
    const p = a.path;
    // Crossing / runway strip bookkeeping
    // a crossing that never started is void once the aircraft holds short of that runway again (a new route after a
    // re-route / runway change ends at its hold line): left booked it blocked the runway for good - Sydney's 16R
    // took no landings for eight minutes behind a departure "crossing" it from its own holding point
    if (s.crossingRef && !s.crossingEntered && a.phase === 'hold_short' && a.holdShortRunway && this.refOf(a.holdShortRunway) === s.crossingRef && !a.holdReleased) {
      const ref = s.crossingRef; s.crossingRef = null; s.crossingMinD = Infinity; this.removeOccupant(ref, a.id); s.onRunwayRef = null;
    }
    if (s.crossingRef) {
      // Vacated only after the strip was actually entered and left again (addOccupant sets onRunwayRef at clearance time,
      // so it cannot be used as the "entered" signal), or when the route turned away without ever entering.
      const d = this.distToRunway(a.pos, s.crossingRef);
      if (d < STRIP_HALF_M) { s.onRunwayRef = s.crossingRef; s.crossingEntered = true; }
      s.crossingMinD = Math.min(s.crossingMinD, d);
      const clearM = HOLD_LINE_M - 15 + a.perf.lengthMeters * 0.5;
      if ((s.crossingEntered && d > clearM) || (!s.crossingEntered && d > s.crossingMinD + 60 && d > HOLD_LINE_M + 30)) {
        const ref = s.crossingRef; s.crossingRef = null; s.crossingEntered = false; s.crossingMinD = Infinity; this.removeOccupant(ref, a.id); s.onRunwayRef = null;
        this.emit('runway_vacated', a, `${a.callsign} runway ${ref} vacated`);
      }
    }
    if (a.phase === 'hold_short') {
      a.delay.holdShortWaitS += FIXED;
      if (s.stoppedSince == null) {
        s.stoppedSince = this.time;
        const h = p?.holds?.[0];
        if (h && h.runway) {
          if (h.isDepartureEntry && a.plan.kind === 'departure') {
            this.addScore('HOLD_POINT', a.callsign, null, h.runway);
            if (a.delay.holdShortAt == null) a.delay.holdShortAt = this.time;
            if (a.onFrequency === 'ground' && this.settings.autoHandoff && a.handedTo == null) { s.handoffTo = 'tower'; s.handoffAt = this.time + rf(5, 15); a.handedTo = 'tower'; }
            s.nextRequestAt = this.time + (a.onFrequency === 'tower' ? rf(3, 8) : 25); s.nextRequestKind = 'ready';
          } else { s.nextRequestAt = this.time + rf(2, 5); s.nextRequestKind = 'cross'; }
        }
      }
      // ready-for-departure once on tower (C1: engines stable >= 60 s, >= 45 s since stop)
      return;
    }
    if (s.stoppedSince != null && a.speed > 1) s.stoppedSince = null;
    // End of the taxi path
    if (p && a.distAlong >= p.total - 0.6 && a.speed < 0.4 && !(p.holds && p.holds.length)) {
      const dest = s.taxiDest;
      if (dest?.kind === 'stand') {
        const g = this.gateByRef(dest.ref);
        a.path = null; a.distAlong = 0; a.speed = 0; a.phase = 'arrived';
        if (g) this.occupyStand(g, a);
        a.delay.parkedAt = this.time;
        this.emit('arrived', a, `${a.callsign} on stand ${dest.ref}`);
        this.emit('phase', a, `${a.callsign} -> arrived`);
        if (a.plan.kind === 'arrival') { this.addScore('PARKED', a.callsign, null, null, `stand ${dest.ref}`); this.recordDelay(a); if (this.settings.despawnParked) s.despawnAt = this.time + rf(120, 300); }
        else { s.despawnAt = this.settings.despawnParked ? this.time + rf(600, 1200) : null; }
        if (a.emergency && a.emergency.status !== 'resolved') { a.emergency.stoppedAt = a.emergency.stoppedAt ?? this.time; if (a.emergency.type === 'medical') this.resolveEmergency(a, 'patient handed over'); }
        s.taxiDest = null;
      } else if (dest && dest.kind !== 'runway') {
        a.path = null; a.speed = 0; s.taxiDest = null;
        this.emit('info', a, `${a.callsign} holding at ${dest.label}`, undefined, 'PILOT');
      } else if (!dest) {
        a.path = null; a.speed = 0;
        if (a.plan.kind === 'arrival' && !a.requests.length && s.vacated) { s.nextRequestAt = this.time + rf(3, 8); s.nextRequestKind = 'taxi_in'; }
      }
    }
  }
  private trLineup(a: AircraftState, s: Scratch) {
    if (s.luawAt != null && a.speed >= 0.5) s.luawAt = this.time;   // the wait counts from the moment the aircraft stops in position
    if (s.luawAt != null && a.speed < 0.5 && this.time - s.luawAt > LUAW_QUERY_S && !a.requests.length && !a.rto && !a.pendingCmds.some(c => c.kind === 'takeoff')) {
      this.raiseRequest(a, 'ready', null, `${this.telephony(a.callsign)}, holding in position runway ${a.plan.runway}, are we cleared for takeoff?`);
      s.luawAt = this.time;
    }
    if (a.rto && s.rtoRecoverAt != null && this.time >= s.rtoRecoverAt && !a.requests.length) {
      const hi = a.rto.speedKt >= 80;
      this.raiseRequest(a, hi ? 'return_to_stand' : 'ready', null, hi ? `${this.telephony(a.callsign)}, request taxi back to the stand for a brake check.` : `${this.telephony(a.callsign)}, brakes cooled, ready for departure.`);
      s.rtoRecoverAt = null;
    }
  }
  private trTakeoff(a: AircraftState, s: Scratch) {
    if (a.path) {
      if (!a.takeoffCleared && s.rollAt != null && this.time >= s.rollAt && !a.rto) { a.takeoffCleared = true; s.rollAt = null; this.emit('info', a, `${a.callsign} rolling runway ${a.plan.runway}`, undefined, 'PILOT'); }
      if (a.rto && a.speed < 0.3) {
        // Rejected takeoff complete: stopped on the runway, back to lineup (brake cooling / taxi back)
        a.phase = 'lineup'; a.path = null; a.distAlong = 0; a.takeoffCleared = false;
        const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
        if (rs) this.addOccupant(rs.name, a, 'lineup');
        s.luawAt = this.time;
        this.emit('info', a, `${a.callsign} stopped on runway ${a.plan.runway} after the rejected takeoff`);
        // high-speed reject: 30 min brake cooling + inspection - the pilot asks to go back to the stand right away
        if (a.rto.speedKt >= 80) this.raiseRequest(a, 'return_to_stand', null, `${this.telephony(a.callsign)}, request taxi back to the stand for a brake check.`);
      }
      return;
    }
    // Airborne (path cleared by the physics at rotation): one-off bookkeeping
    if (s.onRunwayRef) {
      const ref = s.onRunwayRef;
      const rs = a.plan.runway ? this.runwayState(a.plan.runway) : this.bothEnds(ref)[0];
      this.removeOccupant(ref, a.id);
      if (rs) { this.setWakeTimer(rs.name, a); for (const r of this.bothEnds(rs.ref)) if (r.takeoffClearance === a.callsign) r.takeoffClearance = null; }
      this.addScore('MOVEMENT', a.callsign, null, a.plan.runway ?? null, 'takeoff');
      this.recordMovement(a);
      this.recordDelay(a);
      a.onFrequency = a.onFrequency === 'ground' ? 'tower' : a.onFrequency;
    }
    if (this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null && a.altitude >= a.clearance.autoHandoffAlt) this.execHandoff(a, 'departure');
  }
  private trAirborne(a: AircraftState, s: Scratch) {
    // A departure stays a departure until it is set up for an approach (emergency return, "request return"): from
    // then on it is handled like an arrival (landing path, tower handoff, landing clearance).
    if (a.plan.kind === 'departure' && !a.ilsArmed && a.navMode !== 'visual') {
      if (this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null && a.altitude >= a.clearance.autoHandoffAlt) this.execHandoff(a, 'departure');
      // level below cruise for > 60 s -> request higher
      if (Math.abs(a.altitude - a.targetAltitude) < 60 && a.targetAltitude < (a.plan.cruiseAlt ?? 13000)) {
        if (s.lastLevelAt === 0) s.lastLevelAt = this.time;
        else if (this.time - s.lastLevelAt > 60 && !a.requests.length && a.onFrequency !== 'external' && (s.nextRequestAt == null || s.nextRequestAt < this.time)) { this.raiseRequest(a, 'higher', Math.min(a.targetAltitude + 2000, a.plan.cruiseAlt ?? 13000)); s.lastLevelAt = this.time + 30; }
        // with the centre: cleared on up to the cruising level (a departure released level would otherwise leave the TMA at an arrival entry level)
        else if (this.time - s.lastLevelAt > 20 && a.onFrequency === 'external' && !this.altitudeBlocked(a, a.plan.cruiseAlt ?? 13000)) { this.execAltitude(a, a.plan.cruiseAlt ?? 13000, false); s.lastLevelAt = 0; }
      } else s.lastLevelAt = 0;
      return;
    }
    // Arrival: build the landing path once established inside 8 NM (B1 fixed: the runway check happens at the forced-GA points, not here)
    if (a.gsCaptured && a.ilsCaptured && a.assignedRunway) {
      const r = this.ilsFor(a.assignedRunway); if (!r) return;
      const along = distAlongFwd(a.pos, r);
      if (along < LANDING_PHASE_NM * NM_TO_M && along > 100 && Math.abs(angleDelta(a.heading, r.rwdHdg)) < 25) {
        const rs = this.runwayState(a.assignedRunway)!; const osm = this.runwayByEnd(a.assignedRunway)!;
        const thrXY = r.thrXY;
        const farXY = advance(this.endXY(osm.other), rs.headingTrue, 300);
        // path: current position -> point 1.5 NM out on the centreline -> threshold -> far end (keeps the last miles straight)
        const onLine = advance(thrXY, (rs.headingTrue + 180) % 360, Math.min(along - 200, 1.5 * NM_TO_M));
        const raw = along > 1.8 * NM_TO_M ? [{ ...a.pos }, onLine, thrXY, farXY] : [{ ...a.pos }, thrXY, farXY];
        a.path = this.buildPath(raw, 'approach');
        a.thresholdDist = projectOntoPath(a.path.pts, a.path.cum, thrXY).at;
        a.distAlong = 0; a.holdReleased = true;
        a.plan.runway = a.assignedRunway;
        a.phase = 'landing';
        this.emit('phase', a, `${a.callsign} -> landing ${a.assignedRunway}`);
        s.queried4NM = false; s.crosswindChecked = false;
      }
    }
    // Arrival at spawn altitude with no descent for 3 min -> request lower
    if (a.plan.kind === 'arrival' && !a.ilsArmed && a.cmdAltitude != null && a.cmdAltitude >= 7000 && this.time - a.spawnedAt > 180 && !a.requests.length && (s.nextRequestAt == null || s.nextRequestAt < this.time) && s.lastLevelAt === 0) { this.raiseRequest(a, 'lower', 4000); s.lastLevelAt = this.time; }
    // (once per flight: told to expect vectors, a crew does not ask again every few minutes - the AI's "unable" to each
    // repeat filled the log)
    if (a.plan.kind === 'arrival' && a.navMode === 'heading' && !a.ilsArmed && !s.directAsked && this.time - a.spawnedAt > 360 && !a.requests.length && s.lastLevelAt > 0 && this.time - s.lastLevelAt > 150 && this.beacons.length) {
      s.directAsked = true;
      const near = this.beacons.reduce((b, x) => (dist(a.pos, x) < dist(a.pos, b) ? x : b));
      this.raiseRequest(a, 'direct', near.id); s.lastLevelAt = this.time + 120;
    }
  }
  private trLanding(a: AircraftState, s: Scratch) {
    const rw = a.plan.runway ?? a.assignedRunway; if (!rw) return;
    const rs = this.runwayState(rw); if (!rs) return;
    const d = distToThresholdFromPathNM(a) ?? 99;
    // 1000 ft: crosswind / gust go-around roll (03 §D4)
    if (!s.crosswindChecked && a.altitude <= 1000) {
      s.crosswindChecked = true;
      const pX = this.safe('weather', () => this.weather.crosswindGoAroundP(a.perf.weightClass, rs.headingTrue), 0);
      const pG = this.safe('weather', () => this.weather.gustGoAroundP(), 0);
      const p = Math.max(pX, pG);
      if (p > 0 && this.wxRng() < p) { this.initiateGoAround(a, pX >= pG ? 'crosswind out of limits' : 'gusts', false); return; }
    }
    // 4 NM without clearance: pilot query (suppressed by "continue approach")
    if (!a.landingCleared && !s.continueApproach && !s.queried4NM && d <= CONFIRM_CLEARED_NM) { s.queried4NM = true; this.raiseRequest(a, 'confirm_cleared', Math.round(d)); }
    // Forced go-around table (03 §B1 + brief)
    const noClrNM = s.continueApproach ? 1.0 : FORCED_GA.noClearanceNM;
    if (!a.landingCleared && !s.awaitClearance && (d <= noClrNM || a.altitude <= FORCED_GA.noClearanceFt)) { this.initiateGoAround(a, 'no landing clearance', true, 'GA_UNHANDLED'); return; }
    if (rs.status === 'closed' && d <= FORCED_GA.closedNM && !a.emergency) { this.initiateGoAround(a, `runway ${rs.name} closed`, true, 'CLOSED_RUNWAY_CLEARANCE'); return; }
    const occ = rs.occupiedBy.filter(o => o.id !== a.id);
    const blocking = occ.find(o => o.kind === 'lineup' || o.kind === 'takeoff' || o.kind === 'stopped' || o.kind === 'inspection' || o.kind === 'backtrack' || o.kind === 'vehicle');
    if (blocking && d <= FORCED_GA.occupiedNM) { this.initiateGoAround(a, `runway occupied by ${blocking.callsign}`, true, 'RWY_INCURSION', blocking.callsign); return; }
    const crossing = occ.find(o => o.kind === 'crossing');
    if (crossing && d <= FORCED_GA.crossingNM) { this.initiateGoAround(a, `${crossing.callsign} crossing the runway`, true, 'RWY_INCURSION', crossing.callsign); return; }
    const preceding = occ.find(o => o.kind === 'rollout' || o.kind === 'landing');
    if (preceding && d <= FORCED_GA.precedingNM) { this.initiateGoAround(a, `${preceding.callsign} still on the runway`, true, 'RWY_INCURSION', preceding.callsign); return; }
    const veh = this.safe('fleet', () => this.fleet.onRunway(rs.ref)[0] ?? null, null);
    if (veh && d <= FORCED_GA.occupiedNM) { this.initiateGoAround(a, `${veh.callsign} on the runway`, true, 'RWY_INCURSION', veh.id); return; }
    // Landing occupant from 2 NM (1 NM medium; 2 NM H/S per 03 §2.5)
    if (d <= (a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 2 : 1) && !occ.length && !rs.occupiedBy.some(o => o.id === a.id)) this.addOccupant(rs.name, a, 'landing');
    // Tower handoff safety net (landing without being on tower)
    if (this.settings.autoHandoff && a.onFrequency === 'approach' && a.handedTo == null) this.execHandoff(a, 'tower');
  }
  private trRollout(a: AircraftState, s: Scratch) {
    const rw = a.plan.runway ?? a.assignedRunway; const rs = rw ? this.runwayState(rw) : undefined;
    if (!rs) return;
    if (!s.touchdownDone) { s.touchdownDone = true; this.onTouchdown(a, s, rs); }
    if (a.path && a.path.kind !== 'taxi') {
      // On the runway path: exit when reaching the planned exit (or stop for an emergency / no exit)
      const plan = s.exitPlan;
      if (plan && a.distAlong >= plan.at - 1 && a.speed <= plan.speedKt + 3) {
        // traffic moved onto the exit since touchdown (an aircraft pulled up to the hold line there): roll on to the next one
        if (!(a.exitTaxiway && plan.taxiway === a.exitTaxiway) && this.exitBlocked(a, plan.twyNodeId, this.nodeXY(plan.runwayNodeId) ?? a.pos, rs, plan.runwayNodeId)) {
          const next = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, null, false);
          if (next && next.twyNodeId !== plan.twyNodeId) {
            s.exitPlan = next; a.path.holdAt = next.at; a.cmdIas = next.speedKt;
            this.emit('info', a, `${a.callsign}: ${plan.taxiway ?? 'the exit'} is blocked, rolling to ${next.taxiway ?? 'the next one'}`, undefined, 'PILOT');
            return;
          }
        }
        this.exitViaTaxiway(a, rs, plan, false);
        return;
      }
      if (!plan && a.speed < 0.3) {
        // Stopped on the runway (emergency / no exit found / LAHSO)
        // (the emergencies system may already have marked the stop from the motion - below 1 kt - a tick earlier;
        // the closure, the occupant and the checklist item are booked here either way)
        if (a.emergency && a.emergency.stopOnRunway && a.emergency.status !== 'resolved' && a.emergency.checklist.runway_closed == null) {
          if (a.emergency.stoppedAt == null) {
            a.emergency.stoppedAt = this.time; a.emergency.status = 'stopped';
            this.emit('emergency', a, `${a.callsign} stopped on runway ${rs.name}`, { type: 'emergency', emergency: a.emergency, change: 'stopped' }, 'SYS');
          }
          this.addOccupant(rs.name, a, 'stopped');
          if (a.emergency.closureMin > 0 && rs.status !== 'closed') this.setRunwayStatus(rs.name, 'closed', `${a.callsign} disabled on the runway`);
          for (const r of this.bothEnds(rs.ref)) r.statusUntil = this.time + a.emergency.closureMin * 60;
          this.checklist(a, 'runway_closed');
        } else if (!a.emergency && !s.vacated && !a.requests.some(r => r.answeredAt == null && r.kind === 'taxi_in') && !this.pendingEvents.some(e => e.id === a.id && e.type === 'info')) {
          this.emit('info', a, `${a.callsign} stopped on the runway, request taxi`, undefined, 'PILOT');
          this.raiseRequest(a, 'taxi_in');
        }
      }
      return;
    }
    // On the exit path
    if (!s.vacated) {
      const clearM = HOLD_LINE_M - 15 + a.perf.lengthMeters * 0.5;
      if (this.distToRunway(a.pos, rs.ref) > clearM) this.onVacated(a, s, rs);
    }
    if (a.path && a.distAlong >= a.path.total - 0.6 && a.speed < 0.4) {
      a.path = null; a.distAlong = 0; a.speed = 0; a.phase = 'taxi';
      this.emit('phase', a, `${a.callsign} -> taxi`);
      if (!s.vacated) this.onVacated(a, s, rs);
      if (this.aiOn('ground') && a.plan.gateRef) { this.execTaxi(a, { kind: 'stand', ref: a.plan.gateRef }, [], true, null, [], false); this.emit('info', a, `${a.callsign} auto taxi to stand ${a.plan.gateRef}`, undefined, 'AI'); }
      else { s.nextRequestAt = Math.max(this.time + rf(2, 6), s.handoffAt != null ? s.handoffAt + 4 : 0); s.nextRequestKind = 'taxi_in'; }
    }
  }
  private onTouchdown(a: AircraftState, s: Scratch, rs: RunwayState) {
    for (const r of this.bothEnds(rs.ref)) { r.lastArrival = { callsign: a.callsign, at: this.time, cat: a.wakeCategory }; }
    this.setLandingClearance(rs, a.callsign, false);
    this.addOccupant(rs.name, a, 'rollout');
    a.landingCleared = false;
    // requests that belonged to the flight (direct, higher / lower, vectors) are moot on the ground
    a.requests = a.requests.filter(r => r.answeredAt != null || !['direct', 'higher', 'lower', 'further', 'confirm_cleared', 'going_around'].includes(r.kind));
    let closure = 0;
    if (a.emergency && a.emergency.status !== 'resolved') {
      closure = this.safe('emergencies', () => handleLanded(this.emergencyView(), a), 0);
      if (!this.sys.emergencies) { const spec = EMERGENCY_CATALOGUE[a.emergency.type]; a.emergency.landedAt = this.time; a.emergency.status = 'landed'; a.emergency.stopOnRunway = a.emergency.stopOnRunway || chance(spec.stopOnRunwayP); closure = a.emergency.stopOnRunway ? Math.round(rf(spec.closureMin[0], spec.closureMin[1])) : 0; }
      a.emergency.closureMin = closure;
      this.emit('emergency', a, `${a.callsign} landed runway ${rs.name}${a.emergency.stopOnRunway ? ', stopping on the runway' : ''}`, { type: 'emergency', emergency: a.emergency, change: 'landed' }, 'SYS');
    }
    const stopOnRunway = !!a.emergency && a.emergency.stopOnRunway && a.emergency.status !== 'resolved';
    if (stopOnRunway) {
      s.exitPlan = null;
      if (a.path) { a.path.holdAt = Math.min(a.path.total, a.distAlong + this.brakingM(a.speed, 2.5) + 40); }
      a.cmdIas = null;
      return;
    }
    const plan = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, a.exitTaxiway, false) ?? (a.exitTaxiway ? this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, null, false) : null);
    s.exitPlan = plan;
    if (a.path) a.path.holdAt = plan ? plan.at : undefined;
    a.cmdIas = plan ? plan.speedKt : null;
    if (a.exitTaxiway && (!plan || plan.taxiway !== a.exitTaxiway)) this.emit('info', a, `${a.callsign}: unable ${a.exitTaxiway}, we'll take ${plan?.taxiway ?? 'the end'}`, undefined, 'PILOT');
  }
  private onVacated(a: AircraftState, s: Scratch, rs: RunwayState) {
    s.vacated = true;
    this.removeOccupant(rs.ref, a.id); s.onRunwayRef = null;
    a.delay.vacatedAt = this.time;
    this.emit('runway_vacated', a, `${a.callsign} runway ${rs.name} vacated`);
    if (a.delay.touchdownAt != null) {
      // a landing (not a departure that vacated after a cancelled line-up / rejected takeoff)
      this.addScore('LANDED', a.callsign, null, rs.name, `runway occupancy ${Math.round(this.time - a.delay.touchdownAt)} s`);
      this.recordMovement(a);
    }
    if (this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null) { s.handoffTo = 'ground'; s.handoffAt = this.time + rf(5, 15); a.handedTo = 'ground'; }
    if (a.lahsoHoldShortOf) { a.lahsoHoldShortOf = null; }
  }
  private trGoAround(a: AircraftState, s: Scratch) {
    if (a.altitude >= this.missedApproachAltFt - 100 && this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null) this.execHandoff(a, 'approach');
    // 30 s into the missed approach the crew asks for vectors as a proper request (it shows in the request queue and
    // is answered by any heading / direct / ILS instruction), unless the going-around call is still open or already answered with vectors
    const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
    const stillRunwayHdg = !rs || Math.abs(angleDelta(a.targetHeading, rs.headingTrue)) < 1;
    if (s.gaAt != null && this.time - s.gaAt > 30 && !s.overshootSaid && stillRunwayHdg && !a.requests.some(r => r.answeredAt == null)) { s.overshootSaid = true; this.raiseRequest(a, 'further', null, `${this.telephony(a.callsign)}, flying runway heading, climbing ${this.missedApproachAltFt}, request further instructions.`); }
  }

  /** Pick the runway exit: first high-speed exit reachable at <= 30 kt (M) / 25 kt (H,S), else the next 90-degree exit at <= 15 kt. */
  private chooseExit(a: AircraftState, ref: string, hdg: number, speedKt: number, wantTaxiway: string | null, fromStandstill: boolean): ExitPlan | null {
    const rs = this.bothEnds(ref).find(r => Math.abs(angleDelta(r.headingTrue, hdg)) < 5) ?? this.bothEnds(ref)[0];
    const thr = this.thresholdXY(rs.name)!;
    const alongNow = alongTrack(a.pos, thr, hdg);
    const decel = 2.0 * SURFACE_FACTOR[this.wx().runwayCondition] / (a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.rolloutFactor : 1);
    const hsSpeed = a.perf.weightClass === 'L' ? 35 : a.perf.weightClass === 'M' ? 30 : 25;
    const cands: Array<ExitPlan & { along: number; hs: boolean; clear: boolean }> = [];
    // normal braking first; when no exit is reachable that way (a short runway, a fast touchdown) the crew brakes
    // firmly (up to 3 m/s^2) for the last one rather than rolling off the end
    // (strict first: also skip an exit that taxiing traffic is heading for; with none left, any exit nobody stands on -
    // at a mixed-mode runway every exit has a departure on its way to it, and the arrival stopped on the runway)
    for (const strict of [true, false]) {
    if (!strict && cands.length) break;
    for (const firm of [1, 1.5]) {
    if (firm > 1 && (cands.length || fromStandstill)) break;
    for (const ex of this.runwayExits(ref)) {
      const along = alongTrack(ex.xy, thr, hdg);
      const margin = fromStandstill ? 10 : 40;
      if (along < alongNow + margin) continue;
      const twy = this.nodeXY(ex.twyNodeId)!;
      const angle = Math.abs(angleDelta(hdg, headingTo(ex.xy, twy)));
      if (angle > 125) continue; // would need a backtrack
      // an exit blocked by ground traffic (an aircraft holding short of the runway on that taxiway, or a vehicle / aircraft
      // sitting on it) is skipped unless the controller asked for it by name: taking it parks the arrival nose-to-nose on the strip
      if (!(wantTaxiway && (ex.taxiway === wantTaxiway)) && this.exitBlocked(a, ex.twyNodeId, ex.xy, rs, ex.runwayNodeId, strict)) continue;
      const clear = this.exitWalk(rs, { runwayNodeId: ex.runwayNodeId, twyNodeId: ex.twyNodeId, at: 0, speedKt: 0, taxiway: ex.taxiway, angleDeg: angle }, HOLD_LINE_M + a.perf.lengthMeters * 0.5 + 15).clear;
      const hs = angle >= 8 && angle <= 55;
      const exitSpeed = hs ? hsSpeed : 15;
      const need = fromStandstill ? 0 : this.brakingM(speedKt, decel * firm) - this.brakingM(exitSpeed, decel * firm);
      if (along - alongNow - margin < need) continue;
      const at = a.path ? projectOntoPath(a.path.pts, a.path.cum, ex.xy, a.distAlong).at : along - alongNow;
      cands.push({ runwayNodeId: ex.runwayNodeId, twyNodeId: ex.twyNodeId, at, speedKt: exitSpeed, taxiway: ex.taxiway, angleDeg: angle, along, hs, clear });
    }
    }
    }
    cands.sort((x, y) => x.along - y.along);
    if (!cands.length) return null;
    // an exit taxiway that only leads back onto the strip (data quirks at some fields) is skipped when there are others
    if (cands.some(c => c.clear) && !cands.every(c => c.clear)) { const keep = cands.filter(c => c.clear || (wantTaxiway && c.taxiway === wantTaxiway)); cands.length = 0; cands.push(...keep); }
    if (wantTaxiway) {
      // a taxiway that crosses the runway is an exit on both sides: take the one on the stand's side (the other one
      // turns the arrival away from its gate, and the taxi in has to cross the next runway)
      const ws = cands.filter(c => c.taxiway === wantTaxiway || this.air.taxiwayNodes.get(wantTaxiway)?.includes(c.twyNodeId));
      const g = a.reservedStand ? this.gateByRef(a.reservedStand) : a.plan.gateRef ? this.gateByRef(a.plan.gateRef) : undefined;
      const gx = g ? this.nodeXY(g.nodeId) : null;
      const w = (gx && ws.find(c => (crossTrack(this.nodeXY(c.twyNodeId)!, thr, hdg) > 0) === (crossTrack(gx, thr, hdg) > 0))) || ws[0];
      if (w) return strip(w);
      if (!fromStandstill) return null;
    }
    if (a.exitDir && !wantTaxiway) {
      const side = cands.find(c => (crossTrack(this.nodeXY(c.twyNodeId)!, thr, hdg) > 0 ? 'R' : 'L') === a.exitDir);
      if (side) return strip(side);
    }
    // from a standstill (cancelled line-up) the nearest exit is the right one; on a rollout prefer the first high-speed
    // exit - on the side of the runway the stand is on, so the taxi in does not cross the landing runway again
    if (!fromStandstill) {
      const g = a.reservedStand ? this.gateByRef(a.reservedStand) : a.plan.gateRef ? this.gateByRef(a.plan.gateRef) : undefined;
      const gx = g ? this.nodeXY(g.nodeId) : null;
      if (gx && Math.abs(crossTrack(gx, thr, hdg)) > 150) {
        const standSide = crossTrack(gx, thr, hdg) > 0 ? 'R' : 'L';
        const mine = cands.filter(c => (crossTrack(this.nodeXY(c.twyNodeId)!, thr, hdg) > 0 ? 'R' : 'L') === standSide);
        if (mine.length) return strip(mine.find(c => c.hs) ?? mine[0]);
      }
    }
    const first = fromStandstill ? cands[0] : (cands.find(c => c.hs) ?? cands[0]);
    return strip(first);
    function strip(c: ExitPlan & { along: number; hs: boolean; clear: boolean }): ExitPlan { return { runwayNodeId: c.runwayNodeId, twyNodeId: c.twyNodeId, at: c.at, speedKt: c.speedKt, taxiway: c.taxiway, angleDeg: c.angleDeg }; }
  }
  /** Ground traffic sitting on / holding at the first 150 m of an exit taxiway (measured from the runway edge node). */
  private exitBlocked(a: AircraftState, twyNodeId: string, rwyXY: XY, rs?: RunwayState, runwayNodeId?: string, strict = true): boolean {
    const twy = this.nodeXY(twyNodeId); if (!twy) return false;
    const h = headingTo(rwyXY, twy);
    const others = this.aircraft.filter(b => b !== a && !isAirborne(b) && b.phase !== 'parked' && b.phase !== 'arrived');
    for (const b of others) {
      const along = alongTrack(b.pos, rwyXY, h), cross = Math.abs(crossTrack(b.pos, rwyXY, h));
      if (along > 20 && along < 150 + b.perf.lengthMeters && cross < 35) return true;
      // ... or taxiing toward that hold line (its next 300 m pass the exit within 40 m): it arrives there while the
      // arrival is still rolling out and the two meet at the hold line
      if (strict && b.path && b.phase === 'taxi') for (let d = b.distAlong; d <= Math.min(b.path.total, b.distAlong + 300); d += 15) {
        const q = sampleAlong(b.path.pts, b.path.cum, d).pos; const qa = alongTrack(q, rwyXY, h);
        if (qa > 20 && qa < 150 && Math.abs(crossTrack(q, rwyXY, h)) < 40) return true;
      }
    }
    // the exit's tail (a high-speed exit curves onto the parallel taxiway): anything standing within 40 m of it
    if (rs && runwayNodeId) {
      const { ids } = this.exitWalk(rs, { runwayNodeId, twyNodeId, at: 0, speedKt: 0, taxiway: null, angleDeg: 0 }, HOLD_LINE_M + a.perf.lengthMeters * 0.5 + 15);
      const pts = ids.map(id => this.nodeXY(id)!).filter(Boolean);
      for (let i = 1; i < pts.length; i++) {
        const seg = dist(pts[i - 1], pts[i]); const n = Math.max(1, Math.ceil(seg / 15));
        for (let k = 0; k <= n; k++) { const q = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / n, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / n }; if (dist(q, rwyXY) < 30) continue; if (others.some(b => b.speed < 3 && dist(b.pos, q) < 40)) return true; }
      }
    }
    return false;
  }
  /** Runway exits for the command panel picker (04 §1.4): distance ahead of the aircraft along its landing runway, side, high-speed flag, engine default. */
  exitsAhead(a: AircraftState): Array<{ taxiway: string; distAheadM: number; dir: 'L' | 'R'; highSpeed: boolean; engineDefault: boolean; passed: boolean }> {
    const rw = a.plan.runway ?? a.assignedRunway; const rs = rw ? this.runwayState(rw) : undefined;
    if (!rs) return [];
    const hdg = rs.headingTrue; const thr = this.thresholdXY(rs.name); if (!thr) return [];
    const alongNow = isAirborne(a) ? 0 : alongTrack(a.pos, thr, hdg);
    // default: the planned exit; before touchdown, the exit the pilot would take at a typical landing roll speed
    const def = this.sc(a).exitPlan ?? (a.phase === 'rollout' || a.phase === 'lineup' ? this.chooseExit(a, rs.ref, hdg, a.speed, null, a.phase === 'lineup') : isAirborne(a) ? this.chooseExit(a, rs.ref, hdg, 120, a.exitTaxiway, false) : null);
    const out: Array<{ taxiway: string; distAheadM: number; dir: 'L' | 'R'; highSpeed: boolean; engineDefault: boolean; passed: boolean }> = [];
    const seen = new Set<string>();
    for (const ex of this.runwayExits(rs.ref)) {
      const along = alongTrack(ex.xy, thr, hdg);
      const twy = this.nodeXY(ex.twyNodeId); if (!twy) continue;
      const angle = Math.abs(angleDelta(hdg, headingTo(ex.xy, twy)));
      if (!ex.taxiway || angle > 125 || seen.has(ex.taxiway)) continue;
      seen.add(ex.taxiway);
      out.push({ taxiway: ex.taxiway, distAheadM: along - alongNow, dir: crossTrack(twy, thr, hdg) > 0 ? 'R' : 'L', highSpeed: angle >= 8 && angle <= 55, engineDefault: def?.taxiway === ex.taxiway, passed: along < alongNow + 10 });
    }
    const ahead = out.filter(e => !e.passed).sort((x, y) => x.distAheadM - y.distAheadM);
    const top = ahead.slice(0, 8);
    const d = ahead.find(e => e.engineDefault); if (d && !top.includes(d)) top.push(d);
    return top;
  }
  /** Leave the runway via an exit: runway node -> taxiway node -> until clear of the hold line, then stop. */
  /** The taxiway nodes an exit leads along until clear of the strip: prefer the edge that gets furthest from the
   *  runway (a high-speed exit's tail often runs parallel to the runway before joining the taxiway), never turning
   *  back more than 110 degrees, and never back toward the runway once heading away. `clear` = it got clear. */
  private exitWalk(rs: RunwayState, exit: ExitPlan, clearM: number): { ids: string[]; clear: boolean } {
    const ids = [exit.runwayNodeId, exit.twyNodeId];
    let prev = exit.runwayNodeId, cur = exit.twyNodeId; let hops = 0, walked = 0;
    while (hops++ < 80 && walked < 600 && this.distToRunway(this.nodeXY(cur)!, rs.ref) < clearM) {
      const n = this.air.nodes.get(cur)!;
      const cx = this.nodeXY(cur)!;
      const h0 = headingTo(this.nodeXY(prev)!, cx);
      const opts = n.edges.filter(e => e.to !== prev && e.type !== 'runway' && !this.runwayNodes.get(rs.ref)?.has(e.to) && Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(e.to)!))) <= 110);
      if (!opts.length) break;
      const score = (e: typeof opts[number]) => this.distToRunway(this.nodeXY(e.to)!, rs.ref) - Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(e.to)!))) * 0.2;
      const next = opts.reduce((b, e) => (score(e) > score(b) ? e : b));
      if (this.distToRunway(this.nodeXY(next.to)!, rs.ref) < this.distToRunway(cx, rs.ref) - 5) break;   // only ways back toward the strip
      walked += next.meters;
      prev = cur; cur = next.to; ids.push(cur);
    }
    return { ids, clear: this.distToRunway(this.nodeXY(cur)!, rs.ref) >= clearM };
  }
  private exitViaTaxiway(a: AircraftState, rs: RunwayState, exit: ExitPlan, fromLineup: boolean) {
    const clearM = HOLD_LINE_M + a.perf.lengthMeters * 0.5 + 15;
    const { ids } = this.exitWalk(rs, exit, clearM);
    const raw: XY[] = [{ ...a.pos }];
    for (const id of ids) raw.push(this.nodeXY(id)!);
    const last = raw[raw.length - 1];
    if (this.distToRunway(last, rs.ref) < clearM) raw.push(advance(last, headingTo(raw[raw.length - 2], last), clearM - this.distToRunway(last, rs.ref) + 5));
    const path = this.buildPath(raw, 'taxi', true);
    path.holds = [];
    a.path = path; a.distAlong = 0; a.holdReleased = false; a.cmdIas = null;
    a.exitTaxiway = null; a.exitDir = null;
    const s = this.sc(a); s.exitPlan = null;
    if (fromLineup) {
      a.phase = 'rollout'; s.vacated = false; s.touchdownDone = true; a.takeoffCleared = false;
      this.emit('info', a, `${a.callsign} vacating runway ${rs.name} via ${exit.taxiway ?? 'the next taxiway'}`, undefined, 'PILOT');
    } else this.emit('info', a, `${a.callsign} exiting via ${exit.taxiway ?? 'taxiway'}`, undefined, 'PILOT');
  }
  private startRollout(a: AircraftState, endName: string, alongM: number) {
    const rs = this.runwayState(endName)!; const r = this.runwayByEnd(endName)!;
    const thr = this.thresholdXY(endName)!;
    const far = advance(this.endXY(r.other), rs.headingTrue, 300);
    a.pos = advance(thr, rs.headingTrue, alongM); a.heading = rs.headingTrue;
    a.path = this.buildPath([{ ...a.pos }, far], 'approach');
    a.distAlong = 0; a.thresholdDist = -alongM; a.altitude = 0;
    a.phase = 'rollout'; a.plan.runway = rs.name; a.assignedRunway = rs.name;
    a.delay.touchdownAt = this.time;
  }

  // ── per-second tasks ───────────────────────────────────────────────────────
  private perSecond() {
    try { airMindOf(this).tick(this); crewLifeOf(this).tick(); } catch { /* as below */ }
    try { mindOf(this).tick(this); } catch { /* the pilots' look-out never stops the simulation */ }
    for (const a of this.aircraft) {
      const s = this.sc(a);
      // scheduled pilot requests
      if (s.nextRequestAt != null && this.time >= s.nextRequestAt && s.nextRequestKind) {
        const kind = s.nextRequestKind; s.nextRequestAt = null; s.nextRequestKind = null;
        if (!(kind === 'with_you' && (a.underControl && this.time - a.spawnedAt > 5 && a.onFrequency === 'approach' && a.plan.kind === 'arrival' && false))) {
          if (kind === 'taxi' && a.phase !== 'startup') { /* superseded */ }
          else if (kind === 'ready' && a.phase !== 'hold_short' && a.phase !== 'lineup') { /* superseded */ }
          else if (kind === 'cross' && a.phase !== 'hold_short') { /* superseded */ }
          else this.raiseRequest(a, kind, kind === 'cross' ? (a.holdShortRunway ?? null) : kind === 'direct' ? (this.beacons[0]?.id ?? null) : null);
        }
      }
      // recall / expire open request
      const req = a.requests[0];
      if (req && req.answeredAt == null) {
        if (req.expiresAt != null && this.time >= req.expiresAt) this.expireRequest(a);
        else if (this.time >= req.recallAt) {
          req.recalls++; req.recallAt = this.time + (SimEngine.RECALL_S[req.kind] ?? 60);
          a.delay.unansweredS += SimEngine.RECALL_S[req.kind] ?? 60;
          if (req.recalls === 3) { this.stats.unansweredRequests++; }
          if (req.recalls >= 3 && req.recalls % 2 === 1) this.addScore('UNANSWERED_REQUEST', a.callsign, null, null, `${req.kind} unanswered ${Math.round(this.time - req.at)} s`);
          this.emit('request', a, req.recalls >= 3 ? `${this.telephony(a.callsign)}, standing by.` : req.text, { type: 'request', request: req, change: 'recalled' });
        }
      }
      // readback mismatch enforcement
      this.enforceMismatch(a);
      // airborne time / fuel
      if (isAirborne(a)) {
        a.delay.airborneS += 1;
        if (a.fuelMin != null) {
          a.fuelMin -= 1 / 60;
          if (a.fuelMin <= 0) {
            this.emit('fuel_exhaustion', a, `${a.callsign} FUEL EXHAUSTION`);
            this.addScore('FUEL_EXHAUSTION', a.callsign);
            this.remove(a.id, 'fuel_exhaustion');
            continue;
          }
          if (!a.emergency && a.fuelMin < 20 && a.plan.kind === 'arrival' && !isAirborne(a) === false && a.phase !== 'landing') {
            this.declareEmergency(a, 'fuel');
          }
        }
      }
      // emergencies
      if (this.sys.emergencies) {
        if (!a.emergency && this.settings.emergencyRate !== 'off') {
          const e = this.safe('emergencies', () => maybeDeclare(a, this.emergRng, this.emergencyView(), this.settings.emergencyRate), null);
          if (e) this.attachEmergency(a, e);
        } else if (a.emergency && a.emergency.status !== 'resolved') {
          this.safe('emergencies', () => stepEmergency(this.emergencyView(), a, 1), undefined);
          const em: Emergency = a.emergency;
          if (em.status === 'resolved' && em.resolvedAt == null) { em.resolvedAt = this.time; this.stats.emergenciesResolved++; }
        }
      }
      if (a.emergency && a.emergency.status !== 'resolved') this.emergencyTick(a, s);
      // stage change events
      const st = this.stageOf(a);
      if (st !== s.lastStage) { this.emit('stage', a, st, { type: 'stage', from: s.lastStage, to: st }); s.lastStage = st; }
      // despawn
      if (s.despawnAt != null && this.time >= s.despawnAt) { if (a.plan.kind === 'arrival' && a.phase === 'parked') this.retireToParked(a); this.remove(a.id, a.plan.kind === 'arrival' ? 'arrived' : 'departed'); continue; }
      // rotten LUAW: > 180 s on the runway with nobody inbound -> vacates for fuel (03 §A14)
      if (a.phase === 'lineup' && s.luawAt != null && this.time - s.luawAt > 400 && !a.pendingCmds.length && a.plan.runway && !this.arrivalOnFinal(a.plan.runway, 6)) {
        const rs = this.runwayState(a.plan.runway)!; const ex = this.chooseExit(a, rs.ref, rs.headingTrue, 0, null, true);
        if (ex) { this.emit('info', a, `${a.callsign}: vacating the runway, brakes and fuel`, undefined, 'PILOT'); this.exitViaTaxiway(a, rs, ex, true); }
        s.luawAt = this.time;
      }
    }
    // runway status timers (closure after emergency: aircraft towed when it elapses; runway stays closed until reopened)
    for (const rs of this.runways) {
      if (rs.statusUntil != null && this.time >= rs.statusUntil) {
        rs.statusUntil = null;
        for (const a of this.aircraft) if (a.emergency && this.sc(a).onRunwayRef === rs.ref && a.phase === 'rollout') { this.emit('info', a, `${a.callsign} towed clear of runway ${rs.ref}`); this.remove(a.id, 'arrived'); }
        this.emit('info', null, `Runway ${rs.ref}: disabled aircraft cleared, inspection required before reopening`);
      }
    }
    // weather-driven runway wind components (cheap; every second)
    const w = this.wx();
    for (const rs of this.runways) { const c = windComponents(w.windDirTrue, w.windKt, rs.headingTrue); rs.windHeadKt = c.headKt; rs.windCrossKt = c.crossKt; }
    if (this.time - this.lastRunwayCheck >= 60) { this.lastRunwayCheck = this.time; this.onWeatherChange(null); }
    if (this.aiOn('tower')) this.autoTowerStep();
    stepArrivals(this);
    if (this.aiOn('approach')) this.autoApproachStep(); else this.aiDeconflict(true);
    if (this.aiOn('ground')) this.autoGroundStep();
    // streak bonuses (03 §6): 1 h / 2 h without an incident
    if (this.stats.streakS >= 3600 && !this.incidentLog.has('STREAK|1h|')) { this.incidentLog.set('STREAK|1h|', this.time); this.addScore('STREAK', 'SESSION', '1h', null, 'one hour without incident'); }
  }
  private emergencyTick(a: AircraftState, s: Scratch) {
    const e = a.emergency!;
    // ARFF on scene
    if (e.arff !== 'none' && e.arffOnSceneAt == null && this.sys.fleet) {
      const on = this.fleet.list().some(v => v.type === 'arff' && v.state === 'onscene');
      if (on) {
        e.arffOnSceneAt = this.time;
        const resp = s.arffDispatchedAt != null ? this.time - s.arffDispatchedAt : null;
        if (resp != null) { this.stats.arffResponseS.push(resp); if (resp <= 180) this.addScore('ARFF_ON_TIME', a.callsign, null, e.runway, `${Math.round(resp)} s`); }
        this.emit('emergency', a, `Fire services on scene for ${a.callsign}`, { type: 'emergency', emergency: e, change: 'services' }, 'SYS');
      }
    }
    // Souls/fuel not asked within 3 min
    if (e.checklist.souls_fuel == null && EMERGENCY_CATALOGUE[e.type].required.includes('souls_fuel') && this.time - e.declaredAt > 180 && !this.sys.emergencies) this.addScore('EMERGENCY_CHECKLIST_MISS', a.callsign, null, null, 'souls and fuel not obtained within 3 min');
    // Stand-down: stopped/vacated for 10 min with no fire -> resolved
    if ((e.status === 'stopped' || e.status === 'landed') && e.stoppedAt != null && this.time - e.stoppedAt > 600 && !this.sys.emergencies) this.resolveEmergency(a, 'stand down');
  }
  /**
   * May an AI clear this aircraft across the runway it is holding short of? The crossing must be safe, and when a
   * second runway follows right behind (a parallel pair, hold lines a few hundred metres apart) that one must be safe
   * too and the stretch between them empty - one aircraft fits there, a queue does not, and an aircraft stopped there
   * with its tail on the first runway blocks it for the next arrival.
   */
  /** Should this aircraft be told to cross the runway it holds at now: time before the next arrival, and room on the far side? */
  crossAdvised(a: AircraftState): boolean { return this.aiCrossAllowed(a); }
  /** Who is in the way of crossing, other than on the runway itself: cleared for take-off on it, or standing where this one would stop. */
  crossBlocker(a: AircraftState): { cs: string; how: 'takeoff' | 'far' } | null {
    const rw = a.holdShortRunway, ref = rw ? this.refOf(rw) : null; if (!rw || !ref || !a.path) return null;
    const dep = this.aircraft.find(x => x !== a && !isAirborne(x) && x.plan.runway && this.refOf(x.plan.runway) === ref && (x.takeoffCleared || x.pendingCmds.some(c => c.kind === 'takeoff')));
    if (dep) return { cs: dep.callsign, how: 'takeoff' };
    const h0 = a.path.holds?.[0], h1 = a.path.holds?.[1]; if (!h0) return null;
    const room = h1 && h1.runway && h1.at - h0.at < 450 ? h1.at - h0.at + 60 : 220;
    const far = this.aircraft.find(b => { if (b === a || isAirborne(b) || b.phase === 'parked' || b.phase === 'arrived') return false; const pr = projectOntoPath(a.path!.pts, a.path!.cum, b.pos, h0.at, room); return pr.dist < 60 && pr.at > h0.at + 20; });
    return far ? { cs: far.callsign, how: 'far' } : null;
  }
  private aiCrossAllowed(a: AircraftState): boolean {
    // an AI allows for the crew's reaction and a slow start: a heavy needs ~70 s from the clearance to being clear
    let crossS = a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 100 : 80;
    const h0 = a.path?.holds?.[0], h1 = a.path?.holds?.[1];
    // a route that runs along the strip (an exit loop, a backtrack) is on it far longer than a plain crossing
    if (h0 && a.path && a.holdShortRunway) { const ref = this.refOf(a.holdShortRunway); let m = 0; while (h0.at + m < a.path.total && this.distToRunway(sampleAlong(a.path.pts, a.path.cum, h0.at + m).pos, ref ?? '') < STRIP_HALF_M + 18) m += 20; crossS += Math.max(0, m - 120) / 3; }
    if (!a.holdShortRunway || !this.crossingSafe(a.holdShortRunway, crossS, true, a.pos)) return false;
    // the far side must be clear: an aircraft standing on the path within 220 m past the crossing would leave this one
    // stopped on the strip
    if (this.farSideBlocker(a)) return false;
    // nor may another aircraft be crossing toward the same taxiway: two that meet on the far side both stop on the strip
    if (this.crossesToward(a, h0?.at ?? null)) return false;
    if (!(h0 && h1 && h1.runway && h1.at - h0.at < 450)) return true;
    const roomBetween = !this.aircraft.some(b => b !== a && !isAirborne(b) && b.phase !== 'parked' && b.phase !== 'arrived' && (() => { const pr = projectOntoPath(a.path!.pts, a.path!.cum, b.pos, h0.at, h1.at - h0.at + 60); return pr.dist < 60 && pr.at > h0.at + 20; })());
    if (h1.isDepartureEntry) return roomBetween;                        // it will line up on the second one: only the room matters
    return roomBetween && this.crossingSafe(h1.runway, crossS + 30, true) && !this.bothEnds(this.refOf(h1.runway) ?? h1.runway).some(o => o.occupiedBy.some(x => x.kind === 'takeoff' || x.kind === 'landing' || x.kind === 'rollout'));
  }
  /** Another aircraft on (or cleared across) the same runway whose way ahead comes within 45 m of this one's way past the crossing. */
  private crossesToward(a: AircraftState, holdAt: number | null): boolean {
    const ref = a.holdShortRunway ? this.refOf(a.holdShortRunway) : null; if (!ref || holdAt == null || !a.path) return false;
    const reach = 380 + a.perf.lengthMeters;
    return this.aircraft.some(b => {
      if (b === a || isAirborne(b) || !b.path) return false;
      if (this.sc(b).crossingRef !== ref && !b.pendingCmds.some(c => c.kind === 'cross' && this.refOf((c.ast as { runway?: string } | undefined)?.runway ?? '') === ref)) return false;
      for (let m = 0; m <= 380 && b.distAlong + m < b.path.total; m += 25) {
        const pr = projectOntoPath(a.path!.pts, a.path!.cum, sampleAlong(b.path.pts, b.path.cum, b.distAlong + m).pos, holdAt, reach);
        if (pr.dist < 45 && pr.at > holdAt + 20) return true;
      }
      return false;
    });
  }
  /** An aircraft standing on the path within 220 m past the crossing this one holds short of: crossing now would leave it stopped on the strip. */
  private farSideBlocker(a: AircraftState): AircraftState | null {
    const h0 = a.path?.holds?.[0]; if (!h0 || !a.path) return null;
    const ref = a.holdShortRunway ? this.refOf(a.holdShortRunway) : null;
    const coming = this.aircraft.find(b => { const h = b !== a && b.phase === 'taxi' && !this.sc(b).tow ? b.path?.holds?.[0] : null; if (!h || !ref || this.refOf(h.runway) !== ref || h.at - b.distAlong > 260 || h.at < b.distAlong) return false; const pr = projectOntoPath(a.path!.pts, a.path!.cum, sampleAlong(b.path!.pts, b.path!.cum, h.at).pos, h0.at, 260 + a.perf.lengthMeters); return pr.dist < 25 && pr.at > h0.at + 30 && Math.abs(angleDelta(sampleAlong(b.path!.pts, b.path!.cum, h.at).heading, sampleAlong(a.path!.pts, a.path!.cum, pr.at).heading)) > 120; });
    if (coming) return coming;
    return this.aircraft.find(b => b !== a && !isAirborne(b) && b.phase !== 'parked' && b.phase !== 'arrived' && b.speed < 3 && (() => { const pr = projectOntoPath(a.path!.pts, a.path!.cum, b.pos, h0.at, 220 + a.perf.lengthMeters + b.perf.lengthMeters); return pr.dist < 40 && pr.at > h0.at + 30; })()) ?? null;
  }
  /** An arrival below 5,000 ft not established on an approach within 3 NM of the first 6 NM of a take-off from `end`. */
  private lowTrafficOnClimbOut(end: string): boolean {
    const r = this.ilsFor(end); if (!r) return false;
    const pts = [0, 1.5, 3, 4.5, 6, 8].map(nm => advance(r.thrXY, r.rwdHdg, nm * NM_TO_M));
    // where it is now and where it will be in one and two minutes on its present vector (a departure is at 3,000 ft
    // about two minutes after the clearance, still on the tower frequency)
    return this.aircraft.some(b => {
      if (b.plan.kind !== 'arrival' || !isAirborne(b) || b.ilsCaptured || b.phase === 'landing' || b.altitude >= 5000) return false;
      const hdg = b.navMode === 'heading' ? b.targetHeading : b.heading;
      const at = [0, 60, 120].map(t => advance(b.pos, hdg, b.speed * KTS_TO_MPS * t));
      return at.some(q => pts.some(p => dist(p, q) < 3 * NM_TO_M));
    });
  }
  /** AI tower assist (UX §G5.10): routine clearances 8 s after they become valid; never violates the rules. */
  private depQueueFull(): boolean {
    const runways = new Set(this.activeEnds('dep').map(r => r.ref)).size || 1;
    // (one with more than 4 km still to taxi is not in the queue yet: at Singapore five of those kept everybody else on stand)
    const moving = this.aircraft.filter(d => d.plan.kind === 'departure' && !isAirborne(d) && ['pushback', 'taxi', 'hold_short', 'lineup', 'takeoff'].includes(d.phase))
      .reduce((n, d) => n + (d.phase === 'taxi' && d.path && d.path.total - d.distAlong > 4000 ? 0.4 : 1), 0);
    return moving >= DEP_QUEUE_PER_RUNWAY * runways;
  }
  /** Another aircraft on the ground within 70 m of the lane `a` would push back along, or taxiing toward it (its next
   *  400 m pass within 50 m of the lane). */
  private pushLaneBusy(a: AircraftState, coming = true): boolean {
    const p = this.pushbackPath(a, 'any'); if (!p) return false;
    const lane: XY[] = []; for (let d = 0; d <= p.total; d += 10) lane.push(sampleAlong(p.pts, p.cum, d).pos);
    return this.aircraft.some(b => {
      if (b === a || isAirborne(b)) return false;
      // a neighbour whose pushback is approved but not started yet (the crew's reply still to come) pushes all the same
      if (b.phase === 'parked' && b.pendingCmds.some(c => c.kind === 'pushback')) {
        const bp = this.pushbackPath(b, 'any'); if (!bp) return false;
        for (let d = 0; d <= bp.total; d += 15) { const q = sampleAlong(bp.pts, bp.cum, d).pos; if (lane.some(l => dist(l, q) < 60 + (a.perf.lengthMeters + b.perf.lengthMeters) / 4)) return true; }
        return false;
      }
      if (['parked', 'arrived', 'departed', 'startup'].includes(b.phase)) return false;
      if (lane.some(q => dist(q, b.pos) < 70)) return true;
      if (!b.path || (!coming && b.phase !== 'pushback')) return false;
      // (a neighbour already pushing: its whole lane - two heavies pushed from adjacent stands into each other)
      const ahead = b.phase === 'pushback' ? b.path.total : Math.min(b.path.total, b.distAlong + 400);
      const clear = b.phase === 'pushback' ? 60 + (a.perf.lengthMeters + b.perf.lengthMeters) / 4 : 50;
      for (let d = b.distAlong; d <= ahead; d += 15) { const q = sampleAlong(b.path.pts, b.path.cum, d).pos; if (lane.some(l => dist(l, q) < clear)) return true; }
      return false;
    });
  }
  /** After an AI runway change: arrivals not yet on an approach expect the nearest new arrival end (their sequence is
   *  re-planned), departures before take-off the nearest new departure end - those taxiing are re-cleared to it (left
   *  alone they waited at the old runway's hold line for good). */
  /** A departure whose runway is no longer in use: the nearest one that is, and the way there when it is already taxiing. */
  private aiMoveToRunway(a: AircraftState): boolean {
    const c = this.activeEnds('dep').filter(r => r.status === 'open' && this.weightAllowed(r.name, a.perf.weightClass) && this.thresholdXY(r.name)); if (!c.length) return false;
    const best = c.reduce((b, r) => (dist(a.pos, this.thresholdXY(r.name)!) < dist(a.pos, this.thresholdXY(b.name)!) ? r : b));
    const was = a.plan.runway; a.plan.runway = best.name;
    if (a.phase !== 'taxi' && a.phase !== 'hold_short') return true;
    const dest: TaxiDest = { kind: 'runway', runway: best.name, intersection: null };
    const plan = this.planTaxi(a, dest, []); if ('code' in plan) { a.plan.runway = was; return false; }
    const hs = plan.path.holds!.find(h => !h.isDepartureEntry) ?? null;
    const r = this.cmdTaxi(a, dest, [], true, hs ? { kind: 'runway', runway: hs.runway } : null, [], false);
    if (!r.ok) { a.plan.runway = was; return false; }
    this.answerRequest(a, ['ready', 'taxi'], 'ai');
    this.emit('transmission', a, `AI ${a.onFrequency === 'tower' ? 'TWR' : 'GND'}: ${a.callsign} runway change, taxi to runway ${best.name}${hs ? `, hold short of runway ${hs.runway}` : ''}`, { type: 'transmission', ast: makeAst('taxi', a.callsign, { dest, via: [], auto: true, holdShortOf: hs ? { kind: 'runway', runway: hs.runway } : null, cross: [], expedite: false }), result: { ok: true, code: 'ok_queued', transmission: '', readback: '' }, who: 'ai' }, 'AI');
    return true;
  }
  private aiReassignRunways() {
    const say = (a: AircraftState, who: string, text: string, ast: CommandAST, ok: boolean) => { if (ok) this.emit('transmission', a, `AI ${who}: ${text}`, { type: 'transmission', ast, result: { ok: true, code: 'ok_queued', transmission: '', readback: '' }, who: 'ai' }, 'AI'); };
    const arr = this.windFiltered(this.activeEnds('arr').filter(r => r.status === 'open'));
    const dep = this.activeEnds('dep').filter(r => r.status === 'open');
    const nearest = (a: AircraftState, list: RunwayState[]) => { const c = list.filter(r => this.weightAllowed(r.name, a.perf.weightClass) && this.thresholdXY(r.name)); return c.length ? c.reduce((b, r) => (dist(a.pos, this.thresholdXY(r.name)!) < dist(a.pos, this.thresholdXY(b.name)!) ? r : b)) : null; };
    for (const a of this.aircraft) {
      const s = this.sc(a);
      if (a.plan.kind === 'arrival' && isAirborne(a) && !a.ilsArmed && !a.ilsCaptured && a.phase !== 'landing' && a.plan.runway && !arr.some(r => r.name === a.plan.runway)) {
        const best = nearest(a, arr); if (!best) continue;
        a.plan.runway = best.name; a.assignedRunway = null;
        s.aiMode = null; s.aiBase = null; s.aiRank = null; s.aiSide = null; s.aiJoin = null; s.aiOrbitAt = null;
        say(a, a.onFrequency === 'tower' ? 'TWR' : 'APP', `${a.callsign} runway change, expect ILS ${best.name}`, makeAst('expectRunway', a.callsign, { runway: best.name }), true);
      } else if (a.plan.kind === 'departure' && !isAirborne(a) && ['parked', 'startup', 'pushback', 'taxi', 'hold_short'].includes(a.phase) && a.plan.runway && !dep.some(r => r.name === a.plan.runway)) {
        this.aiMoveToRunway(a);
      }
    }
  }
  /** AI positions answer an emergency on their frequency at once: acknowledge, squawk, souls on board and fuel (the
   *  checklist items the score asks for within 3 minutes - the AI used to leave them to nobody). */
  private aiAckEmergencies(freqs: Position[], tag: string) {
    for (const a of this.aircraft) {
      const e = a.emergency;
      if (!e || e.status === 'resolved' || !freqs.includes(a.onFrequency) || a.pendingCmds.length) continue;
      if (e.checklist.acknowledge != null && e.checklist.souls_fuel != null) continue;
      if (this.time - e.declaredAt < 4) continue;
      const ast = makeAst('emergencyAck', a.callsign, { ask: ['pob', 'fuel'], squawk: true });
      const r = this.cmdEmergencyAck(a, ['pob', 'fuel'], true);
      if (r.ok) this.emit('transmission', a, `AI ${tag}: ${a.callsign} ${describe(ast)}`, { type: 'transmission', ast, result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
    }
  }
  private autoTowerStep() {
    this.aiAckEmergencies(['tower'], 'TWR');
    // a wind shift (frontal passage) left the runways in use with a tailwind: the tower applies the weather suggestion
    // after a minute (it kept clearing take-offs and landings with 11-12 kt behind them)
    if (this.suggestedRunways) {
      this.aiRunwaySugAt ??= this.time;
      if (this.time - this.aiRunwaySugAt >= 60) { const sg = this.suggestedRunways; this.aiRunwaySugAt = null; this.setActiveRunways(sg.dep, sg.arr); this.aiReassignRunways(); }
    } else this.aiRunwaySugAt = null;
    // an arrival on the tower frequency that is no longer on an approach (broken off, cancelled): back to approach for
    // vectors - the tower does not vector, and left alone it flew on until it left the airspace
    for (const a of this.aircraft) {
      const s = this.sc(a);
      const off = a.plan.kind === 'arrival' && isAirborne(a) && a.onFrequency === 'tower' && !a.ilsArmed && !a.ilsCaptured && a.phase !== 'landing' && a.handedTo == null && !a.pendingCmds.length;
      if (!off) { s.towerOffApprSince = null; continue; }
      s.towerOffApprSince ??= this.time;
      if (this.time - s.towerOffApprSince < 8) continue;
      s.towerOffApprSince = null;
      const r = this.cmdHandoff(a, 'approach', 'now');
      if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} contact approach`, { type: 'transmission', ast: makeAst('contact', a.callsign, { position: 'approach', when: 'now' }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
    }
    // holding at a runway that has gone out of use (the wind turned the field round): to one that is, or off from here when
    // nothing uses it the other way (left to itself it stood there for good, with everybody behind it)
    const offHere = new Set<string>();
    for (const a of this.aircraft) {
      const s = this.sc(a); if (a.phase !== 'hold_short' || a.plan.kind !== 'departure' || !a.plan.runway || a.onFrequency !== 'tower' || a.pendingCmds.length || s.stoppedSince == null || this.time - s.stoppedSince < 30) continue;
      const rs = this.runwayState(a.plan.runway); if (!rs || rs.activeDep || !a.holdShortNode || !this.isHoldNodeForRunway(a.holdShortNode, rs.name)) continue;
      const opp = this.runwayState(rs.reciprocal), tail = -this.windFor(rs.headingTrue).headKt;
      if (rs.status === 'open' && tail < 10 && !(opp && (opp.activeDep || opp.activeArr))) { offHere.add(rs.name); continue; }
      if (this.time - (s.aiMovedAt ?? -999) < 60) continue;
      s.aiMovedAt = this.time;
      if (!this.aiMoveToRunway(a) && rs.status === 'open' && tail < 10 && !this.arrivalOnFinal(opp?.name ?? rs.name, 12)) offHere.add(rs.name);
    }
    for (const rs of this.runways) {
      if (!rs.activeDep && !offHere.has(rs.name)) continue;
      // the hold line serves both ends of the runway: only the end the departure is planned for (its into-wind end) is cleared
      const waiting = this.aircraft.find(a => a.phase === 'hold_short' && a.holdShortNode && this.isHoldNodeForRunway(a.holdShortNode, rs.name) && this.runwayAheadM(a, rs) >= this.takeoffRunNeededM(a) && a.plan.kind === 'departure' && a.plan.runway && upper(a.plan.runway) === rs.name && this.sc(a).stoppedSince != null && this.time - this.sc(a).stoppedSince! > 8 && !a.pendingCmds.length);
      // a departure off this runway or a parallel (same direction) climbing out ahead: wait until it is 2.5 NM out (4.5
      // behind a heavy or a 757: its wake) - close parallels count as one runway for departures, the way towers run them
      // (6 NM off the parallel held every second departure about 2.5 min and capped the pair near 20 an hour)
      const parallelDep = !!this.departureAlongside(rs.name);
      // an arrival inside 4 NM to a runway that crosses this one (or a landing roll on it): no take-off through its path
      const heavy = waiting && (waiting.wakeCategory === 'HEAVY' || waiting.wakeCategory === 'SUPER' || waiting.perf.b757);
      const crossing = this.bothEnds(rs.ref)[0].intersects.flatMap(ref => this.bothEnds(ref)).some(o => !!this.arrivalOnFinal(o.name, heavy ? 9 : 4) || o.occupiedBy.some(x => x.kind === 'rollout' || x.kind === 'landing'));
      // an arrival inside 6 NM (8 behind a heavy: its wake must be clear of the touchdown zone) on this runway: wait
      const finalBusy = !!waiting && !!this.arrivalOnFinal(rs.name, heavy ? 7 : 5);
      // an aircraft mid-crossing on the runway, or waiting at the next hold line with its tail still on it: no take-off
      const crosserOn = rs.occupiedBy.some(x => x.kind === 'crossing') || !!this.crossingTraffic(rs.name);   // (or cleared across, about to enter)
      // an arrival being vectored low across the climb-out (not established on an approach): the departure would climb
      // into it before approach can do anything about it - it is still on the tower frequency
      const climbOut = waiting ? this.lowTrafficOnClimbOut(rs.name) : false;
      if (waiting) this.sc(waiting).aiWhy = `dep:${parallelDep ? ' parallel' : ''}${crossing ? ' crossing' : ''}${finalBusy ? ' final' : ''}${crosserOn ? ' crosser' : ''}${climbOut ? ' climbout' : ''}`;
      if (waiting && (parallelDep || crossing || finalBusy || crosserOn || climbOut)) {
        const req = waiting.requests.find(q => q.answeredAt == null && q.kind === 'ready');
        if (req && this.time - req.at > 8) { this.answerRequest(waiting, ['ready'], 'ai'); this.emit('transmission', waiting, `AI TWR: ${waiting.callsign} hold position, traffic`, { type: 'transmission', ast: makeAst('holdPosition', waiting.callsign, { reason: 'traffic' }), result: { ok: true, code: 'ok_queued', transmission: '', readback: '' }, who: 'ai' }, 'AI'); }
      }
      if (waiting && !parallelDep && !crossing && !finalBusy && !crosserOn && !climbOut) {
        // initial climb to 7,000: above the 3-6,000 ft pattern levels quickly, below the 9,000+ ft arrivals entering the
        // airspace (a climb straight to 9,000 met them level); approach climbs it on to cruise once that is clear
        const init = Math.max(6000, Math.min(DEP_INITIAL_FT, waiting.plan.cruiseAlt ?? DEP_INITIAL_FT));
        const r = this.cmdTakeoff(waiting, rs.name, { immediate: false, afterDepHdg: null, turn: null, initialAlt: init, contactDeparture: true });
        if (r.ok) this.emit('transmission', waiting, `AI TWR: ${waiting.callsign} runway ${rs.name} cleared for takeoff`, { type: 'transmission', ast: makeAst('takeoff', waiting.callsign, { runway: rs.name }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
      }
    }
    for (const a of this.aircraft) {
      // a rollout that came to a stop on the runway (no exit) asks the tower for taxi: hand it to ground, who taxis it off
      if (a.phase === 'rollout' && a.onFrequency === 'tower' && a.handedTo == null && a.speed < 1 && a.requests.some(r => r.answeredAt == null && r.kind === 'taxi_in') && !a.pendingCmds.length) {
        const r = this.cmdHandoff(a, 'ground', 'now');
        if (r.ok) { this.emit('transmission', a, `AI TWR: ${a.callsign} contact ground`, { type: 'transmission', ast: makeAst('contact', a.callsign, { position: 'ground', when: 'now' }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI'); }
        continue;
      }
      if (a.phase === 'landing' && !a.landingCleared && a.plan.runway) {
        const d = distToThresholdFromPathNM(a) ?? 99;
        // hold the landing clearance while a departure is rolling on / cleared onto a crossing runway
        const rsL = this.runwayState(a.plan.runway)!;
        // (a lined-up aircraft at the far threshold does not block the intersection; a roll, a landing or a crossing does)
        const crossBusy = this.bothEnds(rsL.ref)[0].intersects.flatMap(ref => this.bothEnds(ref)).some(o => o.occupiedBy.some(x => x.kind !== 'lineup' && x.kind !== 'vehicle') || this.aircraft.some(b => b.plan.runway && this.refOf(b.plan.runway) === o.ref && b.phase === 'takeoff' && !isAirborne(b)));
        // preceding traffic still rolling out inside 3.5 NM: "continue approach" keeps the arrival coming (the crew would
        // otherwise go around at 2 NM without a clearance); the clearance follows the moment the runway is vacated
        const occ = this.runwayOccupant(a.plan.runway, a.id);
        if (d <= 3.5 && (occ ? rsL.occupiedBy.some(x => x.kind === 'rollout' || x.kind === 'crossing') : crossBusy) && !this.sc(a).continueApproach && !a.pendingCmds.length) {
          const r = this.cmdContinueApproach(a, null);
          if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} continue approach, traffic vacating`, { type: 'transmission', ast: makeAst('continueApproach', a.callsign, { number: null }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
        }
        // still not clear just before the crew's own no-clearance limits: the tower sends it around (the crew going around on its own at minimums with no
        // clearance is an unhandled go-around)
        // (told to continue behind one that is rolling out or crossing: it has until about 1.4 NM)
        if ((d <= (this.sc(a).continueApproach ? 1.4 : FORCED_GA.noClearanceNM + 0.3) || a.altitude <= FORCED_GA.noClearanceFt + 150) && (occ || crossBusy) && !a.pendingCmds.length) {
          // a departure climbing out of a runway alongside (same direction, within 6 NM, below 5,000 ft): the missed
          // approach turns 30 degrees away from it (straight ahead it climbed into one turning across from the parallel)
          const rwyHdg = rsL.headingTrue;
          // (off a parallel runway, whatever its heading now: its departure route may already be turning across)
          const dep = this.aircraft.find(b => { if (b.plan.kind !== 'departure' || !(isAirborne(b) || b.phase === 'takeoff') || b.altitude >= 5000 || !b.plan.runway || b.plan.runway === a.plan.runway || dist(a.pos, b.pos) >= 6 * NM_TO_M) return false; const br = this.runwayState(b.plan.runway); return !!br && Math.abs(angleDelta(br.headingTrue, rwyHdg)) < 20; });
          // away from the way it will turn (toward its exit fix - still on the roll it has not turned yet), else from where it is
          const fix = dep ? this.beacons.find(x => x.id === dep.plan.fix) : undefined;
          const depTo = dep ? (fix ? headingTo(dep.pos, fix) : dep.targetHeading) : rwyHdg;
          const side = dep ? (Math.abs(angleDelta(rwyHdg, depTo)) > 15 ? (angleDelta(rwyHdg, depTo) > 0 ? -1 : 1) : (crossTrack(dep.pos, a.pos, rwyHdg) > 0 ? -1 : 1)) : 0;
          const gaHdg: number | 'runway' = dep ? Math.round((rwyHdg + side * 30 + 360) % 360) : 'runway';
          const r = this.cmdGoAround(a, gaHdg, 3000, 'approach');
          const said = gaHdg === 'runway' ? 'fly runway heading' : `turn ${side < 0 ? 'left' : 'right'} heading ${hdg3(((gaHdg - this.magVar) % 360 + 360) % 360)}`;
          if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} go around, ${said}, climb 3000, contact approach`, { type: 'transmission', ast: makeAst('goAround', a.callsign, { heading: gaHdg, alt: 3000, contact: 'approach' }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
          continue;
        }
        if (d <= 5 && !crossBusy && !occ && !a.pendingCmds.some(c => c.kind === 'clearedLand')) {
          const r = this.cmdClearedLand(a, a.plan.runway, null, null);
          if (!r.ok) this.sc(a).aiWhy = `land: ${r.code} ${r.reason ?? ''}`;
          if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} runway ${a.plan.runway} cleared to land`, { type: 'transmission', ast: makeAst('clearedLand', a.callsign, { runway: a.plan.runway }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
        }
      }
      if (a.phase === 'hold_short' && a.holdShortRunway && !a.holdReleased && a.path?.holds?.[0] && !a.path.holds[0].isDepartureEntry && this.sc(a).stoppedSince != null && this.time - this.sc(a).stoppedSince! > 8 && this.aiCrossAllowed(a) && !a.pendingCmds.length) {
        const r = this.cmdCross(a, a.holdShortRunway, false, null);
        if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} cross runway ${a.holdShortRunway}`, { type: 'transmission', ast: makeAst('cross', a.callsign, { runway: a.holdShortRunway }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
      }
    }
  }

  /**
   * AI approach assist (Solo mode helper): every arrival on the approach frequency that is not yet established is
   * sequenced onto its runway's ILS — radar contact, a descent to a 3000 ft (+1000 ft per place in the queue) level,
   * 190 kt, a 30-degree intercept at 10 NM or a delay leg away from the centreline while the aircraft ahead needs
   * more spacing, then the ILS clearance. Uses the same command API as the player so every rule still applies.
   */
  /**
   * AI ground: answers the ground-frequency requests a controller would - start-up / pushback, taxi to the departure
   * runway, taxi to the stand after landing, a brake-check return - and releases taxiway hold-shorts once the traffic
   * they were waiting for has passed. Same command API as the player, so all the rules still apply.
   */
  /**
   * Ground deadlock: an aircraft held for 40 s behind one that is itself standing still (holding short, or held in
   * turn - two aircraft nose to nose on one taxiway, one of them on the runway waiting for the other to clear the
   * hold line) is re-routed around the other, the way a ground controller amends a route.
   */
  private aiBreakDeadlocks(say: (a: AircraftState, text: string, ast: CommandAST, r: EngineOutcome) => boolean) {
    for (const a of this.aircraft) {
      const s = this.sc(a);
      if (!s.taxiDest || this.time - s.lastRerouteAt < 120 || a.pendingCmds.length) continue;
      // two aircraft holding short of the same runway from opposite sides of one taxiway: neither can be cleared across
      // (the other stands on its far side) - the one that stopped last goes round
      const facing = a.phase === 'hold_short' && !a.holdReleased && s.stoppedSince != null && this.time - s.stoppedSince > 40 ? this.farSideBlocker(a) : null;
      // (or one taxiing up to the far side and held there, waiting for this one: nose to nose across the runway)
      const facingTaxi = !!facing && facing.phase === 'taxi' && facing.trafficHold && facing.speed < 0.5;
      const b = facing && (facing.phase === 'hold_short' || facingTaxi) && Math.abs(angleDelta(a.heading, facing.heading)) > 120 && (facingTaxi || (this.sc(facing).stoppedSince ?? 0) <= (s.stoppedSince ?? 0))
        ? facing
        : (a.phase === 'taxi' && a.trafficHold && s.heldSince != null && this.time - s.heldSince >= DEADLOCK_S && s.blockedById != null ? this.byId(s.blockedById) : null);
      if (!b || isAirborne(b) || b.speed > 0.5) continue;
      const bs = this.sc(b);
      if (this.time - bs.lastRerouteAt < 40) continue;                           // the other one is already going round
      // a real deadlock only: the two block each other, or the other is standing still facing this one (nose to nose)
      // - an aircraft queued behind another one heading the same way is simply waiting its turn
      const headOn = Math.abs(angleDelta(a.heading, b.heading)) > 120;
      // (or a longer ring: a waits for b, b for c, ... and one of them for a - three or four aircraft round a junction)
      let ring = false; { let c: AircraftState | undefined = b; for (let k = 0; k < 6 && c; k++) { const nx = this.sc(c).blockedById; if (nx == null || !c.trafficHold) break; if (nx === a.id) { ring = true; break; } c = this.byId(nx); } }
      const stuck = ring || b === facing || bs.blockedById === a.id || (headOn && (b.phase === 'hold_short' || b.phase === 'parked' || b.phase === 'arrived' || (b.trafficHold && bs.heldSince != null && this.time - bs.heldSince > 20)));
      if (!stuck) continue;
      // round the blocker - and clear of everybody else standing on the taxiways (a way round that runs into the next
      // stopped aircraft is no way round)
      const avoid = new Set<string>();
      const standing = this.aircraft.filter(x => x !== a && !isAirborne(x) && x.speed < 0.5 && !['parked', 'arrived', 'startup'].includes(x.phase) && x.phase !== 'pushback');
      for (const id of this.air.nodes.keys()) { const xy = this.nodeXY(id); if (!xy) continue; if (dist(xy, b.pos) < 70 || standing.some(x => x !== b && dist(xy, x.pos) < 50)) avoid.add(id); }
      if (!avoid.size) continue;
      this.rerouteAvoid = avoid;
      const plan = this.planTaxi(a, s.taxiDest, []);
      this.rerouteAvoid = null;
      s.lastRerouteAt = this.time;
      if ('code' in plan) continue;
      const remaining = a.path ? a.path.total - a.distAlong : 0;
      // no sensible way round - unless it has been stuck for two minutes: then any way round beats waiting for good
      const longStuck = s.heldSince != null && this.time - s.heldSince > 120;
      if (plan.path.total > (longStuck ? remaining * 5 + 3000 : remaining * 2.5 + 800)) continue;
      this.rerouteAvoid = avoid;
      const dest = s.taxiDest;
      const hs = plan.path.holds!.find(h => !h.isDepartureEntry) ?? null;
      const r = this.cmdTaxi(a, dest, [], true, hs ? { kind: 'runway', runway: hs.runway } : null, [], false);
      this.rerouteAvoid = null;
      // the re-plan happens when the pilot executes the taxi command: keep the avoid set for that plan
      if (r.ok) { s.rerouteAvoidNodes = avoid; say(a, `${a.callsign} re-route around ${b.callsign}: taxi via ${taxiwaysForPath(this.air, plan.ids).slice(0, 4).join(' ') || 'the alternate'}${hs ? `, hold short of runway ${hs.runway}` : ''}`, makeAst('taxi', a.callsign, { dest, via: [], auto: true, holdShortOf: hs ? { kind: 'runway', runway: hs.runway } : null, cross: [], expedite: false }), r); }
    }
  }
  private autoGroundStep() {
    this.aiAckEmergencies(['ground'], 'GND');
    const say = (a: AircraftState, text: string, ast: CommandAST, r: EngineOutcome) => { if (r.ok) this.emit('transmission', a, `AI GND: ${text}`, { type: 'transmission', ast, result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI'); return r.ok; };
    // a taxi clearance the way a controller phrases it: with "hold short of" the first runway the route crosses (FAA
    // scores a bare clearance across a runway; ICAO holds implicitly either way)
    const taxi = (a: AircraftState, dest: TaxiDest, what: string): boolean => {
      const plan = this.planTaxi(a, dest, []);
      const first = 'code' in plan ? null : plan.path.holds!.find(h => !h.isDepartureEntry) ?? null;
      const hs: HoldShortTarget | null = first ? { kind: 'runway', runway: first.runway } : null;
      return say(a, `${a.callsign} taxi to ${what}${hs ? `, hold short of runway ${first!.runway}` : ''}`, makeAst('taxi', a.callsign, { dest, via: [], auto: true, holdShortOf: hs, cross: [], expedite: false }), this.cmdTaxi(a, dest, [], true, hs, [], false));
    };
    this.aiBreakDeadlocks(say);
    for (const a of this.aircraft) {
      if (isAirborne(a) || a.onFrequency !== 'ground' || a.phase === 'arrived' || a.phase === 'departed') continue;
      const s = this.sc(a); if (this.time < s.aiNextAt || a.pendingCmds.length) continue;
      // an aircraft waiting at a runway to cross: that call first, whatever else its crew has asked
      const open = (a.phase === 'hold_short' && a.holdShortRunway ? a.requests.find(q => q.answeredAt == null && q.kind === 'cross') : undefined) ?? a.requests.find(q => q.answeredAt == null);
      // taxiway hold-short (give way): continue once the traffic it waited for is clear
      if (!open && a.phase === 'hold_short' && a.holdShortTaxiway && !a.holdShortRunway && s.stoppedSince != null && this.time - s.stoppedSince > 15 && !a.trafficHold) {
        const o = this.cmdContinue(a, null); if (say(a, `${a.callsign} continue taxi`, makeAst('continue', a.callsign, { holdShortOf: null }), o)) { s.aiNextAt = this.time + 10; continue; }
      }
      // at a runway it is to cross with nothing asked (the call was answered "standby", or lost): cleared when it is safe
      if (!open && a.phase === 'hold_short' && a.holdShortRunway && !a.holdReleased && a.path?.holds?.[0] && !a.path.holds[0].isDepartureEntry && s.stoppedSince != null && this.time - s.stoppedSince > 20 && this.aiCrossAllowed(a)) {
        if (say(a, `${a.callsign} cross runway ${a.holdShortRunway}`, makeAst('cross', a.callsign, { runway: a.holdShortRunway }), this.cmdCross(a, a.holdShortRunway, false, null))) { s.aiNextAt = this.time + 8; continue; }
      }
      if (!open || this.time - open.at < 5) continue;                       // a human takes a moment to answer
      const rwy = a.plan.runway;
      let ok = false;
      switch (open.kind) {
        case 'startup': case 'pushback': case 'clearance':
          // (not into a lane somebody is taxiing along: a push into an arrival taxiing in left both waiting for the other)
          // metering: a runway queue longer than DEP_QUEUE_PER_RUNWAY per departure runway waits at the gate (engines off),
          // not on the taxiways - a field full of taxiing departures released one climb-out after another across the
          // arrival pattern and nobody landed
          // (held either way, the crew is told so: "standby" - left unanswered they called again and again and the
          // request timed out on the alert list)
          {
            // (seven minutes and more at the gate: only what is really in the way keeps it there, ten: no queue does)
            const waited = this.time - open.at; const lane = a.needsPushback && this.pushLaneBusy(a, waited < 420), queue = !lane && waited < 600 && this.depQueueFull();
            if (lane || queue) {
              if (this.time >= a.standbyUntil && this.time - open.at >= 12) say(a, `${a.callsign} standby, ${lane ? 'traffic passing behind you' : `expect ${a.needsPushback ? 'pushback' : 'start-up'} in two minutes`}`, makeAst('standby', a.callsign, {}), this.cmdStandby(a));
              s.aiNextAt = this.time + (lane ? 10 : 15); continue;
            }
          }
          if (a.needsPushback) ok = say(a, `${a.callsign} push back approved${rwy ? `, expect runway ${rwy}` : ''}`, makeAst('pushback', a.callsign, { dir: 'any', expectRunway: rwy ?? null, startup: true, tailTo: null }), this.cmdPushback(a, 'any', rwy ?? null, true, null));
          else ok = say(a, `${a.callsign} start-up approved${rwy ? `, expect runway ${rwy}` : ''}`, makeAst('startup', a.callsign, { expectRunway: rwy ?? null }), this.cmdStartup(a, rwy ?? null));
          break;
        case 'taxi': case 'intersection':
          if (rwy && this.taxiComing(a)) { s.aiNextAt = this.time + 6; continue; }                 // (one coming in on the same lane first)
          if (rwy) ok = taxi(a, { kind: 'runway', runway: rwy, intersection: null }, `runway ${rwy}`);
          break;
        case 'taxi_in': case 'return_to_stand': {
          if (a.plan.gateRef) ok = taxi(a, { kind: 'stand', ref: a.plan.gateRef }, `stand ${a.plan.gateRef}`);
          if (!ok) {
            // the stand is taken or unreachable from here: another free stand, a nearby one first
            const gate = this.freeStand({ prefer: a.plan.gateRef ?? null, type: a.perf.icaoCode });
            if (gate && gate.ref !== a.plan.gateRef && !('code' in this.planTaxi(a, { kind: 'stand', ref: gate.ref }, []))) { this.releaseStands(a); this.reserveStand(gate, a); a.plan.gateRef = gate.ref; ok = taxi(a, { kind: 'stand', ref: gate.ref }, `stand ${gate.ref}`); }
          }
          break;
        }
        case 'cross':
          if (a.holdShortRunway && this.aiCrossAllowed(a)) ok = say(a, `${a.callsign} cross runway ${a.holdShortRunway}`, makeAst('cross', a.callsign, { runway: a.holdShortRunway }), this.cmdCross(a, a.holdShortRunway, false, null));
          else { s.aiNextAt = this.time + 5; continue; }
          break;
        case 'with_you':
          // checking in on ground after the tower handoff: already taxiing -> acknowledge; otherwise give the taxi clearance
          if (a.path && a.path.total > 0 && (a.speed > 0.5 || this.sc(a).vacated || a.phase !== 'rollout')) { this.answerRequest(a, ['with_you'], 'ai'); this.emit('transmission', a, `AI GND: ${a.callsign} ${a.plan.kind === 'arrival' ? `continue to stand ${a.plan.gateRef ?? ''}` : `continue taxi${rwy ? `, runway ${rwy}` : ''}`}`, { type: 'transmission', ast: makeAst('roger', a.callsign, {}), result: { ok: true, code: 'ok_queued', transmission: '', readback: '' }, who: 'ai' }, 'AI'); ok = true; }
          else if (a.plan.kind === 'arrival' && a.plan.gateRef) ok = taxi(a, { kind: 'stand', ref: a.plan.gateRef }, `stand ${a.plan.gateRef}`);
          else if (rwy) ok = taxi(a, { kind: 'runway', runway: rwy, intersection: null }, `runway ${rwy}`);
          break;
        case 'radio_check': case 'runway_vacated': case 'say_again': case 'wind_check':
          ok = say(a, `${a.callsign} roger`, makeAst('roger', a.callsign, {}), this.cmdRoger(a));
          break;
        default:
          ok = say(a, `${a.callsign} unable`, makeAst('unable', a.callsign, { reason: 'traffic' }), this.cmdUnable(a, 'traffic'));
      }
      s.aiNextAt = this.time + (ok ? 8 : 20);
    }
  }
  private autoApproachStep() {
    this.aiAckEmergencies(['approach', 'departure'], 'APP');
    // departures on the approach / departure frequency: climb to the cruise level and release them from the TMA
    const say0 = (a: AircraftState, text: string, ast: CommandAST, r: EngineOutcome) => { if (r.ok) this.emit('transmission', a, `AI APP: ${text}`, { type: 'transmission', ast, result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI'); return r.ok; };
    this.aiDeconflict();
    for (const a of this.aircraft) {
      if (a.plan.kind !== 'departure' || !isAirborne(a) || (a.onFrequency !== 'approach' && a.onFrequency !== 'departure') || a.handedTo != null) continue;
      const s = this.sc(a); if (this.time < s.aiNextAt || a.pendingCmds.length || this.time < s.aiAvoidUntil) continue;
      const open = a.requests.find(q => q.answeredAt == null);
      const top = Math.max(9000, a.plan.cruiseAlt ?? 9000);
      if ((a.cmdAltitude ?? a.targetAltitude) < top && this.time - a.spawnedAt > 5 && !this.altitudeBlocked(a, top)) {
        if (say0(a, `${a.callsign} climb ${top}`, makeAst('altitude', a.callsign, { ft: top }), this.cmdAltitude(a, top, false, null))) { s.aiNextAt = this.time + 8; continue; }
      }
      if (open && open.kind !== 'higher') { say0(a, `${a.callsign} roger`, makeAst('roger', a.callsign, {}), this.cmdRoger(a)); s.aiNextAt = this.time + 8; continue; }
      // hand off to the centre once above 8,000 ft or beyond 20 NM (left the TMA above FL90 otherwise scores the same)
      // (not while it still has traffic in the band it is climbing through within 10 NM: with the centre nobody here can
      // stop its climb, and it met an arrival entering at 11,000)
      const climbingThrough = a.altitude < (a.cmdAltitude ?? a.targetAltitude) - 300 && dist(a.pos, this.centerXY) < this.airspaceRadiusM * 0.8 && this.altitudeBlocked(a, a.cmdAltitude ?? a.targetAltitude, 10);
      if (!climbingThrough && ((a.altitude >= 7500 && (a.cmdAltitude ?? a.targetAltitude) >= top) || dist(a.pos, this.centerXY) > Math.min(20 * NM_TO_M, this.airspaceRadiusM * 0.8))) {
        if (say0(a, `${a.callsign} contact centre`, makeAst('contact', a.callsign, { position: 'external', when: 'now' }), this.cmdHandoff(a, 'external', 'now'))) { s.aiNextAt = this.time + 30; continue; }
      }
      s.aiNextAt = this.time + 5;
    }
    this.aiSequenceArrivals();
  }

  /** Predicted closest approach of two airborne aircraft inside `horizonS` on their present tracks: distance (m) and time (s). */
  private cpa(a: AircraftState, b: AircraftState, horizonS = 90, hdgA: number | null = null): { dM: number; tS: number } {
    // on the heading being turned to (a prediction on the mid-turn heading sees a pair too late); `hdgA` tries a heading for `a`
    const vel = (x: AircraftState) => { const g = applyWind(this.wx(), x === a && hdgA != null ? hdgA : x.navMode === 'heading' || x.navMode === 'sid' ? x.targetHeading : x.heading, x.speed); const v = g.gsKt * KTS_TO_MPS; return { vx: Math.sin(g.trackTrue * Math.PI / 180) * v, vy: Math.cos(g.trackTrue * Math.PI / 180) * v }; };
    const va = vel(a), vb = vel(b);
    const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dvx = vb.vx - va.vx, dvy = vb.vy - va.vy;
    const dv2 = dvx * dvx + dvy * dvy;
    const tS = dv2 < 1e-6 ? 0 : Math.max(0, Math.min(horizonS, -(dx * dvx + dy * dvy) / dv2));
    return { dM: Math.hypot(dx + dvx * tS, dy + dvy * tS), tS };
  }
  /** True when a turn of `a` onto `hdg` would bring it within 3.8 NM of another aircraft less than 1,000 ft away inside 100 s. */
  private headingConflicts(a: AircraftState, hdg: number): boolean {
    // an arrival low in the pattern is not turned across a climb-out with a departure cleared, rolling or still climbing
    // on the tower frequency (on the ground it is no traffic to the CPA test, and two minutes later it is at 3,000 ft)
    if (a.plan.kind === 'arrival' && a.altitude < 5000) {
      const path = [30, 60, 90, 120].map(t => advance(a.pos, hdg, a.speed * KTS_TO_MPS * t));
      for (const rs of this.runways) {
        if (!rs.activeDep) continue;
        if (!this.aircraft.some(d => d.plan.kind === 'departure' && d.plan.runway === rs.name && (d.phase === 'takeoff' || d.takeoffCleared || (isAirborne(d) && d.altitude < 5000 && d.onFrequency === 'tower')))) continue;
        const r = this.ilsFor(rs.name); if (!r) continue;
        const out = [0, 2, 4, 6, 8].map(nm => advance(r.thrXY, r.rwdHdg, nm * NM_TO_M));
        if (path.some(q => out.some(p => dist(p, q) < 2.5 * NM_TO_M))) return true;
      }
    }
    return this.aircraft.some(b => b !== a && isAirborne(b) && (b.phase !== 'landing' || b.altitude > 1500) && !(a.ilsCaptured && b.ilsCaptured)
      // (altitude bands, present to cleared: a turn into somebody descending through this level is a turn into traffic)
      && Math.max(b.altitude, b.targetAltitude) > Math.min(a.altitude, a.targetAltitude) - 1000 && Math.min(b.altitude, b.targetAltitude) < Math.max(a.altitude, a.targetAltitude) + 1000 && (() => { const nu = this.cpa(a, b, 100, hdg).dM; return nu < 3.8 * NM_TO_M && nu <= this.cpa(a, b, 100).dM + 300; })());   // a pair already close may be turned onto a heading that opens it up
  }
  /** True when `a` cannot take a new altitude toward `toFt` without passing within 1,000 ft of another aircraft that
   *  is (or will be within 90 s) inside `nm` NM of it. */
  private altitudeBlocked(a: AircraftState, toFt: number, nm = 5, except: AircraftState | null = null): boolean {
    const lo = Math.min(a.altitude, toFt) - 900, hi = Math.max(a.altitude, toFt) + 900;
    return this.aircraft.some(b => b !== a && b !== except && isAirborne(b) && (b.phase !== 'landing' || b.altitude > 1500)
      && Math.max(b.altitude, b.targetAltitude) > lo && Math.min(b.altitude, b.targetAltitude) < hi
      && (dist(a.pos, b.pos) < nm * NM_TO_M || this.cpa(a, b, 120).dM < nm * NM_TO_M));
  }

  /**
   * Safety net under the assist's vectoring: any two airborne aircraft it is responsible for that are predicted to
   * come within 3.8 NM at less than 1,000 ft inside the next 100 s get an avoiding action - a climbing departure is
   * stopped 1,000 ft below the other, an arrival still descending stops its descent, otherwise the one later in the
   * sequence turns away. Normal vectoring resumes 30 s after the pair is clear.
   */
  private aiDeconflict(advise = false) {
    // the aircraft the assist can act on, and everybody else airborne it must keep them away from (a departure
    // already handed to the centre, an aircraft on the player's frequency)
    const mine = this.aircraft.filter(a => isAirborne(a) && a.phase !== 'landing' && (a.onFrequency === 'approach' || a.onFrequency === 'departure') && a.handedTo == null);
    const all = this.aircraft.filter(a => isAirborne(a) && (a.phase !== 'landing' || a.altitude > 1500));   // (the final inside 8 NM counts while it is still up in the pattern's levels)
    // (advising: nobody is told anything; the call is kept for the flight card of the player working Approach)
    const say = (a: AircraftState, text: string, ast: CommandAST, run: () => EngineOutcome, card: string) => {
      if (advise) { const q = this.sc(a); q.airAdvice = { cmd: `${a.callsign} ${card}`, until: this.time + 18 }; return true; }
      const r = run(); if (r.ok) this.emit('transmission', a, `AI APP: ${text}`, { type: 'transmission', ast, result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI'); return r.ok;
    };
    for (let i = 0; i < mine.length; i++) for (let j = 0; j < all.length; j++) {
      const a = mine[i], b = all[j];
      if (a === b) continue;
      const jm = mine.indexOf(b); if (jm >= 0 && jm < i) continue;                 // each controllable pair once
      if (this.reducedMinima(a, b)) continue;
      if (a.ilsCaptured && b.ilsCaptured) continue;                       // in trail on the final: spacing, not vectors
      const { dM: dcpa, tS: tcpa } = this.cpa(a, b, AI_CPA_S);
      // in trail behind a heavier aircraft the wake minimum (4-8 NM) is the separation, anywhere - not only on the final;
      // judged before the two are lined up (the score counts the pair once the trailer is within 0.5 NM of the track, by
      // which time it is already inside the minimum)
      const lt = this.wakeTrail(a, b);
      if (dcpa > Math.max(AI_CPA_NM, (lt?.nm ?? 0) + 0.6) * NM_TO_M) continue;
      // vertical: where each will be at the closest point, capped by its cleared altitude
      // (an aircraft on the glideslope descends at about 5.3 ft/min per knot whatever its cleared altitude says - read as
      // level it was taken for 1,000 ft above a crossing aircraft it was descending onto)
      const altAt = (x: AircraftState, t: number) => { if (x.gsCaptured) return Math.max(0, x.altitude - x.speed * 5.3 / 60 * t); const rate = (x.targetAltitude > x.altitude ? x.perf.maxClimbRate : -x.perf.maxDescentRate) / 60; const v = x.altitude + rate * t; return x.targetAltitude > x.altitude ? Math.min(v, x.targetAltitude) : Math.max(v, x.targetAltitude); };
      const nowV = Math.abs(a.altitude - b.altitude), thenV = Math.abs(altAt(a, tcpa) - altAt(b, tcpa));
      const crossing = (a.altitude - b.altitude) * (altAt(a, tcpa) - altAt(b, tcpa)) < 0;
      // in trail behind a heavier type, 1,000 ft only separates with the trailer above it (below, it sits in the wake):
      // the trailer is turned out of the trail instead of being stopped 1,000 ft below
      const wakePair = !!lt && lt.nm > HORIZ_SEP_NM + 0.01;
      const wakeVertOk = !lt || (lt.trailer.altitude >= lt.leader.altitude + 1000 && altAt(lt.trailer, tcpa) >= altAt(lt.leader, tcpa) + 1000);
      if (nowV >= 1000 && thenV >= 1000 && !crossing && (!wakePair || wakeVertOk)) continue;
      const sa = this.sc(a), sb = this.sc(b);
      // who gives way: a departure climbing into an arrival levels off below it; between arrivals the later one in the
      // sequence (higher rank / further out) acts
      const pick = (): [AircraftState, AircraftState] => {
        if (!mine.includes(b)) return [a, b];                                   // only one of them takes instructions
        if (a.plan.kind === 'departure' && b.plan.kind !== 'departure') return [a, b];
        if (b.plan.kind === 'departure' && a.plan.kind !== 'departure') return [b, a];
        if (a.ilsArmed !== b.ilsArmed) return a.ilsArmed ? [b, a] : [a, b];
        return (sa.aiRank ?? 99) >= (sb.aiRank ?? 99) ? [a, b] : [b, a];
      };
      const [x, y] = wakePair && !wakeVertOk && mine.includes(lt!.trailer) ? [lt!.trailer, lt!.leader] : pick();
      if (x.pendingCmds.length && y.pendingCmds.length) continue;
      const sx = this.sc(x), sy = this.sc(y);
      // vertical first: a climb stopped 1,000 ft below the other, or a descent stopped 1,000 ft above it - on either
      // aircraft; failing that the one giving way turns away from the other
      const stopClimb = (c: AircraftState, o: AircraftState): boolean => {
        if (c.pendingCmds.length || c.altitude >= o.altitude - 200 || c.targetAltitude <= c.altitude) return false;
        let cap = Math.floor((Math.min(o.altitude, o.targetAltitude) - 1000) / 1000) * 1000;
        while (cap >= c.altitude - 300 && this.altitudeBlocked(c, cap, 5, o)) cap -= 1000;    // not onto a level somebody else holds
        if (cap < c.altitude - 300 || cap >= c.targetAltitude) return false;
        return say(c, `${c.callsign} stop climb ${cap}, traffic`, makeAst('altitude', c.callsign, { ft: cap }), () => this.cmdAltitude(c, cap, false, null), `${cap >= c.altitude - 100 ? 'climb' : 'descend'} and maintain ${cap}`);
      };
      const stopDescent = (c: AircraftState, o: AircraftState): boolean => {
        if (c.pendingCmds.length || c.altitude <= o.altitude + 200 || c.targetAltitude >= c.altitude || (c.ilsCaptured && c.gsCaptured)) return false;
        let lvl = Math.ceil((Math.max(o.altitude, o.targetAltitude) + 1000) / 1000) * 1000;
        while (lvl <= c.altitude + 300 && this.altitudeBlocked(c, lvl, 5, o)) lvl += 1000;
        if (lvl > c.altitude + 300 || lvl <= c.targetAltitude) return false;
        return say(c, `${c.callsign} stop descent ${lvl}, traffic`, makeAst('altitude', c.callsign, { ft: lvl }), () => this.cmdAltitude(c, lvl, false, null), `${lvl <= c.altitude + 100 ? 'descend' : 'climb'} and maintain ${lvl}`);
      };
      // both level at the same altitude: an arrival steps down 1,000 ft (not below 3,000), a departure steps up 1,000 ft,
      // when that band is free of everybody else and there is time for it
      const levelAway = (c: AircraftState, o: AircraftState): boolean => {
        if (c.pendingCmds.length || nowV >= 500 || Math.abs(c.targetAltitude - c.altitude) > 150 || tcpa < 35) return false;
        const here = Math.round(c.altitude / 1000) * 1000;
        const to = c.plan.kind === 'departure' ? here + 1000 : here - 1000;
        if (Math.abs(to - o.targetAltitude) < 1000 || Math.abs(to - o.altitude) < 1000) return false;   // the other is on its way there
        if (to < 3000 || (c.plan.kind === 'departure' && to > Math.max(9000, c.plan.cruiseAlt ?? 9000)) || (c.ilsCaptured && c.gsCaptured)) return false;
        if (this.altitudeBlocked(c, to, 5, o)) return false;
        return say(c, `${c.callsign} ${to > here ? 'climb' : 'descend'} ${to}, traffic`, makeAst('altitude', c.callsign, { ft: to }), () => this.cmdAltitude(c, to, false, null), `${to > here ? 'climb' : 'descend'} and maintain ${to}`);
      };
      const levelApart = nowV >= 1000 && thenV >= 1000 && !crossing && (!wakePair || wakeVertOk);
      const wakeTurn = wakePair && !wakeVertOk;
      // an avoiding turn is held while the pair is still close - 90 s at most, and not into the boundary; a vertical
      // resolution only pauses the vectoring briefly
      if (this.time < sx.aiAvoidUntil) {
        const nearEdge = dist(x.pos, this.centerXY) > this.airspaceRadiusM - 4 * NM_TO_M;
        if (!levelApart && this.time < sx.aiAvoidFrom + 90 && !nearEdge) sx.aiAvoidUntil = this.time + 20;
        continue;
      }
      // (a vertical resolution holds for 90 s: the sequencer's level ladder climbed one straight back onto the other)
      if (!wakeTurn && (stopClimb(x, y) || stopDescent(x, y) || levelAway(x, y))) { sx.aiAlt = x.cmdAltitude; sx.aiAvoidUntil = this.time + 10; sx.aiAltHoldUntil = this.time + 90; sx.aiNextAt = this.time + 6; continue; }
      if (!wakeTurn && mine.includes(y) && (stopClimb(y, x) || stopDescent(y, x) || levelAway(y, x))) { sy.aiAlt = y.cmdAltitude; sy.aiAvoidUntil = this.time + 10; sy.aiAltHoldUntil = this.time + 90; sy.aiNextAt = this.time + 6; continue; }
      let done = false;
      if (!x.pendingCmds.length && (nowV < 1000 || crossing || wakeTurn)) {
        // turn away from the other's position, 60 to 90 degrees off the present heading; near the boundary the
        // turn is made toward the inside of the airspace instead
        const away = headingTo(y.pos, x.pos);
        const d = angleDelta(x.heading, away);
        let h = Math.abs(d) <= 90 ? away : (x.heading + (angleDelta(x.heading, headingTo(x.pos, y.pos)) >= 0 ? -90 : 90) + 360) % 360;   // the other on the right: turn left
        if (Math.abs(angleDelta(x.heading, h)) < 60) h = (x.heading + (d >= 0 ? 60 : -60) + 360) % 360;
        if (dist(x.pos, this.centerXY) > this.airspaceRadiusM - 8 * NM_TO_M) {
          const inward = headingTo(x.pos, this.centerXY);
          if (Math.abs(angleDelta(h, inward)) > 80) h = (inward + (angleDelta(inward, away) >= 0 ? 70 : -70) + 360) % 360;
        }
        const tru = Math.round(h) % 360, mag = ((tru - this.magVar) % 360 + 360) % 360;
        const alt = x.cmdAltitude ?? Math.round(x.altitude / 1000) * 1000;
        const o = () => x.ilsArmed ? this.cmdCancelApproach(x, tru, alt, null) : this.cmdHeading(x, tru, null, null);
        if (say(x, `${x.callsign} ${x.ilsArmed ? 'cancel approach, ' : ''}turn heading ${hdg3(mag)}, traffic`, x.ilsArmed ? makeAst('cancelApproach', x.callsign, { hdg: tru, alt, dir: null }) : makeAst('heading', x.callsign, { hdg: tru, dir: null, when: null }), o, x.ilsArmed ? `cancel approach clearance, fly heading ${hdg3(mag)}, maintain ${alt}` : `fly heading ${hdg3(mag)}`)) { sx.aiHdg = tru; sx.aiBase = null; sx.aiMode = null; done = true; }
      }
      if (done) { sx.aiAvoidUntil = this.time + 20; sx.aiAvoidFrom = this.time; sx.aiNextAt = this.time + 6; }
    }
  }

  /**
   * The assist as approach controller: it gives each arrival the calls of the arrival plan (arrivals.ts: order, landing
   * times, speed before distance, a longer way round before a hold), one at a time.
   */
  private aiSequenceArrivals() {
    const say = (a: AircraftState, text: string, ast: CommandAST, r: EngineOutcome) => { if (r.ok) this.emit('transmission', a, `AI APP: ${text}`, { type: 'transmission', ast, result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI'); return r.ok; };
    for (const a of this.aircraft) {
      if (a.plan.kind !== 'arrival' || !isAirborne(a) || a.phase === 'landing' || a.onFrequency !== 'approach' || !a.plan.runway) continue;
      const s = this.sc(a), p = arrivalPlan(this, a); if (!p || this.time < s.aiNextAt || a.pendingCmds.length) continue;
      s.aiMode = p.leg; s.aiRank = p.place; s.aiLevel = p.level;
      const rwy = p.rwy, req = a.requests.find(q => q.answeredAt == null);
      if (a.ilsCaptured || (a.ilsArmed && this.time - (s.aiClearedAt ?? -1e9) < 150 && req?.kind !== 'further')) {
        // on its approach still on this frequency: what it asked gets an answer (it flies the ILS as cleared)
        if (req) { if (req.kind === 'lower' || req.kind === 'higher' || req.kind === 'going_around') say(a, `${a.callsign} roger`, makeAst('roger', a.callsign, {}), this.cmdRoger(a)); else say(a, `${a.callsign} unable, continue the approach`, makeAst('unable', a.callsign, { reason: 'traffic' }), this.cmdUnable(a, 'traffic')); s.aiNextAt = this.time + 6; continue; }
        if (a.ilsCaptured && p.x > 5.5 && a.cmdIas !== p.kt && a.speed > p.kt + 6) { if (say(a, `${a.callsign} reduce speed ${p.kt}`, makeAst('speed', a.callsign, { kts: p.kt, untilNM: 5 }), this.cmdSpeed(a, p.kt, 5))) s.aiNextAt = this.time + 10; }
        continue;
      }
      if (this.time < s.aiAvoidUntil) continue;
      if (req?.kind === 'with_you') { say(a, `${a.callsign} radar contact, expect ILS ${rwy}`, makeAst('radarContact', a.callsign, { descendTo: null, expectRunway: rwy }), this.cmdRadarContact(a, null, rwy)); s.aiNextAt = this.time + 6; continue; }
      if (req && (req.kind === 'lower' || req.kind === 'higher' || req.kind === 'going_around')) { say(a, `${a.callsign} roger, expect ${req.kind === 'higher' ? 'higher' : 'lower'} shortly`, makeAst('roger', a.callsign, {}), this.cmdRoger(a)); s.aiNextAt = this.time + 4; continue; }
      if (req && req.kind !== 'further') { say(a, `${a.callsign} unable, expect vectors for the ILS`, makeAst('unable', a.callsign, { reason: 'traffic' }), this.cmdUnable(a, 'traffic')); s.aiNextAt = this.time + 6; continue; }
      const cur = a.cmdAltitude ?? a.targetAltitude;
      // holding: into the stack at its level, a new time when the wait has grown; it leaves when the plan turns it in
      if (p.leg === 'hold' && p.hold) {
        const h = p.hold, mm = String(Math.floor(h.efc / 60) % 60).padStart(2, '0');
        const hold = () => say(a, `${a.callsign} hold at ${h.fix} as published, expect further clearance at ${mm}`, makeAst('hold', a.callsign, { fix: h.fix, inbound: null, dir: null, legTimeMin: null, legNM: null, efc: h.efc }), this.cmdHold(a, h.fix, null, null, null, null, h.efc));
        if (!(a.navMode === 'hold' && a.holdFixName === h.fix) || req?.kind === 'further' || (a.holdEfc != null && h.efc > a.holdEfc + 120)) { if (hold()) { s.aiNextAt = this.time + 8; continue; } }
        if (this.time >= (s.aiAltHoldUntil ?? 0)) {
          const to = h.level < cur - 400 ? this.safeDescent(a, h.level) : h.level > cur + 400 ? this.safeClimb(a, h.level) : cur;
          if (Math.abs(to - cur) > 400 && say(a, `${a.callsign} ${to < cur ? 'descend' : 'climb'} ${to}`, makeAst('altitude', a.callsign, { ft: to }), this.cmdAltitude(a, to, false, null))) { s.aiAlt = to; s.aiNextAt = this.time + 6; continue; }
        }
        s.aiNextAt = this.time + 3; continue;
      }
      if (p.clear && !a.ilsArmed) { if (say(a, `${a.callsign} cleared ILS ${rwy}`, makeAst('ils', a.callsign, { runway: rwy }), this.cmdILS(a, rwy))) { s.aiNextAt = this.time + 12; s.aiClearedAt = this.time; continue; } }
      // the turn first: on the way in it cannot wait for the rest
      const head = a.navMode === 'heading' ? a.targetHeading : a.heading, turn = Math.abs(angleDelta(head, p.hdg));
      const due = turn > (p.leg === 'final' ? 5 : p.leg === 'base' ? 12 : 10) || req?.kind === 'further' || (a.ilsArmed && this.time - (s.aiClearedAt ?? -1e9) > 150);
      const deferred = s.aiDeferFrom != null && this.time - s.aiDeferFrom > 30;
      if (due) {
        const tru = Math.round(p.hdg) % 360, mag = ((tru - this.magVar) % 360 + 360) % 360, nearEdge = dist(a.pos, this.centerXY) > this.airspaceRadiusM - 5 * NM_TO_M;
        // (a vector into a neighbour is not given: the present heading a little longer, 30 s at most)
        if (!nearEdge && !deferred && turn > 12 && this.headingConflicts(a, tru)) { s.aiDeferFrom ??= this.time; }
        else {
          s.aiDeferFrom = null;
          const o = a.ilsArmed ? this.cmdCancelApproach(a, tru, cur, null) : this.cmdHeading(a, tru, null, null);
          if (say(a, `${a.callsign} ${a.ilsArmed ? 'cancel approach, ' : ''}fly heading ${hdg3(mag)}`, a.ilsArmed ? makeAst('cancelApproach', a.callsign, { hdg: tru, alt: cur, dir: null }) : makeAst('heading', a.callsign, { hdg: tru, dir: null, when: null }), o)) { s.aiHdg = tru; s.aiNextAt = this.time + 6; continue; }
        }
      }
      // down as far as the way is free: never into a level somebody near holds
      if (this.time >= (s.aiAltHoldUntil ?? 0)) {
        const to = this.safeDescent(a, p.level);
        // (broken off beside the final: up, out of the way of the next one coming down it)
        const up = !p.go && (p.leg === 'out' || cur < 2900) && cur < 3900 ? (!this.altitudeBlocked(a, 4000) ? 4000 : cur < 2900 && !this.altitudeBlocked(a, 3000) ? 3000 : 0) : 0;
        if (up > cur + 400) { if (say(a, `${a.callsign} climb ${up}`, makeAst('altitude', a.callsign, { ft: up }), this.cmdAltitude(a, up, false, null))) { s.aiAlt = up; s.aiNextAt = this.time + 6; continue; } }
        else if (to < cur - 400) { if (say(a, `${a.callsign} descend ${to}`, makeAst('altitude', a.callsign, { ft: to }), this.cmdAltitude(a, to, false, null))) { s.aiAlt = to; s.aiNextAt = this.time + 6; continue; } }
      }
      if (p.kt && a.cmdIas !== p.kt && (a.speed > p.kt + 6 || (a.cmdIas != null && p.kt > a.cmdIas + 9 && p.leg !== 'final'))) {
        if (say(a, `${a.callsign} ${a.speed > p.kt ? 'reduce speed' : 'speed'} ${p.kt}`, makeAst('speed', a.callsign, { kts: p.kt, untilNM: null }), this.cmdSpeed(a, p.kt, null))) { s.aiNextAt = this.time + 6; continue; }
      }
      s.aiNextAt = this.time + 2;
    }
  }
  /** An avoiding action the flight card shows (player working Approach): what to say, or that one given is being held. */
  airAdvice(a: AircraftState): { cmd: string | null } | null {
    const s = this.sc(a); if (s.airAdvice && this.time < s.airAdvice.until) return { cmd: s.airAdvice.cmd };
    return this.time < s.aiAvoidUntil ? { cmd: null } : null;
  }
  /** A turn on to `hdg` that would put it into a neighbour (the flight card waits with it). */
  turnBlocked(a: AircraftState, hdg: number): boolean { const s = this.sc(a); if (!this.headingConflicts(a, hdg)) { s.aiDeferFrom = null; return false; } s.aiDeferFrom ??= this.time; return this.time - s.aiDeferFrom < 25; }
  /** Somebody else cleared to land on this runway, where only one at a time may be. */
  landsFirst(a: AircraftState, runway: string): string | null { const rs = this.runwayState(runway); return this.settings.region === 'ICAO' && rs && rs.landingClearances.length && !rs.landingClearances.includes(a.callsign) ? rs.landingClearances[0] : null; }
  /** Told to continue its approach without a landing clearance yet. */
  continuing(a: AircraftState): boolean { return this.sc(a).continueApproach; }
  /** Somebody taxiing in against the first part of this departure's way out, with nowhere to pass: it is let by first (an
   *  arrival has nowhere else to wait; the departure is off the lanes yet). Two and a half minutes at most. */
  taxiComing(a: AircraftState): AircraftState | null {
    if (a.phase !== 'startup' || !a.plan.runway) return null; const s = this.sc(a);
    const q = a.requests.find(r => r.answeredAt == null && r.kind === 'taxi'); if (q && this.time - q.at > 150) return null;
    if (s.coming && this.time - s.coming.at < 4) return this.byId(s.coming.id) ?? null;
    s.coming = { at: this.time, id: -1 };
    const plan = this.planTaxi(a, { kind: 'runway', runway: a.plan.runway, intersection: null }, []); if ('code' in plan) return null;
    const mine = new Map<string, XY>(); let m = 0;
    for (let i = 1; i < plan.ids.length && m < 800; i++) { const u = this.nodeXY(plan.ids[i - 1])!, v = this.nodeXY(plan.ids[i])!; m += dist(u, v); mine.set(`${plan.ids[i]}>${plan.ids[i - 1]}`, { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 }); }
    for (const b of this.aircraft) {
      if (b === a || b.phase !== 'taxi' || !b.path || b.speed < 1.5 || this.sc(b).tow) continue; const ids = this.sc(b).routeIds; if (!ids) continue;
      let near = Infinity, n = 0;
      for (let i = 1; i < ids.length; i++) { const p = mine.get(`${ids[i - 1]}>${ids[i]}`); if (!p) continue; const pr = projectOntoPath(b.path.pts, b.path.cum, p, b.distAlong), ahead = pr.at - b.distAlong; if (ahead < 5 || dist(sampleAlong(b.path.pts, b.path.cum, pr.at).pos, p) > 12) continue; n++; near = Math.min(near, ahead); }
      if (n && near < 650) { s.coming.id = b.id; return b; }
    }
    return null;
  }
  /** Off this runway or a parallel one, still too close for the next take-off: a departure rolling or climbing out (2.5 NM; 4.5 behind a heavy), or one going around. */
  departureAlongside(runway: string, except?: AircraftState): AircraftState | null {
    const rs = this.runwayState(runway), thr = this.thresholdXY(runway); if (!rs || !thr) return null;
    return this.aircraft.find(b => b !== except && b.plan.runway && b.altitude < 4000 && Math.abs(angleDelta(this.runwayState(b.plan.runway)?.headingTrue ?? 0, rs.headingTrue)) < 20
      && (b.plan.kind === 'departure' ? (b.phase === 'takeoff' || b.phase === 'climb' || b.takeoffCleared || b.pendingCmds.some(c => c.kind === 'takeoff')) && dist(b.pos, thr) < (b.wakeCategory === 'HEAVY' || b.wakeCategory === 'SUPER' || b.perf.b757 ? 4.5 : 2.5) * NM_TO_M
        : b.goAround && isAirborne(b) && !b.ilsCaptured && dist(b.pos, thr) < 4 * NM_TO_M)) ?? null;
  }
  /** An arrival being vectored low across this runway's climb-out. */
  climbOutBusy(runway: string): boolean { return !!this.lowTrafficOnClimbOut(runway); }
  /** The highest level up to `top` a departure can be given: clear of everybody near on the way up. */
  safeClimb(a: AircraftState, top: number): number {
    const cur = a.cmdAltitude ?? a.targetAltitude;
    for (let to = top; to > cur + 500; to = Math.ceil(to / 1000) * 1000 - 1000) if (!this.altitudeBlocked(a, to)) return to;
    return cur;
  }
  /** The lowest level down to `level` this arrival can be given: clear of everybody near on the way down, and not a level another arrival within 8 NM holds. */
  safeDescent(a: AircraftState, level: number): number {
    const cur = a.cmdAltitude ?? a.targetAltitude; if (level >= cur) return cur;
    for (let to = level; to < cur; to += 1000) {
      if (this.altitudeBlocked(a, to, DESCENT_CLEAR_NM)) continue;
      if (this.aircraft.some(b => b !== a && b.plan.kind === 'arrival' && isAirborne(b) && !b.ilsCaptured && Math.abs((b.cmdAltitude ?? b.targetAltitude) - to) < 500 && dist(a.pos, b.pos) < 8 * NM_TO_M)) continue;
      return to;
    }
    return cur;
  }
  // ── what the arrival plan asks of the field (arrivals.ts) ──
  sameStrip(r1: string, r2: string): boolean { return this.refOf(r1) === this.refOf(r2); }
  /** Parallel runways under 760 m apart: one runway as far as wake goes. */
  closeParallel(r1: string, r2: string): boolean {
    if (r1 === r2) return true; if (!this.sameDirection(r1, r2)) return false; const a = this.ilsFor(r1), b = this.ilsFor(r2);
    return !!a && !!b && Math.abs(crossTrackM(b.thrXY, a)) < 760;
  }
  sameDirection(r1: string, r2: string): boolean { return Math.abs(angleDelta(this.runwayHeading(r1), this.runwayHeading(r2))) < 15; }
  wakeFinalNM(lead: AircraftState, trail: AircraftState): number { return WAKE_FINAL_NM[lead.perf.b757 ? 'HEAVY' : lead.wakeCategory][trail.wakeCategory]; }
  headwindOn(runway: string): number { const w = this.wx(); return Math.max(-15, Math.min(30, windComponents(w.windDirTrue, w.windKt, this.runwayHeading(runway)).headKt)); }
  glideAltFt(runway: string, alongNM: number): number { const r = this.ilsFor(runway); return r ? gsAltFt(alongNM * NM_TO_M, r) : 3000; }
  /** How far out along the final the pattern fits inside the airspace (NM). */
  finalRoomNM(runway: string): number {
    const r = this.ilsFor(runway); if (!r) return 18;
    let d = 12; while (d < 40 && [5, -5].every(x => dist(advance(advance(r.thrXY, featherHdg(r), (d + 1) * NM_TO_M), (r.rwdHdg + 90) % 360, x * NM_TO_M), this.centerXY) < this.airspaceRadiusM - 2 * NM_TO_M)) d += 1;
    return d;
  }
  /** Flying `hdg` for two minutes keeps it `nm` inside the airspace. */
  insideBy(a: AircraftState, hdg: number, nm: number): boolean { return dist(advance(a.pos, hdg, a.speed * KTS_TO_MPS * 100), this.centerXY) < this.airspaceRadiusM - nm * NM_TO_M; }
  /** A departure is waiting for (or on its way to) this runway or one that crosses it: the arrivals leave it a gap. */
  departureWaits(runway: string): boolean {
    const rs = this.runwayState(runway); if (!rs) return false;
    if (this.aircraft.some(d => d.phase === 'hold_short' && !!d.holdShortRunway && !d.holdReleased && this.refOf(d.holdShortRunway) === rs.ref)) return true;      // (or to cross it)
    return this.aircraft.some(d => d.plan.kind === 'departure' && d.plan.runway && (d.phase === 'lineup' || d.phase === 'hold_short' || (d.phase === 'taxi' && !!d.path && d.path.total - d.distAlong < 700)) && (this.refOf(d.plan.runway) === rs.ref || rs.intersects.includes(this.refOf(d.plan.runway) ?? '')));
  }

  // ── retire finished flights ────────────────────────────────────────────────
  private retire() {
    for (const a of [...this.aircraft]) {
      if (!isAirborne(a)) continue;
      const d = dist(a.pos, this.centerXY);
      if (a.plan.kind === 'departure') {
        if (d > this.airspaceRadiusM * 0.92) {
          if (a.phase === 'departed' || a.onFrequency === 'external') { this.emit('departed', a, `${a.callsign} left the TMA`); this.remove(a.id, 'departed'); }
          else if (a.altitude >= 9000) { this.emit('departed', a, `${a.callsign} left the TMA above FL90`); this.addScore('DEPARTED_HANDOFF', a.callsign, null, null, 'exit above FL90'); this.remove(a.id, 'departed'); }
          else { this.emit('diversion', a, `${a.callsign} DIVERSION — left airspace below FL90 without handoff`); this.addScore('DIVERSION_UNHANDLED', a.callsign, null, null, 'unhandled exit'); this.stats.diversions++; this.remove(a.id, 'diversion'); }
        }
      } else {
        const s = this.sc(a);
        if (d < this.airspaceRadiusM) s.enteredAirspace = true;
        if (this.time - a.spawnedAt <= 30 || d <= this.airspaceRadiusM * 1.05) continue;
        // Outside the boundary: a diversion once it has been inside, or when it is flying away from the field
        // (a spawn queued behind a busy entry starts outside and is still inbound - B3/B11).
        const outbound = Math.abs(angleDelta(a.heading, headingTo(a.pos, this.centerXY))) > 90;
        if (!s.enteredAirspace && !outbound && this.time - a.spawnedAt < 240) continue;
        this.emit('diversion', a, `${a.callsign} DIVERSION — exited airspace`);
        this.addScore('DIVERSION', a.callsign, null, null, 'exited airspace');
        this.stats.diversions++;
        this.remove(a.id, 'diversion');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Separation / incursions / alerts (once per frame)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Required lateral separation for a pair (NM): 3 NM radar (2.5 on the same final inside 10 NM, dry), or the wake matrix when in trail. */
  requiredSepNM(a: AircraftState, b: AircraftState): number {
    let base = HORIZ_SEP_NM;
    const sameFinal = a.ilsCaptured && b.ilsCaptured && a.assignedRunway && a.assignedRunway === b.assignedRunway;
    if (sameFinal && this.settings.reducedFinalSep && this.wx().runwayCondition === 'dry') {
      const da = this.distToThresholdNM(a, a.assignedRunway!) ?? 99, db = this.distToThresholdNM(b, a.assignedRunway!) ?? 99;
      if (da < 10 && db < 10) base = REDUCED_FINAL_NM;
    }
    const lt = this.leaderTrailer(a, b);
    if (!lt) return base;
    const leadCat: WakeCategory = lt.leader.perf.b757 ? 'HEAVY' : lt.leader.wakeCategory;
    return Math.max(base, WAKE_FINAL_NM[leadCat][lt.trailer.wakeCategory]);
  }
  /** In-trail geometry: same track (+-30 deg), trailer within 0.5 NM laterally of the leader's track and at/below the leader + 1000 ft. */
  /** Same direction (30 deg), one behind the other, the trailer not 1,000 ft above: the pair and its wake minimum (NM) -
   *  leaderTrailer() without the 0.5 NM track tolerance, for the conflict net to act before the trailer lines up. */
  private wakeTrail(a: AircraftState, b: AircraftState): { leader: AircraftState; trailer: AircraftState; nm: number } | null {
    if (Math.abs(angleDelta(a.heading, b.heading)) > 30) return null;
    const aAhead = alongTrack(a.pos, b.pos, b.heading) > 0;
    const leader = aAhead ? a : b, trailer = aAhead ? b : a;
    if (trailer.altitude > leader.altitude + 1000) return null;
    return { leader, trailer, nm: WAKE_FINAL_NM[leader.perf.b757 ? 'HEAVY' : leader.wakeCategory][trailer.wakeCategory] };
  }
  private leaderTrailer(a: AircraftState, b: AircraftState): { leader: AircraftState; trailer: AircraftState } | null {
    if (Math.abs(angleDelta(a.heading, b.heading)) > 30) return null;
    const aAhead = alongTrack(a.pos, b.pos, b.heading) > 0;
    const leader = aAhead ? a : b, trailer = aAhead ? b : a;
    if (Math.abs(crossTrack(trailer.pos, leader.pos, leader.heading)) > 0.5 * NM_TO_M) return null;
    if (trailer.altitude > leader.altitude + 1000) return null;
    return { leader, trailer };
  }
  /** Reduced-minima exceptions (03 §8): independent parallel ILS, both on final < 1600 ft, diverging departures >= 15 deg, 60 s go-around grace. */
  reducedMinima(a: AircraftState, b: AircraftState): boolean {
    const refA = a.assignedRunway ? this.refOf(a.assignedRunway) : null, refB = b.assignedRunway ? this.refOf(b.assignedRunway) : null;
    if (a.ilsCaptured && b.ilsCaptured && refA && refB && refA !== refB && Math.abs(angleDelta(this.runwayHeading(a.assignedRunway!), this.runwayHeading(b.assignedRunway!))) < 15) return true;
    const onFinal = (x: AircraftState) => x.phase === 'landing' || (x.ilsCaptured && x.gsCaptured);
    if (onFinal(a) && onFinal(b) && refA !== refB && a.altitude < 1600 && b.altitude < 1600) return true;
    const dep = (x: AircraftState) => x.plan.kind === 'departure' && x.delay.airborneAt != null && this.time - x.delay.airborneAt < 180;
    if (dep(a) && dep(b) && Math.abs(angleDelta(a.heading, b.heading)) >= 15) return true;
    const ga = (x: AircraftState) => x.goAround && this.sc(x).gaAt != null && this.time - this.sc(x).gaAt! < 60;
    if (ga(a) || ga(b)) return true;
    // Segregated parallel operations (Doc 4444 6.7.3): a departure in its initial climb vs an aircraft on final to /
    // landing on a parallel runway is protected by the runway separation, not by the radar minimum.
    const initialClimb = (x: AircraftState) => x.plan.kind === 'departure' && !x.ilsArmed && x.delay.airborneAt != null && this.time - x.delay.airborneAt < 180 && !!x.plan.runway;
    const onFinalTo = (x: AircraftState) => (x.phase === 'landing' || x.ilsCaptured) && (x.assignedRunway ?? x.plan.runway ?? null);
    const parallelPair = (dep: AircraftState, arr: AircraftState) => {
      const rwA = arr.assignedRunway ?? arr.plan.runway!, rwD = dep.plan.runway!;
      const refA = this.refOf(rwA), refD = this.refOf(rwD);
      return !!refA && !!refD && refA !== refD && Math.abs(angleDelta(this.runwayHeading(rwA), this.runwayHeading(rwD))) < 15;
    };
    if (initialClimb(a) && onFinalTo(b) && parallelPair(a, b)) return true;
    if (initialClimb(b) && onFinalTo(a) && parallelPair(b, a)) return true;
    if (a.emergency?.type === 'depressurization' && this.time - a.emergency.declaredAt < 60 || b.emergency?.type === 'depressurization' && this.time - b.emergency.declaredAt < 60) return true;
    return false;
  }
  private checkSeparation() {
    for (const a of this.aircraft) a.conflict = false;
    const now = new Set<string>(); const list = this.aircraft;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]; const d = dist(a.pos, b.pos);
      const airA = isAirborne(a), airB = isAirborne(b);
      if (!airA && !airB) {
        // apron / taxiway spacing (parked pairs excluded: stands are close together)
        const stat = (x: AircraftState) => x.phase === 'parked' || x.phase === 'arrived' || x.phase === 'startup';
        if (stat(a) && stat(b)) continue;
        if (d < (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.6 && !(stat(a) || stat(b))) {
          a.conflict = b.conflict = true; const k = pairKey(a.id, b.id); now.add(k);
          if (!this.conflictPairs.has(k)) {
            const rel = Math.abs(a.speed - b.speed) + (a.speed > 0.5 && b.speed > 0.5 ? Math.min(a.speed, b.speed) : 0);
            if (d < (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.35 && rel > 5) { this.emit('ground_conflict', a, `GROUND COLLISION: ${a.callsign} / ${b.callsign}`); this.addScore('COLLISION_GND', a.callsign, b.callsign); }
            else { this.emit('ground_conflict', a, `GROUND CONFLICT: ${a.callsign} / ${b.callsign}`); this.addScore('GROUND_CONFLICT', a.callsign, b.callsign); }
          }
        }
      } else if (airA && airB) {
        // air-ground pairs are excluded (runway protection is the incursion domain)
        if (a.phase === 'departed' && b.phase === 'departed') continue;
        const reqNM = this.requiredSepNM(a, b);
        if (this.reducedMinima(a, b)) continue;
        // Mode C reports in 100 ft increments: an aircraft settling at 3,990 ft is at 4,000 for the controller (03 §3)
        const vert = Math.abs(Math.round(a.altitude / 100) - Math.round(b.altitude / 100)) * 100;
        if (d < 0.1 * NM_TO_M && vert < 200) {
          const k = pairKey(a.id, b.id);
          if (!this.conflictPairs.has(k)) { this.emit('separation_loss', a, `MID-AIR COLLISION: ${a.callsign} / ${b.callsign}`); this.addScore('COLLISION_AIR', a.callsign, b.callsign); }
          now.add(k); a.conflict = b.conflict = true; continue;
        }
        if (d < reqNM * NM_TO_M && vert < VERT_SEP_FT) {
          a.conflict = b.conflict = true; const k = pairKey(a.id, b.id); now.add(k);
          if (!this.conflictPairs.has(k)) {
            const lt = this.leaderTrailer(a, b);
            const wake = lt && WAKE_FINAL_NM[lt.leader.perf.b757 ? 'HEAVY' : lt.leader.wakeCategory][lt.trailer.wakeCategory] > HORIZ_SEP_NM && d >= HORIZ_SEP_NM * NM_TO_M;
            if (wake && lt) {
              this.emit('separation_loss', lt.trailer, `WAKE SEPARATION: ${lt.trailer.callsign} ${(d / NM_TO_M).toFixed(1)} NM behind ${lt.leader.callsign} (${lt.leader.wakeCategory}), ${reqNM} NM required`);
              this.addScore('WAKE_FINAL', lt.trailer.callsign, lt.leader.callsign, lt.trailer.assignedRunway ?? null, `${(d / NM_TO_M).toFixed(1)} NM`);
              if (d < (reqNM - 1) * NM_TO_M && (lt.trailer.phase === 'landing' || lt.trailer.gsCaptured)) this.initiateGoAround(lt.trailer, `wake turbulence, ${lt.leader.callsign} ahead`, true, null);
            } else {
              this.emit('separation_loss', a, `SEPARATION LOSS: ${a.callsign} / ${b.callsign} ${(d / NM_TO_M).toFixed(1)} NM / ${Math.round(vert)} ft`);
              this.addScore('SEPARATION_LOSS', a.callsign, b.callsign, null, `${(d / NM_TO_M).toFixed(1)} NM / ${Math.round(vert)} ft`);
            }
          }
        }
      }
    }
    this.conflictPairs = now;
  }
  /** Runway strip entered by an aircraft without a clearance for that runway (or while an arrival is inside 2 NM). Returns the runway ref. */
  onRunwayWithoutClearance(id: number | string): string | null {
    if (typeof id === 'string') {
      const v = this.fleet.byId(id); if (!v || !v.onRunway) return null;
      const rs = this.bothEnds(v.onRunway)[0]; if (!rs) return null;
      const arr = this.arrivalOnFinal(rs.name, 2);
      if (arr || this.rollingDeparture(rs.name)) return v.onRunway;
      return rs.occupiedBy.some(o => o.id === v.id) ? null : v.onRunway;
    }
    const a = this.byId(id); if (!a || isAirborne(a) || a.phase === 'parked' || a.phase === 'arrived' || a.phase === 'startup') return null;
    const s = this.sc(a);
    const refs = this.runwaysAt(a.pos);
    const authorisedOn = (ref: string) => {
      const rs = this.bothEnds(ref)[0];
      return rs.occupiedBy.some(o => o.id === a.id) || s.crossingRef === ref || s.onRunwayRef === ref || (!!a.plan.runway && this.refOf(a.plan.runway) === ref && (a.phase === 'takeoff' || a.phase === 'lineup' || a.phase === 'rollout'));
    };
    const cleared = refs.filter(authorisedOn);
    // a stand that itself lies inside a strip (a short runway with parking alongside): leaving or reaching it is not an incursion
    const gate = a.plan.gateRef ? this.gateByRef(a.plan.gateRef) : undefined;
    const gxy = gate ? this.gateXY(gate) : null;
    for (const ref of refs) {
      const rs = this.bothEnds(ref)[0];
      if (!cleared.includes(ref) && gxy && this.distToRunway(gxy, ref) < STRIP_HALF_M + 30 && dist(a.pos, gxy) < 150 && !this.arrivalOnFinal(rs.name, 2) && !this.rollingDeparture(rs.name)) continue;
      if (!cleared.includes(ref)) {
        // the intersection box of a runway the aircraft IS cleared on (landing roll / takeoff through a crossing runway) is not an incursion
        if (cleared.some(c => rs.intersects.includes(c) || this.bothEnds(c)[0].intersects.includes(ref))) continue;
        // stopped at the hold line of this runway as instructed (the line itself sits at the strip edge): not an incursion
        if (a.phase === 'hold_short' && a.speed < 1 && a.holdShortRunway && this.refOf(a.holdShortRunway) === ref && !this.arrivalOnFinal(rs.name, 2)) continue;
        return ref;
      }
      const arr = this.arrivalOnFinal(rs.name, 2);
      if (arr && arr.a.id !== a.id && (s.crossingRef === ref || a.phase === 'taxi')) return ref;
    }
    return null;
  }
  private checkIncursions() {
    for (const a of this.aircraft) {
      const ref = this.onRunwayWithoutClearance(a.id);
      if (!ref) continue;
      const rs = this.bothEnds(ref)[0];
      const arr = this.arrivalOnFinal(rs.name, 2);
      const ev = this.addScore('RWY_INCURSION', a.callsign, arr?.callsign ?? null, rs.name, arr ? `on ${ref} with ${arr.callsign} ${arr.nm.toFixed(1)} NM final` : `on ${ref} without clearance`);
      if (ev) this.emit('ground_conflict', a, `RUNWAY INCURSION: ${a.callsign} on ${ref}${arr ? ` with ${arr.callsign} on final` : ''}`);
      this.safe('alerts', () => this.alerts.raise('runway_incursion', arr ? [a.callsign, arr.callsign] : [a.callsign], `Runway incursion ${ref}`, ev?.detail ?? '', this.time, { runway: rs.name }, [a.id]), undefined);
    }
  }
  private stepAlerts(dt: number) {
    if (!this.sys.alerts) return;
    const ctx: AlertStepCtx = {
      time: this.time,
      requiredSepNM: (a, b) => this.requiredSepNM(a, b),
      reducedMinima: (a, b) => this.reducedMinima(a, b),
      // no terrain database: the default floor outside the terminal area applies (alerts.ts msawDefaultFloorFt / msawNearNM)
      msaAt: () => null,
      centerXY: this.centerXY,
      airspaceRadiusM: this.airspaceRadiusM,
      onRunwayWithoutClearance: (id) => this.onRunwayWithoutClearance(id),
      arrivalOnFinal: (rw, nm) => this.arrivalOnFinal(rw, nm)?.callsign ?? null,
      rollingDeparture: (rw) => this.rollingDeparture(rw),
      wakeTimerRemainingS: (rw) => this.wakeTimerRemainingS(rw),
    };
    const vehicles = this.safe('fleet', () => this.fleet.list(), [] as Vehicle[]);
    const res = this.safe('alerts', () => this.alerts.step(this.aircraft, vehicles, this.runways, dt, ctx), null);
    if (!res) return;
    for (const ev of res.events) this.pushEvent(ev);
    for (const al of res.resolved) if (al.kind === 'stca' && al.predicted) this.addScore('STCA_RESOLVED', al.subjects[0], al.subjects[1] ?? null);
  }
  activeAlerts(): Alert[] { return this.safe('alerts', () => this.alerts.active(), [] as Alert[]); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Test / store views
  // ═══════════════════════════════════════════════════════════════════════════
  viewOf(a: AircraftState): AircraftView {
    return {
      id: a.id, callsign: a.callsign, type: a.perf.icaoCode, phase: a.phase, stage: this.stageOf(a), plan: { ...a.plan },
      pos: { x: a.pos.x, y: a.pos.y }, heading: a.heading, speed: a.speed, altitude: a.altitude,
      targetHeading: a.targetHeading, targetSpeed: a.targetSpeed, targetAltitude: a.targetAltitude,
      cmdAltitude: a.cmdAltitude, cmdIas: a.cmdIas, expedite: a.expedite, navMode: a.navMode,
      ilsArmed: a.ilsArmed, ilsCaptured: a.ilsCaptured, gsCaptured: a.gsCaptured, assignedRunway: a.assignedRunway,
      holdFixName: a.holdFixName, holdPhase: a.holdPhase, directTargetName: a.directTargetName,
      conflict: !!a.conflict, trafficHold: a.trafficHold, holdReleased: a.holdReleased, takeoffCleared: a.takeoffCleared,
      pendingCmds: a.pendingCmds.map(c => ({ ...c })), pathTotal: a.path?.total ?? 0, distAlong: a.distAlong, taxiRoute: [...(a.plan.taxiRoute ?? [])],
      attention: a.attention, underControl: a.underControl,
      wakeCategory: a.wakeCategory, requests: a.requests.map(r => ({ ...r })), emergency: a.emergency ? { ...a.emergency, checklist: { ...a.emergency.checklist }, requests: [...a.emergency.requests] } : null,
      landingCleared: a.landingCleared, holdShortNode: a.holdShortNode, holdShortRunway: a.holdShortRunway, onFrequency: a.onFrequency, handedTo: a.handedTo,
      goAround: a.goAround, squawk: a.squawk, pushbackStage: a.pushback.stage, startupReadyAt: a.startup.readyAt, reservedStand: a.reservedStand, fuelMin: a.fuelMin,
    };
  }
  snapshotForTest(): AircraftView[] { return this.aircraft.map(a => this.viewOf(a)); }
  /** Wake timers per runway end (test API shape). */
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }> {
    const out: Record<string, { runway: string; leader: string; remainingS: number }> = {};
    for (const rs of this.runways) if (rs.wakeTimer && rs.wakeTimer.expiresAt > this.time) out[rs.name] = { runway: rs.name, leader: rs.wakeTimer.leader, remainingS: Math.ceil(rs.wakeTimer.expiresAt - this.time) };   // ceil: what the countdown in the UI shows
    return out;
  }
  /** Distance (m) to the next hold on the aircraft's path, null when none (ActionCtx.distToNextHoldM). */
  distToNextHold(a: AircraftState): { m: number; runway: string | null; isCrossing: boolean } | null {
    const h = a.path?.holds?.[0]; if (!h || a.holdReleased) return null;
    return { m: Math.max(0, h.at - a.distAlong), runway: h.runway || null, isCrossing: !h.isDepartureEntry && !!h.runway };
  }
  /** Runways whose centrelines are parallel to `runway` (within 10 deg), other physical runways only. */
  parallelRunways(runway: string): string[] {
    const rs = this.runwayState(runway); if (!rs) return [];
    return this.runways.filter(r => r.ref !== rs.ref && Math.abs(angleDelta(r.headingTrue, rs.headingTrue)) < 10).map(r => r.name);
  }
  /** Physically on a runway strip (ActionCtx.onRunway). */
  isOnRunway(a: AircraftState): boolean { return !isAirborne(a) && this.runwaysAt(a.pos).length > 0; }
}

function pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
function rawLength(air: OsmAirport, ids: string[]): number {
  let m = 0;
  for (let i = 0; i < ids.length - 1; i++) { const n = air.nodes.get(ids[i]); const e = n?.edges.find(x => x.to === ids[i + 1]); if (e) m += e.meters; }
  return m;
}
function describeTarget(t: VehicleTarget): string {
  switch (t.kind) { case 'runway': return `runway ${t.runway}`; case 'aircraft': return t.callsign; case 'stand': return `stand ${t.ref}`; case 'point': return 'map point'; case 'station': return 'station'; }
}
