import { body } from 'express-validator';
import { ALL_CONTENT_STATUS } from '../constants';
import {
  LIMITS,
  str,
  slug,
  bool,
  int,
  strArray,
  objArray,
  enumField,
  urlField,
  noUnknownFields,
  dropFields,
  SERVER_OWNED_FIELDS,
} from './common';
import { seoObjectGuard, seoRules } from '../seo/seoFields';

/**
 * Course request schemas.
 *
 * Courses carry the deepest client-supplied structures in the product —
 * `syllabus` is a list of modules each holding a list of items — so the nested
 * counts matter as much as the top-level ones. Every array is bounded at both
 * levels; `guardPayloadShape` bounds the depth beyond that.
 */
const COURSE_FIELDS = [
  'slug', 'title', 'category', 'tagline', 'description', 'duration', 'modules',
  'tools', 'projects', 'placement', 'syllabus', 'fees', 'skills', 'bannerImage',
  'images', 'brochureUrl', 'faqs', 'status', 'featured', 'order', 'trainer',
  'showInNav', 'navOrder', 'seo',
] as const;

const rules = (required: boolean) => [
  dropFields(SERVER_OWNED_FIELDS),
  str('title', { required, min: 2, max: LIMITS.TITLE, label: 'Title' }),
  slug('slug'),
  str('category', { max: LIMITS.LABEL }),
  str('tagline', { max: LIMITS.SUMMARY }),
  str('description', { max: LIMITS.TEXT }),
  str('duration', { max: LIMITS.LABEL }),
  str('fees', { max: LIMITS.LABEL }),
  str('placement', { max: LIMITS.TEXT }),

  ...strArray('modules', { maxItems: LIMITS.MODULES, maxLength: LIMITS.LABEL, label: 'Modules' }),
  ...strArray('tools', { maxItems: LIMITS.ARRAY, label: 'Tools' }),
  ...strArray('projects', { maxItems: LIMITS.ARRAY, maxLength: LIMITS.SUMMARY, label: 'Projects' }),
  ...strArray('skills', { maxItems: LIMITS.ARRAY, label: 'Skills' }),
  ...strArray('images', { maxItems: LIMITS.GALLERY, maxLength: LIMITS.URL, label: 'Images' }),

  objArray('syllabus', { maxItems: LIMITS.SYLLABUS, label: 'Syllabus' }),
  body('syllabus.*.title').optional().isString().trim().isLength({ max: LIMITS.TITLE }),
  body('syllabus.*.items')
    .optional()
    .isArray({ max: LIMITS.LIST_ITEMS })
    .withMessage(`A syllabus module may list at most ${LIMITS.LIST_ITEMS} items`),
  body('syllabus.*.items.*').optional().isString().trim().isLength({ max: LIMITS.SUMMARY }),

  objArray('faqs', { maxItems: LIMITS.FAQS, label: 'FAQs' }),
  body('faqs.*.q').optional().isString().trim().isLength({ max: LIMITS.TITLE }),
  body('faqs.*.a').optional().isString().trim().isLength({ max: LIMITS.TEXT }),

  urlField('bannerImage'),
  urlField('brochureUrl'),
  enumField('status', ALL_CONTENT_STATUS, { label: 'Status' }),
  bool('featured'),
  int('order'),

  // Header Courses menu: on/off, and the course's place in it (1 = first).
  // null clears the position; a course shown without one sorts last.
  bool('showInNav', { label: 'Show in Courses menu' }),
  body('navOrder')
    .optional({ values: 'null' })
    .isInt({ min: 1, max: LIMITS.ORDER_MAX })
    .withMessage(`Menu position must be a whole number between 1 and ${LIMITS.ORDER_MAX}`)
    .toInt(),
  body('showInNav').custom((show, { req }) => {
    const position = req.body?.navOrder;
    if (show === true && (position === null || position === '')) {
      throw new Error('Enter a menu position for a course shown in the Courses menu');
    }
    return true;
  }),
  // Search & social overrides (seo/seoFields.ts). Empty means "use the
  // generated default"; canonicalUrl is refused — it comes from the route
  // registry. Who may change noindex/nofollow is decided in the controller,
  // which can see the stored values.
  seoObjectGuard('seo'),
  ...seoRules('seo.'),

  // `trainer` is a relation: an id string, or a populated object echoed back.
  body('trainer')
    .optional({ values: 'null' })
    .custom((value) => {
      if (typeof value === 'string') return value.length <= LIMITS.SLUG;
      if (value && typeof value === 'object' && !Array.isArray(value)) return true;
      throw new Error('Trainer must be an id or a trainer object');
    }),
];

export const createCourseValidator = [
  ...rules(true),
  noUnknownFields(COURSE_FIELDS, SERVER_OWNED_FIELDS),
];
export const updateCourseValidator = [
  ...rules(false),
  noUnknownFields(COURSE_FIELDS, SERVER_OWNED_FIELDS),
];
