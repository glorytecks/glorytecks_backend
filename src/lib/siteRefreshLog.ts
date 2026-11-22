import { logger } from '../config/logger';
import { siteRefreshRepo } from '../repositories';
import { ApiError } from '../utils/ApiError';
import type { NotifyResult } from './siteRevalidation';

/**
 * Record what happened when the API asked the marketing site to refresh.
 *
 * The outcome used to reach the function log only, so a refresh that kept
 * failing — content stale on the site for up to its ISR window — was invisible
 * in the admin. One row per attempt that was actually sent; a skipped
 * notification (nothing public changed, or the webhook is not configured) is
 * not a refresh, and the dashboard reports the configuration on its own.
 *
 * Never throws: the CMS write has already succeeded. Until the migration
 * (supabase/migrations/20261024000000_site_refresh_log.sql) is applied the
 * table is missing; recording then pauses for a while instead of paying for a
 * failing insert on every save.
 */

const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01']);
const PAUSE_AFTER_MISSING_MS = 10 * 60 * 1000;

let pausedUntil = 0;

/** True when a repository error says the table does not exist (migration not applied). */
export function isMissingTable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const code = (err.logDetail as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && MISSING_TABLE_CODES.has(code);
}

export async function recordSiteRefresh(
  resource: string,
  tags: readonly string[],
  result: NotifyResult,
): Promise<void> {
  if (result.status === 'skipped') return;
  if (Date.now() < pausedUntil) return;
  try {
    await siteRefreshRepo.insertRaw({
      resource: resource.slice(0, 60),
      tags: [...tags],
      status: result.status,
      reason: result.status === 'failed' ? result.reason.slice(0, 200) : null,
      http_status: result.status === 'sent' ? result.httpStatus : null,
      attempts: result.attempts,
    });
  } catch (err) {
    if (isMissingTable(err)) {
      pausedUntil = Date.now() + PAUSE_AFTER_MISSING_MS;
      logger.warn(
        'site_refresh_log does not exist; refresh outcomes are not recorded. Apply supabase/migrations/20261024000000_site_refresh_log.sql.',
      );
      return;
    }
    logger.warn('Site refresh outcome could not be recorded', {
      resource,
      status: result.status,
      reason: (err as Error).message,
    });
  }
}

/** Tests only: forget a pause left by an earlier case. */
export function resetSiteRefreshLogPause(): void {
  pausedUntil = 0;
}
