import { env } from '../config/env';
import { logger } from '../config/logger';
import { SITE_ORIGIN } from '../seo/site/canonical';
import { LEGAL_SLUGS, ROUTE_KEYED_PAGES, routeKeyedPage } from '../seo/pageSeoRegistry';
import { courseRepo, localityRepo } from '../repositories';
import { cacheGet, cacheSet } from './cache';
import {
  indexNowConfigProblem,
  submitToIndexNow,
  warnIndexNowUnconfigured,
  type IndexNowResult,
} from './indexNow';
import type { ChangeContext } from './siteRevalidation';

/**
 * Which URLs a CMS write tells IndexNow about.
 *
 * Called by invalidateResource() once a write has succeeded, with the same
 * before/after records the site-cache refresh (siteRevalidation.ts) uses. The
 * rules mirror what the site renders:
 *
 *   • A page is submitted only while it is public: status `published` (or
 *     `isActive` for a locality) and not `seo.noindex`. A draft saved as a
 *     draft submits nothing.
 *   • A page that STOPS being public (unpublished, archived, deleted, set to
 *     noindex, or renamed away from this slug) is submitted once under its old
 *     URL, so the engines recrawl it and see the 404 or the noindex.
 *   • An edit to a record that stays public is submitted only if something a
 *     visitor can see changed; internal notes, SEO keywords and timestamps do
 *     not count.
 *   • Landing pages (/data-science-course-ameerpet …) are built from a course
 *     and a locality, so a change to either also submits the landings that use
 *     it, provided the other half is live — the page 404s otherwise.
 *   • A write without a change record (the bulk scripts) submits nothing: the
 *     whole archive is never pushed at once.
 *
 * Only these pages are covered. The listing pages (/, /courses, /blog and the
 * category archives) and the sitemaps are left to the engines' own crawl.
 */

type Doc = Record<string, unknown> | null | undefined;

export interface IndexNowPaths {
  /** Site paths that are public and were added or changed. */
  updated: string[];
  /** Site paths that were public and no longer are. */
  removed: string[];
}

