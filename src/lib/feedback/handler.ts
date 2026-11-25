/*
  /api/feedback (feedback-module-prompt.md §5). Apart from route.ts so it can be tested without Next (tests/engine/feedback.test.ts).

  Who: the game has no accounts. A player is an anonymous signed httpOnly cookie (fb_id); a triager signs in once with a
  link from `scripts/feedback.mjs signin` (fb_admin cookie); an agent sends its bearer token. One function, load(), decides
  what each may see: their own for a player, all for triagers and agents, 404 for anyone else.
  Cross-site posts: every write needs the x-feedback header, which another site cannot send without CORS (there is none).
  Files come in 4 MB pieces (nginx stops a request at 8 MB) and are written straight to disk.
*/
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { RateLimiter, clientKey } from '../../app/api/voice/stt/handler';
import * as db from './store';
import type { EventRow, Report, Status } from './store';
import { sniff, servedType } from './sniff';
import { clean, cleanDeep } from './clean';
import { aiOn, kick } from './sweeper';

export const FB_LIMITS = { perHour: 20, perHourIp: 60, text: 20_000, context: 256 * 1024, file: 50 * 1024 * 1024, files: 20, chunk: 4 * 1024 * 1024, ipBytesPerDay: 600 * 1024 * 1024, totalBytes: 5 * 1024 * 1024 * 1024, freeBytes: 5 * 1024 * 1024 * 1024 };

interface Mem { person: RateLimiter; ip: RateLimiter; signin: RateLimiter; calls: RateLimiter; bytes: Map<string, { day: string; n: number }>; busy: Set<string> }
const g = globalThis as unknown as { __openatcFeedback?: Mem };
const mem = (): Mem => (g.__openatcFeedback ??= { person: new RateLimiter(FB_LIMITS.perHour / 60, FB_LIMITS.perHour), ip: new RateLimiter(FB_LIMITS.perHourIp / 60, FB_LIMITS.perHourIp), signin: new RateLimiter(5, 10), calls: new RateLimiter(240, 120), bytes: new Map(), busy: new Set() });

class Err extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

