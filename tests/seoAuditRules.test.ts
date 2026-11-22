import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSources, readPage } from '../src/seo/audit/extract';
import {
  analyze,
  evaluationOf,
  fingerprint,
  isEvaluated,
  pageTypeFor,
  type AnalysisInput,
  type AuditFinding,
  type AuditRow,
  type SiteChecks,
} from '../src/seo/audit/analyze';
import { planLifecycle, type KeyedFinding, type StoredIssue } from '../src/seo/audit/lifecycle';
import { AUDIT_CATEGORIES, AUDIT_RULES, auditRule } from '../src/seo/audit/rules';
import { canonicalUrlFor, PRODUCTION_ORIGIN } from '../src/seo/site/canonical';

/**
 * Every audit rule, run on FIXTURES: made-up pages and sitemap results built
 * here, not the live site. Each case starts from a clean three-page FIXTURE
 * site that produces no findings at all, breaks one thing, and checks that
 * exactly the rule for it fires — and on which path.
 */

const HOSTS = ['glorytecks.com', 'www.glorytecks.com'];
const self = (p: string) => canonicalUrlFor(PRODUCTION_ORIGIN, p);

interface PageSpec {
  /** null leaves the tag out; an array writes several. */
  title?: string | null | string[];
  description?: string | null | string[];
  canonical?: string | null | string[];
  robots?: string | null;
  h1?: string | null | string[];
  /** Main-content links: [path, text]. */
  links?: [string, string][];
  /** Extra markup in <main>, after the h1. */
  main?: string;
  head?: string;
}

const list = <T>(v: T | T[] | null | undefined, fallback: T): T[] => (v === null ? [] : Array.isArray(v) ? v : [v ?? fallback]);

/** A FIXTURE page: everything a clean page needs, unless the spec takes it away. */
function html(path: string, spec: PageSpec = {}): string {
  const titles = list(spec.title, `Fixture page ${path} | GloryTecks`);
  const descriptions = list(spec.description, `Fixture description for ${path}: what this made-up page covers, long enough for the site rules.`);
  const canonicals = list(spec.canonical, self(path));
  const h1s = list(spec.h1, `Fixture heading for ${path}`);
  const links = (spec.links ?? []).map(([to, text]) => `<p><a href="${to}">${text}</a></p>`).join('');
  return [
    '<!doctype html><html><head>',
    ...titles.map((t) => `<title>${t}</title>`),
    ...descriptions.map((d) => `<meta name="description" content="${d}">`),
    ...canonicals.map((c) => `<link rel="canonical" href="${c}">`),
    spec.robots === null ? '' : `<meta name="robots" content="${spec.robots ?? 'index, follow'}">`,
    spec.head ?? '',
    '</head><body>',
    '<header><nav><a href="/">Home</a><a href="/courses">Courses</a></nav></header>',
    '<main>',
    ...h1s.map((h) => `<h1>${h}</h1>`),
    links,
    spec.main ?? '',
    '</main>',
    '<footer><p>Fixture footer</p></footer>',
    '</body></html>',
  ].join('');
}

interface RowSpec extends Partial<AuditRow> {
  /** Served page: read with the audit's own extraction. */
  page?: PageSpec;
  xRobotsTag?: string | null;
  hostNoindex?: boolean;
}

/** One crawled FIXTURE URL. With `page`, it answered 200 and was read as HTML. */
function row(path: string, spec: RowSpec = {}): AuditRow {
  const { page, xRobotsTag = null, hostNoindex = false, ...rest } = spec;
  const inSitemap = rest.inSitemap ?? false;
  const read = page
    ? readPage({
        path,
        url: `https://glorytecks.com${path}`,
        html: html(path, page),
        contentType: 'text/html; charset=utf-8',
        truncated: false,
        xRobotsTag,
        hostNoindex,
        linkHosts: HOSTS,
        sitemapLoc: inSitemap ? (rest.loc ?? self(path)) : null,
        status: 200,
      })
    : null;
  return {
    kind: 'page',
    path,
    state: 'done',
    sources: inSitemap ? ['sitemap:/sitemaps/pages.xml'] : ['link'],
    inSitemap,
    loc: inSitemap ? self(path) : null,
    expectedLive: inSitemap,
    expectIndex: null,
    expectFollow: null,
    status: page ? 200 : (rest.status ?? 200),
    finalStatus: page ? 200 : (rest.finalStatus ?? rest.status ?? 200),
    finalUrl: `https://glorytecks.com${path}`,
    hops: [],
    loop: false,
    offsite: null,
    error: null,
    skipReason: null,
    record: read?.record ?? null,
    links: read?.links ?? null,
    images: read?.images ?? null,
    ...rest,
  };
}

