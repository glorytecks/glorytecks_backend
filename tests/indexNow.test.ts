import './setup';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEXNOW_ENDPOINT,
  MAX_URLS_PER_REQUEST,
  buildIndexNowPayload,
  indexNowConfigProblem,
  normalizeIndexNowUrls,
  resetIndexNowState,
  submitToIndexNow,
} from '../src/lib/indexNow';
import {
  indexNowPathsForChange,
  notifyIndexNow,
  resetIndexNowDedupe,
  type LandingDeps,
} from '../src/lib/indexNowChanges';
import { invalidateResource } from '../src/lib/cacheInvalidation';

/**
 * IndexNow (2026-10-26).
 *
 *  • Only canonical https URLs of glorytecks.com are ever sent, deduplicated,
 *    in batches of at most 10,000.
 *  • Only public pages are submitted; a page that stops being public is
 *    submitted once under its old URL; draft edits and non-visible fields
 *    submit nothing.
 *  • Failure of any kind never throws and never fails the CMS write.
 */

const KEY = '0b6ae579dfc845a1998ddd3541f6e985';
const ORIGIN = 'https://glorytecks.com';

afterEach(() => {
  resetIndexNowState();
  resetIndexNowDedupe();
  process.env.INDEXNOW_KEY = '';
});

const published = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, status: 'published', ...extra });
const draft = (slug: string) => ({ slug, status: 'draft' });

