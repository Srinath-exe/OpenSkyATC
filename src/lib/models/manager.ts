/*
  The models this game runs, and the player's control over them (Settings > AI models): what each one does, how big it
  is, whether it is on this device yet, how fast it runs here. "Download" fetches the files (with progress) into the
  browser's cache and then loads the model once in its own worker and times one real inference, so the numbers shown
  are this device's. Records are kept in localStorage; the files themselves sit in the browser's HTTP cache (/models/*
  is served immutable for a year) or, for the speech model, in transformers.js's Cache Storage.
*/
import { useSyncExternalStore } from 'react';
import { L1Client, S1_MODEL_URL, s1Url } from '@/lib/voice/l1';
import { installedDir, releases, onReleases, setInstalledDir } from './updates';
import { LS, EV_VOICE_ENGINE, readJson, writeJson } from '@/game/persist';
import type { VoiceEngine } from '@/lib/voice/recognizer';

export type ModelId = 's1' | 'stt' | 'tts';
/** Where our speech model's files are served from, and the Cache Storage they are kept in once downloaded (the worker
 *  public/voice/atc-asr-worker.js reads the same cache). */
export const STT_DIR = process.env.NEXT_PUBLIC_STT_MODEL_BASE || '/models/stt/parakeet-110m-atc-v1/';   // a CDN can serve it (set the env)
export const MODEL_CACHE = 'skycontrol-models-v1';
/** The version this build ships of each model; the update channel (updates.ts) may name a newer one. */
const BUILT: Record<ModelId, string> = { s1: S1_MODEL_URL.split('/').pop()!, stt: '2026-11-11', tts: 'v1.2' };
const BUILT_ALIASES: Record<ModelId, string[]> = { s1: [], stt: ['v1'], tts: [] };
/** The newest version of each model. */
export const MODEL_VERSION: Record<ModelId, string> = new Proxy(BUILT, { get: (t, id: ModelId) => releases()[id]?.version ?? t[id] });
/** The speech model's folder: the one installed on this device, else the newest. */
export const sttDir = (): string => installedDir('stt') ?? newestSttDir();
const newestSttDir = (): string => { const r = releases().stt; return r && r.version !== BUILT.stt ? `${r.dir}/` : STT_DIR; };
export interface ModelInfo {
  id: ModelId;
  name: string;
  /** what it does for the player, one line */
  role: string;
  model: string;
  /** download, MB (the model files; runtimes from the CDN are listed in `extra`) */
  sizeMB: number;
  extra?: string;
  /** memory once loaded, MB (estimate: weights plus the runtime's working set) */
  ramMB: number;
  /** what runs instead when this one is not used */
  instead: string;
  files: string[];
  /** where the model is published (Hugging Face), when it is ours */
  hub?: string;
}

export const MODELS: ModelInfo[] = [
  { id: 's1', name: 'Command model', role: 'The main model: turns what you said into the command the game carries out, and checks the readback', model: 'S1-2M (2 M parameters, RL-tuned on ATC transcripts)', sizeMB: 2.1, ramMB: 15, instead: 'Always on this device; without it the rules alone parse your words', files: [`${S1_MODEL_URL}/model.json`, `${S1_MODEL_URL}/model.bin`], hub: 'https://huggingface.co/srinath-exe/skycontrol-atc-command-2m' },
  { id: 'stt', name: 'ATC-ASR', role: 'Our speech model, fine-tuned on ATC radio: hears your push-to-talk and writes it down. On this device it works offline and your voice never leaves it', model: 'parakeet-110m-atc v1 (110 M parameters, int8 ONNX, WebAssembly)', sizeMB: 136, extra: 'plus ONNX Runtime Web from the CDN (~11 MB)', ramMB: 450, instead: 'The same model on this game\'s server: audio streams there, is not stored, and the text is back ~0.3 s after you let go', files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].map((f) => `${STT_DIR}${f}`) },
  { id: 'tts', name: 'Pilot voices', role: 'Speaks every pilot readback and request, four voices over a radio filter', model: 'Paradee-8M v1.2 (8 M parameters, int8 ONNX)', sizeMB: 8.2, extra: 'plus ONNX Runtime Web from the CDN (~11 MB)', ramMB: 90, instead: 'The browser\'s built-in voice (the same for every pilot)', files: ['/models/tts/paradee-8m-v1.2/config.json', '/models/tts/paradee-8m-v1.2/paradee_int8.onnx', '/models/tts/atc-lexicon-v1.json'] },
];

