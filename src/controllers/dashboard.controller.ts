import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/ApiResponse';
import {
  blogRepo,
  courseRepo,
  trainerRepo,
  testimonialRepo,
  placementRepo,
  companyRepo,
  blogCategoryRepo,
  contactEnquiryRepo,
  chatEnquiryRepo,
  demoRequestRepo,
  galleryRepo,
  brochureRepo,
  authorRepo,
  courseCategoryRepo,
  batchRepo,
  comparisonRepo,
  localityRepo,
  faqRepo,
  roadmapRepo,
  legalDocRepo,
} from '../repositories';
import { CONTENT_STATUS, LEAD_STATUS, type Role } from '../constants';
import { cacheWrap, CACHE_TTL } from '../lib/cache';
import { DASHBOARD_PULSE_KEY } from '../lib/cacheInvalidation';
import {
  activity as activityFeed,
  attention as attentionQueue,
  canSeeContent,
  canSeeLeads,
  pulse,
  systemStatus,
  trends as trendSeries,
  type ActivityKind,
  type TrendRange,
} from '../services/dashboard.service';
import { blogOverview, coursesOverview, leadsOverview, peopleOverview, websiteOverview } from '../services/dashboardSections.service';

export const DASHBOARD_STATS_KEY = 'admin:dashboard:stats';

async function computeStats() {
  // Each count is a HEAD request with count=exact — the PostgREST
  // equivalent of countDocuments(), still issued in parallel.
  const [
    totalBlogs,
    publishedBlogs,
    draftBlogs,
    totalCourses,
    publishedCourses,
    draftCourses,
    totalTrainers,
    totalTestimonials,
    totalPlacements,
    totalCompanies,
    totalCategories,
    totalEnquiries,
    newEnquiries,
    totalDemoRequests,
    newDemoRequests,
    totalChatEnquiries,
    newChatEnquiries,
    galleryCount,
    brochureCount,
    authors,
    courseCategories,
    activeBatches,
    comparisons,
    localities,
    faqs,
    roadmaps,
    legalDocs,
  ] = await Promise.all([
    blogRepo.count(),
    blogRepo.count({ status: CONTENT_STATUS.PUBLISHED }),
    blogRepo.count({ status: CONTENT_STATUS.DRAFT }),
    courseRepo.count(),
    courseRepo.count({ status: CONTENT_STATUS.PUBLISHED }),
    courseRepo.count({ status: CONTENT_STATUS.DRAFT }),
    trainerRepo.count(),
    testimonialRepo.count(),
    placementRepo.count(),
    companyRepo.count(),
    blogCategoryRepo.count(),
    contactEnquiryRepo.count(),
    contactEnquiryRepo.count({ status: LEAD_STATUS.NEW }),
    demoRequestRepo.count(),
    demoRequestRepo.count({ status: LEAD_STATUS.NEW }),
    chatEnquiryRepo.count(),
    chatEnquiryRepo.count({ status: LEAD_STATUS.NEW }),
    galleryRepo.count(),
    brochureRepo.count(),
    authorRepo.count(),
    courseCategoryRepo.count(),
    batchRepo.count({ isActive: true }),
    comparisonRepo.count(),
    localityRepo.count(),
    faqRepo.count(),
    roadmapRepo.count(),
    legalDocRepo.count(),
  ]);

  const [recentBlogs, recentCourses, recentEnquiries, recentDemoRequests] = await Promise.all([
    blogRepo.findMany({
      sort: [{ field: 'updatedAt', direction: -1 }],
      limit: 5,
      fields: ['title', 'slug', 'status', 'category', 'updatedAt', 'date'],
    }),
    courseRepo.findMany({
      sort: [{ field: 'updatedAt', direction: -1 }],
      limit: 5,
      fields: ['title', 'slug', 'status', 'updatedAt'],
    }),
    contactEnquiryRepo.findMany({
      sort: [{ field: 'createdAt', direction: -1 }],
      limit: 5,
      fields: ['name', 'email', 'course', 'status', 'createdAt'],
    }),
    demoRequestRepo.findMany({
      sort: [{ field: 'createdAt', direction: -1 }],
      limit: 5,
      fields: ['name', 'phone', 'course', 'status', 'createdAt'],
    }),
  ]);

  // Storage estimate: image/document counts (binary lives in Cloudinary,
  // not in the database — that has not changed).
  const mediaAssets = galleryCount + brochureCount;

  return {
    // When these numbers were read. A cache hit keeps the original time, so
    // the dashboard can say how old they are.
    generatedAt: new Date().toISOString(),
    counts: {
      blogs: totalBlogs,
      publishedBlogs,
      draftBlogs,
      courses: totalCourses,
      publishedCourses,
      draftCourses,
      trainers: totalTrainers,
      testimonials: totalTestimonials,
      placements: totalPlacements,
      companies: totalCompanies,
      categories: totalCategories,
      enquiries: totalEnquiries,
      newEnquiries,
      demoRequests: totalDemoRequests,
      newDemoRequests,
      chatEnquiries: totalChatEnquiries,
      newChatEnquiries,
      gallery: galleryCount,
      brochures: brochureCount,
      mediaAssets,
      authors,
      courseCategories,
      activeBatches,
      comparisons,
      localities,
      faqs,
      roadmaps,
      legalDocs,
    },
    recent: {
      blogs: recentBlogs,
      courses: recentCourses,
      enquiries: recentEnquiries,
      demoRequests: recentDemoRequests,
    },
  };
}

