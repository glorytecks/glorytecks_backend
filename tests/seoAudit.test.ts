import './setup';
import { DB, MISSING, REQUESTS, SUBJECT, resetDb } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { FetchFailure, type FetchOptions, type FetchResult, type Transport } from '../src/lib/safeHttp';
import { csvCell, setSiteAuditDepsForTests } from '../src/services/siteAudit.service';
import { BUDGET_SKIP, type AuditContext } from '../src/seo/audit/engine';
import { fingerprint } from '../src/seo/audit/analyze';
import { canonicalUrlFor, PRODUCTION_ORIGIN } from '../src/seo/site/canonical';

/**
 * The technical SEO audit end to end: the real routes, middleware and step
 * engine, over the in-memory PostgREST (dashboardTestEnv) and a FIXTURE site.
 *
 * Every page, sitemap and image below is made up; a fake transport answers
 * for them and records every request the audit makes. No test reaches the
 * network, and none of this says anything about the live site.
 *
 * The cases run in order and share one history: run 1 finds the FIXTURE
 * site's problems, run 2 sees some fixed, run 3 is cancelled, run 4 retries
 * a failed page, run 5 runs out of budget.
 */

const API = '/api/v1/seo-audit';
const ORIGIN = 'https://glorytecks.com';
const self = (p: string) => canonicalUrlFor(PRODUCTION_ORIGIN, p);

/* ── Server, roles, requests ──────────────────────────────────────────────── */

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => {
  setSiteAuditDepsForTests(null);
  server.close();
});

type Who = keyof typeof SUBJECT;
const token = (who: Who) => jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

async function call(path: string, opts: { method?: string; who?: Who | null } = {}) {
  const who = opts.who === undefined ? 'admin' : opts.who;
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: who ? { Authorization: `Bearer ${token(who)}` } : {},
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: res.status, raw, json, headers: res.headers };
}

/* ── The FIXTURE site ─────────────────────────────────────────────────────── */

interface PageSpec {
  title?: string;
  h1?: string | null;
  canonical?: string;
  robots?: string;
  links?: [string, string][];
  images?: string[];
  text?: string;
}

function page(path: string, spec: PageSpec = {}): string {
  return [
    '<!doctype html><html><head>',
    `<title>${spec.title ?? `Fixture page ${path} | GloryTecks`}</title>`,
    `<meta name="description" content="Fixture description for ${path}: a made-up page for the audit tests, long enough for the site rules.">`,
    `<link rel="canonical" href="${spec.canonical ?? self(path)}">`,
    `<meta name="robots" content="${spec.robots ?? 'index, follow'}">`,
    '</head><body>',
    '<header><nav><a href="/">Home</a><a href="/courses">Courses</a></nav></header><main>',
    spec.h1 === null ? '<h2>No main heading</h2>' : `<h1>${spec.h1 ?? `Fixture heading ${path}`}</h1>`,
    ...(spec.links ?? []).map(([to, text]) => `<p><a href="${to}">${text}</a></p>`),
    ...(spec.images ?? []).map((src) => `<img src="${src}" alt="Fixture image">`),
    spec.text ? `<p>${spec.text}</p>` : '',
    '</main><footer><p>Fixture footer</p></footer></body></html>',
  ].join('');
}

