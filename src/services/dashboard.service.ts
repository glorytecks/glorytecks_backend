import { env } from '../config/env';
import { logger } from '../config/logger';
import { getRedisClient, isRedisReady } from '../config/redis';
import {
  adminUserRepo,
  batchRepo,
  blogRepo,
  chatEnquiryRepo,
  contactEnquiryRepo,
  courseRepo,
  demoRequestRepo,
  seoAuditRepo,
  siteRefreshRepo,
} from '../repositories';
import type { BaseRepository, Filter } from '../repositories/BaseRepository';
import { CONTENT_ROLES, CONTENT_STATUS, LEAD_ROLES, LEAD_STATUS, ROLES, type Role } from '../constants';
import { webhookConfigProblem } from '../lib/siteRevalidation';
import { cachedSiteProbe, SITE_PROBE_TTL_SECONDS, type SiteProbe } from '../lib/siteProbe';
import { isMissingTable } from '../lib/siteRefreshLog';
import type { ISiteRefreshEntry } from '../interfaces/common';
import { googleIntegrationStatuses } from './analytics.service';

/*
  The admin home page's operational reads: system status, the work waiting for
  someone, persisted activity and dated trends. /dashboard/stats (the headline
  counts) stays in the controller as it was.

  Every read is decided by role HERE, on the server: a section a role may not
  see is absent from the response, never fetched and then hidden. Each section
  fails on its own — a missing table or a failing query becomes that section's
  state, and the rest of the dashboard still loads.

  Nothing here is cached in a shared key, so no role-specific value can be
  served to another role. The one shared cache entry is the website probe,
  which carries no role-specific data (lib/siteProbe.ts).
*/

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const canSeeLeads = (role?: Role): boolean => !!role && LEAD_ROLES.includes(role);
export const canSeeContent = (role?: Role): boolean => !!role && CONTENT_ROLES.includes(role);
export const isAdmin = (role?: Role): boolean => role === ROLES.ADMIN;

/** A section's outcome: its data, a failure, or a table that does not exist yet. */
export type Section<T> = { state: 'ok'; data: T } | { state: 'error' } | { state: 'not-set-up' };

export async function section<T>(label: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { state: 'ok', data: await run() };
  } catch (err) {
    if (isMissingTable(err)) return { state: 'not-set-up' };
    logger.warn(`Dashboard section failed: ${label}`, { reason: (err as Error).message });
    return { state: 'error' };
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/* ── System status ────────────────────────────────────────────────────────── */

export type IntegrationId = 'site-refresh' | 'uploads' | 'cache' | 'site-key' | 'sign-in-links' | 'search-console' | 'analytics';

export interface IntegrationStatus {
  id: IntegrationId;
  /**
   * `unchecked`: configured, but no request to the service has been made yet.
   * `misconfigured`: set, but not in a form the service accepts (nothing was sent).
   */
  state: 'ok' | 'not-configured' | 'degraded' | 'off' | 'unchecked' | 'misconfigured';
  /** What is wrong, in configuration terms: variable names, never values. */
  problem: string | null;
  envVars: string[];
}

async function cacheStatus(): Promise<IntegrationStatus> {
  const envVars = ['REDIS_URL', 'CACHE_ENABLED'];
  if (!env.redis.enabled) {
    return { id: 'cache', state: 'off', problem: 'CACHE_ENABLED is false', envVars };
  }
  if (!process.env.REDIS_URL?.trim()) {
    return { id: 'cache', state: 'not-configured', problem: 'REDIS_URL is not set', envVars };
  }
  if (isRedisReady()) return { id: 'cache', state: 'ok', problem: null, envVars };

  // A cold serverless instance may still be connecting: ask once, briefly.
  const client = getRedisClient();
  if (client) {
    const answered = await Promise.race([
      client.ping().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000).unref()),
    ]);
    if (answered) return { id: 'cache', state: 'ok', problem: null, envVars };
  }
  return { id: 'cache', state: 'degraded', problem: 'Redis is configured but not reachable from the API', envVars };
}

