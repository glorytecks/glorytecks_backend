import crypto from 'node:crypto';
import { cacheGet, cacheSet } from '../lib/cache';
import { analyticsConfig, publicConfig, searchConsoleConfig, type Provider } from '../integrations/google/config';
import { GoogleApiError, googleDeps, toGoogleError, type GoogleErrorKind } from '../integrations/google/http';
import { READ_LEVELS, getSite, searchAnalytics, type GscDimension, type GscRow } from '../integrations/google/searchConsole';
import { batchRunReports, listKeyEvents, runReport } from '../integrations/google/analytics';
import {
  GA4_TOTAL_METRICS,
  GSC_TIME_ZONE,
  addDays,
  change,
  dateInZone,
  datesOf,
  ga4Date,
  gscDaily,
  gscTotals,
  movers,
  periods,
  toItems,
  worthReviewing,
  type Change,
  type Ga4TotalMetric,
  type RangeDays,
} from '../integrations/google/reports';

/**
 * Search Console and GA4 for the admin: connection state, connection tests and
 * the two performance reports. Every Google call goes through
 * integrations/google; this file decides what to ask for, caches the answers
 * and keeps a small sync record (last success, last failure, latest data
 * date) so the Integrations screen can say how things stand without calling
 * Google on every visit.
 *
 * Reports are cached (Search Console 6 h — its data moves once a day;
 * GA4 1 h) and the last good copy is kept for a week, so a quota or outage
 * shows the previous report, marked stale, instead of a blank page. After a
 * quota answer no report request goes to Google for at least 15 minutes.
 */

const GSC_TTL_S = 6 * 3600;
const GA4_TTL_S = 3600;
const LAST_GOOD_TTL_S = 7 * 86_400;
const STATUS_TTL_S = 30 * 86_400;
/** Search Console: "If you exceed your quota, wait 15 minutes and try again." */
const QUOTA_COOLDOWN_MS = 15 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

export interface SafeError {
  kind: GoogleErrorKind;
  message: string;
  retryAfterSeconds: number | null;
}

const safe = (err: unknown): SafeError => {
  const e = toGoogleError(err);
  return { kind: e.kind, message: e.safeMessage, retryAfterSeconds: e.retryAfterSeconds };
};

/* ── Sync record ──────────────────────────────────────────────────────────── */

export interface SyncStatus {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: SafeError | null;
  /** After a quota answer: no report request goes to Google before this time. */
  cooldownUntil: string | null;
  /** Search Console: newest day with data (Pacific Time). GA4: newest day with any activity (property time zone). */
  latestDataDate: string | null;
  permissionLevel: string | null;
  timeZone: string | null;
}

const EMPTY_STATUS: SyncStatus = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
  cooldownUntil: null,
  latestDataDate: null,
  permissionLevel: null,
  timeZone: null,
};

// The record is per property, so pointing the integration at another property starts clean.
const statusKey = (provider: Provider, identifier: string) =>
  `analytics:status:${provider}:${crypto.createHash('sha256').update(identifier).digest('hex').slice(0, 16)}`;

/** Without Redis (local runs, an outage) the record lives in this instance only. */
const memoryStatus = new Map<string, SyncStatus>();

async function readStatus(provider: Provider, identifier: string): Promise<SyncStatus> {
  const key = statusKey(provider, identifier);
  const stored = (await cacheGet<SyncStatus>(key)) ?? memoryStatus.get(key);
  return { ...EMPTY_STATUS, ...stored };
}

async function writeStatus(provider: Provider, identifier: string, patch: Partial<SyncStatus>): Promise<void> {
  const key = statusKey(provider, identifier);
  const next = { ...(await readStatus(provider, identifier)), ...patch };
  memoryStatus.set(key, next);
  await cacheSet(key, next, STATUS_TTL_S);
}

