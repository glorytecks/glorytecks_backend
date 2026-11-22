/**
 * The gate every rewritten article must pass before it is written to the
 * database (Phase 11, docs/BLOG_REWRITE_FINAL_REPORT.md). Pure: the caller
 * passes in the live row and everything that needs I/O.
 *
 * Two results, both required:
 *   quality   the content: a meaningful rewrite (not the old text, not a copy of
 *             another article), valid and well-rendered blocks, no template or
 *             unsupported claims, no keyword stuffing, sources that resolve and
 *             are cited, internal links to live pages, no unverified code
 *             presented as verified, an allowed byline, and a passing review.
 *   metadata  identity and SEO fields: same id, slug, category and publication
 *             date; a sane title; SEO title, description, OG fields and
 *             excerpt within range; canonical untouched; not noindexed.
 *
 * The internal quality score is not an input. A number never approves anything.
 */
import { inlineRenderedTexts, leftoverMarkup, nestedMarkup, plainTextMarkup, type Block } from '../../utils/blocks';
import { strayTrailingNumber } from '../../utils/blogTitle';

export { strayTrailingNumber };

export interface GateSource {
  url: string;
  supports?: string;
  /** Result of the pre-write link check: an HTTP status, or a manual verification note. */
  check?: { status: number; at: string; manual?: string };
}

export interface GateFile {
  id: string;
  slug: string;
  changes: {
    content: Block[];
    excerpt?: string;
    metaDescription?: string;
    metaTitle?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
    title?: string;
    authorKey?: string;
    [k: string]: unknown;
  };
  sources?: GateSource[];
  codeVerification?: { block: string; status: string }[];
  byline?: { authorKey?: string; approvedBy?: string; approvedAt?: string };
  review?: {
    automated?: {
      result?: string;
      failures?: string[];
      contentSha256?: string;
      similarityToOriginal?: number;
      maxSimilarityToCorpus?: number;
      maxSimilarityToOtherRewrites?: number;
      templateSentences?: number;
      brokenLinks?: string[];
      keywordDensityPer100Words?: number | null;
    };
    independent?: { verdict?: string };
  };
}

export interface GateLiveRow {
  id: string;
  slug: string;
  title: string;
  category_slug: string;
  date: string;
  author_key: string;
  seo_canonical_url: string | null;
  seo_noindex: boolean | null;
  contentSha256: string;
  /**
   * Set by the caller when the file's title, excerpt, byline or SEO fields differ
   * from the live row. With identical content, that makes the write a metadata
   * correction rather than a no-op re-application.
   */
  metadataChanged?: boolean;
}

export interface GateContext {
  sha: (blocks: unknown) => string;
  validateBlocks: (blocks: unknown) => string | null;
  renderHtml: (blocks: Block[]) => string;
  organizationAuthorKeys: readonly string[];
  /** Slugs of published articles that are not redirected: valid /blog/ link targets. */
  liveSlugs: ReadonlySet<string>;
  /** Every other internal path a link may target (courses, compare pages, landings). */
  staticPaths: ReadonlySet<string>;
  /** Content checksum of the row when the rewrite was written (the backup baseline). */
  baselineSha: string;
}

export interface GateResult {
  quality: { ok: boolean; failures: string[] };
  metadata: { ok: boolean; failures: string[] };
}

export const LIMITS = {
  maxSimilarity: 0.2,
  maxKeywordDensity: 1.0,
  minSources: 2,
  internalLinks: [2, 8] as const,
  excerpt: [70, 320] as const,
  metaTitle: [20, 65] as const,
  metaDescription: [70, 160] as const,
  ogTitle: [10, 95] as const,
  ogDescription: [70, 200] as const,
  title: [10, 150] as const,
};

/** Fields a rewrite must never carry: identity, URL, category and publication date. */
const FORBIDDEN_CHANGES = ['slug', 'category', 'categorySlug', 'date', 'status', 'publishedAt', 'canonicalUrl', 'noindex', 'id'];

/** Sentences the Phase 4 audit found repeated across hundreds of the original articles. */
export const TEMPLATE_PHRASES = [
  /is one of the topics learners ask about most/i,
  /in active demand across Hyderabad/i,
  /is very learnable with the right sequence/i,
  /The tools change; the fundamentals don't/i,
  /Most committed learners reach a job-ready level/i,
  /A degree helps but isn't mandatory/i,
  /you'll leave knowing what to do next/i,
  /100% placement/i,
];

