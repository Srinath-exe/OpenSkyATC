/* In-app feedback: the API on a throwaway folder; no AI, no network. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.FEEDBACK_DIR = mkdtempSync(join(tmpdir(), 'fb-'));
process.env.FEEDBACK_NO_SWEEP = '1';
delete process.env.GEMINI_API_KEY;
import { handleFeedback } from '../../src/lib/feedback/handler';
import * as db from '../../src/lib/feedback/store';
import { setReader, check, ReadFailed } from '../../src/lib/feedback/ai';
import { sweep, retention } from '../../src/lib/feedback/sweeper';

after(() => rmSync(process.env.FEEDBACK_DIR!, { recursive: true, force: true }));

class Who {
  cookie = ''; constructor(private head: Record<string, string> = {}, private ip = '10.0.0.1') {}
  async go(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const u = new URL(path, 'https://x.test/api/feedback/'); const parts = u.pathname.replace('/api/feedback/', '').split('/').filter(Boolean);
    const raw = body instanceof Uint8Array;
    const res = await handleFeedback(new Request(u, { method, body: body === undefined ? undefined : raw ? new Uint8Array(body as Uint8Array) : JSON.stringify(body), headers: { 'x-feedback': '1', 'x-real-ip': this.ip, ...(this.cookie ? { cookie: this.cookie } : {}), ...this.head, ...extra } }), parts);
    const c = res.headers.get('set-cookie'); if (c) this.cookie = [this.cookie, c.split(';')[0]].filter(Boolean).join('; ');
    const t = await res.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* bytes */ }
    return { status: res.status, j, t, headers: res.headers };
  }
  make(over: Record<string, unknown> = {}) { return this.go('POST', 'reports', { client_id: randomUUID(), body: 'The plane is stuck. It will not move.', mode: 'screenshot', route: '/play', ...over }); }
  async file(n: number, bytes: Uint8Array, kind = 'SCREENSHOT', type = 'image/png', cfid = randomUUID() as string) {
    const s = await this.go('POST', `reports/${n}/files`, { client_file_id: cfid, kind, size: bytes.length, content_type: type, name: 'a b.png' });
    if (s.status !== 200) return s;
    for (let o = 0; o < bytes.length; o += 1000) await this.go('PUT', `reports/${n}/files/${s.j.id}?offset=${o}`, bytes.subarray(o, o + 1000));
    return { ...(await this.go('POST', `reports/${n}/files/${s.j.id}/done`)), id: s.j.id as string };
  }
}
const PNG = new Uint8Array(2500).fill(7); PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let team: Who, agent: Who;
before(async () => {
  agent = new Who({ authorization: `Bearer ${db.keys().agent}`, 'x-feedback-agent': 'claude' });
  team = new Who({}, '10.0.0.9');
  const link = (await new Who().go('POST', 'signin', {}, { 'x-feedback-admin': db.keys().admin })).j.path as string;
  const r = await team.go('GET', link.replace('/api/feedback/', ''));
  assert.equal(r.status, 303); assert.equal((await team.go('GET', 'me')).j.triager, true);
  const again = await new Who().go('GET', link.replace('/api/feedback/', ''));
  assert.match(again.headers.get('location')!, /expired/, 'a sign-in link works once');
});

test('the same client_id makes one report, also when two arrive at once', async () => {
  const p = new Who(); const id = randomUUID();
  const a = await p.make({ client_id: id }); const b = await p.make({ client_id: id });
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.j.number, b.j.number);
  const id2 = randomUUID(); const two = await Promise.all([p.make({ client_id: id2 }), p.make({ client_id: id2 })]);
  assert.equal(two[0].j.number, two[1].j.number);
  const many = await Promise.all(Array.from({ length: 6 }, () => p.make()));
  assert.equal(new Set(many.map((x) => x.j.number)).size, 6, 'every report has its own number');
});

