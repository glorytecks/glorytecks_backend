import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/ApiResponse';
import { parseListParams, buildPaginationMeta, toSortSpecs } from '../utils/queryFeatures';
import { ApiError } from '../utils/ApiError';
import { validate } from '../middlewares/validate';
import {
  demoRequestController,
  contactEnquiryController,
  chatEnquiryController,
} from '../controllers/lead.controller';
import {
  demoRequestValidator,
  contactEnquiryValidator,
  chatEnquiryCreateValidator,
  chatEnquiryUpdateValidator,
} from '../validators/lead.validator';
import { brochureProxyController } from '../controllers/brochure.controller';
import {
  publicDownloadLimiter,
  publicWriteLimiter,
  chatWriteLimiter,
  honeypotGuard,
} from '../middlewares/rateLimit';
import { slugParam, uuidParam, listQueryValidator } from '../validators/common';
import { BLOG_LIST_FIELDS, CONTENT_STATUS } from '../constants';
import { cacheWrap, hashQuery, CACHE_TTL } from '../lib/cache';
import { IBlog } from '../interfaces/common';
import { neighboursOf, rankRelated } from '../lib/blogContext';
import { PAGE_SEO_PATHS } from '../seo/pageSeoRegistry';
import { publicOverride, withPublicSeo } from '../seo/seoFields';
import {
  blogRepo,
  courseRepo,
  blogCategoryRepo,
  authorRepo,
  trainerRepo,
  testimonialRepo,
  placementRepo,
  companyRepo,
  roadmapRepo,
  faqRepo,
  comparisonRepo,
  localityRepo,
  pageSeoRepo,
  legalDocRepo,
  galleryRepo,
  brochureRepo,
  batchRepo,
  settingsRepo,
  aboutPageRepo,
} from '../repositories';

/**
 * Public, read-only API consumed by the GloryTecks marketing website.
 * Only exposes published / active content and never requires authentication.
 *
 * All GET handlers are wrapped with Redis cacheWrap() for high-concurrency
 * performance. Cache is invalidated by admin mutation controllers.
 *
 * Nothing about this file's contract changed in the migration — the same
 * paths, query parameters, cache keys, TTLs and response envelopes. Only the
 * data source underneath moved from MongoDB to Supabase PostgreSQL.
 */
const router = Router();

// ── HTTP caching for the public read API ────────────────────────────────────
// Every public read is revalidated with the origin, never served from a CDN
// copy. The only caller of these GETs is the marketing site's server (browsers
// only POST leads), and the site already caches each response in its own
// tagged data cache. A second, edge cache here made invalidation wrong: blogs
// and courses used to be edge-cached for 120 s (+300 s stale), so when a CMS
// save told the site to refetch (lib/siteRevalidation) the site could read the
// pre-save edge copy and keep it for its whole ISR window.
//
// The origin stays shielded: Redis answers in <1 ms and is purged on every
// admin mutation (lib/cacheInvalidation) before the site is notified.
const REVALIDATE_AT_ORIGIN = 'public, max-age=0, s-maxage=0, must-revalidate';

router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', REVALIDATE_AT_ORIGIN);
  next();
});

/* ── Blogs ─────────────────────────────────────────────────────────────── */

// List responses only ever need card-level fields. Excluding the heavy body
// (content blocks, rendered html, toc, faqs, seo) cuts the payload of a
// 6-post page from ~hundreds of KB to a few KB.
//
// This is the former space-separated Mongoose projection string, expressed as
// the field list the repository turns into a PostgREST `select`.
// BLOG_LIST_FIELDS lives in constants: siteRevalidation uses it to tell a
// card-visible edit from a body-only one.

/** Hard cap for anonymous list requests — nobody needs 100 posts per page. */
const PUBLIC_BLOG_MAX_LIMIT = 24;

/** Fields searched by the public blog list (was a case-insensitive $or regex). */
const PUBLIC_BLOG_SEARCH_FIELDS = ['title', 'excerpt', 'category', 'tags'];