/** Claims a rewrite may not make: salary figures, invented outcomes, first-hand experience. */
export const UNSUPPORTED = [
  /₹\s?\d|\b\d+(\.\d+)?\s?(lpa|lakhs?)\b/i,
  /\bour (students|learners|graduates|trainees|alumni)\b/i,
  /\b(we['’]ve|we have) (seen|helped|trained|placed)\b/i,
  /\bin (our|my) experience\b/i,
  /\b\d{2,}\+?\s*(students|learners|placements|hiring partners)\b/i,
];

const EXECUTION_CLAIM = /\b(tested|verified|was run|were run|runs as written|output (shown )?is real|outputs (shown )?are real)\b/i;
// "Best practices" is a technical term, not a claim.
const PROMOTIONAL = /\b(best(?! practices?\b)|#1|number one|guaranteed?|100% placement|job guarantee)\b/i;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function blockTexts(blocks: readonly Block[]): string[] {
  return blocks.flatMap((b) => {
    switch (b.type) {
      case 'paragraph':
      case 'quote':
      case 'callout':
        return [b.text];
      case 'list':
        return b.items;
      case 'table':
        return b.rows.flat();
      case 'faq':
        return b.items.flatMap((i) => [i.q, i.a]);
      default:
        return [];
    }
  });
}


const within = (value: string | undefined, [lo, hi]: readonly [number, number]) => Boolean(value) && value!.length >= lo && value!.length <= hi;

export function gateArticle(file: GateFile, live: GateLiveRow, ctx: GateContext): GateResult {
  const q: string[] = [];
  const m: string[] = [];
  const blocks = file.changes.content ?? [];
  const texts = blockTexts(blocks);
  const body = texts.join('\n');
  const newSha = ctx.sha(blocks);

  /* ── Quality ───────────────────────────────────────────────────────── */
  if (!Array.isArray(blocks) || blocks.length === 0) q.push('no content');
  const invalid = ctx.validateBlocks(blocks);
  if (invalid) q.push(`blocks fail validation: ${invalid}`);

  if (newSha === live.contentSha256) {
    // Same body: only a metadata correction (SEO title, excerpt, byline) is a meaningful write.
    if (!live.metadataChanged) q.push('new content is identical to the live content');
  } else if (live.contentSha256 !== ctx.baselineSha) q.push('live content changed since the rewrite was written (re-baseline first)');

  const html = ctx.renderHtml(blocks);
  for (const tag of ['p', 'h2', 'h3', 'ul', 'ol', 'li', 'table', 'tr', 'pre']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (open !== close) q.push(`malformed HTML: <${tag}> opened ${open}, closed ${close}`);
  }
  // Only text the renderer parses inline can show stray markers, and markers inside
  // its tokens (a `**kwargs` code span, link text) are content, not leftovers.
  const leftover = inlineRenderedTexts(blocks).find(leftoverMarkup);
  if (leftover) q.push(`unrendered Markdown in prose: "${leftover.slice(0, 60)}"`);
  const nested = inlineRenderedTexts(blocks).flatMap(nestedMarkup);
  if (nested.length) q.push(`markup nested inside bold or link text shows raw on the site: ${nested.slice(0, 2).join(' | ')}`);
  for (const b of blocks) {
    if (b.type === 'table' && b.rows.some((r) => r.length !== b.head.length)) q.push(`table row width differs from its ${b.head.length}-column header`);
  }
  const plainMarked = plainTextMarkup(blocks);
  if (plainMarked.length) q.push(`markup in a heading, FAQ question, table header or callout title shows raw: "${plainMarked[0].slice(0, 60)}"`);
  if (texts.some((t) => /(^|[^*\w])\*[^*\s][^*]*\*(?!\*)/.test(t.replace(/`[^`]*`/g, '')))) q.push('single-asterisk italics (not supported by the renderer)');

  const a = file.review?.automated;
  if (!a?.result) q.push('automated checks have not been run');
  else {
    if (a.contentSha256 !== newSha) q.push('automated checks are stale (content changed since they ran)');
    if (a.result !== 'pass') q.push(`automated checks failed: ${(a.failures ?? []).join('; ')}`);
    if ((a.similarityToOriginal ?? 1) >= LIMITS.maxSimilarity) q.push(`too close to the original (${a.similarityToOriginal})`);
    if ((a.maxSimilarityToCorpus ?? 1) >= LIMITS.maxSimilarity) q.push(`too close to another article (${a.maxSimilarityToCorpus})`);
    if ((a.maxSimilarityToOtherRewrites ?? 0) >= LIMITS.maxSimilarity) q.push(`too close to another rewrite (${a.maxSimilarityToOtherRewrites})`);
    if ((a.templateSentences ?? 0) > 0) q.push(`${a.templateSentences} template sentence(s)`);
    if ((a.brokenLinks ?? []).length) q.push(`broken internal links: ${a.brokenLinks!.join(' ')}`);
    if ((a.keywordDensityPer100Words ?? 0) > LIMITS.maxKeywordDensity) q.push(`keyword stuffing (${a.keywordDensityPer100Words} per 100 words)`);
  }
  if (file.review?.independent?.verdict !== 'pass') q.push('second review has not passed');

  for (const re of [...TEMPLATE_PHRASES, ...UNSUPPORTED]) if (re.test(body)) q.push(`forbidden phrasing: ${re.source}`);

  const links = [...body.matchAll(LINK)].map((x) => x[2]);
  const external = [...new Set(links.filter((u) => !u.startsWith('/')))];
  const internal = links.filter((u) => u.startsWith('/'));
  const sources = file.sources ?? [];
  if (new Set(sources.map((s) => s.url)).size < LIMITS.minSources) q.push(`fewer than ${LIMITS.minSources} sources`);
  for (const u of external) if (!sources.some((s) => s.url === u)) q.push(`external link not listed in sources: ${u}`);
  for (const s of sources) {
    if (!/^https:\/\//.test(s.url)) q.push(`source is not https: ${s.url}`);
    if (!external.includes(s.url)) q.push(`source listed but never cited: ${s.url}`);
    const status = s.check?.status ?? 0;
    const okStatus = status >= 200 && status < 400;
    if (!okStatus && !s.check?.manual) q.push(`source did not resolve (${status || 'unchecked'}): ${s.url}`);
  }
  if (internal.length < LIMITS.internalLinks[0] || internal.length > LIMITS.internalLinks[1]) q.push(`${internal.length} internal links (want ${LIMITS.internalLinks.join('–')})`);
  for (const href of internal) {
    const pathOnly = href.split(/[?#]/)[0];
    if (pathOnly === `/blog/${file.slug}`) q.push('links to itself');
    else if (pathOnly.startsWith('/blog/')) {
      if (!ctx.liveSlugs.has(pathOnly.slice(6))) q.push(`internal link to a missing or unpublished article: ${href}`);
    } else if (!ctx.staticPaths.has(pathOnly)) q.push(`internal link to an unknown page: ${href}`);
  }

  const codeBlocks = blocks.filter((b) => b.type === 'code').length;
  const cv = file.codeVerification ?? [];
  if (cv.some((c) => c.status === 'not executed')) q.push('code marked "not executed" is still in the article');
  if (codeBlocks > 0 && cv.length === 0) q.push('code blocks without a verification record');
  if (cv.some((c) => c.status !== 'executed') && EXECUTION_CLAIM.test(body)) q.push('claims execution while some code was not executed');

  const authorKey = file.changes.authorKey ?? live.author_key;
  if (!ctx.organizationAuthorKeys.includes(authorKey)) {
    const b = file.byline;
    if (!b?.approvedBy || !b.approvedAt || b.authorKey !== authorKey) q.push(`byline "${authorKey}" is a person with no recorded approval`);
  }

  /* ── Metadata ──────────────────────────────────────────────────────── */
  if (file.id !== live.id) m.push(`id mismatch: file ${file.id}, live ${live.id}`);
  if (file.slug !== live.slug) m.push(`slug mismatch: file ${file.slug}, live ${live.slug}`);
  for (const key of FORBIDDEN_CHANGES) if (key in file.changes) m.push(`rewrite may not change ${key}`);
  if (!live.date) m.push('live row has no publication date');
  if (!live.category_slug) m.push('live row has no category');

  const title = (file.changes.title ?? live.title).trim();
  if (!within(title, LIMITS.title)) m.push(`title is ${title.length} characters`);
  const stray = strayTrailingNumber(title, live.slug);
  if (stray) m.push(`title ends with a stray number "${stray}" that the slug does not have`);
  // Only a title the rewrite writes is judged for wording; an unchanged H1 is not the rewrite's.
  if (file.changes.title !== undefined && PROMOTIONAL.test(title)) m.push('title uses promotional wording');

  const c = file.changes;
  if (!within(c.excerpt, LIMITS.excerpt)) m.push(`excerpt is ${c.excerpt?.length ?? 0} characters`);
  if (!within(c.metaTitle, LIMITS.metaTitle)) m.push(`SEO title is ${c.metaTitle?.length ?? 0} characters`);
  if (!within(c.metaDescription, LIMITS.metaDescription)) m.push(`meta description is ${c.metaDescription?.length ?? 0} characters`);
  if (!within(c.ogTitle, LIMITS.ogTitle)) m.push(`OG title is ${c.ogTitle?.length ?? 0} characters`);
  if (!within(c.ogDescription, LIMITS.ogDescription)) m.push(`OG description is ${c.ogDescription?.length ?? 0} characters`);
  if (c.ogImage !== undefined && !/^https:\/\//.test(c.ogImage)) m.push('OG image is not an https URL');
  if (PROMOTIONAL.test(`${c.metaTitle ?? ''} ${c.metaDescription ?? ''}`)) m.push('SEO title or description uses promotional wording');

  const canonical = (live.seo_canonical_url ?? '').trim();
  if (canonical && !canonical.replace(/\/$/, '').endsWith(`/blog/${live.slug}`)) m.push(`live canonical points elsewhere: ${canonical}`);
  if (live.seo_noindex) m.push('live row is noindex');

  return { quality: { ok: q.length === 0, failures: q }, metadata: { ok: m.length === 0, failures: m } };
}