export interface ModelState { state: 'none' | 'downloading' | 'ready' | 'error'; progress: number; bytes: number; loadMs: number | null; runMs: number | null; device: string; at: number | null; message: string; version?: string }
const KEY = 'skycontrol_models_v1';
const blank = (): ModelState => ({ state: 'none', progress: 0, bytes: 0, loadMs: null, runMs: null, device: '', at: null, message: '' });
let states: Record<ModelId, ModelState> = { s1: blank(), stt: blank(), tts: blank() };
let net: { rttMs: number | null; at: number | null } = { rttMs: null, at: null };
let loaded = false;
const subs = new Set<() => void>();
let snap = { states, net };
function emit() { snap = { states: { ...states }, net: { ...net } }; for (const f of subs) f(); }
function hydrate() {
  if (loaded || typeof window === 'undefined') return; loaded = true;
  const saved = readJson<Partial<Record<ModelId, ModelState>>>(KEY, {});
  for (const m of MODELS) { const r = saved[m.id]; if (r && r.state === 'ready') states[m.id] = { ...blank(), ...r }; }
  snap = { states: { ...states }, net };
}
function save() { const out: Partial<Record<ModelId, ModelState>> = {}; for (const m of MODELS) if (states[m.id].state === 'ready') out[m.id] = states[m.id]; writeJson(KEY, out); }
function put(id: ModelId, p: Partial<ModelState>) { states = { ...states, [id]: { ...states[id], ...p } }; emit(); }
const subscribe = (f: () => void) => { hydrate(); subs.add(f); return () => { subs.delete(f); }; };
const SERVER_SNAP = { states: { s1: blank(), stt: blank(), tts: blank() }, net: { rttMs: null, at: null } };
export function useModels() { return useSyncExternalStore(subscribe, () => { hydrate(); return snap; }, () => SERVER_SNAP); }

// ── voice preferences, shared by every settings view (one store, so two views never disagree) ──
const vsubs = new Set<() => void>();
let vsnap: { engine: VoiceEngine; pilot: 'neural' | 'browser' } | null = null;
function readVoice() { return { engine: readJson<VoiceEngine>(LS.voiceEngine, 'server'), pilot: readJson<'neural' | 'browser'>(LS.pilotVoice, 'neural') === 'browser' ? 'browser' as const : 'neural' as const }; }
export function useVoicePrefs() {
  return useSyncExternalStore((f) => { vsubs.add(f); return () => { vsubs.delete(f); }; }, () => (vsnap ??= readVoice()), () => ({ engine: 'server' as VoiceEngine, pilot: 'neural' as const }));
}
export function setVoiceEngine(v: VoiceEngine) { writeJson(LS.voiceEngine, v); vsnap = readVoice(); for (const f of vsubs) f(); window.setTimeout(() => window.dispatchEvent(new Event(EV_VOICE_ENGINE)), 0); }
export function setPilotVoice(v: 'neural' | 'browser') { writeJson(LS.pilotVoice, v); vsnap = readVoice(); for (const f of vsubs) f(); }

