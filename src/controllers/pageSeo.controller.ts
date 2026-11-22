import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess, sendNoContent } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { CONTENT_STATUS, ROLES } from '../constants';
import {
  aboutPageRepo,
  comparisonRepo,
  courseRepo,
  legalDocRepo,
  localityRepo,
  pageSeoRepo,
  seoAuditRepo,
} from '../repositories';
import type { IPageSeo } from '../interfaces/common';
import {
  LEGAL_SLUGS,
  ROUTE_KEYED_PAGES,
  SEO_GUIDANCE,
  SEO_LIMITS,
  comparisonFallback,
  courseFallback,
  landingFallback,
  routeKeyedPage,
  type PageKind,
  type SeoFallback,
  type SeoStorage,
} from '../seo/pageSeoRegistry';
import { SEO_FIELDS, changedFields, changesRobots, robotsProblem, type SeoValues } from '../seo/seoFields';
import { CHECKS, checkPages, summarize, type CheckPage } from '../seo/pageChecks';
import { recordSeoAudit } from '../lib/seoAudit';
import { cacheWrap, CACHE_TTL } from '../lib/cache';
import { PAGE_SEO_ENTRIES_KEY, invalidateResource } from '../lib/cacheInvalidation';

/**
 * Page SEO — one list of every non-blog page with editable SEO, and the
 * read/write endpoints for the pages whose SEO is stored by path.
 *
 *   GET    /page-seo                → every page: storage, fallback, override, effective values
 *   GET    /page-seo/checks         → the SEO checks (seo/pageChecks.ts) over the same pages
 *   GET    /page-seo/entry?path=    → one page, plus its recent SEO audit history
 *   PUT    /page-seo                → { path, ...fields } replace a route-keyed page's overrides
 *   DELETE /page-seo?path=          → reset a route-keyed page to its built-in defaults
 *
 * Course, comparison and legal pages are listed here but edited on their own
 * record (their SEO lives there), so PUT/DELETE refuse them with a pointer.
 * The router restricts all of this to administrators.
 */

