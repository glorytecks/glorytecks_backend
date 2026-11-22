import './setup';
// AFTER './setup', which disables the cache for every other suite.
import './redisTestEnv';
import { DB, REQUESTS, SUBJECT, resetDb } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { FakeRedisServer } from './fakeRedisServer';

/**
 * Cache isolation for the dashboard, on the real Redis code path.
 *
 * /dashboard/stats is cached under ONE key for every caller. That is only
 * safe because the role filter runs on the way out of the cache, on every
 * request. These tests warm the cache as the most privileged role, take the
 * database away so any later answer can only come from the cache, and check
 * what every other role is then handed.
 *
 * The newer dashboard endpoints are not cached per role at all; the second
 * test pins that no role-shaped entry ever reaches Redis.
 */

type Role = keyof typeof SUBJECT;

const LEAD = { name: 'CachedLeadSentinel', email: 'cached-lead@dashboard.invalid', phone: '+10000000099' };
const DRAFT = 'CachedDraftSentinelTitle';

let redis: FakeRedisServer;
let server: http.Server;
let base: string;

test.before(async () => {
  redis = new FakeRedisServer();
  process.env.REDIS_URL = `redis://127.0.0.1:${await redis.listen()}`;
  const { connectRedis, isRedisReady } = await import('../src/config/redis');
  await connectRedis();
  for (let i = 0; i < 100 && !isRedisReady(); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(isRedisReady(), 'the fake Redis is connected');

  const app = (await import('../src/app')).default;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  server.close();
  const { disconnectRedis } = await import('../src/config/redis');
  await disconnectRedis();
  redis.close();
});

const tokenFor = (who: Role) =>
  jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

async function get(path: string, who: Role): Promise<{ status: number; raw: string; body: any }> {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${tokenFor(who)}` } });
  const raw = await res.text();
  return { status: res.status, raw, body: JSON.parse(raw) };
}

const dashboardKeys = () => redis.keys().filter((k) => k.startsWith('gt:admin:dashboard:'));

async function waitForKey(key: string) {
  for (let i = 0; i < 100 && !redis.keys().includes(key); i += 1) await new Promise((r) => setTimeout(r, 10));
}

test('a cache warmed by an administrator never hands lead details or drafts to another role', async () => {
  const now = new Date().toISOString();
  resetDb({
    contact_enquiries: [{ id: 'e1', ...LEAD, status: 'new', created_at: now }],
    demo_requests: [{ id: 'd1', ...LEAD, status: 'new', created_at: now }],
    blogs: [{ id: 'b1', title: DRAFT, slug: 'cached-draft', status: 'draft', updated_at: now, created_at: now }],
    courses: [{ id: 'c1', title: DRAFT, slug: 'cached-course', status: 'draft', updated_at: now, created_at: now }],
  });

  const warm = await get('/api/v1/dashboard/stats', 'admin');
  assert.equal(warm.status, 200);
  assert.ok(warm.raw.includes(LEAD.email) && warm.raw.includes(DRAFT), 'the administrator sees everything');
  await waitForKey('gt:admin:dashboard:stats');
  assert.deepEqual(dashboardKeys(), ['gt:admin:dashboard:stats'], 'one shared key, not one per role');

  // From here on the database is empty: whatever a role is handed came from the cache.
  for (const table of Object.keys(DB)) DB[table] = [];

  const expectations: Record<Role, { leads: boolean; drafts: boolean }> = {
    admin: { leads: true, drafts: true },
    receptionist: { leads: true, drafts: false },
    content_writer: { leads: false, drafts: true },
    editor: { leads: false, drafts: false },
    viewer: { leads: false, drafts: false },
  };
  for (const [who, may] of Object.entries(expectations) as [Role, (typeof expectations)[Role]][]) {
    const { status, raw, body } = await get('/api/v1/dashboard/stats', who);
    assert.equal(status, 200, who);
    assert.equal(body.data.counts.enquiries, 1, `${who} was served from the cache`);
    assert.equal(body.data.generatedAt, warm.body.data.generatedAt, `${who}: the cached reading time, not a new one`);
    for (const value of Object.values(LEAD)) {
      assert.equal(raw.includes(value), may.leads, `${who} ${may.leads ? 'sees' : 'never sees'} ${value}`);
    }
    assert.equal(raw.includes(DRAFT), may.drafts, `${who} ${may.drafts ? 'sees' : 'never sees'} the draft title`);
  }
});

test('a lead changed through the API has cleared the cached counts by the time the response returns', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  resetDb({ contact_enquiries: [{ id, ...LEAD, status: 'new', created_at: new Date().toISOString() }] });
  await get('/api/v1/dashboard/stats', 'admin');
  await get('/api/v1/dashboard/pulse', 'admin');
  await waitForKey('gt:admin:dashboard:stats');
  await waitForKey('gt:admin:dashboard:pulse');

  redis.delMs = 40;
  const res = await fetch(`${base}/api/v1/enquiries/${id}/status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenFor('admin')}`, 'Content-Type': 'application/json', Origin: 'https://admin.glorytecks.test' },
    body: JSON.stringify({ status: 'closed' }),
  });
  assert.equal(res.status, 200);
  // Read at once, with the purge slower than the response: on a serverless host
  // the function may stop as soon as the response is sent.
  const left = dashboardKeys();
  redis.delMs = 0;
  assert.deepEqual(left, []);
});

test('the pulse is answered from the cache, so several open dashboards cost one read', async () => {
  resetDb({ contact_enquiries: [{ id: 'e1', ...LEAD, status: 'new', created_at: new Date().toISOString() }] });
  const first = await get('/api/v1/dashboard/pulse', 'admin');
  await waitForKey('gt:admin:dashboard:pulse');
  REQUESTS.length = 0;
  const second = await get('/api/v1/dashboard/pulse', 'receptionist');
  assert.deepEqual(second.body.data, first.body.data);
  assert.deepEqual(REQUESTS, ['GET admin_users'], 'only the caller is looked up');
});

test('the per-role dashboard endpoints never write a role-shaped entry to the shared cache', async () => {
  resetDb({});
  await redis.keys().forEach(() => undefined);
  for (const who of Object.keys(SUBJECT) as Role[]) {
    for (const path of ['/dashboard/status', '/dashboard/attention', '/dashboard/trends?range=7&tz=330']) {
      const { status } = await get(`/api/v1${path}`, who);
      assert.equal(status, 200, `${who} ${path}`);
    }
  }
  await get('/api/v1/dashboard/activity', 'admin');
  const unexpected = dashboardKeys().filter((k) => k !== 'gt:admin:dashboard:stats' && k !== 'gt:admin:dashboard:pulse');
  assert.deepEqual(unexpected, [], 'no attention, trends, activity or status entry is cached per role');
});