// A success does not end a quota pause: a cheap request (a connection test, a
// report that started before the quota answer) can succeed while the quota a
// full report needs is still spent. The pause simply runs out.
const recordSuccess = (provider: Provider, identifier: string, now: number, patch: Partial<SyncStatus> = {}) =>
  writeStatus(provider, identifier, { lastSuccessAt: iso(now), ...patch });

const recordFailure = (provider: Provider, identifier: string, now: number, err: SafeError) =>
  writeStatus(provider, identifier, {
    lastFailureAt: iso(now),
    lastFailure: err,
    ...(err.kind === 'quota' ? { cooldownUntil: iso(now + Math.max(QUOTA_COOLDOWN_MS, (err.retryAfterSeconds ?? 0) * 1000)) } : {}),
  });

/* ── Connection state ─────────────────────────────────────────────────────── */

export type Connection = 'not-configured' | 'invalid' | 'unchecked' | 'connected' | 'error';

function connectionOf(configState: 'configured' | 'not-configured' | 'invalid', status: SyncStatus): Connection {
  if (configState !== 'configured') return configState;
  if (!status.lastSuccessAt && !status.lastFailureAt) return 'unchecked';
  if (status.lastFailureAt && (!status.lastSuccessAt || status.lastFailureAt > status.lastSuccessAt)) return 'error';
  return 'connected';
}

// resource_id selects the property. Google uses it in its own links (URL
// Inspection results) but does not document it for these pages, so the admin
// labels them "Open in Search Console" and never promises a particular screen.
const consoleLinks = (siteUrl: string | null) => {
  const q = siteUrl ? `?resource_id=${encodeURIComponent(siteUrl)}` : '';
  return {
    open: `https://search.google.com/search-console${q}`,
    performance: `https://search.google.com/search-console/performance/search-analytics${q}`,
    users: `https://search.google.com/search-console/users${q}`,
  };
};

// Google documents no deep links into a GA4 property, so this opens Analytics and
// the setup steps name the screens (Admin → Property access management).
const analyticsLinks = () => ({ open: 'https://analytics.google.com/analytics/web/' });

export async function integrationView(provider: Provider) {
  const config = publicConfig(provider);
  const status = config.identifier ? await readStatus(provider, config.identifier) : EMPTY_STATUS;
  return {
    provider,
    label: provider === 'search-console' ? 'Google Search Console' : 'Google Analytics 4',
    config,
    status,
    connection: connectionOf(config.state, status),
    links: provider === 'search-console' ? consoleLinks(config.identifier) : analyticsLinks(),
  };
}

export type IntegrationView = Awaited<ReturnType<typeof integrationView>>;

export async function integrations() {
  const [searchConsole, analytics] = await Promise.all([integrationView('search-console'), integrationView('analytics')]);
  return { searchConsole, analytics };
}

/* ── Connection tests ─────────────────────────────────────────────────────── */

export interface TestCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface TestResult {
  ok: boolean;
  checks: TestCheck[];
  testedAt: string;
}

const notReady = (provider: Provider): TestResult | null => {
  const config = publicConfig(provider);
  if (config.state === 'configured') return null;
  const message =
    config.state === 'not-configured'
      ? `Not configured: set ${config.missing.join(', ')} in the API's environment.`
      : config.problems.join(' ');
  return { ok: false, checks: [{ name: 'Configuration', ok: false, message }], testedAt: new Date(googleDeps().now()).toISOString() };
};