router.get(
  '/blogs',
  validate(listQueryValidator),
  asyncHandler(async (req: Request, res: Response) => {
    const params = parseListParams(req.query as Record<string, unknown>, [
      'categorySlug',
      'kind',
      'featured',
      'trending',
      'popular',
    ]);
    params.limit = Math.min(params.limit, PUBLIC_BLOG_MAX_LIMIT);

    // `category` is accepted as a friendlier alias of `categorySlug`.
    const category = req.query.category ? String(req.query.category).toLowerCase() : undefined;
    if (category && !params.filters.categorySlug) params.filters.categorySlug = category;

    // `tag` matches any element of the tags array (case-insensitive exact).
    const tag = req.query.tag ? String(req.query.tag).trim() : undefined;

    const filter: Record<string, unknown> = {
      ...params.filters,
      status: CONTENT_STATUS.PUBLISHED,
    };
    if (tag) {
      filter.tags = { op: 'arrayIncludesInsensitive', value: tag };
    }

    const full = Boolean(req.query.full);

    const cacheKey = `public:blogs:list:${hashQuery({
      ...params,
      tag: tag ?? '',
      full: req.query.full ?? '',
    })}`;

    const result = await cacheWrap(cacheKey, CACHE_TTL.BLOGS, async () => {
      const { items, total } = await blogRepo.list({
        filter,
        search: params.search,
        searchableFields: PUBLIC_BLOG_SEARCH_FIELDS,
        sort: toSortSpecs(params.sort),
        page: params.page,
        limit: params.limit,
        fields: full ? undefined : BLOG_LIST_FIELDS,
      });
      return { items, meta: buildPaginationMeta(total, params.page, params.limit) };
    });

    return sendSuccess(res, result.items, 'Blogs', 200, result.meta);
  }),
);

/**
 * Post context: related posts + chronological prev/next within the category.
 * One cached endpoint replaces the website's old "download every blog and
 * compute client-side" approach: the post, its category in light form (one
 * indexed query, ~60 rows of slug/title/tags), and card fields for the three
 * related posts.
 *
 * Related-post ranking stays in JavaScript (lib/blogContext.ts): the same
 * tag-overlap score as before, drawn from the whole category instead of its
 * 12 newest posts, with a stable per-pair spread for equal scores.
 */
const CATEGORY_POOL_MAX = 1000;
/**
 * Sitemap feed — every published post's URL data in ONE query.
 *
 * The website's sitemap generator previously walked `/public/blogs` page by
 * page at the endpoint's 24-item cap. With 597 published posts that is 25
 * requests, and `/sitemaps/blog.xml` and `/sitemaps/categories.xml` each ran
 * their own walk — **~50 requests and ~50 PostgREST round trips every hour**,
 * to produce a list of slugs and dates.
 *
 * This returns exactly the four columns a sitemap needs, for the whole
 * archive, in a single indexed query (`blogs_status_date_idx`). No body, no
 * content blocks, no author join — a sitemap does not need them, and shipping
 * them was most of the cost.
 *
 * Deliberately unpaginated but hard-bounded by SITEMAP_MAX_ROWS: the response
 * is a few tens of KB at the current archive size and the cap keeps it from
 * becoming unbounded as content grows.
 */
const SITEMAP_MAX_ROWS = 5000;

router.get(
  '/blogs/sitemap',
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await cacheWrap('public:blogs:sitemap', CACHE_TTL.BLOGS, async () => {
      return blogRepo.findMany({
        filter: { status: CONTENT_STATUS.PUBLISHED },
        sort: [{ field: 'date', direction: -1 }],
        limit: SITEMAP_MAX_ROWS,
        fields: ['slug', 'date', 'updated', 'categorySlug'],
      });
    });

    return sendSuccess(res, items, 'Blog sitemap feed');
  }),
);

