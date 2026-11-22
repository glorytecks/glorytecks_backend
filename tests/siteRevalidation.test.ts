import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  notifySite,
  siteTagsForChange,
  webhookConfigProblem,
} from '../src/lib/siteRevalidation';
import { invalidateResource } from '../src/lib/cacheInvalidation';

/**
 * Backend → site revalidation (A3, 2026-10-15).
 *
 *  • Only a change a visitor can see notifies the site, and only with the tags
 *    that change touches.
 *  • Delivery never throws, retries once on a transient failure, and never
 *    puts the secret in a log line or result.
 */

const SECRET = 's'.repeat(40);
const URL_OK = 'https://site.example/api/revalidate';

const published = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, status: 'published', ...extra });
const draft = (slug: string) => ({ slug, status: 'draft' });

/* ── Mapping ─────────────────────────────────────────────────────────────── */

test('saving a never-published draft does not notify the site', () => {
  assert.deepEqual(siteTagsForChange('blogs', { before: null, after: draft('new-post') }), []);
  assert.deepEqual(siteTagsForChange('blogs', { before: draft('p'), after: draft('p') }), []);
  assert.deepEqual(siteTagsForChange('courses', { before: draft('c'), after: draft('c') }), []);
  assert.deepEqual(siteTagsForChange('legal', { before: draft('terms'), after: draft('terms') }), []);
  assert.deepEqual(siteTagsForChange('comparisons', { before: null, after: draft('a-vs-b') }), []);
});

test('publishing, editing a published record and unpublishing all notify', () => {
  // A publish or a card edit at the same URL refreshes the archive (`blog-index`)
  // and the post, not every page: the footer and article sidebars list titles
  // on every page and catch up on their own timer (2026-11-09).
  assert.deepEqual(siteTagsForChange('blogs', { before: draft('p'), after: published('p') }), ['blog-index', 'blog:p']);
  assert.deepEqual(siteTagsForChange('blogs', { before: null, after: published('p') }), ['blog-index', 'blog:p']);
  assert.deepEqual(
    siteTagsForChange('blogs', { before: published('p', { title: 'Old' }), after: published('p', { title: 'New' }) }),
    ['blog-index', 'blog:p'],
  );
  // Unpublishing must refresh the page so it starts returning 404, and every
  // list that may still link to it (`blogs`).
  assert.deepEqual(siteTagsForChange('blogs', { before: published('p'), after: draft('p') }), ['blogs', 'blog:p']);
  assert.deepEqual(siteTagsForChange('blogs', { before: published('p'), after: null }), ['blogs', 'blog:p']);
  // So must a slug change: the old URL becomes a 404.
  assert.deepEqual(
    siteTagsForChange('blogs', { before: published('old-slug'), after: published('new-slug') }),
    ['blogs', 'blog:old-slug', 'blog:new-slug'],
  );
});

test('a body-only edit to a published post refreshes that post only', () => {
  const before = published('p', { title: 'T', excerpt: 'E', updated: '2026-10-01', html: '<p>old</p>', content: [{ text: 'old' }] });
  const after = { ...before, html: '<p>new</p>', content: [{ text: 'new' }], toc: [], faqs: [] };
  assert.deepEqual(siteTagsForChange('blogs', { before, after }), ['blog:p']);
  // Anything a card shows (or the sitemap's lastmod) widens it to the archive.
  for (const field of ['title', 'excerpt', 'featuredImage', 'updated', 'date', 'trending', 'popular', 'authorKey', 'tags']) {
    assert.deepEqual(
      siteTagsForChange('blogs', { before, after: { ...after, [field]: 'changed' } }),
      ['blog-index', 'blog:p'],
      field,
    );
  }
  // Courses split differently (A4): only an SEO-text-only save is narrow;
  // any other field the course list carries refreshes every list.
  assert.deepEqual(
    siteTagsForChange('courses', { before: published('c', { title: 'A' }), after: published('c', { title: 'B' }) }),
    ['courses', 'course:c'],
  );
  assert.deepEqual(
    siteTagsForChange('courses', {
      before: published('c', { seo: { metaTitle: 'A' } }),
      after: published('c', { seo: { metaTitle: 'B' } }),
    }),
    ['course:c'],
  );
});

