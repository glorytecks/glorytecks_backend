import { createHash } from 'node:crypto';
import { canonicalUrlFor, PRODUCTION_ORIGIN } from '../site/canonical';
import { checkSitemapUrl } from '../site/smoke';
import { auditLinks, inboundStats, pageTypeOf, type CrawledPage } from '../site/intent';
import { breadcrumbsMatch } from '../site/pageAudit';
import { crawlable, isArchiveSlice } from '../site/sitecrawl';
import { checkPages, type CheckPage, type TextSource } from '../pageChecks';
import { auditRule, editorialRuleId, isAuditRule, type AuditCategory, type AuditSeverity } from './rules';
import type { PageRecord, StoredLink } from './extract';

/**
 * Turn one run's crawl into findings. Pure: the rows go in, findings come out.
 *
 * The predicates are the site crawl's own (main-website/lib/seo/
 * sitecrawl.live.test.ts → findings()), applied to the same readings, plus
 * the site's link audit (intent.ts → auditLinks) and SEO checks
 * (pageChecks.ts → checkPages). Where the crawl reports a list, this reports
 * one finding per page — or, for a broken link or image, one per target with
 * the pages that use it — so each can be tracked and fixed on its own.
 */

export type RowKind = 'page' | 'link' | 'image';
export type RowState = 'pending' | 'done' | 'failed' | 'skipped';

export interface Hop {
  status: number;
  location: string | null;
}

/** One URL in a run: a page that was (or is to be) read, a link target, or an image. */
export interface AuditRow {
  kind: RowKind;
  /** Site path (+ query) for pages and links; the absolute URL for images. */
  path: string;
  state: RowState;
  /** Where the URL came from: registry, cms:course, sitemap:/sitemaps/blog.xml, link. */
  sources: string[];
  inSitemap: boolean;
  /** The <loc> a sitemap lists it under. */
  loc: string | null;
  /** Listed somewhere (registry, CMS, sitemap) as a page that should answer 200. */
  expectedLive: boolean;
  /** What the CMS intends: true = should be indexable / followed, false = deliberately not, null = unknown. */
  expectIndex: boolean | null;
  expectFollow: boolean | null;
  /** First response status. */
  status: number | null;
  /** Status after redirects within the approved hosts. */
  finalStatus: number | null;
  finalUrl: string | null;
  hops: Hop[];
  loop: boolean;
  /** Set when a redirect led to a host the audit may not follow. */
  offsite: string | null;
  error: string | null;
  skipReason: string | null;
  record: PageRecord | null;
  links: StoredLink[] | null;
  images: string[] | null;
}

export interface SiteFileCheck {
  /** The file was requested in this run and answered. */
  checked: boolean;
  failures: string[];
}

export interface SiteChecks {
  /** robots.txt as a search engine reads it: production only, null otherwise. */
  robots: SiteFileCheck | null;
  sitemapIndex: SiteFileCheck;
  children: ({ path: string } & SiteFileCheck)[];
  hygiene: SiteFileCheck;
}

export interface AnalysisInput {
  rows: readonly AuditRow[];
  site: SiteChecks;
  /** Nothing pending, failed, skipped or cut by the page budget, and every sitemap read. */
  coverageComplete: boolean;
  /** /sitemap.xml and every child sitemap were read. */
  sitemapsComplete: boolean;
  /** The origin is a *.vercel.app deployment. */
  hostNoindex: boolean;
  /** Where each Page SEO page's title and description come from. */
  textSources: ReadonlyMap<string, { title: TextSource; description: TextSource }>;
}

export interface AuditFinding {
  rule: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** The page, link target, image or file the finding is about. */
  path: string;
  /** A second key when one path can carry several findings of a rule. */
  target: string | null;
  pageType: string;
  detail: string;
  evidence: Record<string, unknown>;
  /** Pages involved (link sources, pages using an image, pages sharing a title). */
  affected: string[];
  affectedCount: number;
}

