import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { requireAuth, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { activityQueryValidator, trendsQueryValidator } from '../validators/dashboard.validator';
import { CONTENT_ROLES, LEAD_ROLES, ROLES } from '../constants';

/*
  Every role has a dashboard, so most of these carry requireAuth alone and
  decide per section, on the server, what the caller's role may see
  (services/dashboard.service.ts). Activity names editors and the pages whose
  SEO they changed, which is administrator-only everywhere else, so it is
  refused outright for other roles.
*/

const router = Router();
router.get('/stats', requireAuth, dashboardController.stats);
router.get('/status', requireAuth, dashboardController.status);
router.get('/attention', requireAuth, dashboardController.attention);
router.get('/pulse', requireAuth, authorize(...LEAD_ROLES), dashboardController.pulse);
router.get(
  '/activity',
  requireAuth,
  authorize(ROLES.ADMIN),
  validate(activityQueryValidator),
  dashboardController.activity,
);
router.get('/trends', requireAuth, validate(trendsQueryValidator), dashboardController.trends);

// Section overviews: each open to the roles that may open that section's pages.
router.get('/sections/leads', requireAuth, authorize(...LEAD_ROLES), validate(trendsQueryValidator), dashboardController.leadsOverview);
router.get('/sections/blog', requireAuth, authorize(...CONTENT_ROLES), validate(trendsQueryValidator), dashboardController.blogOverview);
router.get('/sections/courses', requireAuth, authorize(...CONTENT_ROLES), validate(trendsQueryValidator), dashboardController.coursesOverview);
router.get('/sections/website', requireAuth, authorize(ROLES.ADMIN), dashboardController.websiteOverview);
router.get('/sections/people', requireAuth, authorize(...CONTENT_ROLES), dashboardController.peopleOverview);
export default router;