// ── downloads ──
/** Fetch files with progress (the response lands in the HTTP cache, where the game's loaders find it). */
async function fetchAll(id: ModelId, urls: string[]): Promise<number> {
  const sizes = await Promise.all(urls.map(async (u) => { try { const r = await fetch(u, { method: 'HEAD' }); return Number(r.headers.get('content-length')) || 0; } catch { return 0; } }));
  const total = sizes.reduce((a, b) => a + b, 0); let got = 0;
  for (const u of urls) {
    const r = await fetch(u); if (!r.ok || !r.body) throw new Error(`${u}: ${r.status}`);
    const rd = r.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; got += value.byteLength; put(id, { progress: total ? Math.min(0.95, got / total * 0.95) : 0.5, bytes: got }); }
  }
  return got;
}
function onceWorker(url: string, msgs: Array<Record<string, unknown>>, onProgress?: (m: { loaded: number; total: number; file: string }) => void, timeoutMs = 180000): Promise<Array<Record<string, any>>> {
  return new Promise((ok, err) => {
    const w = new Worker(url, { type: 'module' }); const out: Array<Record<string, any>> = []; let i = 0;
    const t = setTimeout(() => { w.terminate(); err(new Error('timed out')); }, timeoutMs);
    const next = () => { if (i >= msgs.length) { clearTimeout(t); w.terminate(); ok(out); return; } w.postMessage(msgs[i++]); };
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { onProgress?.(m); return; }
      if (m.type === 'error') { clearTimeout(t); w.terminate(); err(new Error(m.message)); return; }
      if (['ready', 'audio', 'result', 'completion', 'prefilled'].includes(m.type)) { out.push(m); next(); }
    };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); err(new Error(e.message || 'worker failed')); };
    next();
  });
}
const running = new Set<ModelId>();
export async function downloadModel(id: ModelId): Promise<boolean> {
  if (running.has(id)) return false; running.add(id);
  put(id, { state: 'downloading', progress: 0, message: '' });
  const t0 = performance.now();
  try {
    if (id === 's1') {
      // (a download is the newest: installed only once it has loaded and answered)
      const dir = releases().s1?.dir ?? S1_MODEL_URL;
      const bytes = await fetchAll(id, [`${dir}/model.json`, `${dir}/model.bin`]);
      const c = new L1Client(dir); const tl = performance.now(); await c.load(); const loadMs = performance.now() - tl;
      const r = await c.complete('united two one four climb and maintain five thousand', ['UAL214']); c.dispose(); setInstalledDir('s1', dir); window.dispatchEvent(new Event('skycontrol-s1-changed'));
      put(id, { state: 'ready', progress: 1, bytes, loadMs: Math.round(loadMs), runMs: Math.round(r.ms), device: 'WebAssembly', at: Date.now() });
    } else if (id === 'tts') {
      const bytes = await fetchAll(id, MODELS[2].files);
      const out = await onceWorker('/voice/tts-worker.js', [{ type: 'load', id: 1 }, { type: 'speak', id: 2, text: 'Climb and maintain five thousand, United two one four.', voice: 'am_puck', speed: 1 }]);
      put(id, { state: 'ready', progress: 1, bytes, loadMs: Math.round(performance.now() - t0), runMs: out[1]?.ms ?? null, device: 'WebAssembly', at: Date.now() });
    } else {
      const files = new Map<string, { loaded: number; total: number }>();
      const audio = new Float32Array(16000 * 2); for (let i = 0; i < audio.length; i++) audio[i] = (Math.random() - 0.5) * 0.002;
      // fresh copies into Cache Storage (an update replaces the old files), then load once in the worker and time 2 s of audio
      const dir = newestSttDir();
      // (an update lives in another folder: the old one keeps working until the new one has loaded)
      if (dir === sttDir()) { try { await caches.delete(MODEL_CACHE); } catch { /* none yet */ } }
      const out = await onceWorker(`/voice/atc-asr-worker.js?dir=${encodeURIComponent(dir)}`, [{ type: 'load' }, { type: 'transcribe', id: 1, audio }], (m) => {
        files.set(m.file, { loaded: m.loaded, total: m.total }); let l = 0, t = 0; files.forEach((f) => { l += f.loaded; t += f.total; });
        put(id, { progress: Math.min(0.95, l / (MODELS[1].sizeMB * 1e6) * 0.95), bytes: l });
      }, 900000);
      setInstalledDir('stt', dir);
      try { const c = await caches.open(MODEL_CACHE); for (const q of await c.keys()) if (!q.url.includes(dir.replace(/^https?:\/\/[^/]+/, ''))) await c.delete(q); } catch { /* nothing to clear */ }
      if (readVoice().engine === 'local') window.setTimeout(() => window.dispatchEvent(new Event(EV_VOICE_ENGINE)), 0);   // the recogniser restarts on the new files
      let bytes = 0; files.forEach((f) => { bytes += f.total || f.loaded; });
      put(id, { state: 'ready', progress: 1, bytes: bytes || states.stt.bytes, loadMs: out[0]?.ms ?? null, runMs: out[1]?.ms ?? null, device: out[0]?.device ?? out[1]?.device ?? '', at: Date.now() });
    }
    put(id, { version: MODEL_VERSION[id] }); save(); return true;
  } catch (e) {
    put(id, { state: 'error', message: String((e as Error).message || e).slice(0, 160) }); return false;
  } finally { running.delete(id); }
}

