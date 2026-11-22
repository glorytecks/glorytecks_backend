import { query, ValidationChain } from 'express-validator';
import { ACTIVITY_KINDS, TREND_RANGES } from '../services/dashboard.service';

/**
 * Dashboard query schemas. Each parameter has a closed set of values or a
 * bounded range; anything else is refused, never coerced. A repeated
 * parameter arrives as an array and fails `isString`.
 */

export const activityQueryValidator: ValidationChain[] = [
  query('kind')
    .optional()
    .isString()
    .bail()
    .isIn(ACTIVITY_KINDS)
    .withMessage(`kind must be one of ${ACTIVITY_KINDS.join(', ')}`),
  query('limit')
    .optional()
    .isString()
    .bail()
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be between 1 and 50'),
];

export const trendsQueryValidator: ValidationChain[] = [
  query('range')
    .optional()
    .isString()
    .bail()
    .isIn(TREND_RANGES.map(String))
    .withMessage(`range must be one of ${TREND_RANGES.join(', ')} (days)`),
  // The caller's UTC offset in minutes east, as `-new Date().getTimezoneOffset()` gives it.
  query('tz')
    .optional()
    .isString()
    .bail()
    .isInt({ min: -720, max: 840 })
    .withMessage('tz must be a UTC offset in minutes, from -720 to 840'),
];
