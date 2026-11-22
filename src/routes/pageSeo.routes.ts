import { Router } from 'express';
import { pageSeoController } from '../controllers/pageSeo.controller';
import { requireAuth, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { adminWriteLimiter } from '../middlewares/rateLimit';
import { ROLES } from '../constants';
import { pageSeoEntryQuery, pageSeoPathQuery, pageSeoUpsertValidator } from '../validators/pageSeo.validator';

/**
 * Page SEO for the non-blog pages. Administrators only: these fields decide
 * how the site's fixed pages and landings appear in search results, including
 * whether they appear at all. Course SEO is edited on the course (content
 * writers included) — see course.controller for its robots rule.
 */
const router = Router();

router.use(requireAuth, authorize(ROLES.ADMIN));

router.get('/', pageSeoController.list);
router.get('/checks', pageSeoController.checks);
router.get('/entry', validate(pageSeoEntryQuery), pageSeoController.entry);
router.put('/', adminWriteLimiter, validate(pageSeoUpsertValidator), pageSeoController.upsert);
router.delete('/', adminWriteLimiter, validate(pageSeoPathQuery), pageSeoController.reset);

export default router;