/** Remove a model from this device: its files go, and whatever used it falls back (speech to the server, pilot voices
 *  to the browser's). */
export async function removeModel(id: ModelId): Promise<void> {
  if (running.has(id)) return;
  try {
    if (id === 'stt') await caches.delete(MODEL_CACHE);
    else { const c = await caches.open(MODEL_CACHE); for (const u of MODELS.find((m) => m.id === id)!.files) await c.delete(u); }
  } catch { /* nothing stored */ }
  states = { ...states, [id]: blank() }; setInstalledDir(id, null); emit(); save();
  if (id === 'stt' && readVoice().engine === 'local') setVoiceEngine('server');
  if (id === 'tts' && readVoice().pilot === 'neural') setPilotVoice('browser');
}
/** A newer version of a downloaded model is out. */
export const updateAvailable = (id: ModelId, st: ModelState) => {
  if (st.state !== 'ready') return false;
  const r = releases()[id], newest = r?.version ?? BUILT[id], same = [newest, ...(r ? r.aliases : BUILT_ALIASES[id])];
  return !same.includes(st.version ?? '');
};
if (typeof window !== 'undefined') onReleases(() => emit());   // a newer release arrived: every view of the models refreshes

/** Round trip to this game's server (median of three small no-cache requests): what an on-device model saves per call. */
export async function measureServer(): Promise<number | null> {
  const ts: number[] = [];
  for (let i = 0; i < 3; i++) { const t = performance.now(); try { await fetch(`/icon.svg?rtt=${Date.now()}-${i}`, { cache: 'no-store' }); ts.push(performance.now() - t); } catch { /* offline */ } }
  ts.sort((a, b) => a - b); net = { rttMs: ts.length ? Math.round(ts[Math.floor(ts.length / 2)]) : null, at: Date.now() }; emit(); return net.rttMs;
}

/** Everything on this device: download all three, switch the pilot voices to it (and speech too only when asked: the
 *  on-device recogniser is much less accurate than the server's), ask the browser to keep the files. */
export async function goOnDevice(opts: { speech?: boolean } = {}): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* not offered */ }
  for (const m of MODELS) if (states[m.id].state !== 'ready') await downloadModel(m.id);
  if (states.stt.state === 'ready' && opts.speech) setVoiceEngine('local');
  if (states.tts.state === 'ready') setPilotVoice('neural');
}

export async function storageUse(): Promise<{ usedMB: number; quotaMB: number; persisted: boolean } | null> {
  try { const e = await navigator.storage.estimate(); const persisted = (await navigator.storage.persisted?.()) ?? false; return { usedMB: (e.usage ?? 0) / 1e6, quotaMB: (e.quota ?? 0) / 1e6, persisted }; } catch { return null; }
}
