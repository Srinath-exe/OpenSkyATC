import { createOutbox, Refused, type OutFile, type Transport } from "./outbox";

/* The outbox's way to /api/feedback. A file goes up in pieces of at most 4 MB (nginx stops a request at 8 MB) and goes on
   from where the server has it. */
const NEVER = [400, 403, 404, 413, 415, 422];

export async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const blob = body instanceof Blob;
  const res = await fetch(`/api/feedback/${path}`, { method, credentials: "same-origin", cache: "no-store", headers: { "x-feedback": "1", ...(body === undefined || blob ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : blob ? body : JSON.stringify(body) });
  const j = await res.json().catch(() => ({})) as T & { error?: string };
  if (res.ok) return j;
  if (NEVER.includes(res.status)) throw new Refused(j.error ?? "It was not accepted.");
  throw Object.assign(new Error(j.error ?? `HTTP ${res.status}`), { status: res.status });
}

const transport: Transport = {
  create: (clientId, report) => api("POST", "reports", { client_id: clientId, ...(report as object) }),
  async upload(number: number, f: OutFile, fileId: string) {
    const s = await api<{ id: string; have: number; done: boolean; chunk: number }>("POST", `reports/${number}/files`, { client_file_id: fileId, kind: f.kind, size: f.blob.size, content_type: f.blob.type, name: f.name, seconds: Number(/-(\d+)s\./.exec(f.name)?.[1]) || null });
    if (s.done) return;
    for (let have = s.have, tries = 0; have < f.blob.size && tries < 200; tries++)
      have = (await api<{ have: number }>("PUT", `reports/${number}/files/${s.id}?offset=${have}`, f.blob.slice(have, have + s.chunk, "application/octet-stream"))).have;
    await api("POST", `reports/${number}/files/${s.id}/done`, {});
  },
  submit: async (number, failed) => { await api("POST", `reports/${number}/submit`, { failed_files: failed }); },
};

let box: ReturnType<typeof createOutbox> | null = null;
const listeners: { sent?(n: number, failed: string[]): void; refused?(why: string): void } = {};
export const onOutbox = (l: typeof listeners) => { Object.assign(listeners, l); };
const WAITING = "skycontrol_feedback_waiting"; // so the app start only loads this when something is waiting
export const markWaiting = (on: boolean) => { try { if (on) localStorage.setItem(WAITING, "1"); else localStorage.removeItem(WAITING); } catch { /* storage blocked */ } };
/** There are no accounts: one person per browser, whom the server knows by its own cookie. */
export const outbox = () => (box ??= createOutbox(transport, "player", {
  sent: (n, failed) => { markWaiting(false); listeners.sent?.(n, failed); },
  refused: (why) => { markWaiting(false); listeners.refused?.(why); },
}));