// ── who ──
const mac = (s: string) => createHmac('sha256', db.keys().cookie).update(s).digest('hex');
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const signed = (s: string) => `${s}.${mac(s)}`;
function unsign(v: string | undefined): string | null {
  const i = v?.lastIndexOf('.') ?? -1;
  return v && i > 0 && same(v.slice(i + 1), mac(v.slice(0, i))) ? v.slice(0, i) : null;
}
const cookies = (req: Request) => Object.fromEntries((req.headers.get('cookie') ?? '').split(/;\s*/).filter((c) => c.includes('=')).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
const setCookie = (req: Request, name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${req.headers.get('x-forwarded-proto') === 'https' || req.url.startsWith('https:') ? '; Secure' : ''}`;

interface Caller { reporterId: string | null; triager: boolean; agent: string | null }
function caller(req: Request): Caller {
  const auth = req.headers.get('authorization');
  if (auth) {
    if (!auth.startsWith('Bearer ') || !same(auth.slice(7), db.keys().agent)) throw new Err(401, 'Bad token');
    const name = (req.headers.get('x-feedback-agent') ?? 'agent').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'agent';
    return { reporterId: null, triager: false, agent: name };
  }
  const c = cookies(req);
  const admin = unsign(c.fb_admin);
  return { reporterId: unsign(c.fb_id), triager: !!admin && Number(admin.split(':')[1]) > Date.now() && admin.startsWith('admin:'), agent: null };
}
const worker = (w: Caller) => w.triager || !!w.agent;
const owns = (w: Caller, r: Report) => (w.agent ? r.source === 'AGENT' && r.agent_name === w.agent : !!w.reporterId && r.reporter_id === w.reporterId);
const playerName = (id: string) => `Player ${id.slice(0, 4)}`;
function actor(w: Caller, r?: Report): { name: string; type: EventRow['actor_type'] } {
  if (w.agent) return { name: w.agent, type: 'AGENT' };
  if (w.triager && !(r && !w.triager)) return { name: 'Team', type: 'TRIAGER' };
  return { name: playerName(w.reporterId ?? 'anon'), type: 'REPORTER' };
}
async function load(n: number, w: Caller): Promise<Report> {
  const r = await db.read(n);
  if (!r || !(worker(w) || owns(w, r))) throw new Err(404, 'Not found');
  return r;
}

// ── what is sent back ──
function link(n: number, id: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `/api/feedback/files/${n}/${id}?exp=${exp}&sig=${mac(`file:${n}:${id}:${exp}`)}`;
}
const row = (r: Report) => ({ number: r.number, title: r.title, summary: r.ai?.summary ?? r.body?.slice(0, 240) ?? null, status: r.status, kind: r.kind, severity: r.severity, reporter_name: r.reporter_name ?? r.agent_name, source: r.source, environment: r.environment, route: r.route, mode: r.mode, files_state: r.files_state, ai_state: r.ai_state, created_at: r.created_at, updated_at: r.updated_at });
function full(r: Report, w: Caller) {
  const team = worker(w);
  const files = r.files.filter((f) => f.done).map((f) => ({ id: f.id, kind: f.kind, content_type: f.content_type, size_bytes: f.size_bytes, file_name: f.file_name, seconds: f.seconds, deleted_at: f.deleted_at, url: f.deleted_at ? null : link(r.number, f.id) }));
  const events = r.events.filter((e) => team || !e.internal);
  if (team) return { ...r, files, events, mine: owns(w, r) };
  return { ...row(r), body: r.body, url: r.url, page_title: r.page_title, element: r.element, ai: r.ai ? { summary: r.ai.summary } : null, files, events, mine: true };
}

// ── reading a request ──
async function bodyOf(req: Request, max = 400 * 1024): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > max) throw new Err(413, 'Too large');
  try { const v = JSON.parse(text || '{}') as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* below */ }
  throw new Err(400, 'Not JSON');
}
function text(v: unknown, max = FB_LIMITS.text): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Err(422, 'Expected text');
  if (v.length > max) throw new Err(422, `Text over ${max.toLocaleString('en')} characters`);
  return clean(v).trim() || null;
}
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => { if (list.includes(v as T)) return v as T; throw new Err(422, `Unknown ${what}`); };
const uuid = (v: unknown) => { if (typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)) return v.toLowerCase(); throw new Err(422, 'client_id must be a UUID'); };

function firstTitle(r: { body: string | null; element: Record<string, unknown> | null; page_title: string | null; mode: string | null }): string {
  const words = r.body?.split(/\n|(?<=[.!?])\s/)[0]?.trim();
  if (words) return words.slice(0, 80);
  const part = String(r.element?.text || r.element?.label || r.element?.heading || '').slice(0, 40);
  const how = { record: 'Recording', screenshot: 'Screenshot', highlight: 'Highlight' }[r.mode ?? ''] ?? 'Report';
  return part ? `${how}: ${part}` : `${how} on ${r.page_title || 'this screen'}`.slice(0, 80);
}

// ── routes ──
export async function handleFeedback(req: Request, parts: string[]): Promise<Response> {
  try {
    kick();
    return await route(req, parts);
  } catch (e) {
    if (e instanceof Err) return json({ error: e.message, ...e.extra }, e.status);
    throw e;
  }
}

async function route(req: Request, p: string[]): Promise<Response> {
  const m = req.method; const url = new URL(req.url); const w = caller(req);
  if (p[0] === 'files' && p.length === 3 && (m === 'GET' || m === 'HEAD')) return serve(req, Number(p[1]), p[2], url);
  if (p[0] === 'signin' && m === 'GET') return signin(req, url);
  if (m !== 'GET' && m !== 'HEAD' && !w.agent && !req.headers.get('x-feedback')) throw new Err(403, 'Missing x-feedback header');
  if (!mem().calls.take(clientKey(req.headers))) throw new Err(429, 'Too many requests');

  if (p[0] === 'signin' && m === 'POST') { // the CLI asks for a one-time link with the admin key
    if (!mem().signin.take(clientKey(req.headers)) || !same(req.headers.get('x-feedback-admin') ?? '', db.keys().admin)) throw new Err(401, 'Bad key');
    const code = randomBytes(24).toString('hex'); const dir = path.join(db.dataDir(), 'signin');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, createHash('sha256').update(code).digest('hex')), String(Date.now() + 24 * 3600_000), { mode: 0o600 });
    return json({ path: `/api/feedback/signin?code=${code}` });
  }
  if (p[0] === 'signout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': setCookie(req, 'fb_admin', '', 0) });
  if (p[0] === 'me' && m === 'GET') return json({ name: w.reporterId ? playerName(w.reporterId) : null, triager: w.triager, ai: aiOn() });
  if (p[0] !== 'reports') throw new Err(404, 'Not found');

  if (p.length === 1) {
    if (m === 'POST') return create(req, w);
    if (m === 'GET') return list(url, w);
    throw new Err(405, 'Not allowed');
  }
  const n = Number(p[1]); const r = await load(n, w); const what = p[2];
  if (p.length === 2) {
    if (m === 'GET') return json(full(r, w));
    if (m === 'PATCH') return patch(req, r, w);
    if (m === 'DELETE') { if (!w.triager) throw new Err(404, 'Not found'); await db.remove(n); return json({ ok: true }); }
    throw new Err(405, 'Not allowed');
  }
  if (what === 'files') {
    if (!owns(w, r)) throw new Err(404, 'Not found');
    if (p.length === 3 && m === 'POST') return startFile(req, r);
    if (p.length === 4 && m === 'PUT') return putChunk(req, r, p[3], url);
    if (p.length === 5 && p[4] === 'done' && m === 'POST') return doneFile(r, p[3]);
  }
  if (p.length === 3 && m === 'POST') {
    if (what === 'submit') return submit(req, r, w);
    if (what === 'notes') return note(req, r, w);
    if (what === 'verdict') return verdict(req, r, w);
    if (what === 'read') return readAgain(r, w);
  }
  throw new Err(404, 'Not found');
}

async function create(req: Request, w: Caller): Promise<Response> {
  const b = await bodyOf(req);
  const clientId = uuid(b.client_id);
  let cookie: string | null = null;
  if (!w.agent && !w.reporterId) { w.reporterId = randomUUID(); cookie = setCookie(req, 'fb_id', signed(w.reporterId), 400 * 24 * 3600); }
  const owner = w.agent ? `agent-${w.agent}` : w.reporterId!;
  const head: Record<string, string> = cookie ? { 'set-cookie': cookie } : {};
  // a retry of one already made is answered without using up the hourly limit
  const again = cookie ? null : (await db.all()).find((r) => r.client_id === clientId && (w.agent ? r.agent_name === w.agent : r.reporter_id === w.reporterId));
  if (again) return json(full(again, w), 200, head);
  if (!w.agent && (!mem().person.take(owner) || !mem().ip.take(clientKey(req.headers)))) throw new Err(429, 'Too many reports this hour');

  const context = b.context == null ? null : cleanDeep(b.context) as Record<string, unknown>;
  if (JSON.stringify(b.context ?? null).length > FB_LIMITS.context) throw new Err(413, 'Context over 256 KB');
  const element = b.element && typeof b.element === 'object' ? cleanDeep(b.element) as Record<string, unknown> : null;
  if (JSON.stringify(element).length > 32 * 1024) throw new Err(413, 'Element too large');
  const f = { body: text(b.body), steps: text(b.steps), expected: text(b.expected), actual: text(b.actual), page_title: text(b.page_title, 300), mode: b.mode == null ? null : oneOf(b.mode, ['record', 'screenshot', 'highlight'] as const, 'mode') };
  const title = w.agent ? text(b.title, 200) : null;
  const t = db.now();
  const { report, existed } = await db.create(owner, clientId, (number) => ({
    number, client_id: clientId, reporter_id: w.agent ? null : w.reporterId, reporter_name: w.agent ? null : playerName(w.reporterId!), reporter_role: w.agent ? null : w.triager ? 'team' : 'player',
    source: w.agent ? 'AGENT' : 'PERSON', agent_name: w.agent, ...f,
    title: title ?? firstTitle({ ...f, element }), title_by: title ? 'PERSON' : 'AUTO',
    kind: b.kind == null ? 'CHANGE' : oneOf(b.kind, db.KINDS, 'kind'), kind_by: b.kind == null ? 'AUTO' : 'PERSON',
    severity: b.severity == null ? 'MEDIUM' : oneOf(b.severity, db.SEVERITIES, 'severity'), severity_by: b.severity == null ? 'AUTO' : 'PERSON',
    status: 'NEW', url: text(b.url, 2000), route: text(b.route, 300), environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox', app_version: text(b.app_version, 80),
    element, context, files_state: 'UPLOADING', failed_files: [],
    ai_state: aiOn() ? 'WAITING' : 'OFF', ai_attempts: 0, ai_started_at: null, ai_error: null, ai: null, ai_partial: false,
    duplicate_of: null, maybe_duplicate_of: null, created_at: t, updated_at: t, closed_at: null, files: [],
    events: [db.event(actor({ ...w, triager: false }), { to_status: 'NEW' })],
  }));
  return json(full(report, w), existed ? 200 : 201, head);
}

async function list(url: URL, w: Caller): Promise<Response> {
  const q = url.searchParams; const mine = q.get('mine') === '1' || !worker(w);
  let rows = await db.all();
  if (mine) rows = rows.filter((r) => owns(w, r));
  const want = (k: string) => (q.get(k) ?? '').split(',').filter(Boolean);
  const [kind, severity, env, person, status] = [want('kind'), want('severity'), want('environment'), q.get('person'), want('status')];
  const s = (q.get('q') ?? '').trim().toLowerCase().slice(0, 200);
  rows = rows.filter((r) => (!kind.length || kind.includes(r.kind)) && (!severity.length || severity.includes(r.severity)) && (!env.length || env.includes(r.environment))
    && (!person || (r.reporter_name ?? r.agent_name) === person)
    && (!s || s === `#${r.number}` || s === String(r.number) || [r.title, r.ai?.summary, r.body, r.route, r.reporter_name, r.agent_name].some((x) => x?.toLowerCase().includes(s))));
  const counts = Object.fromEntries(db.STATUSES.map((x) => [x, rows.filter((r) => r.status === x).length]));
  const people = [...new Set(rows.map((r) => r.reporter_name ?? r.agent_name).filter(Boolean))];
  if (status.length) rows = rows.filter((r) => status.includes(r.status));
  const cursor = Number(q.get('cursor') ?? 0); const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 30) || 30));
  if (cursor) rows = rows.filter((r) => r.number < cursor);
  const page = rows.slice(0, limit);
  return json({ reports: page.map(row), counts, people, next: rows.length > limit ? page[page.length - 1].number : null });
}

