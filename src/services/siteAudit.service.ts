import { blogRepo, siteAuditIssueRepo, siteAuditRunRepo } from '../repositories';
import type { Filter, SortSpec } from '../repositories';
import type { ISiteAuditIssue, ISiteAuditRun } from '../interfaces/common';
import { CONTENT_STATUS } from '../constants';
import { buildEntries } from '../controllers/pageSeo.controller';
import { createTransport } from '../lib/safeHttp';
import { isMissingTable } from '../lib/siteRefreshLog';
import { auditConfig, type AuditConfig } from '../seo/audit/config';
import { AUDIT_CATEGORIES, AUDIT_RULES, AUDIT_SEVERITIES, isAuditRule, auditRule, type AuditCategory, type AuditSeverity } from '../seo/audit/rules';
import { activeRun, latestRun, readAll, RUN_VIEW_FIELDS, type AuditContext, type EngineDeps, type Seed } from '../seo/audit/engine';

/**
 * The technical SEO audit as the admin sees it: configuration, runs, issues
 * and exports. The crawl itself is seo/audit/engine.ts; this file supplies its
 * view of the CMS and reads what it stored.
 */

export const MIGRATION_FILE = 'backend/supabase/migrations/20261025000000_site_audit.sql';

/* ── What the CMS says about the site ─────────────────────────────────────── */

/**
 * The URLs to start from and where each page is edited — the same list Page
 * SEO and its health checks use (pageSeo.controller → buildEntries), plus
 * every published blog post.
 */