const AFFECTED_CAP = 50;
const EVIDENCE_LIST_CAP = 50;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Page type as the crawl assigns it; images and site files get their own. */
export function pageTypeFor(path: string): string {
  if (/^https?:\/\//i.test(path)) return 'image';
  if (path === '/robots.txt' || path === '/sitemap.xml' || path.startsWith('/sitemaps/')) return 'site-file';
  return pageTypeOf(path.split('?')[0], /^\/[a-z-]+-course-[a-z-]+$/.test(path) ? 'locations' : null);
}

/** The redirect status a link sees: the first hop's, else the final answer. */
export function linkStatus(row: Pick<AuditRow, 'hops' | 'finalStatus'>): number | undefined {
  if (row.hops.length) return row.hops[0].status;
  return row.finalStatus ?? undefined;
}

export function fingerprint(origin: string, rule: string, path: string, target: string | null): string {
  return createHash('sha256').update(`${origin}\n${rule}\n${path}\n${target ?? ''}`).digest('hex').slice(0, 40);
}

const hopList = (row: AuditRow) => row.hops.map((h) => `${h.status} → ${h.location ?? '(no Location)'}`);

export function analyze(input: AnalysisInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  const add = (
    rule: string,
    path: string,
    detail: string,
    evidence: Record<string, unknown> = {},
    affected: readonly string[] = [],
    target: string | null = null,
  ) => {
    const r = auditRule(rule);
    const list = [...new Set(affected)].sort();
    out.push({
      rule,
      category: r.category,
      severity: r.severity,
      path,
      target,
      pageType: pageTypeFor(path),
      detail: clip(detail, 480),
      evidence,
      affected: list.slice(0, AFFECTED_CAP),
      affectedCount: list.length,
    });
  };

  const pages = input.rows.filter((r) => r.kind === 'page');
  const answered = pages.filter((r) => r.state === 'done');
  const byPath = new Map(input.rows.filter((r) => r.kind !== 'image').map((r) => [r.path, r]));
  // sitecrawl → html200: answered 200 without a redirect, and read as HTML.
  const html = answered.filter((r) => r.status === 200 && r.hops.length === 0 && r.record);
  const selfCanonical = (p: string) => canonicalUrlFor(PRODUCTION_ORIGIN, p);

  /* ── Listed URLs that do not answer 200 directly (sitecrawl → notLive) ── */
  for (const row of answered) {
    if (!row.expectedLive || !crawlable(row.path)) continue;
    const ev = { status: row.status, finalStatus: row.finalStatus, finalUrl: row.finalUrl, hops: hopList(row), listedIn: row.sources };
    const n = row.hops.length;
    if (row.loop) add('redirect-loop', row.path, `redirects in a loop (${plural(n, 'hop')})`, ev);
    else if (row.offsite) add('redirect-offsite', row.path, `redirects to ${row.offsite}, which the audit does not follow`, ev);
    else if (n && row.finalStatus !== 200) add('http-status', row.path, `redirects (${plural(n, 'hop')}) and ends at HTTP ${row.finalStatus}`, ev);
    else if (n >= 2) add('redirect-chain', row.path, `${n} redirects before the page: ${hopList(row).join(' ; ')}`, ev);
    else if (n === 1) add('redirected-url', row.path, `redirects (${row.hops[0].status}) to ${row.hops[0].location}`, ev);
    else if (row.status !== 200) add('http-status', row.path, `HTTP ${row.status}`, ev);
  }

  /* ── Sitemap URLs (smoke.ts → checkSitemapUrl, applied while crawling) ── */
  for (const row of answered) {
    if (!row.inSitemap) continue;
    const loc = row.loc ?? selfCanonical(row.path);
    // A page read as HTML was checked as it was read; anything else did not
    // answer 200, and checkSitemapUrl needs only the status for that.
    const failures =
      row.record?.sitemapFailures ??
      checkSitemapUrl(loc, { status: row.status ?? 0, html: '', xRobotsTag: null }, { hostNoindex: input.hostNoindex });
    if (failures.length) {
      add('sitemap-url-invalid', row.path, failures.join('; '), {
        loc,
        failures,
        listedIn: row.sources.filter((s) => s.startsWith('sitemap:')).map((s) => s.slice(8)),
      });
    }
  }

  /* ── One page at a time ── */
  for (const row of html) {
    const r = row.record as PageRecord;
    const p = row.path;

    if (r.soft404) add('soft-404', p, `answers 200 but reads as not found: “${clip(r.title, 120)}”`, { title: r.title, h1: r.h1 });

    if (r.h1Count !== 1 || !r.h1) {
      add('h1', p, r.h1Count === 0 ? 'no <h1>' : r.h1Count > 1 ? `${r.h1Count} <h1> elements` : 'the <h1> is empty', {
        h1Count: r.h1Count,
        firstH1: r.h1,
        outline: r.outline,
      });
    }
    const outline = r.headingProblems.filter((x) => !/<h1> elements|empty <h1>/.test(x));
    if (outline.length) add('heading-outline', p, outline.join('; '), { problems: outline, outline: r.outline });

    if (r.emptyAnchors.length) add('empty-anchor', p, `${plural(r.emptyAnchors.length, 'link')} without an accessible name`, { hrefs: r.emptyAnchors });
    if (r.imagesMissingAlt.length) {
      add('image-alt', p, `${r.imagesMissingAlt.length} of ${plural(r.images, 'image')} without an alt attribute`, { images: r.imagesMissingAlt });
    }
    if (r.jsonLd === 'error') add('json-ld-invalid', p, r.jsonLdErrors[0] ?? 'a JSON-LD block does not parse', { errors: r.jsonLdErrors });

    if (r.titleCount !== 1 || !r.title) {
      add('title-tag', p, r.titleCount === 0 ? 'no <title>' : r.titleCount > 1 ? `${r.titleCount} <title> elements` : 'the <title> is empty', {
        count: r.titleCount,
        title: r.title,
      });
    }
    if (r.descriptionCount !== 1 || !r.description) {
      add(
        'meta-description-tag',
        p,
        r.descriptionCount === 0 ? 'no meta description' : r.descriptionCount > 1 ? `${r.descriptionCount} meta descriptions` : 'the meta description is empty',
        { count: r.descriptionCount, description: r.description },
      );
    }

    if (r.faqMissing.length) {
      add('faq-markup-mismatch', p, `${r.faqMissing.length} of ${plural(r.faqQuestions, 'marked-up question')} not visible on the page`, {
        missing: r.faqMissing,
      });
    }

    // sitecrawl → breadcrumb / breadcrumbVisible, including the ?page=N exception.
    const endWrong =
      r.breadcrumbEnd !== null &&
      !!r.canonical &&
      r.breadcrumbEnd !== r.canonical &&
      !(isArchiveSlice(p) && r.breadcrumbEnd === r.canonical.replace(/\?page=\d+$/, ''));
    const trailWrong =
      r.breadcrumbVisible !== null && r.breadcrumbSchemaNames.length > 0 && !breadcrumbsMatch(r.breadcrumbVisible, r.breadcrumbSchemaNames);
    if (endWrong || trailWrong) {
      const parts = [
        endWrong ? `BreadcrumbList ends at ${r.breadcrumbEnd || '(nothing)'}, the canonical is ${r.canonical}` : '',
        trailWrong ? `visible trail “${(r.breadcrumbVisible ?? []).join(' › ')}” differs from the markup “${r.breadcrumbSchemaNames.join(' › ')}”` : '',
      ].filter(Boolean);
      add('breadcrumb-mismatch', p, parts.join('; '), {
        breadcrumbEnd: r.breadcrumbEnd,
        canonical: r.canonical,
        visible: r.breadcrumbVisible,
        markup: r.breadcrumbSchemaNames,
      });
    }

    const self = selfCanonical(p);
    if (r.index && (r.canonicalCount !== 1 || r.canonical !== self)) {
      add('canonical-mismatch', p, r.canonicalCount === 0 ? 'no canonical' : r.canonicalCount > 1 ? `${r.canonicalCount} canonicals` : `canonical is ${r.canonical}`, {
        expected: self,
        found: r.canonicals,
      });
    }

    const robots = { robotsMeta: r.robotsMeta || '(none)', xRobotsTag: r.xRobotsTag || '(none)', listedIn: row.sources };
    if (row.expectIndex === true && !r.index) add('unexpected-noindex', p, `served robots: ${r.robotsMeta || '(no meta)'}${r.xRobotsTag ? `; X-Robots-Tag: ${r.xRobotsTag}` : ''}`, robots);
    else if (row.inSitemap && !r.index) add('sitemap-noindex', p, `listed in a sitemap, but robots says ${r.robotsMeta || r.xRobotsTag}`, robots);
    if (row.expectFollow === true && !r.follow) add('unexpected-nofollow', p, `served robots: ${r.robotsMeta || '(no meta)'}${r.xRobotsTag ? `; X-Robots-Tag: ${r.xRobotsTag}` : ''}`, robots);

    // Paginated archive slices are deliberately left out of the sitemaps.
    if (input.sitemapsComplete && r.index && r.canonical === self && !row.inSitemap && !isArchiveSlice(p)) {
      add('not-in-sitemap', p, 'indexable and self-canonical, but no sitemap lists it', { canonical: r.canonical, foundVia: row.sources });
    }

    if (r.claims.length) {
      const patterns = [...new Set(r.claims.map((c) => c.pattern))];
      add('claim-wording', p, `${plural(r.claims.length, 'phrase')} to check: ${patterns.join(', ')}`, { hits: r.claims });
    }
  }

  /* ── Links (intent.ts → auditLinks over every page read) ── */
  const crawled: CrawledPage[] = answered.map((r) => ({
    path: r.path,
    status: linkStatus(r) ?? 0,
    canonical: r.record?.canonical || null,
    links: (r.links ?? []).map((l) => ({ from: r.path, ...l })),
  }));
  const targetStatus = new Map(
    input.rows.filter((r) => r.kind === 'link' && r.state === 'done').map((r) => [r.path, linkStatus(r)] as const),
  );
  const indexableSelf = html.filter((r) => r.record?.index && r.record.canonical === selfCanonical(r.path)).map((r) => r.path);
  const links = auditLinks(crawled, indexableSelf, PRODUCTION_ORIGIN, (p) => targetStatus.get(p));

  const sourcesOf = new Map<string, { from: string; zone: string; nav: boolean; anchor: string }[]>();
  for (const r of answered) {
    for (const l of r.links ?? []) {
      const list = sourcesOf.get(l.to) ?? [];
      if (list.length < 10) list.push({ from: r.path, zone: l.zone, nav: l.nav, anchor: l.anchor });
      sourcesOf.set(l.to, list);
    }
  }
  const grouped = <T extends { from: string; to: string }>(list: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const item of list) map.set(item.to, [...(map.get(item.to) ?? []), item]);
    return map;
  };
  const linkEvidence = (to: string) => {
    const row = byPath.get(to);
    return {
      status: row ? linkStatus(row) : undefined,
      hops: row ? hopList(row) : [],
      loop: row?.loop ?? false,
      examples: (sourcesOf.get(to) ?? []).slice(0, 5).map((s) => `${s.from} (${s.zone}${s.nav ? ', nav' : ''}): “${s.anchor || '(no text)'}”`),
    };
  };

  for (const [to, list] of grouped(links.broken)) {
    add('broken-internal-link', to, `HTTP ${list[0].status}, linked from ${plural(new Set(list.map((l) => l.from)).size, 'page')}`, linkEvidence(to), list.map((l) => l.from));
  }
  for (const [to, list] of grouped(links.redirected)) {
    const row = byPath.get(to);
    const dest = row?.loop ? 'a redirect loop' : (row?.finalUrl ?? row?.hops[0]?.location ?? 'another URL');
    add('redirected-internal-link', to, `redirects (${list[0].status}) to ${dest}, linked from ${plural(new Set(list.map((l) => l.from)).size, 'page')}`, linkEvidence(to), list.map((l) => l.from));
  }
  for (const [to, list] of grouped(links.nonCanonical)) {
    add('non-canonical-link', to, `the page’s canonical is ${list[0].canonical}`, { ...linkEvidence(to), canonical: list[0].canonical }, list.map((l) => l.from));
  }

  // Whether a page has inbound links can only be told from the whole graph.
  if (input.coverageComplete) {
    const stats = inboundStats(crawled);
    for (const p of links.orphans) add('orphan-page', p, 'no page the audit read links here', { inbound: stats.get(p) ?? { total: 0, contextual: 0, editorial: 0 } });
    const orphaned = new Set(links.orphans);
    // As in the site's link-graph check (linkgraph.live.test.ts), only pages the
    // sitemaps list are judged for editorial links: not ?page=N slices or pages
    // the sitemaps leave out on purpose.
    const listed = new Set(pages.filter((r) => r.inSitemap).map((r) => r.path));
    for (const p of links.weak) {
      if (orphaned.has(p) || !listed.has(p)) continue;
      const s = stats.get(p) ?? { total: 0, contextual: 0, editorial: 0 };
      add('weakly-linked', p, `${plural(s.total, 'page')} ${s.total === 1 ? 'links' : 'link'} here, none from its own content`, { inbound: s });
    }
  }

  /* ── Images ── */
  const usedOn = new Map<string, string[]>();
  for (const r of html) for (const src of r.images ?? []) usedOn.set(src, [...(usedOn.get(src) ?? []), r.path]);
  for (const row of input.rows) {
    if (row.kind !== 'image' || row.state !== 'done') continue;
    const status = row.finalStatus ?? row.status;
    if (status !== null && status >= 400) {
      const pagesUsing = usedOn.get(row.path) ?? [];
      add('broken-image', row.path, `HTTP ${status}, used on ${plural(pagesUsing.length, 'page')}`, { status, hops: hopList(row) }, pagesUsing);
    }
  }

  /* ── Editorial hints (pageChecks.ts) on the text pages serve; blog posts have their own audit ── */
  const editorial: CheckPage[] = html
    .filter((r) => !r.path.startsWith('/blog'))
    .map((r) => {
      const rec = r.record as PageRecord;
      const src = input.textSources.get(r.path);
      return {
        path: r.path,
        live: true,
        saved: false,
        title: rec.title,
        titleSource: src?.title ?? 'default',
        description: rec.description,
        descriptionSource: src?.description ?? 'default',
        noindex: !rec.index,
        nofollow: !rec.follow,
      };
    });
  const textOf = new Map(editorial.map((e) => [e.path, e]));
  for (const f of checkPages(editorial)) {
    const rule = editorialRuleId(f.check);
    if (!rule) continue;
    // A duplicate is only a duplicate among the pages read; with pages left
    // out, the group may be incomplete in either direction.
    if ((f.check === 'title-duplicate' || f.check === 'description-duplicate') && !input.coverageComplete) continue;
    const page = textOf.get(f.path);
    const field = f.check.startsWith('title') ? 'title' : 'description';
    add(rule, f.path, f.detail, { [field]: field === 'title' ? page?.title : page?.description, source: f.source ?? null }, f.related ?? []);
  }

  /* ── robots.txt and the sitemaps (smoke.ts checks) ── */
  if (input.site.robots?.failures.length) add('robots-txt', '/robots.txt', input.site.robots.failures.join('; '), { failures: input.site.robots.failures });
  if (input.site.sitemapIndex.failures.length) {
    add('sitemap-index', '/sitemap.xml', input.site.sitemapIndex.failures.slice(0, 3).join('; '), { failures: input.site.sitemapIndex.failures.slice(0, EVIDENCE_LIST_CAP) });
  }
  for (const child of input.site.children) {
    if (!child.failures.length) continue;
    add('sitemap-urlset', child.path, child.failures.length === 1 ? child.failures[0] : `${child.failures.length} entries are not valid canonicals`, {
      failures: child.failures.slice(0, EVIDENCE_LIST_CAP),
      total: child.failures.length,
    });
  }
  if (input.site.hygiene.failures.length) {
    add('sitemap-hygiene', '/sitemap.xml', plural(input.site.hygiene.failures.length, 'problem'), {
      failures: input.site.hygiene.failures.slice(0, EVIDENCE_LIST_CAP),
      total: input.site.hygiene.failures.length,
    });
  }

  return out;
}

