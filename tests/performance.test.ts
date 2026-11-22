import './setup';
import { DB, SUBJECT, resetDb } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { readRemainingPages } from '../src/services/dashboard.service';

/**
 * What the admin's performance work rests on, through the real middleware
 * stack: lists ask the database for only what they show, the background check
 * for new leads stays small and role-scoped, and the timing header says nothing
 * beyond durations.
 */

type Role = keyof typeof SUBJECT;

const standIn = globalThis.fetch;
/** What reached the database, as decoded PostgREST addresses. */
const sent: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
  if (href.includes('/rest/v1/')) sent.push(decodeURIComponent(href));
  return standIn(input, init);
}) as typeof fetch;

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());

const tokenFor = (who: Role) =>
  jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

const get = (path: string, who?: Role, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { ...headers, ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) } });

/** The columns the last read of a table asked for. */
function columnsRead(table: string): string[] {
  const read = sent.filter((url) => url.includes(`/rest/v1/${table}?`)).at(-1);
  assert.ok(read, `${table} was read`);
  return (new URL(read).searchParams.get('select') ?? '').split(',').map((c) => c.split(':').at(-1) as string);
}

const POST_ID = '11111111-1111-4111-8111-111111111111';

const LISTS: { path: string; table: string; heavy: string[] }[] = [
  { path: '/blogs', table: 'blogs', heavy: ['content', 'html', 'toc', 'faqs', 'seo_meta_description'] },
  { path: '/courses', table: 'courses', heavy: ['syllabus', 'modules', 'faqs', 'description', 'seo_meta_description'] },
  { path: '/comparisons', table: 'comparisons', heavy: ['rows', 'intro', 'verdict', 'faqs', 'meta_description'] },
  { path: '/legal', table: 'legal_docs', heavy: ['sections', 'intro'] },
];

for (const { path, table, heavy } of LISTS) {
  test(`${path} asks the database for the columns its table shows, and never the record's body`, async () => {
    resetDb({ [table]: [{ id: POST_ID, title: 'A record', slug: 'a-record', status: 'published' }] });
    sent.length = 0;
    const res = await get(`/api/v1${path}?limit=20`, 'admin');
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: { id: string; title: string }[] };
    assert.equal(data[0].title, 'A record');
    assert.equal(data[0].id, POST_ID, 'a row can always be opened');

    const columns = columnsRead(table);
    assert.ok(columns.includes('id') && columns.includes('title'));
    for (const column of heavy) assert.ok(!columns.includes(column), `${table} list leaves out ${column}`);
  });

  test(`${path}/:id still reads the whole record, for its editor`, async () => {
    resetDb({ [table]: [{ id: POST_ID, title: 'A record', slug: 'a-record', status: 'published' }] });
    sent.length = 0;
    const res = await get(`/api/v1${path}/${POST_ID}`, 'admin');
    assert.equal(res.status, 200);
    const columns = columnsRead(table);
    assert.ok(columns.includes('*') || heavy.every((c) => columns.includes(c)), `${table} detail reads ${heavy.join(', ')}`);
  });
}

const LEAD = { name: 'PulseLeadSentinel', email: 'pulse-lead@dashboard.invalid', phone: '+10000000077' };

test('the pulse answers each lead table with its newest time and how many are unhandled', async () => {
  resetDb({
    contact_enquiries: [
      { id: 'e1', ...LEAD, status: 'new', created_at: '2026-10-30T10:00:00.000Z' },
      { id: 'e2', ...LEAD, status: 'new', created_at: '2026-10-31T10:00:00.000Z' },
      { id: 'e3', ...LEAD, status: 'closed', created_at: '2026-10-29T10:00:00.000Z' },
    ],
    demo_requests: [{ id: 'd1', ...LEAD, status: 'contacted', created_at: '2026-10-28T10:00:00.000Z' }],
    chat_enquiries: [],
  });
  const res = await get('/api/v1/dashboard/pulse', 'receptionist');
  assert.equal(res.status, 200);
  const { data } = (await res.json()) as { data: { checkedAt: string; leads: Record<string, unknown> } };
  assert.ok(!Number.isNaN(Date.parse(data.checkedAt)));
  assert.deepEqual(data.leads, {
    enquiries: { latestAt: '2026-10-31T10:00:00.000Z', unhandled: 2 },
    demoRequests: { latestAt: '2026-10-28T10:00:00.000Z', unhandled: 0 },
    chatEnquiries: { latestAt: null, unhandled: 0 },
  });
});

test('the pulse changes when a lead arrives', async () => {
  resetDb({ contact_enquiries: [{ id: 'e1', ...LEAD, status: 'new', created_at: '2026-10-30T10:00:00.000Z' }] });
  const read = async () => ((await (await get('/api/v1/dashboard/pulse', 'admin')).json()) as { data: { leads: { enquiries: unknown } } }).data.leads.enquiries;
  const before = await read();
  DB.contact_enquiries.push({ id: 'e2', ...LEAD, status: 'new', created_at: '2026-10-31T10:00:00.000Z' });
  assert.notDeepEqual(await read(), before);
});