/** The clean FIXTURE site: three pages that link to each other, all in the sitemap. */
const cleanRows = (): AuditRow[] => [
  row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course']] } }),
  row('/courses', { inSitemap: true, page: { links: [['/courses/python', 'Python course details']] } }),
  row('/courses/python', { inSitemap: true, page: { links: [['/courses', 'All courses']] } }),
];

const cleanSite = (): SiteChecks => ({
  robots: { checked: true, failures: [] },
  sitemapIndex: { checked: true, failures: [] },
  children: [{ path: '/sitemaps/pages.xml', checked: true, failures: [] }],
  hygiene: { checked: true, failures: [] },
});

/** Every rule a case produced, so the last test can check that all of them were exercised. */
const exercised = new Set<string>();

function run(rows: AuditRow[], over: Partial<AnalysisInput> = {}): AuditFinding[] {
  const findings = analyze({
    rows,
    site: cleanSite(),
    coverageComplete: true,
    sitemapsComplete: true,
    hostNoindex: false,
    textSources: new Map(),
    ...over,
  });
  for (const f of findings) exercised.add(f.rule);
  return findings;
}

const summary = (findings: AuditFinding[]) => findings.map((f) => `${f.rule} ${f.path}`).sort();

/* ── The clean site ───────────────────────────────────────────────────────── */

test('FIXTURE: the clean three-page site produces no findings', () => {
  assert.deepEqual(summary(run(cleanRows())), []);
});

/* ── Availability ─────────────────────────────────────────────────────────── */

test('FIXTURE http-status: a listed URL answering 404, or redirecting to an error', () => {
  const findings = run([
    ...cleanRows(),
    row('/gone-course', { expectedLive: true, sources: ['registry'], status: 404, finalStatus: 404 }),
    row('/moved-then-gone', {
      expectedLive: true,
      sources: ['cms:course'],
      status: 308,
      finalStatus: 410,
      hops: [{ status: 308, location: '/somewhere' }],
    }),
  ]);
  assert.deepEqual(summary(findings), ['http-status /gone-course', 'http-status /moved-then-gone']);
  assert.match(findings[0].detail, /HTTP 404/);
  assert.match(findings[1].detail, /ends at HTTP 410/);
  assert.deepEqual(findings[0].evidence.listedIn, ['registry']);
});

test('FIXTURE redirected-url, redirect-chain, redirect-loop and redirect-offsite on listed URLs', () => {
  const listed = { expectedLive: true, sources: ['sitemap:/sitemaps/pages.xml'] };
  const findings = run([
    ...cleanRows(),
    row('/one-hop', { ...listed, status: 308, finalStatus: 200, hops: [{ status: 308, location: '/courses' }] }),
    row('/two-hops', {
      ...listed,
      status: 301,
      finalStatus: 200,
      hops: [
        { status: 301, location: '/one-hop' },
        { status: 308, location: '/courses' },
      ],
    }),
    row('/loop', { ...listed, status: 308, finalStatus: null, loop: true, hops: [{ status: 308, location: '/loop2' }, { status: 308, location: '/loop' }] }),
    row('/away', { ...listed, status: 302, finalStatus: 302, offsite: 'evil.example (evil.example is not an approved host)', hops: [{ status: 302, location: 'https://evil.example/' }] }),
  ]);
  assert.deepEqual(summary(findings), ['redirect-chain /two-hops', 'redirect-loop /loop', 'redirect-offsite /away', 'redirected-url /one-hop']);
});

test('FIXTURE: a URL only found through a link is judged as a link, not as a listed URL', () => {
  const findings = run([...cleanRows(), row('/unlisted', { status: 404, finalStatus: 404 })]);
  assert.deepEqual(summary(findings), []);
});

test('FIXTURE soft-404: a 200 page that reads as not found', () => {
  const findings = run([
    ...cleanRows().map((r) => (r.path === '/' ? row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ['/lost', 'Lost page']] } }) : r)),
    row('/lost', { page: { title: 'Page not found | GloryTecks', h1: '404 — page not found', canonical: null, robots: 'noindex' } }),
  ]);
  assert.deepEqual(summary(findings), ['soft-404 /lost']);
});