const ok = (status = 200, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

interface Call {
  url: string;
  init: RequestInit;
}
function recordingFetch(responder: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/* ── Configuration ───────────────────────────────────────────────────────── */

test('the key must be set and in the protocol format', () => {
  assert.equal(indexNowConfigProblem(KEY), null);
  assert.match(indexNowConfigProblem('') ?? '', /not set/);
  assert.match(indexNowConfigProblem('short') ?? '', /8-128/);
  assert.match(indexNowConfigProblem('has spaces in it!') ?? '', /8-128/);
  assert.match(indexNowConfigProblem('a'.repeat(129)) ?? '', /8-128/);
});

test('without a key nothing is sent', async () => {
  const { calls, fetchImpl } = recordingFetch(() => ok());
  const r = await submitToIndexNow([`${ORIGIN}/blog/a`], { key: '', fetchImpl });
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0);
});

/* ── URL validation and normalisation ────────────────────────────────────── */

test('only canonical https URLs of the site pass', () => {
  const { urls, rejected } = normalizeIndexNowUrls([
    `${ORIGIN}/blog/a`,
    'https://evil.example/blog/a',
    'https://www.glorytecks.com/blog/a',
    'http://glorytecks.com/blog/a',
    'https://glorytecks.com.evil.example/blog/a',
    'https://user:pw@glorytecks.com/blog/a',
    `${ORIGIN}/blog/a?utm_source=x`,
    `${ORIGIN}/blog/a#top`,
    'javascript:alert(1)',
    '/blog/relative',
    'not a url',
    '',
  ]);
  assert.deepEqual(urls, [`${ORIGIN}/blog/a`]);
  assert.equal(rejected.length, 11);
});

test('URLs are deduplicated and put in the site canonical form', () => {
  const { urls } = normalizeIndexNowUrls([
    `${ORIGIN}/courses/x/`,
    `${ORIGIN}/courses/x`,
    `${ORIGIN}//courses//x`,
    `${ORIGIN}/`,
    ORIGIN,
  ]);
  assert.deepEqual(urls, [`${ORIGIN}/courses/x`, ORIGIN]);
});

/* ── Payload and delivery ────────────────────────────────────────────────── */

test('the payload carries host, key, keyLocation and the URL list', () => {
  assert.deepEqual(buildIndexNowPayload(KEY, [`${ORIGIN}/blog/a`]), {
    host: 'glorytecks.com',
    key: KEY,
    keyLocation: `${ORIGIN}/${KEY}.txt`,
    urlList: [`${ORIGIN}/blog/a`],
  });
});

test('a submission is one JSON POST to the IndexNow endpoint', async () => {
  const { calls, fetchImpl } = recordingFetch(() => ok(200));
  const r = await submitToIndexNow([`${ORIGIN}/courses/a`, `${ORIGIN}/courses/a`], { key: KEY, fetchImpl });
  assert.deepEqual(r, { status: 'sent', submitted: 1, batches: 1, httpStatus: [200] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, INDEXNOW_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(
    (calls[0].init.headers as Record<string, string>)['Content-Type'],
    'application/json; charset=utf-8',
  );
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    host: 'glorytecks.com',
    key: KEY,
    keyLocation: `${ORIGIN}/${KEY}.txt`,
    urlList: [`${ORIGIN}/courses/a`],
  });
});

test('202 Accepted counts as submitted', async () => {
  const { fetchImpl } = recordingFetch(() => ok(202));
  const r = await submitToIndexNow([`${ORIGIN}/blog/a`], { key: KEY, fetchImpl });
  assert.equal(r.status, 'sent');
});

test('large lists are split and no request exceeds the 10,000-URL limit', async () => {
  assert.equal(MAX_URLS_PER_REQUEST, 10_000);
  const many = Array.from({ length: 25_001 }, (_, i) => `${ORIGIN}/blog/post-${i}`);
  const { calls, fetchImpl } = recordingFetch(() => ok());
  const r = await submitToIndexNow(many, { key: KEY, fetchImpl });
  assert.equal(r.status, 'sent');
  const sizes = calls.map((c) => JSON.parse(String(c.init.body)).urlList.length);
  assert.deepEqual(sizes, [10_000, 10_000, 5_001]);
});

test('a rejected key (403) fails once and stops the remaining batches', async () => {
  const urls = ['a', 'b', 'c'].map((s) => `${ORIGIN}/blog/${s}`);
  const { calls, fetchImpl } = recordingFetch(() => ok(403));
  const r = await submitToIndexNow(urls, { key: KEY, fetchImpl, batchSize: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(calls.length, 1);
  // The key itself never appears in the diagnostic.
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('a 429 pauses submissions for the time the engine asked', async () => {
  let clock = 1_000_000;
  const { calls, fetchImpl } = recordingFetch(() => ok(429, { 'retry-after': '30' }));
  const first = await submitToIndexNow([`${ORIGIN}/blog/a`], { key: KEY, fetchImpl, now: () => clock });
  assert.equal(first.status, 'failed');
  assert.match((first as { reason: string }).reason, /rate limited.*30 s/);

  clock += 10_000;
  const during = await submitToIndexNow([`${ORIGIN}/blog/b`], { key: KEY, fetchImpl, now: () => clock });
  assert.equal(during.status, 'skipped');
  assert.equal(calls.length, 1);

  clock += 25_000;
  const after = await submitToIndexNow([`${ORIGIN}/blog/c`], { key: KEY, fetchImpl, now: () => clock });
  assert.equal(after.status, 'failed');
  assert.equal(calls.length, 2);
});

test('a 5xx, a network error and a timeout are all reported, not thrown', async () => {
  const five = recordingFetch(() => ok(503));
  assert.equal((await submitToIndexNow([`${ORIGIN}/blog/a`], { key: KEY, fetchImpl: five.fetchImpl })).status, 'failed');

  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const net = await submitToIndexNow([`${ORIGIN}/blog/a`], { key: KEY, fetchImpl: down });
  assert.deepEqual(net.status === 'failed' && net.reason, 'network error');

  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
  const slow = await submitToIndexNow([`${ORIGIN}/blog/a`], { key: KEY, fetchImpl: hang, timeoutMs: 20 });
  assert.match(slow.status === 'failed' ? slow.reason : '', /timed out after 20 ms/);
});

/* ── Which URLs a change submits ─────────────────────────────────────────── */

const noLandings: LandingDeps = { coursePublished: async () => false, localityActive: async () => false };
const allLive: LandingDeps = { coursePublished: async () => true, localityActive: async () => true };
const paths = (resource: string, change: Parameters<typeof indexNowPathsForChange>[1], deps = noLandings) =>
  indexNowPathsForChange(resource, change, deps);

test('an unpublished course is never submitted as a public URL', async () => {
  assert.deepEqual(await paths('courses', { before: null, after: draft('data-science') }), { updated: [], removed: [] });
  assert.deepEqual(await paths('courses', { before: draft('c'), after: draft('c') }), { updated: [], removed: [] });
  assert.deepEqual(
    await paths('courses', { before: null, after: { slug: 'c', status: 'archived' } }),
    { updated: [], removed: [] },
  );
});

test('publishing a course submits its page', async () => {
  assert.deepEqual(await paths('courses', { before: draft('c'), after: published('c') }), {
    updated: ['/courses/c'],
    removed: [],
  });
  assert.deepEqual(await paths('courses', { before: null, after: published('c') }), {
    updated: ['/courses/c'],
    removed: [],
  });
});

test('archiving, unpublishing or deleting a public course submits its old URL as removed', async () => {
  const gone = { updated: [], removed: ['/courses/c'] };
  assert.deepEqual(await paths('courses', { before: published('c'), after: { slug: 'c', status: 'archived' } }), gone);
  assert.deepEqual(await paths('courses', { before: published('c'), after: draft('c') }), gone);
  assert.deepEqual(await paths('courses', { before: published('c'), after: null }), gone);
  // A published course hidden from search is no longer an indexable page either.
  assert.deepEqual(
    await paths('courses', { before: published('c'), after: published('c', { seo: { noindex: true } }) }),
    gone,
  );
});

test('renaming a public course submits the new URL and the old one as removed', async () => {
  assert.deepEqual(await paths('courses', { before: published('old'), after: published('new') }), {
    updated: ['/courses/new'],
    removed: ['/courses/old'],
  });
});

test('editing a public course submits it only when something visible changed', async () => {
  const before = published('c', { title: 'T', seo: { metaTitle: 'M', keywords: ['a'], intentNote: 'n' }, updatedAt: '1' });
  // Timestamps, SEO keywords and the editor's note are not visible.
  const internal = { ...before, updatedAt: '2', seo: { metaTitle: 'M', keywords: ['b'], intentNote: 'other' } };
  assert.deepEqual(await paths('courses', { before, after: internal }), { updated: [], removed: [] });
  assert.deepEqual(await paths('courses', { before, after: { ...before, title: 'T2' } }), {
    updated: ['/courses/c'],
    removed: [],
  });
  assert.deepEqual(
    await paths('courses', { before, after: { ...before, seo: { ...before.seo, metaTitle: 'New' } } }),
    { updated: ['/courses/c'], removed: [] },
  );
});

test('blog posts, comparisons and policy pages map to their own URLs', async () => {
  assert.deepEqual((await paths('blogs', { before: draft('p'), after: published('p') })).updated, ['/blog/p']);
  assert.deepEqual((await paths('blogs', { before: published('p'), after: null })).removed, ['/blog/p']);
  assert.deepEqual((await paths('blogs', { before: null, after: draft('p') })).updated, []);
  assert.deepEqual((await paths('comparisons', { before: null, after: published('a-vs-b') })).updated, ['/compare/a-vs-b']);
  assert.deepEqual((await paths('legal', { before: null, after: published('terms') })).updated, ['/terms']);
  // A legal row whose slug is not a routed page is not a page.
  assert.deepEqual((await paths('legal', { before: null, after: published('internal-memo') })).updated, []);
});

test('slugs that are not valid path segments are never submitted', async () => {
  for (const slug of ['../admin', 'a b', 'A/B', '', '-x']) {
    assert.deepEqual(await paths('blogs', { before: null, after: published(slug) }), { updated: [], removed: [] }, slug);
  }
});

test('a write without a change record (a bulk script) submits nothing', async () => {
  for (const r of ['blogs', 'courses', 'comparisons', 'legal', 'localities', 'page-seo']) {
    assert.deepEqual(await paths(r, undefined), { updated: [], removed: [] }, r);
  }
});

test('resources with no public page of their own submit nothing', async () => {
  for (const r of ['trainers', 'testimonials', 'settings', 'categories', 'authors', 'faqs', 'enquiries']) {
    assert.deepEqual(await paths(r, { before: null, after: { slug: 'x', status: 'published', isActive: true } }), {
      updated: [],
      removed: [],
    }, r);
  }
});

test('the About page is submitted at its fixed URL', async () => {
  assert.deepEqual(await paths('about', undefined), { updated: ['/about'], removed: [] });
});

test('a course change also submits the landings that use it, when the locality is live', async () => {
  const ds = await paths('courses', { before: draft('data-science'), after: published('data-science') }, allLive);
  assert.ok(ds.updated.includes('/courses/data-science'));
  assert.ok(ds.updated.includes('/data-science-course-ameerpet'));
  assert.ok(ds.updated.includes('/data-science-course-kukatpally'));
  assert.equal(ds.updated.filter((p) => p.endsWith('/data-science-course-ameerpet')).length, 1);

  // The landing 404s without its locality, so it is not submitted.
  const noLocality = await paths('courses', { before: draft('data-science'), after: published('data-science') });
  assert.deepEqual(noLocality.updated, ['/courses/data-science']);

  // Unpublishing the course takes its landings down.
  const off = await paths('courses', { before: published('mlops'), after: draft('mlops') }, allLive);
  assert.deepEqual(off.removed.sort(), ['/courses/mlops', '/mlops-course-ameerpet']);

  // An SEO-text-only edit does not touch the landings.
  const seoOnly = await paths(
    'courses',
    { before: published('mlops', { seo: { metaTitle: 'a' } }), after: published('mlops', { seo: { metaTitle: 'b' } }) },
    allLive,
  );
  assert.deepEqual(seoOnly.updated, ['/courses/mlops']);
});

test('a locality change submits its landings, when the course is live', async () => {
  const loc = (extra: Record<string, unknown> = {}) => ({ slug: 'madhapur', isActive: true, ...extra });
  const edited = await paths('localities', { before: loc({ intro: 'a' }), after: loc({ intro: 'b' }) }, allLive);
  assert.deepEqual(edited.updated.sort(), ['/data-science-course-madhapur', '/generative-ai-course-madhapur']);

  const unchanged = await paths('localities', { before: loc(), after: loc() }, allLive);
  assert.deepEqual(unchanged.updated, []);

  const off = await paths('localities', { before: loc(), after: loc({ isActive: false }) }, allLive);
  assert.deepEqual(off.removed.sort(), ['/data-science-course-madhapur', '/generative-ai-course-madhapur']);

  const noCourse = await paths('localities', { before: loc({ intro: 'a' }), after: loc({ intro: 'b' }) });
  assert.deepEqual(noCourse.updated, []);
});

test('a page-seo change submits that page, or removes it when it is set to noindex', async () => {
  const row = (extra: Record<string, unknown> = {}) => ({ path: '/contact', noindex: false, ...extra });
  assert.deepEqual(
    await paths('page-seo', { before: row({ metaTitle: 'a' }), after: row({ metaTitle: 'b' }) }),
    { updated: ['/contact'], removed: [] },
  );
  assert.deepEqual(await paths('page-seo', { before: null, after: row({ noindex: true }) }), {
    updated: [],
    removed: ['/contact'],
  });
  // Already hidden before and after: nothing public changed.
  assert.deepEqual(
    await paths('page-seo', { before: row({ noindex: true, metaTitle: 'a' }), after: row({ noindex: true, metaTitle: 'b' }) }),
    { updated: [], removed: [] },
  );
  // Editor-only fields are not a visible change.
  assert.deepEqual(
    await paths('page-seo', { before: row({ keywords: ['a'] }), after: row({ keywords: ['b'] }) }),
    { updated: [], removed: [] },
  );
  // A path outside the registry is ignored.
  assert.deepEqual(await paths('page-seo', { before: null, after: { path: '/admin', metaTitle: 'x' } }), {
    updated: [],
    removed: [],
  });
});

test('a landing page-seo change needs the landing to be live', async () => {
  const after = { path: '/mlops-course-ameerpet', metaTitle: 'x', noindex: false };
  assert.deepEqual((await paths('page-seo', { before: null, after })).updated, []);
  assert.deepEqual((await paths('page-seo', { before: null, after }, allLive)).updated, ['/mlops-course-ameerpet']);
});

/* ── Delivery from a write ───────────────────────────────────────────────── */

test('a successful publication submits the absolute canonical URL', async () => {
  const submitted: string[][] = [];
  const result = await notifyIndexNow(
    'blogs',
    { before: draft('p'), after: published('p') },
    { key: KEY, deps: noLandings, submit: async (u) => (submitted.push(u), { status: 'sent', submitted: u.length, batches: 1, httpStatus: [200] }) },
  );
  assert.equal(result.status, 'sent');
  assert.deepEqual(submitted, [[`${ORIGIN}/blog/p`]]);
});

test('a draft saved as a draft submits nothing', async () => {
  let called = false;
  const result = await notifyIndexNow(
    'courses',
    { before: draft('c'), after: draft('c') },
    { key: KEY, deps: noLandings, submit: async () => ((called = true), { status: 'sent', submitted: 0, batches: 0, httpStatus: [] }) },
  );
  assert.equal(result.status, 'skipped');
  assert.equal(called, false);
});

test('the same publication processed twice is submitted once', async () => {
  let calls = 0;
  const submit = async (u: string[]) => (calls++, { status: 'sent' as const, submitted: u.length, batches: 1, httpStatus: [200] });
  const change = { before: draft('p'), after: published('p') };
  await notifyIndexNow('blogs', change, { key: KEY, deps: noLandings, submit });
  const second = await notifyIndexNow('blogs', change, { key: KEY, deps: noLandings, submit });
  assert.equal(calls, 1);
  assert.equal(second.status, 'skipped');

  // Unpublishing right afterwards is a different event and still goes out.
  await notifyIndexNow('blogs', { before: published('p'), after: draft('p') }, { key: KEY, deps: noLandings, submit });
  assert.equal(calls, 2);
});

test('a failed submission is not remembered, so the next change retries it', async () => {
  let calls = 0;
  const failing = async () => (calls++, { status: 'failed' as const, reason: 'HTTP 503', submitted: 0, batches: 1, httpStatus: [503] });
  const change = { before: draft('p'), after: published('p') };
  await notifyIndexNow('blogs', change, { key: KEY, deps: noLandings, submit: failing });
  await notifyIndexNow('blogs', change, { key: KEY, deps: noLandings, submit: failing });
  assert.equal(calls, 2);
});

test('an IndexNow failure never rejects, even if the submitter throws', async () => {
  const result = await notifyIndexNow(
    'blogs',
    { before: draft('p'), after: published('p') },
    { key: KEY, deps: noLandings, submit: async () => { throw new Error('boom'); } },
  );
  assert.equal(result.status, 'failed');
});

test('invalidateResource still resolves when IndexNow is down, and submits after the write', async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(String(url));
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  process.env.INDEXNOW_KEY = KEY;
  try {
    await assert.doesNotReject(
      invalidateResource('blogs', { before: draft('indexnow-test'), after: published('indexnow-test') }),
    );
    assert.deepEqual(seen, [INDEXNOW_ENDPOINT]);

    // And a draft edit calls nobody.
    seen.length = 0;
    await invalidateResource('blogs', { before: draft('indexnow-draft'), after: draft('indexnow-draft') });
    assert.deepEqual(seen, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
