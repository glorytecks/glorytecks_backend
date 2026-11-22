// ─────────────────────────────────────────────────────────────────────────────
// GENERATED COPY — do not edit here. Every declaration below is copied verbatim
// from main-website/lib/seo/pageAudit.ts (the site deploys separately, so the
// backend cannot import it). main-website/lib/seo/auditParity.test.ts fails if
// any of them differs from the site's, or if this file declares anything the
// site file does not. Change the site file, then copy the declaration across.
// ─────────────────────────────────────────────────────────────────────────────

import { CLAIM_DISCLAIMER, CLAIM_PATTERNS, DISCLAIMABLE } from './claimPatterns';

const ENTITY: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });

/** Markup a crawler never treats as page content. */
const stripInert = (html: string) =>
  html.replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[1] ?? m[2]) : undefined;
}

/* ── Headings ─────────────────────────────────────────────────────────────── */

export interface Heading {
  level: number;
  text: string;
}

/** Every h1–h6 in document order, with its text (an image's alt counts as text). */
export function headingsOf(html: string): Heading[] {
  const body = stripInert(html);
  return [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => {
    const alts = [...m[2].matchAll(/<img\b[^>]*>/gi)].map(([t]) => attr(t, 'alt') ?? '').join(' ');
    return { level: Number(m[1]), text: `${textOf(m[2])} ${alts}`.replace(/\s+/g, ' ').trim() };
  });
}

/**
 * Outline problems: not exactly one non-empty <h1>, a heading before the
 * <h1>, a level skipped on the way down (h2 → h4), or an empty heading.
 * Going back up any number of levels is fine — that is how sections end.
 */
export function headingIssues(headings: readonly Heading[]): string[] {
  const issues: string[] = [];
  const h1 = headings.filter((h) => h.level === 1);
  if (h1.length !== 1) issues.push(`${h1.length} <h1> elements`);
  else if (!h1[0].text) issues.push('empty <h1>');
  const firstH1 = headings.findIndex((h) => h.level === 1);
  if (firstH1 > 0) issues.push(`<h${headings[0].level}> "${headings[0].text.slice(0, 50)}" before the <h1>`);
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1];
    const cur = headings[i];
    if (cur.level > prev.level + 1) {
      issues.push(`skips h${prev.level} → h${cur.level} at "${cur.text.slice(0, 50)}"`);
    }
  }
  for (const h of headings) if (!h.text) issues.push(`empty <h${h.level}>`);
  return [...new Set(issues)];
}

/* ── Images ───────────────────────────────────────────────────────────────── */

export interface ImageAltAudit {
  total: number;
  /** <img> with no alt attribute at all — the one real failure. */
  missing: string[];
  /** alt="" — decorative, valid when the image says nothing the page does not. */
  decorative: number;
}

export function imageAlt(html: string): ImageAltAudit {
  const out: ImageAltAudit = { total: 0, missing: [], decorative: 0 };
  for (const [tag] of stripInert(html).matchAll(/<img\b[^>]*>/gi)) {
    out.total++;
    const alt = attr(tag, 'alt');
    if (alt === undefined) out.missing.push(attr(tag, 'src') ?? attr(tag, 'srcset')?.split(/\s/)[0] ?? '(no src)');
    else if (!alt.trim()) out.decorative++;
  }
  return out;
}

/* ── Anchors ──────────────────────────────────────────────────────────────── */

/**
 * Links with no accessible name: no text, no aria-label / aria-labelledby /
 * title, no non-empty image alt and no <svg><title>. A screen reader announces
 * them as "link" and a crawler gets no anchor text.
 */