test('a course edit that only its own page shows refreshes that course alone', () => {
  const tags = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    siteTagsForChange('courses', { before: published('c', before), after: published('c', after) });

  // Detail fields, and the timestamp every save bumps: the course page and its landings only.
  for (const field of ['syllabus', 'faqs', 'fees', 'placement', 'skills', 'images', 'bannerImage', 'brochureUrl', 'trainer']) {
    assert.deepEqual(tags({ [field]: 'a', updatedAt: '1' }, { [field]: 'b', updatedAt: '2' }), ['course:c'], field);
  }
  assert.deepEqual(
    tags({ syllabus: ['a'], seo: { metaTitle: 'A' } }, { syllabus: ['b'], seo: { metaTitle: 'B' } }),
    ['course:c'],
  );

  // What a card shows refreshes the course lists (`course-index`), not every
  // page, while the URL and the header menu stay the same (2026-11-09).
  for (const field of ['tagline', 'duration', 'modules', 'tools', 'projects', 'description', 'featured', 'order', 'createdAt']) {
    assert.deepEqual(tags({ [field]: 'a', syllabus: ['a'] }, { [field]: 'b', syllabus: ['b'] }), ['course-index', 'course:c'], field);
  }
  // The menu is on every page: its label, group, membership and order are site-wide.
  // (published() has no showInNav, which the site reads as "in the menu".)
  for (const field of ['title', 'category', 'showInNav', 'navOrder']) {
    assert.deepEqual(tags({ [field]: 'a', syllabus: ['a'] }, { [field]: 'b', syllabus: ['b'] }), ['courses', 'course:c'], field);
  }
  // …but a course outside the menu can be renamed or recategorised cheaply.
  assert.deepEqual(
    tags({ showInNav: false, title: 'A', category: 'X' }, { showInNav: false, title: 'B', category: 'Y' }),
    ['course-index', 'course:c'],
  );
  // Entering or leaving the menu is site-wide.
  assert.deepEqual(tags({ showInNav: false }, { showInNav: true, navOrder: 3 }), ['courses', 'course:c']);
  assert.deepEqual(tags({ showInNav: true, navOrder: 3 }, { showInNav: false, navOrder: 3 }), ['courses', 'course:c']);
  // A robots change moves the course in or out of courses.xml, which carries `course-index`.
  assert.deepEqual(tags({ seo: { noindex: false } }, { seo: { noindex: true } }), ['course-index', 'course:c']);
  // A field this module does not know about is treated as site-wide.
  assert.deepEqual(tags({ someNewColumn: 1 }, { someNewColumn: 2 }), ['courses', 'course:c']);
  assert.deepEqual(tags({ showInNav: false, someNewColumn: 1 }, { showInNav: false, someNewColumn: 2 }), ['courses', 'course:c']);
});

test('publishing a course refreshes the course lists, or every page when it joins the menu', () => {
  const archived = (extra: Record<string, unknown> = {}) => ({ slug: 'c', status: 'archived', ...extra });
  // Outside the menu: the lists and its own page only.
  assert.deepEqual(
    siteTagsForChange('courses', { before: archived({ showInNav: false }), after: published('c', { showInNav: false }) }),
    ['course-index', 'course:c'],
  );
  // In the menu (the column defaults to true): every page shows it.
  assert.deepEqual(siteTagsForChange('courses', { before: archived(), after: published('c') }), ['courses', 'course:c']);
  // Leaving public view is always site-wide: links to it are on every page.
  assert.deepEqual(
    siteTagsForChange('courses', { before: published('c', { showInNav: false }), after: archived({ showInNav: false }) }),
    ['courses', 'course:c'],
  );
  assert.deepEqual(siteTagsForChange('courses', { before: published('c', { showInNav: false }), after: null }), ['courses', 'course:c']);
});

test('a rename refreshes the old and the new slug', () => {
  assert.deepEqual(
    siteTagsForChange('courses', { before: published('old-name'), after: published('new-name') }),
    ['courses', 'course:old-name', 'course:new-name'],
  );
});

