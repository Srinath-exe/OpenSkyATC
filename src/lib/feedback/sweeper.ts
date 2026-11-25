/*
  The reading job and the retention job. There is no job queue, so once a minute this looks at the reports on disk: what is
  waiting is there after a restart too. Two servers share the list; a report is taken under its lock, so one of them reads it.
*/
import { promises as fs } from 'node:fs';
import * as db from './store';
import { aiOn, partsOf, readReport, ReadFailed } from './ai';
export { aiOn } from './ai';

const MIN = 60_000, KEEP_DAYS = () => Number(process.env.FEEDBACK_KEEP_DAYS || 90);
const g = globalThis as unknown as { __openatcFeedbackSweep?: { timer: ReturnType<typeof setInterval>; running: boolean; again: boolean; cleaned: string } };

/** Starts the minute timer (first call); `now` also looks right away. */
export function kick(now = false): void {
  if (process.env.FEEDBACK_NO_SWEEP) return; // tests call sweep() themselves
  if (!g.__openatcFeedbackSweep) {
    const timer = setInterval(() => kick(true), MIN); timer.unref?.();
    g.__openatcFeedbackSweep = { timer, running: false, again: false, cleaned: '' };
  }
  const s = g.__openatcFeedbackSweep;
  if (!now) return;
  if (s.running) { s.again = true; return; }
  s.running = true;
  void (async () => {
    do { s.again = false; await sweep().catch((e) => console.error('[feedback] sweep', e)); } while (s.again);
    const day = db.now().slice(0, 10);
    if (s.cleaned !== day) { s.cleaned = day; await retention().catch((e) => console.error('[feedback] retention', e)); }
  })().finally(() => { s.running = false; });
}

export async function sweep(at = Date.now()): Promise<void> {
  if (!aiOn()) return;
  for (const r of await db.all()) {
    const stuck = r.ai_state === 'READING' && at - Date.parse(r.ai_started_at ?? r.created_at) > 10 * MIN;
    const late = r.files_state === 'UPLOADING' && at - Date.parse(r.created_at) > 15 * MIN;
    if (!(r.ai_state === 'WAITING' || stuck) || !(r.files_state === 'READY' || late)) continue;
    let mine: db.Report | null = null;
    await db.update(r.number, (x) => {
      const still = x.ai_state === 'WAITING' || (x.ai_state === 'READING' && at - Date.parse(x.ai_started_at ?? x.created_at) > 10 * MIN);
      if (!still) return false;
      if (x.ai_attempts >= 3) { x.ai_state = 'FAILED'; x.ai_error ??= 'The AI could not read this report after three tries. Press Read again.'; return; }
      x.ai_state = 'READING'; x.ai_attempts++; x.ai_started_at = new Date(at).toISOString(); x.ai_partial = x.files_state !== 'READY';
      mine = structuredClone(x);
    });
    if (mine) await readOne(mine);
  }
}

async function readOne(r: db.Report): Promise<void> {
  try {
    const got = await readReport(partsOf(r));
    const twin = got.title ? (await db.all()).find((o) => o.number !== r.number && db.OPEN.includes(o.status) && o.route === r.route && alike(o.title, got.title)) : undefined;
    await db.update(r.number, (x) => {
      x.ai = got; x.ai_error = null;
      // files that came in while it was being read: once more
      if (x.ai_partial && x.files_state === 'READY') { x.ai_state = 'WAITING'; x.ai_attempts = 0; } else x.ai_state = 'DONE';
      if (x.title_by !== 'PERSON') { x.title = got.title; x.title_by = 'AI'; }
      if (x.kind_by !== 'PERSON') { x.kind = got.kind; x.kind_by = 'AI'; }
      if (x.severity_by !== 'PERSON') { x.severity = got.severity; x.severity_by = 'AI'; }
      if (twin && !x.duplicate_of) x.maybe_duplicate_of = twin.number;
    });
  } catch (e) {
    const again = !(e instanceof ReadFailed) || e.again;
    await db.update(r.number, (x) => {
      x.ai_error = e instanceof ReadFailed ? e.message : 'The AI could not read this report. Press Read again.';
      x.ai_state = again && x.ai_attempts < 3 ? 'WAITING' : 'FAILED';
    });
    if (!(e instanceof ReadFailed)) console.error(`[feedback] reading #${r.number}`, e);
  }
}
function alike(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const x = words(a), y = words(b); if (!x.size || !y.size) return false;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.6;
}

/** Recordings, voice notes and stills of reports closed longer than the setting go; the words stay. */
export async function retention(at = Date.now()): Promise<void> {
  for (const r of await db.all()) {
    if (!r.closed_at || at - Date.parse(r.closed_at) < KEEP_DAYS() * 24 * 60 * MIN || !r.files.some((f) => !f.deleted_at && ['RECORDING', 'VOICE', 'STILL'].includes(f.kind))) continue;
    await db.update(r.number, async (x) => {
      for (const f of x.files) if (!f.deleted_at && ['RECORDING', 'VOICE', 'STILL'].includes(f.kind)) { await fs.rm(db.filePath(x.number, f.id), { force: true }); f.deleted_at = new Date(at).toISOString(); }
    });
  }
}
