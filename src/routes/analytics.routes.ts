import { Router, Request, Response, NextFunction } from 'express';
import { analyticsController } from '../controllers/analytics.controller';
import { requireAuth, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { expensiveLimiter } from '../middlewares/rateLimit';
import { ROLES } from '../constants';
import { providerParam, reportQueryValidator } from '../validators/analytics.validator';

/**
 * Search Console and GA4. Administrators only, like the other SEO screens:
 * these reports cover the whole site and its traffic sources, and the
 * Integrations page names the Google properties and the service account.
 *
 * Anything that makes the API call Google right now — a connection test, or
 * a report with `refresh=1` that skips the cache — spends the per-account
 * budget for server-side fan-out work. Cached reports do not.
 */
const router = Router();

router.use(requireAuth, authorize(ROLES.ADMIN));

const limitRefresh = (req: Request, res: Response, next: NextFunction) =>
  req.query.refresh === '1' ? expensiveLimiter(req, res, next) : next();

router.get('/integrations', analyticsController.integrations);
router.post('/integrations/:provider/test', expensiveLimiter, validate(providerParam), analyticsController.test);
router.get('/search-console', validate(reportQueryValidator), limitRefresh, analyticsController.searchConsole);
router.get('/ga4', validate(reportQueryValidator), limitRefresh, analyticsController.ga4);

export default router;
