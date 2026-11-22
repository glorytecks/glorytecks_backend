import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { buildPaginationMeta } from '../utils/queryFeatures';
import { isMissingTable } from '../lib/siteRefreshLog';
import { auditConfig, type AuditConfig } from '../seo/audit/config';
import { cancelRun, retryRun, startRun, stepRun } from '../seo/audit/engine';
import {
  engineDeps,
  exportIssues,
  getRun,
  issueDetail,
  listIssues,
  listRuns,
  MIGRATION_FILE,
  overview,
  runView,
  type IssueQuery,
} from '../services/siteAudit.service';

/**
 * Technical SEO audit — administrators only (see the router).
 *
 *   GET  /seo-audit/overview          configuration, latest runs, open issue counts
 *   GET  /seo-audit/runs              runs, newest first
 *   POST /seo-audit/runs              start a run (one at a time; not within the cooldown)
 *   GET  /seo-audit/runs/:id          one run's progress
 *   POST /seo-audit/runs/:id/step     advance a run by one time-boxed step
 *   POST /seo-audit/runs/:id/cancel   stop a run in progress
 *   POST /seo-audit/runs/:id/retry    check again what failed in the latest run
 *   GET  /seo-audit/issues            issues, filtered, sorted and paginated
 *   GET  /seo-audit/issues/export     the same issues as CSV or JSON
 *   GET  /seo-audit/issues/:id        one issue with its evidence and affected pages
 *
 * Opening the screen never crawls: only an explicit run does, and a run's
 * results are reused until the next one.
 */

function requireConfig(): AuditConfig {
  const state = auditConfig();
  if (!state.ok) throw ApiError.serviceUnavailable(`The technical SEO audit is not configured. ${state.reason}`);
  return state.config;
}

/** A missing table means the migration has not been applied: say so, instead of a bare 500. */
async function tables<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingTable(err)) throw ApiError.serviceUnavailable(`The technical SEO audit is not set up: apply ${MIGRATION_FILE}.`);
    throw err;
  }
}

/** The engine's clock, so a test can move time (cooldowns, stalled runs) without waiting. */
const clock = () => engineDeps().now();

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown, fallback: number) => (typeof v === 'string' && v !== '' ? Number(v) : fallback);

function issueQuery(req: Request): IssueQuery {
  const q = req.query;
  return {
    status: str(q.status) as IssueQuery['status'],
    severity: str(q.severity) as IssueQuery['severity'],
    category: str(q.category) as IssueQuery['category'],
    pageType: str(q.pageType),
    rule: str(q.rule),
    q: str(q.q),
    seen: str(q.seen) as IssueQuery['seen'],
    sort: str(q.sort) as IssueQuery['sort'],
    order: str(q.order) as IssueQuery['order'],
    page: num(q.page, 1),
    limit: num(q.limit, 25),
  };
}

const RETRY_REFUSAL: Record<string, string> = {
  'not-latest': 'Only the latest run can be retried.',
  'not-finished': 'This run is still in progress.',
  'nothing-to-retry': 'Every URL in this run answered; there is nothing to retry.',
  'active-elsewhere': 'Another run is in progress. Wait for it to finish or cancel it first.',
};

export const siteAuditController = {
  overview: asyncHandler(async (_req: Request, res: Response) => {
    return sendSuccess(res, await overview(clock()), 'SEO audit overview');
  }),

  runs: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const page = num(req.query.page, 1);
    const limit = num(req.query.limit, 10);
    const result = await tables(() => listRuns(config, page, limit, clock()));
    return sendSuccess(res, result.items, 'SEO audit runs', 200, buildPaginationMeta(result.total, page, limit));
  }),

  run: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const run = await tables(() => getRun(config, req.params.id, clock()));
    if (!run) throw ApiError.notFound('Run not found');
    return sendSuccess(res, run, 'SEO audit run');
  }),

  start: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const now = clock();
    const result = await tables(() => startRun(config, req.user?.id ?? null, now));
    if (result.outcome === 'active') {
      throw ApiError.conflict('An audit is already in progress. Resume or cancel it first.', [{ field: 'runId', message: result.run.id }]);
    }
    if (result.outcome === 'cooldown') {
      throw ApiError.conflict(
        `The last audit finished less than ${Math.round(config.cooldownMs / 60_000)} minutes ago, and its results are current.`,
        [{ field: 'nextAllowedAt', message: result.nextAllowedAt }],
      );
    }
    return sendCreated(res, runView(result.run, now), 'SEO audit started');
  }),

  step: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const result = await tables(() => stepRun(req.params.id, config, engineDeps()));
    if (result.outcome === 'not-found') throw ApiError.notFound('Run not found');
    return sendSuccess(res, { outcome: result.outcome, run: runView(result.run, clock()) }, 'SEO audit step');
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const now = clock();
    const run = await tables(() => cancelRun(req.params.id, now));
    if (run) return sendSuccess(res, runView(run, now), 'SEO audit cancelled');
    const current = await tables(() => getRun(config, req.params.id, now));
    if (!current) throw ApiError.notFound('Run not found');
    if ((current.status === 'queued' || current.status === 'running') && current.phase === 'analyze') {
      throw ApiError.conflict('This run is analysing what it found and will finish in a moment; it can no longer be cancelled.');
    }
    throw ApiError.conflict('This run is not in progress.');
  }),

  retry: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const result = await tables(() => retryRun(req.params.id, config));
    if (result.outcome !== 'retrying') throw ApiError.conflict(RETRY_REFUSAL[result.outcome]);
    return sendSuccess(res, { run: runView(result.run, clock()), requeued: result.requeued }, 'SEO audit retry started');
  }),

  issues: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const q = issueQuery(req);
    const result = await tables(() => listIssues(config, q));
    return sendSuccess(res, result.items, 'SEO audit issues', 200, buildPaginationMeta(result.total, result.page, result.limit));
  }),

  issue: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const issue = await tables(() => issueDetail(config, req.params.id));
    if (!issue) throw ApiError.notFound('Issue not found');
    return sendSuccess(res, issue, 'SEO audit issue');
  }),

  exportIssues: asyncHandler(async (req: Request, res: Response) => {
    const config = requireConfig();
    const format = (str(req.query.format) ?? 'csv') as 'csv' | 'json';
    const file = await tables(() => exportIssues(config, issueQuery(req), format, clock()));
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(file.body);
  }),
};
