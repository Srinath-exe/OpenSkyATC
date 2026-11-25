import { LIMITS } from "./limits";

export type MicState = "none" | "on" | "muted";
export interface Clip { blob: Blob; seconds: number; hasVoice: boolean; stills: Blob[] }
export interface Session {
  /** The clip, or null when it was cancelled or nothing was recorded. */
  readonly done: Promise<Clip | null>;
  readonly mic: MicState;
  toggleMic(): MicState;
  stop(): void;
  cancel(): void;
}

const MIC: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: true } };
const supported = (types: string[]) => types.find((t) => MediaRecorder.isTypeSupported(t));

/** False on phones: no browser there can record its own screen. */
export const canRecordScreen = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";

/** Must be called straight from a click. Rejects when screen sharing is refused. */
export async function recordScreen(onTick: (seconds: number) => void): Promise<Session> {
  // The screen first, then the mic: asking for the mic first uses up the click,
  // and the browser then refuses to share the screen.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 12 },
    audio: false,
    preferCurrentTab: true, // Chrome offers this tab first
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  const mic = await navigator.mediaDevices.getUserMedia(MIC).catch(() => null); // refused: carry on without voice
  const stills = takeStills(display);
  const session = run({
    tracks: [...display.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])],
    streams: mic ? [display, mic] : [display],
    mimeType: supported(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]),
    maxSeconds: LIMITS.recordSeconds, maxBytes: LIMITS.recordBytes, hasVoice: !!mic, onTick, stills,
  });
  // The browser's own "Stop sharing" ends it too.
  display.getVideoTracks()[0]?.addEventListener("ended", () => session.stop());
  return session;
}

/** Rejects when the microphone is refused. */
export async function recordVoice(onTick: (seconds: number) => void): Promise<Session> {
  const mic = await navigator.mediaDevices.getUserMedia(MIC);
  return run({
    tracks: mic.getAudioTracks(), streams: [mic],
    mimeType: supported(["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]),
    maxSeconds: LIMITS.voiceSeconds, maxBytes: LIMITS.recordBytes, hasVoice: true, onTick, stills: null,
  });
}

function run(o: {
  tracks: MediaStreamTrack[]; streams: MediaStream[]; mimeType?: string; maxSeconds: number; maxBytes: number;
  hasVoice: boolean; onTick: (s: number) => void; stills: ReturnType<typeof takeStills> | null;
}): Session {
  const rec = new MediaRecorder(new MediaStream(o.tracks), { mimeType: o.mimeType, videoBitsPerSecond: 900_000, audioBitsPerSecond: 64_000 });
  const voice = o.tracks.filter((t) => t.kind === "audio");
  const chunks: Blob[] = [];
  const began = Date.now();
  const seconds = () => Math.round((Date.now() - began) / 1000);
  let bytes = 0;
  let cancelled = false;
  let finish!: (c: Clip | null) => void;
  const done = new Promise<Clip | null>((r) => { finish = r; });

  const stop = () => { if (rec.state !== "inactive") rec.stop(); };
  const timer = window.setInterval(() => { o.onTick(seconds()); if (seconds() >= o.maxSeconds) stop(); }, 500);
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    chunks.push(e.data);
    bytes += e.data.size;
    if (bytes > o.maxBytes) stop();
  };
  rec.onerror = stop;
  rec.onstop = () => {
    window.clearInterval(timer);
    const stills = o.stills?.end() ?? [];
    o.streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); // the browser's recording light goes out
    const type = (rec.mimeType || o.mimeType || chunks[0]?.type || "video/webm").split(";")[0] ?? "video/webm";
    const blob = new Blob(chunks, { type });
    finish(cancelled || !blob.size ? null : { blob, seconds: Math.max(1, seconds()), hasVoice: o.hasVoice, stills });
  };
  rec.start(1000);
  return {
    done,
    get mic() { return voice.length === 0 ? "none" : voice.some((t) => t.enabled) ? "on" : "muted"; },
    toggleMic() { const on = this.mic !== "on"; voice.forEach((t) => { t.enabled = on; }); return this.mic; },
    stop,
    cancel() { cancelled = true; stop(); },
  };
}

/** Frames of the recording, for the poster, for the AI, and for an agent that cannot play a video. */
function takeStills(stream: MediaStream) {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  let stills: Blob[] = [];
  const grab = () => {
    if (!video.videoWidth) return;
    const scale = Math.min(1, 1280 / video.videoWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext("2d")?.drawImage(video, 0, 0, c.width, c.height);
    c.toBlob((b) => {
      if (!b) return;
      stills.push(b);
      // Keep them spread over the whole recording; the first one always stays, it is the poster.
      if (stills.length > LIMITS.stills) stills = stills.filter((_, i) => i % 2 === 0);
    }, "image/jpeg", 0.72);
  };
  const first = window.setTimeout(grab, 800);
  const every = window.setInterval(grab, LIMITS.stillEveryMs);
  return {
    end() {
      window.clearTimeout(first);
      window.clearInterval(every);
      video.srcObject = null;
      return stills;
    },
  };
}

/** For `onLoadedMetadata` on any player of these clips: Chrome's recordings carry no length, so the
 *  player reads 0:00 and cannot seek until it has been sent to the end once. */
export function findLength(el: HTMLMediaElement) {
  if (el.duration !== Infinity) return;
  el.addEventListener("timeupdate", () => { el.currentTime = 0; }, { once: true });
  el.currentTime = 1e101;
}
