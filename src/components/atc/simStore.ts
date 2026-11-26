// ============================================================
//  simStore — the single bridge between the pure engine (src/lib/sim) and the
//  React game UI / canvas renderers (00-MASTER-PLAN §2.1, 06-CONTRACTS §2, §7).
//
//  Owns: ONE SimEngine (+ the parsed airspace projected into engine XY), the
//  RAF loop (never in test mode), `step()` (engine.update + event routing +
//  autospawn + persistence), the comm log, toasts, selection / hover, the
//  position tab, settings (persisted), start-config consumption, the test API
//  installation (window.__atcTest) and the render-hook registry the canvas
//  views use for screen projection.
//
//  Emit policy (binding for the UI): every discrete mutation emits at once
//  (version++ and subscribers notified); the RAF loop emits every 6th frame
//  (~10 Hz) so live numbers update; canvas views read `sim` directly in their
//  own RAF and never re-render React per frame.
//
//  Relative imports on purpose: this file is also compiled by the headless
//  node:test runner (scripts/test-sim.sh) which ignores tsconfig path aliases.
// ============================================================
import { setVoiceStress } from '../../lib/tts/pilotSpeech';
import { stressOf } from '../../lib/sim/persona';
import { useRef, useSyncExternalStore } from 'react';
import { SimEngine, AirspaceConfig, FIXED } from '../../lib/sim/engine';
import { buildOsmAirport } from '../../lib/osmAirport';
import type { OsmAirport } from '../../lib/osmAirport';
import { loadEndlessAirport, coordToXY } from '../../lib/airspace/eairport';
import type { EAirport } from '../../lib/airspace/eairport';
import { setSeed, rf, chance } from '../../lib/sim/rng';
import { profileOf } from '../../lib/sim/airlines';
import { advance, headingTo, NM_TO_M } from '../../lib/sim/projection';
import type { XY } from '../../lib/sim/projection';
import type { ILSRunway } from '../../lib/sim/ils';
import type { WeightClass } from '../../lib/sim/aircraftDB';
import { executeText, twoCallsIn, dispatch, fromEngine, actionCtxFromEngine, isSilent } from '../../lib/sim/dispatch';
import type { DispatchResult } from '../../lib/sim/dispatch';
import { telephony as phraseTelephony } from '../../lib/sim/phraseology';
import { suggest as suggestText } from '../../lib/sim/commands';
import type { Suggestion } from '../../lib/sim/commands';
import { actionsFor as treeActionsFor, stepsFor as treeStepsFor, validate as treeValidate, toAst, undoable, canUndo } from '../../lib/sim/commandTree';
import type { ActionCtx, ActionRow, PickerStep, ActionParams, ValidationResult, ActionId } from '../../lib/sim/commandTree';
import { makeAst, isAircraftCommand } from '../../lib/sim/commandAst';
import type { CommandAST, CommandResult } from '../../lib/sim/commandAst';
import { bayFor } from '../../lib/sim/stage';
import type { BayId } from '../../lib/sim/stage';
import { EVENT_WHO, POSITION_OWNER, type Position as RadioPosition } from '../../lib/sim/types';
import type { Sector } from '../../lib/sim/types';
import type {
  AircraftState, Alert, AlertSeverity, Atis, EmergencyType, PilotRequest, PlayerPosition, RunwayState, RunwayStatus,
  SessionStats, SimEvent, Stage, Vehicle, VehicleTarget, VehicleType, WeatherState, Position as FreqPosition,
} from '../../lib/sim/types';
import { createTestApi } from '../../lib/sim/testApi';
import type { AtcTestApi, CameraView, TestApiHost } from '../../lib/sim/testApi';
import { sound } from './sound';
import { namingAt, DEFAULT_SETTINGS, sanitizeSettings, sectorPatch, type Settings } from './simSettings';
import * as persist from './persist';
import { LlmAgent } from '../../lib/llm/agent';
import type { LlmStatus } from '../../lib/llm/agent';
import { DEFAULT_LLM_CONFIG } from '../../lib/llm/client';
import type { LlmConfig } from '../../lib/llm/client';
import { describe as describeAst } from '../../lib/sim/commandAst';

const NM = NM_TO_M, DEG = Math.PI / 180;

// ──────────────────────────────────────────────────────────────────────────────
//  Airport catalogue (home page picker, ground camera presets)
// ──────────────────────────────────────────────────────────────────────────────
export const ATC_AIRPORTS: Record<string, { center: [number, number]; groundZoom: number; name: string; city: string }> = {
  EGLL: { center: [-0.4543, 51.4700], groundZoom: 13.4, name: 'Heathrow', city: 'London' },
  KLAX: { center: [-118.4081, 33.9416], groundZoom: 13.5, name: 'Los Angeles Intl', city: 'Los Angeles' },
  KJFK: { center: [-73.7781, 40.6413], groundZoom: 13.3, name: 'John F. Kennedy', city: 'New York' },
  KSFO: { center: [-122.3790, 37.6213], groundZoom: 13.5, name: 'San Francisco Intl', city: 'San Francisco' },
  KBOS: { center: [-71.0096, 42.3656], groundZoom: 13.5, name: 'Logan Intl', city: 'Boston' },
  VIDP: { center: [77.1000, 28.5562], groundZoom: 13.1, name: 'Indira Gandhi', city: 'Delhi' },
};

// ──────────────────────────────────────────────────────────────────────────────
//  Public types (the STORE INTERFACE every Wave-2 agent codes to)
// ──────────────────────────────────────────────────────────────────────────────
export type Position = PlayerPosition;

export interface RadioLine {
  key: number;
  who: 'ATC' | 'PILOT' | 'SYS' | 'AI' | 'LLM';
  /** AI lines: the position that spoke (TWR / APP / GND) - shown as the badge instead of repeating "AI APP:" in the text. */
  aiPos?: string;
  text: string;
  /** Sim seconds. */
  at: number;
  callsign?: string;
  /** Frequency the line was heard on (comm-log filter). */
  position?: FreqPosition;
  result?: CommandResult;
  ast?: CommandAST;
  /** Sim time until which this ATC line can be undone (UNDO ring); undefined = no ring / closed. */
  undoUntil?: number;
  status?: 'ok' | 'unable' | 'partial' | 'error' | 'undone' | 'mismatch';
}

export type ToastKind = 'info' | 'success' | 'attention' | 'error';
export interface Toast {
  key: number;
  kind: ToastKind;
  text: string;
  detail?: string;
  /** Alert severity when the toast mirrors an alert. */
  severity?: AlertSeverity;
  /** Wall-clock ms the toast was pushed. */
  at: number;
  /** ms; 0 = sticky (critical alerts stay until acked / dismissed). */
  duration: number;
  alertId?: string;
  callsigns?: string[];
  scoreDelta?: number;
}

export type { Settings } from './simSettings';
export { DEFAULT_SETTINGS, sectorAi, sectorPatch } from './simSettings';

export interface StartConfig {
  icao: string;
  /** Active runway ends (both roles); undefined / [] = every end. */
  ends?: string[];
  /** Allowed weight classes per END. */
  weights?: Record<string, WeightClass[]>;
  seed?: number;
  spawn?: 'none' | 'default';
  difficulty?: 'low' | 'normal' | 'high';
  /** Deterministic test mode: no RAF, window.__atcTest installed. */
  test?: boolean;
  /** Starting position tab. */
  position?: Position;
  /** Names fixed for this session whatever the setting (the tutorial and the film speak of SFO's own). */
  naming?: 'real' | 'simple';
}

export interface RadarBeacon { id: string; x: number; y: number; pron?: string; holdHeading?: number }
export interface RadarRunway { id: string; name: string; thr: XY; course: number; locCourse: number; gsDeg: number; lengthM: number }
export interface RadarEntry { x: number; y: number; heading: number; beacon?: string; altFt: number; weight: number }
export interface RadarArea { shape: 'circle' | 'polygon'; altFt: number; name?: string; radiusM?: number; center?: XY; points: XY[] }
export interface RadarScene {
  centerXY: XY; radiusM: number;
  beacons: RadarBeacon[]; runways: RadarRunway[]; entries: RadarEntry[]; areas: RadarArea[];
}

export interface StripBay { bay: BayId; title: string; items: AircraftState[] }

export type ProjectorKind = 'radar' | 'ground';
export interface ProjectorExtras {
  /** Move the view camera (radar cam / maplibre jumpTo with zoom). */
  setCamera?: (cam: CameraView) => void;
  /** CSS size of the canvas element (emptySpot / hit-testing). */
  size?: () => { w: number; h: number } | null;
  /** Fly so all these points are in view (clear of the side panels), optionally looking along `bearing`. */
  frame?: (pts: XY[], opts?: { bearing?: number }) => void;
}
interface Projector { fn: (xy: XY, altFt?: number) => { x: number; y: number } | null; centerOn: (xy: XY) => void; camera: () => CameraView | null; extras: ProjectorExtras }

/** Legacy key map kept for the old settings page; new code uses `persist.PERSIST_KEYS`. */
export const LS_KEYS = {
  score: persist.PERSIST_KEYS.highScore,
  tts: persist.PERSIST_KEYS.settings,
  groundTheme: persist.PERSIST_KEYS.settings,
  autoTower: persist.PERSIST_KEYS.settings,
  settings: persist.PERSIST_KEYS.settings,
  startConfig: persist.PERSIST_KEYS.startConfig,
};

