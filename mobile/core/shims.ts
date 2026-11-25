/*
  Globals the web game's modules expect, for an embedded JS engine with no DOM (QuickJS on Android, JavaScriptCore on
  iOS through flutter_js). Imported first by core.ts, so they exist before any game module runs.

  - localStorage: in memory; the app reads the whole store with ATC.storage() and puts it back with ATC.restore().
  - fetch: answers only the files the app handed in with ATC.provide(path, text) (airport data); anything else fails,
    so nothing in the game reaches the network from here.
  - queueMicrotask / performance / TextEncoder: older engines lack some of them.
*/
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any

const store = new Map<string, string>()
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
export const storageDump = (): Record<string, string> => Object.fromEntries(store)
export const storageLoad = (o: Record<string, string>): void => { for (const [k, v] of Object.entries(o)) store.set(k, v) }

export const provided = new Map<string, string>()
g.fetch = async (url: string) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const body = provided.get(path)
  if (body == null) return { ok: false, status: 404, json: async () => { throw new Error(`no ${path}`) }, text: async () => '' }
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }
}

g.queueMicrotask ??= (fn: () => void) => { Promise.resolve().then(fn) }
g.performance ??= { now: () => Date.now() }

// Timers on the app's clock: ATC.tick(dt) advances them (advanceTimers), so the tutorial coach's 4 Hz tick and its
// delays run with the game, pause with it, and never need an event loop of the engine's own.
let clock = 0, timerSeq = 1
const timers = new Map<number, { at: number; fn: () => void; every: number }>()
const addTimer = (fn: (...a: unknown[]) => void, ms: unknown, every: boolean, args: unknown[]) => {
  const d = Math.max(0, Number(ms) || 0), id = timerSeq++
  timers.set(id, { at: clock + d, fn: () => fn(...args), every: every ? Math.max(1, d) : 0 })
  return id
}
g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => addTimer(fn, ms, false, a)
g.setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => addTimer(fn, ms, true, a)
g.clearTimeout = g.clearInterval = (id: number) => { timers.delete(id) }
/** Milliseconds of app time so far (what the timers run on). */
export const clockMs = (): number => clock
export function advanceTimers(ms: number): void {
  clock += ms
  for (let guard = 0; guard < 1000; guard++) {
    let next: [number, { at: number; fn: () => void; every: number }] | null = null
    for (const t of timers) if (t[1].at <= clock && (!next || t[1].at < next[1].at)) next = t
    if (!next) break
    const [id, t] = next
    if (t.every) t.at = Math.max(t.at + t.every, clock - t.every + 1); else timers.delete(id)   // an interval late by many periods runs once
    try { t.fn() } catch (e) { (g.console as Console).error(e) }
  }
}
// the store's own frame loop never starts here (no window); this only tells the coach that frames drive the sim
g.requestAnimationFrame ??= () => 0
g.cancelAnimationFrame ??= () => undefined
g.console ??= { log() {}, warn() {}, error() {}, info() {}, debug() {} }

// QuickJS 2020-11-08 (flutter_js) predates ES2022: the game uses .at(); the rest are cheap insurance
function at(this: ArrayLike<unknown>, i: number) { const n = Math.trunc(i) || 0; const k = n < 0 ? this.length + n : n; return k >= 0 && k < this.length ? this[k] : undefined }
for (const C of [Array, String, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
  if (!(C.prototype as any).at) Object.defineProperty(C.prototype, 'at', { value: at, writable: true, configurable: true })
}
if (!(Array.prototype as any).findLast) {
  Object.defineProperty(Array.prototype, 'findLast', { value(this: unknown[], f: (v: unknown, i: number, a: unknown[]) => boolean) { for (let i = this.length - 1; i >= 0; i--) if (f(this[i], i, this)) return this[i]; return undefined }, writable: true, configurable: true })
  Object.defineProperty(Array.prototype, 'findLastIndex', { value(this: unknown[], f: (v: unknown, i: number, a: unknown[]) => boolean) { for (let i = this.length - 1; i >= 0; i--) if (f(this[i], i, this)) return i; return -1 }, writable: true, configurable: true })
}
if (!(Object as any).hasOwn) (Object as any).hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k)
if (!(String.prototype as any).replaceAll) {
  Object.defineProperty(String.prototype, 'replaceAll', { value(this: string, a: string | RegExp, b: any) { return typeof a === 'string' ? this.split(a).join(typeof b === 'function' ? b(a) : b) : this.replace(a, b) }, writable: true, configurable: true })
}

if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class {
    encode(s: string): Uint8Array {
      const out: number[] = []
      for (const ch of unescape(encodeURIComponent(s))) out.push(ch.charCodeAt(0))
      return Uint8Array.from(out)
    }
  }
}
if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class {
    decode(b?: Uint8Array): string {
      if (!b) return ''
      let s = ''
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
      try { return decodeURIComponent(escape(s)) } catch { return s }
    }
  }
}
