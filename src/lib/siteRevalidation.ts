import { env } from '../config/env';
import { logger } from '../config/logger';
import { BLOG_LIST_FIELDS } from '../constants';

/**
 * Tell the marketing site (main-website) which cached content a CMS write
 * changed, so it is refreshed in seconds instead of waiting out its ISR window.
 *
 * The site's endpoint is `POST /api/revalidate` (main-website/app/api/revalidate
 * /route.ts): `Authorization: Bearer <secret>`, body `{ "tags": [...] }`. It
 * accepts only the tags below, so a mapping change here must be mirrored in
 * main-website/lib/api/client.ts (CACHE_TAGS and ENTITY_TAG).
 *
 * Rules:
 *   • Only changes a visitor can see notify the site. Saving a draft that was
 *     never published — and is not being published — changes nothing public.
 *   • Tags are as narrow as the change: one blog post's tag, not every post's.
 *   • A failure is logged and swallowed. The CMS write has already succeeded;
 *     the content still appears when the site's time-based revalidation runs.
 *   • Unconfigured (no URL or a weak secret) means "do nothing", logged once.
 */

type Doc = Record<string, unknown> | null | undefined;

export interface ChangeContext {
  /** The record before the write (null for a create). */
  before?: Doc;
  /** The record after the write (null for a delete). */
  after?: Doc;
}

/** Resources whose public visibility is `status === 'published'`. */
const STATUS_RESOURCES = new Set(['blogs', 'courses', 'comparisons', 'legal']);

/** Resources whose public visibility is `isActive !== false`. */
const ACTIVE_RESOURCES = new Set([
  'localities',
  'trainers',
  'testimonials',
  'placements',
  'companies',
  'roadmaps',
  'faqs',
  'gallery',
  'batches',
]);

/** Site-wide tag(s) per resource. Anything not listed never notifies the site (e.g. leads). */
const RESOURCE_TAGS: Record<string, string[]> = {
  blogs: ['blogs'],
  courses: ['courses'],
  comparisons: ['comparisons'],
  legal: ['legal'],
  localities: ['localities'],
  categories: ['categories'],
  // Author name, role and bio are embedded in every article body.
  authors: ['authors'],
  // Trainers appear on the homepage and inside each course record.
  trainers: ['people'],
  testimonials: ['marketing'],
  placements: ['marketing'],
  companies: ['marketing'],
  roadmaps: ['marketing'],
  faqs: ['marketing'],
  gallery: ['marketing'],
  batches: ['marketing'],
  settings: ['settings'],
  about: ['about'],
  // Search/social overrides for fixed pages, resources and landings, read by
  // those pages' metadata and by the pages, locations and resources sitemaps.
  'page-seo': ['page-seo'],
  // Course categories are admin-only (publicRead: false; a course stores its
  // category as text). Brochures have no list tag: the PDF is streamed per
  // request, and a brochure change refreshes only its course page (see
  // siteTagsForChange), which decides whether to show "Download Brochure".
  'course-categories': [],
  brochures: [],
};

/** Per-record tag prefix, for resources whose pages are addressed by slug. */
const ENTITY_PREFIX: Record<string, string> = {
  blogs: 'blog',
  courses: 'course',
  comparisons: 'comparison',
  legal: 'legal',
  localities: 'locality',
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

/** Both versions public, same slug, and no list-card field changed. */
function isBodyOnlyEdit({ before, after }: ChangeContext): boolean {
  if (!before || !after) return false;
  if (!visible('blogs', before) || !visible('blogs', after)) return false;
  // `author` is the embedded author row; a reassignment shows up in `authorKey`.
  return BLOG_LIST_FIELDS.filter((f) => f !== 'author').every(
    (f) => JSON.stringify(before[f] ?? null) === JSON.stringify(after[f] ?? null),
  );
}

/**
 * Public after the write, and at the same URL as before (or not public before:
 * a publish). Anything else — unpublishing, deleting, a slug change — removes
 * a URL other pages may link to, so it keeps the full resource-wide refresh
 * (`blogs`, `comparisons`).
 */
function isSameUrlChange(resource: string, { before, after }: ChangeContext): boolean {
  if (!visible(resource, after)) return false;
  if (!visible(resource, before)) return true;
  const slugOf = (doc: Doc) => String(doc?.slug ?? '').toLowerCase();
  return slugOf(before) === slugOf(after);
}

/**
 * Course fields only the course's own page shows — and its location landings,
 * which read that one course too (both tagged `course:<slug>` on the site).
 * Every other field reaches a site-wide list: the Courses menu, the footer, the
 * home and /courses cards and search, the article sidebar's recommended course
 * (main-website/lib/courseViews.ts lists what each reads). A field not named
 * here counts as site-wide, so a new column defaults to the safe full refresh.
 * `seo` is detail too, except its robots flags (checked below), which move a
 * course in or out of courses.xml.
 */
const COURSE_DETAIL_FIELDS = new Set([
  'syllabus',
  'faqs',
  'fees',
  'placement',
  'skills',
  'images',
  'bannerImage',
  'brochureUrl',
  'trainer',
  'trainerId',
  'seo',
  'updatedAt',
]);

/** Both versions public, every list-visible field unchanged, and robots unchanged. */
function isDetailOnlyCourseEdit({ before, after }: ChangeContext): boolean {
  if (!before || !after) return false;
  if (!visible('courses', before) || !visible('courses', after)) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (COURSE_DETAIL_FIELDS.has(k)) continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) return false;
  }
  const b = (before.seo ?? {}) as Record<string, unknown>;
  const a = (after.seo ?? {}) as Record<string, unknown>;
  return Boolean(b.noindex) === Boolean(a.noindex) && Boolean(b.nofollow) === Boolean(a.nofollow);
}

