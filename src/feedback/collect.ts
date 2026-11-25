import { gameContext } from "@/lib/report";
import { idsInAddress, pageHeading } from "./element";
import { capturedLogs } from "./logs";
import { cleanUrl } from "./redact";
import type { Draft } from "./machine";
import type { OutFile } from "./outbox";

/** What goes along without asking. Taken when the capture is made, not when Send is pressed. */
export function collect() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    url: cleanUrl(window.location.href),
    route: window.location.pathname.replace(/\/\d+(?=\/|$)/g, "/[n]"),
    page_title: pageHeading(),
    app_version: process.env.NEXT_PUBLIC_BUILD,
    context: {
      ids: idsInAddress(),
      screen: { viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, ua: navigator.userAgent, language: navigator.language, tz, scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" },
      game: gameContext(),
      ...capturedLogs(),
    },
  };
}
export type Collected = ReturnType<typeof collect>;

const ext = (b: Blob) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "audio/mp4": "m4a", "audio/ogg": "ogg" })[b.type.split(";")[0] ?? ""] ?? "webm";

export function filesOf(d: Draft): OutFile[] {
  const out: OutFile[] = [];
  if (d.clip) out.push({ name: `recording-${d.clip.seconds}s.${ext(d.clip.blob)}`, kind: "RECORDING", blob: d.clip.blob });
  if (d.voice) out.push({ name: `voice-${d.voice.seconds}s.${ext(d.voice.blob)}`, kind: "VOICE", blob: d.voice.blob });
  if (d.shot) out.push({ name: `screenshot.${ext(d.shot)}`, kind: "SCREENSHOT", blob: d.shot });
  d.pictures.slice(0, 4).forEach((b, i) => out.push({ name: `picture-${i + 1}.${ext(b)}`, kind: "FILE", blob: b }));
  d.clip?.stills.slice(0, 12).forEach((b, i) => out.push({ name: `still-${String(i + 1).padStart(2, "0")}.jpg`, kind: "STILL", blob: b }));
  return out;
}

type Sim = { engine?: { byId(id: number): { callsign: string; type?: string; phase?: string } | null | undefined } | null; hoveredId?: number | null; selectedId?: number | null; paused?: boolean; setPaused?(b: boolean): void };
export const game = () => (window as unknown as { __atcSim?: Sim }).__atcSim;

/** The map and the radar are one canvas each: what is at the spot that was clicked. */
export function whatIsAt(x: number, y: number): Record<string, string> {
  const out: Record<string, string> = { spot: `${Math.round(x)},${Math.round(y)}` };
  try {
    const s = game();
    const name = (id: number | null | undefined) => { const a = id == null ? null : s?.engine?.byId(id); return a ? [a.callsign, a.type, a.phase].filter(Boolean).join(" ") : null; };
    const at = name(s?.hoveredId), sel = name(s?.selectedId);
    if (at) out.aircraft = at;
    if (sel) out.selected = sel;
    const map = (window as unknown as { __mbxMap?: { getCanvas(): HTMLCanvasElement; unproject(p: [number, number]): { lng: number; lat: number }; getZoom(): number } }).__mbxMap;
    const r = map?.getCanvas().getBoundingClientRect();
    if (map && r?.width && document.elementFromPoint(x, y)?.closest(".mapboxgl-map")) { const q = map.unproject([x - r.left, y - r.top]); out.place = `${q.lat.toFixed(6)},${q.lng.toFixed(6)} zoom ${map.getZoom().toFixed(1)}`; }
  } catch { /* a map that is being torn down */ }
  return out;
}