export type DashboardStatsData = Awaited<ReturnType<typeof computeStats>>;

/**
 * The cached payload as one caller may see it.
 *
 * Filtered on the way OUT, not by fetching less: the cache entry is shared by
 * every caller under one key, so a role-dependent *cached* payload would serve
 * whichever role warmed it to everyone after. `data` belongs to the cache and
 * is never mutated here — only copied.
 *
 * The recent lists carry lead names, emails and phone numbers (LEAD_ROLES only
 * on /enquiries and /demo-requests) and unpublished titles (CONTENT_ROLES only
 * on /blogs and /courses), so the same rule applies here. The lists are
 * emptied rather than omitted: the shape of the response is part of the API
 * contract. The headline counts stay visible to every role (aggregates, not
 * personal data — see tests/authorization.test.ts).
 */
export function scopeStats(data: DashboardStatsData, role: Role | undefined) {
  const mayReadLeads = canSeeLeads(role);
  const mayReadContent = canSeeContent(role);
  return {
    ...data,
    cacheTtlSeconds: CACHE_TTL.DASHBOARD,
    recent: {
      blogs: mayReadContent ? data.recent.blogs : [],
      // An entry cached before this list existed has no `courses`.
      courses: mayReadContent ? (data.recent.courses ?? []) : [],
      enquiries: mayReadLeads ? data.recent.enquiries : [],
      demoRequests: mayReadLeads ? data.recent.demoRequests : [],
    },
  };
}

export const dashboardController = {
  /**
   * Headline counts and recent records for the dashboard home.
   *
   * This endpoint carries `requireAuth` but no `authorize`, because every role
   * has a dashboard — but it aggregates modules that are NOT open to every
   * role, so the recent lists are scoped by `scopeStats` on the way out.
   */
  stats: asyncHandler(async (req: Request, res: Response) => {
    const data = await cacheWrap(DASHBOARD_STATS_KEY, CACHE_TTL.DASHBOARD, computeStats);
    return sendSuccess(res, scopeStats(data, req.user?.role), 'Dashboard stats fetched');
  }),

  /** Website, database and (administrators) integration status. */
  status: asyncHandler(async (req: Request, res: Response) => {
    return sendSuccess(res, await systemStatus(req.user?.role), 'System status');
  }),

  /** Work waiting for someone, scoped to what the caller's role may open. */
  attention: asyncHandler(async (req: Request, res: Response) => {
    return sendSuccess(res, await attentionQueue(req.user?.role), 'Dashboard attention');
  }),

  /** Whether the leads have changed, for a page checking in the background (lead roles; see the route). */
  pulse: asyncHandler(async (_req: Request, res: Response) => {
    return sendSuccess(res, await cacheWrap(DASHBOARD_PULSE_KEY, CACHE_TTL.PULSE, () => pulse()), 'Dashboard pulse');
  }),

  /** SEO changes and site refreshes, newest first (administrators; see the route). */
  activity: asyncHandler(async (req: Request, res: Response) => {
    const kind = (req.query.kind as ActivityKind | undefined) ?? 'all';
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    return sendSuccess(res, await activityFeed(kind, limit), 'Dashboard activity');
  }),

  /** Daily lead and publishing counts over 7, 30 or 90 days. */
  trends: asyncHandler(async (req: Request, res: Response) => {
    const days = (req.query.range ? Number(req.query.range) : 30) as TrendRange;
    const tz = req.query.tz ? Number(req.query.tz) : 0;
    return sendSuccess(res, await trendSeries(req.user?.role, days, tz), 'Dashboard trends');
  }),

  /*
    One overview per sidebar section. The router allows each to the roles that
    may open that section's pages; the service leaves out parts that belong to
    a module the caller's role may not open.
  */
  leadsOverview: asyncHandler(async (req: Request, res: Response) => {
    const { days, tz } = rangeParams(req);
    return sendSuccess(res, await leadsOverview(days, tz), 'Leads overview');
  }),
  blogOverview: asyncHandler(async (req: Request, res: Response) => {
    const { days, tz } = rangeParams(req);
    return sendSuccess(res, await blogOverview(days, tz), 'Blog overview');
  }),
  coursesOverview: asyncHandler(async (req: Request, res: Response) => {
    const { days, tz } = rangeParams(req);
    return sendSuccess(res, await coursesOverview(req.user?.role, days, tz), 'Courses overview');
  }),
  websiteOverview: asyncHandler(async (_req: Request, res: Response) => {
    return sendSuccess(res, await websiteOverview(), 'Website overview');
  }),
  peopleOverview: asyncHandler(async (_req: Request, res: Response) => {
    return sendSuccess(res, await peopleOverview(), 'People and proof overview');
  }),
};

/** ?range=7|30|90 (default 30) and ?tz=<minutes east of UTC>, already validated by the router. */
function rangeParams(req: Request): { days: TrendRange; tz: number } {
  return { days: (req.query.range ? Number(req.query.range) : 30) as TrendRange, tz: req.query.tz ? Number(req.query.tz) : 0 };
}