export interface PageSeoEntry {
  path: string;
  kind: PageKind;
  storage: SeoStorage;
  label: string;
  primaryIntent: string | null;
  /** Where to edit it in the admin. */
  adminPath: string;
  /** False when the page currently 404s (unpublished, or a landing's course/locality is missing). */
  live: boolean;
  /** Stored values, editorial ones included (admin only). Null when nothing is saved. */
  override: SeoValues | null;
  /** What the page shows for an unset field. Null when it cannot be computed (page not live). */
  fallback: SeoFallback | null;
  effective: { title: string | null; description: string | null; noindex: boolean; nofollow: boolean };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The SEO fields of a stored group, normalised to the editor's shape. */
function pickSeo(src: Record<string, unknown> | null | undefined): SeoValues | null {
  if (!src) return null;
  const out: SeoValues = {
    metaTitle: (src.metaTitle as string) || null,
    metaDescription: (src.metaDescription as string) || null,
    ogTitle: (src.ogTitle as string) || null,
    ogDescription: (src.ogDescription as string) || null,
    ogImage: (src.ogImage as string) || null,
    ogImageAlt: (src.ogImageAlt as string) || null,
    keywords: Array.isArray(src.keywords) ? (src.keywords as string[]) : [],
    noindex: Boolean(src.noindex),
    nofollow: Boolean(src.nofollow),
    intentNote: (src.intentNote as string) || null,
  };
  return hasAny(out) ? out : null;
}

/** True when at least one field departs from "use the default". */
function hasAny(v: SeoValues): boolean {
  return SEO_FIELDS.some((f) => {
    const x = v[f];
    return Array.isArray(x) ? x.length > 0 : x !== null && x !== undefined && x !== false && x !== '';
  });
}

function effective(override: SeoValues | null, fallback: SeoFallback | null) {
  return {
    title: override?.metaTitle || fallback?.title || null,
    description: override?.metaDescription || fallback?.description || null,
    noindex: Boolean(override?.noindex),
    nofollow: Boolean(override?.nofollow),
  };
}

/** A PUT body as the full set of fields; anything omitted is cleared. */
function fullReplace(body: Record<string, unknown>): SeoValues {
  return {
    metaTitle: (body.metaTitle as string | null | undefined) ?? null,
    metaDescription: (body.metaDescription as string | null | undefined) ?? null,
    ogTitle: (body.ogTitle as string | null | undefined) ?? null,
    ogDescription: (body.ogDescription as string | null | undefined) ?? null,
    ogImage: (body.ogImage as string | null | undefined) ?? null,
    ogImageAlt: (body.ogImageAlt as string | null | undefined) ?? null,
    keywords: (body.keywords as string[] | undefined) ?? [],
    noindex: Boolean(body.noindex),
    nofollow: Boolean(body.nofollow),
    intentNote: (body.intentNote as string | null | undefined) ?? null,
  };
}

const EMPTY_SEO: SeoValues = fullReplace({});

/* ── Building the list ────────────────────────────────────────────────────── */

export async function buildEntries(): Promise<PageSeoEntry[]> {
  const [rows, about, courses, localities, comparisons, legalDocs] = await Promise.all([
    pageSeoRepo.findMany({ sort: [{ field: 'path', direction: 1 }] }),
    aboutPageRepo.get(),
    courseRepo.findMany({
      fields: ['slug', 'title', 'tagline', 'duration', 'modules', 'tools', 'status', 'seo'],
      sort: [{ field: 'order', direction: 1 }, { field: 'title', direction: 1 }],
    }),
    localityRepo.findMany({ fields: ['slug', 'name', 'isActive'] }),
    comparisonRepo.findMany({
      fields: ['slug', 'title', 'intro', 'status', 'metaTitle', 'metaDescription'],
      sort: [{ field: 'order', direction: 1 }],
    }),
    legalDocRepo.findMany({
      fields: ['slug', 'title', 'intro', 'status', 'metaTitle', 'metaDescription'],
      sort: [{ field: 'title', direction: 1 }],
    }),
  ]);

  const rowByPath = new Map(rows.map((r) => [r.path, r]));
  // The site reads published courses and active localities only.
  const liveCourse = new Map(
    courses.filter((c) => c.status === CONTENT_STATUS.PUBLISHED).map((c) => [c.slug, c]),
  );
  const liveLocality = new Map(localities.filter((l) => l.isActive !== false).map((l) => [l.slug, l]));

  const entries: PageSeoEntry[] = [];

  for (const page of ROUTE_KEYED_PAGES) {
    let fallback = page.fallback ?? null;
    let live = true;
    if (page.kind === 'landing') {
      const course = liveCourse.get(page.courseSlug ?? '');
      const loc = liveLocality.get(page.localitySlug ?? '');
      live = Boolean(course && loc);
      fallback =
        course && loc
          ? landingFallback({
              courseTitle: course.title,
              tagline: course.tagline ?? '',
              duration: course.duration ?? '',
              localityName: loc.name,
              localitySlug: loc.slug,
            })
          : null;
    }
    const row = page.storage === 'page' ? rowByPath.get(page.path) : undefined;
    const override = page.storage === 'about' ? pickSeo(about.seo as Record<string, unknown>) : pickSeo(row as never);
    entries.push({
      path: page.path,
      kind: page.kind,
      storage: page.storage,
      label: page.label,
      primaryIntent: page.primaryIntent ?? null,
      adminPath: `/page-seo/edit?path=${encodeURIComponent(page.path)}`,
      live,
      override,
      fallback,
      effective: effective(override, fallback),
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      updatedBy: row?.editor?.name ?? null,
    });
  }

  for (const c of courses) {
    const override = pickSeo(c.seo as unknown as Record<string, unknown>);
    const fallback = courseFallback({
      title: c.title,
      tagline: c.tagline ?? '',
      duration: c.duration ?? '',
      modules: c.modules ?? [],
      tools: c.tools ?? [],
    });
    entries.push({
      path: `/courses/${c.slug}`,
      kind: 'course',
      storage: 'course',
      label: `Course — ${c.title}`,
      primaryIntent: null,
      adminPath: `/courses/${c.id}#seo`,
      live: c.status === CONTENT_STATUS.PUBLISHED,
      override,
      fallback,
      effective: effective(override, fallback),
      updatedAt: null,
      updatedBy: null,
    });
  }

  for (const c of comparisons) {
    const override = pickSeo({ metaTitle: c.metaTitle, metaDescription: c.metaDescription });
    const fallback = comparisonFallback({ title: c.title, intro: c.intro ?? '' });
    entries.push({
      path: `/compare/${c.slug}`,
      kind: 'comparison',
      storage: 'comparison',
      label: `Comparison — ${c.title}`,
      primaryIntent: null,
      adminPath: `/comparisons/${c.id}`,
      live: c.status === CONTENT_STATUS.PUBLISHED,
      override,
      fallback,
      effective: effective(override, fallback),
      updatedAt: null,
      updatedBy: null,
    });
  }

  for (const d of legalDocs) {
    if (!LEGAL_SLUGS.includes(d.slug)) continue; // not a page the site routes
    const override = pickSeo({ metaTitle: d.metaTitle, metaDescription: d.metaDescription });
    const fallback = { title: d.title, description: d.intro ?? '' };
    entries.push({
      path: `/${d.slug}`,
      kind: 'legal',
      storage: 'legal',
      label: `Policy — ${d.title}`,
      primaryIntent: null,
      adminPath: `/legal?edit=${d.id}`,
      live: d.status === CONTENT_STATUS.PUBLISHED,
      override,
      fallback,
      effective: effective(override, fallback),
      updatedAt: null,
      updatedBy: null,
    });
  }

  return entries;
}

/**
 * The page list is six reads, and the dashboard, Page SEO and SEO health all
 * want it. Every write that feeds it clears this key (lib/cacheInvalidation.ts).
 */
const cachedEntries = () => cacheWrap(PAGE_SEO_ENTRIES_KEY, CACHE_TTL.PAGE_SEO, buildEntries);

/* ── Handlers ─────────────────────────────────────────────────────────────── */

async function history(path: string) {
  const items = await seoAuditRepo.findMany({
    filter: { entityKey: path },
    sort: [{ field: 'createdAt', direction: -1 }],
    limit: 20,
  });
  return items.map((h) => ({
    action: h.action,
    changedFields: h.changedFields,
    editor: h.editor?.name ?? null,
    at: h.createdAt,
  }));
}

/** A page as the SEO checks read it: what it renders now, and whether that text is saved or built in. */
function checkInput(e: PageSeoEntry): CheckPage {
  return {
    path: e.path,
    live: e.live,
    saved: e.override !== null,
    title: e.effective.title,
    titleSource: e.override?.metaTitle ? 'custom' : 'default',
    description: e.effective.description,
    descriptionSource: e.override?.metaDescription ? 'custom' : 'default',
    noindex: e.effective.noindex,
    nofollow: e.effective.nofollow,
  };
}

function requireRouteKeyed(path: string) {
  const page = routeKeyedPage(path);
  if (!page) {
    throw ApiError.unprocessable('Validation failed', [
      {
        field: 'path',
        message: /^\/(courses|compare)\/[a-z0-9]+(-[a-z0-9]+)*$/.test(path)
          ? 'This page’s SEO is stored on its course or comparison record — edit it there'
          : 'Not a page whose SEO is edited here',
      },
    ]);
  }
  return page;
}

export const pageSeoController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    const pages = await cachedEntries();
    return sendSuccess(res, { limits: SEO_LIMITS, guidance: SEO_GUIDANCE, pages }, 'Page SEO');
  }),

  /**
   * Computed from the saved values, so nothing can go stale: a save clears the
   * cached page list these read. Pages carry what the checks read and where to
   * fix them; stored overrides (editorial keywords, intent notes) are left out,
   * because no check needs them.
   */
  checks: asyncHandler(async (_req: Request, res: Response) => {
    const entries = await cachedEntries();
    const inputs = entries.map(checkInput);
    const findings = checkPages(inputs);
    return sendSuccess(
      res,
      {
        generatedAt: new Date().toISOString(),
        checks: CHECKS,
        summary: summarize(inputs, findings),
        pages: entries.map((e, i) => ({
          ...inputs[i],
          label: e.label,
          kind: e.kind,
          storage: e.storage,
          adminPath: e.adminPath,
        })),
        findings,
      },
      'Page SEO checks',
    );
  }),

  entry: asyncHandler(async (req: Request, res: Response) => {
    const path = String(req.query.path ?? '');
    const page = (await cachedEntries()).find((p) => p.path === path);
    if (!page) throw ApiError.notFound('No editable page at that path');
    return sendSuccess(
      res,
      { limits: SEO_LIMITS, guidance: SEO_GUIDANCE, page, history: await history(path) },
      'Page SEO entry',
    );
  }),

  upsert: asyncHandler(async (req: Request, res: Response) => {
    const path = String(req.body.path);
    const page = requireRouteKeyed(path);
    const values = fullReplace(req.body as Record<string, unknown>);

    const problem = robotsProblem(values);
    if (problem) throw ApiError.unprocessable('Validation failed', [{ field: 'nofollow', message: problem }]);

    if (page.storage === 'about') {
      const about = await aboutPageRepo.get();
      const before = pickSeo(about.seo as Record<string, unknown>) ?? EMPTY_SEO;
      // Defence in depth: the router is admin-only today.
      if (changesRobots(before, values) && req.user?.role !== ROLES.ADMIN) {
        throw ApiError.forbidden('Only administrators can change whether a page is indexed');
      }
      const updated = await aboutPageRepo.update({ seo: values });
      const after = pickSeo(updated.seo as Record<string, unknown>) ?? EMPTY_SEO;
      await recordSeoAudit({
        entityType: 'about',
        entityKey: path,
        recordId: updated.id,
        action: 'update',
        changedFields: changedFields(before as never, after as never, SEO_FIELDS),
        editorId: req.user?.id,
      });
      await invalidateResource('about');
    } else {
      const existing = await pageSeoRepo.findOne({ path });
      const before = pickSeo(existing as never) ?? EMPTY_SEO;
      if (changesRobots(before, values) && req.user?.role !== ROLES.ADMIN) {
        throw ApiError.forbidden('Only administrators can change whether a page is indexed');
      }
      const changed = changedFields(before as never, values as never, SEO_FIELDS);

      let saved: IPageSeo | null = null;
      if (!hasAny(values)) {
        // Saving an all-default form is a reset: no row means "use the defaults".
        if (existing) await pageSeoRepo.deleteById(existing.id);
      } else {
        saved = await pageSeoRepo.upsertOn('path', { path, ...values, updatedBy: req.user?.id ?? null });
      }
      await recordSeoAudit({
        entityType: 'page_seo',
        entityKey: path,
        recordId: saved?.id ?? existing?.id ?? null,
        action: !existing ? 'create' : saved ? 'update' : 'delete',
        changedFields: changed,
        editorId: req.user?.id,
      });
      if (changed.length) await invalidateResource('page-seo', { before: existing as never, after: saved as never });
    }

    const entry = (await buildEntries()).find((p) => p.path === path);
    return sendSuccess(res, entry, 'Page SEO saved');
  }),

  reset: asyncHandler(async (req: Request, res: Response) => {
    const path = String(req.query.path ?? '');
    const page = requireRouteKeyed(path);

    if (page.storage === 'about') {
      const about = await aboutPageRepo.get();
      const before = pickSeo(about.seo as Record<string, unknown>);
      if (before) {
        if (changesRobots(before, EMPTY_SEO) && req.user?.role !== ROLES.ADMIN) {
          throw ApiError.forbidden('Only administrators can change whether a page is indexed');
        }
        await aboutPageRepo.update({ seo: EMPTY_SEO });
        await recordSeoAudit({
          entityType: 'about',
          entityKey: path,
          recordId: about.id,
          action: 'delete',
          changedFields: changedFields(before as never, EMPTY_SEO as never, SEO_FIELDS),
          editorId: req.user?.id,
        });
        await invalidateResource('about');
      }
      return sendNoContent(res);
    }

    const existing = await pageSeoRepo.findOne({ path });
    if (existing) {
      const before = pickSeo(existing as never) ?? EMPTY_SEO;
      if (changesRobots(before, EMPTY_SEO) && req.user?.role !== ROLES.ADMIN) {
        throw ApiError.forbidden('Only administrators can change whether a page is indexed');
      }
      await pageSeoRepo.deleteById(existing.id);
      await recordSeoAudit({
        entityType: 'page_seo',
        entityKey: path,
        recordId: existing.id,
        action: 'delete',
        changedFields: changedFields(before as never, EMPTY_SEO as never, SEO_FIELDS),
        editorId: req.user?.id,
      });
      await invalidateResource('page-seo', { before: existing as never, after: null });
    }
    return sendNoContent(res);
  }),
};

/** Exposed for tests. */
export const __test = { pickSeo, fullReplace, hasAny, effective, buildEntries, checkInput };
