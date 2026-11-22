import './setup';
import { DB, IDS, SUBJECT, WRITES, resetDb } from './pageSeoTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { PAGE_SEO_PATHS, ROUTE_KEYED_PAGES } from '../src/seo/pageSeoRegistry';
import { siteTagsForChange } from '../src/lib/siteRevalidation';

/**
 * Page SEO (A4, 2026-10-15): the non-blog page SEO endpoints, the course and
 * comparison SEO fields, and what the public API exposes.
 *
 * Runs against an in-memory PostgREST (pageSeoTestEnv) that records every
 * write, so each test asserts what reached the database as well as the status.
 */

// Hold the media host allowlist on regardless of a developer's .env.
process.env.MEDIA_ALLOW_ANY_HTTPS_HOST = 'false';

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());
test.beforeEach(() => resetDb());

type Who = keyof typeof SUBJECT;
const token = (who: Who) =>
  jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

async function call(path: string, opts: { method?: string; who?: Who; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.who ? { Authorization: `Bearer ${token(opts.who)}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? JSON.parse(raw) : null };
}

const writesTo = (table: string) => WRITES.filter((w) => w.table === table);

/* ── Authorization ────────────────────────────────────────────────────────── */

test('only administrators reach the Page SEO endpoints', async () => {
  const requests: [string, string, unknown?][] = [
    ['GET', '/api/v1/page-seo'],
    ['GET', '/api/v1/page-seo/entry?path=%2F'],
    ['PUT', '/api/v1/page-seo', { path: '/', metaTitle: 'x' }],
    ['DELETE', '/api/v1/page-seo?path=%2F'],
  ];
  for (const [method, path, body] of requests) {
    for (const who of ['receptionist', 'content_writer', 'editor', 'viewer'] as Who[]) {
      const res = await call(path, { method, who, body });
      assert.equal(res.status, 403, `${who} must be refused ${method} ${path}`);
    }
    assert.equal((await call(path, { method, body })).status, 401, `anonymous ${method} ${path}`);
  }
  assert.equal(writesTo('page_seo').length, 0, 'a refused request must not write');
  assert.equal(writesTo('seo_audit_log').length, 0);
  assert.equal((await call('/api/v1/page-seo', { who: 'admin' })).status, 200);
});

/* ── Validation ───────────────────────────────────────────────────────────── */

test('unsafe or malformed values are refused before anything is written', async () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['unknown path', { path: '/not-a-page', metaTitle: 'x' }, /Not a page whose SEO is edited here/],
    ['trailing slash', { path: '/courses/', metaTitle: 'x' }, /Not a page/],
    ['course path', { path: '/courses/data-science', metaTitle: 'x' }, /course or comparison record/],
    ['blog path', { path: '/blog/some-post', metaTitle: 'x' }, /Not a page/],
    ['free-form canonical', { path: '/', canonicalUrl: 'https://other.example/' }, /Canonical URLs are generated/],
    ['unknown field', { path: '/', metaKeywords: 'x' }, /Unexpected SEO field/],
    ['title too long', { path: '/', metaTitle: 't'.repeat(121) }, /at most 120/],
    ['description too long', { path: '/', metaDescription: 'd'.repeat(321) }, /at most 320/],
    ['zero-width character', { path: '/', metaTitle: 'Glory​Tecks' }, /invisible or control/],
    ['bidi override', { path: '/', ogTitle: 'abc‮def' }, /invisible or control/],
    ['non-text title', { path: '/', metaTitle: 42 }, /must be text/],
    ['http image', { path: '/', ogImage: 'http://res.cloudinary.com/a.png' }, /https/],
    ['javascript image', { path: '/', ogImage: 'javascript:alert(1)' }, /./],
    ['image on an unapproved host', { path: '/', ogImage: 'https://not-allowlisted.example/a.png' }, /approved media host/],
    ['too many keywords', { path: '/', keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }, /at most 10/],
    ['string robots flag', { path: '/', noindex: 'true' }, /true or false/],
    ['nofollow without noindex', { path: '/', nofollow: true }, /also hidden from search results/],
  ];
  for (const [name, body, message] of bad) {
    const res = await call('/api/v1/page-seo', { method: 'PUT', who: 'admin', body });
    assert.ok(res.status === 422 || res.status === 400, `${name}: expected 4xx, got ${res.status}`);
    assert.match(res.raw, message, name);
  }
  assert.equal(writesTo('page_seo').length, 0);
  assert.equal(writesTo('seo_audit_log').length, 0);
});

/* ── Saving ───────────────────────────────────────────────────────────────── */

test('a save normalises text, stores it by path and audits field names only', async () => {
  const res = await call('/api/v1/page-seo', {
    method: 'PUT',
    who: 'admin',
    body: {
      path: '/data-science-course-ameerpet',
      metaTitle: '  Data Science Course   in Ameerpet  ',
      metaDescription: 'Line one\nline two',
      ogTitle: '   ',
      keywords: ['data science ameerpet', 'Data Science Ameerpet', ' '],
      intentNote: '  Local commercial intent.\r\nNot the course page.  ',
    },
  });
  assert.equal(res.status, 200, res.raw);

  const row = DB.page_seo.find((r) => r.path === '/data-science-course-ameerpet');
  assert.ok(row);
  assert.equal(row.meta_title, 'Data Science Course in Ameerpet');
  assert.equal(row.meta_description, 'Line one line two');
  assert.equal(row.og_title, null, 'whitespace-only is stored as null (use the default)');
  assert.deepEqual(row.keywords, ['data science ameerpet']);
  assert.equal(row.intent_note, 'Local commercial intent.\nNot the course page.');
  assert.equal(row.updated_by, SUBJECT.admin);

  const audit = DB.seo_audit_log;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_type, 'page_seo');
  assert.equal(audit[0].entity_key, '/data-science-course-ameerpet');
  assert.equal(audit[0].action, 'create');
  assert.equal(audit[0].editor_id, SUBJECT.admin);
  assert.deepEqual(audit[0].changed_fields, ['metaTitle', 'metaDescription', 'keywords', 'intentNote']);
  assert.ok(!JSON.stringify(audit[0]).includes('Ameerpet'), 'the audit row holds field names, never values');

  // The response previews the result: override over the computed landing fallback.
  assert.equal(res.json.data.effective.title, 'Data Science Course in Ameerpet');
  assert.match(res.json.data.fallback.title, /^Data Science Course in Ameerpet, Hyderabad \| GloryTecks$/);
});

test('a second save is an update, records only what changed, and an empty save resets', async () => {
  await call('/api/v1/page-seo', { method: 'PUT', who: 'admin', body: { path: '/', metaTitle: 'Home A', metaDescription: 'Desc' } });
  const second = await call('/api/v1/page-seo', { method: 'PUT', who: 'admin', body: { path: '/', metaTitle: 'Home B', metaDescription: 'Desc' } });
  assert.equal(second.status, 200);
  assert.equal(DB.page_seo.length, 1, 'one row per path');
  assert.deepEqual(DB.seo_audit_log.at(-1)?.changed_fields, ['metaTitle']);
  assert.equal(DB.seo_audit_log.at(-1)?.action, 'update');

  const empty = await call('/api/v1/page-seo', { method: 'PUT', who: 'admin', body: { path: '/' } });
  assert.equal(empty.status, 200);
  assert.equal(DB.page_seo.length, 0, 'an all-default form removes the row');
  assert.equal(DB.seo_audit_log.at(-1)?.action, 'delete');
  assert.equal(empty.json.data.override, null);
  assert.equal(empty.json.data.effective.title, 'GloryTecks — IT Training Institute in Ameerpet, Hyderabad');
});

test('DELETE resets a page to its defaults and audits it', async () => {
  await call('/api/v1/page-seo', { method: 'PUT', who: 'admin', body: { path: '/contact', noindex: true, nofollow: true } });
  const res = await call('/api/v1/page-seo?path=%2Fcontact', { method: 'DELETE', who: 'admin' });
  assert.equal(res.status, 204);
  assert.equal(DB.page_seo.length, 0);
  assert.deepEqual(DB.seo_audit_log.at(-1)?.changed_fields, ['noindex', 'nofollow']);
  // Resetting a page that has nothing saved is a no-op, not an error.
  assert.equal((await call('/api/v1/page-seo?path=%2Fcontact', { method: 'DELETE', who: 'admin' })).status, 204);
});

test('/about is stored on the about_page record, not duplicated in page_seo', async () => {
  const res = await call('/api/v1/page-seo', {
    method: 'PUT',
    who: 'admin',
    body: { path: '/about', metaTitle: 'About GloryTecks — Ameerpet', ogImageAlt: 'Our classroom' },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(DB.page_seo.length, 0);
  assert.equal(DB.about_page[0].seo_meta_title, 'About GloryTecks — Ameerpet');
  assert.equal(DB.about_page[0].seo_og_image_alt, 'Our classroom');
  assert.ok(!('seo_canonical_url' in (writesTo('about_page')[0].body as object)), 'canonical is never written');
  assert.equal(DB.seo_audit_log.at(-1)?.entity_type, 'about');
});

/* ── Listing ──────────────────────────────────────────────────────────────── */

test('a policy page links to its own record, not just the list of policies', async () => {
  const id = 'dddddddd-0000-4000-8000-000000000001';
  resetDb({ legal_docs: [{ id, slug: 'privacy-policy', title: 'Privacy Policy', status: 'published', intro: 'How we use data.' }] });
  const res = await call('/api/v1/page-seo', { who: 'admin' });
  const pages = res.json.data.pages as Array<Record<string, any>>;
  assert.equal(pages.find((e) => e.storage === 'legal')?.adminPath, `/legal?edit=${id}`);
});

test('the list covers every route-keyed page plus courses and comparisons, with fallbacks', async () => {
  const res = await call('/api/v1/page-seo', { who: 'admin' });
  assert.equal(res.status, 200);
  const pages = res.json.data.pages as Array<Record<string, any>>;
  for (const p of ROUTE_KEYED_PAGES) assert.ok(pages.some((e) => e.path === p.path), p.path);
  const home = pages.find((e) => e.path === '/');
  assert.equal(home.storage, 'page');
  assert.equal(home.fallback.title, 'GloryTecks — IT Training Institute in Ameerpet, Hyderabad');
  assert.equal(home.override, null);

  const landing = pages.find((e) => e.path === '/data-science-course-ameerpet');
  assert.equal(landing.live, true);
  // Ameerpet has the classroom centre, so its landing promises classroom batches there.
  assert.match(landing.fallback.description, /^Data Science course in Ameerpet, Hyderabad, .*classroom batches at the GloryTecks centre near Ameerpet Metro/);
  // A landing whose locality is not in the CMS 404s on the site: no fallback to preview.
  const missing = pages.find((e) => e.path === '/data-science-course-kukatpally');
  assert.equal(missing.live, false);
  assert.equal(missing.fallback, null);

  const course = pages.find((e) => e.path === '/courses/data-science');
  assert.equal(course.storage, 'course');
  assert.equal(course.adminPath, `/courses/${IDS.course}#seo`);
  assert.equal(course.fallback.title, 'Data Science Course in Hyderabad | GloryTecks');

  const cmp = pages.find((e) => e.path === '/compare/power-bi-vs-tableau');
  assert.equal(cmp.effective.title, 'Power BI vs Tableau 2026');
  assert.equal(cmp.effective.description, 'Power BI and Tableau are the two leading business intelligence tools.');
  assert.deepEqual(res.json.data.limits.metaTitle, 120);
});

/* ── Public API ───────────────────────────────────────────────────────────── */

test('the public endpoint serves registry paths only, public fields only', async () => {
  resetDb({
    page_seo: [
      {
        id: 'p1',
        path: '/courses',
        meta_title: 'IT Courses',
        meta_description: null,
        keywords: ['secret keyword'],
        intent_note: 'Internal planning note',
        noindex: false,
        nofollow: false,
        updated_by: SUBJECT.admin,
      },
      { id: 'p2', path: '/removed-page', meta_title: 'Orphan', keywords: [], noindex: false, nofollow: false },
      { id: 'p3', path: '/resources/lms', noindex: true, nofollow: false, keywords: [] },
    ],
  });
  const res = await call('/api/v1/public/page-seo');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.data, {
    '/courses': { metaTitle: 'IT Courses' },
    '/resources/lms': { noindex: true },
  });
  for (const leak of ['secret keyword', 'Internal planning note', SUBJECT.admin, 'Orphan', 'p1']) {
    assert.ok(!res.raw.includes(leak), `public response leaked ${leak}`);
  }
});

