import { Router } from 'express';
import { siteAuditController } from '../controllers/siteAudit.controller';
import { requireAuth, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { adminWriteLimiter, expensiveLimiter } from '../middlewares/rateLimit';
import { ROLES } from '../constants';
import {
  exportQueryValidator,
  issueIdParam,
  issuesQueryValidator,
  runIdParam,
  runsQueryValidator,
} from '../validators/siteAudit.validator';

/**
 * Technical SEO audit. Administrators only, like Page SEO and SEO health: the
 * audit sends requests from the server to the public site, and its findings
 * cover every page, unpublished records' URLs included.
 *
 * Starting and retrying a run spend the per-account budget for server-side
 * fan-out work. Steps are not limited per request: a step can only run while
 * it holds the run's lease, the run has a fixed page budget, and a finished
 * run cannot be advanced, so calling it more often crawls nothing extra.
 */
const router = Router();

router.use(requireAuth, authorize(ROLES.ADMIN));

router.get('/overview', siteAuditController.overview);
router.get('/runs', validate(runsQueryValidator), siteAuditController.runs);
router.post('/runs', expensiveLimiter, siteAuditController.start);
router.get('/runs/:id', validate(runIdParam), siteAuditController.run);
router.post('/runs/:id/step', validate(runIdParam), siteAuditController.step);
router.post('/runs/:id/cancel', adminWriteLimiter, validate(runIdParam), siteAuditController.cancel);
router.post('/runs/:id/retry', expensiveLimiter, validate(runIdParam), siteAuditController.retry);
router.get('/issues', validate(issuesQueryValidator), siteAuditController.issues);
router.get('/issues/export', validate(exportQueryValidator), siteAuditController.exportIssues);
router.get('/issues/:id', validate(issueIdParam), siteAuditController.issue);

export default router;