/** Ask Google whether the service account can read the property, and record the outcome. */
export async function testSearchConsole(): Promise<TestResult> {
  const blocked = notReady('search-console');
  if (blocked) return blocked;
  const config = searchConsoleConfig();
  if (config.state !== 'configured') throw new Error('unreachable');
  const deps = googleDeps();
  const now = deps.now();
  const checks: TestCheck[] = [{ name: 'Configuration', ok: true, message: 'All variables are set and well formed.' }];
  try {
    const site = await getSite(config.value, deps);
    if (!(READ_LEVELS as readonly string[]).includes(site.permissionLevel)) {
      throw new GoogleApiError('permission-denied', 'The service account is not a user of this property. Add it under Settings → Users and permissions.');
    }
    checks.push({ name: 'Property access', ok: true, message: `Access to ${site.siteUrl} (${site.permissionLevel}).` });
    const latest = await latestGscDate(config.value, now, deps);
    checks.push({
      name: 'Search data',
      ok: true,
      message: latest ? `Data available up to ${latest}.` : 'Connected, but Search Console has no data for the last two weeks.',
    });
    await recordSuccess('search-console', config.value.siteUrl, now, { permissionLevel: site.permissionLevel, latestDataDate: latest });
    return { ok: true, checks, testedAt: new Date(now).toISOString() };
  } catch (err) {
    const e = safe(err);
    checks.push({ name: 'Property access', ok: false, message: e.message });
    await recordFailure('search-console', config.value.siteUrl, now, e);
    return { ok: false, checks, testedAt: new Date(now).toISOString() };
  }
}

export async function testAnalytics(): Promise<TestResult> {
  const blocked = notReady('analytics');
  if (blocked) return blocked;
  const config = analyticsConfig();
  if (config.state !== 'configured') throw new Error('unreachable');
  const deps = googleDeps();
  const now = deps.now();
  const checks: TestCheck[] = [{ name: 'Configuration', ok: true, message: 'All variables are set and well formed.' }];
  try {
    const report = await runReport(config.value, { dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }], metrics: ['activeUsers'] }, deps);
    checks.push({ name: 'Reports (Data API)', ok: true, message: `Reports can be read. Property time zone: ${report.timeZone ?? 'not reported'}.` });
    await recordSuccess('analytics', config.value.propertyId, now, { timeZone: report.timeZone });
  } catch (err) {
    const e = safe(err);
    checks.push({ name: 'Reports (Data API)', ok: false, message: e.message });
    await recordFailure('analytics', config.value.propertyId, now, e);
    return { ok: false, checks, testedAt: new Date(now).toISOString() };
  }
  // The key-event list needs the Admin API too; without it the reports still work.
  try {
    const events = await listKeyEvents(config.value, deps);
    checks.push({
      name: 'Key events (Admin API)',
      ok: true,
      message: events.length ? `${events.length} key event${events.length === 1 ? '' : 's'}: ${events.map((e) => e.eventName).join(', ')}.` : 'No key events are marked in this property yet.',
    });
  } catch (err) {
    checks.push({ name: 'Key events (Admin API)', ok: false, message: safe(err).message });
  }
  return { ok: checks.every((c) => c.ok), checks, testedAt: new Date(now).toISOString() };
}

/* ── Report cache ─────────────────────────────────────────────────────────── */

interface Entry<T> {
  report: T;
  fetchedAt: string;
}

export interface Served<T> extends Entry<T> {
  /** True when this is the last good copy: Google failed, or we are holding off after a quota answer. */
  stale: boolean;
}

interface Outcome<T> {
  served: Served<T> | null;
  /** Why the report is stale or missing. */
  error: SafeError | null;
  /** What Google answered this time; null when it was not asked (cache hit, holding off). */
  asked: 'ok' | SafeError | null;
}

/** Builds in progress, so simultaneous requests for one report share a single set of Google calls. */
const inflight = new Map<string, Promise<Entry<unknown>>>();

