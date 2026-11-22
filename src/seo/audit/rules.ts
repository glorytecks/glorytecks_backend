import { CHECKS, type CheckId } from '../pageChecks';

/*
  What the technical SEO audit reports, and where each rule comes from.

  Every rule below is one the site already holds itself to. The page-level
  readings (extractSeo, headings, images, robots, structured data, links) are
  the site's own functions, copied verbatim into ../site and kept identical by
  main-website/lib/seo/auditParity.test.ts. The predicates that turn readings
  into findings follow the assertions of the site's full crawl,
  main-website/lib/seo/sitecrawl.live.test.ts, which names each `source` here.

  Findings are checks and advice. None of them predicts a ranking.
*/

export type AuditCategory = 'availability' | 'indexing' | 'sitemap' | 'links' | 'on-page' | 'structured-data' | 'editorial' | 'content';
export type AuditSeverity = 'fix' | 'review' | 'info';

export interface AuditRule {
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  label: string;
  /** Why it matters, in plain words. */
  why: string;
  /** What to do about it. */
  fix: string;
  /** The site code the rule comes from. */
  source: string;
}

const CRAWL = 'main-website/lib/seo/sitecrawl.live.test.ts';

const FIXED: AuditRule[] = [
  /* availability */
  {
    id: 'http-status', category: 'availability', severity: 'fix', label: 'Listed URL does not answer 200',
    why: 'A URL the sitemap or the route registry says is live answers with an error, so visitors and crawlers reach a dead end.',
    fix: 'Publish the record or restore the page, or remove the URL from wherever it is listed.',
    source: `${CRAWL} — "every URL from the registries, config, CMS and sitemaps answers 200 without a redirect"`,
  },
  {
    id: 'redirected-url', category: 'availability', severity: 'fix', label: 'Listed URL redirects',
    why: 'Listed URLs should be final destinations. A redirect costs an extra request and tells crawlers the listing is out of date.',
    fix: 'List the destination instead (sitemap, links, registry), or remove the redirect if the old URL should be the page.',
    source: `${CRAWL} — "answers 200 without a redirect"`,
  },
  {
    id: 'redirect-chain', category: 'availability', severity: 'fix', label: 'Redirect chain',
    why: 'More than one hop before the page: every hop is another round trip, and long chains may not be followed to the end.',
    fix: 'Point the first URL straight at the final destination.',
    source: `${CRAWL} — "every configured redirect is one hop to a 200"`,
  },
  {
    id: 'redirect-loop', category: 'availability', severity: 'fix', label: 'Redirect loop',
    why: 'The redirects lead back to a URL already visited, so the page never loads.',
    fix: 'Remove one of the redirects in the loop (next.config.mjs or the hosting configuration).',
    source: 'main-website/lib/seo/pageAudit.ts — followRedirects',
  },
  {
    id: 'redirect-offsite', category: 'availability', severity: 'fix', label: 'Redirects to another host',
    why: 'The URL redirects to a host outside the site. The audit does not follow it, and visitors leave the site.',
    fix: 'Check the redirect is intended; if not, point it at the right page on the site.',
    source: 'backend/src/lib/safeHttp.ts — the audit only follows redirects to approved hosts',
  },
  {
    id: 'soft-404', category: 'availability', severity: 'fix', label: 'Soft 404',
    why: 'The page answers 200 but says it is not found, so crawlers may keep an error page as if it were content.',
    fix: 'Make the route answer 404 (or 410) when the content does not exist, or restore the content.',
    source: `${CRAWL} — "no 200 page is a soft 404" (pageAudit.isSoft404)`,
  },

  /* indexing */
  {
    id: 'canonical-mismatch', category: 'indexing', severity: 'fix', label: 'Canonical is not this page',
    why: 'An indexable page should declare exactly one canonical: its own production URL. Anything else asks search engines to index a different URL.',
    fix: 'Check the page’s canonical generation (lib/seo/canonical.ts) and any CMS override for this page.',
    source: `${CRAWL} — "every indexable page declares exactly one canonical, its own URL"`,
  },
  {
    id: 'sitemap-url-invalid', category: 'indexing', severity: 'fix', label: 'Sitemap URL is not a clean canonical',
    why: 'Every sitemap entry should answer 200 without a redirect, declare itself as its one canonical, be indexable, and carry the X-Robots-Tag its host requires (noindex on *.vercel.app, none in production).',
    fix: 'Fix the page’s canonical or robots settings, or remove the URL from the sitemap that lists it.',
    source: 'main-website/lib/seo/smoke.ts — checkSitemapUrl',
  },
  {
    id: 'sitemap-noindex', category: 'indexing', severity: 'fix', label: 'Noindex URL in a sitemap',
    why: 'The sitemap asks for the page to be indexed while the page asks not to be. One of the two is a mistake.',
    fix: 'Remove the noindex if the page should be found, or drop it from the sitemap if it should not.',
    source: `${CRAWL} — "every sitemap URL is a 200, indexable, self-canonical page"`,
  },
  {
    id: 'unexpected-noindex', category: 'indexing', severity: 'fix', label: 'Live page asks not to be indexed',
    why: 'The CMS has this page live and has not hidden it from search, but the page (robots meta or X-Robots-Tag) says noindex, so it will drop out of results.',
    fix: 'Find where the noindex comes from — the route’s metadata, a stray header, or a setting — and remove it, or hide the page deliberately in its editor.',
    source: 'Page SEO and blog settings (what the CMS intends) against the served robots directives (pageAudit.robotsState)',
  },
  {
    id: 'unexpected-nofollow', category: 'indexing', severity: 'review', label: 'Live page asks crawlers not to follow its links',
    why: 'The CMS has not set nofollow for this page, but it serves nofollow, so crawlers ignore every link on it.',
    fix: 'Remove the nofollow from the route’s metadata or headers, or set it deliberately in the page’s editor.',
    source: 'Page SEO and blog settings against the served robots directives; the site requires index,follow on its fixed pages (smoke.ts → checkPage)',
  },
  {
    id: 'not-in-sitemap', category: 'indexing', severity: 'review', label: 'Indexable page missing from the sitemaps',
    why: 'An indexable, self-canonical page that no sitemap lists is harder for crawlers to discover. Paginated archive pages are excluded on purpose.',
    fix: 'Add the page to the right sitemap, or noindex it if it should not be found.',
    source: `${CRAWL} — "every indexable self-canonical page is … listed in a sitemap"`,
  },

  /* sitemap and robots */
  {
    id: 'robots-txt', category: 'sitemap', severity: 'fix', label: 'robots.txt problem',
    why: 'robots.txt must allow crawling and point at the production sitemap, or crawlers cannot find the site’s pages.',
    fix: 'Check main-website/app/robots.ts and that the production deployment serves it.',
    source: 'main-website/lib/seo/smoke.ts — checkRobotsTxt',
  },
  {
    id: 'sitemap-index', category: 'sitemap', severity: 'fix', label: 'Sitemap index problem',
    why: '/sitemap.xml must be an index of the per-type sitemaps on the production origin.',
    fix: 'Check main-website/app/sitemap.xml and that it is reachable.',
    source: 'main-website/lib/seo/smoke.ts — checkSitemapIndex',
  },
  {
    id: 'sitemap-urlset', category: 'sitemap', severity: 'fix', label: 'Sitemap entry problem',
    why: 'Every <loc> in a sitemap must be a valid canonical URL on the production origin.',
    fix: 'Check the sitemap route that produced the entry.',
    source: 'main-website/lib/seo/smoke.ts — checkUrlset',
  },
  {
    id: 'sitemap-hygiene', category: 'sitemap', severity: 'review', label: 'Sitemap hygiene',
    why: 'No <priority> or <changefreq>, no malformed or future <lastmod>, and no URL listed twice. Out-of-date dates make the sitemap look stale.',
    fix: 'Check the sitemap route that produced the entry.',
    source: 'main-website/lib/seo/smoke.ts — checkSitemapHygiene',
  },

  /* links */
  {
    id: 'broken-internal-link', category: 'links', severity: 'fix', label: 'Broken internal link',
    why: 'Pages on the site link to a URL that answers with an error.',
    fix: 'Change or remove the link on each page that has it, or restore the target page.',
    source: `${CRAWL} — "no internal link … points at a missing page" (intent.auditLinks)`,
  },
  {
    id: 'redirected-internal-link', category: 'links', severity: 'review', label: 'Internal link goes through a redirect',
    why: 'Links should point at the final URL; every redirect is an extra round trip.',
    fix: 'Update the link to the redirect’s destination.',
    source: `${CRAWL} — "no internal link goes through a redirect" (intent.auditLinks)`,
  },
  {
    id: 'non-canonical-link', category: 'links', severity: 'review', label: 'Link to a non-canonical URL',
    why: 'The link points at a URL whose canonical is a different URL, splitting signals between two addresses.',
    fix: 'Link to the canonical URL instead.',
    source: 'main-website/lib/seo/intent.ts — auditLinks (nonCanonical)',
  },
  {
    id: 'broken-image', category: 'links', severity: 'fix', label: 'Broken image',
    why: 'An image on the page answers with an error, so it does not show.',
    fix: 'Re-upload the image or change the record that uses it.',
    source: 'Image status check over the images the site’s pages use (same status rule as links)',
  },
  {
    id: 'orphan-page', category: 'links', severity: 'review', label: 'Page with no internal links to it',
    why: 'No crawled page links here. Pages only reachable from the sitemap are harder to discover and get no internal context.',
    fix: 'Link to it from a related page, hub or category.',
    source: `${CRAWL} — "every indexable self-canonical page is linked internally" (intent.auditLinks)`,
  },
  {
    id: 'weakly-linked', category: 'links', severity: 'info', label: 'Only menu links point here',
    why: 'Pages link here only from navigation, footers or listings — no page links to it from its own content. Judged for pages the sitemaps list; a menu hub such as Contact is expected here.',
    fix: 'Add a contextual link from a related page where it helps the reader.',
    source: 'main-website/lib/seo/intent.ts — auditLinks (weak), over sitemap URLs as in linkgraph.live.test.ts',
  },
  {
    id: 'empty-anchor', category: 'links', severity: 'review', label: 'Link without an accessible name',
    why: 'A link with no text, label or image alt is announced as just "link" and gives crawlers no anchor text.',
    fix: 'Give the link visible text or an aria-label.',
    source: `${CRAWL} — "no link lacks an accessible name" (pageAudit.emptyAnchors)`,
  },

  /* on-page */
  {
    id: 'title-tag', category: 'on-page', severity: 'fix', label: 'Missing or repeated <title>',
    why: 'Each page needs exactly one non-empty title: it names the page in search results and browser tabs.',
    fix: 'Set the page’s SEO title in its editor; check the route’s metadata if the editor already has one.',
    source: `${CRAWL} — "every HTML page has exactly one non-empty <title> and meta description"`,
  },
  {
    id: 'meta-description-tag', category: 'on-page', severity: 'fix', label: 'Missing or repeated meta description',
    why: 'Each page needs exactly one meta description; without one, search results show an excerpt chosen for you.',
    fix: 'Set the page’s meta description in its editor.',
    source: `${CRAWL} — "every HTML page has exactly one non-empty <title> and meta description"`,
  },
  {
    id: 'h1', category: 'on-page', severity: 'fix', label: 'Not exactly one <h1>',
    why: 'A page should have one main heading that says what it is about.',
    fix: 'Make sure the template renders one <h1> and that content blocks do not add another.',
    source: `${CRAWL} — "every HTML page has exactly one non-empty <h1>"`,
  },
  {
    id: 'heading-outline', category: 'on-page', severity: 'review', label: 'Heading levels out of order',
    why: 'A skipped level (h2 → h4), a heading before the <h1> or an empty heading breaks the page outline readers and assistive technology use.',
    fix: 'Adjust the heading levels in the content or the template.',
    source: `${CRAWL} — "heading levels are not skipped and nothing precedes the <h1>"`,
  },
  {
    id: 'image-alt', category: 'on-page', severity: 'review', label: 'Images without alt text',
    why: 'An <img> with no alt attribute gives screen readers and crawlers nothing. alt="" is fine for decoration.',
    fix: 'Add alt text to each image in its editor, or alt="" if it is decorative.',
    source: `${CRAWL} — "every <img> has an alt attribute" (pageAudit.imageAlt)`,
  },

  /* structured data */
  {
    id: 'json-ld-invalid', category: 'structured-data', severity: 'fix', label: 'Structured data does not parse',
    why: 'A JSON-LD block that is not valid JSON is ignored entirely by every consumer.',
    fix: 'Check the component that renders the block; a stray character in CMS text is a common cause.',
    source: `${CRAWL} — "every JSON-LD block parses"`,
  },
  {
    id: 'faq-markup-mismatch', category: 'structured-data', severity: 'fix', label: 'FAQ markup not visible on the page',
    why: 'Every question and answer in FAQPage markup must also be visible on the page.',
    fix: 'Show the FAQ on the page or remove it from the markup; both come from the same FAQ list.',
    source: `${CRAWL} — "FAQPage markup only describes questions and answers visible on the page"`,
  },
  {
    id: 'breadcrumb-mismatch', category: 'structured-data', severity: 'review', label: 'Breadcrumbs disagree',
    why: 'The BreadcrumbList should end at the page’s own canonical URL, and the visible trail should match it.',
    fix: 'Check the page’s breadcrumb items in its template.',
    source: `${CRAWL} — the two breadcrumb assertions`,
  },

  /* content (not technical) */
  {
    id: 'claim-wording', category: 'content', severity: 'info', label: 'Claim wording to verify',
    why: 'Wording the site’s truth scan reports for a person to check: an outcome, a figure or a promise. Disclaimed uses are already excluded. This is a content review, not a technical error.',
    fix: 'Keep it if the business has evidence for it; otherwise reword it in the record’s editor.',
    source: 'main-website/lib/seo/pageAudit.ts — truthScan (lib/guardrails/claimPatterns.ts)',
  },
];