test('the pulse carries no lead details, and goes only to the roles that handle leads', async () => {
  resetDb({ contact_enquiries: [{ id: 'e1', ...LEAD, status: 'new', created_at: '2026-10-30T10:00:00.000Z' }] });
  for (const who of ['admin', 'receptionist'] as Role[]) {
    const res = await get('/api/v1/dashboard/pulse', who);
    assert.equal(res.status, 200, who);
    const raw = await res.text();
    for (const value of Object.values(LEAD)) assert.ok(!raw.includes(value), `${who} is not sent ${value}`);
  }
  for (const who of ['content_writer', 'editor', 'viewer'] as Role[]) {
    assert.equal((await get('/api/v1/dashboard/pulse', who)).status, 403, who);
  }
  assert.equal((await get('/api/v1/dashboard/pulse')).status, 401, 'anonymous');
});

test('the pulse reads lead rows only for their time, not their contents', async () => {
  resetDb({ contact_enquiries: [{ id: 'e1', ...LEAD, status: 'new', created_at: '2026-10-30T10:00:00.000Z' }] });
  sent.length = 0;
  await get('/api/v1/dashboard/pulse', 'admin');
  const columns = sent.filter((url) => url.includes('/rest/v1/contact_enquiries?') && !url.includes('status=')).flatMap((url) => new URL(url).searchParams.get('select')?.split(',') ?? []);
  for (const column of ['email', 'phone', 'name', 'message']) assert.ok(!columns.includes(column), `${column} is not read`);
});

test('a signed-in request says where its time went, in durations only', async () => {
  resetDb({ contact_enquiries: [] });
  const res = await get('/api/v1/dashboard/pulse', 'admin');
  const timing = res.headers.get('server-timing') ?? '';
  assert.match(timing, /^total;dur=\d+\.\d, auth;dur=\d+\.\d, db;dur=\d+\.\d;desc="[1-9]\d* calls"$/);
  assert.ok(!/contact_enquiries|select|rest\/v1|Bearer/.test(timing), 'no query, table or credential leaves the server');
});

test('the database time counts overlapping calls once', async () => {
  resetDb({ contact_enquiries: [] });
  const started = Date.now();
  const res = await get('/api/v1/dashboard/pulse', 'admin');
  const elapsed = Date.now() - started;
  const db = Number(/db;dur=([\d.]+)/.exec(res.headers.get('server-timing') ?? '')?.[1]);
  assert.ok(db <= elapsed + 1, `${db} ms of database time fits in ${elapsed} ms of request`);
});

test('nobody is told anything about the server before signing in', async () => {
  const anonymous = await get('/api/v1/dashboard/pulse');
  assert.equal(anonymous.headers.get('server-timing'), null);
  const badToken = await fetch(`${base}/api/v1/dashboard/pulse`, { headers: { Authorization: 'Bearer not-a-token' } });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.headers.get('server-timing'), null);
});

test('the admin, on its own origin, may read the timing', async () => {
  resetDb({ contact_enquiries: [] });
  const origin = 'https://admin.glorytecks.test';
  const res = await get('/api/v1/dashboard/pulse', 'admin', { Origin: origin });
  assert.equal(res.headers.get('timing-allow-origin'), origin);
});

test('a preflight stays good for two hours, the most a browser allows', async () => {
  const res = await fetch(`${base}/api/v1/dashboard/stats`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://admin.glorytecks.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(res.headers.get('access-control-max-age'), '7200');
});

test('pages read together keep their order, whichever answers first', async () => {
  const slowFirst = (page: number) =>
    new Promise<{ items: number[] }>((resolve) => setTimeout(() => resolve({ items: [page * 10, page * 10 + 1] }), page === 2 ? 20 : 1));
  assert.deepEqual(await readRemainingPages(4000, 50_000, slowFirst), [20, 21, 30, 31, 40, 41]);
});

test('pages read together start together', async () => {
  let open = 0;
  let most = 0;
  await readRemainingPages(5000, 50_000, async () => {
    open += 1;
    most = Math.max(most, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open -= 1;
    return { items: [] };
  });
  assert.equal(most, 4);
});

test('reading pages stops at the row limit, and asks for nothing when one page holds everything', async () => {
  const asked: number[] = [];
  const read = async (page: number) => {
    asked.push(page);
    return { items: [] };
  };
  await readRemainingPages(10, 50_000, read);
  assert.deepEqual(asked, []);
  await readRemainingPages(1_000_000, 3000, read);
  assert.deepEqual(asked, [2, 3]);
});
