/*
  Model updates pushed to players (public/model-updates.json, written by scripts/model-release.mjs; the phone app reads the
  same file). Checked when the game opens, every six hours and on coming back to the tab. A player who has a model on the
  device is asked; one who has not simply gets the newest when it is first used. Only folders on this site are accepted.
*/
import type { ModelId } from './manager';

export interface ReleaseFile { name: string; size: number; sha256: string; role?: string }
export interface Release { version: string; aliases: string[]; title: string; what: string; notes: string[]; dir: string; bytes: number; files: ReleaseFile[] }
export type Releases = Partial<Record<ModelId, Release>>;

const SNOOZE = 'skycontrol_model_snooze';   // { "stt@v2": until (ms) | -1 = skip this version }
let current: Releases = {};
const subs = new Set<() => void>();
export const releases = (): Releases => current;
export const onReleases = (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; };

export function parseReleases(j: unknown): Releases {
  const o = j as { schema?: number; models?: Record<string, Release> };
  if (!o || o.schema !== 1 || !o.models) return {};
  const out: Releases = {};
  for (const id of ['s1', 'stt', 'tts'] as ModelId[]) {
    const m = o.models[id];
    if (!m || typeof m.version !== 'string' || !/^\/models\/[\w./-]+$/.test(m.dir ?? '') || m.dir.includes('..') || !Array.isArray(m.files) || !m.files.every((f) => /^[\w.-]+$/.test(f.name) && f.size > 0 && /^[0-9a-f]{64}$/.test(f.sha256))) continue;
    out[id] = { ...m, aliases: m.aliases ?? [], notes: (m.notes ?? []).map(String).slice(0, 6), bytes: m.files.reduce((a, f) => a + f.size, 0) };
  }
  return out;
}
export async function checkReleases(): Promise<void> {
  try {
    const r = await fetch('/model-updates.json', { cache: 'no-store' }); if (!r.ok) return;
    current = parseReleases(await r.json()); for (const f of subs) f();
  } catch { /* offline: ask another time */ }
}
/** Start checking (once per page). */
let started = false;
export function watchReleases(): void {
  if (started || typeof window === 'undefined') return; started = true;
  let last = 0; const go = () => { if (Date.now() - last < 60_000) return; last = Date.now(); void checkReleases(); };
  go(); window.setInterval(go, 6 * 3600_000); document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
}
const snoozed = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(SNOOZE) ?? '{}') as Record<string, number>; } catch { return {}; } };
export const isSnoozed = (id: ModelId, version: string, now = Date.now()): boolean => { const v = snoozed()[`${id}@${version}`]; return v === -1 || (v ?? 0) > now; };
export function snooze(id: ModelId, version: string, forever: boolean): void { try { localStorage.setItem(SNOOZE, JSON.stringify({ ...snoozed(), [`${id}@${version}`]: forever ? -1 : Date.now() + 24 * 3600_000 })); } catch { /* */ } }

// ── where each model is loaded from: the folder the player installed, else the newest release, else what shipped ──
const DIRS = 'skycontrol_model_dirs';
const dirs = (): Partial<Record<ModelId, string>> => { try { return JSON.parse(localStorage.getItem(DIRS) ?? '{}') as Partial<Record<ModelId, string>>; } catch { return {}; } };
export const installedDir = (id: ModelId): string | null => dirs()[id] ?? null;
export function setInstalledDir(id: ModelId, dir: string | null): void { try { const d = dirs(); if (dir) d[id] = dir; else delete d[id]; localStorage.setItem(DIRS, JSON.stringify(d)); } catch { /* */ } }