/** Lookups for the other half of a landing page. Injected in tests. */
export interface LandingDeps {
  coursePublished(slug: string): Promise<boolean>;
  localityActive(slug: string): Promise<boolean>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

const slugOf = (doc: Doc): string | null => {
  const slug = typeof doc?.slug === 'string' ? doc.slug.toLowerCase() : '';
  return SLUG.test(slug) ? slug : null;
};

const isPublished = (doc: Doc): boolean => Boolean(doc) && doc?.status === 'published';
const isNoindex = (doc: Doc): boolean => Boolean((doc?.seo as { noindex?: unknown } | null | undefined)?.noindex);

/** Resources that own one page at a path built from their slug. */
const PAGE_PATH: Record<string, (slug: string) => string | null> = {
  courses: (slug) => `/courses/${slug}`,
  blogs: (slug) => `/blog/${slug}`,
  comparisons: (slug) => `/compare/${slug}`,
  // A legal row with any other slug is not a page on the site.
  legal: (slug) => (LEGAL_SLUGS.includes(slug) ? `/${slug}` : null),
};

/** The public URL of a record, or null when it is not public and indexable. */
function publicPath(resource: string, doc: Doc): string | null {
  const build = PAGE_PATH[resource];
  const slug = slugOf(doc);
  if (!build || !slug || !isPublished(doc) || isNoindex(doc)) return null;
  return build(slug);
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** What a visitor or crawler could see of a record: no ids, timestamps or editorial SEO notes. */
function visibleView(doc: Doc, ignoreSeo: boolean): string {
  const view: Record<string, unknown> = { ...(doc ?? {}) };
  delete view.id;
  delete view.createdAt;
  delete view.updatedAt;
  if (ignoreSeo) {
    delete view.seo;
  } else if (view.seo && typeof view.seo === 'object') {
    const seo = { ...(view.seo as Record<string, unknown>) };
    delete seo.keywords;
    delete seo.intentNote;
    view.seo = seo;
  }
  return stable(view);
}

const changedVisibly = (before: Doc, after: Doc, ignoreSeo = false): boolean =>
  visibleView(before, ignoreSeo) !== visibleView(after, ignoreSeo);

/* ── Landing pages ────────────────────────────────────────────────────────── */

const LANDINGS = ROUTE_KEYED_PAGES.filter((p) => p.kind === 'landing');

type LandingKey = 'courseSlug' | 'localitySlug';

interface Side {
  slug: string | null;
  live: boolean;
}

/**
 * Landings that a course or locality change adds, changes or takes down.
 * `by` is the half that changed; the other half must be live for the page to
 * exist at all.
 */
async function landingChanges(
  by: LandingKey,
  before: Side,
  after: Side,
  changed: boolean,
  deps: LandingDeps,
  out: IndexNowPaths,
): Promise<void> {
  const otherLive = (l: (typeof LANDINGS)[number]) =>
    by === 'courseSlug' ? deps.localityActive(l.localitySlug ?? '') : deps.coursePublished(l.courseSlug ?? '');
  const renamed = before.slug !== after.slug;

  if (after.live && after.slug && (!before.live || renamed || changed)) {
    for (const l of LANDINGS.filter((p) => p[by] === after.slug)) {
      if (await otherLive(l)) out.updated.push(l.path);
    }
  }
  if (before.live && before.slug && (!after.live || renamed)) {
    for (const l of LANDINGS.filter((p) => p[by] === before.slug)) {
      if (await otherLive(l)) out.removed.push(l.path);
    }
  }
}

/** The SEO fields a visitor or crawler sees; the editor-only ones are left out. */
function pageSeoView(row: Doc): string {
  const pick = (k: string) => (row?.[k] === '' || row?.[k] === undefined ? null : row?.[k]);
  return stable(
    ['metaTitle', 'metaDescription', 'ogTitle', 'ogDescription', 'ogImage', 'ogImageAlt'].map(pick).concat(
      Boolean(row?.noindex),
      Boolean(row?.nofollow),
    ),
  );
}

/* ── Mapping ──────────────────────────────────────────────────────────────── */

/**
 * The paths a write submits. Pure apart from the landing lookups in `deps`.
 * Unit-tested in tests/indexNow.test.ts.
 */
export async function indexNowPathsForChange(
  resource: string,
  change: ChangeContext | undefined,
  deps: LandingDeps,
): Promise<IndexNowPaths> {
  const out: IndexNowPaths = { updated: [], removed: [] };

  // The About page has a fixed URL and its writes carry no record.
  if (resource === 'about') {
    out.updated.push('/about');
    return out;
  }
  if (!change) return out;
  const { before, after } = change;

  if (PAGE_PATH[resource]) {
    const was = publicPath(resource, before);
    const now = publicPath(resource, after);
    if (now && (!was || was !== now || changedVisibly(before, after))) out.updated.push(now);
    if (was && was !== now) out.removed.push(was);
  }

  if (resource === 'courses') {
    const side = (doc: Doc): Side => ({ slug: slugOf(doc), live: isPublished(doc) });
    const changed = changedVisibly(before, after, true);
    await landingChanges('courseSlug', side(before), side(after), changed, deps, out);
  }

  if (resource === 'localities') {
    const side = (doc: Doc): Side => ({ slug: slugOf(doc), live: Boolean(doc) && doc?.isActive !== false });
    await landingChanges('localitySlug', side(before), side(after), changedVisibly(before, after), deps, out);
  }

  if (resource === 'page-seo') {
    const path = String(after?.path ?? before?.path ?? '');
    const page = routeKeyedPage(path);
    if (page && page.storage === 'page') {
      // No row means the page's defaults, which are indexable.
      const wasIndexable = !before?.noindex;
      const nowIndexable = !after?.noindex;
      const live =
        page.kind !== 'landing' ||
        ((await deps.coursePublished(page.courseSlug ?? '')) && (await deps.localityActive(page.localitySlug ?? '')));
      if (live && (wasIndexable || nowIndexable) && pageSeoView(before) !== pageSeoView(after)) {
        (nowIndexable ? out.updated : out.removed).push(path);
      }
    }
  }

  return out;
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */

/** The same event processed twice (a double click, a retried request) submits once. */
const DEDUPE_TTL_SECONDS = 600;
const recent = new Map<string, number>();

const dedupeKey = (kind: 'updated' | 'removed', url: string) => `indexnow:${kind}:${url}`;

async function alreadySent(key: string): Promise<boolean> {
  const expires = recent.get(key);
  if (expires !== undefined) {
    if (expires > Date.now()) return true;
    recent.delete(key);
  }
  // Shared with the other instances when Redis is on; a miss when it is not.
  return (await cacheGet<number>(key)) !== null;
}

async function markSent(key: string): Promise<void> {
  if (recent.size > 1000) {
    const now = Date.now();
    for (const [k, expires] of recent) if (expires <= now) recent.delete(k);
  }
  recent.set(key, Date.now() + DEDUPE_TTL_SECONDS * 1000);
  await cacheSet(key, 1, DEDUPE_TTL_SECONDS);
}

/** Clears the in-process duplicate memory. Tests only. */
export function resetIndexNowDedupe(): void {
  recent.clear();
}

// A failed lookup counts as "not live": better to skip a landing than to
// submit one that may 404.
const defaultDeps: LandingDeps = {
  async coursePublished(slug) {
    try {
      return Boolean(await courseRepo.findOne({ slug, status: 'published' }));
    } catch {
      return false;
    }
  },
  async localityActive(slug) {
    try {
      const locality = await localityRepo.findOne({ slug });
      return Boolean(locality) && locality?.isActive !== false;
    } catch {
      return false;
    }
  },
};

export interface NotifyOptions {
  key?: string;
  deps?: LandingDeps;
  /** Injected in tests. */
  submit?: (urls: string[]) => Promise<IndexNowResult>;
}

/**
 * Tell IndexNow what a successful write changed. Never throws: the write has
 * already succeeded and a failure here is logged by the sender.
 */
export async function notifyIndexNow(
  resource: string,
  change?: ChangeContext,
  opts: NotifyOptions = {},
): Promise<IndexNowResult> {
  return notifyIndexNowMany(resource, [change], opts);
}

/**
 * notifyIndexNow for several writes to one resource (a bulk status change):
 * every write's changed URLs in one submission, deduplicated. Never throws.
 */
export async function notifyIndexNowMany(
  resource: string,
  changes: ReadonlyArray<ChangeContext | undefined>,
  opts: NotifyOptions = {},
): Promise<IndexNowResult> {
  try {
    const problem = indexNowConfigProblem(opts.key ?? env.indexNow.key);
    if (problem) {
      warnIndexNowUnconfigured(problem);
      return { status: 'skipped', reason: problem };
    }

    const wanted: { kind: 'updated' | 'removed'; url: string }[] = [];
    for (const change of changes) {
      const paths = await indexNowPathsForChange(resource, change, opts.deps ?? defaultDeps);
      wanted.push(
        ...paths.updated.map((p) => ({ kind: 'updated' as const, url: toUrl(p) })),
        ...paths.removed.map((p) => ({ kind: 'removed' as const, url: toUrl(p) })),
      );
    }

    const fresh: typeof wanted = [];
    for (const item of wanted) {
      if (!(await alreadySent(dedupeKey(item.kind, item.url)))) fresh.push(item);
    }
    if (fresh.length === 0) return { status: 'skipped', reason: 'no public change' };

    const urls = [...new Set(fresh.map((i) => i.url))];
    const result = await (opts.submit ?? ((u) => submitToIndexNow(u, { key: opts.key })))(urls);
    if (result.status === 'sent') {
      for (const item of fresh) await markSent(dedupeKey(item.kind, item.url));
    }
    return result;
  } catch (err) {
    logger.warn('IndexNow notification failed unexpectedly', { resource, message: (err as Error).message });
    return { status: 'failed', reason: 'unexpected error', submitted: 0, batches: 0, httpStatus: [] };
  }
}

const toUrl = (path: string): string => `${SITE_ORIGIN}${path}`;