router.get(
  '/blogs/:slug/context',
  validate(slugParam()),
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug.toLowerCase();
    const cacheKey = `public:blogs:context:${slug}`;

    const data = await cacheWrap(cacheKey, CACHE_TTL.BLOGS, async () => {
      const post = await blogRepo.findOne(
        { slug, status: CONTENT_STATUS.PUBLISHED },
        { fields: ['slug', 'categorySlug', 'tags', 'date'] },
      );
      if (!post) return null;

      // The whole category, light fields, newest first in one total order
      // (date, then id — BaseRepository.applySort). Neighbours and related
      // posts are decided from it in lib/blogContext.ts; see there for why a
      // date comparison is not enough.
      const pool = await blogRepo.findMany({
        filter: { status: CONTENT_STATUS.PUBLISHED, categorySlug: post.categorySlug },
        sort: [{ field: 'date', direction: -1 }],
        limit: CATEGORY_POOL_MAX,
        fields: ['slug', 'title', 'tags'],
      });
      const { prev, next } = neighboursOf(pool, post.slug);

      // Card fields only for the posts actually shown, in rank order.
      const picked = rankRelated(post, pool, 3);
      const related: IBlog[] = picked.length
        ? (
            await blogRepo.findMany({
              filter: { status: CONTENT_STATUS.PUBLISHED, slug: { op: 'in', value: picked } },
              limit: picked.length,
              fields: BLOG_LIST_FIELDS,
            })
          ).sort((a, b) => picked.indexOf(a.slug) - picked.indexOf(b.slug))
        : [];

      // Thin category? Pad with recent trending posts from other categories.
      if (related.length < 3) {
        const fill = await blogRepo.findMany({
          filter: {
            status: CONTENT_STATUS.PUBLISHED,
            trending: true,
            categorySlug: { op: 'neq', value: post.categorySlug },
            slug: { op: 'neq', value: slug },
          },
          sort: [{ field: 'date', direction: -1 }],
          limit: 3 - related.length,
          fields: BLOG_LIST_FIELDS,
        });
        related.push(...(fill as IBlog[]));
      }

      return { related, prev, next };
    });

    if (!data) throw ApiError.notFound('Blog not found');
    return sendSuccess(res, data, 'Blog context');
  }),
);

router.get(
  '/blogs/:slug',
  validate(slugParam()),
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug.toLowerCase();
    const cacheKey = `public:blogs:slug:${slug}`;

    const doc = await cacheWrap(cacheKey, CACHE_TTL.BLOGS, async () => {
      // `detail: true` additionally selects the author's bio, matching the old
      // populate('author', 'name key role initials avatar bio').
      return blogRepo.findOne({ slug, status: CONTENT_STATUS.PUBLISHED }, { detail: true });
    });

    if (!doc) throw ApiError.notFound('Blog not found');
    return sendSuccess(res, doc, 'Blog');
  }),
);

/* ── Courses ───────────────────────────────────────────────────────────── */

/**
 * `?view=card`: every published course as the site's course LISTS need it —
 * the menu and footer links, the course cards on / and /courses, the
 * /training-in-hyderabad list, the courses sitemap and the build's list of
 * course pages. Measured on the live API (17-11-2026, 83 courses): the whole
 * list is 1,244,106 bytes, these fields 56,556. The site's Data Cache refuses
 * an entry over 2 MB (base64-encoded, so ~1.5 MB of JSON), which the whole list
 * would pass with roughly 100 courses.
 *
 * Without the parameter the response is exactly what it always was, so an
 * older site keeps working, and a newer site against an older API simply gets
 * the whole list.
 */
const COURSE_CARD_FIELDS = [
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
  // Read only to be counted below; the lists show "13 modules", not the modules.
  'modules',
  'projects',
  'createdAt',
  'updatedAt',
];

/**
 * What a card carries, named one by one: the response never depends on the
 * database honouring the column list above.
 */
const COURSE_CARD_OUTPUT = [
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
  'createdAt',
  'updatedAt',
] as const;