test('public course and about responses carry no editorial SEO fields', async () => {
  Object.assign(DB.courses[0], {
    seo_meta_title: 'Data Science Course | GloryTecks',
    seo_keywords: ['competitor keyword list'],
    seo_intent_note: 'Do not publish this note',
    seo_canonical_url: 'https://elsewhere.example/',
  });
  Object.assign(DB.about_page[0], { seo_intent_note: 'About note', seo_keywords: ['about kw'] });
  for (const path of ['/api/v1/public/courses', '/api/v1/public/courses/data-science', '/api/v1/public/about']) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    for (const leak of ['competitor keyword list', 'Do not publish this note', 'elsewhere.example', 'About note', 'about kw']) {
      assert.ok(!res.raw.includes(leak), `${path} leaked ${leak}`);
    }
  }
  const detail = await call('/api/v1/public/courses/data-science');
  assert.equal(detail.json.data.seo.metaTitle, 'Data Science Course | GloryTecks');
});

test('a public course says whether /brochures/<slug>.pdf has a file (hasBrochure)', async () => {
  // The site shows "Download Brochure" only then (2026-11-10): on courses
  // without one the button opened a 404 that Search Console reported.
  const before = DB.courses[0].brochure_url;
  try {
    DB.courses[0].brochure_url = null;
    let detail = await call('/api/v1/public/courses/data-science');
    assert.equal(detail.status, 200, detail.raw);
    assert.equal(detail.json.data.hasBrochure, false);

    DB.courses[0].brochure_url = 'https://res.cloudinary.com/demo/raw/upload/brochure.pdf';
    detail = await call('/api/v1/public/courses/data-science');
    assert.equal(detail.json.data.hasBrochure, true);
  } finally {
    DB.courses[0].brochure_url = before;
  }
});