test('a comparison publish or same-URL edit refreshes /compare and its page, not every page', () => {
  // The footer's comparison links and the related-comparison blocks are on
  // nearly every page and carry only `comparisons` (2026-11-12).
  assert.deepEqual(siteTagsForChange('comparisons', { before: draft('a-vs-b'), after: published('a-vs-b') }), ['comparison-index', 'comparison:a-vs-b']);
  assert.deepEqual(siteTagsForChange('comparisons', { before: null, after: published('a-vs-b') }), ['comparison-index', 'comparison:a-vs-b']);
  assert.deepEqual(
    siteTagsForChange('comparisons', {
      before: published('a-vs-b', { itemA: 'A', verdict: 'old' }),
      after: published('a-vs-b', { itemA: 'A2', verdict: 'new' }),
    }),
    ['comparison-index', 'comparison:a-vs-b'],
  );
  // Leaving the URL is site-wide, so no page keeps a link to a 404.
  assert.deepEqual(siteTagsForChange('comparisons', { before: published('a-vs-b'), after: draft('a-vs-b') }), ['comparisons', 'comparison:a-vs-b']);
  assert.deepEqual(siteTagsForChange('comparisons', { before: published('a-vs-b'), after: null }), ['comparisons', 'comparison:a-vs-b']);
  assert.deepEqual(
    siteTagsForChange('comparisons', { before: published('a-vs-b'), after: published('a-vs-c') }),
    ['comparisons', 'comparison:a-vs-b', 'comparison:a-vs-c'],
  );
  // An unsafe slug is dropped, not forwarded.
  assert.deepEqual(siteTagsForChange('comparisons', { after: published('../x') }), ['comparison-index']);
});

test('each slugged resource maps to its own entity tag', () => {
  const doc = { before: null, after: published('x') };
  assert.deepEqual(siteTagsForChange('comparisons', doc), ['comparison-index', 'comparison:x']);
  assert.deepEqual(siteTagsForChange('legal', doc), ['legal', 'legal:x']);
  assert.deepEqual(siteTagsForChange('localities', { after: { slug: 'ameerpet' } }), ['localities', 'locality:ameerpet']);
});

test('isActive resources: an inactive record saved again does not notify', () => {
  assert.deepEqual(siteTagsForChange('testimonials', { before: { isActive: false }, after: { isActive: false } }), []);
  assert.deepEqual(siteTagsForChange('testimonials', { before: { isActive: true }, after: { isActive: false } }), ['marketing']);
  assert.deepEqual(siteTagsForChange('trainers', { after: { isActive: true } }), ['people']);
  assert.deepEqual(siteTagsForChange('localities', { before: { slug: 'x', isActive: false }, after: { slug: 'x', isActive: false } }), []);
});

test('leads, brochures and unknown resources never notify', () => {
  for (const r of ['enquiries', 'demo-requests', 'brochures', 'course-categories', 'admins', 'nope']) {
    assert.deepEqual(siteTagsForChange(r, { before: null, after: { isActive: true } }), [], r);
  }
});

test('a brochure change refreshes only its course page, which shows the Download Brochure button', () => {
  assert.deepEqual(
    siteTagsForChange('brochures', { before: null, after: { courseSlug: 'Tableau', isActive: true } }),
    ['course:tableau'],
  );
  // Deactivated or deleted: the button must go too.
  assert.deepEqual(
    siteTagsForChange('brochures', { before: { courseSlug: 'tableau', isActive: true }, after: { courseSlug: 'tableau', isActive: false } }),
    ['course:tableau'],
  );
  assert.deepEqual(siteTagsForChange('brochures', { before: { courseSlug: 'tableau' }, after: null }), ['course:tableau']);
  // Moved to another course: both pages.
  assert.deepEqual(
    siteTagsForChange('brochures', { before: { courseSlug: 'tableau' }, after: { courseSlug: 'power-bi' } }),
    ['course:tableau', 'course:power-bi'],
  );
  // No change context (bulk scripts) or no usable slug: nothing.
  assert.deepEqual(siteTagsForChange('brochures'), []);
  assert.deepEqual(siteTagsForChange('brochures', { after: { courseSlug: '../x' } }), []);
});

