import './setup';
import { DB, SUBJECT, WRITES, resetDb } from './pageSeoTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { SITE_REVALIDATE_MAX_TAGS } from '../src/lib/cacheInvalidation';

/**
 * Bulk status changes (17-11-2026): POST /<resource>/bulk-status with
 * { ids, status } on comparisons, legal documents, blogs and courses.
 *
 * Each record goes through its module's own single-record code; the site is
 * told once for all of them (in requests of at most SITE_REVALIDATE_MAX_TAGS
 * tags, the site's own limit). Runs on the in-memory PostgREST stand-in, with
 * the site's /api/revalidate answered here and every request to it recorded.
 */

const SITE = 'https://site.example/api/revalidate';
const SECRET = 's'.repeat(40);
const now = '2026-11-17T00:00:00.000Z';

let server: http.Server;
let base: string;
/** The tags of every request that reached the site, in order. */
const siteRequests: string[][] = [];

test.before(async () => {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    if (href === SITE) {
      siteRequests.push((JSON.parse(String(init?.body)) as { tags: string[] }).tags);
      return new Response(JSON.stringify({ revalidated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return inner(input, init);
  }) as typeof fetch;
  process.env.SITE_REVALIDATE_URL = SITE;
  process.env.SITE_REVALIDATE_SECRET = SECRET;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

test.after(() => {
  server.close();
  process.env.SITE_REVALIDATE_URL = '';
  process.env.SITE_REVALIDATE_SECRET = '';
});

type Who = keyof typeof SUBJECT;
const token = (who: Who) =>
  jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

async function bulk(path: string, body: unknown, who?: Who) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${token(who)}` } : {}) },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? JSON.parse(raw) : null };
}

const id = (n: number) => `c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const comparison = (n: number, status: string) => ({
  id: id(n),
  slug: `cmp-${n}`,
  title: `Compare ${n}`,
  status,
  item_a: 'A',
  item_b: 'B',
  created_at: now,
  updated_at: now,
});
const blog = (n: number, status: string, publishedAt: string | null = null) => ({
  id: id(100 + n),
  slug: `post-${n}`,
  title: `Post ${n}`,
  status,
  published_at: publishedAt,
  category_slug: 'data-science',
  tags: [],
  date: '2026-11-01',
  created_at: now,
  updated_at: now,
});
const course = (n: number, status: string) => ({
  id: id(200 + n),
  slug: `course-${n}`,
  title: `Course ${n}`,
  status,
  modules: [],
  seo_keywords: [],
  seo_noindex: false,
  seo_nofollow: false,
  created_at: now,
  updated_at: now,
});

const patchesTo = (table: string) => WRITES.filter((w) => w.table === table && w.method === 'PATCH');
const statusOf = (table: string, rowId: string) => DB[table].find((r) => r.id === rowId)?.status;

test.beforeEach(() => {
  siteRequests.length = 0;
});

/* ── What is changed, and what is reported ───────────────────────────────── */

test('changes only what needs changing and reports every record', async () => {
  resetDb({ comparisons: [comparison(1, 'draft'), comparison(2, 'draft'), comparison(3, 'published')] });
  const res = await bulk('/comparisons/bulk-status', { ids: [id(1), id(2), id(3), id(99)], status: 'published' }, 'admin');

  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.json.data.updated, [id(1), id(2)]);
  assert.deepEqual(res.json.data.unchanged, [id(3)]);
  assert.deepEqual(res.json.data.failed, [{ id: id(99), message: 'Comparison not found' }]);
  assert.equal(statusOf('comparisons', id(1)), 'published');
  assert.equal(statusOf('comparisons', id(2)), 'published');
  // Nothing written for the record already published.
  assert.ok(!patchesTo('comparisons').some((w) => w.query.includes(id(3))));
});

test('the site is told once for all of them, with every record’s own tag', async () => {
  resetDb({ comparisons: [comparison(1, 'draft'), comparison(2, 'draft'), comparison(3, 'draft')] });
  const res = await bulk('/comparisons/bulk-status', { ids: [id(1), id(2), id(3)], status: 'published' }, 'admin');
  assert.equal(res.status, 200, res.raw);

  assert.equal(siteRequests.length, 1, 'one refresh request, not one per record');
  const tags = siteRequests[0];
  for (const slug of ['cmp-1', 'cmp-2', 'cmp-3']) assert.ok(tags.includes(`comparison:${slug}`), slug);
  assert.equal(new Set(tags).size, tags.length, 'no tag twice');
});

test('more tags than the site takes in one request go in several, each within its limit', async () => {
  const count = 60;
  resetDb({ comparisons: Array.from({ length: count }, (_, i) => comparison(i + 1, 'draft')) });
  const ids = Array.from({ length: count }, (_, i) => id(i + 1));
  const res = await bulk('/comparisons/bulk-status', { ids, status: 'published' }, 'admin');
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.json.data.updated.length, count);

  assert.ok(siteRequests.length >= 2, `${siteRequests.length} request(s)`);
  for (const batch of siteRequests) assert.ok(batch.length >= 1 && batch.length <= SITE_REVALIDATE_MAX_TAGS, `${batch.length} tags`);
  const all = siteRequests.flat();
  assert.equal(new Set(all).size, all.length, 'no tag sent twice');
  for (let n = 1; n <= count; n += 1) assert.ok(all.includes(`comparison:cmp-${n}`), `cmp-${n}`);
});

test('nothing to change means nothing written and no refresh', async () => {
  resetDb({ comparisons: [comparison(1, 'published'), comparison(2, 'published')] });
  const res = await bulk('/comparisons/bulk-status', { ids: [id(1), id(2)], status: 'published' }, 'admin');
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.json.data.unchanged, [id(1), id(2)]);
  assert.equal(patchesTo('comparisons').length, 0);
  assert.equal(siteRequests.length, 0);
});

/* ── Each module's own rules ─────────────────────────────────────────────── */

test('posts publish through setStatus: a first publish is stamped, an earlier one kept', async () => {
  const earlier = '2026-01-01T00:00:00.000Z';
  resetDb({ blogs: [blog(1, 'draft'), blog(2, 'draft', earlier)] });
  const res = await bulk('/blogs/bulk-status', { ids: [id(101), id(102)], status: 'published' }, 'content_writer');

  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.json.data.updated, [id(101), id(102)]);
  const [first, second] = DB.blogs;
  assert.equal(first.status, 'published');
  assert.ok(typeof first.published_at === 'string' && first.published_at.length > 0, 'first publish stamped');
  assert.equal(second.published_at, earlier, 'an earlier publish date is kept');
  assert.equal(siteRequests.length, 1);
  assert.ok(siteRequests[0].includes('blog:post-1') && siteRequests[0].includes('blog:post-2'));
});