/* ── Indexing ─────────────────────────────────────────────────────────────── */

test('FIXTURE canonical-mismatch: an indexable page whose canonical is not itself; a noindex page is not judged', () => {
  const rows = cleanRows();
  rows[2] = row('/courses/python', { inSitemap: true, page: { canonical: self('/courses'), links: [['/courses', 'All courses']] } });
  const findings = run([...rows, row('/filtered', { page: { canonical: self('/courses'), robots: 'noindex, follow' } })]);
  // The sitemap check sees the same canonical problem on the listed URL.
  assert.deepEqual(summary(findings), ['canonical-mismatch /courses/python', 'non-canonical-link /courses/python', 'sitemap-url-invalid /courses/python']);
  const canonical = findings.find((f) => f.rule === 'canonical-mismatch')!;
  assert.equal(canonical.evidence.expected, self('/courses/python'));
});

test('FIXTURE canonical-mismatch: two canonicals, or none', () => {
  const findings = run([
    ...cleanRows(),
    row('/two', { page: { canonical: [self('/two'), self('/courses')] } }),
    row('/none', { page: { canonical: null } }),
  ]);
  const canon = findings.filter((f) => f.rule === 'canonical-mismatch');
  assert.deepEqual(canon.map((f) => `${f.path}: ${f.detail}`).sort(), ['/none: no canonical', '/two: 2 canonicals']);
});

test('FIXTURE sitemap-url-invalid: checkSitemapUrl failures, including a non-200 sitemap URL', () => {
  const findings = run([
    ...cleanRows(),
    row('/listed-404', { inSitemap: true, status: 404, finalStatus: 404 }),
  ]);
  assert.deepEqual(summary(findings), ['http-status /listed-404', 'sitemap-url-invalid /listed-404']);
  assert.deepEqual(findings.find((f) => f.rule === 'sitemap-url-invalid')!.evidence.failures, ['HTTP 404']);
});

test('FIXTURE sitemap-url-invalid on a *.vercel.app origin: the host must send X-Robots-Tag: noindex, and the header does not make pages noindex', () => {
  const staging = { hostNoindex: true };
  const rows = [
    row('/', { ...staging, inSitemap: true, xRobotsTag: 'noindex', page: { links: [['/courses/python', 'Python course']] } }),
    row('/courses', { ...staging, inSitemap: true, xRobotsTag: 'noindex', page: { links: [['/courses/python', 'Python course details']] } }),
    // This response forgot the staging header.
    row('/courses/python', { ...staging, inSitemap: true, xRobotsTag: null, page: { links: [['/courses', 'All courses']] } }),
  ];
  const findings = run(rows, { hostNoindex: true });
  assert.deepEqual(summary(findings), ['sitemap-url-invalid /courses/python']);
  assert.match(findings[0].detail, /vercel\.app response without X-Robots-Tag: noindex/);
  // The staging header did not count as noindex: no sitemap-noindex, canonical checks still ran.
  assert.equal(rows[0].record?.index, true);
});

test('FIXTURE sitemap-noindex and unexpected-noindex: a noindex page in a sitemap, and one the CMS wants indexed', () => {
  const rows = cleanRows();
  rows[1] = row('/courses', { inSitemap: true, page: { robots: 'noindex, follow', links: [['/courses/python', 'Python course details']] } });
  let findings = run(rows);
  assert.ok(summary(findings).includes('sitemap-noindex /courses'));
  assert.ok(!summary(findings).includes('unexpected-noindex /courses'));

  rows[1] = { ...rows[1], expectIndex: true };
  findings = run(rows);
  assert.ok(summary(findings).includes('unexpected-noindex /courses'));
  assert.ok(!summary(findings).includes('sitemap-noindex /courses'), 'the CMS intent explains it: one finding, not two');
});

test('FIXTURE unexpected-noindex through the X-Robots-Tag header on the production host', () => {
  const rows = cleanRows();
  rows[1] = row('/courses', { inSitemap: true, expectIndex: true, xRobotsTag: 'noindex', page: { links: [['/courses/python', 'Python course details']] } });
  const findings = run(rows);
  assert.ok(summary(findings).includes('unexpected-noindex /courses'));
  assert.match(findings.find((f) => f.rule === 'sitemap-url-invalid')!.detail, /X-Robots-Tag "noindex" on the production host/);
});

