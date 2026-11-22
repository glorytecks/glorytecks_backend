import './setup';
// AFTER './setup', which disables the cache for every other suite.
import './redisTestEnv';
import { SUBJECT, resetDb } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { FakeRedisServer } from './fakeRedisServer';
import { setGoogleDepsForTests } from '../src/integrations/google/http';
import { clearTokenCache } from '../src/integrations/google/auth';

/**
 * Search Console and GA4 through the real routes, middleware, cache (a fake
 * Redis) and services, with Google answered by a FIXTURE. The service account
 * key is generated for this run; the property ids and every number are made
 * up. Nothing reaches Google.
 */

const API = '/api/v1/analytics';
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_BODY = PEM.split('\n')[1];
const TOKEN = 'ya29.FIXTURE-ACCESS-TOKEN-0123456789';
const EMAIL = 'gt-analytics-reader@fixture-project.iam.gserviceaccount.com';
const SITE = 'sc-domain:glorytecks.com';
const PROPERTY = '123456789';

/* ── A FIXTURE Google ─────────────────────────────────────────────────────── */

type Mode = 'ok' | 'empty' | 'quota' | 'down' | 'bad-key' | 'no-access';
const google = { mode: 'ok' as Mode, calls: [] as { url: string; body: any }[], keyEvents: ['generate_lead'] as string[], refuseKeyEventCounts: false as boolean | 'quota' };
let NOW = Date.parse('2026-10-25T10:00:00Z');

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const day = (d: string) => Number(d.slice(8, 10));

function gscRows(body: any) {
  const dims: string[] = body.dimensions;
  if (google.mode === 'empty') return {};
  // Days up to 2026-10-22 have data (Search Console runs a few days behind).
  const latest = '2026-10-22';
  const end = body.endDate < latest ? body.endDate : latest;
  if (dims[0] === 'date') {
    const rows = [];
    for (let t = Date.parse(body.startDate); new Date(t).toISOString().slice(0, 10) <= end; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      rows.push({ keys: [d], clicks: day(d), impressions: day(d) * 20, ctr: 0.05, position: 6 });
    }
    return { rows, responseAggregationType: 'byProperty' };
  }
  // The current period ends on the latest data day; the previous one before it.
  const recent = body.endDate >= latest;
  const lists: Record<string, any[]> = {
    query: recent
      ? [
          { keys: ['python course hyderabad'], clicks: 60, impressions: 1500, ctr: 0.04, position: 4.2 },
          { keys: ['data science course'], clicks: 8, impressions: 900, ctr: 0.0089, position: 9.5 },
          { keys: ['power bi training'], clicks: 2, impressions: 400, ctr: 0.005, position: 6 },
        ]
      : [
          { keys: ['python course hyderabad'], clicks: 30, impressions: 1200, ctr: 0.025, position: 5 },
          { keys: ['data science course'], clicks: 25, impressions: 950, ctr: 0.026, position: 7 },
        ],
    page: [{ keys: ['https://glorytecks.com/courses/python-programming'], clicks: recent ? 70 : 40, impressions: 2000, ctr: recent ? 0.035 : 0.02, position: 5 }],
    device: [
      { keys: ['MOBILE'], clicks: 50, impressions: 1800, ctr: 0.0278, position: 5.5 },
      { keys: ['DESKTOP'], clicks: 20, impressions: 900, ctr: 0.0222, position: 6.1 },
    ],
    country: [{ keys: ['ind'], clicks: 65, impressions: 2500, ctr: 0.026, position: 5.4 }],
  };
  return { rows: lists[dims[0]] ?? [] };
}