/* ── Course SEO ───────────────────────────────────────────────────────────── */

test('content writers edit course SEO text; only admins change robots', async () => {
  const text = await call(`/api/v1/courses/${IDS.course}`, {
    method: 'PUT',
    who: 'content_writer',
    body: { seo: { metaTitle: 'Data Science Course in Hyderabad — Classroom & Online', ogImageAlt: 'Students' } },
  });
  assert.equal(text.status, 200, text.raw);
  assert.equal(DB.courses[0].seo_meta_title, 'Data Science Course in Hyderabad — Classroom & Online');
  assert.equal(DB.seo_audit_log.at(-1)?.entity_key, '/courses/data-science');
  assert.equal(DB.seo_audit_log.at(-1)?.editor_id, SUBJECT.content_writer);
  assert.deepEqual(DB.seo_audit_log.at(-1)?.changed_fields, ['metaTitle', 'ogImageAlt']);

  WRITES.length = 0;
  const robots = await call(`/api/v1/courses/${IDS.course}`, {
    method: 'PUT',
    who: 'content_writer',
    body: { seo: { noindex: true } },
  });
  assert.equal(robots.status, 403);
  assert.match(robots.raw, /Only administrators/);
  assert.equal(writesTo('courses').length, 0, 'a refused robots change writes nothing');
  assert.equal(DB.courses[0].seo_noindex, false);

  // Sending the CURRENT robots values back (a full-form save) is not a change.
  const same = await call(`/api/v1/courses/${IDS.course}`, {
    method: 'PUT',
    who: 'content_writer',
    body: { seo: { noindex: false, nofollow: false, metaDescription: 'Desc' } },
  });
  assert.equal(same.status, 200, same.raw);

  const admin = await call(`/api/v1/courses/${IDS.course}`, { method: 'PUT', who: 'admin', body: { seo: { noindex: true } } });
  assert.equal(admin.status, 200, admin.raw);
  assert.equal(DB.courses[0].seo_noindex, true);
});