test('FIXTURE unexpected-nofollow: served nofollow on a page the CMS did not set it for', () => {
  const rows = cleanRows();
  rows[2] = row('/courses/python', { inSitemap: true, expectFollow: true, page: { robots: 'index, nofollow', links: [['/courses', 'All courses']] } });
  assert.deepEqual(summary(run(rows)), ['unexpected-nofollow /courses/python']);
  // Without a CMS intent, nofollow is not flagged.
  rows[2] = { ...rows[2], expectFollow: null };
  assert.deepEqual(summary(run(rows)), []);
});

test('FIXTURE not-in-sitemap: an indexable self-canonical page no sitemap lists; ?page=N slices are exempt', () => {
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ['/extra', 'Extra page'], ['/blog?page=2', 'Older posts']] } });
  const findings = run([
    ...rows,
    row('/extra', { page: { links: [['/courses', 'Courses']] } }),
    row('/blog?page=2', { page: { links: [['/courses', 'Courses']] } }),
  ]);
  assert.deepEqual(summary(findings).filter((s) => s.startsWith('not-in-sitemap')), ['not-in-sitemap /extra']);
  // Only when every sitemap was read.
  assert.deepEqual(summary(run([...rows, row('/extra', { page: {} })], { sitemapsComplete: false })).filter((s) => s.startsWith('not-in-sitemap')), []);
});

/* ── Sitemaps and robots.txt ──────────────────────────────────────────────── */

test('FIXTURE robots-txt, sitemap-index, sitemap-urlset and sitemap-hygiene from the site-file checks', () => {
  const site: SiteChecks = {
    robots: { checked: true, failures: ['robots.txt does not list https://glorytecks.com/sitemap.xml (found: none)'] },
    sitemapIndex: { checked: true, failures: ['sitemap index entry https://example.org/x.xml is not under https://glorytecks.com/sitemaps/'] },
    children: [
      { path: '/sitemaps/pages.xml', checked: true, failures: [] },
      { path: '/sitemaps/blog.xml', checked: true, failures: ['https://glorytecks.com/Blog/X is not a valid canonical on https://glorytecks.com'] },
    ],
    hygiene: { checked: true, failures: ['/sitemaps/blog.xml carries <priority> or <changefreq>'] },
  };
  const findings = run(cleanRows(), { site });
  assert.deepEqual(summary(findings), ['robots-txt /robots.txt', 'sitemap-hygiene /sitemap.xml', 'sitemap-index /sitemap.xml', 'sitemap-urlset /sitemaps/blog.xml']);
  assert.equal(pageTypeFor('/sitemaps/blog.xml'), 'site-file');
});

/* ── Links and images ─────────────────────────────────────────────────────── */

test('FIXTURE broken-internal-link: one finding per target, with every page that links to it', () => {
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ['/missing', 'Old link']] } });
  rows[1] = row('/courses', { inSitemap: true, page: { links: [['/courses/python', 'Python course details'], ['/missing', 'Old link']] } });
  const findings = run([...rows, { ...row('/missing', { status: 404, finalStatus: 404 }), kind: 'link' }]);
  assert.deepEqual(summary(findings), ['broken-internal-link /missing']);
  assert.deepEqual(findings[0].affected, ['/', '/courses']);
  assert.equal(findings[0].affectedCount, 2);
  assert.match(String((findings[0].evidence.examples as string[])[0]), /main/);
});

test('FIXTURE redirected-internal-link and non-canonical-link', () => {
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ['/old', 'Old URL'], ['/variant', 'Variant']] } });
  const findings = run([
    ...rows,
    row('/old', { status: 308, finalStatus: 200, hops: [{ status: 308, location: '/courses' }], finalUrl: 'https://glorytecks.com/courses' }),
    row('/variant', { page: { canonical: self('/courses'), robots: 'noindex, follow' } }),
  ]);
  assert.deepEqual(summary(findings), ['non-canonical-link /variant', 'redirected-internal-link /old']);
  assert.match(findings.find((f) => f.rule === 'redirected-internal-link')!.detail, /redirects \(308\) to https:\/\/glorytecks\.com\/courses/);
});