/* ── What a run looked at, so an issue it did not report can be closed ──── */

export interface Evaluation {
  /** Every page and link target found was answered (see AnalysisInput.coverageComplete). */
  coverageComplete: boolean;
  /** Every image found on an approved host was answered. */
  imagesComplete: boolean;
  sitemapsComplete: boolean;
  /** Pages and link targets that answered in this run. */
  answered: ReadonlySet<string>;
  /** Images that answered in this run. */
  images: ReadonlySet<string>;
  /** Site files read: robots-txt, sitemap-index, sitemap-hygiene, child:<path>. */
  siteChecked: ReadonlySet<string>;
  /** Child sitemaps the index lists; null when the index was not read. */
  listedChildren: ReadonlySet<string> | null;
}

const SITE_RULES = new Set(['robots-txt', 'sitemap-index', 'sitemap-hygiene']);
const GRAPH_RULES = new Set(['orphan-page', 'weakly-linked', 'editorial:title-duplicate', 'editorial:description-duplicate']);

/**
 * Did this run look at what an earlier issue is about? Only then may the
 * issue be marked resolved for not being reported. A page the run did not
 * reach — budget, robots.txt, a timeout — leaves its issues as they were.
 */
export function isEvaluated(ev: Evaluation, rule: string, path: string): boolean {
  if (!isAuditRule(rule)) return false;
  if (GRAPH_RULES.has(rule)) return ev.coverageComplete;
  if (SITE_RULES.has(rule)) return ev.siteChecked.has(rule);
  if (rule === 'sitemap-urlset') return ev.siteChecked.has(`child:${path}`) || (ev.listedChildren !== null && !ev.listedChildren.has(path));
  if (rule === 'broken-image') return ev.images.has(path) || ev.imagesComplete;
  if (rule === 'not-in-sitemap') return ev.sitemapsComplete && (ev.answered.has(path) || ev.coverageComplete);
  // With complete coverage every URL still listed or linked was answered, so
  // one that is absent is no longer listed or linked anywhere.
  return ev.answered.has(path) || ev.coverageComplete;
}

export function evaluationOf(
  rows: readonly AuditRow[],
  site: SiteChecks,
  coverage: { complete: boolean; imagesComplete: boolean; sitemapsComplete: boolean },
): Evaluation {
  const siteChecked = new Set<string>();
  if (site.robots?.checked) siteChecked.add('robots-txt');
  if (site.sitemapIndex.checked) siteChecked.add('sitemap-index');
  if (site.hygiene.checked) siteChecked.add('sitemap-hygiene');
  for (const c of site.children) if (c.checked) siteChecked.add(`child:${c.path}`);
  return {
    coverageComplete: coverage.complete,
    imagesComplete: coverage.imagesComplete,
    sitemapsComplete: coverage.sitemapsComplete,
    answered: new Set(rows.filter((r) => r.kind !== 'image' && r.state === 'done').map((r) => r.path)),
    images: new Set(rows.filter((r) => r.kind === 'image' && r.state === 'done').map((r) => r.path)),
    siteChecked,
    listedChildren: site.sitemapIndex.checked ? new Set(site.children.map((c) => c.path)) : null,
  };
}