/** Every integration except the cache, whose state needs a live check. */
export function integrationStatuses(): IntegrationStatus[] {
  const refreshProblem = webhookConfigProblem(env.siteRevalidation.url, env.siteRevalidation.secret);
  return [
    {
      id: 'site-refresh',
      state: refreshProblem ? 'not-configured' : 'ok',
      problem: refreshProblem,
      envVars: ['SITE_REVALIDATE_URL', 'SITE_REVALIDATE_SECRET'],
    },
    {
      id: 'uploads',
      state: env.cloudinary.enabled ? 'ok' : 'not-configured',
      problem: env.cloudinary.enabled
        ? null
        : 'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must all be set',
      envVars: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
    },
    {
      id: 'site-key',
      state: env.rateLimit.siteKey ? 'ok' : 'not-configured',
      problem: env.rateLimit.siteKey ? null : 'SITE_API_KEY is not set',
      envVars: ['SITE_API_KEY'],
    },
    {
      id: 'sign-in-links',
      state: env.adminAppUrl ? 'ok' : 'not-configured',
      problem: env.adminAppUrl ? null : 'ADMIN_APP_URL is not set',
      envVars: ['ADMIN_APP_URL'],
    },
  ];
}

/* Site refresh history (site_refresh_log) */

export const REFRESH_WINDOW_DAYS = 7;
const REFRESH_ROW_CAP = 500;

export interface RefreshFailure {
  id: string;
  at: string;
  resource: string;
  tags: string[];
  reason: string | null;
  attempts: number;
}

export interface RefreshHistory {
  since: string;
  windowDays: number;
  sent: number;
  failed: number;
  lastSuccessAt: string | null;
  /** The newest attempt in the window, success or not. */
  latest: { at: string; status: 'sent' | 'failed' } | null;
  /** Failed refreshes no later refresh has covered: those pages may still be stale. */
  unresolved: RefreshFailure[];
  /** More rows than were read; the counts are then lower bounds. */
  truncated: boolean;
}

/**
 * A failure stays unresolved until a later refresh that succeeded sent every
 * tag the failed one carried. A later success for a different page does not
 * refresh the page that failed. Pure — unit-tested.
 */
export function unresolvedFailures(rowsNewestFirst: ISiteRefreshEntry[]): ISiteRefreshEntry[] {
  const out: ISiteRefreshEntry[] = [];
  const laterSent: Set<string>[] = [];
  for (const row of rowsNewestFirst) {
    if (row.status === 'sent') {
      laterSent.push(new Set(row.tags ?? []));
      continue;
    }
    const tags = row.tags ?? [];
    const covered = laterSent.some((sent) => tags.length > 0 && tags.every((t) => sent.has(t)));
    if (!covered) out.push(row);
  }
  return out;
}

async function refreshHistory(now: Date): Promise<Section<RefreshHistory>> {
  const since = iso(now.getTime() - REFRESH_WINDOW_DAYS * DAY);
  return section('site refresh history', async () => {
    const [rows, lastSent] = await Promise.all([
      siteRefreshRepo.findMany({
        filter: { createdAt: { op: 'gte', value: since } },
        sort: [{ field: 'createdAt', direction: -1 }],
        limit: REFRESH_ROW_CAP,
      }),
      siteRefreshRepo.findOne({ status: 'sent' }, { sort: [{ field: 'createdAt', direction: -1 }] }),
    ]);
    const failures = unresolvedFailures(rows);
    return {
      since,
      windowDays: REFRESH_WINDOW_DAYS,
      sent: rows.filter((r) => r.status === 'sent').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      lastSuccessAt: lastSent?.createdAt ?? null,
      latest: rows[0]?.createdAt ? { at: rows[0].createdAt, status: rows[0].status } : null,
      unresolved: failures.slice(0, 10).map((r) => ({
        id: String(r.id),
        at: String(r.createdAt),
        resource: r.resource,
        tags: r.tags ?? [],
        reason: r.reason ?? null,
        attempts: r.attempts,
      })),
      truncated: rows.length >= REFRESH_ROW_CAP,
    };
  });
}

export interface SystemStatus {
  generatedAt: string;
  database: { ok: boolean; latencyMs: number | null };
  site: SiteProbe & { cacheSeconds: number };
  /** Administrators only, from here down. */
  deployment?: { commit: string | null; environment: string | null };
  integrations?: IntegrationStatus[];
  siteRefresh?: { configured: boolean; history: Section<RefreshHistory> };
}

/**
 * Is the website up, is the API's database answering, and — for an
 * administrator — which integrations are configured and whether site refreshes
 * are working. Configuration is reported as booleans and variable NAMES only.
 */