const RADIO_MAX = 300;
const EVENT_RING = 500;
const TOAST_MAX = 8;
const EMIT_EVERY = 6;

const BAY_TITLES: Record<BayId, string> = {
  PENDING: 'PENDING', PUSH_START: 'PUSH · START', TAXI_OUT: 'TAXI OUT', AT_HOLD: 'AT HOLD', TAXI_IN: 'TAXI IN', AT_STAND: 'AT STAND', VEHICLES: 'VEHICLES',
  LINED_UP: 'LINED UP', ROLLING_AIRBORNE: 'ROLLING · AIRBORNE', FINAL: 'FINAL', LANDED_ROLLOUT: 'LANDED · ROLLOUT', TO_GROUND: 'TO GROUND',
  INBOUND: 'INBOUND', SEQUENCE: 'SEQUENCE', ESTABLISHED: 'ESTABLISHED', TO_TOWER: 'TO TOWER', CLIMB_OUT: 'CLIMB OUT', HANDED_OFF: 'HANDED OFF',
};
const BAY_ORDER: Record<Position, BayId[]> = {
  ground: ['PENDING', 'PUSH_START', 'TAXI_OUT', 'AT_HOLD', 'TAXI_IN', 'AT_STAND', 'VEHICLES'],
  tower: ['PENDING', 'PUSH_START', 'TAXI_OUT', 'AT_HOLD', 'LINED_UP', 'ROLLING_AIRBORNE', 'FINAL', 'LANDED_ROLLOUT', 'TAXI_IN', 'AT_STAND', 'VEHICLES'],
  approach: ['INBOUND', 'SEQUENCE', 'ESTABLISHED', 'TO_TOWER', 'CLIMB_OUT', 'HANDED_OFF'],
};
/** Bays sorted by distance to threshold (arrival flow). */
const DISTANCE_BAYS = new Set<BayId>(['FINAL', 'SEQUENCE', 'ESTABLISHED', 'TO_TOWER', 'INBOUND']);

/** Drop persisted values that are outside the Settings domain (old / edited / foreign blobs must not break `load()`). */

/** Persisted LLM config: unknown / malformed fields fall back to the defaults. */
function sanitizeLlm(raw: Partial<LlmConfig> | null): LlmConfig {
  const d = DEFAULT_LLM_CONFIG; const r = raw ?? {};
  const positions = Array.isArray(r.positions) ? r.positions.filter((p): p is PlayerPosition => p === 'ground' || p === 'tower' || p === 'approach') : d.positions;
  return {
    mode: r.mode === 'advise' || r.mode === 'control' ? r.mode : 'off',
    positions: positions.length ? positions : d.positions,
    endpoint: typeof r.endpoint === 'string' ? r.endpoint.trim() : d.endpoint,
    model: typeof r.model === 'string' ? r.model.trim() : d.model,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : d.apiKey,
    intervalS: typeof r.intervalS === 'number' && isFinite(r.intervalS) ? Math.min(120, Math.max(3, r.intervalS)) : d.intervalS,
    temperature: typeof r.temperature === 'number' && isFinite(r.temperature) ? Math.min(2, Math.max(0, r.temperature)) : d.temperature,
    maxTokens: typeof r.maxTokens === 'number' && isFinite(r.maxTokens) ? Math.min(4096, Math.max(32, Math.round(r.maxTokens))) : d.maxTokens,
    direct: typeof r.direct === 'boolean' ? r.direct : d.direct,
    record: typeof r.record === 'boolean' ? r.record : d.record,
  };
}

/** Autospawn tuning per difficulty: traffic cap and spawn cadence (sim s). */
const SPAWN_TUNING: Record<Settings['difficulty'], { base: number; lo: number; hi: number; depShare: number }> = {
  low: { base: 5, lo: 90, hi: 150, depShare: 0.55 },
  normal: { base: 8, lo: 50, hi: 100, depShare: 0.55 },
  high: { base: 12, lo: 30, hi: 60, depShare: 0.5 },
};
const SPAWN_CAP_MAX = 24;

/** What traffic the player wants: how many at once, how often, the departure share, which sizes. */
export interface TrafficPrefs { limit: number | null; pace: 'quiet' | 'normal' | 'busy'; depShare: number | null; sizes: Array<'L' | 'M' | 'H' | 'S'> }
const TRAFFIC_KEY = 'skycontrol_traffic_v1';
const PACE: Record<TrafficPrefs['pace'], number> = { quiet: 0.6, normal: 1, busy: 1.6 };
function loadTraffic(): TrafficPrefs {
  const d: TrafficPrefs = { limit: null, pace: 'normal', depShare: null, sizes: ['L', 'M', 'H', 'S'] };
  try {
    const raw = localStorage.getItem(TRAFFIC_KEY); if (raw) return { ...d, ...JSON.parse(raw) };
    const old = Number(localStorage.getItem('skycontrol_traffic_limit')); if (old >= 1) d.limit = old;   // the first version kept only the limit
  } catch { /* no storage (server, private mode) */ }
  return d;
}

const isBrowser = () => typeof window !== 'undefined';

function readUrlParams(): { test: boolean; seed: number | null; spawn: 'none' | 'default' | null; icao: string | null } {
  if (!isBrowser()) return { test: false, seed: null, spawn: null, icao: null };
  try {
    const q = new URLSearchParams(window.location.search);
    const seedRaw = q.get('seed');
    const seed = seedRaw != null && seedRaw !== '' && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : null;
    const spawnRaw = q.get('spawn');
    const spawn = spawnRaw === 'none' || spawnRaw === 'default' ? spawnRaw : null;
    const icaoRaw = q.get('icao');
    const icao = icaoRaw && /^[A-Za-z]{4}$/.test(icaoRaw) ? icaoRaw.toUpperCase() : null;
    const test = q.get('test') === '1' || q.get('test') === 'true';
    return { test, seed, spawn, icao };
  } catch {
    return { test: false, seed: null, spawn: null, icao: null };
  }
}

function randomSeed(): number {
  return (Math.floor(Math.random() * 0x7fffffff) ^ (Date.now() & 0x7fffffff)) >>> 0;
}

// ──────────────────────────────────────────────────────────────────────────────
//  The store
// ──────────────────────────────────────────────────────────────────────────────
class SimStore implements TestApiHost {
  // ---- state ----
  engine: SimEngine | null = null;
  osm: OsmAirport | null = null;
  airspace: EAirport | null = null;
  radar: RadarScene | null = null;
  icao = '';
  loading = false;
  loadError: string | null = null;
  /** Monotonic; bumps on every emit. */
  version = 0;
  paused = false;
  rate: 1 | 2 | 4 = 1;
  /** Extra speed on top of the rate (the tutorial fast-forwards slow, uneventful stretches like a pushback). */
  boost = 1;
  /** Called after every command (callsign, result, who): the tutorial resumes a game it held for a call. */
  commandTaps = new Set<(callsign: string | null, result: DispatchResult, who: 'ATC' | 'LLM', text: string) => void>();
  private ffAcc = 0;
  position: Position = 'tower';
  selectedId: number | null = null;
  hoveredId: number | null = null;
  radio: RadioLine[] = [];
  toasts: Toast[] = [];
  settings: Settings;
  testMode = false;
  autoSpawn = true;
  mapReady = false;
  highScore = 0;
  lastCallsign: string | null = null;
  /** Seed of the current session (reproducible). */
  seed = 0;
  /** Config the current session was loaded with (restart re-applies it). */
  lastConfig: StartConfig | null = null;
  /** dt passed to the last step() (rate spy for the test API). */
  lastStepDt = 0;
  /** Ring of every engine event since the last clear (test API / late panels). */
  eventLog: SimEvent[] = [];
  /** Feature-flag overrides for the test API (`features()`); UI agents may flip flags off. */
  featureOverrides: Partial<Record<string, boolean>> = {};
  /** Sim time of the last spawn decision and the next planned spawn. */
  nextSpawnAt = 0;
  /** Edge-LLM I/O (docs/spec/07-LLM-IO.md): config (persisted under its own key) + the agent loop. */
  llm: LlmConfig = { ...DEFAULT_LLM_CONFIG };
  llmAgent: LlmAgent = new LlmAgent(this, () => this.llm, () => this.emit());
  /** Who the current command() call speaks as (tags the ATC line): the player, or the LLM working a position. */
  private commandWho: 'ATC' | 'LLM' = 'ATC';

  get tts(): boolean { return this.settings.tts; }

  private raf = 0;
  private last = 0;
  private emitTick = 0;
  private lineKey = 0;
  private toastKey = 0;
  private loadToken = 0;
  /** Wall-clock epoch (ms) when the shift started; the 3D world derives the sun from it + sim time. */
  sessionStartedAt = 0;
  private lastHighScoreWriteAt = -Infinity;
  private listeners = new Set<() => void>();
  /** Raw engine events of every step, for observers that need all of them (the tutorial coach). */
  readonly eventTaps = new Set<(events: SimEvent[]) => void>();
  private batchDepth = 0;
  private dirty = false;
  private projectors: Partial<Record<ProjectorKind, Projector>> = {};
  private memo = new Map<string, { v: number; value: unknown }>();
  private urlTest: ReturnType<typeof readUrlParams> | null = null;

