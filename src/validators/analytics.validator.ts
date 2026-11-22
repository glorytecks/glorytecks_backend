import { param, query, ValidationChain } from 'express-validator';
import { RANGES } from '../integrations/google/reports';

/**
 * Analytics request schemas. Closed sets only: the periods the reports offer
 * and the two providers. Nothing here can choose a Google property — that is
 * fixed by the API's configuration.
 */

const RANGE_VALUES = RANGES.map(String);

export const reportQueryValidator: ValidationChain[] = [
  query('range')
    .optional()
    .isString()
    .bail()
    .isIn(RANGE_VALUES)
    .withMessage(`range must be one of ${RANGE_VALUES.join(', ')} (days)`),
  query('refresh').optional().isString().bail().isIn(['1']).withMessage('refresh must be 1 when given'),
];

export const providerParam: ValidationChain[] = [
  param('provider')
    .isString()
    .bail()
    .isIn(['search-console', 'analytics'])
    .withMessage('provider must be search-console or analytics'),
];
