import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/ApiResponse';
import type { RangeDays } from '../integrations/google/reports';
import { analyticsReport, integrations, searchConsoleReport, testAnalytics, testSearchConsole } from '../services/analytics.service';

/**
 * Google Search Console and GA4 — administrators only (see the router).
 *
 *   GET  /analytics/integrations                    connection state, identifiers, last sync
 *   POST /analytics/integrations/:provider/test     ask Google now, and record the outcome
 *   GET  /analytics/search-console?range=7|28|90    Search Console report (cached 6 h)
 *   GET  /analytics/ga4?range=7|28|90               GA4 report (cached 1 h)
 *
 * A report request never fails for a reason on Google's side: it answers 200
 * with the connection state, the report (or the last good one, marked stale)
 * and a redacted error, so the admin can always render something honest.
 * Credentials and tokens never leave the API.
 */

const rangeOf = (req: Request): RangeDays => (req.query.range ? Number(req.query.range) : 28) as RangeDays;
const refreshOf = (req: Request) => req.query.refresh === '1';

const reportPayload = <T>(r: { connection: unknown; served: { report: T; fetchedAt: string; stale: boolean } | null; error: unknown }) => ({
  connection: r.connection,
  report: r.served?.report ?? null,
  fetchedAt: r.served?.fetchedAt ?? null,
  stale: r.served?.stale ?? false,
  error: r.error ?? null,
});

export const analyticsController = {
  integrations: asyncHandler(async (_req: Request, res: Response) => {
    return sendSuccess(res, await integrations(), 'Analytics integrations');
  }),

  test: asyncHandler(async (req: Request, res: Response) => {
    const result = req.params.provider === 'search-console' ? await testSearchConsole() : await testAnalytics();
    return sendSuccess(res, result, 'Connection test');
  }),

  searchConsole: asyncHandler(async (req: Request, res: Response) => {
    return sendSuccess(res, reportPayload(await searchConsoleReport(rangeOf(req), refreshOf(req))), 'Search Console report');
  }),

  ga4: asyncHandler(async (req: Request, res: Response) => {
    return sendSuccess(res, reportPayload(await analyticsReport(rangeOf(req), refreshOf(req))), 'GA4 report');
  }),
};