/** A course trimmed to the card fields, with counts in place of the two lists. */
export function toPublicCourseCard(course: Record<string, unknown>): Record<string, unknown> {
  const { modules, projects, seo } = course;
  const card: Record<string, unknown> = {};
  for (const field of COURSE_CARD_OUTPUT) {
    if (course[field] !== undefined) card[field] = course[field];
  }
  const noindex = Boolean((seo as { noindex?: unknown } | undefined)?.noindex);
  return {
    ...card,
    // Only the robots flag the sitemap needs; the rest of `seo` is for the
    // course's own page, which reads /courses/:slug.
    ...(noindex ? { seo: { noindex: true } } : {}),
    moduleCount: Array.isArray(modules) ? modules.length : 0,
    projectCount: Array.isArray(projects) ? projects.length : 0,
  };
}

router.get(
  '/courses',
  asyncHandler(async (req: Request, res: Response) => {
    if (req.query.view === 'card') {
      // Under `public:courses:*`, so every course or brochure write clears it
      // with the full list (lib/cacheInvalidation).
      const cards = await cacheWrap('public:courses:card', CACHE_TTL.COURSES, async () => {
        const items = await courseRepo.findMany({
          filter: { status: CONTENT_STATUS.PUBLISHED },
          sort: [
            { field: 'order', direction: 1 },
            { field: 'title', direction: 1 },
          ],
          fields: COURSE_CARD_FIELDS,
        });
        return (items as unknown as Record<string, unknown>[]).map(toPublicCourseCard);
      });
      return sendSuccess(res, cards, 'Courses');
    }

    const cacheKey = 'public:courses:all';

    const items = await cacheWrap(cacheKey, CACHE_TTL.COURSES, async () => {
      return courseRepo.findMany({
        filter: { status: CONTENT_STATUS.PUBLISHED },
        sort: [
          { field: 'order', direction: 1 },
          { field: 'title', direction: 1 },
        ],
      });
    });

    // Editorial SEO fields (target keywords, intent notes) never leave the CMS.
    return sendSuccess(res, (items as unknown[]).map(withPublicSeo), 'Courses');
  }),
);

router.get(
  '/courses/:slug',
  validate(slugParam()),
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug.toLowerCase();
    const cacheKey = `public:courses:slug:${slug}`;

    const doc = await cacheWrap(cacheKey, CACHE_TTL.COURSES, async () => {
      const course = await courseRepo.findOne({ slug, status: CONTENT_STATUS.PUBLISHED }, { detail: true });
      if (!course) return course;
      // Whether /brochures/<slug>.pdf has a file to serve, by the lookup the
      // brochure proxy uses (brochure.controller.ts): the course's own URL,
      // else an active row in the brochures table. The site shows its
      // "Download Brochure" button only then; on every other course the button
      // opened "No brochure is available", a 404 Search Console reports.
      const hasBrochure =
        Boolean(course.brochureUrl) || Boolean(await brochureRepo.exists({ courseSlug: slug, isActive: true }));
      return { ...course, hasBrochure };
    });

    if (!doc) throw ApiError.notFound('Course not found');
    return sendSuccess(res, withPublicSeo(doc), 'Course');
  }),
);

/* ── Simple collections (active/published, ordered) ────────────────────── */
/**
 * Hard ceiling on rows returned by an unpaginated public collection.
 *
 * These endpoints deliberately return a whole collection — the marketing site
 * renders all trainers, all FAQs — so there is no page parameter to bound them.
 * Row counts are admin-controlled, so this is not attacker-reachable today; it
 * bounds the payload as content grows rather than defending against a request.
 * Set high enough to be invisible: no collection here is near it.
 */
const PUBLIC_COLLECTION_MAX = toNumberEnv(process.env.PUBLIC_COLLECTION_MAX, 1000);

function toNumberEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const simpleCollection = (
  path: string,
  resource: string,
  loader: () => Promise<unknown[]>,
  label: string,
) =>
  router.get(
    path,
    asyncHandler(async (_req: Request, res: Response) => {
      const cacheKey = `public:${resource}:all`;
      const items = await cacheWrap(cacheKey, CACHE_TTL.SIMPLE, loader);
      const bounded = Array.isArray(items) ? items.slice(0, PUBLIC_COLLECTION_MAX) : items;
      return sendSuccess(res, bounded, label);
    }),
  );