test('FIXTURE broken-image: an image answering 404, with the pages that show it', () => {
  const src = 'https://res.cloudinary.com/fixture/image/upload/missing.png';
  const rows = cleanRows();
  rows[1] = row('/courses', { inSitemap: true, page: { links: [['/courses/python', 'Python course details']], main: `<img src="${src}" alt="Fixture">` } });
  const image: AuditRow = { ...row(src, { status: 404, finalStatus: 404 }), kind: 'image', sources: ['image'] };
  const findings = run([...rows, image]);
  assert.deepEqual(summary(findings), [`broken-image ${src}`]);
  assert.deepEqual(findings[0].affected, ['/courses']);
  assert.equal(findings[0].pageType, 'image');
});

test('FIXTURE orphan-page and weakly-linked: judged only when the whole site was read', () => {
  const rows = [
    ...cleanRows(),
    row('/lonely', { inSitemap: true, page: {} }),
    // Linked from every page's header menu, never from content.
    row('/courses-menu-only', { inSitemap: true, page: {} }),
    // The same, but no sitemap lists it: like the site's link-graph check, not judged as weak.
    row('/menu-not-listed', { page: {} }),
  ];
  // Put the menu links on the clean pages.
  for (const r of rows.slice(0, 3)) {
    r.links = [...(r.links ?? []), { to: '/courses-menu-only', zone: 'header', nav: true, anchor: 'Menu' }, { to: '/menu-not-listed', zone: 'header', nav: true, anchor: 'Other' }];
  }
  const complete = run(rows);
  assert.deepEqual(summary(complete).filter((s) => /orphan|weak/.test(s)), ['orphan-page /lonely', 'weakly-linked /courses-menu-only']);
  const partial = run(rows, { coverageComplete: false });
  assert.deepEqual(summary(partial).filter((s) => /orphan|weak/.test(s)), []);
});

test('FIXTURE empty-anchor: a link with no accessible name', () => {
  const rows = cleanRows();
  rows[2] = row('/courses/python', { inSitemap: true, page: { links: [['/courses', 'All courses']], main: '<a href="/courses"><svg></svg></a>' } });
  assert.deepEqual(summary(run(rows)), ['empty-anchor /courses/python']);
});

/* ── On-page ──────────────────────────────────────────────────────────────── */

test('FIXTURE title-tag and meta-description-tag: missing, repeated or empty', () => {
  const extra = [
    row('/no-title', { page: { title: null } }),
    row('/two-titles', { page: { title: ['First title for fixture | GloryTecks', 'Second title for fixture | GloryTecks'] } }),
    row('/no-description', { page: { description: null } }),
    row('/empty-description', { page: { description: '' } }),
  ];
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ...extra.map((r): [string, string] => [r.path, `Fixture ${r.path}`])] } });
  const findings = run([...rows, ...extra]).filter((f) => f.rule === 'title-tag' || f.rule === 'meta-description-tag');
  assert.deepEqual(
    findings.map((f) => `${f.rule} ${f.path}: ${f.detail}`).sort(),
    [
      'meta-description-tag /empty-description: the meta description is empty',
      'meta-description-tag /no-description: no meta description',
      'title-tag /no-title: no <title>',
      'title-tag /two-titles: 2 <title> elements',
    ],
  );
});

test('FIXTURE h1 and heading-outline', () => {
  const extra = [
    row('/two-h1', { page: { h1: ['First heading', 'Second heading'] } }),
    row('/no-h1', { page: { h1: null, main: '<h2>Only a subheading</h2>' } }),
    row('/skipped-level', { page: { main: '<h3>Jumped straight to h3</h3>' } }),
  ];
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ...extra.map((r): [string, string] => [r.path, `Fixture ${r.path}`])] } });
  const findings = run([...rows, ...extra]).filter((f) => f.rule === 'h1' || f.rule === 'heading-outline');
  assert.deepEqual(summary(findings), ['h1 /no-h1', 'h1 /two-h1', 'heading-outline /skipped-level']);
  assert.match(findings.find((f) => f.rule === 'heading-outline')!.detail, /skips h1 → h3/);
});

test('FIXTURE image-alt: an <img> with no alt; alt="" (decorative) is fine', () => {
  const rows = cleanRows();
  rows[2] = row('/courses/python', {
    inSitemap: true,
    page: { links: [['/courses', 'All courses']], main: '<img src="/a.png"><img src="/b.png" alt="">' },
  });
  const findings = run(rows).filter((f) => f.rule === 'image-alt');
  assert.deepEqual(summary(findings), ['image-alt /courses/python']);
  assert.deepEqual(findings[0].evidence.images, ['/a.png']);
});