const urlset = (paths: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${self(p)}</loc><lastmod>2026-10-01</lastmod></url>`)
    .join('')}</urlset>`;

const IMG_OK = 'https://res.cloudinary.com/fixture/image/upload/ok.png';
const IMG_BROKEN = 'https://res.cloudinary.com/fixture/image/upload/broken.png';
const IMG_ELSEWHERE = 'https://cdn.other.example/fixture.png';

type Answer = { status: number; body?: string; location?: string; xRobotsTag?: string } | 'timeout';

/** FIXTURE site, version 1: twelve URLs with known problems. */
function fixtureSite(): Map<string, Answer> {
  const html = (path: string, spec?: PageSpec): Answer => ({ status: 200, body: page(path, spec) });
  return new Map<string, Answer>([
    [`${ORIGIN}/robots.txt`, { status: 200, body: `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /private\nSitemap: ${ORIGIN}/sitemap.xml\n` }],
    [
      `${ORIGIN}/sitemap.xml`,
      {
        status: 200,
        body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${ORIGIN}/sitemaps/pages.xml</loc></sitemap><sitemap><loc>${ORIGIN}/sitemaps/blog.xml</loc></sitemap></sitemapindex>`,
      },
    ],
    [`${ORIGIN}/sitemaps/pages.xml`, { status: 200, body: urlset(['/', '/courses', '/courses/python', '/about']) }],
    [`${ORIGIN}/sitemaps/blog.xml`, { status: 200, body: urlset(['/blog/fixture-post', '/blog/missing-post']) }],
    [
      `${ORIGIN}/`,
      html('/', {
        links: [
          ['/courses/python', 'Python course'],
          ['/about', 'About us'],
          ['/blog/fixture-post', 'Fixture post'],
          ['/old-page', 'Old page'],
          ['/missing', 'Missing page'],
          ['/away', 'Partner site'],
          ['/meta', 'Metadata'],
          ['/private/area', 'Private area'],
        ],
        images: [IMG_OK, IMG_BROKEN, IMG_ELSEWHERE],
      }),
    ],
    [`${ORIGIN}/courses`, html('/courses', { links: [['/courses/python', 'Python course details']] })],
    [`${ORIGIN}/courses/python`, html('/courses/python', { h1: null, links: [['/courses', 'All courses']] })],
    [`${ORIGIN}/about`, html('/about', { canonical: self('/courses'), links: [['/', 'Home page']] })],
    [`${ORIGIN}/blog/fixture-post`, html('/blog/fixture-post', { links: [['/courses/python', 'Python course']], text: 'Get a 100% placement guarantee.' })],
    [`${ORIGIN}/blog/missing-post`, { status: 404, body: '<title>Not found</title>' }],
    [`${ORIGIN}/old-page`, { status: 308, location: '/courses' }],
    [`${ORIGIN}/missing`, { status: 404, body: '<title>Not found</title>' }],
    [`${ORIGIN}/away`, { status: 302, location: 'https://evil.example/steal' }],
    [`${ORIGIN}/meta`, { status: 302, location: 'http://169.254.169.254/latest/meta-data/' }],
    ['https://res.cloudinary.com/robots.txt', { status: 404 }],
    [IMG_OK, { status: 200 }],
    [IMG_BROKEN, { status: 404 }],
  ]);
}

let site = fixtureSite();
const requested: { url: string; method: string }[] = [];
let gate: Promise<void> | null = null;
let arrived: (() => void) | null = null;

const transport: Transport = {
  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    requested.push({ url, method: opts.method ?? 'GET' });
    if (gate) {
      arrived?.();
      await gate;
    }
    const answer = site.get(url) ?? { status: 404, body: '<title>Not found</title>' };
    if (answer === 'timeout') throw new FetchFailure('no answer within 4 s', true);
    const readBody = opts.readBody && opts.method !== 'HEAD';
    return {
      status: answer.status,
      location: answer.location ?? null,
      contentType: url.endsWith('.xml') ? 'application/xml' : url.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8',
      xRobotsTag: answer.xRobotsTag ?? null,
      body: readBody ? (answer.body ?? '') : null,
      truncated: false,
      ms: 3,
    };
  },
};

/** What the CMS says, as FIXTURES: registry pages, a published course and a published post. */
const context = async (): Promise<AuditContext> => ({
  seeds: [
    { path: '/', source: 'registry', live: true, expectIndex: true, expectFollow: true, priority: 0 },
    { path: '/courses', source: 'registry', live: true, expectIndex: true, expectFollow: true, priority: 0 },
    { path: '/about', source: 'registry', live: true, expectIndex: true, expectFollow: true, priority: 0 },
    { path: '/courses/python', source: 'cms:course', live: true, expectIndex: true, expectFollow: true, priority: 1 },
    { path: '/blog/fixture-post', source: 'cms:blog', live: true, expectIndex: true, expectFollow: null, priority: 3 },
  ],
  textSources: new Map(),
  adminPathFor: (p: string) =>
    ({ '/': '/page-seo/edit?path=%2F', '/about': '/page-seo/edit?path=%2Fabout', '/courses/python': '/courses/c1#seo', '/blog/fixture-post': '/blogs/b1' })[
      p.split('?')[0]
    ] ?? null,
});

let NOW = Date.parse('2026-10-25T09:00:00.000Z');
const later = (minutes: number) => {
  NOW += minutes * 60_000;
};

setSiteAuditDepsForTests({ transport, context, now: () => NOW });

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function startRun() {
  const res = await call(`${API}/runs`, { method: 'POST' });
  assert.equal(res.status, 201, res.raw);
  return res.json.data.id as string;
}

/** Step until the run stops; the admin screen does the same. */
async function finish(runId: string, max = 60) {
  for (let i = 0; i < max; i++) {
    const res = await call(`${API}/runs/${runId}/step`, { method: 'POST' });
    assert.equal(res.status, 200, res.raw);
    if (res.json.data.outcome !== 'advanced') return res.json.data.run;
  }
  assert.fail(`run ${runId} did not finish in ${max} steps`);
}

const issues = () => (DB.site_audit_issues ?? []) as Record<string, any>[];
const openIssues = () => issues().filter((i) => i.status === 'open');
const keyOf = (i: Record<string, any>) => `${i.rule} ${i.path}`;
const issue = (rule: string, path: string) => issues().find((i) => i.rule === rule && i.path === path);

/* ── Access ───────────────────────────────────────────────────────────────── */

const ROUTES: [string, string][] = [
  ['GET', `${API}/overview`],
  ['GET', `${API}/runs`],
  ['POST', `${API}/runs`],
  ['GET', `${API}/runs/00000000-0000-4000-8000-00000000abcd`],
  ['POST', `${API}/runs/00000000-0000-4000-8000-00000000abcd/step`],
  ['POST', `${API}/runs/00000000-0000-4000-8000-00000000abcd/cancel`],
  ['POST', `${API}/runs/00000000-0000-4000-8000-00000000abcd/retry`],
  ['GET', `${API}/issues`],
  ['GET', `${API}/issues/export?format=csv`],
  ['GET', `${API}/issues/00000000-0000-4000-8000-00000000abcd`],
];

test('only administrators reach the audit: 401 without a session, 403 for every other role', async () => {
  resetDb();
  process.env.SEO_AUDIT_ORIGIN = ORIGIN;
  for (const [method, path] of ROUTES) {
    assert.equal((await call(path, { method, who: null })).status, 401, `${method} ${path}`);
    for (const who of ['receptionist', 'content_writer', 'editor', 'viewer'] as Who[]) {
      assert.equal((await call(path, { method, who })).status, 403, `${who} ${method} ${path}`);
    }
  }
  assert.equal(requested.length, 0, 'no refused request crawled anything');
  assert.equal((DB.site_audit_runs ?? []).length, 0);
});

test('not configured: the overview says why and how to enable it; nothing can start', async () => {
  resetDb();
  process.env.SEO_AUDIT_ORIGIN = '';
  const overview = await call(`${API}/overview`);
  assert.equal(overview.status, 200);
  assert.equal(overview.json.data.configured, false);
  assert.match(overview.json.data.reason, /SEO_AUDIT_ORIGIN is not set/);
  assert.match(overview.json.data.setup, /SEO_AUDIT_ORIGIN/);
  assert.ok(overview.json.data.rules.length > 20, 'the rule catalogue is still there to read');
  const start = await call(`${API}/runs`, { method: 'POST' });
  assert.equal(start.status, 503);
  assert.match(start.json.message, /not configured/);

  process.env.SEO_AUDIT_ORIGIN = 'https://evil.example';
  const foreign = await call(`${API}/overview`);
  assert.equal(foreign.json.data.configured, false);
  assert.match(foreign.json.data.reason, /must be https:\/\/glorytecks\.com/);
  assert.equal(requested.length, 0);
});

test('not set up: before the migration the overview names it and runs are refused', async () => {
  resetDb();
  process.env.SEO_AUDIT_ORIGIN = ORIGIN;
  MISSING.add('site_audit_runs');
  MISSING.add('site_audit_issues');
  const overview = await call(`${API}/overview`);
  assert.equal(overview.status, 200);
  assert.equal(overview.json.data.setUp, false);
  assert.match(overview.json.data.migration, /20261025000000_site_audit\.sql/);
  const start = await call(`${API}/runs`, { method: 'POST' });
  assert.equal(start.status, 503);
  assert.match(start.json.message, /not set up: apply .*20261025000000_site_audit\.sql/);
  assert.equal((await call(`${API}/issues`)).status, 503);
});

/* ── Run 1 ────────────────────────────────────────────────────────────────── */

let run1 = '';
let writesBefore = 0;

test('run 1: the FIXTURE site is crawled step by step and its problems become issues', async () => {
  resetDb();
  process.env.SEO_AUDIT_ORIGIN = ORIGIN;
  process.env.SEO_AUDIT_MAX_PAGES = '';
  requested.length = 0;
  writesBefore = REQUESTS.length;

  run1 = await startRun();
  const run = await finish(run1);
  assert.equal(run.status, 'completed');
  assert.equal(run.phase, 'done');
  assert.ok(run.steps >= 4, 'discover, crawl, links, images and analyze each took a step');

  assert.deepEqual(openIssues().map(keyOf).sort(), [
    `broken-image ${IMG_BROKEN}`,
    'broken-internal-link /missing',
    'canonical-mismatch /about',
    'claim-wording /blog/fixture-post',
    'h1 /courses/python',
    'http-status /blog/missing-post',
    'non-canonical-link /about',
    'redirected-internal-link /away',
    'redirected-internal-link /meta',
    'redirected-internal-link /old-page',
    'sitemap-url-invalid /about',
    'sitemap-url-invalid /blog/missing-post',
  ]);
  for (const i of issues()) {
    assert.equal(i.times_seen, 1);
    assert.equal(i.first_run_id, run1);
    assert.equal(i.last_run_id, run1);
    assert.equal(i.first_seen_at, new Date(NOW).toISOString());
  }
  assert.deepEqual(issue('broken-internal-link', '/missing')!.affected, ['/']);
  assert.equal(issue('broken-image', IMG_BROKEN)!.admin_path, '/page-seo/edit?path=%2F', 'an image is fixed on the page that shows it');
  assert.equal(issue('h1', '/courses/python')!.admin_path, '/courses/c1#seo');

  assert.equal(run.summary.found.total, 12);
  assert.equal(run.summary.new, 12);
  assert.equal(run.coverage.robotsSkipped, 1, '/private/area is disallowed for the crawler');
  assert.equal(run.coverage.complete, false);
  assert.deepEqual(run.coverage.externalImageHosts, ['cdn.other.example']);
});

test('run 1 asked robots.txt first, stayed on approved hosts and never followed a redirect off them', () => {
  assert.equal(requested[0].url, `${ORIGIN}/robots.txt`);
  const urls = requested.map((r) => r.url);
  for (const banned of ['evil.example', '169.254.169.254', '/private/area', 'cdn.other.example']) {
    assert.ok(!urls.some((u) => u.includes(banned)), `requested ${banned}`);
  }
  for (const url of urls) {
    assert.match(url, /^https:\/\/(glorytecks\.com|res\.cloudinary\.com)\//, url);
  }
  // A URL is requested once, except where a redirect leads to it again.
  const twice = urls.filter((u, i) => urls.indexOf(u) !== i);
  assert.deepEqual(twice, [`${ORIGIN}/courses`], 'only /courses, as the target of /old-page');
  assert.ok(requested.filter((r) => r.url.startsWith('https://res.cloudinary.com/fixture')).every((r) => r.method === 'HEAD'), 'images: HEAD only');

  const away = (DB.site_audit_pages as Record<string, any>[]).find((r) => r.run_id === run1 && r.path === '/away')!;
  assert.match(away.offsite, /evil\.example .*not an approved host/);
  const meta = (DB.site_audit_pages as Record<string, any>[]).find((r) => r.run_id === run1 && r.path === '/meta')!;
  assert.match(meta.offsite, /http is not allowed|IP address/);
});

test('run 1 wrote nothing outside the audit’s own tables: content, SEO settings and the public site are untouched', () => {
  const writes = REQUESTS.slice(writesBefore).filter((r) => !r.startsWith('GET ') && !r.startsWith('HEAD '));
  assert.ok(writes.length > 0);
  for (const w of writes) assert.match(w, /^(POST|PATCH) site_audit_(runs|pages|issues)$/, w);
});

test('the overview reports the run, its time and the open issues by severity; a new run waits for the cooldown', async () => {
  const res = await call(`${API}/overview`);
  const data = res.json.data;
  assert.equal(data.configured, true);
  assert.equal(data.setUp, true);
  assert.equal(data.latestCompleted.id, run1);
  assert.equal(data.latestCompleted.finishedAt, new Date(NOW).toISOString());
  assert.equal(data.previousCompleted, null, 'no history yet to compare with');
  assert.equal(data.active, null);
  assert.deepEqual(data.openIssues, {
    total: 12,
    fix: openIssues().filter((i) => i.severity === 'fix').length,
    review: openIssues().filter((i) => i.severity === 'review').length,
    info: openIssues().filter((i) => i.severity === 'info').length,
  });
  assert.equal(data.nextRunAllowedAt, new Date(NOW + 10 * 60_000).toISOString());
  assert.equal(data.settings.origin, ORIGIN);

  const again = await call(`${API}/runs`, { method: 'POST' });
  assert.equal(again.status, 409);
  assert.match(again.json.message, /results are current/);
  assert.equal(again.json.errors[0].message, data.nextRunAllowedAt);
});

/* ── Issues: list, filters, detail, export ────────────────────────────────── */

test('issues: filtered, sorted and paginated on the server', async () => {
  const all = await call(`${API}/issues?limit=100`);
  assert.equal(all.status, 200);
  assert.equal(all.json.meta.total, 12);
  const ranks = all.json.data.map((i: any) => ({ fix: 0, review: 1, info: 2 })[i.severity as 'fix']);
  assert.deepEqual(ranks, [...ranks].sort(), 'fix first by default');

  const fix = await call(`${API}/issues?severity=fix&limit=100`);
  assert.ok(fix.json.data.length > 0 && fix.json.data.every((i: any) => i.severity === 'fix'));
  const links = await call(`${API}/issues?category=links&limit=100`);
  assert.deepEqual(links.json.data.map((i: any) => i.rule).sort(), ['broken-image', 'broken-internal-link', 'non-canonical-link', 'redirected-internal-link', 'redirected-internal-link', 'redirected-internal-link']);
  const articles = await call(`${API}/issues?pageType=article&limit=100`);
  assert.deepEqual(articles.json.data.map((i: any) => `${i.rule} ${i.path}`).sort(), [
    'claim-wording /blog/fixture-post',
    'http-status /blog/missing-post',
    'sitemap-url-invalid /blog/missing-post',
  ]);
  const search = await call(`${API}/issues?q=MISSING&limit=100`);
  assert.ok(search.json.data.length >= 3 && search.json.data.every((i: any) => i.path.includes('missing')), 'URL search ignores case');
  const percent = await call(`${API}/issues?q=${encodeURIComponent('%')}`);
  assert.equal(percent.json.meta.total, 0, 'a % is matched literally, not as a wildcard');
  const byRule = await call(`${API}/issues?rule=h1`);
  assert.deepEqual(byRule.json.data.map((i: any) => i.path), ['/courses/python']);

  const page1 = await call(`${API}/issues?sort=path&limit=5&page=1`);
  const page2 = await call(`${API}/issues?sort=path&limit=5&page=2`);
  assert.equal(page1.json.meta.hasNextPage, true);
  const paths = [...page1.json.data, ...page2.json.data].map((i: any) => i.path);
  assert.equal(new Set(page1.json.data.map((i: any) => i.id).concat(page2.json.data.map((i: any) => i.id))).size, 10, 'no row on two pages');
  assert.deepEqual(paths, [...paths].sort());
  const desc = await call(`${API}/issues?sort=path&order=desc&limit=100`);
  assert.deepEqual(desc.json.data.map((i: any) => i.path), [...desc.json.data.map((i: any) => i.path)].sort().reverse());
});

test('issues: parameters outside their closed sets are refused, never passed on', async () => {
  for (const query of [
    'severity=critical',
    'category=everything',
    'pageType=admin',
    'rule=drop-table',
    'status=deleted',
    'seen=sometimes',
    'sort=constructor',
    'order=sideways',
    'limit=1000',
    'page=0',
    `q=${'x'.repeat(201)}`,
    'severity=fix&severity=info',
  ]) {
    const res = await call(`${API}/issues?${query}`);
    assert.equal(res.status, 422, query);
  }
  assert.equal((await call(`${API}/issues/export?format=xlsx`)).status, 422);
  assert.equal((await call(`${API}/runs/not-a-uuid/step`, { method: 'POST' })).status, 422);
  assert.equal((await call(`${API}/issues/not-a-uuid`)).status, 422);
});

test('issue detail: why it matters, the fix, the rule’s source, the evidence and the affected pages with their editors', async () => {
  const target = issue('broken-internal-link', '/missing')!;
  const res = await call(`${API}/issues/${target.id}`);
  assert.equal(res.status, 200);
  const d = res.json.data;
  assert.equal(d.rule.id, 'broken-internal-link');
  assert.match(d.rule.why, /answers with an error/);
  assert.ok(d.rule.fix.length > 10);
  assert.match(d.rule.source, /sitecrawl\.live\.test\.ts/);
  assert.equal(d.evidence.status, 404);
  assert.equal(d.liveUrl, `${ORIGIN}/missing`);
  assert.deepEqual(d.affected, [{ path: '/', liveUrl: ORIGIN, adminPath: '/page-seo/edit?path=%2F' }]);
  assert.equal((await call(`${API}/issues/00000000-0000-4000-8000-00000000abcd`)).status, 404);
});

test('export: CSV (spreadsheet-safe) and JSON, with the current filters', async () => {
  const csv = await call(`${API}/issues/export?format=csv&category=links`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename="seo-audit-issues-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  // fetch().text() drops a byte-order mark, so look at the bytes.
  const bytes = new Uint8Array(await (await fetch(`${base}${API}/issues/export?format=csv`, { headers: { Authorization: `Bearer ${token('admin')}` } })).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM, for Excel');
  assert.ok(csv.raw.startsWith('"Severity","Category","Issue"'));
  const lines = csv.raw.split('\r\n');
  assert.equal(lines.length, 1 + 6, 'header and the six link issues');
  assert.ok(lines.some((l) => l.includes(`"${ORIGIN}/missing"`)));

  assert.equal(csvCell('=HYPERLINK("https://evil.example")'), '"\'=HYPERLINK(""https://evil.example"")"');
  for (const lead of ['+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${lead}1`).startsWith(`"'${lead}`));
  assert.equal(csvCell('/courses'), '"/courses"');

  const json = await call(`${API}/issues/export?format=json&severity=fix`);
  assert.equal(json.status, 200);
  const body = JSON.parse(json.raw);
  assert.equal(body.origin, ORIGIN);
  assert.equal(body.total, body.issues.length);
  assert.equal(body.truncated, false);
  assert.ok(body.issues.every((i: any) => i.severity === 'fix' && i.why && i.fix && i.url.startsWith('https://')));
});

/* ── Run 2: some problems fixed, one new ──────────────────────────────────── */

let run2 = '';

test('run 2: one step at a time — a second step while one is running is told the run is busy', async () => {
  later(11);
  // Fixed since run 1: the course page has its h1, and /missing exists now.
  site.set(`${ORIGIN}/courses/python`, { status: 200, body: page('/courses/python', { links: [['/courses', 'All courses']] }) });
  site.set(`${ORIGIN}/missing`, { status: 200, body: page('/missing', { links: [['/', 'Home page']] }) });
  run2 = await startRun();

  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const first = call(`${API}/runs/${run2}/step`, { method: 'POST' });
  await reached; // the first step is now waiting on the FIXTURE site
  const second = await call(`${API}/runs/${run2}/step`, { method: 'POST' });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.outcome, 'busy');
  gate = null;
  arrived = null;
  release();
  assert.equal((await first).json.data.outcome, 'advanced');

  const run = await finish(run2);
  assert.equal(run.status, 'completed');
});

test('run 2: fixed issues are resolved, recurring ones keep their first sighting, a new one starts its own history', async () => {
  const h1 = issue('h1', '/courses/python')!;
  assert.equal(h1.status, 'resolved');
  assert.equal(h1.resolved_run_id, run2);
  assert.equal(issue('broken-internal-link', '/missing')!.status, 'resolved');

  const canonical = issue('canonical-mismatch', '/about')!;
  assert.equal(canonical.status, 'open');
  assert.equal(canonical.times_seen, 2);
  assert.equal(canonical.first_run_id, run1);
  assert.equal(canonical.last_run_id, run2);
  assert.ok(canonical.first_seen_at < canonical.last_seen_at);

  const fresh = issue('not-in-sitemap', '/missing')!;
  assert.equal(fresh.status, 'open', '/missing is a real page now, but no sitemap lists it');
  assert.equal(fresh.first_run_id, run2);
  assert.equal(fresh.times_seen, 1);

  const recurring = await call(`${API}/issues?seen=recurring&limit=100`);
  assert.ok(recurring.json.data.length > 0 && recurring.json.data.every((i: any) => i.timesSeen > 1));
  const first = await call(`${API}/issues?seen=first&limit=100`);
  assert.deepEqual(first.json.data.map((i: any) => `${i.rule} ${i.path}`), ['not-in-sitemap /missing']);
  const resolved = await call(`${API}/issues?status=resolved&limit=100`);
  assert.deepEqual(resolved.json.data.map((i: any) => `${i.rule} ${i.path}`).sort(), ['broken-internal-link /missing', 'h1 /courses/python']);

  const overview = (await call(`${API}/overview`)).json.data;
  assert.equal(overview.latestCompleted.id, run2);
  assert.equal(overview.previousCompleted.id, run1);
  assert.equal(overview.latestCompleted.summary.resolved, 2);
  assert.equal(overview.latestCompleted.summary.new, 1);

  const runs = await call(`${API}/runs`);
  assert.deepEqual(runs.json.data.map((r: any) => r.id), [run2, run1]);
});

test('older runs keep their URLs but drop the bulky page readings once a newer run is analysed', () => {
  const rows = (DB.site_audit_pages as Record<string, any>[]).filter((r) => r.run_id === run1);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.record === null && r.links === null && r.images === null));
  assert.equal((DB.site_audit_runs as Record<string, any>[]).find((r) => r.id === run1)!.scratch_cleared, true);
  assert.ok((DB.site_audit_pages as Record<string, any>[]).some((r) => r.run_id === run2 && r.record !== null), 'the latest run keeps them, for a retry');
});