const ORDER_THEN_NAME = [
  { field: 'order', direction: 1 as const },
  { field: 'name', direction: 1 as const },
];
const BY_ORDER = [{ field: 'order', direction: 1 as const }];

simpleCollection(
  '/categories',
  'categories',
  () => blogCategoryRepo.findMany({ sort: ORDER_THEN_NAME }),
  'Categories',
);
simpleCollection(
  '/authors',
  'authors',
  () => authorRepo.findMany({ sort: [{ field: 'name', direction: 1 }] }),
  'Authors',
);
simpleCollection(
  '/trainers',
  'trainers',
  () => trainerRepo.findMany({ filter: { isActive: true }, sort: BY_ORDER }),
  'Trainers',
);
simpleCollection(
  '/testimonials',
  'testimonials',
  () => testimonialRepo.findMany({ filter: { isActive: true }, sort: BY_ORDER }),
  'Testimonials',
);
simpleCollection(
  '/placements',
  'placements',
  () => placementRepo.findMany({ filter: { isActive: true }, sort: BY_ORDER }),
  'Placements',
);
simpleCollection(
  '/companies',
  'companies',
  () => companyRepo.findMany({ filter: { isActive: true }, sort: ORDER_THEN_NAME }),
  'Companies',
);
simpleCollection(
  '/roadmaps',
  'roadmaps',
  () => roadmapRepo.findMany({ filter: { isActive: true }, sort: BY_ORDER }),
  'Roadmaps',
);
simpleCollection(
  '/faqs',
  'faqs',
  () =>
    faqRepo.findMany({
      filter: { isActive: true },
      sort: [
        { field: 'scope', direction: 1 },
        { field: 'order', direction: 1 },
      ],
    }),
  'FAQs',
);
simpleCollection(
  '/comparisons',
  'comparisons',
  () => comparisonRepo.findMany({ filter: { status: CONTENT_STATUS.PUBLISHED }, sort: BY_ORDER }),
  'Comparisons',
);
simpleCollection(
  '/localities',
  'localities',
  () => localityRepo.findMany({ filter: { isActive: true }, sort: ORDER_THEN_NAME }),
  'Localities',
);
simpleCollection(
  '/legal',
  'legal',
  () =>
    legalDocRepo.findMany({
      filter: { status: CONTENT_STATUS.PUBLISHED },
      sort: [{ field: 'title', direction: 1 }],
    }),
  'Legal documents',
);
simpleCollection(
  '/gallery',
  'gallery',
  () => galleryRepo.findMany({ filter: { isActive: true }, sort: BY_ORDER }),
  'Gallery',
);
simpleCollection(
  '/brochures',
  'brochures',
  () =>
    brochureRepo.findMany({
      filter: { isActive: true },
      sort: [{ field: 'createdAt', direction: -1 }],
    }),
  'Brochures',
);

/* ── Brochure proxy (streams PDF from Cloudinary via our domain) ────────── */
// Rate-limited explicitly: app.ts exempts public GETs from the general
// limiter, and unlike the other public reads this one streams a file.
router.get(
  '/brochures/:courseSlug/download',
  publicDownloadLimiter,
  validate(slugParam('courseSlug')),
  brochureProxyController.stream,
);

simpleCollection(
  '/batches',
  'batches',
  () => batchRepo.findMany({ filter: { isActive: true }, sort: BY_ORDER }),
  'Batches',
);

/* ── Single-doc lookups by slug ────────────────────────────────────────── */
router.get(
  '/comparisons/:slug',
  validate(slugParam()),
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug.toLowerCase();
    const cacheKey = `public:comparisons:slug:${slug}`;

    const doc = await cacheWrap(cacheKey, CACHE_TTL.SIMPLE, async () => {
      return comparisonRepo.findOne({ slug, status: CONTENT_STATUS.PUBLISHED });
    });

    if (!doc) throw ApiError.notFound('Comparison not found');
    return sendSuccess(res, doc, 'Comparison');
  }),
);