test('a stranger gets 404 for everything, the reporter sees their own without the internals', async () => {
  const p = new Who(), s = new Who({}, '10.0.0.2'); await s.make();
  const n = (await p.make()).j.number;
  for (const [m, u, b] of [['GET', '', undefined], ['PATCH', '', { status: 'FIXED' }], ['DELETE', '', undefined], ['POST', '/notes', { note: 'x' }], ['POST', '/verdict', { verdict: 'works' }], ['POST', '/files', { kind: 'FILE', size: 1, client_file_id: 'x' }], ['POST', '/submit', {}]] as const)
    assert.equal((await s.go(m, `reports/${n}${u}`, b)).status, 404, `${m} ${u}`);
  assert.equal((await p.go('PATCH', `reports/${n}`, { status: 'FIXED' })).status, 404, 'a reporter cannot triage');
  await team.go('PATCH', `reports/${n}`, { note: 'secret thought', internal: true }); await team.go('POST', `reports/${n}/notes`, { note: 'hello' });
  const mine = await p.go('GET', `reports/${n}`);
  assert.equal(mine.status, 200); assert.ok(!mine.t.includes('secret thought')); assert.ok(mine.t.includes('hello')); assert.ok(!('context' in mine.j));
  assert.equal((await s.go('GET', 'reports')).j.reports.every((r: any) => r.number !== n), true);
  const forged = new Who({ cookie: `fb_id=${(await db.read(n))!.reporter_id}.00` }); assert.equal((await forged.go('GET', `reports/${n}`)).status, 404);
  assert.equal((await new Who({ authorization: 'Bearer nope' }).go('GET', 'reports')).status, 401);
  const noHeader = await handleFeedback(new Request('https://x.test/api/feedback/reports', { method: 'POST', body: '{}' }), ['reports']); assert.equal(noHeader.status, 403);
});

test('an agent cannot set TESTED; the reporter can, or reopen', async () => {
  const p = new Who(); const n = (await p.make()).j.number;
  for (const s of ['TESTED', 'NEW']) assert.equal((await agent.go('PATCH', `reports/${n}`, { status: s })).status, 403);
  assert.equal((await p.go('POST', `reports/${n}/verdict`, { verdict: 'works' })).status, 409);
  assert.equal((await agent.go('PATCH', `reports/${n}`, { status: 'FIXED', note: 'done', commit: 'abc' })).j.status, 'FIXED');
  assert.equal((await p.go('POST', `reports/${n}/verdict`, { verdict: 'still_wrong', note: 'no' })).j.status, 'NEW');
  await agent.go('PATCH', `reports/${n}`, { status: 'FIXED' });
  const end = await p.go('POST', `reports/${n}/verdict`, { verdict: 'works' }); assert.equal(end.j.status, 'TESTED');
  assert.deepEqual((await db.read(n))!.events.map((e) => e.to_status), ['NEW', 'FIXED', 'NEW', 'FIXED', 'TESTED']);
});

