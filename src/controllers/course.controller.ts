import { Request, Response } from 'express';
import { courseService } from '../services/course.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/ApiResponse';
import { parseListParams } from '../utils/queryFeatures';
import { ApiError } from '../utils/ApiError';
import { invalidateResource } from '../lib/cacheInvalidation';
import { bulkSetStatus } from '../lib/bulkStatus';
import { recordSeoAudit } from '../lib/seoAudit';
import { ROLES, type ContentStatus } from '../constants';
import type { ICourse } from '../interfaces/common';
import { SEO_FIELDS, changedFields, changesRobots, robotsProblem, type SeoValues } from '../seo/seoFields';
import { courseFallback } from '../seo/pageSeoRegistry';

const asDoc = (doc: unknown) => doc as Record<string, unknown> | null;

/**
 * Course SEO rules that need the stored record, so they cannot live in the
 * validator:
 *  • only an administrator may change noindex/nofollow (content writers edit
 *    every other course field, SEO text included);
 *  • nofollow is only allowed together with noindex, judged on the merged
 *    result of the stored values and this write.
 */
function guardCourseSeo(req: Request, before: SeoValues | null | undefined) {
  const incoming = (req.body as { seo?: SeoValues | null }).seo;
  if (!incoming) return;
  if (changesRobots(before, incoming) && req.user?.role !== ROLES.ADMIN) {
    throw ApiError.forbidden('Only administrators can change whether a page is indexed');
  }
  const merged = { ...(before ?? {}), ...incoming };
  const problem = robotsProblem(merged);
  if (problem) throw ApiError.unprocessable('Validation failed', [{ field: 'seo.nofollow', message: problem }]);
}

const seoOf = (doc: unknown) => ((doc as { seo?: Record<string, unknown> } | null)?.seo ?? null) as Record<string, unknown> | null;

const LIST_FILTERS = ['status', 'category', 'featured'];

export const courseController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const params = parseListParams(req.query as Record<string, unknown>, LIST_FILTERS);
    const { items, meta } = await courseService.list(params);
    return sendSuccess(res, items, 'Courses fetched', 200, meta);
  }),
  getById: asyncHandler(async (req: Request, res: Response) => {
    const doc = await courseService.getById(req.params.id);
    // The title/description the site renders when the course's SEO fields are
    // empty, for the admin's preview (seo/pageSeoRegistry.ts, parity-tested
    // against the site). Read-only: the course form never sends it back.
    const seoFallback = courseFallback({
      title: doc.title,
      tagline: doc.tagline ?? '',
      duration: doc.duration ?? '',
      modules: doc.modules ?? [],
      tools: doc.tools ?? [],
    });
    return sendSuccess(res, { ...doc, seoFallback }, 'Course fetched');
  }),
  getBySlug: asyncHandler(async (req: Request, res: Response) => {
    const doc = await courseService.getOne({ slug: req.params.slug.toLowerCase() });
    if (!doc) throw ApiError.notFound('Course not found');
    return sendSuccess(res, doc, 'Course fetched');
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    guardCourseSeo(req, null);
    const doc = await courseService.createCourse(req.body);
    const changed = changedFields(null, seoOf(doc), SEO_FIELDS);
    if (changed.length) {
      await recordSeoAudit({
        entityType: 'course',
        entityKey: `/courses/${doc.slug}`,
        recordId: doc.id,
        action: 'create',
        changedFields: changed,
        editorId: req.user?.id,
      });
    }
    await invalidateResource('courses', { after: asDoc(doc) });
    return sendCreated(res, doc, 'Course created');
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    // The prior record decides whether the change was public (saving an
    // unpublished draft is not) and supplies the old slug after a rename.
    const before = await courseService.getById(req.params.id);
    guardCourseSeo(req, seoOf(before) as SeoValues | null);
    const doc = await courseService.updateCourse(req.params.id, req.body);
    await recordSeoAudit({
      entityType: 'course',
      entityKey: `/courses/${doc.slug}`,
      recordId: doc.id,
      action: 'update',
      changedFields: changedFields(seoOf(before), seoOf(doc), SEO_FIELDS),
      editorId: req.user?.id,
    });
    await invalidateResource('courses', { before: asDoc(before), after: asDoc(doc) });
    return sendSuccess(res, doc, 'Course updated');
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    const before = await courseService.getById(req.params.id);
    await courseService.remove(req.params.id);
    await invalidateResource('courses', { before: asDoc(before), after: null });
    return sendNoContent(res);
  }),

  /**
   * Several courses to one status: each through update's own steps
   * (updateCourse, the SEO audit, which skips a status-only change), then one
   * site refresh for all of them. No `seo` in the body, so guardCourseSeo has
   * nothing to check.
   */
  bulkStatus: asyncHandler(async (req: Request, res: Response) => {
    const { ids, status } = req.body as { ids: string[]; status: ContentStatus };
    const result = await bulkSetStatus<ICourse>({
      resource: 'courses',
      ids,
      status,
      load: (id) => courseService.getById(id),
      save: async (id, next, before) => {
        const doc = await courseService.updateCourse(id, { status: next } as Partial<ICourse>);
        await recordSeoAudit({
          entityType: 'course',
          entityKey: `/courses/${doc.slug}`,
          recordId: doc.id,
          action: 'update',
          changedFields: changedFields(seoOf(before), seoOf(doc), SEO_FIELDS),
          editorId: req.user?.id,
        });
        return doc;
      },
    });
    return sendSuccess(res, result, 'Course statuses updated');
  }),
};