test('course SEO refuses canonicals, nofollow-without-noindex and unknown keys', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ canonicalUrl: 'https://glorytecks.com/courses/other' }, /Canonical URLs are generated/],
    [{ nofollow: true }, /also hidden from search results/],
    [{ keywordsMeta: 'x' }, /Unexpected SEO field/],
    [{ ogImage: 'http://res.cloudinary.com/x.png' }, /https/],
  ];
  for (const [seo, message] of cases) {
    const res = await call(`/api/v1/courses/${IDS.course}`, { method: 'PUT', who: 'admin', body: { seo } });
    assert.ok(res.status === 422 || res.status === 400, `${JSON.stringify(seo)} → ${res.status}`);
    assert.match(res.raw, message);
  }
  assert.equal(writesTo('courses').length, 0);
});

/* ── Comparisons ──────────────────────────────────────────────────────────── */

test('comparisons store a meta description and audit SEO changes', async () => {
  const res = await call(`/api/v1/comparisons/${IDS.comparison}`, {
    method: 'PUT',
    who: 'admin',
    body: { metaDescription: '  Which BI tool to learn first   in Hyderabad.  ' },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(DB.comparisons[0].meta_description, 'Which BI tool to learn first in Hyderabad.');
  assert.equal(DB.seo_audit_log.at(-1)?.entity_type, 'comparison');
  assert.equal(DB.seo_audit_log.at(-1)?.entity_key, '/compare/power-bi-vs-tableau');
  assert.deepEqual(DB.seo_audit_log.at(-1)?.changed_fields, ['metaDescription']);

  // Clearing it stores '' (the column is NOT NULL), meaning "derive from the intro".
  const cleared = await call(`/api/v1/comparisons/${IDS.comparison}`, { method: 'PUT', who: 'admin', body: { metaDescription: '   ' } });
  assert.equal(cleared.status, 200, cleared.raw);
  assert.equal(DB.comparisons[0].meta_description, '');
});

/* ── Cache invalidation mapping ───────────────────────────────────────────── */

test('publish-time invalidation: page SEO and course SEO map to the narrowest tags', () => {
  assert.deepEqual(siteTagsForChange('page-seo', { before: null, after: { path: '/' } }), ['page-seo']);
  assert.deepEqual(siteTagsForChange('page-seo', { before: { path: '/' }, after: null }), ['page-seo']);
  const course = { slug: 'data-science', status: 'published', title: 'Data Science', seo: { metaTitle: 'A', noindex: false } };
  // SEO text only → that course page only (not every page's header).
  assert.deepEqual(siteTagsForChange('courses', { before: course, after: { ...course, seo: { metaTitle: 'B', noindex: false } } }), ['course:data-science']);
  // Robots change → courses.xml must change too. It carries `course-index`
  // (2026-11-09), so the course lists refresh, not every page.
  assert.deepEqual(
    siteTagsForChange('courses', { before: course, after: { ...course, seo: { metaTitle: 'A', noindex: true } } }),
    ['course-index', 'course:data-science'],
  );
  // Any non-SEO field → the resource-wide tag as before.
  assert.deepEqual(siteTagsForChange('courses', { before: course, after: { ...course, title: 'DS' } }), ['courses', 'course:data-science']);
});

test('every page_seo path is a route-keyed page and /about is not stored in page_seo', () => {
  assert.equal(PAGE_SEO_PATHS.length, ROUTE_KEYED_PAGES.length - 1);
  assert.ok(!PAGE_SEO_PATHS.includes('/about'));
  for (const p of PAGE_SEO_PATHS) assert.match(p, /^\/$|^(\/[a-z0-9]+(-[a-z0-9]+)*)+$/, p);
  assert.equal(new Set(PAGE_SEO_PATHS).size, PAGE_SEO_PATHS.length, 'no duplicate route keys');
});