/* ── Structured data ──────────────────────────────────────────────────────── */

test('FIXTURE json-ld-invalid, faq-markup-mismatch and breadcrumb-mismatch', () => {
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Is this question on the page?', acceptedAnswer: { '@type': 'Answer', text: 'No, only in the markup.' } }] };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: self('/') }, { '@type': 'ListItem', position: 2, name: 'Courses', item: self('/courses') }] };
  const extra = [
    row('/bad-json', { page: { head: '<script type="application/ld+json">{ not json }</script>' } }),
    row('/faq', { page: { head: `<script type="application/ld+json">${JSON.stringify(faq)}</script>` } }),
    row('/crumbs', { page: { head: `<script type="application/ld+json">${JSON.stringify(crumbs)}</script>` } }),
  ];
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ...extra.map((r): [string, string] => [r.path, `Fixture ${r.path}`])] } });
  const findings = run([...rows, ...extra]).filter((f) => f.category === 'structured-data');
  assert.deepEqual(summary(findings), ['breadcrumb-mismatch /crumbs', 'faq-markup-mismatch /faq', 'json-ld-invalid /bad-json']);
  assert.match(findings.find((f) => f.rule === 'breadcrumb-mismatch')!.detail, /ends at https:\/\/glorytecks\.com\/courses/);
});

/* ── Content and editorial ────────────────────────────────────────────────── */

test('FIXTURE claim-wording: claim patterns to check, as information; a disclaimed guarantee is not reported', () => {
  const rows = cleanRows();
  rows[1] = row('/courses', { inSitemap: true, page: { links: [['/courses/python', 'Python course details']], main: '<p>A 100% placement guarantee for every learner.</p>' } });
  rows[2] = row('/courses/python', { inSitemap: true, page: { links: [['/courses', 'All courses']], main: '<p>Training is not a guarantee of a job.</p>' } });
  const findings = run(rows);
  assert.deepEqual(summary(findings), ['claim-wording /courses']);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'content');
});

test('FIXTURE editorial hints: the SEO checks on served text; duplicates only with full coverage; blog posts left to the blog audit', () => {
  const long = 'A fixture title that runs well past the sixty-five character site limit | GloryTecks';
  const rows = cleanRows();
  rows[0] = row('/', { inSitemap: true, page: { links: [['/courses/python', 'Python course'], ['/blog/fixture-post', 'Post']] } });
  rows[1] = row('/courses', { inSitemap: true, page: { title: 'Shared fixture title | GloryTecks', links: [['/courses/python', 'Python course details']] } });
  rows[2] = row('/courses/python', { inSitemap: true, page: { title: 'Shared fixture title | GloryTecks', links: [['/courses', 'All courses']] } });
  const post = row('/blog/fixture-post', { inSitemap: true, page: { title: long } });
  rows.push(row('/long-title', { inSitemap: true, page: { title: long } }), post);
  rows[0].links!.push({ to: '/long-title', zone: 'main', nav: false, anchor: 'Long title page' });

  const complete = summary(run(rows)).filter((s) => s.startsWith('editorial:'));
  assert.deepEqual(complete, [
    'editorial:title-duplicate /courses',
    'editorial:title-duplicate /courses/python',
    'editorial:title-over-limit /long-title',
  ]);
  const partial = summary(run(rows, { coverageComplete: false })).filter((s) => s.startsWith('editorial:'));
  assert.deepEqual(partial, ['editorial:title-over-limit /long-title']);
  for (const f of run(rows)) if (f.rule.startsWith('editorial:')) assert.match(auditRule(f.rule).why, /editorial hint, not a ranking rule/);
});

/* ── Reading pages ────────────────────────────────────────────────────────── */