function ga4Report(body: any) {
  const ranges: { name?: string }[] = body.dateRanges;
  const dims: string[] = (body.dimensions ?? []).map((d: { name: string }) => d.name);
  const metrics: string[] = body.metrics.map((m: { name: string }) => m.name);
  const multi = ranges.length > 1;
  const headers = { dimensionHeaders: [...dims, ...(multi ? ['dateRange'] : [])].map((name) => ({ name })), metricHeaders: metrics.map((name) => ({ name, type: 'TYPE_INTEGER' })) };
  // ProtoJSON leaves out empty lists and zero counts: an empty report has no rows and no rowCount.
  if (google.mode === 'empty') return { ...headers, metadata: { timeZone: 'Asia/Kolkata' }, kind: 'analyticsData#runReport' };
  const value = (m: string, range: string) => {
    const base: Record<string, number> = { activeUsers: 1200, sessions: 1800, screenPageViews: 5400, engagedSessions: 1100, engagementRate: 0.611, keyEvents: 42 };
    const v = base[m] ?? 10;
    return String(range === 'previous' ? Math.round(v * 0.8 * 1000) / 1000 : v);
  };
  const rows: any[] = [];
  const dimValues: Record<string, string[]> = {
    date: ['20261022', '20261023', '20261024'],
    landingPage: ['/', '/courses/python-programming'],
    sessionSourceMedium: ['google / organic', '(direct) / (none)'],
    sessionDefaultChannelGroup: ['Organic Search', 'Direct'],
    eventName: body.dimensionFilter?.filter?.inListFilter?.values ?? [],
  };
  for (const range of ranges.map((r, i) => r.name ?? `date_range_${i}`)) {
    const combos = dims.length ? dimValues[dims[0]].map((v) => [v]) : [[]];
    for (const combo of combos) {
      rows.push({ dimensionValues: [...combo, ...(multi ? [range] : [])].map((value) => ({ value })), metricValues: metrics.map((m) => ({ value: value(m, range) })) });
    }
  }
  return { ...headers, rows, rowCount: rows.length, metadata: { timeZone: 'Asia/Kolkata', currencyCode: 'INR' } };
}

const fakeFetch = (async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const body = init.body ? (url.includes('oauth2') ? Object.fromEntries(new URLSearchParams(String(init.body))) : JSON.parse(String(init.body))) : null;
  google.calls.push({ url, body });
  if (google.mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  if (url === 'https://oauth2.googleapis.com/token') {
    if (google.mode === 'bad-key') return json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    return json(200, { access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' });
  }
  const auth = new Headers(init.headers).get('authorization');
  if (auth !== `Bearer ${TOKEN}`) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } });
  if (google.mode === 'quota') {
    return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per day.' } }, { 'retry-after': '3600' });
  }
  if (google.mode === 'no-access') return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: `User does not have sufficient permission for site '${SITE}'.` } });
  if (url === `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}`) {
    return json(200, { siteUrl: SITE, permissionLevel: 'siteRestrictedUser' });
  }
  if (url === `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`) return json(200, gscRows(body));
  if (url === `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`) {
    if (google.refuseKeyEventCounts === 'quota' && body.dimensions?.[0]?.name === 'eventName') {
      return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per hour.' } });
    }
    if (google.refuseKeyEventCounts && body.dimensions?.[0]?.name === 'eventName') {
      return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Please remove eventName to make the request compatible.' } });
    }
    return json(200, ga4Report(body));
  }
  if (url === `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:batchRunReports`) {
    return json(200, { reports: body.requests.map(ga4Report), kind: 'analyticsData#batchRunReports' });
  }
  if (url.startsWith(`https://analyticsadmin.googleapis.com/v1beta/properties/${PROPERTY}/keyEvents`)) {
    return json(200, { keyEvents: google.keyEvents.map((eventName, i) => ({ name: `properties/${PROPERTY}/keyEvents/${i}`, eventName, createTime: '2026-05-01T09:00:00Z', deletable: true, custom: true, countingMethod: 'ONCE_PER_EVENT' })) });
  }
  return json(404, { error: { code: 404, status: 'NOT_FOUND', message: `No fixture for ${url}` } });
}) as unknown as typeof fetch;

/* ── Server, roles, logs ──────────────────────────────────────────────────── */

let redis: FakeRedisServer;
let server: http.Server;
let base: string;
const captured: string[] = [];
const realStdout = process.stdout.write.bind(process.stdout);
const realStderr = process.stderr.write.bind(process.stderr);

test.before(async () => {
  redis = new FakeRedisServer();
  process.env.REDIS_URL = `redis://127.0.0.1:${await redis.listen()}`;
  const { connectRedis, isRedisReady } = await import('../src/config/redis');
  await connectRedis();
  for (let i = 0; i < 100 && !isRedisReady(); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(isRedisReady());
  const app = (await import('../src/app')).default;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setGoogleDepsForTests({ fetch: fakeFetch, sleep: async () => undefined, now: () => NOW });
  // Everything the API writes to the console, so the last test can look for secrets in it.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (realStdout as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (realStderr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

test.after(async () => {
  process.stdout.write = realStdout;
  process.stderr.write = realStderr;
  setGoogleDepsForTests(null);
  server.close();
  const { disconnectRedis } = await import('../src/config/redis');
  await disconnectRedis();
  redis.close();
});

type Who = keyof typeof SUBJECT;
const token = (who: Who) => jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });
const responses: string[] = [];

async function call(path: string, opts: { method?: string; who?: Who | null } = {}) {
  NOW += 1000; // time passes between requests, so "last success" and "last failure" can be ordered
  const who = opts.who === undefined ? 'admin' : opts.who;
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers: who ? { Authorization: `Bearer ${token(who)}` } : {} });
  const raw = await res.text();
  responses.push(raw);
  return { status: res.status, raw, json: raw ? JSON.parse(raw) : null };
}

