import { Router } from 'express';
import { courseController } from '../controllers/course.controller';
import { requireAuth, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { ALL_CONTENT_STATUS, CONTENT_ROLES } from '../constants';
import { createCourseValidator, updateCourseValidator } from '../validators/course.validator';
import { uuidParam, slugParam, listQueryValidator, bulkStatusValidator } from '../validators/common';
import { adminWriteLimiter, expensiveLimiter } from '../middlewares/rateLimit';
import { BULK_STATUS_MAX } from '../lib/bulkStatus';

const router = Router();

router.use(requireAuth, authorize(...CONTENT_ROLES));

router.get('/', validate(listQueryValidator), courseController.list);
router.get('/slug/:slug', validate(slugParam()), courseController.getBySlug);
router.get('/:id', validate(uuidParam()), courseController.getById);
router.post('/', adminWriteLimiter, validate(createCourseValidator), courseController.create);
// Several courses to one status (the list's bulk actions); many writes in one
// request, so it also spends the expensive-operation budget.
router.post(
  '/bulk-status',
  adminWriteLimiter,
  expensiveLimiter,
  validate(bulkStatusValidator(ALL_CONTENT_STATUS, BULK_STATUS_MAX)),
  courseController.bulkStatus,
);
router.put(
  '/:id',
  adminWriteLimiter,
  validate([...uuidParam(), ...updateCourseValidator]),
  courseController.update,
);
router.delete('/:id', adminWriteLimiter, validate(uuidParam()), courseController.remove);

export default router;