async function startFile(req: Request, r: Report): Promise<Response> {
  const b = await bodyOf(req, 8192);
  const clientFileId = text(b.client_file_id, 200); if (!clientFileId) throw new Err(422, 'client_file_id is missing');
  const kind = oneOf(b.kind, db.FILE_KINDS, 'file kind');
  const size = Number(b.size); if (!Number.isInteger(size) || size < 1) throw new Err(422, 'size is missing');
  if (size > FB_LIMITS.file) throw new Err(413, 'Over 50 MB');
  const type = String(b.content_type ?? '').split(';')[0].trim().toLowerCase().slice(0, 100);
  const old = r.files.find((f) => f.client_file_id === clientFileId);
  if (!old) {
    const ip = clientKey(req.headers); const day = db.now().slice(0, 10); const used = mem().bytes.get(ip);
    if ((used?.day === day ? used.n : 0) + size > FB_LIMITS.ipBytesPerDay) throw new Err(429, 'Too much uploaded today');
    const disk = await fs.statfs(db.dataDir());
    if ((await db.held()) + size > FB_LIMITS.totalBytes || disk.bavail * disk.bsize < FB_LIMITS.freeBytes) throw new Err(413, 'The feedback store is full');
    if (mem().bytes.size > 5000) mem().bytes.clear();
    mem().bytes.set(ip, { day, n: (used?.day === day ? used.n : 0) + size });
  }
  let id = '', done = false;
  await db.update(r.number, (x) => {
    const f = x.files.find((y) => y.client_file_id === clientFileId);
    if (f) { id = f.id; done = f.done; return false; }
    if (x.files.length >= FB_LIMITS.files) throw new Err(413, 'Over 20 files');
    id = randomUUID();
    x.files.push({ id, client_file_id: clientFileId, kind, content_type: type, size_bytes: size, file_name: (text(b.name, 200) ?? kind).replace(/[^\w. -]+/g, '_'), seconds: Number.isFinite(Number(b.seconds)) && Number(b.seconds) > 0 ? Math.round(Number(b.seconds)) : null, done: false, deleted_at: null, created_at: db.now() });
  });
  const have = (await fs.stat(db.filePath(r.number, id)).catch(() => null))?.size ?? 0;
  return json({ id, have, done, chunk: FB_LIMITS.chunk });
}

