// ─────────────────────────────────────────────────────────────────────────────
// GENERATED COPY — do not edit here. Every declaration below is copied verbatim
// from main-website/lib/seo/smoke.ts (the site deploys separately, so the
// backend cannot import it). main-website/lib/seo/auditParity.test.ts fails if
// any of them differs from the site's, or if this file declares anything the
// site file does not. Change the site file, then copy the declaration across.
// ─────────────────────────────────────────────────────────────────────────────

import { isValidCanonical } from './canonical';

/* ── HTML extraction ──────────────────────────────────────────────────────── */

type SchemaNode = Record<string, unknown>;

export interface ExtractedSeo {
  titles: string[];
  /** Every <meta name|property=…> value, keyed by lower-cased name. */
  meta: Map<string, string[]>;
  canonicals: string[];
  h1: string[];
  nodes: SchemaNode[];
  jsonLdErrors: string[];
  internalLinks: string[];
  /**
   * False when <title> sits in <body>. Next streams metadata there on dynamic
   * routes for user agents it does not treat as HTML-limited — Googlebot
   * included. Google reads it after rendering, so this is a warning, not a
   * failure; see the parity report for the trade-off.
   */
  metadataInHead: boolean;
  /** Which build produced the page. */
  framework: 'next' | 'legacy-spa' | 'unknown';
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[1] ?? m[2]) : undefined;
}

const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function flattenGraph(value: unknown, out: SchemaNode[]) {
  if (Array.isArray(value)) {
    for (const v of value) flattenGraph(v, out);
  } else if (value && typeof value === 'object') {
    const node = value as SchemaNode;
    if (node['@graph']) flattenGraph(node['@graph'], out);
    if (node['@type']) out.push(node);
  }
}

/**
 * Read the SEO surface of a server response the way a non-rendering crawler
 * does: from the raw HTML, without executing JavaScript. The whole document is
 * searched, so streamed metadata is still found — `metadataInHead` records
 * where it was.
 */
export function extractSeo(html: string): ExtractedSeo {
  const meta = new Map<string, string[]>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, 'name') ?? attr(tag, 'property'))?.toLowerCase();
    const content = attr(tag, 'content');
    if (!key || content === undefined) continue;
    meta.set(key, [...(meta.get(key) ?? []), content]);
  }

  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => text(m[1]));
  const canonicals = [...html.matchAll(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi)]
    .map(([tag]) => attr(tag, 'href'))
    .filter((href): href is string => href !== undefined);
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => text(m[1]));

  const nodes: SchemaNode[] = [];
  const jsonLdErrors: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      flattenGraph(JSON.parse(m[1]), nodes);
    } catch (e) {
      jsonLdErrors.push(String(e));
    }
  }

  const internalLinks = [
    ...new Set(
      [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)]
        .map((m) => decode(m[1]))
        .filter((href) => href.startsWith('/') && !href.startsWith('//')),
    ),
  ];

  const titleAt = html.search(/<title\b/i);
  const headEnd = html.search(/<\/head>/i);

  return {
    titles,
    meta,
    canonicals,
    h1,
    nodes,
    jsonLdErrors,
    internalLinks,
    metadataInHead: titleAt !== -1 && (headEnd === -1 || titleAt < headEnd),
    framework: /\/_next\/static\//.test(html)
      ? 'next'
      : /<script\b[^>]*type=["']module["'][^>]*src=["']\/assets\/index-/i.test(html)
        ? 'legacy-spa'
        : 'unknown',
  };
}

export interface FetchedPage {
  status: number;
  /** Site-relative path of the final response, after any redirects. */
  finalPath: string;
  html: string;
  /** The X-Robots-Tag response header, when there is one. */
  xRobotsTag?: string | null;
}

export interface CheckOptions {
  /**
   * True when the page was fetched from a *.vercel.app host. Those must carry
   * `X-Robots-Tag: noindex` (next.config.mjs); every other host must not.
   */
  hostNoindex?: boolean;
}

/** True for a Vercel deployment or alias hostname. */
export const isVercelAppHost = (base: string) => /\.vercel\.app$/i.test(new URL(base).hostname);

