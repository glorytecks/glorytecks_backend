import './setup';
import { DB, SUBJECT, WRITES, resetDb } from './pageSeoTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { CHECKS, SITE_COPY_RULES, checkPages, summarize, type CheckId, type CheckPage } from '../src/seo/pageChecks';
import { SEO_GUIDANCE } from '../src/seo/pageSeoRegistry';

/**
 * SEO checks (GET /page-seo/checks): the rules, and the endpoint that runs them
 * over every page Page SEO manages. That the rules match the site's own is
 * main-website's lib/seo/pageChecksParity.test.ts; this file pins behaviour.
 */

/* ── Rules ────────────────────────────────────────────────────────────────── */

const page = (over: Partial<CheckPage> = {}): CheckPage => ({
  path: '/p',
  live: true,
  saved: false,
  title: 'A Thirty-Plus Character Page Title Here',
  titleSource: 'default',
  description: 'A description that is comfortably longer than seventy characters and so passes.',
  descriptionSource: 'default',
  noindex: false,
  nofollow: false,
  ...over,
});

const ids = (pages: CheckPage[]) => checkPages(pages).map((f) => f.check);
const text = (n: number) => 'x'.repeat(n);

test('the defaults used by these tests raise nothing', () => {
  assert.deepEqual(checkPages([page()]), []);
});

test('the catalogue: one entry per id, every one explained, none about rankings', () => {
  const seen = new Set<string>();
  for (const c of CHECKS) {
    assert.ok(!seen.has(c.id), `duplicate check id ${c.id}`);
    seen.add(c.id);
    assert.ok(c.label.trim() && c.why.trim(), c.id);
    assert.doesNotMatch(`${c.label} ${c.why}`, /\brank/i, `${c.id} must not talk about rankings`);
  }
});

test('the copied rules are stateless: no global or sticky regex flags', () => {
  for (const re of [SITE_COPY_RULES.superlatives, SITE_COPY_RULES.guarantees]) {
    assert.doesNotMatch(re.flags, /[gy]/, re.source);
  }
  // Same verdict on a second call — a /g regex would flip it.
  const p = page({ title: 'The Best Course for Data Science Learners' });
  assert.deepEqual(ids([p]), ids([p]));
});

test('title length: guidance, then the site limit, never both', () => {
  const { min, max } = SEO_GUIDANCE.title;
  const saved = (title: string) => page({ title, titleSource: 'custom' });
  assert.deepEqual(ids([saved(text(min - 1))]), ['title-short']);
  assert.deepEqual(ids([saved(text(min))]), []);
  assert.deepEqual(ids([saved(text(max))]), []);
  assert.deepEqual(ids([saved(text(max + 1))]), ['title-long']);
  assert.deepEqual(ids([saved(text(SITE_COPY_RULES.titleMax))]), ['title-long']);
  assert.deepEqual(ids([saved(text(SITE_COPY_RULES.titleMax + 1))]), ['title-over-limit']);
  // Counted after collapsing whitespace, as the editor counts.
  assert.deepEqual(ids([saved(`  ${text(20)}      ${text(20)}  `)]), []);
});

test('description length: the site requires more than 70 and at most 260', () => {
  const saved = (description: string) => page({ description, descriptionSource: 'custom' });
  assert.deepEqual(ids([saved(text(70))]), ['description-too-short']);
  assert.deepEqual(ids([saved(text(71))]), []);
  assert.deepEqual(ids([saved(text(SEO_GUIDANCE.description.max))]), []);
  assert.deepEqual(ids([saved(text(SEO_GUIDANCE.description.max + 1))]), ['description-long']);
  assert.deepEqual(ids([saved(text(260))]), ['description-long']);
  assert.deepEqual(ids([saved(text(261))]), ['description-over-limit']);
});

test('default text is held to the site rules, not to the editor guidance', () => {
  // The guidance is a typing aid for saved text; the site's own pages are
  // allowed up to 65 / 260 characters, and their defaults are judged by that.
  assert.deepEqual(ids([page({ title: text(64) })]), []);
  assert.deepEqual(ids([page({ title: text(12) })]), []);
  assert.deepEqual(ids([page({ description: text(230) })]), []);
  assert.deepEqual(ids([page({ title: text(66) })]), ['title-over-limit']);
  assert.deepEqual(ids([page({ description: text(70) })]), ['description-too-short']);
  assert.deepEqual(ids([page({ description: text(261) })]), ['description-over-limit']);
});

test('a missing title or description is reported once, without length findings', () => {
  assert.deepEqual(ids([page({ title: null })]), ['title-missing']);
  assert.deepEqual(ids([page({ title: '   ' })]), ['title-missing']);
  assert.deepEqual(ids([page({ description: null })]), ['description-missing']);
});