async function serve<T>(
  key: string,
  ttl: number,
  opts: { refresh: boolean; now: number; cooldownUntil: string | null },
  build: () => Promise<T>,
): Promise<Outcome<T>> {
  if (!opts.refresh) {
    const hit = await cacheGet<Entry<T>>(key);
    if (hit) return { served: { ...hit, stale: false }, error: null, asked: null };
  }
  const lastGood = async () => {
    const last = await cacheGet<Entry<T>>(`${key}:last-good`);
    return last ? { ...last, stale: true } : null;
  };

  const until = opts.cooldownUntil ? Date.parse(opts.cooldownUntil) : NaN;
  if (until > opts.now) {
    const minutes = Math.ceil((until - opts.now) / 60_000);
    const error: SafeError = {
      kind: 'quota',
      message: `Google's request quota was reached, so requests are paused for about ${minutes} more minute${minutes === 1 ? '' : 's'}.`,
      retryAfterSeconds: Math.ceil((until - opts.now) / 1000),
    };
    return { served: await lastGood(), error, asked: null };
  }

  let pending = inflight.get(key) as Promise<Entry<T>> | undefined;
  if (!pending) {
    pending = (async () => {
      const entry: Entry<T> = { report: await build(), fetchedAt: iso(opts.now) };
      await Promise.all([cacheSet(key, entry, ttl), cacheSet(`${key}:last-good`, entry, LAST_GOOD_TTL_S)]);
      return entry;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  try {
    return { served: { ...(await pending), stale: false }, error: null, asked: 'ok' };
  } catch (err) {
    const error = safe(err);
    return { served: await lastGood(), error, asked: error };
  }
}

const hashOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/* ── Search Console report ────────────────────────────────────────────────── */

/** Newest complete day Search Console has, looking back two weeks (Pacific Time dates). */
async function latestGscDate(config: Parameters<typeof searchAnalytics>[0], now: number, deps = googleDeps()): Promise<string | null> {
  const today = dateInZone(now, GSC_TIME_ZONE);
  const rows = await searchAnalytics(config, { startDate: addDays(today, -14), endDate: today, dimensions: ['date'], rowLimit: 30 }, deps);
  const dates = rows.map((r) => r.keys[0]).filter(Boolean).sort();
  return dates.at(-1) ?? null;
}

type GscConfig = Parameters<typeof searchAnalytics>[0];

async function buildSearchConsole(config: GscConfig, range: RangeDays, now: number, deps: ReturnType<typeof googleDeps>) {
  const siteUrl = config.siteUrl;
  const latest = await latestGscDate(config, now, deps);
  if (!latest) return { empty: true as const, siteUrl, range, latestDataDate: null };
  const { current, previous } = periods(latest, range);
  const q = (dimensions: GscDimension[], p: { startDate: string; endDate: string }, rowLimit: number): Promise<GscRow[]> =>
    searchAnalytics(config, { ...p, dimensions, rowLimit }, deps);
  // Totals come from the date rows (aggregated by property, like Search Console's
  // chart), never from summing query or page rows, which leave out anonymised queries.
  const [daily, queriesNow, queriesBefore, pagesNow, pagesBefore, devices, countries] = await Promise.all([
    q(['date'], { startDate: previous.startDate, endDate: current.endDate }, 500),
    q(['query'], current, 250),
    q(['query'], previous, 250),
    q(['page'], current, 250),
    q(['page'], previous, 250),
    q(['device'], current, 10),
    q(['country'], current, 10),
  ]);
  const inPeriod = (p: { startDate: string; endDate: string }) => daily.filter((r) => r.keys[0] >= p.startDate && r.keys[0] <= p.endDate);
  const totalsNow = gscTotals(inPeriod(current));
  const totalsBefore = gscTotals(inPeriod(previous));
  const qNow = toItems(queriesNow);
  const qBefore = toItems(queriesBefore);
  const pNow = toItems(pagesNow);
  const pBefore = toItems(pagesBefore);
  return {
    empty: false as const,
    siteUrl,
    range,
    latestDataDate: latest,
    timeZone: GSC_TIME_ZONE,
    current,
    previous,
    totals: {
      clicks: change(totalsNow.clicks, totalsBefore.clicks),
      impressions: change(totalsNow.impressions, totalsBefore.impressions),
      ctr: change(totalsNow.ctr, totalsBefore.impressions ? totalsBefore.ctr : null),
      position: totalsNow.position !== null ? change(totalsNow.position, totalsBefore.position) : null,
    },
    daily: gscDaily(inPeriod(current), current),
    topQueries: qNow.slice(0, 25),
    topPages: pNow.slice(0, 25),
    devices: toItems(devices),
    countries: toItems(countries),
    queryMovers: movers(qNow, qBefore),
    pageMovers: movers(pNow, pBefore),
    reviewQueries: worthReviewing(qNow, qBefore),
    reviewPages: worthReviewing(pNow, pBefore),
    listLimits: { queries: 250, pages: 250 },
  };
}

export async function searchConsoleReport(range: RangeDays, refresh = false) {
  const config = searchConsoleConfig();
  if (config.state !== 'configured') return { connection: await integrationView('search-console'), served: null, error: null };

  const deps = googleDeps();
  const now = deps.now();
  const siteUrl = config.value.siteUrl;
  const { cooldownUntil } = await readStatus('search-console', siteUrl);
  const outcome = await serve(`analytics:gsc:${hashOf(siteUrl)}:${range}`, GSC_TTL_S, { refresh, now, cooldownUntil }, () =>
    buildSearchConsole(config.value, range, now, deps),
  );
  if (outcome.asked === 'ok' && outcome.served) {
    await recordSuccess('search-console', siteUrl, now, { latestDataDate: outcome.served.report.latestDataDate });
  } else if (outcome.asked && outcome.asked !== 'ok') {
    await recordFailure('search-console', siteUrl, now, outcome.asked);
  }
  return { connection: await integrationView('search-console'), served: outcome.served, error: outcome.error };
}

/* ── GA4 report ───────────────────────────────────────────────────────────── */

type Ga4Config = Parameters<typeof runReport>[0];

// Relative dates are resolved by GA4 in the property's own time zone; whole days
// only, ending yesterday as GA4's own "Last N days" do.
const ga4Ranges = (range: RangeDays) => ({
  current: { startDate: `${range}daysAgo`, endDate: 'yesterday', name: 'current' },
  previous: { startDate: `${2 * range}daysAgo`, endDate: `${range + 1}daysAgo`, name: 'previous' },
});

/** The calendar dates GA4 resolved those ranges to, in the property's time zone. */
function ga4Dates(range: RangeDays, now: number, timeZone: string | null) {
  if (!timeZone) return null;
  const today = dateInZone(now, timeZone);
  return {
    current: { startDate: addDays(today, -range), endDate: addDays(today, -1) },
    previous: { startDate: addDays(today, -2 * range), endDate: addDays(today, -range - 1) },
  };
}

/** Google's own definition of Google organic traffic in GA4, to set beside Search Console clicks. */
export const GOOGLE_ORGANIC = 'google / organic';

async function buildAnalytics(config: Ga4Config, range: RangeDays, now: number, deps: ReturnType<typeof googleDeps>) {
  const { current, previous } = ga4Ranges(range);
  // The key-event list comes from the Admin API (its own quota); a failure there
  // leaves the rest of the report intact.
  const keyEventsList = listKeyEvents(config, deps).then(
    (list) => ({ ok: true as const, list }),
    (err) => ({ ok: false as const, error: safe(err) }),
  );
  // One batch: a single request against the property's concurrency limit.
  const [[totals, daily, landing, sources, channels], keyEvents] = await Promise.all([
    batchRunReports(
      config,
      [
        { dateRanges: [current, previous], metrics: [...GA4_TOTAL_METRICS] },
        { dateRanges: [current], dimensions: ['date'], metrics: ['activeUsers', 'sessions', 'screenPageViews'], limit: 100 },
        { dateRanges: [current], dimensions: ['landingPage'], metrics: ['sessions', 'engagementRate', 'keyEvents'], orderByMetric: 'sessions', limit: 25 },
        { dateRanges: [current], dimensions: ['sessionSourceMedium'], metrics: ['sessions', 'engagedSessions', 'keyEvents'], orderByMetric: 'sessions', limit: 25 },
        { dateRanges: [current, previous], dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions'], orderByMetric: 'sessions', limit: 50 },
      ],
      deps,
    ),
    keyEventsList,
  ]);

  // With two date ranges GA4 adds a dateRange dimension holding each range's name.
  const rangeIdx = totals.dimensionHeaders.indexOf('dateRange');
  const pick = (name: string) => totals.rows.find((r) => (rangeIdx === -1 ? name === 'current' : r.dimensions[rangeIdx] === name));
  const t = { current: pick('current'), previous: pick('previous') };
  // No row for the current range means GA4 recorded nothing in it: a real zero.
  // No row for the previous one means there is nothing to compare with.
  const metric = (name: string) => {
    const i = totals.metricHeaders.indexOf(name);
    return change(t.current?.metrics[i] ?? 0, t.previous ? t.previous.metrics[i] : null);
  };

  // Counts for the property's own key events. Google's schema does not spell out
  // keyEvents by eventName, so a refusal here is reported, not fatal.
  type KeyEventCount = { eventName: string; countingMethod: string | null; count: Change | null };
  let keyEventSection: { available: true; list: KeyEventCount[]; countsError: SafeError | null } | { available: false; error: SafeError };
  if (!keyEvents.ok) {
    keyEventSection = { available: false, error: keyEvents.error };
  } else if (keyEvents.list.length === 0) {
    keyEventSection = { available: true, list: [], countsError: null };
  } else {
    try {
      const counts = await runReport(
        config,
        {
          dateRanges: [current, previous],
          dimensions: ['eventName'],
          metrics: ['keyEvents'],
          inList: { dimension: 'eventName', values: keyEvents.list.map((k) => k.eventName) },
          limit: 100,
        },
        deps,
      );
      const ei = counts.dimensionHeaders.indexOf('eventName');
      const ri = counts.dimensionHeaders.indexOf('dateRange');
      const value = (event: string, name: string) => counts.rows.find((r) => r.dimensions[ei] === event && r.dimensions[ri] === name)?.metrics[0] ?? 0;
      keyEventSection = {
        available: true,
        list: keyEvents.list.map((k) => ({
          ...k,
          // Like the totals: with no previous-period data at all there is nothing to compare with.
          count: change(value(k.eventName, 'current'), t.previous ? value(k.eventName, 'previous') : null),
        })),
        countsError: null,
      };
    } catch (err) {
      const e = safe(err);
      // A quota answer is about the whole property: fail the report so the pause starts.
      if (e.kind === 'quota') throw err;
      keyEventSection = { available: true, list: keyEvents.list.map((k) => ({ ...k, count: null })), countsError: e };
    }
  }

  const channelRows = (name: string) => {
    const di = channels.dimensionHeaders.indexOf('sessionDefaultChannelGroup');
    const ri = channels.dimensionHeaders.indexOf('dateRange');
    return channels.rows.filter((r) => r.dimensions[ri] === name).map((r) => ({ channel: r.dimensions[di], sessions: r.metrics[0] }));
  };
  const channelsBefore = new Map(channelRows('previous').map((c) => [c.channel, c.sessions]));
  // A channel missing from the previous period is a zero only if the list was not cut off.
  const channelsComplete = channels.rowCount <= channels.rows.length;

  const sourceRows = sources.rows.map((r) => ({ sourceMedium: r.dimensions[0], sessions: r.metrics[0], engagedSessions: r.metrics[1], keyEvents: r.metrics[2] }));
  const googleRow = sourceRows.find((s) => s.sourceMedium === GOOGLE_ORGANIC);
  // Absent from a complete list is zero; absent from a cut-off list is unknown.
  const googleOrganicSessions = googleRow ? googleRow.sessions : sources.rowCount <= sources.rows.length ? 0 : null;

  const reports = [totals, daily, landing, sources, channels];
  const dates = ga4Dates(range, now, totals.timeZone);
  const dayRows = daily.rows.map((r) => ({ date: ga4Date(r.dimensions[0]), activeUsers: r.metrics[0], sessions: r.metrics[1], views: r.metrics[2] }));
  // GA4 leaves out days with no activity; every day of the period is shown, those as zero.
  const byDate = new Map(dayRows.map((d) => [d.date, d]));
  const dailyFilled = dates
    ? datesOf(dates.current).map((date) => byDate.get(date) ?? { date, activeUsers: 0, sessions: 0, views: 0 })
    : dayRows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    propertyId: config.propertyId,
    range,
    timeZone: totals.timeZone,
    dates,
    /** The newest day GA4 returned any activity for; null when none. */
    latestDataDate: dayRows.reduce<string | null>((latest, d) => (latest === null || d.date > latest ? d.date : latest), null),
    quality: {
      thresholded: reports.some((r) => r.quality.thresholded),
      sampled: reports.some((r) => r.quality.sampled),
      otherRow: reports.some((r) => r.quality.otherRow),
    },
    totals: Object.fromEntries(GA4_TOTAL_METRICS.map((m) => [m, metric(m)])) as Record<Ga4TotalMetric, Change>,
    daily: dailyFilled,
    landingPages: landing.rows.map((r) => ({ page: r.dimensions[0], sessions: r.metrics[0], engagementRate: r.metrics[1], keyEvents: r.metrics[2] })),
    sourceMedium: sourceRows,
    channels: channelRows('current').map((c) => ({
      channel: c.channel,
      sessions: change(c.sessions, channelsBefore.get(c.channel) ?? (channelsComplete ? 0 : null)),
    })),
    channelsComplete,
    googleOrganicSessions,
    keyEvents: keyEventSection,
    listLimits: { rows: 25, landingPages: landing.rowCount, sourceMedium: sources.rowCount },
  };
}

export async function analyticsReport(range: RangeDays, refresh = false) {
  const config = analyticsConfig();
  if (config.state !== 'configured') return { connection: await integrationView('analytics'), served: null, error: null };

  const deps = googleDeps();
  const now = deps.now();
  const propertyId = config.value.propertyId;
  const { cooldownUntil } = await readStatus('analytics', propertyId);
  const outcome = await serve(`analytics:ga4:${hashOf(propertyId)}:${range}`, GA4_TTL_S, { refresh, now, cooldownUntil }, () =>
    buildAnalytics(config.value, range, now, deps),
  );
  if (outcome.asked === 'ok' && outcome.served) {
    const { timeZone, latestDataDate } = outcome.served.report;
    await recordSuccess('analytics', propertyId, now, { timeZone, latestDataDate });
  } else if (outcome.asked && outcome.asked !== 'ok') {
    await recordFailure('analytics', propertyId, now, outcome.asked);
  }
  return { connection: await integrationView('analytics'), served: outcome.served, error: outcome.error };
}

/* ── For the dashboard: state from configuration and the sync record only ─── */

export async function googleIntegrationStatuses() {
  const views = await integrations();
  return [views.searchConsole, views.analytics].map((v) => ({
    id: v.provider,
    state:
      v.connection === 'connected'
        ? ('ok' as const)
        : v.connection === 'not-configured'
          ? ('not-configured' as const)
          : v.connection === 'unchecked'
            ? ('unchecked' as const)
            : v.connection === 'invalid'
              ? ('misconfigured' as const)
              : ('degraded' as const),
    problem:
      v.connection === 'invalid'
        ? v.config.problems.join(' ')
        : v.connection === 'error'
          ? (v.status.lastFailure?.message ?? 'The last request to Google failed.')
          : v.connection === 'not-configured'
            ? `${v.config.missing.join(', ')} not set`
            : null,
    envVars: v.config.envVars,
  }));
}