function checkRobotsHeader(xRobotsTag: string | null | undefined, hostNoindex: boolean, failures: string[]) {
  const noindex = /noindex/i.test(xRobotsTag ?? '');
  if (hostNoindex && !noindex) failures.push('*.vercel.app response without X-Robots-Tag: noindex');
  if (!hostNoindex && noindex) failures.push(`X-Robots-Tag "${xRobotsTag}" on the production host`);
}

/** robots.txt must invite crawling and point at this origin's sitemap. */
export function checkRobotsTxt(body: string, origin: string): string[] {
  const failures: string[] = [];
  if (/^\s*disallow:\s*\/\s*$/im.test(body)) {
    failures.push('robots.txt disallows the whole site — this is not an indexable production build');
  }
  const sitemaps = [...body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!sitemaps.includes(`${origin}/sitemap.xml`)) {
    failures.push(`robots.txt does not list ${origin}/sitemap.xml (found: ${sitemaps.join(', ') || 'none'})`);
  }
  return failures;
}

export const sitemapLocs = (xml: string) =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decode(m[1]));

/** /sitemap.xml must be the index of per-type child sitemaps on this origin. */
export function checkSitemapIndex(xml: string, origin: string): string[] {
  if (!/<sitemapindex\b/.test(xml)) return ['/sitemap.xml is not a <sitemapindex>'];
  const locs = sitemapLocs(xml);
  if (locs.length === 0) return ['/sitemap.xml lists no child sitemaps'];
  return locs
    .filter((loc) => !loc.startsWith(`${origin}/sitemaps/`))
    .map((loc) => `sitemap index entry ${loc} is not under ${origin}/sitemaps/`);
}

/** Every <loc> in a child sitemap must be a valid canonical on this origin. */
export function checkUrlset(xml: string, origin: string): string[] {
  if (!/<urlset\b/.test(xml)) return ['not a <urlset>'];
  return sitemapLocs(xml)
    .filter((loc) => !isValidCanonical(loc, origin))
    .map((loc) => `${loc} is not a valid canonical on ${origin}`);
}

/**
 * Sitemap-set hygiene: no <priority>/<changefreq>, no malformed or future
 * <lastmod>, and no URL listed twice anywhere in the set.
 *
 * `today` is passed in (YYYY-MM-DD) so this stays pure.
 */
export function checkSitemapHygiene(children: readonly { path: string; xml: string }[], today: string): string[] {
  const failures: string[] = [];
  const seen = new Map<string, string>();
  for (const { path, xml } of children) {
    if (/<priority>|<changefreq>/.test(xml)) failures.push(`${path} carries <priority> or <changefreq>`);
    for (const [, lastmod] of xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) failures.push(`${path}: malformed <lastmod> ${lastmod}`);
      else if (lastmod > today) failures.push(`${path}: <lastmod> ${lastmod} is in the future`);
    }
    for (const loc of sitemapLocs(xml)) {
      const first = seen.get(loc);
      if (first) failures.push(`${loc} is listed in ${first} and ${path}`);
      else seen.set(loc, path);
    }
  }
  return failures;
}

/**
 * One sitemap URL as served: 200 with no redirect, exactly one canonical equal
 * to its own <loc>, and indexable.
 */
export function checkSitemapUrl(
  loc: string,
  fetched: Omit<FetchedPage, 'finalPath'>,
  { hostNoindex = false }: CheckOptions = {},
): string[] {
  const failures: string[] = [];
  if (fetched.status !== 200) return [`HTTP ${fetched.status}`];
  const seo = extractSeo(fetched.html);
  if (seo.canonicals.length !== 1) failures.push(`${seo.canonicals.length} canonicals`);
  else if (seo.canonicals[0] !== loc) failures.push(`canonical ${seo.canonicals[0]}`);
  const robots = seo.meta.get('robots')?.[0] ?? '';
  if (!/\bindex\b/.test(robots) || /noindex/.test(robots)) failures.push(`robots "${robots}"`);
  checkRobotsHeader(fetched.xRobotsTag, hostNoindex, failures);
  return failures;
}
