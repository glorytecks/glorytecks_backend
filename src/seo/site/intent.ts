// ─────────────────────────────────────────────────────────────────────────────
// GENERATED COPY — do not edit here. Every declaration below is copied verbatim
// from main-website/lib/seo/intent.ts (the site deploys separately, so the
// backend cannot import it). main-website/lib/seo/auditParity.test.ts fails if
// any of them differs from the site's, or if this file declares anything the
// site file does not. Change the site file, then copy the declaration across.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Search-intent ownership, cannibalisation detection and the internal-link graph.
//
// docs/SEO_KEYWORD_MAP.md is the intent contract: one page, one primary intent.
// This module turns that contract into something a machine can check across
// every indexable URL — including the ~600 CMS articles the registry cannot
// list by hand.
//
// It compares SEARCH INTENT, not keyword frequency. Two pages collide when
// they would answer the same query for the same reason: the same comparison,
// the same interview topic, the same commercial offer in the same place. Two
// "X interview questions for data engineers" articles about different X do
// not collide, however many words their titles share.
//
// Pure: page records and link edges in, findings out. Used by intent.test.ts
// (offline), linkgraph.live.test.ts (a crawl of a deployed site) and the
// Phase 3 reports.
// ─────────────────────────────────────────────────────────────────────────────

/* ── Page model ───────────────────────────────────────────────────────────── */

export type PageType =
  | 'home'
  | 'course-hub'
  | 'course'
  | 'location'
  | 'landing'
  | 'blog-hub'
  | 'category'
  | 'article'
  | 'compare-hub'
  | 'comparison'
  | 'resource-hub'
  | 'resource'
  | 'static';

/** Page type from the canonical path and the sitemap child that lists it. */
export function pageTypeOf(path: string, sitemapChild?: string | null): PageType {
  const p = path.split('?')[0];
  if (p === '/') return 'home';
  if (p === '/courses') return 'course-hub';
  if (p.startsWith('/courses/')) return 'course';
  if (p === '/training-in-hyderabad') return 'location';
  if (p === '/blog') return 'blog-hub';
  if (p.startsWith('/blog/category/')) return 'category';
  if (p.startsWith('/blog/')) return 'article';
  if (p === '/compare') return 'compare-hub';
  if (p.startsWith('/compare/')) return 'comparison';
  if (p === '/resources') return 'resource-hub';
  if (p.startsWith('/resources/')) return 'resource';
  if (sitemapChild === 'locations' || /-course-[a-z-]+$/.test(p)) return 'landing';
  return 'static';
}

/* ── Internal-link graph ──────────────────────────────────────────────────── */

export type LinkZone = 'header' | 'main' | 'footer' | 'outside';

export interface LinkEdge {
  from: string;
  /** Site path (+ query), no fragment. */
  to: string;
  zone: LinkZone;
  /** Inside a <nav> (breadcrumbs, menus, pagination). */
  nav: boolean;
  anchor: string;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

const textOf = (html: string) =>
  decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Every internal <a href> in a server response, with the page zone it sits in
 * and its anchor text. `hosts` are the hostnames that count as this site.
 */
export function extractLinks(html: string, from: string, hosts: readonly string[]): LinkEdge[] {
  const spans = (tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'))].map((m) => [m.index!, m.index! + m[0].length]);
  const header = spans('header');
  const footer = spans('footer');
  const nav = spans('nav');
  const within = (s: number[][], i: number) => s.some(([a, b]) => i >= a && i < b);
  const mainStart = html.search(/<main\b/i);
  const mainEnd = html.search(/<\/main>/i);

  const out: LinkEdge[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref="([^"]*)"/)?.[1];
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href), `https://${hosts[0]}${from}`);
    } catch {
      continue;
    }
    if (!hosts.includes(url.host)) continue;
    if (/^\/(_next|api)\//.test(url.pathname) || /\.(png|jpe?g|svg|webp|ico|pdf|xml|txt|css|js)$/i.test(url.pathname)) continue;
    const i = m.index!;
    const zone: LinkZone = within(header, i) ? 'header' : within(footer, i) ? 'footer' : i > mainStart && i < mainEnd ? 'main' : 'outside';
    const aria = m[1].match(/\baria-label="([^"]*)"/)?.[1];
    out.push({ from, to: url.pathname + url.search, zone, nav: within(nav, i), anchor: textOf(m[2]) || (aria ? decodeEntities(aria) : '') });
  }
  return out;
}