export function emptyAnchors(html: string): string[] {
  const out: string[] = [];
  for (const m of stripInert(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const open = `<a ${m[1]}>`;
    if (attr(open, 'href') === undefined) continue;
    if (textOf(m[2])) continue;
    if ((attr(open, 'aria-label') ?? '').trim() || attr(open, 'aria-labelledby') || (attr(open, 'title') ?? '').trim()) continue;
    if ([...m[2].matchAll(/<img\b[^>]*>/gi)].some(([t]) => (attr(t, 'alt') ?? '').trim())) continue;
    if (/<title\b[^>]*>\s*\S/i.test(m[2]) || /\baria-label="[^"]+"/i.test(m[2])) continue;
    out.push(attr(open, 'href')!);
  }
  return out;
}

/* ── Indexing signals ─────────────────────────────────────────────────────── */

export interface RobotsState {
  index: boolean;
  follow: boolean;
}

/** Combine the robots meta and X-Robots-Tag: either one saying noindex/nofollow wins. */
export function robotsState(metaRobots: readonly string[] | undefined, xRobotsTag: string | null | undefined): RobotsState {
  const all = [...(metaRobots ?? []), xRobotsTag ?? ''].join(',').toLowerCase();
  return {
    index: !/\b(noindex|none)\b/.test(all),
    follow: !/\b(nofollow|none)\b/.test(all),
  };
}

/** A 200 that is really a "not found" page. */
export function isSoft404(status: number, title: string | undefined, h1: readonly string[]): boolean {
  if (status !== 200) return false;
  const t = `${title ?? ''} ${h1.join(' ')}`;
  return /\b(404|not found|page (?:does not|doesn['’]t) exist|no longer available)\b/i.test(t);
}

/* ── Redirects and external links ─────────────────────────────────────────── */

export interface Hop {
  url: string;
  status: number;
  location: string | null;
}

export interface Followed {
  hops: Hop[];
  final: { url: string; status: number };
  loop: boolean;
}

/**
 * Follow redirects one hop at a time with `fetchOnce` (which must not follow
 * them itself), up to `max` hops, noticing loops.
 */
export async function followRedirects(
  start: string,
  fetchOnce: (url: string) => Promise<{ status: number; location: string | null }>,
  max = 10,
): Promise<Followed> {
  const hops: Hop[] = [];
  const seen = new Set<string>();
  let url = start;
  for (let i = 0; i <= max; i++) {
    const r = await fetchOnce(url);
    if (r.status >= 300 && r.status < 400 && r.location) {
      hops.push({ url, status: r.status, location: r.location });
      const next = new URL(r.location, url).href;
      if (seen.has(next) || next === url) return { hops, final: { url: next, status: r.status }, loop: true };
      seen.add(url);
      url = next;
      continue;
    }
    return { hops, final: { url, status: r.status }, loop: false };
  }
  return { hops, final: { url, status: 0 }, loop: true };
}

/* ── Structured data against the visible page ─────────────────────────────── */

type Node = Record<string, unknown>;

/** Text a reader sees: no scripts, styles, templates or comments; entities decoded. */
export function visibleText(html: string): string {
  return textOf(stripInert(html));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

export interface FaqParity {
  /** Questions in the FAQPage markup. */
  questions: number;
  /** Markup questions or answers a reader cannot see on the page. */
  missing: string[];
}

/**
 * Every question and answer an FAQPage node declares must be visible on the
 * page — Google's rule for FAQ markup, and the A8 rule that one array feeds
 * both. Visible FAQs without markup are allowed.
 */
export function faqParity(nodes: readonly Node[], html: string): FaqParity {
  // Whitespace is ignored: tags become spaces when the page is read as text,
  // so "(<a>link</a>)" reads "( link )" while the markup says "(link)".
  const squash = (t: string) => norm(t).replace(/\s+/g, '');
  const text = squash(visibleText(html));
  const out: FaqParity = { questions: 0, missing: [] };
  for (const node of nodes) {
    const types = ([] as unknown[]).concat(node['@type']).map(String);
    if (!types.includes('FAQPage')) continue;
    for (const q of ([] as Node[]).concat((node.mainEntity as Node[]) ?? [])) {
      out.questions++;
      const name = String(q.name ?? '');
      const answer = String((q.acceptedAnswer as Node | undefined)?.text ?? '');
      if (!text.includes(squash(name))) out.missing.push(`question: ${name.slice(0, 80)}`);
      else if (!text.includes(squash(answer))) out.missing.push(`answer to: ${name.slice(0, 80)}`);
    }
  }
  return out;
}

/** The URL a BreadcrumbList ends at, or null when the page has none. */
export function breadcrumbEnd(nodes: readonly Node[]): string | null {
  const crumb = nodes.find((n) => ([] as unknown[]).concat(n['@type']).map(String).includes('BreadcrumbList'));
  if (!crumb) return null;
  const items = (crumb.itemListElement as { item?: unknown }[] | undefined) ?? [];
  const last = items.at(-1)?.item;
  return typeof last === 'string' ? last : ((last as { '@id'?: string } | undefined)?.['@id'] ?? '');
}

export type ClaimZone = 'header' | 'main' | 'footer' | 'other' | 'json-ld' | 'meta';

export interface ClaimHit {
  pattern: string;
  zone: ClaimZone;
  context: string;
  /** "guarantee" inside an explicit "not a guarantee" disclaimer. */
  disclaimer: boolean;
}

/** Every claim-pattern hit on a page, by zone, with ±60 characters of context. */
export function truthScan(html: string): ClaimHit[] {
  const hits: ClaimHit[] = [];
  const scan = (text: string, zone: ClaimZone) => {
    for (const [pattern, re] of CLAIM_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const context = text.slice(Math.max(0, m.index! - 60), m.index! + m[0].length + 60).replace(/\s+/g, ' ').trim();
        hits.push({ pattern, zone, context, disclaimer: DISCLAIMABLE.has(pattern) && CLAIM_DISCLAIMER.test(context) });
      }
    }
  };

  // Structured data and metadata, then the page body by landmark.
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    // Parsed, so escapes such as \u0026 read as the characters a crawler sees.
    const strings: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    try {
      collect(JSON.parse(m[1]));
    } catch {
      strings.push(m[1]);
    }
    scan(strings.join(' \u2016 '), 'json-ld');
  }
  const meta = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1]);
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/\b(name|property)=["'](description|og:title|og:description|twitter:title|twitter:description)["']/i.test(tag)) meta.push(attr(tag, 'content') ?? '');
  }
  scan(decode(meta.join(' \u2016 ')), 'meta');

  const body = stripInert(html.replace(/<head\b[\s\S]*?<\/head>/i, ' '));
  const spans: [ClaimZone, RegExp][] = [
    ['header', /<header\b[\s\S]*?<\/header>/gi],
    ['footer', /<footer\b[\s\S]*?<\/footer>/gi],
    ['main', /<main\b[\s\S]*?<\/main>/gi],
  ];
  let rest = body;
  for (const [zone, re] of spans) {
    for (const m of body.matchAll(re)) {
      // A <header> inside <main> (an article header) belongs to main.
      if (zone === 'header' && /<main\b/i.test(body.slice(0, m.index!)) && !/<\/main>/i.test(body.slice(0, m.index!))) continue;
      scan(textOf(m[0]), zone);
      rest = rest.replace(m[0], ' ');
    }
  }
  scan(textOf(rest), 'other');
  return hits;
}

/** Names in the first visible breadcrumb trail (<nav aria-label="Breadcrumb">), or null without one. */
export function visibleBreadcrumb(html: string): string[] | null {
  const nav = /<nav\b[^>]*aria-label=["']breadcrumb["'][^>]*>([\s\S]*?)<\/nav>/i.exec(stripInert(html));
  if (!nav) return null;
  const items = [...nav[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => textOf(m[1])).filter(Boolean);
  if (items.length) return items;
  // A trail written as links and spans (no list): every link or span that is
  // not a hidden separator is one crumb.
  return [...nav[1].matchAll(/<(a|span)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    .filter((m) => !/aria-hidden=["']true["']/i.test(m[2]))
    .map((m) => textOf(m[3]))
    .filter(Boolean);
}

/**
 * A visible trail matches its BreadcrumbList when the names are equal, or when
 * the page leaves "Home" implicit and the rest are equal.
 */
export function breadcrumbsMatch(visible: readonly string[], schema: readonly string[]): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return same(visible, schema) || (schema[0] === 'Home' && visible[0] !== 'Home' && same(visible, schema.slice(1)));
}

/** Names in the BreadcrumbList, in order. */
export function breadcrumbNames(nodes: readonly Node[]): string[] {
  const crumb = nodes.find((n) => ([] as unknown[]).concat(n['@type']).map(String).includes('BreadcrumbList'));
  return ((crumb?.itemListElement as { name?: unknown }[] | undefined) ?? []).map((i) => String(i.name ?? ''));
}