const configure = (vars: Partial<Record<'email' | 'key' | 'site' | 'property', string>> = {}) => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = vars.email ?? EMAIL;
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = vars.key ?? PEM.replace(/\n/g, '\\n');
  process.env.GSC_SITE_URL = vars.site ?? SITE;
  process.env.GA4_PROPERTY_ID = vars.property ?? PROPERTY;
};
const unconfigure = () => {
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GSC_SITE_URL', 'GA4_PROPERTY_ID']) process.env[k] = '';
};

/* ── Access ───────────────────────────────────────────────────────────────── */

const ROUTES: [string, string][] = [
  ['GET', `${API}/integrations`],
  ['POST', `${API}/integrations/search-console/test`],
  ['POST', `${API}/integrations/analytics/test`],
  ['GET', `${API}/search-console?range=28`],
  ['GET', `${API}/ga4?range=28`],
];

test('role checks: only administrators reach analytics; 401 without a session', async () => {
  resetDb();
  for (const [method, path] of ROUTES) {
    assert.equal((await call(path, { method, who: null })).status, 401, `${method} ${path}`);
    for (const who of ['receptionist', 'content_writer', 'editor', 'viewer'] as Who[]) {
      assert.equal((await call(path, { method, who })).status, 403, `${who} ${method} ${path}`);
    }
  }
  assert.equal(google.calls.length, 0, 'nothing refused reached Google');
});

test('parameters outside their closed sets are refused', async () => {
  for (const q of ['range=30', 'range=7&range=28', 'refresh=yes', 'range=-1']) assert.equal((await call(`${API}/search-console?${q}`)).status, 422, q);
  assert.equal((await call(`${API}/integrations/bigquery/test`, { method: 'POST' })).status, 422);
});

/* ── Not configured / invalid ─────────────────────────────────────────────── */