  constructor() {
    // defaults only: the SSR HTML is rendered from these, so the client must hydrate against the same values
    // (persisted settings / high score are read in `hydratePersisted()` from the page's mount effect).
    this.settings = { ...DEFAULT_SETTINGS };
    this.highScore = 0;
    sound.setEnabled(this.settings.sound);
    sound.setTTS(this.settings.tts);
    sound.setVolume(this.settings.volume);
  }
  private persistedLoaded = false;
  /** Read localStorage once (after hydration): settings blob (validated) + high score. Safe to call repeatedly. */
  hydratePersisted(): void {
    if (this.persistedLoaded || typeof window === 'undefined') return;
    this.persistedLoaded = true;
    this.settings = sanitizeSettings(persist.loadSettings(DEFAULT_SETTINGS));
    // pilot voices are on by default since 2026-11-16 (they were off): switch them on once for players who never chose
    try { if (!localStorage.getItem('skycontrol_tts_default_on')) { localStorage.setItem('skycontrol_tts_default_on', '1'); if (!this.settings.tts) { this.settings = { ...this.settings, tts: true }; persist.saveSettings?.(this.settings) } } } catch { /* storage blocked */ }
    this.llm = sanitizeLlm(persist.readJson<Partial<LlmConfig> | null>(persist.PERSIST_KEYS.llm, null));
    this.highScore = persist.loadHighScore();
    sound.setEnabled(this.settings.sound);
    sound.setTTS(this.settings.tts);
    sound.setVolume(this.settings.volume);
    this.memo.clear();
    this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Subscription / emit
  // ═══════════════════════════════════════════════════════════════════════════
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (!this.persistedLoaded) queueMicrotask(() => this.hydratePersisted());
    return () => { this.listeners.delete(fn); };
  };
  emit(): void {
    if (this.batchDepth > 0) { this.dirty = true; return; }
    this.version++;
    for (const l of this.listeners) { try { l(); } catch (err) { console.error(err); } }
  }
  /** Coalesce the emits of several mutations into one notification. */
  private batch<T>(fn: () => T): T {
    this.batchDepth++;
    try { return fn(); }
    finally { if (--this.batchDepth === 0 && this.dirty) { this.dirty = false; this.emit(); } }
  }
  /** Memoise a query per store version (identity-stable results for useSim selectors). */
  private cached<T>(key: string, compute: () => T): T {
    const m = this.memo.get(key);
    if (m && m.v === this.version) return m.value as T;
    const value = compute();
    this.memo.set(key, { v: this.version, value });
    return value;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Convenience boot for the game page: consumes the one-shot start config
   * written by the home page, merges `?test=1&seed=&icao=&spawn=` and loads.
   */
  boot(fallbackIcao = 'EGLL'): Promise<void> {
    const url = readUrlParams();
    const cfg = persist.consumeStartConfig<StartConfig>() ?? this.lastConfig;
    const icao = url.icao ?? cfg?.icao ?? fallbackIcao;
    return this.load({ ...(cfg ?? {}), icao, test: url.test || !!cfg?.test, seed: url.seed ?? cfg?.seed, spawn: url.spawn ?? cfg?.spawn });
  }

  /** Test-API hook: arm test mode before the next load (05 §2.2). */
  enableTestMode(opts: { seed?: number; spawn?: 'none' | 'default' } = {}): void {
    this.testMode = true;
    this.urlTest = { test: true, seed: opts.seed ?? null, spawn: opts.spawn ?? null, icao: null };
    if (opts.seed != null) this.seed = opts.seed;
  }

  /**
   * ALWAYS applies (also when an engine exists): tears the session down, seeds
   * the rng, fetches osm + airspace, builds the engine per 06-CONTRACTS §7.1,
   * applies ends / weights, spawns initial traffic unless spawn:'none' and
   * starts the RAF loop (never in test mode).
   */
  async load(cfg: StartConfig): Promise<void> {
    this.hydratePersisted();
    const token = ++this.loadToken;
    const url = this.urlTest ?? readUrlParams();
    this.urlTest = null;
    const icao = (cfg.icao || 'EGLL').toUpperCase();
    const testMode = !!cfg.test || url.test;
    const spawn: 'none' | 'default' = cfg.spawn ?? url.spawn ?? 'default';
    const seed = cfg.seed ?? url.seed ?? (testMode ? 1 : randomSeed());

    this.teardown();
    this.testMode = testMode;
    this.seed = seed;
    this.icao = icao;
    this.loading = true;
    this.loadError = null;
    this.lastConfig = { ...cfg, icao, seed, spawn, test: testMode };
    if (cfg.difficulty && cfg.difficulty !== this.settings.difficulty) this.updateSettings({ difficulty: cfg.difficulty }, { silent: true });
    if (cfg.position) this.position = cfg.position === 'ground' && !this.testMode ? 'tower' : cfg.position;
    this.emit();

    let fc: unknown; let ap: EAirport | null = null;
    try {
      [fc, ap] = await Promise.all([
        fetch(`/maps/osm/${icao}.geojson`).then(r => { if (!r.ok) throw new Error(`No airport data for ${icao} (${r.status})`); return r.json(); }),
        loadEndlessAirport(icao).catch(() => null),
      ]);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.loading = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }
    if (token !== this.loadToken) return;

    try {
      setSeed(seed);                                                     // BEFORE new SimEngine (§7.1)
      const air = buildOsmAirport(icao, fc, { magVarDeg: ap?.airspace.magVar, quiet: true });
      const e = new SimEngine(air);
      e.setActiveRunwayEnds(cfg.ends && cfg.ends.length ? cfg.ends : null);
      e.setRunwayWeightAllow(cfg.weights && Object.keys(cfg.weights).length ? cfg.weights : null);
      this.osm = air; this.airspace = ap; this.engine = e;
      this.radar = ap ? this.buildRadar(ap, e) : null;
      if (ap && this.radar) e.setAirspaceConfig(this.airspaceConfig(ap, e, this.radar));
      this.applySettingsToEngine(e);
      e.playerPosition = this.position;
      if (testMode) {
        // deterministic scenarios: fixed pilot delay, exact readbacks, no random emergencies (forceEmergency is the hook)
        e.settings.pilotDelayOverride = this.settings.pilotDelayS ?? 3;
        e.settings.pilotErrorRate = 0;
        e.settings.emergencyRate = 'off';
      }
      this.sessionStartedAt = Date.now();
      this.nextSpawnAt = 0;
      this.autoSpawn = !testMode && spawn !== 'none';
      // the live game starts with the aprons populated (airlines.ts profiles); deterministic test scenarios do not
      if (!testMode) e.populateParked();
      this.applyTraffic();
      this.opening = [];
      if (spawn !== 'none' && !testMode) {
        // a live shift opens quietly: one departure now, the rest one at a time (no burst of calls in the first minute)
        // no two openings alike: how many are ready to go, in what order the rest turn up and when
        const ready = chance(0.75) ? 1 : 2; for (let i = 0; i < ready; i++) e.spawnDeparture();
        const rest: Array<'dep' | 'arr'> = ['arr', 'arr', 'arr', 'dep', 'dep', 'dep']; for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rf(0, i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
        this.opening = rest.slice(0, Math.floor(rf(4, 7)));
        this.nextOpeningAt = e.time + rf(15, 60);
      } else if (spawn !== 'none') {
        for (let i = 0; i < 4; i++) e.spawnDeparture();
        for (let i = 0; i < 3; i++) e.spawnArrival();
      }
      if (spawn !== 'none') {
        // a live session opens with one already on final (the rest come in from the TMA edge: the first of those took
        // some 20 minutes to land, and the tower sat with nothing arriving)
        if (!testMode) e.spawnArrivalShortFinal({ distM: rf(8500, 19000) });
        this.nextSpawnAt = e.time + rf(SPAWN_TUNING[this.settings.difficulty].lo, SPAWN_TUNING[this.settings.difficulty].hi) / profileOf(icao).busy;
      }
      this.pushLine({ who: 'SYS', at: e.time, text: `${ATC_AIRPORTS[icao]?.name ?? air.icao} — ${air.gates.length} stands, ${air.runways.length} runways${ap ? `, ${ap.airspace.radiusNM} NM TMA` : ', no radar airspace'} online${testMode ? ` · test mode · seed ${seed}` : ''}` });
      this.flushEvents();
    } catch (err) {
      this.engine = null; this.radar = null;
      this.loading = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }
    this.loading = false;
    this.emit();
    if (testMode) this.installTestApi();
    else this.start();
  }

  /**
   * Resume the live session on the singleton without reloading (home "Resume shift", settings "Back to shift"):
   * restarts the RAF loop when an engine exists. Returns false when there is nothing to resume.
   */
  resume(): boolean {
    this.hydratePersisted();
    if (!this.engine || this.loading) return false;
    if (!this.testMode) this.start();
    this.emit();
    return true;
  }

  /** Reload the current config (new seed outside test mode); records the finished session first. */
  restart(): Promise<void> {
    const cfg = this.lastConfig ?? { icao: this.icao || 'EGLL' };
    return this.load({ ...cfg, seed: this.testMode ? cfg.seed : undefined });
  }

  private teardown(): void {
    this.stop(); this.lifeMoves = null;
    if (this.engine) this.recordSession();
    this.engine = null; this.osm = null; this.airspace = null; this.radar = null;
    this.selectedId = null; this.hoveredId = null; this.lastCallsign = null;
    this.radio = []; this.toasts = []; this.eventLog = [];
    this.mapReady = false;
    this.paused = false;
    this.memo.clear();
    sound.stopSpeech();
  }

  private recordSession(): void {
    const e = this.engine; if (!e || e.time < 30) return;
    const s = e.stats;
    const incidents = Object.values(s.incidents).reduce<number>((n, v) => n + (v ?? 0), 0);
    persist.pushSessionRecord({
      icao: this.icao, startedAt: this.sessionStartedAt, endedAt: Date.now(), simTimeS: Math.round(e.time),
      points: s.points, skill: s.score, movements: s.movements, departures: s.departures, arrivals: s.arrivals,
      incidents, emergenciesResolved: s.emergenciesResolved, seed: this.seed,
    });
    this.persistHighScore(true);
  }

  private airspaceConfig(ap: EAirport, e: SimEngine, radar: RadarScene): AirspaceConfig {
    const ilsRunways: ILSRunway[] = ap.runways.map(r => ({
      name: r.name, thrXY: coordToXY(r.thrCoord ?? r.coord, e.proj), rwdHdg: r.trueHeading, locCourse: r.localizerCourse,
      gsDeg: r.glideslopeDeg, thrElevFt: 0, estimated: r.derived,
    }));
    const tower = ap.runways.find(r => r.towerFreq != null)?.towerFreq;
    return {
      radiusM: radar.radiusM, centerXY: radar.centerXY, ilsRunways,
      beacons: radar.beacons.map(b => ({ id: b.id, x: b.x, y: b.y, holdHeading: b.holdHeading })),
      entries: radar.entries.map(ep => ({ x: ep.x, y: ep.y, heading: ep.heading, altFt: ep.altFt, beacon: ep.beacon, weight: ep.weight })),
      magVar: ap.airspace.magVar, transitionAltFt: ap.airspace.transitionAltFt, airportName: ap.name,
      frequencies: tower != null ? { tower: tower.toFixed(3) } : undefined, missedApproachAltFt: 3000,
    };
  }

  private buildRadar(ap: EAirport, e: SimEngine): RadarScene {
    const proj = e.proj;
    const centerXY = coordToXY({ kind: 'll', lat: ap.airspace.center.lat, lng: ap.airspace.center.lng }, proj);
    const radiusM = ap.airspace.radiusNM * NM;
    const beacons: RadarBeacon[] = ap.airspace.beacons.map(b => { const p = coordToXY(b.coord, proj); return { id: b.id, x: p.x, y: p.y, pron: b.pron, holdHeading: b.holdHeading }; });
    const runways: RadarRunway[] = ap.runways.map(r => {
      const thr = coordToXY(r.thrCoord ?? r.coord, proj);
      return { id: r.id, name: r.name, thr, course: r.trueHeading, locCourse: r.localizerCourse, gsDeg: r.glideslopeDeg, lengthM: r.lengthFt * 0.3048 };
    });
    const entries: RadarEntry[] = ap.entryPoints.map(ep => {
      const pos = advance(centerXY, (ep.heading + 180) % 360, radiusM);
      return { x: pos.x, y: pos.y, heading: ep.heading, beacon: ep.beacon, altFt: ep.altitudeFt, weight: ep.weight };
    });
    const areas: RadarArea[] = ap.areas.map(a => ({
      shape: a.shape, altFt: a.altitudeFt, name: a.name,
      radiusM: a.radiusNM ? a.radiusNM * NM : undefined,
      center: a.center ? coordToXY(a.center, proj) : undefined,
      points: a.points.map(p => coordToXY(p, proj)),
    }));
    return { centerXY, radiusM, beacons, runways, entries, areas };
  }

  private installTestApi(): void {
    if (!isBrowser()) return;
    try { (window as unknown as { __atcTest?: AtcTestApi }).__atcTest = createTestApi(this); } catch (err) { console.error('test API install failed', err); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loop
  // ═══════════════════════════════════════════════════════════════════════════
  private start(): void {
    if (this.raf || this.testMode || !isBrowser()) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
      this.pruneToasts();
      if (this.paused || !this.engine) return;
      this.step(dt * this.rate * this.boost);
      if (++this.emitTick % EMIT_EVERY === 0) this.emit();
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop(): void {
    if (this.raf && isBrowser()) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.llmAgent.stop();
  }

  /**
   * Advance the sim by dtSim sim-seconds (already rate-scaled) and run every
   * store side-effect: event routing, autospawn, persistence, selection
   * clean-up. Pure with respect to the DOM. Returns the engine events.
   */
  step(dtSim: number): SimEvent[] {
    const e = this.engine; if (!e) return [];
    this.lastStepDt = dtSim;
    // engine.update keeps at most 0.25 s a call (a stalled tab must not leap); a fast-forward (rate x boost) asks for
    // more than that on every frame below ~50 fps, and the excess was lost: run whole fixed steps for it instead
    let events: SimEvent[];
    if (dtSim > 0.24) { this.ffAcc += dtSim; const n = Math.min(240, Math.floor(this.ffAcc / FIXED)); this.ffAcc -= n * FIXED; events = n > 0 ? e.step(n) : e.update(0); }
    else events = e.update(dtSim);
    for (const tap of this.eventTaps) { try { tap(events); } catch (err) { console.error(err); } }
    this.batch(() => {
      this.routeEvents(events);
      if (this.autoSpawn) this.autoSpawnTick(e);
      this.persistHighScore(false);
      if (this.selectedId != null && !e.byId(this.selectedId)) { this.selectedId = null; this.pushToast({ kind: 'info', text: 'Selected aircraft left the simulation', duration: 4000 }); }
      if (this.hoveredId != null && !e.byId(this.hoveredId)) { this.hoveredId = null; this.emit(); }
    });
    return events;
  }

  /** Drain events the engine produced outside a step (commands, dispatches) so lines appear at once. */
  flush(): void { this.flushEvents(); }
  private flushEvents(): void {
    const e = this.engine; if (!e) return;
    const evs = e.update(0);
    if (evs.length) this.batch(() => this.routeEvents(evs));
  }

  /** The traffic the player wants (Settings > Traffic, and the pause menu's limit), kept on this device. */
  traffic: TrafficPrefs = loadTraffic();
  setTraffic(patch: Partial<TrafficPrefs>): void {
    this.traffic = { ...this.traffic, ...patch };
    try { localStorage.setItem(TRAFFIC_KEY, JSON.stringify(this.traffic)) } catch { /* storage blocked */ }
    this.applyTraffic(); this.emit();
  }
  private applyTraffic(): void { const e = this.engine; if (e) e.spawnSizes = this.traffic.sizes.length && this.traffic.sizes.length < 4 ? new Set(this.traffic.sizes) : null; }
  /** The player's limit on aircraft at once; null = no limit beyond the difficulty's own. */
  get trafficLimit(): number | null { return this.traffic.limit; }
  setTrafficLimit(n: number | null): void { this.setTraffic({ limit: n }); }
  /** Aircraft that count toward the limit: everything the game moves (not the parked airframes on the aprons). */
  private lifeMoves: number | null = null;
  /** A new player's ceiling on aircraft at once: three until they have handled a few, then four, then five, then whatever
   *  they chose. Only in a live game; a limit the player set themselves wins. */
  newcomerLimit(): number | null {
    if (this.testMode || !this.raf || !this.engine) return null;
    if (this.lifeMoves == null) this.lifeMoves = persist.loadSessionHistory().reduce((n, r) => n + (r.movements || 0), 0);
    const n = this.lifeMoves + this.engine.stats.movements;
    return n < 4 ? 3 : n < 10 ? 4 : n < 18 ? 5 : null;
  }
  private underLimit(e: SimEngine): boolean {
    const lim = this.trafficLimit ?? this.newcomerLimit();
    return lim == null || e.aircraft.filter((a) => a.phase !== 'arrived' && a.phase !== 'departed').length < lim;
  }
  /** The shift's opening traffic still to come, one at a time. */
  private opening: Array<'dep' | 'arr'> = [];
  private nextOpeningAt = 0;
  private autoSpawnTick(e: SimEngine): void {
    if (this.opening.length) {
      if (e.time >= this.nextOpeningAt && this.underLimit(e)) {
        const k = this.opening.shift()!
        const ok = k === 'dep' ? e.spawnDeparture() : e.spawnArrival();
        if (!ok) { if (k === 'dep') e.spawnArrival(); else e.spawnDeparture(); }
        this.nextOpeningAt = e.time + rf(25, 45);
        // the regular flow starts after the opening has played out
        if (!this.opening.length) this.nextSpawnAt = Math.max(this.nextSpawnAt, e.time + rf(30, 50));
      }
      return;
    }
    const tune = SPAWN_TUNING[this.settings.difficulty];
    if (e.time < this.nextSpawnAt) return;
    const cap = Math.min(SPAWN_CAP_MAX, tune.base + Math.floor(e.skill / 2));
    if (e.aircraft.length < cap && this.underLimit(e)) {
      const dep = chance(this.traffic.depShare ?? tune.depShare);
      const ok = dep ? e.spawnDeparture() : e.spawnArrival();
      if (!ok) { if (dep) e.spawnArrival(); else e.spawnDeparture(); }
    }
    this.nextSpawnAt = e.time + rf(tune.lo, tune.hi) / profileOf(e.air.icao).busy / PACE[this.traffic.pace] * (this.newcomerLimit() === 3 ? 1.6 : 1);   // hubs turn traffic faster
  }

  private persistHighScore(force: boolean): void {
    const e = this.engine; if (!e) return;
    if (e.stats.points > this.highScore) {
      this.highScore = e.stats.points;
      if (force || e.time - this.lastHighScoreWriteAt >= 1) { persist.saveHighScore(this.highScore); this.lastHighScoreWriteAt = e.time; }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Event routing (06-CONTRACTS §7.3)
  // ═══════════════════════════════════════════════════════════════════════════
  private routeEvents(events: SimEvent[]): void {
    if (!events.length) return;
    for (const ev of events) {
      this.eventLog.push(ev);
      this.route(ev);
    }
    if (this.eventLog.length > EVENT_RING) this.eventLog.splice(0, this.eventLog.length - EVENT_RING);
  }

  private route(ev: SimEvent): void {
    const who = ev.who ?? EVENT_WHO[ev.type];
    const d = ev.data;
    if (ev.type === 'info' && ev.message.startsWith('Two stations called')) sound.play('blocked');
    switch (ev.type) {
      case 'phase': case 'stage': case 'removed': case 'landing_clearance':
        return;                                                        // UI reads these from state
      case 'request': {
        if (d?.type === 'request') {
          if (d.change === 'raised' || d.change === 'recalled') { this.pushLine({ who: 'PILOT', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position }); if (this.onMyRadio(ev.position)) sound.play('request'); this.speak(ev.message, 'PILOT', ev.callsign, ev.position); }
          return;
        }
        break;
      }
      case 'readback': {
        this.pushLine({ who: 'PILOT', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position, status: d?.type === 'readback' ? readbackStatus(d.status) : undefined });
        this.closeUndo(ev.callsign, d?.type === 'readback' ? d.status : 'ok');
        if (d?.type === 'readback' && (d.status === 'unable' || d.status === 'mismatch')) sound.play('error'); else sound.play('readback');
        this.speak(ev.message, 'PILOT', ev.callsign, ev.position);
        return;
      }
      case 'transmission': {
        if (d?.type === 'transmission') {
          const res = d.result;
          const aiTag = who === 'AI' ? /^AI (APP|TWR|GND): ([^]*)$/.exec(ev.message) : null;
          const undoOpen = res.ok && res.applyAt != null && res.applyAt > ev.at && undoable(d.ast);
          this.pushLine({
            who: who === 'AI' ? 'AI' : this.commandWho === 'LLM' ? 'LLM' : 'ATC', aiPos: aiTag?.[1], at: ev.at, text: aiTag ? aiTag[2] : ev.message, callsign: ev.callsign !== 'SYSTEM' ? ev.callsign : undefined, position: ev.position,
            result: res, ast: d.ast, undoUntil: undoOpen ? res.applyAt : undefined,
            status: res.ok ? (res.code === 'partial' ? 'partial' : 'ok') : res.code.startsWith('unable') ? 'unable' : res.code === 'queried' ? 'ok' : 'error',
          });
          if (d.who === 'player') sound.play('transmit');
          // the pilot's readback is already written (engine.onTransmission) and due in 2-8 s: voice it now
          if (res.readback && ev.callsign && ev.callsign !== 'SYSTEM' && this.settings.tts && this.settings.sound && !this.testMode) {
            this.voiceStress(ev.callsign);
            sound.prefetchPilot(res.readback, { callsign: ev.callsign, variant: this.engine?.settings.region });
          }
          return;
        }
        break;
      }
      case 'alert': {
        if (d?.type === 'alert') {
          const al = d.alert;
          if (d.change === 'raised' || d.change === 'updated') {
            this.upsertAlertToast(al, d.change);
            if (d.change === 'raised') sound.alert(al.severity);
          } else if (d.change === 'resolved') {
            this.toasts = this.toasts.filter(t => t.alertId !== al.id);
            this.pushToast({ kind: 'success', text: `Resolved · ${al.title}`, detail: al.subjects.join(' / '), duration: 3000, alertId: undefined, callsigns: al.subjects });
            sound.play('resolve');
          } else if (d.change === 'acked') {
            this.toasts = this.toasts.filter(t => t.alertId !== al.id);
            this.emit();
          }
          return;
        }
        break;
      }
      case 'score': {
        if (d?.type === 'score') {
          const s = d.score;
          if (s.points !== 0) {
            this.pushToast({
              kind: s.points < 0 ? 'error' : s.points >= 50 ? 'success' : 'info',
              text: `${s.points > 0 ? '+' : ''}${s.points} ${s.code.toLowerCase().replace(/_/g, ' ')}`, detail: s.detail || s.primary,
              duration: s.points < 0 ? 5000 : 2500, scoreDelta: s.points, callsigns: [s.primary, ...(s.secondary ? [s.secondary] : [])],
            });
            sound.play(s.points < 0 ? 'score-down' : 'score-up');
          }
          return;
        }
        break;
      }
      case 'emergency': {
        if (d?.type === 'emergency') {
          const line = who === 'PILOT' ? 'PILOT' : 'SYS';
          this.pushLine({ who: line, at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position });
          if (d.change === 'declared') {
            this.pushToast({ kind: 'error', severity: 'critical', text: `${d.emergency.level} · ${ev.callsign}`, detail: ev.message, duration: 0, callsigns: [ev.callsign] });
            sound.play('emergency');
          } else if (d.change === 'resolved') {
            this.toasts = this.toasts.filter(t => !(t.severity === 'critical' && t.callsigns?.includes(ev.callsign) && !t.alertId));
            this.pushToast({ kind: 'success', text: `Emergency resolved · ${ev.callsign}`, duration: 4000, callsigns: [ev.callsign] });
            sound.play('resolve');
          }
          if (line === 'PILOT') this.speak(ev.message, 'PILOT', ev.callsign, ev.position);
          return;
        }
        break;
      }
      case 'atis': {
        this.pushLine({ who: 'SYS', at: ev.at, text: ev.message });
        return;
      }
      case 'handoff': {
        this.pushLine({ who: 'SYS', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position });
        sound.play('handoff');
        return;
      }
      case 'ground_conflict': case 'separation_loss': case 'diversion': case 'fuel_exhaustion': {
        this.pushLine({ who: 'SYS', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position, status: 'error' });
        return;
      }
      default:
        break;
    }
    // generic routing by who
    this.pushLine({ who, at: ev.at, text: ev.message, callsign: ev.callsign !== 'SYSTEM' ? ev.callsign : undefined, position: ev.position });
    if (who === 'PILOT') this.speak(ev.message, 'PILOT', ev.callsign, ev.position);
  }

  private upsertAlertToast(al: Alert, change: 'raised' | 'updated'): void {
    const kind: ToastKind = al.severity === 'critical' ? 'error' : al.severity === 'warning' ? 'attention' : 'info';
    const duration = al.severity === 'critical' ? 0 : al.severity === 'warning' ? 12000 : 6000;
    const existing = this.toasts.find(t => t.alertId === al.id);
    if (existing) {
      this.toasts = this.toasts.map(t => t.alertId === al.id ? { ...t, text: al.title, detail: al.detail, severity: al.severity, kind, callsigns: [...al.subjects] } : t);
      this.emit();
      return;
    }
    if (change === 'updated') return;
    this.pushToast({ kind, severity: al.severity, text: al.title, detail: al.detail, duration, alertId: al.id, callsigns: [...al.subjects] });
  }

  /** The crew's voice follows how pressed it is (an emergency, low fuel, a long wait). */
  private voiceStress(callsign?: string): void { const a = callsign ? this.engine?.find(callsign) : null; if (a) setVoiceStress(a.callsign, stressOf(a)); }
  /** Is this frequency the one the player's seat listens to? Tower: tower (and ground, if they ask for it in Settings >
   *  Audio). Approach: approach and departure. */
  private onMyRadio(p: RadioPosition | undefined): boolean {
    if (!p) return true;
    const owner = POSITION_OWNER[p], seat = this.playerPosition(); if (owner == null) return false;
    return seat === 'approach' ? owner === 'approach' : owner === seat || (owner === 'ground' && this.settings.hearGround);
  }
  private speak(text: string, who: 'PILOT' | 'ATC', callsign?: string, position?: RadioPosition): void {
    // (the answer to the player's own last call is always heard: "contact departure" is read back as the flight leaves)
    if (!this.onMyRadio(position) && !(callsign && callsign === this.lastCallsign)) return;
    if (who === 'PILOT') this.voiceStress(callsign);
    if (this.settings.tts && this.settings.sound && !this.testMode) sound.speak(text, { who, callsign, variant: this.engine?.settings.region });
  }

  /** Readback for `callsign` arrived: the UNDO ring of its latest open ATC line closes (06 §4). */
  private closeUndo(callsign: string, status: string): void {
    for (let i = this.radio.length - 1; i >= 0; i--) {
      const l = this.radio[i];
      if ((l.who !== 'ATC' && l.who !== 'AI') || l.callsign !== callsign) continue;
      const next: RadioLine = { ...l, undoUntil: undefined, status: status === 'mismatch' ? 'mismatch' : status === 'unable' ? 'unable' : status === 'partial' ? 'partial' : l.status };
      this.radio = [...this.radio.slice(0, i), next, ...this.radio.slice(i + 1)];
      return;
    }
  }

  private pushLine(l: Omit<RadioLine, 'key'>): RadioLine {
    if (!l.text) return { ...l, key: -1 } as RadioLine;
    const line: RadioLine = { ...l, key: ++this.lineKey };
    this.radio = this.radio.length >= RADIO_MAX ? [...this.radio.slice(-(RADIO_MAX - 1)), line] : [...this.radio, line];
    this.emit();
    return line;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Commands
  // ═══════════════════════════════════════════════════════════════════════════
  private parseCtx() {
    const e = this.engine!;
    const sel = this.selectedId != null ? e.byId(this.selectedId) : undefined;
    return fromEngine(e, { lastCallsign: sel?.callsign ?? this.lastCallsign, position: this.position });
  }

  /** Comm-log text entry: executeText with the engine context; pushes the ATC line (via the transmission event) or a SYS line.
   *  `opts.position` runs the line as that position (the LLM working a position the player is not on); `opts.who` tags the line. */
  command(text: string, opts: { position?: PlayerPosition; who?: 'ATC' | 'LLM' } = {}): DispatchResult {
    const e = this.engine;
    const trimmed = text.trim();
    if (!e) return { ok: false, code: 'not_implemented', transmission: '', readback: '', reason: 'No airport loaded', warnings: [] };
    if (!trimmed) return { ok: false, code: 'invalid_param', transmission: '', readback: '', reason: 'Empty command', warnings: [] };
    // two aircraft in one breath (spokenEdits.ts twoCalls): one after the other
    const calls = trimmed.includes(' | ') ? trimmed.split(' | ') : opts.who === 'LLM' ? null : twoCallsIn(e, trimmed, this.parseCtx());
    if (calls && calls.length > 1 && calls.length <= 3) { let last: DispatchResult | null = null; for (const c of calls) last = this.command(c, opts); return last!; }
    const position = opts.position ?? this.position;
    const who = opts.who ?? 'ATC';
    const ctx = who === 'LLM' ? fromEngine(e, { lastCallsign: null, position }) : this.parseCtx();
    this.commandWho = who;
    let out: DispatchResult;
    try {
      const { parse, result, ask } = executeText(e, trimmed, ctx, { position });
      if (parse.callsign && who === 'ATC') this.lastCallsign = parse.callsign;
      // a call the pilot could not make out (it heard its callsign, not the rest): it asks for it again, as on the radio
      if (!parse.ok && who === 'ATC' && parse.callsign && e.find(parse.callsign)) this.sayAgain(parse.callsign, ask);
      this.afterDispatch(result, parse.callsign ?? null, trimmed);
      out = result;
      for (const tap of this.commandTaps) { try { tap(parse.callsign ?? null, result, who, trimmed); } catch (err) { console.error(err); } }
    } finally { this.commandWho = 'ATC'; }
    if (who === 'ATC' && this.llm.record) this.llmAgent.recordPlayer(this.playerPosition(), trimmed, out.ok, out.ok ? out.readback : (out.reason ?? out.code));
    return out;
  }
  /** The pilot asks the controller to repeat: a beat after the call, in the comm log and on the radio. */
  private sayAgain(cs: string, ask?: string): void {
    const e = this.engine; if (!e || this.testMode) return;
    setTimeout(() => {
      if (this.engine !== e || !e.find(cs)) return;
      const text = ask ?? `Say again, ${phraseTelephony(cs, e.settings.region)}.`;
      this.pushLine({ who: 'PILOT', at: e.time, text, callsign: cs, position: this.playerPosition() });
      this.speak(text, 'PILOT', cs); this.emit();
    }, 900);
  }
  private playerPosition(): PlayerPosition { return this.position === 'approach' ? 'approach' : this.position === 'ground' ? 'ground' : 'tower'; }
  /** The LLM's advice (advise mode): shown in the comm log as an LLM line the player can type or click. */
  llmSuggest(line: string, position: PlayerPosition): void {
    const e = this.engine; if (!e) return;
    this.pushLine({ who: 'LLM', at: e.time, text: `▸ ${line}`, position, status: 'partial' });
  }
  updateLlm(patch: Partial<LlmConfig>): void {
    this.llm = sanitizeLlm({ ...this.llm, ...patch });
    persist.writeJson(persist.PERSIST_KEYS.llm, this.llm);
    this.llmAgent.sync();
    this.memo.clear();
    this.emit();
  }
  llmStatus(): LlmStatus { return this.llmAgent.status; }

  /** Structured dispatch (click tree, drag gestures, panels). */
  dispatchAst(ast: CommandAST): DispatchResult {
    const e = this.engine;
    if (!e) return { ok: false, code: 'not_implemented', transmission: '', readback: '', reason: 'No airport loaded', warnings: [] };
    const a = isAircraftCommand(ast) ? e.find(ast.callsign) ?? null : null;
    const ctx = a ? this.actionCtx(a) : undefined;
    const result = dispatch(e, ast, ctx ? { ctx } : {});
    if (a) this.lastCallsign = a.callsign;
    this.afterDispatch(result, a?.callsign ?? null, null);
    if (this.llm.record) { let line = ''; try { line = describeAst(ast); } catch { line = ast.kind; } this.llmAgent.recordPlayer(this.playerPosition(), line, result.ok, result.ok ? result.readback : (result.reason ?? result.code)); }
    return result;
  }

  private afterDispatch(result: DispatchResult, callsign: string | null, raw: string | null): void {
    const e = this.engine!;
    this.flushEvents();
    if (!result.ok && isSilent(result.code)) {
      this.pushLine({ who: 'SYS', at: e.time, text: `${raw ? `${raw.toUpperCase()} — ` : ''}${result.reason ?? result.code}`, callsign: callsign ?? undefined, status: 'error' });
      sound.play('error');
    }
    this.emit();
  }

  suggest(prefix: string): Suggestion[] {
    if (!this.engine) return [];
    return suggestText(prefix, this.parseCtx());
  }

  actionCtx(a: AircraftState): ActionCtx | null {
    const e = this.engine; if (!e) return null;
    return actionCtxFromEngine(e, a, { position: this.position });
  }
  actionsFor(a: AircraftState): ActionRow[] {
    const ctx = this.actionCtx(a); if (!ctx) return [];
    return treeActionsFor(a, ctx);
  }
  stepsFor(id: ActionId, a: AircraftState): PickerStep[] {
    const ctx = this.actionCtx(a); if (!ctx) return [];
    return treeStepsFor(id, a, ctx);
  }
  validate(id: ActionId, params: ActionParams, a: AircraftState): ValidationResult {
    const ctx = this.actionCtx(a);
    if (!ctx) return { ok: false, errors: [{ code: 'not_found', reason: null, text: 'No airport loaded', hard: true }], warnings: [], ast: null };
    return treeValidate(id, params, a, ctx);
  }
  /** toAst + dispatch (the TRANSMIT button). */
  transmit(id: ActionId, params: ActionParams, a: AircraftState): DispatchResult {
    let ast: CommandAST;
    try { ast = toAst(id, params, a.callsign, a); }
    catch (err) { return { ok: false, code: 'invalid_param', transmission: '', readback: '', reason: err instanceof Error ? err.message : String(err), warnings: [] }; }
    return this.dispatchAst(ast);
  }

  /** The line whose UNDO ring is still open (newest first), null if none. */
  undoableLine(): RadioLine | null {
    const e = this.engine; if (!e) return null;
    for (let i = this.radio.length - 1; i >= 0; i--) {
      const l = this.radio[i];
      if (l.who !== 'ATC' || l.undoUntil == null || !l.callsign || !l.ast) continue;
      if (e.time >= l.undoUntil) continue;
      if (!canUndo(l.at, e.time, l.undoUntil)) continue;
      return l;
    }
    return null;
  }

  /** Pre-empt the last undoable transmission within its window ("{cs}, disregard."). */
  undo(): boolean {
    const e = this.engine; if (!e) return false;
    const line = this.undoableLine(); if (!line || !line.callsign) return false;
    const r = this.dispatchAst(makeAst('disregard', line.callsign, {}));
    if (!r.ok) return false;
    this.radio = this.radio.map(l => l.key === line.key ? { ...l, undoUntil: undefined, status: 'undone' } : l);
    sound.play('undo');
    this.emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UI state
  // ═══════════════════════════════════════════════════════════════════════════
  select(id: number | null): void {
    const e = this.engine;
    if (id != null && e) {
      const a = e.byId(id);
      if (!a) id = null;
      else { a.attention = false; a.underControl = true; this.lastCallsign = a.callsign; }
    }
    if (this.selectedId === id) return;
    this.selectedId = id;
    if (id != null) sound.play('select');
    this.emit();
  }
  hover(id: number | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.emit();
  }
  setPosition(p: Position): void {
    if (p === 'ground' && !this.testMode) p = 'tower';   // ground is part of the Tower job (no separate tab)
    if (this.position === p) return;
    this.position = p;
    if (this.engine) this.engine.playerPosition = p;
    this.memo.clear();
    this.emit();
  }
  setRate(r: 1 | 2 | 4): void {
    if (r !== 1 && r !== 2 && r !== 4) return;
    this.rate = r;
    this.emit();
  }
  togglePause(): void { this.setPaused(!this.paused); }
  setPaused(b: boolean): void {
    if (this.paused === b) return;
    this.paused = b;
    if (this.engine) this.engine.paused = b;
    if (isBrowser()) this.last = performance.now();
    sound.play(b ? 'pause' : 'resume');
    this.emit();
  }
  toggleTTS(): void { this.updateSettings({ tts: !this.settings.tts }); }
  setMapReady(b: boolean): void {
    if (this.mapReady === b) return;
    this.mapReady = b;
    this.emit();
  }

  /** Merge a settings patch, persist it and apply it to the engine + sound at once. */
  updateSettings(patch: Partial<Settings>, opts: { silent?: boolean } = {}): void {
    this.settings = { ...this.settings, ...patch };
    persist.saveSettings(this.settings);
    sound.setEnabled(this.settings.sound);
    sound.setTTS(this.settings.tts);
    sound.setVolume(this.settings.volume);
    if (this.engine) this.applySettingsToEngine(this.engine);
    if (!opts.silent) this.emit();
  }
  /** Hand a sector to the AI or take it back, mid-shift included. */
  setSectorAi(sector: Sector, ai: boolean): void { this.updateSettings(sectorPatch(sector, ai)); }
  private applySettingsToEngine(e: SimEngine): void {
    const s = this.settings;
    e.settings.autoTower = s.autoTower;
    e.settings.autoGround = s.autoGround;
    e.settings.autoApproach = s.autoApproach;
    e.settings.autoMode = s.autoMode;
    e.settings.autoHandoff = s.autoHandoff;
    e.settings.arrivalFlow = !this.testMode;   // the centre meters arrivals in a real session; test scenarios spawn what they ask for
    e.settings.strictFrequencies = s.strictFrequencies;
    e.settings.radioRealism = s.radioRealism && !this.testMode;
    e.settings.personas = !this.testMode;   // crews with characters in a real session; scripted scenarios stay exact
    if (!this.testMode) {
      e.settings.emergencyRate = s.emergencyRate;
      e.settings.pilotDelayOverride = s.pilotDelayS;
      e.settings.pilotErrorRate = s.readbackErrors ? 0.02 : 0;
    } else if (s.pilotDelayS != null) {
      e.settings.pilotDelayOverride = s.pilotDelayS;
    }
    if (s.region !== 'auto') e.settings.region = s.region;
    const names = this.lastConfig?.naming ?? (this.testMode ? 'real' : namingAt(s.naming, this.icao));
    if (e.setNaming(names) && e.time > 1) this.pushLine({ who: 'SYS', at: e.time, text: `Taxiway and stand names: ${names}. Every label, clearance and call now uses them.` });
  }

  ackAlert(id: string): boolean {
    const e = this.engine; if (!e) return false;
    const ok = e.alerts.ack(id, e.time);
    this.toasts = this.toasts.filter(t => t.alertId !== id);
    this.memo.clear();
    this.emit();
    return ok;
  }
  dismissToast(key: number): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter(t => t.key !== key);
    if (this.toasts.length !== before) this.emit();
  }
  pushToast(t: Omit<Toast, 'key' | 'at'> & { at?: number; duration?: number }): Toast {
    const toast: Toast = { ...t, key: ++this.toastKey, at: t.at ?? Date.now(), duration: t.duration ?? 5000 };
    this.toasts = [...this.toasts, toast].slice(-TOAST_MAX);
    this.emit();
    return toast;
  }
  private pruneToasts(): void {
    if (!this.toasts.length) return;
    const now = Date.now();
    const keep = this.toasts.filter(t => t.duration === 0 || now - t.at < t.duration);
    if (keep.length !== this.toasts.length) { this.toasts = keep; this.emit(); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ops
  // ═══════════════════════════════════════════════════════════════════════════
  /** Dispatch a vehicle by type ('arff' = all three trucks) or by id ('FIRE1'). */
  dispatchVehicle(typeOrId: string, target: VehicleTarget): DispatchResult {
    const e = this.engine;
    if (!e) return { ok: false, code: 'not_implemented', transmission: '', readback: '', reason: 'No airport loaded', warnings: [] };
    const v = e.fleet.byId(typeOrId.toUpperCase());
    const type = (v ? v.type : typeOrId.toLowerCase()) as VehicleType;
    const ids = v ? [v.id] : [];
    const count = v ? 1 : type === 'arff' ? 3 : 1;
    return this.dispatchAst(makeAst('dispatchVehicle', null, { type, ids, count, target }));
  }
  recallVehicle(id: string): DispatchResult {
    return this.dispatchAst(makeAst('recallVehicle', null, { id: id.toUpperCase() }));
  }
  setActiveRunways(dep: string[], arr: string[]): void {
    const e = this.engine; if (!e) return;
    e.setActiveRunways(dep, arr);
    this.flushEvents();
    this.memo.clear();
    this.emit();
  }
  setRunwayStatus(rwy: string, status: RunwayStatus, reason = 'controller'): void {
    const e = this.engine; if (!e) return;
    const out = e.setRunwayStatus(rwy, status, reason);
    this.flushEvents();
    if (!out.ok) this.pushLine({ who: 'SYS', at: e.time, text: out.reason ?? out.code, status: 'error' });
    this.memo.clear();
    this.emit();
  }
  spawnDeparture(): void {
    const e = this.engine; if (!e) return;
    e.spawnDeparture();
    this.flushEvents(); this.emit();
  }
  spawnArrival(): void {
    const e = this.engine; if (!e) return;
    e.spawnArrival();
    this.flushEvents(); this.emit();
  }
  clearTraffic(): void {
    const e = this.engine; if (!e) return;
    e.clear(); this.selectedId = null; this.hoveredId = null;
    this.flushEvents(); this.emit();
  }
  declareEmergency(cs: string, type: EmergencyType): void {
    const e = this.engine; if (!e) return;
    const a = e.find(cs); if (!a) return;
    e.declareEmergency(a, type);
    this.flushEvents(); this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Queries (memoised per version where cheap)
  // ═══════════════════════════════════════════════════════════════════════════
  aircraft(): AircraftState[] { return this.cached('aircraft', () => this.engine ? [...this.engine.aircraft] : []); }
  byId(id: number): AircraftState | undefined { return this.engine?.byId(id); }
  find(cs: string): AircraftState | undefined { return this.engine?.find(cs); }
  selected(): AircraftState | null { return this.selectedId != null ? this.engine?.byId(this.selectedId) ?? null : null; }
  stageOf(a: AircraftState): Stage { return this.engine ? this.engine.stageOf(a) : 'parked'; }
  bayOf(a: AircraftState, position: Position = this.position): BayId | null { return this.engine ? bayFor(a, this.engine.stageOf(a), position) : null; }

  /** Strip bays for a position tab (UX §2.2 + §G7): every bay in its fixed order; emergencies pinned first. */
  stripsFor(position: Position): StripBay[] {
    return this.cached(`strips:${position}`, () => {
      const e = this.engine;
      const bays = new Map<BayId, AircraftState[]>();
      for (const b of BAY_ORDER[position]) bays.set(b, []);
      if (e) {
        for (const a of e.aircraft) {
          const bay = bayFor(a, e.stageOf(a), position);
          if (bay && bays.has(bay)) bays.get(bay)!.push(a);
        }
        for (const [bay, items] of bays) {
          const key = (a: AircraftState) => (DISTANCE_BAYS.has(bay) ? (a.plan.runway ? e.distToThresholdNM(a, a.plan.runway) ?? 999 : 999) : a.spawnedAt);
          items.sort((x, y) => {
            const ex = x.emergency && x.emergency.status !== 'resolved' ? 0 : 1, ey = y.emergency && y.emergency.status !== 'resolved' ? 0 : 1;
            if (ex !== ey) return ex - ey;
            return key(x) - key(y) || x.id - y.id;
          });
        }
      }
      return [...bays].map(([bay, items]) => ({ bay, title: BAY_TITLES[bay], items }));
    });
  }
  // shallow copies: the fleet mutates vehicles in place, and useSim's shallow-equal would otherwise miss a state change (recall / hold) until the next tick
  vehicles(): Vehicle[] { return this.cached('vehicles', () => this.engine ? this.engine.fleet.list().map(v => ({ ...v })) : []); }
  /** The alerts that are the player's: anything about a flight in a sector the AI works stays with the AI, except an
   *  emergency (the tower must know about a Mayday on approach). */
  alerts(): Alert[] { return this.cached('alerts', () => this.engine ? this.engine.activeAlerts().filter((x) => this.alertIsMine(x)) : []); }
  private alertIsMine(x: Alert): boolean {
    const e = this.engine; if (!e || x.kind === 'emergency') return true;
    const acs = x.subjectIds.map((id) => e.byId(id)).filter((a): a is AircraftState => !!a);
    if (!acs.length) return true;
    return acs.some((a) => { const owner = POSITION_OWNER[a.onFrequency]; return owner != null && !e.aiOn(owner); });
  }
  allAlerts(): Alert[] { return this.cached('allAlerts', () => this.engine ? [...this.engine.alerts.list()] : []); }
  atis(): Atis | null { return this.cached('atis', () => { try { return this.engine ? this.engine.weather.atis() : null; } catch { return null; } }); }
  weather(): WeatherState | null { return this.cached('weather', () => this.engine ? this.engine.wx() : null); }
  runways(): RunwayState[] { return this.cached('runways', () => this.engine ? [...this.engine.runwayStates()] : []); }
  suggestedRunways(): { dep: string[]; arr: string[]; reason: string } | null { return this.engine?.suggestedRunways ?? null; }
  stats(): SessionStats { return this.cached('stats', () => this.engine ? { ...this.engine.stats } : emptyStats()); }
  score(): number { return this.engine?.stats.points ?? 0; }
  skill(): number { return this.engine?.stats.skill ?? 0; }
  time(): number { return this.engine?.time ?? 0; }
  counts(): { total: number; air: number; gnd: number; conflict: number; req: number; emerg: number } {
    return this.cached('counts', () => {
      const e = this.engine;
      if (!e) return { total: 0, air: 0, gnd: 0, conflict: 0, req: 0, emerg: 0 };
      const c = e.counts();
      let req = 0, emerg = 0;
      for (const a of e.aircraft) {
        if (a.requests.some(r => r.answeredAt == null) && e.time >= a.standbyUntil) req++;
        if (a.emergency && a.emergency.status !== 'resolved') emerg++;
      }
      return { total: c.total, air: c.air, gnd: c.gnd, conflict: c.conf, req, emerg };
    });
  }
  /** Open pilot requests (oldest first), STANDBY-suppressed ones excluded. */
  requests(): PilotRequest[] {
    return this.cached('requests', () => {
      const e = this.engine; if (!e) return [];
      const out: PilotRequest[] = [];
      for (const a of e.aircraft) { if (e.time < a.standbyUntil) continue; for (const r of a.requests) if (r.answeredAt == null) out.push(r); }
      return out.sort((x, y) => x.at - y.at);
    });
  }
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }> { return this.cached('wake', () => this.engine ? this.engine.wakeTimers() : {}); }
  events(): SimEvent[] { return this.eventLog; }
  clearEvents(): void { this.eventLog = []; }
  /** Active alerts involving a callsign. */
  alertsFor(cs: string): Alert[] { return this.alerts().filter(a => a.subjects.includes(cs)); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Render hooks (canvas views register; test API + panels use)
  // ═══════════════════════════════════════════════════════════════════════════
  registerProjector(kind: ProjectorKind, fn: (xy: XY, altFt?: number) => { x: number; y: number } | null, centerOn: (xy: XY) => void, camera: () => CameraView | null, extras: ProjectorExtras = {}): () => void {
    const p: Projector = { fn, centerOn, camera, extras };
    this.projectors[kind] = p;
    this.emit();
    return () => {
      if (this.projectors[kind] === p) {
        delete this.projectors[kind];
        if (kind === 'ground') this.mapReady = false;
        this.emit();
      }
    };
  }
  /** The projector for the active view (radar on APPROACH, ground otherwise; falls back to whichever is mounted). */
  private activeProjector(): Projector | null {
    const want: ProjectorKind = this.position === 'approach' ? 'radar' : 'ground';
    return this.projectors[want] ?? this.projectors[want === 'radar' ? 'ground' : 'radar'] ?? null;
  }
  activeView(): ProjectorKind | null {
    const want: ProjectorKind = this.position === 'approach' ? 'radar' : 'ground';
    if (this.projectors[want]) return want;
    return this.projectors.radar ? 'radar' : this.projectors.ground ? 'ground' : null;
  }
  /** Where a point shows on screen; `altFt` for one in the air (the 3D map draws it above its ground position). */
  screenProject(xy: XY, altFt = 0): { x: number; y: number } | null {
    const p = this.activeProjector(); if (!p) return null;
    try { return p.fn(xy, altFt); } catch { return null; }
  }
  screenPos(id: number): { x: number; y: number } | null {
    const a = this.engine?.byId(id); if (!a) return null;
    return this.screenProject(a.pos);
  }
  centerOnXY(xy: XY): void {
    const p = this.activeProjector(); if (!p) return;
    try { p.centerOn(xy); } catch { /* view not ready */ }
  }
  /** The camera to a flight. On the 3D map, which cannot leave the airport: an airborne departure leaves the camera
   *  where it is; an airborne arrival shows the runway it will land on; a landed arrival is framed with its stand. */
  centerOn(id: number): void {
    const a = this.engine?.byId(id), e = this.engine; if (!a || !e) return;
    const p = this.activeProjector()
    if (p && !this.projectors.radar && p.extras.frame) {
      const onGround = ['parked', 'startup', 'pushback', 'taxi', 'hold_short', 'lineup', 'rollout', 'arrived'].includes(a.phase) || a.altitude < 30
      if (!onGround) {
        if (a.plan.kind !== 'arrival') return
        const rwy = a.assignedRunway ?? a.plan.runway, thr = rwy ? e.thresholdXY(rwy) : null, end = rwy ? e.runwayByEnd(rwy) : null
        if (thr && end) { const h = end.end.trueHdg * Math.PI / 180; p.extras.frame([{ x: thr.x - Math.sin(h) * 400, y: thr.y - Math.cos(h) * 400 }, { x: thr.x + Math.sin(h) * 1600, y: thr.y + Math.cos(h) * 1600 }], { bearing: end.end.trueHdg }); return }
        return
      }
      const st = a.plan.kind === 'arrival' && a.phase !== 'arrived' ? (a.reservedStand ?? a.plan.gateRef) : null
      const g = st ? e.gateByRef(st) : null
      if (g) { p.extras.frame([a.pos, e.gateXY(g)]); return }
    }
    this.centerOnXY(a.pos);
  }
  camera(): CameraView | null {
    const p = this.activeProjector(); if (!p) return null;
    try { return p.camera(); } catch { return null; }
  }
  setCamera(cam: CameraView): void {
    const p = this.activeProjector(); if (!p) return;
    try {
      if (p.extras.setCamera) { p.extras.setCamera(cam); return; }
      if ('lng' in cam) { if (this.engine) p.centerOn(this.engine.proj.toXY(cam.lat, cam.lng)); }
      else p.centerOn({ x: cam.x, y: cam.y });
    } catch { /* view not ready */ }
  }
  /** True when a CSS point relative to the active canvas actually hits the canvas (not a floating panel / toolbar) — emptySpot(). */
  spotFree(x: number, y: number): boolean {
    if (!isBrowser() || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return true;
    const kind = this.activeView();
    const el = document.querySelector<HTMLElement>(kind === 'radar' ? '[data-testid="radar-canvas"]' : '[data-testid="ground-map"]');
    if (!el) return true;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + x, r.top + y);
    return !!hit && hit.tagName === 'CANVAS';
  }
  /** CSS size of the active canvas (registered getter, else DOM lookup by testid). */
  viewSize(): { w: number; h: number } | null {
    const p = this.activeProjector();
    try {
      const s = p?.extras.size?.(); if (s && s.w > 0 && s.h > 0) return s;
    } catch { /* ignore */ }
    if (!isBrowser() || typeof document === 'undefined') return null;
    const kind = this.activeView();
    const el = document.querySelector<HTMLElement>(kind === 'radar' ? '[data-testid="radar-canvas"]' : '[data-testid="ground-map"]')
      ?? document.querySelector<HTMLElement>('[data-testid="radar-canvas"], [data-testid="ground-map"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null;
  }
}

function emptyStats(): SessionStats {
  return {
    startedAt: 0, simTime: 0, score: 0, skill: 0, points: 0, movements: 0, departures: 0, arrivals: 0, movementsPerHour: 0, movementsHistory: [],
    delayAvgS: 0, delayP95S: 0, delaySamples: [], incidents: {}, ledger: [], goAroundsPlayer: 0, goAroundsPilot: 0, diversions: 0,
    emergenciesDeclared: 0, emergenciesResolved: 0, arffResponseS: [], transmissions: 0, responsivenessMeanS: 0, unansweredRequests: 0, streakS: 0,
  };
}
function readbackStatus(s: string): RadioLine['status'] {
  switch (s) { case 'unable': return 'unable'; case 'partial': return 'partial'; case 'mismatch': return 'mismatch'; default: return 'ok'; }
}

export type { SimStore };

// ──────────────────────────────────────────────────────────────────────────────
//  Singleton (HMR-safe) on window.__atcSim
// ──────────────────────────────────────────────────────────────────────────────
declare global {
  interface Window { __atcSim?: SimStore }
}
export const sim: SimStore = (() => {
  if (typeof window !== 'undefined') {
    const w = window as Window;
    if (!w.__atcSim) w.__atcSim = new SimStore();
    return w.__atcSim;
  }
  return new SimStore();
})();

// ──────────────────────────────────────────────────────────────────────────────
//  React hooks
// ──────────────────────────────────────────────────────────────────────────────
function depsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Subscribe to the store with a selector. Re-evaluates the selector only when
 * `sim.version` (or `deps`) changes; the result is kept identity-stable when it
 * is shallow-equal to the previous one, so plain object/array selectors are safe.
 */
export function useSim<T>(selector: (s: SimStore) => T, deps: readonly unknown[] = []): T {
  const ref = useRef<{ v: number; deps: readonly unknown[]; value: T } | null>(null);
  const read = () => {
    const v = sim.version;
    const c = ref.current;
    if (c && c.v === v && depsEqual(c.deps, deps)) return c.value;
    const next = selector(sim);
    const value = c && shallowEqual(c.value, next) ? c.value : next;
    ref.current = { v, deps, value };
    return value;
  };
  return useSyncExternalStore(sim.subscribe, read, read);
}

/** The bare version counter (re-render on every emit). */
export function useSimVersion(): number {
  return useSyncExternalStore(sim.subscribe, () => sim.version, () => 0);
}

// ──────────────────────────────────────────────────────────────────────────────
//  Geometry helpers kept for the canvas views
// ──────────────────────────────────────────────────────────────────────────────
/** Glideslope intercept distance (NM from threshold) for an altitude on a gs°. */
export function gsInterceptNM(altFt: number, gsDeg: number, thrElevFt = 0): number {
  return (altFt - thrElevFt) / (Math.tan(gsDeg * DEG) * 6076);
}
export { headingTo, advance, NM };