async function putChunk(req: Request, r: Report, id: string, url: URL): Promise<Response> {
  const f = r.files.find((x) => x.id === id); if (!f) throw new Err(404, 'Not found');
  if (f.done) return json({ have: f.size_bytes });
  const at = db.filePath(r.number, id); const key = `${r.number}/${id}`;
  if (mem().busy.has(key)) throw new Err(429, 'This file is already being sent');
  mem().busy.add(key);
  const out = await fs.open(at, 'a', 0o600);
  try {
    const have = (await out.stat()).size; const offset = Number(url.searchParams.get('offset') ?? 0);
    if (offset !== have) return json({ have }, 200); // the browser goes on from what is here
    let n = 0; const reader = req.body?.getReader();
    for (; reader;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > FB_LIMITS.chunk || have + n > f.size_bytes) { await reader.cancel().catch(() => undefined); await out.truncate(have); throw new Err(413, 'More than was announced'); }
      await out.write(value);
    }
    return json({ have: have + n });
  } finally { await out.close(); mem().busy.delete(key); }
}

async function doneFile(r: Report, id: string): Promise<Response> {
  const f = r.files.find((x) => x.id === id); if (!f) throw new Err(404, 'Not found');
  if (f.done) return json({ ok: true });
  const at = db.filePath(r.number, id); const st = await fs.stat(at).catch(() => null);
  if (!st || st.size !== f.size_bytes) throw new Err(409, 'Not all of it is here', { have: st?.size ?? 0 });
  const h = await fs.open(at, 'r'); const head = new Uint8Array(16);
  try { await h.read(head, 0, 16, 0); } finally { await h.close(); }
  const found = sniff(head);
  if (!found) {
    await fs.rm(at, { force: true });
    await db.update(r.number, (x) => { x.files = x.files.filter((y) => y.id !== id); });
    throw new Err(415, 'This kind of file is not accepted');
  }
  await db.update(r.number, (x) => { const y = x.files.find((z) => z.id === id); if (y) { y.done = true; y.content_type = servedType(found, y.content_type); } });
  return json({ ok: true });
}

