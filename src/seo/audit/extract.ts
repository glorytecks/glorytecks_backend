import { checkSitemapUrl, extractSeo } from '../site/smoke';
import {
  breadcrumbEnd,
  breadcrumbNames,
  emptyAnchors,
  faqParity,
  headingIssues,
  headingsOf,
  imageAlt,
  isSoft404,
  robotsState,
  truthScan,
  visibleBreadcrumb,
} from '../site/pageAudit';
import { extractLinks, type LinkZone } from '../site/intent';

/**
 * One crawled page, read the way the site's full crawl reads it
 * (main-website/lib/seo/sitecrawl.live.test.ts → crawlOne): every field below
 * is produced by the site's own functions, copied into ../site. Only what the
 * analysis and the evidence need is kept, with long lists cut short.
 *
 * One deliberate difference: on a *.vercel.app deployment every response
 * carries X-Robots-Tag: noindex by design (next.config.mjs), so there the
 * header does not decide whether a page is indexable — the robots meta does,
 * as in the site's own sitemap check (smoke.ts → checkSitemapUrl). Whether the
 * header is right for the host is checked separately, by that same function.
 */

export interface PageRecord {
  contentType: string;
  /** The body was cut at the size limit; everything below describes the part read. */
  truncated: boolean;
  title: string;
  titleCount: number;
  description: string;
  descriptionCount: number;
  canonical: string;
  canonicalCount: number;
  /** Up to three canonicals, as found. */
  canonicals: string[];
  robotsMeta: string;
  xRobotsTag: string;
  index: boolean;
  follow: boolean;
  h1Count: number;
  h1: string;
  outline: string;
  headingProblems: string[];
  emptyAnchors: string[];
  images: number;
  imagesMissingAlt: string[];
  jsonLd: 'none' | 'ok' | 'error';
  jsonLdErrors: string[];
  jsonLdTypes: string[];
  soft404: boolean;
  faqQuestions: number;
  faqMissing: string[];
  breadcrumbEnd: string | null;
  breadcrumbSchemaNames: string[];
  breadcrumbVisible: string[] | null;
  /** Claim-wording hits a person should check (disclaimed uses excluded). */
  claims: { pattern: string; zone: string; context: string }[];
  /** smoke.ts → checkSitemapUrl failures, for a URL a sitemap lists; null otherwise. */
  sitemapFailures: string[] | null;
}

/** An internal link as stored: LinkEdge without the redundant `from`. */
export interface StoredLink {
  to: string;
  zone: LinkZone;
  nav: boolean;
  anchor: string;
}

const LIST_CAP = 20;
const cap = <T>(list: readonly T[], n = LIST_CAP): T[] => list.slice(0, n);
const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A tag attribute, entities decoded (the same reading the site's helpers use). */
function attrOf(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  if (!m) return undefined;
  return (m[1] ?? m[2]).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}

/**
 * The images a page shows, as absolute URLs to check. A Next.js optimised
 * image (/_next/image?url=…) is checked at its source, so the audit never
 * asks the site to transform an image.
 */
export function imageSources(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attrOf(tag, 'src') ?? attrOf(tag, 'srcset')?.trim().split(/\s/)[0];
    if (!src || /^(data|blob):/i.test(src)) continue;
    let url: URL;
    try {
      url = new URL(src, pageUrl);
    } catch {
      continue;
    }
    if (url.pathname === '/_next/image') {
      const inner = url.searchParams.get('url');
      if (!inner) continue;
      try {
        url = new URL(inner, pageUrl);
      } catch {
        continue;
      }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    url.hash = '';
    out.add(url.href);
  }
  return [...out];
}

export interface ReadInput {
  /** Site path (+ query) the page was requested at. */
  path: string;
  /** Absolute URL it was fetched from. */
  url: string;
  html: string;
  contentType: string;
  truncated: boolean;
  xRobotsTag: string | null;
  /** The origin is a *.vercel.app deployment. */
  hostNoindex: boolean;
  linkHosts: readonly string[];
  /** The <loc> a sitemap lists this page under, if any. */
  sitemapLoc: string | null;
  /** First response status (checkSitemapUrl wants it unredirected). */
  status: number;
}

export interface ReadPage {
  record: PageRecord;
  links: StoredLink[];
  images: string[];
}

export function readPage(input: ReadInput): ReadPage {
  const { html } = input;
  const seo = extractSeo(html);
  const robots = seo.meta.get('robots') ?? [];
  const state = robotsState(robots, input.hostNoindex ? null : input.xRobotsTag);
  const outline = headingsOf(html);
  const alt = imageAlt(html);
  const h1s = outline.filter((h) => h.level === 1);
  const title = seo.titles[0] ?? '';
  const parity = faqParity(seo.nodes, html);

  const record: PageRecord = {
    contentType: input.contentType,
    truncated: input.truncated,
    title: short(title, 300),
    titleCount: seo.titles.length,
    description: short(seo.meta.get('description')?.[0] ?? '', 400),
    descriptionCount: seo.meta.get('description')?.length ?? 0,
    canonical: seo.canonicals[0] ?? '',
    canonicalCount: seo.canonicals.length,
    canonicals: cap(seo.canonicals, 3),
    robotsMeta: robots.join(' | '),
    xRobotsTag: input.xRobotsTag ?? '',
    index: state.index,
    follow: state.follow,
    h1Count: h1s.length,
    h1: short(h1s[0]?.text ?? '', 200),
    outline: short(outline.map((h) => `h${h.level}`).join(' '), 300),
    headingProblems: cap(headingIssues(outline)),
    emptyAnchors: cap(emptyAnchors(html)),
    images: alt.total,
    imagesMissingAlt: cap(alt.missing),
    jsonLd: seo.jsonLdErrors.length ? 'error' : seo.nodes.length ? 'ok' : 'none',
    jsonLdErrors: cap(seo.jsonLdErrors, 3).map((e) => short(e)),
    jsonLdTypes: cap([...new Set(seo.nodes.flatMap((n) => ([] as unknown[]).concat(n['@type']).map(String)))]),
    soft404: isSoft404(200, title, h1s.map((h) => h.text)),
    faqQuestions: parity.questions,
    faqMissing: cap(parity.missing, 10),
    breadcrumbEnd: breadcrumbEnd(seo.nodes),
    breadcrumbSchemaNames: cap(breadcrumbNames(seo.nodes)),
    breadcrumbVisible: visibleBreadcrumb(html),
    claims: cap(
      truthScan(html)
        .filter((c) => !c.disclaimer)
        .map((c) => ({ pattern: c.pattern, zone: c.zone, context: short(c.context, 160) })),
    ),
    sitemapFailures: input.sitemapLoc
      ? checkSitemapUrl(input.sitemapLoc, { status: input.status, html, xRobotsTag: input.xRobotsTag }, { hostNoindex: input.hostNoindex })
      : null,
  };

  // Identical edges (same target, zone, nav and text) say nothing more about
  // the graph; anything that differs is kept, so inboundStats reads the same.
  const seen = new Set<string>();
  const links: StoredLink[] = [];
  for (const l of extractLinks(html, input.path, input.linkHosts)) {
    const anchor = short(l.anchor, 80);
    const key = `${l.to}\u0000${l.zone}\u0000${l.nav}\u0000${anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ to: l.to, zone: l.zone, nav: l.nav, anchor });
  }

  return { record, links, images: cap(imageSources(html, input.url), 100) };
}