test('copy rules: superlatives, outcome promises, place names and repeated segments', () => {
  const cases: [Partial<CheckPage>, CheckId[], RegExp?][] = [
    [{ title: 'Best Data Science Course for Working People' }, ['title-superlative'], /uses “Best”/],
    [{ title: 'Topology and Graph Theory Notes for Learners' }, []],
    [{ title: 'The No. 1 Python Course for Beginners Online' }, ['title-superlative']],
    [{ title: 'Data Science Hyderabad | Python Hyderabad Now' }, ['title-place-repeated'], /“hyderabad” 2 times/],
    [{ title: 'Classes in Ameerpet, Kukatpally and Madhapur' }, ['title-too-many-places'], /ameerpet, kukatpally and madhapur/],
    [{ title: 'Classes in Ameerpet, Hyderabad for Data Science' }, []],
    [{ title: 'Data Science Course | Data Science Course' }, ['title-repeated-segment'], /“data science course”/],
    [{ description: `100% placement guaranteed for every learner who joins. ${text(30)}` }, ['description-guarantee'], /“100% placement”/],
    [{ description: `Placement support and interview practice, plus a free demo. ${text(20)}` }, []],
    [{ description: `The leading institute for analytics courses in the city. ${text(20)}` }, ['description-superlative']],
  ];
  for (const [over, expected, detail] of cases) {
    const findings = checkPages([page(over)]);
    assert.deepEqual(findings.map((f) => f.check), expected, JSON.stringify(over));
    if (detail) assert.match(findings[0].detail, detail, JSON.stringify(over));
  }
});

test('duplicates: live, indexable pages only, each told about the others', () => {
  const same = 'Data Science Course in Hyderabad | GloryTecks';
  const findings = checkPages([
    page({ path: '/a', title: same }),
    page({ path: '/b', title: `  ${same.toUpperCase()} ` }),
    page({ path: '/c', title: same, titleSource: 'custom' }),
    page({ path: '/hidden', title: same, noindex: true }),
    page({ path: '/gone', title: same, live: false }),
  ]).filter((f) => f.check === 'title-duplicate');

  assert.deepEqual(findings.map((f) => f.path), ['/a', '/b', '/c']);
  assert.deepEqual(findings[0].related, ['/b', '/c']);
  assert.equal(findings[0].detail, 'also used on 2 other pages');
  assert.equal(findings[2].source, 'custom');

  const descriptions = checkPages([page({ path: '/a' }), page({ path: '/b' })]).filter((f) => f.check === 'description-duplicate');
  assert.deepEqual(descriptions.map((f) => [f.path, f.related, f.severity]), [
    ['/a', ['/b'], 'review'],
    ['/b', ['/a'], 'review'],
  ]);
});

test('hidden and missing pages: one note, and their text is not checked', () => {
  assert.deepEqual(
    checkPages([page({ noindex: true, nofollow: true, title: text(200), description: null })]).map((f) => [f.check, f.detail]),
    [['hidden-from-search', 'noindex, nofollow']],
  );
  assert.deepEqual(ids([page({ live: false, saved: true, title: text(200) })]), ['not-live']);
  assert.deepEqual(ids([page({ live: false, saved: false, title: null })]), [], 'a missing page with nothing saved is not news');
});

test('findings are ordered fix → review → info, and the source travels with them', () => {
  const findings = checkPages([
    page({ path: '/info', noindex: true }),
    page({ path: '/review', title: text(20), titleSource: 'custom' }),
    page({ path: '/fix', description: text(10) }),
  ]);
  assert.deepEqual(findings.map((f) => f.severity), ['fix', 'review', 'info']);
  assert.equal(findings[1].source, 'custom');
  assert.equal(findings[0].source, 'default');
});

test('the summary counts pages and findings consistently', () => {
  const pages = [
    page({ path: '/ok', description: 'A description that is long enough to pass, and specific to this one page alone.' }),
    page({ path: '/long', title: text(70) }),
    page({ path: '/hidden', noindex: true }),
    page({ path: '/gone', live: false, saved: true }),
    page({ path: '/gone-quietly', live: false }),
  ];
  const findings = checkPages(pages);
  assert.deepEqual(summarize(pages, findings), {
    pages: 5,
    checked: 2,
    hidden: 1,
    notLive: 2,
    withFindings: 1,
    fix: 1,
    review: 0,
    info: 2,
  });
});

/* ── Endpoint ─────────────────────────────────────────────────────────────── */

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());
test.beforeEach(() => resetDb());

type Who = keyof typeof SUBJECT;
const token = (who: Who) =>
  jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

