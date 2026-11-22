import { param, query, ValidationChain } from 'express-validator';
import { AUDIT_CATEGORIES, AUDIT_SEVERITIES, isAuditRule } from '../seo/audit/rules';
import { ISSUE_SORTS, PAGE_TYPES } from '../services/siteAudit.service';

/**
 * Technical SEO audit request schemas. Nothing here can name a URL to crawl:
 * the origin comes from SEO_AUDIT_ORIGIN alone. Every parameter has a closed
 * set of values or a bounded range; a repeated parameter arrives as an array
 * and fails `isString`.
 */

const uuid = (where: typeof param, name: string, label: string) =>
  where(name).isString().bail().isUUID().withMessage(`${label} must be a UUID`);

export const runIdParam: ValidationChain[] = [uuid(param, 'id', 'Run id')];
export const issueIdParam: ValidationChain[] = [uuid(param, 'id', 'Issue id')];

const oneOf = (name: string, values: readonly string[]) =>
  query(name).optional().isString().bail().isIn(values).withMessage(`${name} must be one of ${values.join(', ')}`);

const int = (name: string, min: number, max: number) =>
  query(name).optional().isString().bail().isInt({ min, max }).withMessage(`${name} must be a whole number from ${min} to ${max}`);

export const runsQueryValidator: ValidationChain[] = [int('page', 1, 1000), int('limit', 1, 50)];

const issueFilters: ValidationChain[] = [
  oneOf('status', ['open', 'resolved', 'all']),
  oneOf('severity', AUDIT_SEVERITIES),
  oneOf('category', AUDIT_CATEGORIES),
  oneOf('pageType', PAGE_TYPES),
  query('rule')
    .optional()
    .isString()
    .bail()
    .isLength({ max: 80 })
    .custom((v: string) => isAuditRule(v))
    .withMessage('rule must be one of the audit’s rules'),
  query('q').optional().isString().bail().trim().isLength({ max: 200 }).withMessage('q must be at most 200 characters'),
  oneOf('seen', ['first', 'recurring']),
  oneOf('sort', ISSUE_SORTS),
  oneOf('order', ['asc', 'desc']),
];

export const issuesQueryValidator: ValidationChain[] = [...issueFilters, int('page', 1, 10_000), int('limit', 1, 100)];

export const exportQueryValidator: ValidationChain[] = [...issueFilters, oneOf('format', ['csv', 'json'])];