export interface CrawledPage {
  path: string;
  status: number;
  canonical?: string | null;
  links: LinkEdge[];
}

/** /blog, /blog?page=N, /blog/category/x and its pages — listing pages, not editorial. */
export const isArchivePath = (path: string) => /^\/blog(\/category\/[^/?]+)?(\?page=\d+)?$/.test(path);

const isPrevNext = (anchor: string) => /^(previous|next)\b/i.test(anchor.trim());

export interface InboundStats {
  /** Distinct pages linking here from anywhere (menus included). */
  total: number;
  /** Distinct pages linking here from their main content, outside any <nav>. */
  contextual: number;
  /**
   * Contextual links from non-listing pages, excluding prev/next — the links an
   * editor or a relatedness rule chose. The measure of real internal support.
   */
  editorial: number;
}

export function inboundStats(pages: readonly CrawledPage[]): Map<string, InboundStats> {
  const sets = new Map<string, { total: Set<string>; contextual: Set<string>; editorial: Set<string> }>();
  for (const page of pages) {
    for (const l of page.links) {
      if (l.to === page.path) continue;
      const s = sets.get(l.to) ?? { total: new Set(), contextual: new Set(), editorial: new Set() };
      sets.set(l.to, s);
      s.total.add(page.path);
      if (l.zone === 'main' && !l.nav) {
        s.contextual.add(page.path);
        if (!isArchivePath(page.path) && !isPrevNext(l.anchor)) s.editorial.add(page.path);
      }
    }
  }
  return new Map([...sets].map(([k, v]) => [k, { total: v.total.size, contextual: v.contextual.size, editorial: v.editorial.size }]));
}

const GENERIC_ANCHOR = /^(read more|learn more|click here|here|more|view|view details|details|know more|explore|explore course|see more|view all|read|go|open|continue)$/i;

export interface LinkAudit {
  orphans: string[];
  /** Indexable pages with no editorial inbound link at all. */
  weak: string[];
  broken: { from: string; to: string; status: number }[];
  redirected: { from: string; to: string; status: number }[];
  /** Links to a 200 page whose canonical is a different URL. */
  nonCanonical: { from: string; to: string; canonical: string }[];
  genericAnchors: { anchor: string; to: string; links: number }[];
}

/**
 * Audit the graph.
 *
 * `statusOf` answers for targets that were not crawled (filters, utilities).
 * `origin` turns a path into the canonical URL it should declare.
 */
export function auditLinks(
  pages: readonly CrawledPage[],
  indexable: readonly string[],
  origin: string,
  statusOf: (path: string) => number | undefined = () => undefined,
): LinkAudit {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const stats = inboundStats(pages);
  const selfUrl = (p: string) => (p === '/' ? origin : `${origin}${p}`);

  const broken: LinkAudit['broken'] = [];
  const redirected: LinkAudit['redirected'] = [];
  const nonCanonical: LinkAudit['nonCanonical'] = [];
  const anchors = new Map<string, number>();
  const seen = new Set<string>();

  for (const page of pages) {
    for (const l of page.links) {
      const target = byPath.get(l.to);
      const status = target?.status ?? statusOf(l.to);
      const key = `${page.path}→${l.to}`;
      if (status !== undefined && !seen.has(key)) {
        seen.add(key);
        if (status >= 400) broken.push({ from: page.path, to: l.to, status });
        else if (status >= 300) redirected.push({ from: page.path, to: l.to, status });
        else if (target?.canonical && target.canonical !== selfUrl(l.to)) {
          nonCanonical.push({ from: page.path, to: l.to, canonical: target.canonical });
        }
      }
      if (GENERIC_ANCHOR.test(l.anchor.trim())) {
        const k = `${l.anchor.trim().toLowerCase()}\u0000${l.to}`;
        anchors.set(k, (anchors.get(k) ?? 0) + 1);
      }
    }
  }

  return {
    orphans: indexable.filter((p) => p !== '/' && (stats.get(p)?.total ?? 0) === 0),
    weak: indexable.filter((p) => p !== '/' && (stats.get(p)?.editorial ?? 0) === 0),
    broken,
    redirected,
    nonCanonical,
    genericAnchors: [...anchors].map(([k, links]) => {
      const [anchor, to] = k.split('\u0000');
      return { anchor, to, links };
    }),
  };
}