test('credentials absent: a disconnected state with the variables to set, never zeros', async () => {
  unconfigure();
  const list = await call(`${API}/integrations`);
  assert.equal(list.status, 200);
  assert.equal(list.json.data.searchConsole.connection, 'not-configured');
  assert.deepEqual(list.json.data.analytics.config.missing, ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GA4_PROPERTY_ID']);
  const report = await call(`${API}/search-console?range=28`);
  assert.equal(report.status, 200);
  assert.equal(report.json.data.report, null, 'no report, not an empty one');
  assert.equal(report.json.data.connection.connection, 'not-configured');
  const testRun = await call(`${API}/integrations/analytics/test`, { method: 'POST' });
  assert.equal(testRun.json.data.ok, false);
  assert.match(testRun.json.data.checks[0].message, /set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GA4_PROPERTY_ID/);
  assert.equal(google.calls.length, 0);
});

test('invalid configuration: problems by variable name, nothing sent to Google', async () => {
  configure({ key: 'MIIE-NOT-A-REAL-KEY', property: 'G-MKXRJHXL9C' });
  const list = await call(`${API}/integrations`);
  assert.equal(list.json.data.analytics.connection, 'invalid');
  assert.match(list.json.data.analytics.config.problems.join(' '), /GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not a PEM private key.*GA4_PROPERTY_ID must be the numeric/s);
  assert.doesNotMatch(list.raw, /MIIE-NOT-A-REAL-KEY/);
  const status = (await call('/api/v1/dashboard/status')).json.data;
  const ga = status.integrations.find((i: any) => i.id === 'analytics');
  assert.equal(ga.state, 'misconfigured', 'set wrongly, not "unreachable": nothing was sent');
  assert.match(ga.problem, /GA4_PROPERTY_ID must be the numeric/);
  assert.equal(google.calls.length, 0);
});

/* ── Connected ────────────────────────────────────────────────────────────── */

test('test connection: checks property access and data, and records the last successful sync', async () => {
  configure();
  clearTokenCache();
  const sc = await call(`${API}/integrations/search-console/test`, { method: 'POST' });
  assert.equal(sc.json.data.ok, true, sc.raw);
  assert.deepEqual(sc.json.data.checks.map((c: any) => c.name), ['Configuration', 'Property access', 'Search data']);
  assert.match(sc.json.data.checks[2].message, /Data available up to 2026-10-22/);
  const ga = await call(`${API}/integrations/analytics/test`, { method: 'POST' });
  assert.equal(ga.json.data.ok, true, ga.raw);
  assert.match(ga.json.data.checks[1].message, /time zone: Asia\/Kolkata/);
  assert.match(ga.json.data.checks[2].message, /1 key event: generate_lead/);

  const list = (await call(`${API}/integrations`)).json.data;
  assert.equal(list.searchConsole.connection, 'connected');
  assert.equal(list.searchConsole.status.lastSuccessAt, sc.json.data.testedAt);
  assert.equal(list.searchConsole.status.latestDataDate, '2026-10-22');
  assert.equal(list.searchConsole.status.permissionLevel, 'siteRestrictedUser');
  assert.equal(list.searchConsole.config.serviceAccountEmail, EMAIL);
  assert.equal(list.analytics.status.timeZone, 'Asia/Kolkata');
  assert.match(list.searchConsole.links.users, /^https:\/\/search\.google\.com\/search-console\/users\?resource_id=sc-domain%3Aglorytecks\.com$/);
});

test('Search Console report: real dimensions, Pacific-time periods ending on the latest data day, and comparisons', async () => {
  google.calls.length = 0;
  const r = await call(`${API}/search-console?range=7`);
  const rep = r.json.data.report;
  assert.equal(r.json.data.stale, false);
  assert.equal(rep.latestDataDate, '2026-10-22');
  assert.deepEqual(rep.current, { startDate: '2026-10-16', endDate: '2026-10-22' });
  assert.deepEqual(rep.previous, { startDate: '2026-10-09', endDate: '2026-10-15' });
  // FIXTURE: clicks = day of month, impressions = 20 × that.
  const clicksNow = 16 + 17 + 18 + 19 + 20 + 21 + 22;
  const clicksBefore = 9 + 10 + 11 + 12 + 13 + 14 + 15;
  assert.deepEqual(rep.totals.clicks, { current: clicksNow, previous: clicksBefore, delta: clicksNow - clicksBefore, pct: ((clicksNow - clicksBefore) / clicksBefore) * 100 });
  assert.equal(rep.totals.ctr.current, 0.05);
  assert.equal(rep.daily.length, 7);
  assert.equal(rep.topQueries[0].key, 'python course hyderabad');
  assert.deepEqual(rep.devices.map((d: any) => d.key), ['MOBILE', 'DESKTOP']);
  assert.deepEqual(rep.queryMovers.gains.map((m: any) => m.key), ['python course hyderabad']);
  assert.deepEqual(rep.queryMovers.drops.map((m: any) => m.key), ['data science course']);
  assert.ok(rep.reviewQueries.some((q: any) => q.key === 'data science course' && q.reason === 'clicks-dropped'));
  const queries = google.calls.filter((c) => c.url.endsWith('/searchAnalytics/query'));
  assert.ok(queries.every((c) => c.body.type === 'web' && c.body.rowLimit <= 500), 'only what the views need');
  assert.deepEqual([...new Set(queries.map((c) => c.body.dimensions.join(',')))].sort(), ['country', 'date', 'device', 'page', 'query']);
});

test('reports are cached: a second visit does not call Google; refresh=1 does', async () => {
  google.calls.length = 0;
  await call(`${API}/search-console?range=7`);
  assert.equal(google.calls.length, 0, 'served from the cache');
  await call(`${API}/search-console?range=7&refresh=1`);
  assert.ok(google.calls.length > 0, 'a refresh asks Google again');
});

test('GA4 report: totals for two periods, real dimensions, key events from the property, organic sessions apart from Search Console clicks', async () => {
  google.calls.length = 0;
  const r = await call(`${API}/ga4?range=28`);
  const rep = r.json.data.report;
  assert.equal(rep.timeZone, 'Asia/Kolkata');
  // 2026-10-25 15:30 in Kolkata: "28daysAgo..yesterday" is 27 Sep – 24 Oct there.
  assert.deepEqual(rep.dates, {
    current: { startDate: '2026-09-27', endDate: '2026-10-24' },
    previous: { startDate: '2026-08-30', endDate: '2026-09-26' },
  });
  assert.deepEqual(rep.totals.sessions, { current: 1800, previous: 1440, delta: 360, pct: 25 });
  assert.equal(rep.totals.engagementRate.current, 0.611);
  // Every day of the period, those GA4 left out (no activity) as zero.
  assert.equal(rep.daily.length, 28);
  assert.deepEqual([rep.daily[0].date, rep.daily.at(-1).date], ['2026-09-27', '2026-10-24']);
  assert.deepEqual(rep.daily.at(-1), { date: '2026-10-24', activeUsers: 1200, sessions: 1800, views: 5400 });
  assert.deepEqual(rep.daily[0], { date: '2026-09-27', activeUsers: 0, sessions: 0, views: 0 });
  assert.equal(rep.latestDataDate, '2026-10-24', 'the newest day GA4 returned, not the calendar');
  assert.deepEqual(rep.landingPages.map((p: any) => p.page), ['/', '/courses/python-programming']);
  assert.ok(rep.channels.some((c: any) => c.channel === 'Organic Search'));
  assert.equal(rep.googleOrganicSessions, 1800, 'google / organic, as Google defines it, not every search engine');
  assert.deepEqual(rep.quality, { thresholded: false, sampled: false, otherRow: false });
  assert.deepEqual(rep.keyEvents, {
    available: true,
    list: [{ eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT', count: { current: 42, previous: 33.6, delta: 42 - 33.6, pct: ((42 - 33.6) / 33.6) * 100 } }],
    countsError: null,
  }, 'only events the property marks as key events');

  // The five core reports go to Google as one batch; the key-event counts as one more report.
  const batches = google.calls.filter((c) => c.url.endsWith(':batchRunReports'));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].body.requests.length, 5);
  const askedRanges = batches[0].body.requests.map((q: any) => q.dateRanges.map((d: any) => `${d.startDate}..${d.endDate}`).join(' | '));
  assert.ok(askedRanges.includes('28daysAgo..yesterday | 56daysAgo..29daysAgo'), 'the previous period is the 28 days before, in the property time zone');
  const counts = google.calls.filter((c) => c.url.endsWith(':runReport'));
  assert.deepEqual(counts.map((c) => c.body.dimensionFilter.filter.inListFilter.values), [['generate_lead']]);
});

test('GA4 key events: when Google refuses the per-event counts, the rest of the report still shows and says why', async () => {
  google.refuseKeyEventCounts = true;
  const rep = (await call(`${API}/ga4?range=7&refresh=1`)).json.data;
  assert.equal(rep.error, null);
  assert.equal(rep.report.totals.keyEvents.current, 42, 'the total key events still come from the main report');
  assert.deepEqual(rep.report.keyEvents.list.map((k: any) => [k.eventName, k.count]), [['generate_lead', null]]);
  assert.equal(rep.report.keyEvents.countsError.kind, 'invalid-request');
  google.refuseKeyEventCounts = false;
});

test('GA4 key events: none marked yet is said plainly, with no invented events', async () => {
  google.keyEvents = [];
  const rep = (await call(`${API}/ga4?range=90&refresh=1`)).json.data.report;
  assert.deepEqual(rep.keyEvents, { available: true, list: [], countsError: null });
  assert.equal(google.calls.filter((c) => c.url.endsWith(':runReport') && c.body.dimensions?.[0]?.name === 'eventName' && c.body.dateRanges[0].startDate === '90daysAgo').length, 0, 'no count query for nothing');
  google.keyEvents = ['generate_lead'];
});

/* ── Quota, auth failure, empty data, outage ──────────────────────────────── */

test('quota: Google says wait an hour — the last good report is shown, marked stale, with the reason', async () => {
  google.mode = 'quota';
  const r = await call(`${API}/search-console?range=7&refresh=1`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.stale, true);
  assert.ok(r.json.data.report, 'the last good report');
  assert.equal(r.json.data.error.kind, 'quota');
  assert.equal(r.json.data.error.retryAfterSeconds, 3600);
  const list = (await call(`${API}/integrations`)).json.data;
  assert.equal(list.searchConsole.connection, 'error');
  assert.equal(list.searchConsole.status.lastFailure.kind, 'quota');
  assert.equal(Date.parse(list.searchConsole.status.cooldownUntil), Date.parse(list.searchConsole.status.lastFailureAt) + 3600_000, 'holds off as long as Google asked');

  // While holding off, even a refresh is answered from the last good copy without asking Google.
  google.mode = 'ok';
  google.calls.length = 0;
  const again = await call(`${API}/search-console?range=7&refresh=1`);
  assert.equal(google.calls.length, 0, 'Google was not asked');
  assert.equal(again.json.data.stale, true);
  assert.match(again.json.data.error.message, /requests are paused for about 60 more minutes/);
  // …and holding off is not a new failure, so it cannot extend itself.
  const after = (await call(`${API}/integrations`)).json.data.searchConsole.status;
  assert.equal(after.lastFailureAt, list.searchConsole.status.lastFailureAt);
  assert.equal(after.cooldownUntil, list.searchConsole.status.cooldownUntil);
  // A cheap request that succeeds (a connection test) does not end the pause either.
  const t = await call(`${API}/integrations/search-console/test`, { method: 'POST' });
  assert.equal(t.json.data.ok, true);
  const later = (await call(`${API}/integrations`)).json.data.searchConsole.status;
  assert.equal(later.cooldownUntil, list.searchConsole.status.cooldownUntil, 'the pause runs out on its own');
  google.calls.length = 0;
  await call(`${API}/search-console?range=28&refresh=1`);
  assert.equal(google.calls.length, 0, 'still paused');
});

test('quota on the key-event counts pauses GA4 too — the report is not cached as fresh', async () => {
  google.refuseKeyEventCounts = 'quota';
  const r = (await call(`${API}/ga4?range=28&refresh=1`)).json.data;
  assert.equal(r.stale, true, 'the last good report, marked stale');
  assert.equal(r.error.kind, 'quota');
  const status = (await call(`${API}/integrations`)).json.data.analytics.status;
  assert.ok(Date.parse(status.cooldownUntil) > NOW, 'the pause started');
  google.refuseKeyEventCounts = false;
});

test('failed auth: a rejected key is reported plainly; no key, token or assertion in the answer', async () => {
  NOW += 2 * 3600_000; // past the GA4 quota pause from the test before
  google.mode = 'bad-key';
  clearTokenCache();
  const t = await call(`${API}/integrations/search-console/test`, { method: 'POST' });
  assert.equal(t.json.data.ok, false);
  assert.match(t.json.data.checks.at(-1).message, /did not accept the service account key \(invalid_grant: Invalid JWT Signature\.\)/);
  const r = await call(`${API}/ga4?range=7&refresh=1`);
  assert.equal(r.json.data.error.kind, 'auth-failed');
  google.mode = 'ok';
  clearTokenCache();
});

test('no access: the service account is not a user of the property', async () => {
  google.mode = 'no-access';
  const t = await call(`${API}/integrations/search-console/test`, { method: 'POST' });
  assert.equal(t.json.data.ok, false);
  assert.match(t.json.data.checks.at(-1).message, /has no access: User does not have sufficient permission/);
  google.mode = 'ok';
});

test('empty data: no rows is a real zero with nothing to compare, not a failure', async () => {
  NOW += 2 * 3600_000; // past the quota hold-off
  google.mode = 'empty';
  const sc = (await call(`${API}/search-console?range=28&refresh=1`)).json.data;
  assert.equal(sc.error, null);
  assert.equal(sc.report.empty, true, 'Search Console has no data for the period');
  const ga = (await call(`${API}/ga4?range=7&refresh=1`)).json.data;
  assert.equal(ga.error, null);
  assert.deepEqual(ga.report.totals.sessions, { current: 0, previous: null, delta: null, pct: null });
  assert.deepEqual(ga.report.landingPages, []);
  google.mode = 'ok';
});

test('Google unavailable: reports say so, and the dashboard keeps working with the state in its status', async () => {
  google.mode = 'down';
  const r = await call(`${API}/search-console?range=90&refresh=1`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.error.kind, 'unavailable');
  for (const path of ['/api/v1/dashboard/status', '/api/v1/dashboard/stats', '/api/v1/dashboard/attention']) {
    assert.equal((await call(path)).status, 200, path);
  }
  const status = (await call('/api/v1/dashboard/status')).json.data;
  const sc = status.integrations.find((i: any) => i.id === 'search-console');
  assert.equal(sc.state, 'degraded');
  assert.match(sc.problem, /could not be reached/);
  assert.deepEqual(sc.envVars, ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GSC_SITE_URL']);
  google.mode = 'ok';
});

test('no secret leakage: no response and no log line carries the key, the access token or a signed assertion', () => {
  const everything = [...responses, ...captured].join('\n');
  assert.ok(responses.length > 20);
  for (const secret of [PEM_BODY, 'PRIVATE KEY', TOKEN, 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9']) {
    assert.equal(everything.includes(secret), false, `found ${secret.slice(0, 12)}…`);
  }
});