test('FIXTURE extraction: images are checked at their source, and identical links are stored once', () => {
  const page = `<main>
    <img src="/_next/image?url=https%3A%2F%2Fres.cloudinary.com%2Ffixture%2Fa.png&amp;w=640&amp;q=75" alt="A">
    <img src="data:image/png;base64,AAAA" alt="">
    <img src="/images/b.png" alt="B">
    <img srcset="/images/c.png 1x, /images/c@2x.png 2x" alt="C">
  </main>`;
  assert.deepEqual(imageSources(page, 'https://glorytecks.com/courses'), [
    'https://res.cloudinary.com/fixture/a.png',
    'https://glorytecks.com/images/b.png',
    'https://glorytecks.com/images/c.png',
  ]);

  const read = readPage({
    path: '/',
    url: 'https://glorytecks.com/',
    html: html('/', { main: '<a href="/courses">Courses</a><a href="/courses">Courses</a><a href="/courses">Next page</a>' }),
    contentType: 'text/html',
    truncated: false,
    xRobotsTag: null,
    hostNoindex: false,
    linkHosts: HOSTS,
    sitemapLoc: null,
    status: 200,
  });
  const toCourses = read.links.filter((l) => l.to === '/courses' && l.zone === 'main').map((l) => l.anchor);
  assert.deepEqual(toCourses, ['Courses', 'Next page'], 'a duplicate edge is dropped, a different anchor is kept');
});

/* ── What a run looked at, and the issue history ──────────────────────────── */

const site = cleanSite();

test('isEvaluated: an issue is only closed when the run looked at what it is about', () => {
  const rows = [row('/a', { page: {} }), { ...row('/b', {}), state: 'failed' as const }];
  const partial = evaluationOf(rows, site, { complete: false, imagesComplete: false, sitemapsComplete: true });
  assert.equal(isEvaluated(partial, 'title-tag', '/a'), true, 'answered in this run');
  assert.equal(isEvaluated(partial, 'title-tag', '/b'), false, 'failed: not looked at');
  assert.equal(isEvaluated(partial, 'title-tag', '/never-seen'), false, 'not reached: incomplete coverage');
  assert.equal(isEvaluated(partial, 'orphan-page', '/a'), false, 'graph rules need the whole site');
  assert.equal(isEvaluated(partial, 'editorial:title-duplicate', '/a'), false);
  assert.equal(isEvaluated(partial, 'broken-image', 'https://res.cloudinary.com/x.png'), false);
  assert.equal(isEvaluated(partial, 'no-such-rule', '/a'), false);

  const complete = evaluationOf([row('/a', { page: {} })], site, { complete: true, imagesComplete: true, sitemapsComplete: true });
  assert.equal(isEvaluated(complete, 'title-tag', '/no-longer-linked'), true, 'complete: a URL no one lists or links any more');
  assert.equal(isEvaluated(complete, 'orphan-page', '/a'), true);
  assert.equal(isEvaluated(complete, 'sitemap-urlset', '/sitemaps/pages.xml'), true);
  assert.equal(isEvaluated(complete, 'sitemap-urlset', '/sitemaps/removed.xml'), true, 'the index no longer lists it');
  const noIndexRead = evaluationOf([], { ...site, sitemapIndex: { checked: false, failures: [] }, children: [] }, { complete: false, imagesComplete: false, sitemapsComplete: false });
  assert.equal(isEvaluated(noIndexRead, 'sitemap-urlset', '/sitemaps/pages.xml'), false);
  assert.equal(isEvaluated(noIndexRead, 'not-in-sitemap', '/a'), false);
});

const RUN1 = { id: 'run-1', at: '2026-10-20T10:00:00.000Z', origin: 'https://glorytecks.com' };
const RUN2 = { id: 'run-2', at: '2026-10-21T10:00:00.000Z', origin: 'https://glorytecks.com' };

const keyed = (f: Partial<KeyedFinding> & { rule: string; path: string }): KeyedFinding => ({
  category: auditRule(f.rule).category,
  severity: auditRule(f.rule).severity,
  target: null,
  pageType: 'static',
  detail: 'fixture',
  evidence: {},
  affected: [],
  affectedCount: 0,
  adminPath: null,
  fingerprint: fingerprint(RUN1.origin, f.rule, f.path, null),
  ...f,
});

const stored = (k: KeyedFinding, over: Partial<StoredIssue> = {}): StoredIssue => ({
  id: `id-${k.path}`,
  fingerprint: k.fingerprint,
  rule: k.rule,
  path: k.path,
  status: 'open',
  timesSeen: 1,
  reopenedCount: 0,
  firstRunId: RUN1.id,
  lastRunId: RUN1.id,
  resolvedRunId: null,
  firstSeenAt: RUN1.at,
  ...over,
});

const always = () => true;

