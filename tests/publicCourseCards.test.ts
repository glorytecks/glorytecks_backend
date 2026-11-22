import './setup';
import './redisTestEnv';
import { DB, resetDb } from './pageSeoTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { FakeRedisServer } from './fakeRedisServer';

/**
 * `GET /public/courses?view=card` (17-11-2026).
 *
 * Every course LIST on the site needs about a dozen fields per course; the
 * whole list was 1,244,106 bytes on the live API for 83 courses, most of it
 * FAQs and syllabi that only a course's own page shows. The card view returns
 * those fields plus module and project counts. These tests pin what it sends,
 * what it asks the database for, that the plain request is unchanged, and that
 * a course or brochure write clears it from Redis together with the full list.
 */

let redis: FakeRedisServer;
let server: http.Server;
let base: string;
/** The `select` of every read of the courses table, in order. */
const selects: string[] = [];

const now = '2026-11-17T00:00:00.000Z';

function courses() {
  return [
    {
      id: 'c1000000-0000-4000-8000-000000000001',
      slug: 'data-science',
      title: 'Data Science',
      category: 'Data',
      tagline: 'From data to decisions',
      description: 'A long description only the course page shows.',
      duration: '6 Months',
      modules: ['Python', 'Statistics', 'Machine Learning'],
      projects: ['Churn model', 'Sales dashboard'],
      tools: ['Python', 'SQL'],
      syllabus: [{ title: 'Week 1', topics: ['Syllabus text only the course page shows'] }],
      faqs: [{ q: 'An FAQ only the course page shows?', a: 'Yes.' }],
      fees: 'Fee text that must not reach a list',
      status: 'published',
      featured: true,
      order_index: 1,
      show_in_nav: true,
      nav_order: 2,
      seo_meta_title: 'Data Science Course | GloryTecks',
      seo_keywords: ['editorial keyword list'],
      seo_intent_note: 'Editorial note that must stay in the CMS',
      seo_noindex: true,
      seo_nofollow: false,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'c1000000-0000-4000-8000-000000000002',
      slug: 'power-bi',
      title: 'Power BI',
      category: 'Analytics',
      tagline: 'Dashboards that answer questions',
      duration: '2 Months',
      tools: ['Power BI'],
      status: 'published',
      featured: false,
      order_index: 2,
      show_in_nav: false,
      seo_keywords: [],
      seo_noindex: false,
      seo_nofollow: false,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'c1000000-0000-4000-8000-000000000003',
      slug: 'draft-course',
      title: 'Draft Course',
      status: 'draft',
      modules: ['x'],
      seo_keywords: [],
      seo_noindex: false,
      seo_nofollow: false,
      created_at: now,
      updated_at: now,
    },
  ];
}

async function get(path: string): Promise<{ status: number; raw: string; json: { data: Record<string, unknown>[] } }> {
  const res = await fetch(base + path);
  const raw = await res.text();
  return { status: res.status, raw, json: JSON.parse(raw) };
}