async function submit(req: Request, r: Report, w: Caller): Promise<Response> {
  const b = await bodyOf(req, 16 * 1024);
  const failed = Array.isArray(b.failed_files) ? b.failed_files.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 100)).slice(0, 20) : [];
  const out = await db.update(r.number, (x) => {
    if (x.files_state === 'READY') return false;
    x.files_state = 'READY'; x.failed_files = failed;
    if (x.ai_partial && aiOn()) { x.ai_state = 'WAITING'; x.ai_attempts = 0; } // it was read without all its files
  });
  kick(true);
  return json(full(out!, w));
}

function setStatus(x: Report, to: Status, by: { name: string; type: EventRow['actor_type'] }, e: Partial<EventRow> = {}) {
  x.events.push(db.event(by, { from_status: x.status, to_status: to, ...e }));
  x.status = to; x.closed_at = db.CLOSED.includes(to) ? db.now() : null;
}

async function patch(req: Request, r: Report, w: Caller): Promise<Response> {
  if (!worker(w)) throw new Err(404, 'Not found');
  const b = await bodyOf(req); const by = actor(w);
  const status = b.status == null ? null : oneOf(b.status, db.STATUSES, 'status');
  if (w.agent && status && !['CHECKING', 'FIXED', 'WONT_CHANGE'].includes(status)) throw new Err(403, `An agent cannot set ${status}: that belongs to a person`);
  const kind = b.kind == null ? null : oneOf(b.kind, db.KINDS, 'kind'); const severity = b.severity == null ? null : oneOf(b.severity, db.SEVERITIES, 'severity');
  const title = text(b.title, 200); const n = text(b.note); const commit = text(b.commit, 64); const internal = b.internal === true;
  const dup = b.duplicate_of === undefined ? undefined : b.duplicate_of === null ? null : Number(b.duplicate_of);
  if (dup != null && (dup === r.number || !(await db.read(dup)))) throw new Err(422, 'No such report to be a duplicate of');
  const out = await db.update(r.number, (x) => {
    if (title && title !== x.title) { x.events.push(db.event(by, { note: `Title: ${title}`, internal: true })); x.title = title; x.title_by = 'PERSON'; }
    if (kind && kind !== x.kind) { x.events.push(db.event(by, { note: `Kind: ${x.kind} → ${kind}`, internal: true })); x.kind = kind; }
    if (kind) x.kind_by = 'PERSON';
    if (severity && severity !== x.severity) { x.events.push(db.event(by, { note: `Severity: ${x.severity} → ${severity}`, internal: true })); x.severity = severity; }
    if (severity) x.severity_by = 'PERSON';
    if (dup !== undefined) { x.duplicate_of = dup; x.maybe_duplicate_of = null; x.events.push(db.event(by, { note: dup ? `Duplicate of #${dup}` : 'Not a duplicate', internal: true })); }
    if (status && status !== x.status) setStatus(x, status, by, { note: n, internal, commit_sha: commit });
    else if (n || commit) x.events.push(db.event(by, { note: n, internal, commit_sha: commit }));
  });
  return json(full(out!, w));
}