test('files: pieces, retry, range; SVG, HTML and a renamed exe are refused', async () => {
  const p = new Who(); const n = (await p.make()).j.number;
  const ok = await p.file(n, PNG, 'SCREENSHOT', 'image/png', 'one'); assert.equal(ok.status, 200);
  const again = await p.go('POST', `reports/${n}/files`, { client_file_id: 'one', kind: 'SCREENSHOT', size: PNG.length }); assert.equal(again.j.done, true); assert.equal(again.j.id, (ok as any).id);
  const enc = (s: string) => new TextEncoder().encode(s.padEnd(64));
  for (const bad of [enc('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), enc('<!doctype html><script>'), enc('MZ\x90\x00 this is an exe')]) assert.equal((await p.file(n, bad)).status, 415);
  assert.equal((await p.go('POST', `reports/${n}/files`, { client_file_id: 'big', kind: 'FILE', size: 51 * 1024 * 1024 })).status, 413);
  const s = (await p.go('POST', `reports/${n}/files`, { client_file_id: 'over', kind: 'FILE', size: 10 })).j; assert.equal((await p.go('PUT', `reports/${n}/files/${s.id}?offset=0`, PNG)).status, 413);
  assert.equal((await p.go('PUT', `reports/${n}/files/${s.id}?offset=5`, PNG.subarray(0, 5))).j.have, 0, 'a wrong offset writes nothing');
  const got = (await p.go('GET', `reports/${n}`)).j.files; assert.equal(got.length, 1);
  const url = got[0].url.replace('/api/feedback/', '');
  const part = await new Who().go('GET', url, undefined, { range: 'bytes=0-3' }); assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-3/${PNG.length}`); assert.equal(part.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await new Who().go('GET', url.replace(/sig=..../, 'sig=0000'))).status, 404);
  assert.equal((await team.go('DELETE', `reports/${n}`)).status, 200); assert.equal((await p.go('GET', `reports/${n}`)).status, 404);
  assert.ok((await p.make()).j.number > n, 'a deleted number is not used again');
});

test('secrets are cut out on the server, long text is refused', async () => {
  const p = new Who(); const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh';
  const n = (await p.make({ body: `password: hunter2 ${jwt}`, url: '/play?token=abc123&icao=KSFO', context: { console: [{ message: `Bearer ${'a'.repeat(20)}` }], apiKey: 'sk-1' } })).j.number;
  const raw = JSON.stringify(await db.read(n)); for (const x of ['hunter2', jwt, 'abc123', 'aaaaaaaaaaaaaaaaaaaa', 'sk-1']) assert.ok(!raw.includes(x), x);
  assert.ok(raw.includes('icao=KSFO'));
  assert.equal((await p.make({ body: 'x'.repeat(20_001) })).status, 422); assert.equal((await p.make({ context: { a: 'x'.repeat(260 * 1024) } })).status, 413);
});

test('20 reports an hour for each person', async () => {
  const p = new Who({}, '10.9.9.9'); await p.make(); let last = 0; for (let i = 0; i < 20; i++) last = (await p.make()).status; assert.equal(last, 429);
});

test('list: counts, cursor, search', async () => {
  await agent.go('POST', 'reports', { client_id: randomUUID(), title: 'zebra crossing lights', severity: 'HIGH', steps: 'a', expected: 'b', actual: 'c' });
  const z = (await team.go('GET', 'reports?q=zebra')).j; assert.equal(z.reports.length, 1); assert.equal(z.reports[0].source, 'AGENT');
  const a = (await team.go('GET', 'reports?limit=3&status=NEW')).j; assert.equal(a.reports.length, 3); assert.ok(a.counts.NEW > 3);
  const b = (await team.go('GET', `reports?limit=3&status=NEW&cursor=${a.next}`)).j; assert.ok(b.reports[0].number < a.reports[2].number);
  assert.equal((await agent.go('GET', 'reports?severity=HIGH')).j.reports.every((r: any) => r.severity === 'HIGH'), true);
});

test('AI: off without a key; a person\'s title survives; a stuck reading is taken up again; failures are in words', async () => {
  const p = new Who({}, '10.0.0.5'); const off = (await p.make()).j.number; assert.equal((await db.read(off))!.ai_state, 'OFF');
  const reading = { title: 'AI title', kind: 'BUG' as const, severity: 'HIGH' as const, summary: 's', transcript: 't', asks: ['a'], mentions: [], steps_to_reproduce: [] };
  let calls = 0; setReader(async () => { calls++; return reading; });
  try {
    const n = (await p.make()).j.number; await sweep(); assert.equal((await db.read(n))!.ai_state, 'WAITING', 'not before its files are in');
    await p.go('POST', `reports/${n}/submit`, {}); await sweep(); let r = (await db.read(n))!; assert.equal(r.ai_state, 'DONE'); assert.equal(r.title, 'AI title'); assert.equal(r.severity, 'HIGH');
    await team.go('PATCH', `reports/${n}`, { title: 'Mine', severity: 'LOW' }); await team.go('POST', `reports/${n}/read`); await sweep(); r = (await db.read(n))!; assert.equal(r.title, 'Mine'); assert.equal(r.severity, 'LOW'); assert.equal(r.kind, 'BUG'); assert.equal(calls, 2);
    await db.update(n, (x) => { x.ai_state = 'READING'; x.ai_attempts = 1; x.ai_started_at = new Date(Date.now() - 11 * 60_000).toISOString(); }); await sweep(); assert.equal((await db.read(n))!.ai_state, 'DONE');
    const late = (await p.make()).j.number; await sweep(Date.now() + 16 * 60_000); r = (await db.read(late))!; assert.equal(r.ai_state, 'DONE'); assert.equal(r.ai_partial, true);
    await p.go('POST', `reports/${late}/submit`, {}); assert.equal((await db.read(late))!.ai_state, 'WAITING', 'read once more when the rest arrives');
    setReader(async () => { throw new Error('sk-raw-provider'); }); const err = console.error; console.error = () => undefined;
    for (let i = 0; i < 4; i++) await sweep(); console.error = err; r = (await db.read(late))!; assert.equal(r.ai_state, 'FAILED'); assert.equal(r.ai_attempts, 3); assert.ok(!r.ai_error!.includes('sk-raw'));
    assert.throws(() => check('{"title":1}'), ReadFailed);
  } finally { setReader(null); }
});

test('retention: recordings of long-closed reports go, the words stay', async () => {
  const p = new Who({}, '10.0.0.6'); const n = (await p.make()).j.number; const webm = new Uint8Array(50); webm.set([0x1a, 0x45, 0xdf, 0xa3]);
  await p.file(n, webm, 'RECORDING', 'video/webm'); await p.file(n, PNG); await team.go('PATCH', `reports/${n}`, { status: 'WONT_CHANGE' });
  await retention(); assert.ok((await db.read(n))!.files.every((f) => !f.deleted_at));
  await retention(Date.now() + 91 * 24 * 3600_000); const f = (await db.read(n))!.files; assert.ok(f.find((x) => x.kind === 'RECORDING')!.deleted_at); assert.equal(f.find((x) => x.kind === 'SCREENSHOT')!.deleted_at, null);
});
