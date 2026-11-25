/*
  The game settings on their own (types, defaults, checks), without the simulation behind them: the start page and the
  settings page read and write them before the game's code has been downloaded. simStore.ts re-exports all of it.
*/
import type { Sector } from '@/lib/sim/types';

export interface Settings {
  autoTower: boolean;
  autoGround: boolean;
  autoApproach: boolean;
  autoMode: boolean;
  autoHandoff: boolean;
  strictFrequencies: boolean;
  emergencyRate: 'off' | 'rare' | 'normal' | 'training';
  groundTheme: 'satellite' | 'chart';
  showRings: boolean;
  difficulty: 'low' | 'normal' | 'high';
  sound: boolean;
  tts: boolean;
  /** Tower only: also voice the ground frequency. Off: only the seat's own frequency is heard. */
  hearGround: boolean;
  /** Crews that talk over each other and callsigns that sound alike. */
  radioRealism: boolean;
  /** 0..1 master volume. */
  volume: number;
  /** Fixed pilot delay in sim seconds (1-8), null = realistic 2-4 s air / 4-8 s ground. */
  pilotDelayS: number | null;
  /** Pilots occasionally read back a wrong value (2 %). */
  readbackErrors: boolean;
  /** Phraseology variant; 'auto' = FAA for K-airports, ICAO elsewhere. */
  region: 'auto' | 'ICAO' | 'FAA';
  /** Taxiway and stand names: the airport's own, or the simple set (lib/sim/naming.ts). 'auto' = real at SFO, simple elsewhere. */
  naming: 'auto' | 'real' | 'simple';
  /** Drag-to-heading transmits without confirm. */
  instantVectors: boolean;
  /** Typed command line transmits without confirm. */
  typedInstant: boolean;
}

/** Who works a sector: true = the AI, false = the player. Airfield = ground + tower (one controller), approach = approach + departure. */
export function sectorAi(s: Pick<Settings, 'autoGround' | 'autoTower' | 'autoApproach'>, sector: Sector): boolean {
  return sector === 'airfield' ? s.autoGround && s.autoTower : s.autoApproach;
}
export function sectorPatch(sector: Sector, ai: boolean): Partial<Settings> {
  return sector === 'airfield' ? { autoGround: ai, autoTower: ai, autoMode: true } : { autoApproach: ai, autoMode: true };
}

export const DEFAULT_SETTINGS: Settings = {
  autoTower: false, autoGround: false, autoApproach: false, autoMode: true, autoHandoff: true, strictFrequencies: false, emergencyRate: 'normal',
  groundTheme: 'satellite', showRings: true, difficulty: 'low', sound: true, tts: true, hearGround: false, volume: 0.8,
  pilotDelayS: null, readbackErrors: true, radioRealism: true, region: 'auto', naming: 'auto', instantVectors: false, typedInstant: true,
};

export function sanitizeSettings(s: Settings): Settings {
  const out: Settings = { ...s };
  const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const o = out as unknown as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (d[k] == null) { if (o[k] != null && typeof o[k] !== 'number' && typeof o[k] !== 'string' && typeof o[k] !== 'boolean') o[k] = d[k]; continue; }   // nullable option (e.g. pilotDelayS)
    if (o[k] == null || typeof o[k] !== typeof d[k] || (typeof o[k] === 'number' && !isFinite(o[k] as number))) o[k] = d[k];
  }
  if (!['low', 'normal', 'high'].includes(out.difficulty)) out.difficulty = DEFAULT_SETTINGS.difficulty;
  if (!['satellite', 'chart'].includes(out.groundTheme)) out.groundTheme = DEFAULT_SETTINGS.groundTheme;
  if (!['auto', 'real', 'simple'].includes(out.naming)) out.naming = DEFAULT_SETTINGS.naming;
  if (typeof out.volume === 'number') out.volume = Math.min(1, Math.max(0, out.volume));
  // control is per sector: the sector the player is not on is always the AI's (autoMode), and each sector's own switch
  // hands the one the player is on to the AI as well; ground and tower go to the AI together
  out.autoMode = true;
  if (out.autoGround !== out.autoTower) out.autoGround = out.autoTower = out.autoGround || out.autoTower;
  return out;
}

/** Which names an airport shows under a setting. */
export const namingAt = (n: Settings['naming'], icao: string): 'real' | 'simple' => (n === 'auto' ? (icao === 'KSFO' ? 'real' : 'simple') : n);
