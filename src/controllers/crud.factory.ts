import { Request, Response } from 'express';
import { CrudService } from '../services/CrudService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/ApiResponse';
import { parseListParams } from '../utils/queryFeatures';
import { RequestHandler } from 'express';
import { invalidateResource } from '../lib/cacheInvalidation';
import { bulkSetStatus } from '../lib/bulkStatus';
import { recordSeoAudit } from '../lib/seoAudit';
import { changedFields } from '../seo/seoFields';
import type { ContentStatus } from '../constants';
import type { SeoAuditEntity } from '../interfaces/common';

const asDoc = (doc: unknown) => doc as Record<string, unknown> | null;

/** The SEO fields a record-backed page keeps on its own row (comparisons, legal). */
const RECORD_SEO_FIELDS = ['metaTitle', 'metaDescription'] as const;

export interface CrudControllerConfig {
  /** Query params accepted as exact-match filters on list. */
  allowedFilters?: string[];
  /** Human label used in success messages, e.g. "Course". */
  label: string;
  /** Resource name used for cache invalidation (e.g. "trainers"). */
  resourceName?: string;
  /** Optionally transform the incoming body before create/update. */
  transformBody?: (body: Record<string, unknown>, req: Request) => Record<string, unknown>;
  /**
   * Record changes to the row's metaTitle/metaDescription in seo_audit_log,
   * keyed by the page path the row is published at.
   */
  seoAudit?: { entityType: SeoAuditEntity; path: (doc: Record<string, unknown>) => string };
}

export interface CrudHandlers {
  list: RequestHandler;
  getById: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  /** POST /bulk-status — mounted only for resources with a content status (registry `bulkStatus`). */
  bulkStatus: RequestHandler;
}

/**
 * Build a standard set of REST handlers for a resource. Modules with bespoke
 * behaviour (Blog, Auth) implement their own controllers; everything else uses
 * this factory to avoid duplicating identical logic 15+ times.
 */
export function createCrudController<T>(
  service: CrudService<T>,
  config: CrudControllerConfig,
): CrudHandlers {
  const { label, allowedFilters = [], transformBody, resourceName, seoAudit } = config;

  const auditSeo = async (
    req: Request,
    action: 'create' | 'update' | 'delete',
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) => {
    const doc = after ?? before;
    if (!seoAudit || !doc) return;
    const changed = changedFields(before, after, RECORD_SEO_FIELDS);
    if (!changed.length) return;
    await recordSeoAudit({
      entityType: seoAudit.entityType,
      entityKey: seoAudit.path(doc),
      recordId: (doc.id as string) ?? null,
      action,
      changedFields: changed,
      editorId: req.user?.id,
    });
  };

  const list = asyncHandler(async (req: Request, res: Response) => {
    const params = parseListParams(req.query as Record<string, unknown>, allowedFilters);
    const { items, meta } = await service.list(params);
    return sendSuccess(res, items, `${label} list fetched`, 200, meta);
  });

  const getById = asyncHandler(async (req: Request, res: Response) => {
    const doc = await service.getById(req.params.id);
    return sendSuccess(res, doc, `${label} fetched`);
  });

  const create = asyncHandler(async (req: Request, res: Response) => {
    const body = transformBody ? transformBody(req.body, req) : req.body;
    const doc = await service.create(body as Partial<T>);
    await auditSeo(req, 'create', null, asDoc(doc));
    if (resourceName) await invalidateResource(resourceName, { after: asDoc(doc) });
    return sendCreated(res, doc, `${label} created`);
  });

  const update = asyncHandler(async (req: Request, res: Response) => {
    const body = transformBody ? transformBody(req.body, req) : req.body;
    // The prior record decides whether the change was public (an unpublished
    // draft saved again is not) and supplies the old slug after a rename.
    const before = resourceName || seoAudit ? await service.getById(req.params.id) : null;
    const doc = await service.update(req.params.id, body as Partial<T>);
    await auditSeo(req, 'update', asDoc(before), asDoc(doc));
    if (resourceName) await invalidateResource(resourceName, { before: asDoc(before), after: asDoc(doc) });
    return sendSuccess(res, doc, `${label} updated`);
  });

  const remove = asyncHandler(async (req: Request, res: Response) => {
    const before = resourceName || seoAudit ? await service.getById(req.params.id) : null;
    await service.remove(req.params.id);
    await auditSeo(req, 'delete', asDoc(before), null);
    if (resourceName) await invalidateResource(resourceName, { before: asDoc(before), after: null });
    return sendNoContent(res);
  });

  /**
   * Several records to one status: each goes through update's own steps
   * (transformBody, service.update, the SEO audit), then the site and caches
   * are refreshed once for all of them (lib/bulkStatus).
   */
  const bulkStatus = asyncHandler(async (req: Request, res: Response) => {
    const { ids, status } = req.body as { ids: string[]; status: ContentStatus };
    const result = await bulkSetStatus<Record<string, unknown>>({
      resource: resourceName ?? '',
      ids,
      status,
      // A missing record answers 404, which the bulk run reports per record.
      load: async (id) => asDoc(await service.getById(id)),
      save: async (id, next, before) => {
        const body = transformBody ? transformBody({ status: next }, req) : { status: next };
        const doc = asDoc(await service.update(id, body as Partial<T>)) as Record<string, unknown>;
        await auditSeo(req, 'update', before, doc);
        return doc;
      },
    });
    return sendSuccess(res, result, `${label} statuses updated`);
  });

  return { list, getById, create, update, remove, bulkStatus };
}