/** cacheSet is fire-and-forget, so wait for the key rather than racing it. */
async function waitForKey(key: string): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (redis.keys().includes(key)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test.before(async () => {
  redis = new FakeRedisServer();
  process.env.REDIS_URL = `redis://127.0.0.1:${await redis.listen()}`;
  const { connectRedis, isRedisReady } = await import('../src/config/redis');
  await connectRedis();
  for (let i = 0; i < 100 && !isRedisReady(); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(isRedisReady(), 'the fake Redis is connected');

  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    if (href.includes('/rest/v1/courses')) selects.push(new URL(href).searchParams.get('select') ?? '');
    return inner(input, init);
  }) as typeof fetch;

  const app = (await import('../src/app')).default;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

test.after(async () => {
  server.close();
  const { disconnectRedis } = await import('../src/config/redis');
  await disconnectRedis();
  redis.close();
});

test.beforeEach(async () => {
  resetDb({ courses: courses() });
  selects.length = 0;
  const { cacheDeletePattern } = await import('../src/lib/cache');
  await cacheDeletePattern('public:courses:*');
});

const CARD_KEYS = new Set([
  'id',
  'slug',
  'title',
  'category',
  'tagline',
  'duration',
  'tools',
  'featured',
  'order',
  'showInNav',
  'navOrder',
  'seo',
  'createdAt',
  'updatedAt',
  'moduleCount',
  'projectCount',
]);

test('the card view sends the list fields and counts, and nothing a list does not show', async () => {
  const res = await get('/public/courses?view=card');
  assert.equal(res.status, 200, res.raw);
  const cards = res.json.data;
  assert.deepEqual(cards.map((c) => c.slug), ['data-science', 'power-bi'], 'published courses only');

  for (const card of cards) {
    for (const key of Object.keys(card)) assert.ok(CARD_KEYS.has(key), `unexpected field ${key}`);
  }
  const [ds, pbi] = cards;
  assert.equal(ds.moduleCount, 3);
  assert.equal(ds.projectCount, 2);
  assert.equal(pbi.moduleCount, 0);
  assert.equal(pbi.projectCount, 0);
  assert.deepEqual(ds.tools, ['Python', 'SQL']);
  assert.equal(ds.showInNav, true);
  assert.equal(ds.navOrder, 2);
  assert.equal(ds.featured, true);
  assert.equal(ds.updatedAt, now);

  // The sitemap leaves out a course an editor hid from search; nothing else of
  // `seo` travels with a card.
  assert.deepEqual(ds.seo, { noindex: true });
  assert.equal('seo' in pbi, false);

  for (const leak of [
    'A long description',
    'Syllabus text',
    'An FAQ only',
    'Fee text',
    'editorial keyword list',
    'Editorial note',
    'Data Science Course | GloryTecks',
  ]) {
    assert.ok(!res.raw.includes(leak), `the card view leaked "${leak}"`);
  }
});

test('the card view asks the database only for the card columns', async () => {
  await get('/public/courses?view=card');
  assert.equal(selects.length, 1);
  const columns = selects[0].split(',');
  for (const heavy of ['faqs', 'syllabus', 'description', 'fees', 'placement', 'skills', 'images']) {
    assert.ok(!columns.includes(heavy), `the card read selected ${heavy}`);
  }
  for (const needed of ['slug', 'title', 'modules', 'projects', 'show_in_nav', 'nav_order', 'seo_noindex', 'updated_at']) {
    assert.ok(columns.includes(needed), `the card read must select ${needed}`);
  }
});

test('the plain request and an unknown view still get the whole list, as before', async () => {
  for (const path of ['/public/courses', '/public/courses?view=full']) {
    const res = await get(path);
    assert.equal(res.status, 200, res.raw);
    const ds = res.json.data.find((c) => c.slug === 'data-science') as Record<string, unknown>;
    assert.equal(ds.description, 'A long description only the course page shows.', path);
    assert.deepEqual(ds.modules, ['Python', 'Statistics', 'Machine Learning'], path);
    assert.equal('moduleCount' in ds, false, path);
    // Editorial SEO fields still never leave the CMS.
    assert.ok(!res.raw.includes('Editorial note'), path);
  }
});

test('the card view is cached, and a course or brochure write clears it with the full list', async () => {
  const { invalidateResource } = await import('../src/lib/cacheInvalidation');

  for (const resource of ['courses', 'brochures']) {
    await get('/public/courses?view=card');
    await get('/public/courses');
    assert.ok(await waitForKey('gt:public:courses:card'), 'the card list is cached');
    assert.ok(await waitForKey('gt:public:courses:all'), 'the full list is cached');

    const reads = selects.length;
    await get('/public/courses?view=card');
    assert.equal(selects.length, reads, 'a cached card list does not reach the database');

    await invalidateResource(resource);
    assert.ok(!redis.keys().includes('gt:public:courses:card'), `a ${resource} write clears the card list`);
    assert.ok(!redis.keys().includes('gt:public:courses:all'), `a ${resource} write clears the full list`);
  }
});

test('the card list and the full list have separate cache keys', async () => {
  DB.courses[0].description = 'Changed';
  await get('/public/courses?view=card');
  const full = await get('/public/courses');
  assert.equal(
    (full.json.data.find((c) => c.slug === 'data-science') as Record<string, unknown>).description,
    'Changed',
    'a cached card list never answers a request for the whole list',
  );
});