export async function systemStatus(role: Role | undefined, now = new Date()): Promise<SystemStatus> {
  const started = performance.now();
  const [database, site] = await Promise.all([
    adminUserRepo.count().then(
      () => ({ ok: true, latencyMs: Math.round(performance.now() - started) }),
      () => ({ ok: false, latencyMs: null }),
    ),
    cachedSiteProbe(),
  ]);
  const base: SystemStatus = {
    generatedAt: now.toISOString(),
    database,
    site: { ...site, cacheSeconds: SITE_PROBE_TTL_SECONDS },
  };
  if (!isAdmin(role)) return base;

  // Google's state comes from configuration and the last recorded sync — no
  // call to Google is made to draw the dashboard, and a failure here is only
  // a missing line, never a failed page.
  const [cache, history, google] = await Promise.all([
    cacheStatus(),
    refreshHistory(now),
    googleIntegrationStatuses().catch(() => [] as IntegrationStatus[]),
  ]);
  const integrations = integrationStatuses();
  integrations.splice(2, 0, cache);
  integrations.push(...google);
  const refresh = integrations.find((i) => i.id === 'site-refresh');
  return {
    ...base,
    deployment: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      environment: process.env.VERCEL_ENV ?? null,
    },
    integrations,
    siteRefresh: { configured: refresh?.state === 'ok', history },
  };
}

/* ── Attention: work waiting for someone ──────────────────────────────────── */

export const WAITING_HOURS = 24;
export const STALE_DRAFT_DAYS = 14;

export type LeadKey = 'enquiries' | 'demoRequests' | 'chatEnquiries';
export type AnyRepo = BaseRepository<Record<string, unknown>>;

export const LEAD_REPOS: Record<LeadKey, AnyRepo> = {
  enquiries: contactEnquiryRepo as unknown as AnyRepo,
  demoRequests: demoRequestRepo as unknown as AnyRepo,
  chatEnquiries: chatEnquiryRepo as unknown as AnyRepo,
};

export interface LeadQueue {
  /** Still "new" more than WAITING_HOURS after they arrived. */
  waiting: number;
  oldestWaitingAt: string | null;
  /** Arrived in the last WAITING_HOURS, any status. */
  receivedRecently: number;
}

export interface DraftQueue {
  /** Drafts in total. */
  drafts: number;
  /** Drafts not saved for STALE_DRAFT_DAYS. */
  stale: number;
  /** The longest-untouched stale drafts, oldest first. */
  items: { id: string; title: string; updatedAt: string | null }[];
}

export interface BatchQueue {
  active: number;
  pastDated: { count: number; items: { id: string; course: string; startDate: string }[] };
  unreadable: { count: number; items: { id: string; course: string; startDate: string }[] };
}

export interface Attention {
  generatedAt: string;
  thresholds: { waitingHours: number; staleDraftDays: number };
  leads?: Section<Record<LeadKey, LeadQueue>>;
  drafts?: Section<{ blogs: DraftQueue; courses: DraftQueue }>;
  batches?: Section<BatchQueue>;
}

export async function leadQueue(repo: AnyRepo, now: Date): Promise<LeadQueue> {
  const cutoff = iso(now.getTime() - WAITING_HOURS * HOUR);
  const waitingFilter: Filter = { status: LEAD_STATUS.NEW, createdAt: { op: 'lt', value: cutoff } };
  const [waiting, oldest, receivedRecently] = await Promise.all([
    repo.count(waitingFilter),
    repo.findOne(waitingFilter, { fields: ['createdAt'], sort: [{ field: 'createdAt', direction: 1 }] }),
    repo.count({ createdAt: { op: 'gte', value: cutoff } }),
  ]);
  return { waiting, oldestWaitingAt: (oldest?.createdAt as string | undefined) ?? null, receivedRecently };
}

async function draftQueue(repo: AnyRepo, now: Date): Promise<DraftQueue> {
  const staleFilter: Filter = {
    status: CONTENT_STATUS.DRAFT,
    updatedAt: { op: 'lt', value: iso(now.getTime() - STALE_DRAFT_DAYS * DAY) },
  };
  const [drafts, stale, items] = await Promise.all([
    repo.count({ status: CONTENT_STATUS.DRAFT }),
    repo.count(staleFilter),
    repo.findMany({
      filter: staleFilter,
      sort: [{ field: 'updatedAt', direction: 1 }],
      limit: 5,
      fields: ['title', 'updatedAt'],
    }),
  ]);
  return {
    drafts,
    stale,
    items: items.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      updatedAt: (r.updatedAt as string | undefined) ?? null,
    })),
  };
}