export async function loadAuditContext(): Promise<AuditContext> {
  const [entries, blogs] = await Promise.all([buildEntries(), readAll(blogRepo, {}, ['slug', 'status', 'seo'])]);

  const seeds: Seed[] = [];
  for (const e of entries) {
    if (!e.live) continue; // an unpublished record 404s by design
    const registry = e.storage === 'page' || e.storage === 'about';
    seeds.push({
      path: e.path,
      source: registry ? 'registry' : `cms:${e.kind}`,
      live: true,
      expectIndex: !e.effective.noindex,
      expectFollow: !e.effective.nofollow,
      priority: registry ? 0 : 1,
    });
  }
  for (const b of blogs) {
    if (b.status !== CONTENT_STATUS.PUBLISHED) continue;
    seeds.push({
      path: `/blog/${b.slug}`,
      source: 'cms:blog',
      live: true,
      expectIndex: !(b.seo as { noindex?: boolean } | undefined)?.noindex,
      expectFollow: null,
      priority: 3,
    });
  }

  const adminByPath = new Map(entries.map((e) => [e.path, e.adminPath]));
  const blogId = new Map(blogs.map((b) => [b.slug, b.id]));

  return {
    seeds,
    textSources: new Map(
      entries.map((e) => [
        e.path,
        { title: e.override?.metaTitle ? 'custom' : 'default', description: e.override?.metaDescription ? 'custom' : 'default' },
      ]),
    ),
    adminPathFor(path: string) {
      if (/^https?:\/\//i.test(path)) return null;
      const clean = path.split('?')[0];
      const known = adminByPath.get(clean);
      if (known) return known;
      const post = /^\/blog\/(?!category\/)([^/]+)$/.exec(clean);
      if (post) {
        const id = blogId.get(post[1]);
        return id ? `/blogs/${id}` : null;
      }
      if (/^\/blog\/category\/[^/]+$/.test(clean)) return '/categories';
      return null;
    },
  };
}

/* ── Engine wiring, with a seam for tests ─────────────────────────────────── */

let overrides: Partial<EngineDeps> | null = null;

/** Tests only: answer the crawl from fixtures instead of the network. Refused in production. */
export function setSiteAuditDepsForTests(deps: Partial<EngineDeps> | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Site audit dependencies cannot be replaced in production');
  overrides = deps;
}

export function engineDeps(): EngineDeps {
  return {
    transport: overrides?.transport ?? createTransport(),
    now: overrides?.now ?? Date.now,
    context: overrides?.context ?? loadAuditContext,
  };
}

/* ── Views ────────────────────────────────────────────────────────────────── */

/** A run with no step for this long, and no step holding it, is waiting for someone to resume it. */
const STALLED_AFTER_MS = 2 * 60 * 1000;

const isoOrNull = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

export function runView(run: ISiteAuditRun, now: number) {
  const active = run.status === 'queued' || run.status === 'running';
  const leaseFree = !run.leaseUntil || new Date(run.leaseUntil).getTime() < now;
  const lastMove = new Date((run.updatedAt as string) ?? run.createdAt).getTime();
  return {
    id: run.id,
    origin: run.origin,
    status: run.status,
    phase: run.phase,
    maxPages: run.maxPages,
    steps: run.steps ?? 0,
    progress: run.progress ?? {},
    coverage: run.coverage ?? {},
    summary: run.summary ?? null,
    error: run.error ?? null,
    startedBy: typeof run.starter === 'object' && run.starter ? run.starter.name : null,
    startedAt: isoOrNull(run.startedAt),
    finishedAt: isoOrNull(run.finishedAt),
    createdAt: isoOrNull(run.createdAt as string),
    updatedAt: isoOrNull(run.updatedAt as string),
    stalled: active && leaseFree && now - lastMove > STALLED_AFTER_MS,
  };
}

export type RunView = ReturnType<typeof runView>;

function issueRow(i: ISiteAuditIssue) {
  const rule = isAuditRule(i.rule) ? auditRule(i.rule) : null;
  return {
    id: i.id,
    rule: i.rule,
    ruleLabel: rule?.label ?? i.rule,
    category: i.category,
    severity: i.severity,
    path: i.path,
    pageType: i.pageType,
    detail: i.detail,
    affectedCount: i.affectedCount ?? 0,
    adminPath: i.adminPath ?? null,
    status: i.status,
    firstSeenAt: isoOrNull(i.firstSeenAt),
    lastSeenAt: isoOrNull(i.lastSeenAt),
    resolvedAt: isoOrNull(i.resolvedAt),
    timesSeen: i.timesSeen,
    reopenedCount: i.reopenedCount ?? 0,
    firstRunId: i.firstRunId ?? null,
    lastRunId: i.lastRunId ?? null,
  };
}

export type IssueRow = ReturnType<typeof issueRow>;

/** The page types an issue can carry: the crawl's (intent.ts → PageType), plus images and site files. */
export const PAGE_TYPES = [
  'home', 'course-hub', 'course', 'location', 'landing', 'blog-hub', 'category', 'article', 'compare-hub', 'comparison',
  'resource-hub', 'resource', 'static', 'image', 'site-file',
] as const;

export const ISSUE_SORTS = ['severity', 'lastSeen', 'firstSeen', 'affected', 'path', 'timesSeen'] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export interface IssueQuery {
  status?: 'open' | 'resolved' | 'all';
  severity?: AuditSeverity;
  category?: AuditCategory;
  pageType?: string;
  rule?: string;
  q?: string;
  seen?: 'first' | 'recurring';
  sort?: IssueSort;
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

function issueFilter(origin: string, q: IssueQuery): Filter {
  const filter: Filter = { origin };
  const status = q.status ?? 'open';
  if (status !== 'all') filter.status = status;
  if (q.severity) filter.severity = q.severity;
  if (q.category) filter.category = q.category;
  if (q.pageType) filter.pageType = q.pageType;
  if (q.rule) filter.rule = q.rule;
  if (q.q?.trim()) filter.path = { op: 'ilike', value: q.q.trim() };
  if (q.seen === 'first') filter.timesSeen = 1;
  if (q.seen === 'recurring') filter.timesSeen = { op: 'gt', value: 1 };
  return filter;
}

function issueSort(sort: IssueSort = 'severity', order?: 'asc' | 'desc'): SortSpec[] {
  // Each sort's natural direction; `order` flips it.
  const natural: Record<IssueSort, SortSpec[]> = {
    severity: [{ field: 'severityRank', direction: 1 }, { field: 'affectedCount', direction: -1 }, { field: 'lastSeenAt', direction: -1 }],
    lastSeen: [{ field: 'lastSeenAt', direction: -1 }],
    firstSeen: [{ field: 'firstSeenAt', direction: -1 }],
    affected: [{ field: 'affectedCount', direction: -1 }, { field: 'severityRank', direction: 1 }],
    path: [{ field: 'path', direction: 1 }],
    timesSeen: [{ field: 'timesSeen', direction: -1 }, { field: 'severityRank', direction: 1 }],
  };
  const specs = natural[sort];
  const flip = order && (order === 'asc') !== (specs[0].direction === 1);
  const out = flip ? specs.map((s, i) => (i === 0 ? { ...s, direction: (s.direction === 1 ? -1 : 1) as 1 | -1 } : s)) : specs;
  // A stable tie-break so pages never repeat or skip rows.
  return [...out, { field: 'id', direction: 1 }];
}

const ISSUE_LIST_FIELDS = [
  'rule', 'category', 'severity', 'path', 'pageType', 'detail', 'affectedCount', 'adminPath', 'status', 'firstSeenAt',
  'lastSeenAt', 'resolvedAt', 'timesSeen', 'reopenedCount', 'firstRunId', 'lastRunId',
];

export async function listIssues(config: AuditConfig, q: IssueQuery) {
  const page = q.page ?? 1;
  const limit = q.limit ?? 25;
  const { items, total } = await siteAuditIssueRepo.list({
    filter: issueFilter(config.origin, q),
    sort: issueSort(q.sort, q.order),
    page,
    limit,
    fields: ISSUE_LIST_FIELDS,
  });
  return { items: items.map(issueRow), total, page, limit };
}

export async function issueDetail(config: AuditConfig, id: string) {
  const issue = await siteAuditIssueRepo.findOne({ id, origin: config.origin });
  if (!issue) return null;
  const rule = isAuditRule(issue.rule) ? auditRule(issue.rule) : null;
  const context = await engineDeps().context();
  const liveUrl = (p: string) => liveUrlOf(config.origin, p);
  return {
    ...issueRow(issue),
    target: issue.target ?? null,
    evidence: issue.evidence ?? {},
    liveUrl: liveUrl(issue.path),
    resolvedRunId: issue.resolvedRunId ?? null,
    rule: rule
      ? { id: rule.id, label: rule.label, category: rule.category, severity: rule.severity, why: rule.why, fix: rule.fix, source: rule.source }
      : { id: issue.rule, label: issue.rule, category: issue.category, severity: issue.severity, why: '', fix: '', source: '' },
    affected: (issue.affected ?? []).map((p) => ({ path: p, liveUrl: liveUrl(p), adminPath: context.adminPathFor(p) })),
  };
}

/* ── Export ───────────────────────────────────────────────────────────────── */

export const EXPORT_LIMIT = 5000;

/**
 * Quote a CSV cell. A spreadsheet runs a cell that starts with = + - @ (or a
 * tab or carriage return) as a formula, so such a cell gets a leading
 * apostrophe — the admin's own CSV exports do the same (lib/seoChecks.ts).
 */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** The public URL of an issue's path: site paths on the audited origin, images as they are. */
const liveUrlOf = (origin: string, p: string) => (/^https?:\/\//i.test(p) ? p : `${origin}${p === '/' ? '' : p}`);

export async function exportIssues(config: AuditConfig, q: IssueQuery, format: 'csv' | 'json', now: number) {
  const filter = issueFilter(config.origin, q);
  const sort = issueSort(q.sort, q.order);
  // In the order the admin shows them, a page of 1000 at a time (PostgREST's cap), up to the export limit.
  const rows: ISiteAuditIssue[] = [];
  let total = 0;
  for (let page = 1; rows.length < EXPORT_LIMIT; page++) {
    const res = await siteAuditIssueRepo.list({ filter, sort, page, limit: 1000 });
    total = res.total;
    rows.push(...res.items);
    if (res.items.length < 1000) break;
  }
  rows.length = Math.min(rows.length, EXPORT_LIMIT);

  const stamp = new Date(now).toISOString();
  const live = (p: string) => liveUrlOf(config.origin, p);
  const records = rows.map((i) => {
    const rule = isAuditRule(i.rule) ? auditRule(i.rule) : null;
    return {
      severity: i.severity,
      category: i.category,
      issue: rule?.label ?? i.rule,
      rule: i.rule,
      url: live(i.path),
      path: i.path,
      pageType: i.pageType,
      detail: i.detail,
      affectedCount: i.affectedCount ?? 0,
      affected: i.affected ?? [],
      status: i.status,
      firstSeenAt: isoOrNull(i.firstSeenAt),
      lastSeenAt: isoOrNull(i.lastSeenAt),
      resolvedAt: isoOrNull(i.resolvedAt),
      timesSeen: i.timesSeen,
      reopenedCount: i.reopenedCount ?? 0,
      adminPath: i.adminPath ?? null,
      why: rule?.why ?? '',
      fix: rule?.fix ?? '',
      evidence: i.evidence ?? {},
    };
  });
  const filename = `seo-audit-issues-${stamp.slice(0, 10)}.${format}`;

  if (format === 'json') {
    const body = JSON.stringify(
      { exportedAt: stamp, origin: config.origin, filters: q, total, exported: records.length, truncated: total > records.length, issues: records },
      null,
      2,
    );
    return { filename, contentType: 'application/json; charset=utf-8', body };
  }

  const header = ['Severity', 'Category', 'Issue', 'Rule', 'URL', 'Path', 'Page type', 'Detail', 'Affected pages', 'Affected (first 50)', 'Status', 'First seen', 'Last seen', 'Resolved', 'Times seen', 'Reopened', 'Edit in admin', 'Why it matters', 'Recommended fix'];
  const lines = records.map((r) =>
    [
      r.severity, r.category, r.issue, r.rule, r.url, r.path, r.pageType, r.detail, r.affectedCount, r.affected.join(' | '), r.status,
      r.firstSeenAt, r.lastSeenAt, r.resolvedAt, r.timesSeen, r.reopenedCount, r.adminPath, r.why, r.fix,
    ]
      .map(csvCell)
      .join(','),
  );
  // UTF-8 with a BOM so Excel reads it correctly, as the admin's CSV exports do.
  const body = '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n');
  return { filename, contentType: 'text/csv; charset=utf-8', body };
}

/* ── Overview ─────────────────────────────────────────────────────────────── */

export async function overview(now: number) {
  const state = auditConfig();
  const catalogue = {
    rules: AUDIT_RULES.map((r) => ({ id: r.id, label: r.label, category: r.category, severity: r.severity })),
    categories: AUDIT_CATEGORIES,
    severities: AUDIT_SEVERITIES,
    pageTypes: PAGE_TYPES,
  };
  if (!state.ok) return { configured: false as const, reason: state.reason, setup: state.setup, ...catalogue };

  const { config } = state;
  const settings = {
    origin: config.origin,
    pageHosts: config.pageHosts,
    mediaHosts: config.mediaHosts,
    production: config.production,
    hostNoindex: config.hostNoindex,
    maxPages: config.maxPages,
    stepMs: config.stepMs,
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
    attempts: config.attempts,
    cooldownMinutes: Math.round(config.cooldownMs / 60_000),
  };

  try {
    const [active, latest, completed] = await Promise.all([
      activeRun(),
      latestRun(config.origin),
      siteAuditRunRepo.findMany({
        filter: { origin: config.origin, status: 'completed' },
        sort: [{ field: 'createdAt', direction: -1 }, { field: 'id', direction: -1 }],
        limit: 2,
        fields: [...RUN_VIEW_FIELDS, 'starter'],
      }),
    ]);
    const count = (extra: Filter) => siteAuditIssueRepo.count({ origin: config.origin, status: 'open', ...extra });
    const [total, fix, review, info] = await Promise.all([count({}), count({ severity: 'fix' }), count({ severity: 'review' }), count({ severity: 'info' })]);
    const last = completed[0] ?? null;
    const nextAllowed = last?.finishedAt ? new Date(last.finishedAt).getTime() + config.cooldownMs : 0;
    return {
      configured: true as const,
      setUp: true as const,
      settings,
      ...catalogue,
      active: active ? runView(active, now) : null,
      latest: latest ? runView(latest, now) : null,
      latestCompleted: last ? runView(last, now) : null,
      previousCompleted: completed[1] ? runView(completed[1], now) : null,
      nextRunAllowedAt: nextAllowed > now ? new Date(nextAllowed).toISOString() : null,
      openIssues: { total, fix, review, info },
      generatedAt: new Date(now).toISOString(),
    };
  } catch (err) {
    if (isMissingTable(err)) {
      return { configured: true as const, setUp: false as const, settings, ...catalogue, migration: MIGRATION_FILE };
    }
    throw err;
  }
}

export async function listRuns(config: AuditConfig, page: number, limit: number, now: number) {
  const { items, total } = await siteAuditRunRepo.list({
    filter: { origin: config.origin },
    sort: [{ field: 'createdAt', direction: -1 }, { field: 'id', direction: 1 }],
    page,
    limit,
    fields: [...RUN_VIEW_FIELDS, 'starter'],
  });
  return { items: items.map((r) => runView(r, now)), total, page, limit };
}

export async function getRun(config: AuditConfig, id: string, now: number) {
  const run = await siteAuditRunRepo.findOne({ id, origin: config.origin }, { fields: [...RUN_VIEW_FIELDS, 'starter'] });
  return run ? runView(run, now) : null;
}
