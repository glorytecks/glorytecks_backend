import { cacheDelete, cacheDeletePattern } from './cache';
import { logger } from '../config/logger';
import { notifySite, siteTagsForChange, type ChangeContext } from './siteRevalidation';
import { recordSiteRefresh } from './siteRefreshLog';
import { notifyIndexNowMany } from './indexNowChanges';

/**
 * Tags the site's `/api/revalidate` accepts in one request (main-website
 * lib/revalidation/handler.ts MAX_TAGS). A single save sends a handful; a bulk
 * status change sends one per record, so its tags go in requests of this size.
 */
export const SITE_REVALIDATE_MAX_TAGS = 50;

/**
 * Map of resource names to their cache key patterns.
 * When a resource is mutated (create/update/delete), all matching patterns
 * are cleared so the next read fetches fresh data from MongoDB.
 */
export const PAGE_SEO_ENTRIES_KEY = 'admin:page-seo:entries';
export const DASHBOARD_PULSE_KEY = 'admin:dashboard:pulse';

const INVALIDATION_MAP: Record<string, string[]> = {
  // Bespoke resources
  blogs: [
    'public:blogs:*',
    'admin:dashboard:stats',
  ],
  courses: [
    'public:courses:*',
    // The brochure proxy's cached courses.brochure_url lookup, so a replaced
    // brochure is served at once instead of after the cache TTL.
    'brochure:resolve:*',
    'admin:dashboard:stats',
    PAGE_SEO_ENTRIES_KEY,
  ],
  settings: [
    'public:settings',
  ],
  about: [
    'public:about',
    PAGE_SEO_ENTRIES_KEY,
  ],

  // Generic resources (from the service registry)
  categories: ['public:categories:*', 'admin:dashboard:stats'],
  // The dashboard's At a glance counts every resource below, so each write clears them.
  authors: ['public:authors:*', 'admin:dashboard:stats'],
  'course-categories': ['admin:dashboard:stats'],
  trainers: ['public:trainers:*', 'admin:dashboard:stats'],
  testimonials: ['public:testimonials:*', 'admin:dashboard:stats'],
  placements: ['public:placements:*', 'admin:dashboard:stats'],
  companies: ['public:companies:*', 'admin:dashboard:stats'],
  roadmaps: ['public:roadmaps:*', 'admin:dashboard:stats'],
  faqs: ['public:faqs:*', 'admin:dashboard:stats'],
  comparisons: ['public:comparisons:*', 'admin:dashboard:stats', PAGE_SEO_ENTRIES_KEY],
  localities: ['public:localities:*', 'admin:dashboard:stats', PAGE_SEO_ENTRIES_KEY],
  legal: ['public:legal:*', 'admin:dashboard:stats', PAGE_SEO_ENTRIES_KEY],
  gallery: ['public:gallery:*', 'admin:dashboard:stats'],
  // public:courses:* too: a course's `hasBrochure` comes from this table.
  brochures: ['public:brochures:*', 'brochure:resolve:*', 'public:courses:*', 'admin:dashboard:stats'],
  batches: ['public:batches:*', 'admin:dashboard:stats'],
  'page-seo': ['public:page-seo', PAGE_SEO_ENTRIES_KEY],

  // Lead-related: only affects dashboard stats
  'demo-requests': ['admin:dashboard:stats'],
  enquiries: ['admin:dashboard:stats'],
};

/**
 * Invalidate all cache entries related to a given resource, then tell the
 * marketing site which of its cached pages the change affects.
 * Call this after any create, update, or delete operation — and `await` it:
 * on a serverless host the function may be frozen once the response is sent,
 * so a fire-and-forget purge can silently never run.
 *
 * Never throws: the write has already succeeded, and each step logs its own
 * failure. Order matters — Redis is purged first so the site's refetch reads
 * the new data, not the API's cached copy.
 *
 * @param resource - The resource name (e.g. 'blogs', 'courses', 'trainers')
 * @param change   - The record before and after the write. It decides whether
 *   anything public changed (a draft saved as a draft does not notify the site)
 *   and which per-record site tags to refresh. Omitted (bulk scripts): the
 *   site's resource-wide listing tags are refreshed, nothing per-record.
 */
export async function invalidateResource(resource: string, change?: ChangeContext): Promise<void> {
  await invalidateResourceChanges(resource, [change]);
}

/**
 * invalidateResource for several writes to one resource at once (a bulk
 * status change): Redis is purged once, the site is told once with the union of
 * every write's tags (in requests of at most SITE_REVALIDATE_MAX_TAGS), and
 * IndexNow gets one submission. One write gives exactly what
 * invalidateResource always did. Never throws.
 */
export async function invalidateResourceChanges(
  resource: string,
  changes: ReadonlyArray<ChangeContext | undefined>,
): Promise<void> {
  const patterns = INVALIDATION_MAP[resource];
  if (patterns && patterns.length > 0) {
    logger.debug(`Cache invalidation: ${resource} → [${patterns.join(', ')}]`);
    await Promise.all(
      patterns.map((pattern) => {
        if (pattern.includes('*')) {
          return cacheDeletePattern(pattern);
        }
        return cacheDelete(pattern);
      }),
    ).catch((err) => logger.warn(`Cache invalidation failed for ${resource}: ${(err as Error).message}`));
  }

  // First-seen order, so one write's tags arrive exactly as before.
  const tags = [...new Set(changes.flatMap((change) => siteTagsForChange(resource, change)))];
  // No tags (a draft saved as a draft) still goes through once: notifySite
  // answers "skipped" and the refresh log ignores it, as it always has.
  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += SITE_REVALIDATE_MAX_TAGS) batches.push(tags.slice(i, i + SITE_REVALIDATE_MAX_TAGS));
  if (batches.length === 0) batches.push([]);
  for (const batch of batches) {
    const result = await notifySite(batch);
    // Kept for the admin dashboard, which would otherwise never learn of a failure.
    await recordSiteRefresh(resource, batch, result);
  }

  // After the site purge, so the engines crawl the refreshed page. Awaited for
  // the same serverless reason; bounded by its own timeout, and never throws.
  await notifyIndexNowMany(resource, changes);
}

/**
 * Invalidate dashboard stats cache directly (used by lead controllers).
 */
export async function invalidateDashboard(): Promise<void> {
  await Promise.all([cacheDelete('admin:dashboard:stats'), cacheDelete(DASHBOARD_PULSE_KEY)]);
}