/**
 * Course fields that course LISTS show, but not the header menu: the cards on
 * /courses and the home page, the courses sitemap, /training-in-hyderabad, the
 * footer's course strip and the demo and chat course pickers. The archive-type
 * lists carry `course-index` on the site; the footer and pickers are on every
 * page and carry only `courses`, and catch up when each page next regenerates.
 * A field in neither this set nor COURSE_DETAIL_FIELDS counts as site-wide.
 */
const COURSE_LIST_FIELDS = new Set([
  'title',
  'tagline',
  'category',
  'duration',
  'modules',
  'tools',
  'projects',
  'description',
  'featured',
  'order',
  'createdAt',
  'status',
]);

/** In the header's Courses menu (main-website lib/courseNav.ts): public, and not switched off. */
const inCourseMenu = (doc: Doc): boolean => visible('courses', doc) && doc?.showInNav !== false;

/**
 * A course change that only course lists need at once: publishing a course
 * that is not in the menu, or editing what its card shows while its URL and the
 * menu stay the same. Sending `courses` for these marked every page stale,
 * because every page carries the course strip in its footer: each such save
 * rewrote ~760 pages as crawlers reached them (2026-11-09).
 *
 * Still site-wide (`courses`): a course leaving its URL (unpublished, deleted,
 * renamed), a course entering or leaving the menu or moving in it, a menu
 * course's title or category (the menu's label and group), and any field this
 * module does not know.
 */
function isListOnlyCourseChange({ before, after }: ChangeContext): boolean {
  if (!visible('courses', after)) return false;
  if (!visible('courses', before)) return !inCourseMenu(after);
  const same = (k: string) => JSON.stringify(before?.[k] ?? null) === JSON.stringify(after?.[k] ?? null);
  if (String(before?.slug ?? '').toLowerCase() !== String(after?.slug ?? '').toLowerCase()) return false;
  if (inCourseMenu(before) !== inCourseMenu(after) || !same('navOrder')) return false;
  if (inCourseMenu(after) && !(same('title') && same('category'))) return false;
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    if (COURSE_DETAIL_FIELDS.has(k) || COURSE_LIST_FIELDS.has(k)) continue;
    if (!same(k)) return false;
  }
  return true;
}

function visible(resource: string, doc: Doc): boolean {
  if (!doc) return false;
  if (STATUS_RESOURCES.has(resource)) return doc.status === 'published';
  if (ACTIVE_RESOURCES.has(resource)) return doc.isActive !== false;
  return true;
}

/**
 * The site cache tags a change invalidates, or [] when nothing public changed.
 * Without a change context (bulk maintenance scripts) the records are unknown,
 * so only the resource-wide tags are returned.
 * Pure — unit-tested in tests/siteRevalidation.test.ts.
 */