async function get(path: string, who?: Who) {
  const res = await fetch(base + path, { headers: who ? { Authorization: `Bearer ${token(who)}` } : {} });
  const raw = await res.text();
  return { status: res.status, headers: res.headers, raw, json: raw ? JSON.parse(raw) : null };
}

const CHECKS_URL = '/api/v1/page-seo/checks';

test('only administrators can run the checks', async () => {
  assert.equal((await get(CHECKS_URL)).status, 401, 'anonymous');
  for (const who of ['receptionist', 'content_writer', 'editor', 'viewer'] as Who[]) {
    assert.equal((await get(CHECKS_URL, who)).status, 403, who);
  }
  assert.equal((await get(CHECKS_URL, 'admin')).status, 200);
  assert.equal(WRITES.length, 0, 'running the checks writes nothing');
});

test('the report: saved and default text, hidden and missing pages, where to fix each', async () => {
  resetDb({
    page_seo: [
      {
        id: 'p-home',
        path: '/',
        meta_title: 'Best IT Training in Hyderabad | GloryTecks Hyderabad',
        keywords: ['KEYWORD-SENTINEL'],
        intent_note: 'INTENT-NOTE-SENTINEL',
        noindex: false,
        nofollow: false,
        updated_by: SUBJECT.admin,
      },
      { id: 'p-contact', path: '/contact', keywords: [], noindex: true, nofollow: false },
      // No python course in the CMS, so this landing 404s; its saved title does nothing.
      { id: 'p-python', path: '/python-course-ameerpet', meta_title: 'Python in Ameerpet', keywords: [], noindex: false, nofollow: false },
    ],
  });

  const res = await get(CHECKS_URL, 'admin');
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'per-user admin data is never cached by a proxy');
  const data = res.json.data;

  const at = (path: string) => (data.findings as Array<Record<string, any>>).filter((f) => f.path === path);

  // A saved home title that breaks two of the site's own rules. The home
  // description is its default (232 characters, within the site's 260), so
  // the editor's 160-character guidance does not apply to it.
  assert.deepEqual(at('/').map((f) => [f.check, f.source]), [
    ['title-place-repeated', 'custom'],
    ['title-superlative', 'custom'],
  ]);

  // The comparison renders its saved title and its intro as the description.
  assert.deepEqual(at('/compare/power-bi-vs-tableau').map((f) => f.check), [
    'description-too-short',
    'title-short',
    'description-superlative',
  ]);

  assert.deepEqual(at('/contact').map((f) => f.check), ['hidden-from-search']);
  assert.deepEqual(at('/python-course-ameerpet').map((f) => f.check), ['not-live']);
  // A landing that 404s with nothing saved is not reported at all.
  assert.deepEqual(at('/mlops-course-ameerpet'), []);

  const pages = data.pages as Array<Record<string, any>>;
  const home = pages.find((p) => p.path === '/');
  assert.equal(home.titleSource, 'custom');
  assert.equal(home.adminPath, '/page-seo/edit?path=%2F');
  assert.equal(pages.find((p) => p.path === '/courses/data-science').adminPath.endsWith('#seo'), true);

  // Every finding points at a page in the report, and every check is in the catalogue.
  const paths = new Set(pages.map((p) => p.path));
  const known = new Set((data.checks as Array<{ id: string }>).map((c) => c.id));
  for (const f of data.findings) {
    assert.ok(paths.has(f.path), f.path);
    assert.ok(known.has(f.check), f.check);
  }

  const { summary } = data;
  assert.equal(summary.pages, pages.length);
  assert.equal(summary.fix + summary.review + summary.info, data.findings.length);
  assert.equal(summary.hidden, 1);
  assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));

  // Editorial fields stay out of a report that does not need them.
  for (const leak of ['KEYWORD-SENTINEL', 'INTENT-NOTE-SENTINEL', '"override"', '"keywords"', '"intentNote"']) {
    assert.ok(!res.raw.includes(leak), `the checks report leaked ${leak}`);
  }
  assert.equal(WRITES.length, 0);
});

test('a save is reflected the next time the checks run', async () => {
  const before = await get(CHECKS_URL, 'admin');
  assert.ok(!before.json.data.findings.some((f: { path: string; check: string }) => f.path === '/placements' && f.check === 'title-over-limit'));

  DB.page_seo.push({ id: 'p-placements', path: '/placements', meta_title: text(70), keywords: [], noindex: false, nofollow: false });
  const after = await get(CHECKS_URL, 'admin');
  assert.ok(after.json.data.findings.some((f: { path: string; check: string }) => f.path === '/placements' && f.check === 'title-over-limit'));
});
