import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/ApiResponse';
import { aboutPageRepo } from '../repositories';
import { invalidateResource } from '../lib/cacheInvalidation';
import { recordSeoAudit } from '../lib/seoAudit';
import { SEO_FIELDS, changedFields } from '../seo/seoFields';

export const aboutController = {
  get: asyncHandler(async (_req: Request, res: Response) => {
    const about = await aboutPageRepo.get();
    return sendSuccess(res, about, 'About page fetched');
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    // /about's SEO group is normally edited through Page SEO, but this route
    // accepts it too — audit it either way.
    const before = req.body?.seo ? await aboutPageRepo.get() : null;
    // Partial, leaf-level merge — same semantics as the old `doc.set(body)`.
    const about = await aboutPageRepo.update(req.body as Record<string, unknown>);
    if (before) {
      await recordSeoAudit({
        entityType: 'about',
        entityKey: '/about',
        recordId: about.id,
        action: 'update',
        changedFields: changedFields(
          before.seo as unknown as Record<string, unknown>,
          about.seo as unknown as Record<string, unknown>,
          SEO_FIELDS,
        ),
        editorId: req.user?.id,
      });
    }
    await invalidateResource('about');
    return sendSuccess(res, about, 'About page updated');
  }),
};