async function note(req: Request, r: Report, w: Caller): Promise<Response> {
  const b = await bodyOf(req); const n = text(b.note ?? b.text); if (!n) throw new Err(422, 'The note is empty');
  const by = worker(w) && !(b.as === 'reporter' && owns(w, r)) ? actor(w) : actor({ ...w, triager: false });
  const out = await db.update(r.number, (x) => { x.events.push(db.event(by, { note: n, internal: worker(w) && b.internal === true })); });
  return json(full(out!, w));
}

async function verdict(req: Request, r: Report, w: Caller): Promise<Response> {
  if (!owns(w, r) || w.agent) throw new Err(404, 'Not found');
  const b = await bodyOf(req); const v = oneOf(b.verdict, ['works', 'still_wrong'] as const, 'verdict'); const n = text(b.note);
  let bad = false;
  const out = await db.update(r.number, (x) => {
    if (x.status !== 'FIXED') { bad = true; return false; }
    setStatus(x, v === 'works' ? 'TESTED' : 'NEW', actor({ ...w, triager: false }), { note: n ?? (v === 'works' ? 'It works' : 'Still wrong') });
  });
  if (bad) throw new Err(409, 'This report is not waiting for an answer');
  return json(full(out!, w));
}

async function readAgain(r: Report, w: Caller): Promise<Response> {
  if (!worker(w)) throw new Err(404, 'Not found');
  if (!aiOn()) throw new Err(409, 'AI reading is off: no GEMINI_API_KEY is set');
  const out = await db.update(r.number, (x) => { x.ai_state = 'WAITING'; x.ai_attempts = 0; x.ai_error = null; });
  kick(true);
  return json(full(out!, w));
}

async function signin(req: Request, url: URL): Promise<Response> {
  if (!mem().signin.take(clientKey(req.headers))) throw new Err(429, 'Too many tries');
  const f = path.join(db.dataDir(), 'signin', createHash('sha256').update(url.searchParams.get('code') ?? '').digest('hex'));
  const until = Number(await fs.readFile(f, 'utf8').catch(() => 0));
  const ok = until > Date.now() && await fs.rm(f).then(() => true, () => false); // used once
  return new Response(null, { status: 303, headers: { location: ok ? '/feedback' : '/feedback?signin=expired', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(ok ? { 'set-cookie': setCookie(req, 'fb_admin', signed(`admin:${Date.now() + 60 * 24 * 3600_000}`), 60 * 24 * 3600) } : {}) } });
}

async function serve(req: Request, n: number, id: string, url: URL): Promise<Response> {
  const exp = Number(url.searchParams.get('exp'));
  if (!(exp > Date.now() / 1000) || !same(url.searchParams.get('sig') ?? '', mac(`file:${n}:${id}:${exp}`))) throw new Err(404, 'Not found');
  const f = (await db.read(n))?.files.find((x) => x.id === id && x.done && !x.deleted_at);
  const st = f ? await fs.stat(db.filePath(n, id)).catch(() => null) : null;
  if (!f || !st) throw new Err(404, 'Not found');
  const head: Record<string, string> = {
    'content-type': f.content_type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes', 'content-security-policy': "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'content-disposition': `${f.content_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.file_name}"`,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  let from = 0, to = st.size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    from = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2])); if (m[1] && m[2]) to = Math.min(to, Number(m[2]));
    if (from > to) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } });
    status = 206; head['content-range'] = `bytes ${from}-${to}/${st.size}`;
  }
  head['content-length'] = String(to - from + 1);
  if (req.method === 'HEAD') return new Response(null, { status, headers: head });
  return new Response(Readable.toWeb(createReadStream(db.filePath(n, id), { start: from, end: to })) as ReadableStream, { status, headers: head });
}