test('singletons and bulk scripts (no change context) get the resource-wide tags only', () => {
  assert.deepEqual(siteTagsForChange('settings'), ['settings']);
  assert.deepEqual(siteTagsForChange('about'), ['about']);
  assert.deepEqual(siteTagsForChange('blogs'), ['blogs']);
});

test('a slug that is not a safe tag is dropped, not forwarded', () => {
  assert.deepEqual(
    siteTagsForChange('blogs', { after: published('../../etc?x=1') }),
    ['blog-index'],
  );
  assert.deepEqual(
    siteTagsForChange('blogs', { before: published('../../etc?x=1'), after: null }),
    ['blogs'],
  );
});

test('every tag the backend can emit is accepted by the site endpoint', () => {
  // Mirrors main-website/lib/api/client.ts CACHE_TAGS + ENTITY_TAG_PREFIXES.
  const client = readFileSync(path.join(__dirname, '../../main-website/lib/api/client.ts'), 'utf8');
  const tagBlock = client.slice(client.indexOf('export const CACHE_TAGS'), client.indexOf('} as const', client.indexOf('export const CACHE_TAGS')));
  const siteTags = new Set([...tagBlock.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]));
  const prefixBlock = client.slice(client.indexOf('export const ENTITY_TAG_PREFIXES'));
  const prefixes = new Set([...prefixBlock.slice(0, prefixBlock.indexOf(']')).matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(siteTags.size >= 9 && prefixes.size >= 5, 'could not read the site tag list');

  const resources = ['blogs', 'courses', 'comparisons', 'legal', 'localities', 'categories', 'authors', 'trainers',
    'testimonials', 'placements', 'companies', 'roadmaps', 'faqs', 'gallery', 'batches', 'settings', 'about', 'page-seo'];
  // Publishes (in and out of the course menu), card edits, body edits and removals,
  // so every narrow tag (blog-index, course-index, comparison-index) is checked too.
  const changes = [
    { before: null, after: published('slug-1', { isActive: true }) },
    { before: null, after: published('slug-1', { isActive: true, showInNav: false }) },
    { before: published('slug-1', { isActive: true, title: 'A' }), after: published('slug-1', { isActive: true, title: 'B' }) },
    { before: published('slug-1', { isActive: true, showInNav: false, tagline: 'A' }), after: published('slug-1', { isActive: true, showInNav: false, tagline: 'B' }) },
    { before: published('slug-1', { isActive: true, html: 'a' }), after: published('slug-1', { isActive: true, html: 'b' }) },
    { before: published('slug-1', { isActive: true }), after: null },
  ];
  const emitted = new Set<string>();
  for (const r of resources) {
    for (const change of changes) {
      for (const tag of siteTagsForChange(r, change)) {
        emitted.add(tag);
        const [prefix, slug] = tag.split(':');
        assert.ok(slug ? prefixes.has(prefix) : siteTags.has(tag), `${r} emits "${tag}", which the site would reject`);
      }
    }
  }
  assert.ok(
    emitted.has('blog-index') && emitted.has('course-index') && emitted.has('comparison-index'),
    'the narrow tags were not exercised',
  );
});

/* ── Delivery ────────────────────────────────────────────────────────────── */

type Call = { url: string; init: RequestInit };
function fakeFetch(statuses: Array<number | 'throw'>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (s === 'throw') throw new TypeError('fetch failed');
    return new Response('{}', { status: s });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test('configuration is refused unless https (or localhost) and a 32+ char secret', () => {
  assert.match(webhookConfigProblem('', SECRET) ?? '', /not set/);
  assert.match(webhookConfigProblem('not a url', SECRET) ?? '', /valid URL/);
  assert.match(webhookConfigProblem('http://site.example/api/revalidate', SECRET) ?? '', /https/);
  assert.equal(webhookConfigProblem('http://localhost:3100/api/revalidate', SECRET), null);
  assert.match(webhookConfigProblem(URL_OK, 'short') ?? '', /32 characters/);
  assert.equal(webhookConfigProblem(URL_OK, SECRET), null);
  // The secret is never part of the message.
  assert.ok(!(webhookConfigProblem(URL_OK, 'short-secret-value') ?? '').includes('short-secret-value'));
});

test('sends the tags with a bearer secret, in the body only as tags', async () => {
  const f = fakeFetch([200]);
  const r = await notifySite(['blogs', 'blog:p'], { url: URL_OK, secret: SECRET, fetchImpl: f.impl });
  assert.deepEqual(r, { status: 'sent', httpStatus: 200, attempts: 1 });
  assert.equal(f.calls.length, 1);
  const { init } = f.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(init.body as string), { tags: ['blogs', 'blog:p'] });
});

test('nothing is sent when there is nothing to refresh or it is unconfigured', async () => {
  const f = fakeFetch([200]);
  assert.equal((await notifySite([], { url: URL_OK, secret: SECRET, fetchImpl: f.impl })).status, 'skipped');
  assert.equal((await notifySite(['blogs'], { url: '', secret: SECRET, fetchImpl: f.impl })).status, 'skipped');
  assert.equal((await notifySite(['blogs'], { url: URL_OK, secret: 'weak', fetchImpl: f.impl })).status, 'skipped');
  assert.equal(f.calls.length, 0);
});

test('retries once on 5xx, 429 or a network error; never on 4xx', async () => {
  for (const first of [503, 429, 'throw'] as const) {
    const f = fakeFetch([first, 200]);
    const r = await notifySite(['blogs'], { url: URL_OK, secret: SECRET, fetchImpl: f.impl, retryDelayMs: 1 });
    assert.deepEqual(r, { status: 'sent', httpStatus: 200, attempts: 2 }, String(first));
  }
  const f = fakeFetch([401, 200]);
  const r = await notifySite(['blogs'], { url: URL_OK, secret: SECRET, fetchImpl: f.impl, retryDelayMs: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(f.calls.length, 1);
});

test('a persistent failure or a hang resolves (never throws) without exposing the secret', async () => {
  const down = fakeFetch(['throw']);
  const r1 = await notifySite(['blogs'], { url: URL_OK, secret: SECRET, fetchImpl: down.impl, retryDelayMs: 1 });
  assert.equal(r1.status, 'failed');
  assert.ok(!JSON.stringify(r1).includes(SECRET));

  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
  const r2 = await notifySite(['blogs'], { url: URL_OK, secret: SECRET, fetchImpl: hang, timeoutMs: 20, retryDelayMs: 1 });
  assert.deepEqual(r2, { status: 'failed', reason: 'timed out after 20 ms', attempts: 2 });
});

/* ── Wiring ──────────────────────────────────────────────────────────────── */

test('invalidateResource notifies the configured site only for public changes', async (t) => {
  const f = fakeFetch([200]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  process.env.SITE_REVALIDATE_URL = URL_OK;
  process.env.SITE_REVALIDATE_SECRET = SECRET;
  t.after(() => {
    globalThis.fetch = realFetch;
    process.env.SITE_REVALIDATE_URL = '';
    process.env.SITE_REVALIDATE_SECRET = '';
  });

  // Only requests to the site count: the outcome is then recorded in the
  // database (site_refresh_log), which goes through the same fetch.
  const toSite = () => f.calls.filter((c) => String(c.url) === URL_OK);

  await invalidateResource('blogs', { before: draft('p'), after: draft('p') });
  await invalidateResource('enquiries');
  assert.equal(toSite().length, 0, 'draft save and lead write must not notify');

  await invalidateResource('blogs', { before: draft('p'), after: published('p') });
  assert.equal(toSite().length, 1);
  assert.deepEqual(JSON.parse(toSite()[0].init.body as string), { tags: ['blog-index', 'blog:p'] });
});

test('CMS write handlers await invalidation (no fire-and-forget on serverless)', () => {
  const dir = path.join(__dirname, '../src/controllers');
  for (const file of ['crud.factory.ts', 'blog.controller.ts', 'course.controller.ts', 'settings.controller.ts', 'about.controller.ts']) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    assert.ok(src.includes('await invalidateResource('), `${file} must await invalidateResource`);
    assert.ok(!/void invalidateResource\(/.test(src), `${file} still fires invalidateResource without awaiting`);
  }
});