/**
 * A batch start date as a calendar date ("YYYY-MM-DD"), or null when it cannot
 * be read. The column is free text: most rows are "YYYY-MM-DD", some are
 * written out ("Jun 10, 2026"). Anything else is reported as unreadable rather
 * than guessed. Pure — unit-tested.
 */
export function parseBatchDate(text: string | null | undefined): string | null {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso8601 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso8601) {
    const [y, m, d] = iso8601.slice(1).map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  // A written-out date names a month and a four-digit year.
  if (!/[a-z]{3}/i.test(value) || !/\b\d{4}\b/.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // Date-only strings that are not ISO parse as LOCAL midnight; read them back the same way.
  const date = new Date(ms);
  const year = date.getFullYear();
  if (year < 2000 || year > 2100) return null;
  return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function batchQueue(now: Date): Promise<BatchQueue> {
  const rows = await batchRepo.findMany({
    filter: { isActive: true },
    fields: ['course', 'startDate'],
    sort: [{ field: 'order', direction: 1 }],
  });
  // "Passed" means before yesterday in UTC, so no time zone can make today's batch look overdue.
  const yesterday = iso(now.getTime() - DAY).slice(0, 10);
  const parsed = rows.map((r) => ({
    id: String(r.id),
    course: String(r.course ?? ''),
    startDate: String(r.startDate ?? ''),
    date: parseBatchDate(r.startDate as string | undefined),
  }));
  const past = parsed.filter((b) => b.date !== null && b.date < yesterday).sort((a, b) => (a.date! < b.date! ? -1 : 1));
  const unreadable = parsed.filter((b) => b.date === null);
  const strip = ({ id, course, startDate }: (typeof parsed)[number]) => ({ id, course, startDate });
  return {
    active: rows.length,
    pastDated: { count: past.length, items: past.slice(0, 5).map(strip) },
    unreadable: { count: unreadable.length, items: unreadable.slice(0, 5).map(strip) },
  };
}

export async function attention(role: Role | undefined, now = new Date()): Promise<Attention> {
  const out: Attention = {
    generatedAt: now.toISOString(),
    thresholds: { waitingHours: WAITING_HOURS, staleDraftDays: STALE_DRAFT_DAYS },
  };
  const jobs: Promise<void>[] = [];
  if (canSeeLeads(role)) {
    jobs.push(
      section('waiting leads', async () => {
        const [enquiries, demoRequests, chatEnquiries] = await Promise.all(
          (Object.keys(LEAD_REPOS) as LeadKey[]).map((k) => leadQueue(LEAD_REPOS[k], now)),
        );
        return { enquiries, demoRequests, chatEnquiries };
      }).then((s) => void (out.leads = s)),
    );
  }
  if (canSeeContent(role)) {
    jobs.push(
      section('stale drafts', async () => {
        const [blogs, courses] = await Promise.all([
          draftQueue(blogRepo as unknown as AnyRepo, now),
          draftQueue(courseRepo as unknown as AnyRepo, now),
        ]);
        return { blogs, courses };
      }).then((s) => void (out.drafts = s)),
    );
  }
  if (isAdmin(role)) {
    jobs.push(section('batches', () => batchQueue(now)).then((s) => void (out.batches = s)));
  }
  await Promise.all(jobs);
  return out;
}

/* ── Activity: persisted events only ──────────────────────────────────────── */

export type ActivityKind = 'all' | 'seo' | 'site';
export const ACTIVITY_KINDS: ActivityKind[] = ['all', 'seo', 'site'];

export type ActivityItem =
  | {
      kind: 'seo';
      id: string;
      at: string;
      action: 'create' | 'update' | 'delete';
      entityType: string;
      path: string;
      recordId: string | null;
      changedFields: string[];
      editor: string | null;
    }
  | {
      kind: 'site';
      id: string;
      at: string;
      status: 'sent' | 'failed';
      resource: string;
      tags: string[];
      reason: string | null;
      attempts: number;
    };

export interface Activity {
  generatedAt: string;
  sources: { seo?: Section<null>['state']; site?: Section<null>['state'] };
  items: ActivityItem[];
}

/** Newest first, at most `limit`, across both logs. Pure — unit-tested. */
export function mergeActivity(lists: ActivityItem[][], limit: number): ActivityItem[] {
  return lists
    .flat()
    .filter((i) => !Number.isNaN(Date.parse(i.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

/**
 * The SEO change log and the site refresh log, merged. Administrator-only:
 * the SEO history names editors and the pages they changed.
 */
export async function activity(kind: ActivityKind, limit: number, now = new Date()): Promise<Activity> {
  const sources: Activity['sources'] = {};
  const lists: ActivityItem[][] = [];

  const reads: Promise<void>[] = [];
  if (kind === 'all' || kind === 'seo') {
    reads.push(
      section('seo activity', () =>
        seoAuditRepo.findMany({ sort: [{ field: 'createdAt', direction: -1 }], limit }),
      ).then((s) => {
        sources.seo = s.state;
        if (s.state !== 'ok') return;
        lists.push(
          s.data.map((r) => ({
            kind: 'seo' as const,
            id: String(r.id),
            at: String(r.createdAt ?? ''),
            action: r.action,
            entityType: r.entityType,
            path: r.entityKey,
            recordId: r.recordId ?? null,
            changedFields: r.changedFields ?? [],
            editor: r.editor?.name ?? null,
          })),
        );
      }),
    );
  }
  if (kind === 'all' || kind === 'site') {
    reads.push(
      section('site refresh activity', () =>
        siteRefreshRepo.findMany({ sort: [{ field: 'createdAt', direction: -1 }], limit }),
      ).then((s) => {
        sources.site = s.state;
        if (s.state !== 'ok') return;
        lists.push(
          s.data.map((r) => ({
            kind: 'site' as const,
            id: String(r.id),
            at: String(r.createdAt ?? ''),
            status: r.status,
            resource: r.resource,
            tags: r.tags ?? [],
            reason: r.reason ?? null,
            attempts: r.attempts,
          })),
        );
      }),
    );
  }
  await Promise.all(reads);
  return { generatedAt: now.toISOString(), sources, items: mergeActivity(lists, limit) };
}

/* ── Trends: dated counts, nothing estimated ──────────────────────────────── */

export const TREND_RANGES = [7, 30, 90] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

/** The calendar date of an instant at a fixed UTC offset (minutes east). Pure. */
export function dayKey(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export interface TrendWindow {
  /** The calendar dates covered, oldest first ("YYYY-MM-DD"). */
  dates: string[];
  /** Start of the first day, as an instant. */
  from: string;
  to: string;
  /** Start of the equally long period before it. */
  previousFrom: string;
}

/** `days` calendar days ending today (today so far), at the given offset. Pure. */
export function trendWindow(days: number, tzOffsetMinutes: number, now: Date): TrendWindow {
  const [y, m, d] = dayKey(now.getTime(), tzOffsetMinutes).split('-').map(Number);
  const todayStart = Date.UTC(y, m - 1, d) - tzOffsetMinutes * 60_000;
  const fromMs = todayStart - (days - 1) * DAY;
  return {
    dates: Array.from({ length: days }, (_, i) => dayKey(fromMs + i * DAY, tzOffsetMinutes)),
    from: iso(fromMs),
    to: now.toISOString(),
    previousFrom: iso(fromMs - days * DAY),
  };
}

/** Count instants per calendar date. Instants outside the dates are ignored. Pure. */
export function bucketByDay(instants: readonly unknown[], dates: readonly string[], tzOffsetMinutes: number): number[] {
  const index = new Map(dates.map((k, i) => [k, i]));
  const counts = dates.map(() => 0);
  for (const value of instants) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isNaN(ms)) continue;
    const i = index.get(dayKey(ms, tzOffsetMinutes));
    if (i !== undefined) counts[i] += 1;
  }
  return counts;
}

export const PAGE_SIZE = 1000;
export const MAX_TREND_ROWS = 10_000;

/** Every page after the first, read together: one at a time, each would wait on the last. */
export async function readRemainingPages<T>(
  total: number,
  maxRows: number,
  read: (page: number) => Promise<{ items: T[] }>,
): Promise<T[]> {
  const pages = Math.min(Math.ceil(total / PAGE_SIZE), maxRows / PAGE_SIZE);
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => read(i + 2)));
  return rest.flatMap((page) => page.items);
}

export interface Series {
  /** One count per date in the trend window. */
  counts: number[];
  total: number;
  /** The same count for the equally long period before, or null when the data does not reach back that far. */
  previousTotal: number | null;
  /** More rows than MAX_TREND_ROWS: the daily counts cover the first rows only. */
  truncated: boolean;
}

export async function series(
  repo: AnyRepo,
  field: 'createdAt' | 'publishedAt',
  window: TrendWindow,
  tz: number,
  extra: Filter = {},
): Promise<Series> {
  const current: Filter = { ...extra, [field]: { op: 'gte', value: window.from } };
  const previous: Filter = {
    ...extra,
    [field]: [
      { op: 'gte', value: window.previousFrom },
      { op: 'lt', value: window.from },
    ],
  };
  const read = (page: number) =>
    repo.list({ filter: current, fields: [field], sort: [{ field, direction: 1 }], page, limit: PAGE_SIZE });

  const [first, previousTotal, reachesBack] = await Promise.all([
    read(1),
    repo.count(previous),
    // A comparison is only fair if records existed before the previous period began.
    repo.exists({ ...extra, [field]: { op: 'lt', value: window.previousFrom } }),
  ]);
  const rest = await readRemainingPages(first.total, MAX_TREND_ROWS, read);
  const values: unknown[] = [...first.items, ...rest].map((r) => r[field]);
  return {
    counts: bucketByDay(values, window.dates, tz),
    total: first.total,
    previousTotal: reachesBack ? previousTotal : null,
    truncated: first.total > MAX_TREND_ROWS,
  };
}

/**
 * The small question an open admin asks in the background: has anything changed
 * in the leads? It answers from the created_at and status indexes, and the page
 * fetches the lists themselves only when the answer differs.
 */
export interface Pulse {
  checkedAt: string;
  leads: Record<LeadKey, { latestAt: string | null; unhandled: number }>;
}

export async function pulse(now = new Date()): Promise<Pulse> {
  const kinds = Object.keys(LEAD_REPOS) as LeadKey[];
  const rows = await Promise.all(
    kinds.map(async (k) => {
      const [latest, unhandled] = await Promise.all([
        LEAD_REPOS[k].findOne({}, { fields: ['createdAt'], sort: [{ field: 'createdAt', direction: -1 }] }),
        LEAD_REPOS[k].count({ status: LEAD_STATUS.NEW }),
      ]);
      return [k, { latestAt: (latest?.createdAt as string | undefined) ?? null, unhandled }] as const;
    }),
  );
  return { checkedAt: now.toISOString(), leads: Object.fromEntries(rows) as Pulse['leads'] };
}

export interface Trends {
  generatedAt: string;
  range: { days: number; tzOffsetMinutes: number } & TrendWindow;
  leads?: Section<Record<LeadKey, Series>>;
  publishing?: Section<{ blogs: Series }>;
}

/**
 * Daily counts over the last 7, 30 or 90 days, from each record's own date:
 * leads by when they arrived, posts by when they were first published.
 * Days are calendar days at the caller's UTC offset.
 */
export async function trends(
  role: Role | undefined,
  days: TrendRange,
  tzOffsetMinutes: number,
  now = new Date(),
): Promise<Trends> {
  const window = trendWindow(days, tzOffsetMinutes, now);
  const out: Trends = { generatedAt: now.toISOString(), range: { days, tzOffsetMinutes, ...window } };
  const jobs: Promise<void>[] = [];
  if (canSeeLeads(role)) {
    jobs.push(
      section('lead trends', async () => {
        const [enquiries, demoRequests, chatEnquiries] = await Promise.all(
          (Object.keys(LEAD_REPOS) as LeadKey[]).map((k) =>
            series(LEAD_REPOS[k], 'createdAt', window, tzOffsetMinutes),
          ),
        );
        return { enquiries, demoRequests, chatEnquiries };
      }).then((s) => void (out.leads = s)),
    );
  }
  if (canSeeContent(role)) {
    jobs.push(
      section('publishing trends', async () => ({
        blogs: await series(blogRepo as unknown as AnyRepo, 'publishedAt', window, tzOffsetMinutes, {
          status: CONTENT_STATUS.PUBLISHED,
        }),
      })).then((s) => void (out.publishing = s)),
    );
  }
  await Promise.all(jobs);
  return out;
}
