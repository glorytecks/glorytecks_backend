import { Router } from 'express';
import { resources } from '../services/registry';
import { createCrudController } from '../controllers/crud.factory';
import { requireAuth, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { adminWriteLimiter, expensiveLimiter } from '../middlewares/rateLimit';
import { RESOURCE_SCHEMAS } from '../validators/resource.validators';
import { uuidParam, listQueryValidator, bulkStatusValidator } from '../validators/common';
import { ALL_CONTENT_STATUS, ROLES } from '../constants';
import { BULK_STATUS_MAX } from '../lib/bulkStatus';

/**
 * Mount every registry resource as a protected REST router at /<path>.
 * Bespoke modules (blogs, courses, leads) are mounted separately in index.ts.
 *
 * Every route carries validation, and the mount refuses to proceed without it:
 * a resource added to the registry with no schema is a resource that would
 * silently accept arbitrary JSON, so this fails at boot rather than shipping
 * an unvalidated endpoint. Boot is the right place — the alternative is
 * discovering it from production traffic.
 */
export function buildGenericRoutes(): Router {
  const router = Router();

  for (const def of resources) {
    const schema = RESOURCE_SCHEMAS[def.path];
    if (!schema) {
      throw new Error(
        `Resource "${def.path}" is registered without a request schema. ` +
          'Add one to validators/resource.validators.ts before mounting it.',
      );
    }

    const handlers = createCrudController(def.service, { ...def.controller, resourceName: def.path });
    const r = Router();
    // Each resource declares which roles may manage it (defaults to admin-only).
    const roles = def.roles ?? [ROLES.ADMIN];
    r.use(requireAuth, authorize(...roles));

    r.get('/', validate(listQueryValidator), handlers.list);
    r.get('/:id', validate(uuidParam()), handlers.getById);
    // Writes are limited per account. Reads are covered by the global API
    // ceiling — they are cheap and the admin UI issues many of them per screen.
    r.post('/', adminWriteLimiter, validate(schema.create), handlers.create);
    // Several records to one status at once. Only resources with a content
    // status opt in; it fans out to many writes, so it also spends the
    // per-account budget for expensive operations.
    if (def.bulkStatus) {
      r.post(
        '/bulk-status',
        adminWriteLimiter,
        expensiveLimiter,
        validate(bulkStatusValidator(ALL_CONTENT_STATUS, BULK_STATUS_MAX)),
        handlers.bulkStatus,
      );
    }
    r.put('/:id', adminWriteLimiter, validate([...uuidParam(), ...schema.update]), handlers.update);
    r.patch('/:id', adminWriteLimiter, validate([...uuidParam(), ...schema.update]), handlers.update);
    r.delete('/:id', adminWriteLimiter, validate(uuidParam()), handlers.remove);

    router.use(`/${def.path}`, r);
  }

  return router;
}