export function siteTagsForChange(resource: string, change?: ChangeContext): string[] {
  const base = RESOURCE_TAGS[resource];
  if (!base) return [];
  if (!change) return [...base];
  if (!visible(resource, change.before) && !visible(resource, change.after)) return [];

  // A brochure row decides whether its course page shows "Download Brochure"
  // (the course's `hasBrochure`), so it refreshes that one page, before and
  // after a move to another course. The PDF itself is streamed per request.
  if (resource === 'brochures') {
    const tags = new Set<string>();
    for (const doc of [change.before, change.after]) {
      const slug = typeof doc?.courseSlug === 'string' ? doc.courseSlug.toLowerCase() : '';
      if (SLUG.test(slug)) tags.add(`course:${slug}`);
    }
    return [...tags];
  }

  // A published post edited in place without touching anything a card shows
  // (title, excerpt, image, dates, flags…) changes only its own page. Every
  // article page renders "latest" and "popular" card lists, so sending
  // `blogs` here would make all ~600 articles regenerate for a body edit.
  if (resource === 'blogs' && isBodyOnlyEdit(change)) {
    const slug = String(change.after?.slug ?? '').toLowerCase();
    return SLUG.test(slug) ? [`blog:${slug}`] : [];
  }

  // A post that is (still) public at the same URL: a publish, or an edit to
  // what its card shows. Only the archive needs it at once — /blog, the
  // category pages, the home page's latest posts and the sitemaps, which carry
  // `blog-index` on the site (main-website/lib/api/services.ts → BlogListScope).
  // The footer and the article sidebars list titles on every page; they carry
  // only `blogs` and catch up when each page next regenerates. Sending `blogs`
  // for a publish marked all ~760 pages stale, and each was rewritten when next
  // crawled: 7–15K ISR write units per publish (Vercel dashboard, 5–7 Nov 2026).
  if (resource === 'blogs' && isSameUrlChange('blogs', change)) {
    const slug = String(change.after?.slug ?? '').toLowerCase();
    return SLUG.test(slug) ? ['blog-index', `blog:${slug}`] : ['blog-index'];
  }

  // The same for comparisons: a publish, or an edit at the same URL, refreshes
  // /compare and the compare sitemap (`comparison-index` on the site) and the
  // comparison's own page. The footer's comparison links and the related-
  // comparison blocks on course, landing, article and other comparison pages
  // are on nearly every page and carry only `comparisons` (main-website
  // lib/site-data.ts → getComparisonLinks); they pick a publish up when each
  // page next regenerates. Sending `comparisons` here would rewrite the whole
  // site for every publish, as `blogs` did. Unpublishing, deleting or renaming
  // still sends `comparisons` below, so no page keeps a link to a gone URL.
  if (resource === 'comparisons' && isSameUrlChange('comparisons', change)) {
    const slug = String(change.after?.slug ?? '').toLowerCase();
    return SLUG.test(slug) ? ['comparison-index', `comparison:${slug}`] : ['comparison-index'];
  }

  // Likewise a published course whose only changes are detail its own page
  // shows (syllabus, FAQs, fees, SEO text…): every page carries `courses`
  // through the menu, so sending it would regenerate the whole site for a
  // syllabus edit. (A robots change also moves the course in or out of
  // courses.xml, so it keeps the resource-wide tag; the sitemap's lastmod
  // follows `course:<slug>`, see main-website/app/sitemaps/courses.xml.)
  if (resource === 'courses' && isDetailOnlyCourseEdit(change)) {
    const slug = String(change.after?.slug ?? '').toLowerCase();
    return SLUG.test(slug) ? [`course:${slug}`] : [];
  }

  // A course publish or card edit that leaves the URL and the menu alone:
  // the course lists (`course-index`) and the course's own page.
  if (resource === 'courses' && isListOnlyCourseChange(change)) {
    const slug = String(change.after?.slug ?? '').toLowerCase();
    return SLUG.test(slug) ? ['course-index', `course:${slug}`] : ['course-index'];
  }

  const tags = new Set(base);
  const prefix = ENTITY_PREFIX[resource];
  if (prefix) {
    // Both slugs: a rename must refresh the old URL (now a 404) and the new one.
    for (const doc of [change.before, change.after]) {
      const slug = typeof doc?.slug === 'string' ? doc.slug.toLowerCase() : '';
      if (SLUG.test(slug)) tags.add(`${prefix}:${slug}`);
    }
  }
  return [...tags];
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */

export interface NotifyOptions {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

export type NotifyResult =
  | { status: 'skipped'; reason: string }
  | { status: 'sent'; httpStatus: number; attempts: number }
  | { status: 'failed'; reason: string; attempts: number };

const MIN_SECRET_LENGTH = 32;
let warnedUnconfigured = false;

/** Why the webhook cannot be used, or null when it is configured. Never includes the secret. */
export function webhookConfigProblem(url: string, secret: string): string | null {
  if (!url) return 'SITE_REVALIDATE_URL is not set';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'SITE_REVALIDATE_URL is not a valid URL';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    return 'SITE_REVALIDATE_URL must use https (http is allowed for localhost only)';
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return `SITE_REVALIDATE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  return null;
}

const retryable = (status: number) => status === 429 || status >= 500;

/** POST the tags to the site. Never throws. */
export async function notifySite(tags: readonly string[], opts: NotifyOptions = {}): Promise<NotifyResult> {
  if (tags.length === 0) return { status: 'skipped', reason: 'no public change' };

  const url = opts.url ?? env.siteRevalidation.url;
  const secret = opts.secret ?? env.siteRevalidation.secret;
  const problem = webhookConfigProblem(url, secret);
  if (problem) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn(`Site revalidation disabled: ${problem}. Site pages refresh on their ISR timer only.`);
    }
    return { status: 'skipped', reason: problem };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? env.siteRevalidation.timeoutMs;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  let lastReason = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ tags }),
        signal: controller.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) {
        logger.info('Site revalidated', { tags, attempts: attempt });
        return { status: 'sent', httpStatus: res.status, attempts: attempt };
      }
      lastReason = `HTTP ${res.status}`;
      if (!retryable(res.status)) break;
    } catch (err) {
      lastReason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : 'network error';
      void err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  // The secret is never part of the log line.
  logger.warn('Site revalidation failed; content will refresh on the ISR timer', {
    reason: lastReason,
    tags,
  });
  return { status: 'failed', reason: lastReason, attempts: 2 };
}
