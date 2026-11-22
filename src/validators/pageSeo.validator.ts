import { body, query, ValidationChain } from 'express-validator';
import { routeKeyedPage } from '../seo/pageSeoRegistry';
import { seoObjectGuard, seoRules } from '../seo/seoFields';

/**
 * Page SEO request schemas.
 *
 * The path must be one the route registry lists (seo/pageSeoRegistry.ts):
 * exact spelling, no trailing slash, no query string. Course and comparison
 * pages are refused with a pointer to the record that stores their SEO.
 */
function pathRule(chain: ValidationChain): ValidationChain {
  return chain
    .exists({ values: 'falsy' })
    .withMessage('path is required')
    .bail()
    .isString()
    .withMessage('path must be text')
    .bail()
    .isLength({ max: 200 })
    .withMessage('path is too long')
    .bail()
    .custom((path: string) => {
      if (routeKeyedPage(path)) return true;
      if (/^\/(courses|compare)\/[a-z0-9]+(-[a-z0-9]+)*$/.test(path)) {
        throw new Error('This page’s SEO is stored on its course or comparison record — edit it there');
      }
      throw new Error('Not a page whose SEO is edited here');
    });
}

export const pageSeoUpsertValidator: ValidationChain[] = [
  pathRule(body('path')),
  ...seoRules(''),
  seoObjectGuard('', { allowRoot: ['path'] }),
];

export const pageSeoPathQuery: ValidationChain[] = [pathRule(query('path'))];

/** The read endpoint also serves course, comparison and legal paths (read-only). */
export const pageSeoEntryQuery: ValidationChain[] = [
  query('path')
    .exists({ values: 'falsy' })
    .withMessage('path is required')
    .bail()
    .isString()
    .isLength({ max: 200 })
    .matches(/^\/[a-z0-9/-]*$/)
    .withMessage('path must be a site path'),
];