test('courses change through updateCourse, and a status-only change writes no SEO audit row', async () => {
  resetDb({ courses: [course(1, 'published'), course(2, 'published')] });
  const res = await bulk('/courses/bulk-status', { ids: [id(201), id(202)], status: 'archived' }, 'content_writer');

  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.json.data.updated, [id(201), id(202)]);
  assert.equal(statusOf('courses', id(201)), 'archived');
  assert.equal(statusOf('courses', id(202)), 'archived');
  assert.equal(WRITES.filter((w) => w.table === 'seo_audit_log').length, 0);
  assert.equal(siteRequests.length, 1);
  assert.ok(siteRequests[0].includes('course:course-1') && siteRequests[0].includes('course:course-2'));
});

test('legal documents take the bulk change too', async () => {
  resetDb({ legal_docs: [{ id: id(301), slug: 'terms', title: 'Terms', status: 'draft', sections: [], created_at: now, updated_at: now }] });
  const res = await bulk('/legal/bulk-status', { ids: [id(301)], status: 'published' }, 'admin');
  assert.equal(res.status, 200, res.raw);
  assert.equal(statusOf('legal_docs', id(301)), 'published');
});

/* ── Who may, and what is accepted ───────────────────────────────────────── */

test('the same roles as a single save: comparisons are admin-only, posts and courses content roles', async () => {
  resetDb({ comparisons: [comparison(1, 'draft')], blogs: [blog(1, 'draft')] });
  const body = { ids: [id(1)], status: 'published' };
  assert.equal((await bulk('/comparisons/bulk-status', body)).status, 401);
  assert.equal((await bulk('/comparisons/bulk-status', body, 'content_writer')).status, 403);
  assert.equal((await bulk('/blogs/bulk-status', { ids: [id(101)], status: 'published' }, 'receptionist')).status, 403);
  assert.equal(statusOf('comparisons', id(1)), 'draft');
  assert.equal(statusOf('blogs', id(101)), 'draft');
});

test('a malformed request is refused before anything is written', async () => {
  resetDb({ comparisons: [comparison(1, 'draft')] });
  const tooMany = Array.from({ length: 101 }, (_, i) => id(i + 1));
  const bad: unknown[] = [
    { ids: [], status: 'published' },
    { ids: tooMany, status: 'published' },
    { ids: ['not-a-uuid'], status: 'published' },
    { ids: [id(1)], status: 'live' },
    { ids: [id(1)] },
    { ids: [id(1)], status: 'published', title: 'sneaked in' },
  ];
  for (const body of bad) {
    const res = await bulk('/comparisons/bulk-status', body, 'admin');
    assert.equal(res.status, 422, `${JSON.stringify(body).slice(0, 80)} → ${res.status} ${res.raw.slice(0, 120)}`);
  }
  assert.equal(patchesTo('comparisons').length, 0);
  assert.equal(statusOf('comparisons', id(1)), 'draft');
});

test('resources without a content status have no bulk route', async () => {
  const res = await bulk('/trainers/bulk-status', { ids: [id(1)], status: 'published' }, 'admin');
  assert.equal(res.status, 404);
});
