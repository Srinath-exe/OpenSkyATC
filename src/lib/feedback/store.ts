/*
  In-app feedback reports on disk (the project has no database; data/reports already works this way). The sandbox and the
  live server run from the same checkout, so both read and write this one list:
    <FEEDBACK_DIR>/keys.json                      made on first use, 0600 (FEEDBACK_ADMIN_TOKEN / FEEDBACK_AGENT_TOKEN override)
    <FEEDBACK_DIR>/index/<owner>.<client_id>      the report number: a retry is not a second report
    <FEEDBACK_DIR>/reports/<n>/report.json        the report, its files' list and its history
    <FEEDBACK_DIR>/reports/<n>/files/<id>         the bytes
  mkdir and open('wx') are atomic across processes: they hand out numbers and locks.
*/
import { promises as fs, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

export type Status = 'NEW' | 'CHECKING' | 'FIXED' | 'TESTED' | 'WONT_CHANGE';
export type Kind = 'BUG' | 'CHANGE' | 'QUESTION';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type By = 'AUTO' | 'AI' | 'PERSON';
export const STATUSES: Status[] = ['NEW', 'CHECKING', 'FIXED', 'TESTED', 'WONT_CHANGE'];
export const KINDS: Kind[] = ['BUG', 'CHANGE', 'QUESTION'];
export const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const FILE_KINDS = ['RECORDING', 'VOICE', 'SCREENSHOT', 'STILL', 'FILE'] as const;
export const OPEN: Status[] = ['NEW', 'CHECKING'];
export const CLOSED: Status[] = ['TESTED', 'WONT_CHANGE'];

export interface Reading { title: string; kind: Kind; severity: Severity; summary: string; transcript: string; asks: string[]; mentions: string[]; steps_to_reproduce: string[] }
export interface FileRow { id: string; client_file_id: string; kind: (typeof FILE_KINDS)[number]; content_type: string; size_bytes: number; file_name: string; seconds: number | null; done: boolean; deleted_at: string | null; created_at: string }
export interface EventRow { id: string; actor_name: string; actor_type: 'REPORTER' | 'TRIAGER' | 'AGENT' | 'SYSTEM'; from_status: Status | null; to_status: Status | null; note: string | null; internal: boolean; commit_sha: string | null; created_at: string }
export interface Report {
  number: number; client_id: string; reporter_id: string | null; reporter_name: string | null; reporter_role: string | null;
  source: 'PERSON' | 'AGENT'; agent_name: string | null; mode: string | null;
  title: string; title_by: By; kind: Kind; kind_by: By; severity: Severity; severity_by: By; status: Status;
  body: string | null; steps: string | null; expected: string | null; actual: string | null;
  url: string | null; route: string | null; page_title: string | null; environment: string; app_version: string | null;
  element: Record<string, unknown> | null; context: Record<string, unknown> | null;
  files_state: 'UPLOADING' | 'READY'; failed_files: string[];
  ai_state: 'WAITING' | 'READING' | 'DONE' | 'FAILED' | 'OFF'; ai_attempts: number; ai_started_at: string | null; ai_error: string | null; ai: Reading | null; ai_partial: boolean;
  duplicate_of: number | null; maybe_duplicate_of: number | null;
  created_at: string; updated_at: string; closed_at: string | null;
  files: FileRow[]; events: EventRow[];
}

export function dataDir(): string {
  if (process.env.FEEDBACK_DIR) return process.env.FEEDBACK_DIR;
  const cwd = process.cwd();
  return cwd.endsWith(path.join('.next', 'standalone')) ? path.join(cwd, '..', '..', 'data', 'feedback') : path.join(cwd, 'data', 'feedback');
}
const reportDir = (n: number) => path.join(dataDir(), 'reports', String(n));
export const filePath = (n: number, id: string) => path.join(reportDir(n), 'files', id);
const reportFile = (n: number) => path.join(reportDir(n), 'report.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();

// ── keys ──
export interface Keys { admin: string; agent: string; cookie: string }
export function keys(): Keys {
  const f = path.join(dataDir(), 'keys.json');
  if (!existsSync(f)) {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const k = () => randomBytes(32).toString('hex');
    try { writeFileSync(f, JSON.stringify({ admin: k(), agent: k(), cookie: k() }), { mode: 0o600, flag: 'wx' }); } catch { /* the other server made it */ }
  }
  const k = JSON.parse(readFileSync(f, 'utf8')) as Keys;
  return { admin: process.env.FEEDBACK_ADMIN_TOKEN || k.admin, agent: process.env.FEEDBACK_AGENT_TOKEN || k.agent, cookie: k.cookie };
}

// ── reports ──
export async function read(n: number): Promise<Report | null> {
  if (!Number.isInteger(n) || n < 1) return null;
  try { return JSON.parse(await fs.readFile(reportFile(n), 'utf8')) as Report; } catch { return null; }
}
async function write(r: Report): Promise<void> {
  const tmp = `${reportFile(r.number)}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(r), { mode: 0o600 });
  await fs.rename(tmp, reportFile(r.number));
}
async function locked<T>(n: number, work: () => Promise<T>): Promise<T> {
  const lock = path.join(reportDir(n), '.lock');
  for (let i = 0; ; i++) {
    try { await fs.mkdir(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 10_000) { await fs.rmdir(lock).catch(() => undefined); continue; } // its holder died
      if (i > 500) throw new Error(`report ${n} is locked`);
      await sleep(10 + Math.random() * 15);
    }
  }
  try { return await work(); } finally { await fs.rmdir(lock).catch(() => undefined); }
}
/** Change a report under its lock. `work` returns false to leave it as it is. */
export async function update(n: number, work: (r: Report) => void | false | Promise<void | false>): Promise<Report | null> {
  if (!(await read(n))) return null;
  return locked(n, async () => {
    const r = await read(n);
    if (!r) return null;
    if ((await work(r)) !== false) { r.updated_at = now(); await write(r); }
    return r;
  });
}
async function numbers(): Promise<number[]> {
  const list = await fs.readdir(path.join(dataDir(), 'reports')).catch(() => [] as string[]);
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
}
const cache = new Map<string, { at: number; r: Report }>();
/** Newest first. Unchanged reports are not read again. */
export async function all(): Promise<Report[]> {
  const out: Report[] = [];
  for (const n of await numbers()) {
    const f = reportFile(n);
    const st = await fs.stat(f).catch(() => null);
    if (!st) continue;
    let c = cache.get(f);
    if (!c || c.at !== st.mtimeMs) { const r = await read(n); if (!r) continue; c = { at: st.mtimeMs, r }; cache.set(f, c); }
    out.push(c.r);
  }
  return out;
}
/** Makes the report, or answers with the one this client_id already made. */
export async function create(owner: string, clientId: string, make: (n: number) => Report): Promise<{ report: Report; existed: boolean }> {
  const index = path.join(dataDir(), 'index', `${owner}.${clientId}`);
  await fs.mkdir(path.dirname(index), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(dataDir(), 'reports'), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 100; i++) {
    try { await (await fs.open(index, 'wx', 0o600)).close(); } catch {
      const n = Number(await fs.readFile(index, 'utf8').catch(() => ''));
      const r = n ? await read(n) : null;
      if (r) return { report: r, existed: true };
      const st = await fs.stat(index).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 10_000) await fs.rm(index, { force: true }); // made by a server that died before the report
      else await sleep(20);
      continue;
    }
    for (let n = ((await numbers())[0] ?? 0) + 1; ; n++) {
      try { await fs.mkdir(reportDir(n), { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
      await fs.mkdir(path.join(reportDir(n), 'files'), { mode: 0o700 });
      const report = make(n);
      await write(report);
      await fs.writeFile(index, String(n));
      return { report, existed: false };
    }
  }
  throw new Error('could not make the report');
}
export async function remove(n: number): Promise<void> {
  const r = await read(n);
  // the empty folder stays, so its number is never given to another report
  await fs.rm(path.join(reportDir(n), 'files'), { recursive: true, force: true });
  await fs.rm(reportFile(n), { force: true });
  if (r) await fs.rm(path.join(dataDir(), 'index', `${r.source === 'AGENT' ? `agent-${r.agent_name}` : r.reporter_id}.${r.client_id}`), { force: true });
}
/** Bytes held by all reports' files. */
export async function held(): Promise<number> {
  return (await all()).reduce((a, r) => a + r.files.reduce((b, f) => b + (f.deleted_at ? 0 : f.size_bytes), 0), 0);
}
export const event = (actor: { name: string; type: EventRow['actor_type'] }, e: Partial<EventRow> = {}): EventRow => ({
  id: randomUUID(), actor_name: actor.name, actor_type: actor.type, from_status: null, to_status: null, note: null, internal: false, commit_sha: null, ...e, created_at: now(),
});
