import { LIMITS } from "./limits";
import { cleanText, cleanUrl } from "./redact";

export interface ConsoleEntry { level: "error" | "warn"; message: string; at: string }
export interface NetworkEntry { method: string; url: string; status: number | null; ms: number; requestId: string | null; at: string }

const consoleLog: ConsoleEntry[] = [];
const networkLog: NetworkEntry[] = [];
let installed = false;

function push<T>(list: T[], item: T, max: number) {
  list.push(item);
  if (list.length > max) list.shift();
}

function asText(args: unknown[]): string {
  const one = (a: unknown) => {
    if (a instanceof Error) return [`${a.name}: ${a.message}`, ...(a.stack ?? "").split("\n").slice(1, 4)].join("\n");
    if (typeof a === "string") return a;
    try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
  };
  return cleanText(args.map(one).join(" ")).slice(0, 1200);
}

/**
 * Call once, as early as the app boots, so errors from the first render are kept.
 * Two small buffers in memory; nothing leaves the page until a report is sent.
 * Bodies and headers are never read, except the response's x-request-id.
 */
export function installCapture(opts: { isOwnApi: (path: string) => boolean; isReporterCall: (path: string) => boolean }) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const log = (level: ConsoleEntry["level"], args: unknown[]) =>
    push(consoleLog, { level, message: asText(args), at: new Date().toISOString() }, LIMITS.consoleEntries);

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try { log(level, args); } catch { /* logging must never break the app */ }
      original(...args);
    };
  }
  window.addEventListener("error", (e) => log("error", [e.error ?? e.message]));
  window.addEventListener("unhandledrejection", (e) => log("error", ["Unhandled:", e.reason]));

  // Only this app's own API: map tiles, fonts and analytics would crowd out the calls that matter.
  const note = (method: string, rawUrl: string, started: number, status: number | null, requestId: string | null) => {
    const url = cleanUrl(rawUrl);
    const path = url.split("?")[0] ?? url;
    if (!opts.isOwnApi(path) || opts.isReporterCall(path)) return;
    push(networkLog, { method: method.toUpperCase(), url, status, ms: Math.round(performance.now() - started), requestId, at: new Date().toISOString() }, LIMITS.networkEntries);
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    try {
      const res = await realFetch(input, init);
      note(method, url, started, res.status, res.headers.get("x-request-id"));
      return res;
    } catch (err) {
      // A call the app itself cancelled is not a failure.
      if ((err as Error)?.name !== "AbortError") note(method, url, started, null, null);
      throw err;
    }
  };

  // axios and older code use XMLHttpRequest.
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; started: number }>();
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    meta.set(this, { method: String(args[0]), url: String(args[1]), started: 0 });
    return (open as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    if (m) {
      m.started = performance.now();
      let aborted = false;
      this.addEventListener("abort", () => { aborted = true; });
      this.addEventListener("loadend", () => {
        if (aborted) return;
        const id = this.getAllResponseHeaders().match(/^x-request-id:\s*(.+)$/im);
        note(m.method, m.url, m.started, this.status || null, id?.[1]?.trim() ?? null);
      });
    }
    return send.call(this, body);
  };
}

export const capturedLogs = () => ({ console: [...consoleLog], network: [...networkLog] });