test('lifecycle: a new issue, then the same issue in the next run', () => {
  const f = keyed({ rule: 'h1', path: '/a' });
  const first = planLifecycle([], [f], RUN1, always);
  assert.deepEqual(first.counts, { new: 1, recurring: 0, reopened: 0, resolved: 0 });
  assert.equal(first.upserts[0].times_seen, 1);
  assert.equal(first.upserts[0].first_run_id, RUN1.id);
  assert.equal(first.upserts[0].first_seen_at, RUN1.at);

  const second = planLifecycle([stored(f)], [f], RUN2, always);
  assert.deepEqual(second.counts, { new: 0, recurring: 1, reopened: 0, resolved: 0 });
  assert.equal(second.upserts[0].times_seen, 2);
  assert.equal(second.upserts[0].first_seen_at, RUN1.at, 'first seen never moves');
  assert.equal(second.upserts[0].first_run_id, RUN1.id);
  assert.equal(second.upserts[0].last_seen_at, RUN2.at);
  assert.equal(second.upserts[0].last_run_id, RUN2.id);
});

test('lifecycle: analysing the same run again does not count it twice', () => {
  const f = keyed({ rule: 'h1', path: '/a' });
  const again = planLifecycle([stored(f, { timesSeen: 2, lastRunId: RUN2.id })], [f], RUN2, always);
  assert.equal(again.upserts[0].times_seen, 2);
});

test('lifecycle: an issue not reported is resolved only if the run looked at it', () => {
  const a = keyed({ rule: 'h1', path: '/a' });
  const b = keyed({ rule: 'h1', path: '/b' });
  const plan = planLifecycle([stored(a), stored(b)], [], RUN2, (_rule, path) => path === '/a');
  assert.deepEqual(plan.resolve, ['id-/a']);
  assert.equal(plan.counts.resolved, 1);
  assert.deepEqual(planLifecycle([stored(a)], [], RUN2, () => false).resolve, [], 'partial coverage resolves nothing');
});

test('lifecycle: a resolved issue that comes back is reopened — unless this same run had resolved it', () => {
  const f = keyed({ rule: 'h1', path: '/a' });
  const back = planLifecycle([stored(f, { status: 'resolved', resolvedRunId: RUN1.id })], [f], RUN2, always);
  assert.equal(back.upserts[0].status, 'open');
  assert.equal(back.upserts[0].resolved_at, null);
  assert.equal(back.upserts[0].reopened_count, 1);
  assert.equal(back.counts.reopened, 1);

  const corrected = planLifecycle([stored(f, { status: 'resolved', resolvedRunId: RUN2.id })], [f], RUN2, always);
  assert.equal(corrected.upserts[0].reopened_count, 0);
  assert.equal(corrected.counts.reopened, 0);
});

test('lifecycle: one row per fingerprint, and fingerprints are per origin', () => {
  const f = keyed({ rule: 'h1', path: '/a' });
  assert.equal(planLifecycle([], [f, { ...f }], RUN1, always).upserts.length, 1);
  assert.notEqual(fingerprint('https://glorytecks.com', 'h1', '/a', null), fingerprint('https://staging-x.vercel.app', 'h1', '/a', null));
  assert.match(fingerprint('https://glorytecks.com', 'h1', '/a', null), /^[0-9a-f]{40}$/);
});

/* ── The catalogue ────────────────────────────────────────────────────────── */

test('every rule says why it matters, how to fix it and where it comes from — and none promises rankings', () => {
  const ids = new Set<string>();
  for (const r of AUDIT_RULES) {
    assert.ok(!ids.has(r.id), `duplicate rule ${r.id}`);
    ids.add(r.id);
    assert.ok(AUDIT_CATEGORIES.includes(r.category), r.id);
    for (const field of ['label', 'why', 'fix', 'source'] as const) assert.ok(r[field].trim().length > 5, `${r.id}.${field}`);
    const text = `${r.label} ${r.why} ${r.fix}`;
    assert.doesNotMatch(text, /\b(boost|improve|increase|raise)s?\b[^.]*\b(rank|ranking|rankings|position)\b|\brank(s)? (higher|better)\b/i, r.id);
  }
});

test('every fixed rule was exercised by a FIXTURE above', () => {
  const missing = AUDIT_RULES.filter((r) => !r.id.startsWith('editorial:') && !exercised.has(r.id)).map((r) => r.id);
  assert.deepEqual(missing, []);
});