router.get(
  '/legal/:slug',
  validate(slugParam()),
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug.toLowerCase();
    const cacheKey = `public:legal:slug:${slug}`;

    const doc = await cacheWrap(cacheKey, CACHE_TTL.SIMPLE, async () => {
      return legalDocRepo.findOne({ slug, status: CONTENT_STATUS.PUBLISHED });
    });

    if (!doc) throw ApiError.notFound('Document not found');
    return sendSuccess(res, doc, 'Document');
  }),
);

router.get(
  '/localities/:slug',
  validate(slugParam()),
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug.toLowerCase();
    const cacheKey = `public:localities:slug:${slug}`;

    const doc = await cacheWrap(cacheKey, CACHE_TTL.SIMPLE, async () => {
      return localityRepo.findOne({ slug, isActive: true });
    });

    if (!doc) throw ApiError.notFound('Locality not found');
    return sendSuccess(res, doc, 'Locality');
  }),
);

/* ── Settings ──────────────────────────────────────────────────────────── */
router.get(
  '/settings',
  asyncHandler(async (_req: Request, res: Response) => {
    const settings = await cacheWrap('public:settings', CACHE_TTL.SETTINGS, async () => {
      return settingsRepo.get();
    });
    return sendSuccess(res, settings, 'Settings');
  }),
);

/* ── About page ────────────────────────────────────────────────────────── */
router.get(
  '/about',
  asyncHandler(async (_req: Request, res: Response) => {
    const about = await cacheWrap('public:about', CACHE_TTL.SETTINGS, async () => {
      return aboutPageRepo.get();
    });
    return sendSuccess(res, withPublicSeo(about), 'About page');
  }),
);

/* ── Page SEO overrides ────────────────────────────────────────────────── */
// Search/social overrides for the pages that have no CMS record (fixed pages,
// resource pages, course × locality landings), as { [path]: fields }. One
// small response the site caches and tags `page-seo`; a page with no entry
// renders its built-in title and description. Only paths in the registry are
// served, so a row left behind by a removed page can never resurface.
router.get(
  '/page-seo',
  asyncHandler(async (_req: Request, res: Response) => {
    const data = await cacheWrap('public:page-seo', CACHE_TTL.SIMPLE, async () => {
      const rows = await pageSeoRepo.findMany({});
      const allowed = new Set(PAGE_SEO_PATHS);
      const out: Record<string, Record<string, unknown>> = {};
      for (const row of rows) {
        if (!allowed.has(row.path)) continue;
        const fields = publicOverride(row as unknown as Record<string, unknown>);
        if (Object.keys(fields).length) out[row.path] = fields;
      }
      return out;
    });
    return sendSuccess(res, data, 'Page SEO');
  }),
);

/* ── Public form submissions (website → CMS) ───────────────────────────── */
// The only writes an anonymous caller can reach, so the only ones a spam run
// can target. Limited per address and hourly: a visitor submits one form,
// occasionally two. The contact form's honeypot field stays — IP limiting and
// a honeypot cover each other's blind spot (a NAT shares one budget, a botnet
// has many addresses but usually one script), and neither is the whole answer.
router.post(
  '/demo-requests',
  publicWriteLimiter,
  chatWriteLimiter,
  honeypotGuard,
  validate(demoRequestValidator),
  demoRequestController.create,
);
router.post(
  '/contact',
  publicWriteLimiter,
  chatWriteLimiter,
  honeypotGuard,
  validate(contactEnquiryValidator),
  contactEnquiryController.create,
);

// Website chat widget: opened with the visitor's name, then updated after each
// answer. Its own limiter - see chatWriteLimiter.
router.post(
  '/chat-enquiries',
  chatWriteLimiter,
  honeypotGuard,
  validate(chatEnquiryCreateValidator),
  chatEnquiryController.create,
);
// POST, not PATCH: the public CORS policy allows GET and POST only, and widening
// it for one route would loosen it for the whole public surface.
router.post(
  '/chat-enquiries/:id',
  chatWriteLimiter,
  validate([...uuidParam(), ...chatEnquiryUpdateValidator]),
  chatEnquiryController.publicUpdate,
);

export default router;