/* ── Run 3: cancelled ─────────────────────────────────────────────────────── */

test('run 3: cancel stops the run, nothing is analysed and no issue changes', async () => {
  later(11);
  const run3 = await startRun();
  const issuesBefore = JSON.stringify(issues());
  assert.equal((await call(`${API}/runs/${run3}/step`, { method: 'POST' })).json.data.outcome, 'advanced');

  const cancel = await call(`${API}/runs/${run3}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.data.status, 'cancelled');
  assert.equal((await call(`${API}/runs/${run3}/step`, { method: 'POST' })).json.data.outcome, 'inactive');
  assert.equal((await call(`${API}/runs/${run3}/cancel`, { method: 'POST' })).status, 409);
  assert.equal((await call(`${API}/runs/00000000-0000-4000-8000-00000000abcd/cancel`, { method: 'POST' })).status, 404);
  assert.equal((await call(`${API}/runs/00000000-0000-4000-8000-00000000abcd/step`, { method: 'POST' })).status, 404);
  assert.equal(JSON.stringify(issues()), issuesBefore);
});

/* ── Run 4: a page that times out, then a retry ───────────────────────────── */

let run4 = '';

test('run 4: a page that never answers is tried three times, then recorded as failed — with its issues left as they were', async () => {
  site.set(`${ORIGIN}/about`, 'timeout');
  run4 = await startRun(); // no cooldown: run 3 was cancelled, run 2 finished 11+ minutes ago
  requested.length = 0;
  const run = await finish(run4);
  assert.equal(run.status, 'completed');
  assert.equal(run.coverage.failed, 1);
  assert.equal(requested.filter((r) => r.url === `${ORIGIN}/about`).length, 3, 'three attempts, no more');
  const about = issue('canonical-mismatch', '/about')!;
  assert.equal(about.status, 'open', 'not looked at, so not resolved');
  assert.equal(about.times_seen, 2, 'not seen either');
  const row = (DB.site_audit_pages as Record<string, any>[]).find((r) => r.run_id === run4 && r.path === '/about')!;
  assert.equal(row.state, 'failed');
  assert.match(row.error, /no answer within/);
});

test('retry: only the latest run, only what failed; a second analysis of the same run does not count it twice', async () => {
  assert.equal((await call(`${API}/runs/${run2}/retry`, { method: 'POST' })).status, 409, 'not the latest run');

  site.set(`${ORIGIN}/about`, { status: 200, body: page('/about', { canonical: self('/courses'), links: [['/', 'Home page']] }) });
  const retry = await call(`${API}/runs/${run4}/retry`, { method: 'POST' });
  assert.equal(retry.status, 200, retry.raw);
  assert.equal(retry.json.data.requeued, 1);
  assert.equal(retry.json.data.run.status, 'running');

  const timesBefore = Object.fromEntries(issues().filter((i) => i.last_run_id === run4).map((i) => [i.id, i.times_seen]));
  const run = await finish(run4);
  assert.equal(run.status, 'completed');
  assert.equal(run.coverage.failed, 0);
  const about = issue('canonical-mismatch', '/about')!;
  assert.equal(about.times_seen, 3, 'seen in run 4 after the retry: counted once');
  assert.equal(about.last_run_id, run4);
  for (const [id, times] of Object.entries(timesBefore)) {
    assert.equal(issues().find((i) => i.id === id)!.times_seen, times, `re-analysis counted ${id} twice`);
  }
  const nothing = await call(`${API}/runs/${run4}/retry`, { method: 'POST' });
  assert.equal(nothing.status, 409);
  assert.match(nothing.json.message, /nothing to retry/);
});

/* ── Run 5: the page budget ───────────────────────────────────────────────── */

test('run 5: the page budget caps what is fetched; what it left out keeps its issues open', async () => {
  later(11);
  process.env.SEO_AUDIT_MAX_PAGES = '10';
  const extra = Array.from({ length: 15 }, (_, i) => `/p${i + 1}`);
  site.set(`${ORIGIN}/sitemaps/pages.xml`, { status: 200, body: urlset(['/', '/courses', '/courses/python', '/about', ...extra]) });
  for (const p of extra) site.set(`${ORIGIN}${p}`, { status: 200, body: page(p, { links: [['/', 'Home page']] }) });
  // Open issues about pages this run cannot reach: they must stay open.
  const stale = [
    { rule: 'h1', path: '/p9' },
    { rule: 'orphan-page', path: '/lonely' },
  ].map((s, i) => ({
    id: `00000000-0000-4000-a000-00000000000${i}`,
    fingerprint: fingerprint(ORIGIN, s.rule, s.path, null),
    origin: ORIGIN,
    ...s,
    category: 'on-page',
    severity: 'fix',
    severity_rank: 0,
    page_type: 'static',
    detail: 'FIXTURE',
    evidence: {},
    affected: [],
    affected_count: 0,
    admin_path: null,
    status: 'open',
    first_seen_at: new Date(NOW).toISOString(),
    last_seen_at: new Date(NOW).toISOString(),
    first_run_id: run1,
    last_run_id: run1,
    times_seen: 1,
    reopened_count: 0,
  }));
  DB.site_audit_issues.push(...stale);

  requested.length = 0;
  const run5 = await startRun();
  // Step until the run is analysing: from then on it cannot be cancelled.
  let phase = '';
  for (let i = 0; i < 60 && phase !== 'analyze'; i++) {
    phase = (await call(`${API}/runs/${run5}/step`, { method: 'POST' })).json.data.run.phase;
  }
  assert.equal(phase, 'analyze');
  const refused = await call(`${API}/runs/${run5}/cancel`, { method: 'POST' });
  assert.equal(refused.status, 409, 'analysis writes the issue history; it is not stopped half-way');
  assert.match(refused.json.message, /analysing what it found/);
  const run = await finish(run5);
  assert.equal(run.status, 'completed');
  const rows = (DB.site_audit_pages as Record<string, any>[]).filter((r) => r.run_id === run5 && r.kind === 'page');
  assert.equal(rows.filter((r) => r.skip_reason !== BUDGET_SKIP).length, 10, 'ten pages, the budget');
  // 21 listed pages (4 + 15 in pages.xml, 2 in blog.xml), best first: the last 11 wait for a bigger budget.
  assert.equal(run.coverage.budgetSkipped, 11);
  const kept = rows.filter((r) => r.skip_reason !== BUDGET_SKIP).map((r) => r.path);
  for (const p of ['/', '/courses', '/about', '/courses/python']) assert.ok(kept.includes(p), `${p}: registry and CMS pages come first`);
  assert.equal(run.coverage.complete, false);
  const pageFetches = requested.filter((r) => /^https:\/\/glorytecks\.com\/(?!robots\.txt|sitemap)/.test(r.url));
  assert.ok(pageFetches.length <= 10 + 10, 'pages plus status checks, each within its budget');
  assert.equal(issue('h1', '/p9')!.status, 'open');
  assert.equal(issue('orphan-page', '/lonely')!.status, 'open', 'graph issues need the whole site');
});

/* ── robots.txt that cannot be read ───────────────────────────────────────── */

test('a robots.txt answering 429 (slow down) is treated as unreadable, not as permission', async () => {
  later(11);
  site.set(`${ORIGIN}/robots.txt`, { status: 429 });
  requested.length = 0;
  const run = await finish(await startRun());
  assert.equal(run.status, 'failed');
  assert.match(run.error, /robots\.txt could not be read \(HTTP 429\)/);
  assert.deepEqual(requested.map((r) => r.url), [`${ORIGIN}/robots.txt`]);
});

test('a robots.txt answering 503 stops the run before any page is fetched (RFC 9309)', async () => {
  later(11);
  site.set(`${ORIGIN}/robots.txt`, { status: 503 });
  requested.length = 0;
  const id = await startRun();
  const run = await finish(id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /robots\.txt could not be read \(HTTP 503\).*RFC 9309/);
  assert.deepEqual(requested.map((r) => r.url), [`${ORIGIN}/robots.txt`]);
  // The overview shows it; the failed run can be retried once robots.txt is back.
  assert.equal((await call(`${API}/overview`)).json.data.latest.status, 'failed');
  site.set(`${ORIGIN}/robots.txt`, { status: 200, body: 'User-agent: *\nAllow: /\n' });
  // A sitemap URL whose path fits the column but whose full <loc> does not: it must not jam the run.
  const longPath = `/${'a'.repeat(2030)}`;
  site.set(`${ORIGIN}/sitemaps/pages.xml`, { status: 200, body: urlset(['/', '/courses', '/courses/python', '/about', longPath]) });
  const retry = await call(`${API}/runs/${id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 200, retry.raw);
  assert.equal(retry.json.data.run.phase, 'discover');
  assert.equal((await finish(id)).status, 'completed');
  const long = (DB.site_audit_pages as Record<string, any>[]).find((r) => r.run_id === id && r.path === longPath)!;
  assert.ok(long, 'the long URL was queued');
  assert.equal(long.loc, null, 'a <loc> longer than the column is not stored');
  assert.ok(self(longPath).length > 2048);
});