/*
  Editorial hints: the existing SEO checks (pageChecks.ts, kept equal to the
  site's copy rules), run over the text each page actually serves. Missing
  text is the on-page rules' job above; hidden and unpublished pages are
  states, not findings, in a crawl.
*/
const EDITORIAL_SKIP = new Set<CheckId>(['title-missing', 'description-missing', 'hidden-from-search', 'not-live']);

/** The audit rule for an SEO check, or null when the audit leaves that check to another rule. */
export function editorialRuleId(check: CheckId): string | null {
  return EDITORIAL_SKIP.has(check) ? null : `editorial:${check}`;
}

const EDITORIAL: AuditRule[] = CHECKS.filter((c) => !EDITORIAL_SKIP.has(c.id)).map((c) => ({
  id: `editorial:${c.id}`,
  category: 'editorial',
  severity: c.severity,
  label: c.label,
  why: `${c.why} An editorial hint, not a ranking rule.`,
  fix: c.field === 'title' ? 'Edit the SEO title in the page’s editor.' : 'Edit the meta description in the page’s editor.',
  source: 'backend/src/seo/pageChecks.ts (the SEO health checks, kept equal to main-website/lib/guardrails/copyRules.ts)',
}));

export const AUDIT_RULES: readonly AuditRule[] = [...FIXED, ...EDITORIAL];

const BY_ID = new Map(AUDIT_RULES.map((r) => [r.id, r]));

export function auditRule(id: string): AuditRule {
  const rule = BY_ID.get(id);
  if (!rule) throw new Error(`Unknown audit rule ${id}`);
  return rule;
}

export const isAuditRule = (id: string): boolean => BY_ID.has(id);

export const AUDIT_CATEGORIES: readonly AuditCategory[] = ['availability', 'indexing', 'sitemap', 'links', 'on-page', 'structured-data', 'editorial', 'content'];
export const AUDIT_SEVERITIES: readonly AuditSeverity[] = ['fix', 'review', 'info'];

/** Sort order: fix first. Stored with each issue, since the names do not sort that way. */
export const SEVERITY_RANK: Record<AuditSeverity, number> = { fix: 0, review: 1, info: 2 };
