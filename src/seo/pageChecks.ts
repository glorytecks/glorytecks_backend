/**
 * SEO checks for the pages Page SEO manages — fixed pages, resource pages,
 * location landings, courses, comparisons and policies — behind the admin's
 * "SEO health" screen (GET /page-seo/checks).
 *
 * Pure data and pure functions; the only import is the equally pure registry.
 * main-website's `lib/seo/pageChecksParity.test.ts` imports this file and fails
 * when a rule here stops matching the one the site's own tests enforce
 * (`lib/guardrails/copyRules.ts`, applied by `lib/seo/onpage.test.ts`), so the
 * admin and the site cannot disagree about what a rule says.
 *
 * Severity is how the admin prioritises a finding, not a verdict on the page:
 *
 *   fix     breaks a rule the site's tests hold its own fixed pages to, or is
 *           missing, or two live, indexable pages show the same title;
 *   review  saved text outside the length guidance the editor shows, wording a
 *           person should judge, or a description another page also uses;
 *   info    a state worth knowing: hidden from search, or settings saved on a
 *           page that currently returns 404.
 *
 * The length guidance is the editor's aid for text an editor writes, so it is
 * applied to saved text only. A page's default text is held to the site's own
 * rules instead — the same rules its test suite already enforces on it.
 *
 * None of this measures or predicts rankings. Search engines choose what to
 * show and often shorten or rewrite titles and snippets; the checks describe
 * the text and settings saved in the CMS, nothing more. Blog posts are out of
 * scope: their SEO is resolved differently (main-website lib/blog/metadata.ts)
 * and judged by the blog quality audit and publish gate, not by these rules.
 */
import { SEO_GUIDANCE } from './pageSeoRegistry';

/* ── The site's rules (main-website lib/guardrails/copyRules.ts) ──────────── */

/**
 * Copied, not imported: the backend deploys separately. Every value is
 * compared with the site's by pageChecksParity.test.ts.
 */
export const SITE_COPY_RULES = {
  /** Unsubstantiated superlatives (onpage.test.ts: titles and descriptions). */
  superlatives: /\b(best|#\s*1|no\.?\s*1|top|leading|greatest|finest|world-class)\b/i,
  /** Outcome promises (onpage.test.ts: descriptions). */
  guarantees:
    /\b(guarantee[ds]?|assured|100\s*%\s*(placement|job)|job\s+guarantee|guaranteed\s+(job|salary|placement|package))\b/i,
  /** A title names each of these at most once, and at most `maxPlaces` of them. */
  places: ['hyderabad', 'ameerpet', 'kukatpally', 'secunderabad', 'madhapur', 'gachibowli'] as readonly string[],
  maxPlaces: 2,
  /** Longest title the site allows its fixed pages. */
  titleMax: 65,
  /** A description must be longer than this… */
  descriptionMoreThan: 70,
  /** …and at most this long. */
  descriptionMax: 260,
};

/* ── Check catalogue ──────────────────────────────────────────────────────── */

export type CheckSeverity = 'fix' | 'review' | 'info';

/** What part of the page a check reads. */
export type CheckField = 'title' | 'description' | 'page';

/**
 * Where a rule comes from, so the admin can say so next to every finding:
 * the site's own test suite, the editor's length guidance, a comparison
 * between pages, or a plain fact about the page.
 */
export type CheckRule = 'site-rule' | 'guidance' | 'site-wide' | 'status';

export type CheckId =
  | 'title-missing'
  | 'title-over-limit'
  | 'title-long'
  | 'title-short'
  | 'title-superlative'
  | 'title-place-repeated'
  | 'title-too-many-places'
  | 'title-repeated-segment'
  | 'title-duplicate'
  | 'description-missing'
  | 'description-too-short'
  | 'description-over-limit'
  | 'description-long'
  | 'description-superlative'
  | 'description-guarantee'
  | 'description-duplicate'
  | 'hidden-from-search'
  | 'not-live';

export interface CheckDefinition {
  id: CheckId;
  severity: CheckSeverity;
  field: CheckField;
  rule: CheckRule;
  /** Short name, e.g. "Title over 65 characters". */
  label: string;
  /** Why it matters, in plain words. Never a ranking claim. */
  why: string;
}

const R = SITE_COPY_RULES;
const G = SEO_GUIDANCE;

/** Every check, in the order the admin lists them. */
export const CHECKS: readonly CheckDefinition[] = [
  {
    id: 'title-missing',
    severity: 'fix',
    field: 'title',
    rule: 'status',
    label: 'No search title',
    why: 'The page has no saved title and no default to fall back on, so search engines pick text from the page instead.',
  },
  {
    id: 'title-over-limit',
    severity: 'fix',
    field: 'title',
    rule: 'site-rule',
    label: `Title over ${R.titleMax} characters`,
    why: `The site keeps the titles of its own fixed pages to ${R.titleMax} characters. Longer titles are usually cut off in results.`,
  },
  {
    id: 'title-long',
    severity: 'review',
    field: 'title',
    rule: 'guidance',
    label: `Title over ${G.title.max} characters`,
    why: `Within the site's limit, but longer than the ${G.title.min}–${G.title.max} characters most results show in full, so the end may be cut off. Checked on saved titles only.`,
  },
  {
    id: 'title-short',
    severity: 'review',
    field: 'title',
    rule: 'guidance',
    label: `Title under ${G.title.min} characters`,
    why: `Shorter than the usual ${G.title.min}–${G.title.max} characters. Fine if it says everything the page is about. Checked on saved titles only.`,
  },
  {
    id: 'title-superlative',
    severity: 'review',
    field: 'title',
    rule: 'site-rule',
    label: 'Superlative in the title',
    why: 'The site keeps words like “best”, “top” and “#1” out of its own titles because the business cannot back them up. Leave it if the word is not a claim about GloryTecks — “which is best?”, for example.',
  },
  {
    id: 'title-place-repeated',
    severity: 'fix',
    field: 'title',
    rule: 'site-rule',
    label: 'Place named twice in the title',
    why: 'Repeating a place name reads as keyword stuffing. The site rejects it in its own titles.',
  },
  {
    id: 'title-too-many-places',
    severity: 'fix',
    field: 'title',
    rule: 'site-rule',
    label: `More than ${R.maxPlaces} places in the title`,
    why: 'A locality and its city (“Ameerpet, Hyderabad”) are one address; a third place name reads as stuffing. The site rejects it in its own titles.',
  },
  {
    id: 'title-repeated-segment',
    severity: 'fix',
    field: 'title',
    rule: 'site-rule',
    label: 'Phrase repeated around “|”',
    why: 'The same phrase on both sides of a separator spends the space a result shows on saying one thing twice.',
  },
  {
    id: 'title-duplicate',
    severity: 'fix',
    field: 'title',
    rule: 'site-wide',
    label: 'Same title as another page',
    why: 'Two live pages with one title compete for the same searches, and a reader cannot tell them apart in results.',
  },
  {
    id: 'description-missing',
    severity: 'fix',
    field: 'description',
    rule: 'status',
    label: 'No meta description',
    why: 'Without one, search engines build a snippet from page text, which may not say what the page offers.',
  },
  {
    id: 'description-too-short',
    severity: 'fix',
    field: 'description',
    rule: 'site-rule',
    label: `Description of ${R.descriptionMoreThan} characters or fewer`,
    why: `The site requires more than ${R.descriptionMoreThan} characters in its own descriptions. Very short ones are often replaced with text from the page.`,
  },
  {
    id: 'description-over-limit',
    severity: 'fix',
    field: 'description',
    rule: 'site-rule',
    label: `Description over ${R.descriptionMax} characters`,
    why: `The site keeps its own descriptions to ${R.descriptionMax} characters. Text past that point is almost never shown.`,
  },
  {
    id: 'description-long',
    severity: 'review',
    field: 'description',
    rule: 'guidance',
    label: `Description over ${G.description.max} characters`,
    why: `Most results show about ${G.description.max} characters of a description; the rest may be cut off or rewritten. Put what matters first. Checked on saved descriptions only.`,
  },
  {
    id: 'description-superlative',
    severity: 'review',
    field: 'description',
    rule: 'site-rule',
    label: 'Superlative in the description',
    why: 'The site keeps words like “best”, “top” and “#1” out of its own descriptions because the business cannot back them up. Leave it if the word is not a claim about GloryTecks.',
  },
  {
    id: 'description-guarantee',
    severity: 'fix',
    field: 'description',
    rule: 'site-rule',
    label: 'Outcome promise in the description',
    why: 'The site never promises jobs, salaries or placement in its own descriptions — a promise the business would have to honour. A disclaimer such as “not a guarantee” is caught too; reword it so a shortened snippet cannot read as a promise.',
  },
  {
    id: 'description-duplicate',
    severity: 'review',
    field: 'description',
    rule: 'site-wide',
    label: 'Same description as another page',
    why: 'Pages that share a description look interchangeable in results. Say what is specific to each one.',
  },
  {
    id: 'hidden-from-search',
    severity: 'info',
    field: 'page',
    rule: 'status',
    label: 'Hidden from search',
    why: 'A saved setting keeps this page out of search results and the sitemap, so its text is not checked. Make sure that is intended.',
  },
  {
    id: 'not-live',
    severity: 'info',
    field: 'page',
    rule: 'status',
    label: 'Saved settings on a page that is not live',
    why: 'The page returns 404 until its record is published (for a landing, its course and locality), so its saved settings have no effect yet.',
  },
];

const CHECK_ORDER = new Map(CHECKS.map((c, i) => [c.id, i]));
const SEVERITY_OF = new Map(CHECKS.map((c) => [c.id, c.severity]));
const SEVERITY_RANK: Record<CheckSeverity, number> = { fix: 0, review: 1, info: 2 };

/* ── Input and output ─────────────────────────────────────────────────────── */

export type TextSource = 'custom' | 'default';

/** One page as the checks see it: what it shows now, and where that text comes from. */
export interface CheckPage {
  path: string;
  /** False when the page currently returns 404. */
  live: boolean;
  /** Settings are saved for this page (anything other than "use the defaults"). */
  saved: boolean;
  /** The title the page renders: the saved one, or the built-in default. */
  title: string | null;
  titleSource: TextSource;
  description: string | null;
  descriptionSource: TextSource;
  noindex: boolean;
  nofollow: boolean;
}

export interface Finding {
  check: CheckId;
  severity: CheckSeverity;
  path: string;
  /** What exactly was found: "72 characters", "uses “best”", … */
  detail: string;
  /** Whether the flagged text is saved in the CMS or the page's built-in default. */
  source?: TextSource;
  /** The other pages involved, for site-wide checks. */
  related?: string[];
}

export interface CheckSummary {
  /** Every page Page SEO manages. */
  pages: number;
  /** Live pages that are not hidden from search: the ones whose text was checked. */
  checked: number;
  /** Live pages hidden from search by a saved setting. */
  hidden: number;
  /** Pages that currently return 404. */
  notLive: number;
  /** Checked pages with at least one fix or review finding. */
  withFindings: number;
  fix: number;
  review: number;
  info: number;
}

/* ── The checks ───────────────────────────────────────────────────────────── */

/** Collapse whitespace the way the editor counts characters. */
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const quoted = (s: string) => `“${s}”`;

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function make(check: CheckId, path: string, detail: string, extra: Pick<Finding, 'source' | 'related'> = {}): Finding {
  return { check, severity: SEVERITY_OF.get(check) as CheckSeverity, path, detail, ...extra };
}

function titleFindings(page: CheckPage, title: string): Finding[] {
  const out: Finding[] = [];
  const source = { source: page.titleSource };
  const at = (check: CheckId, detail: string) => out.push(make(check, page.path, detail, source));

  if (!title) {
    at('title-missing', 'no title and no default');
    return out;
  }

  const length = title.length;
  if (length > R.titleMax) at('title-over-limit', `${length} characters`);
  else if (page.titleSource === 'custom') {
    if (length > G.title.max) at('title-long', `${length} characters`);
    else if (length < G.title.min) at('title-short', `${length} characters`);
  }

  const superlative = title.match(R.superlatives);
  if (superlative) at('title-superlative', `uses ${quoted(superlative[0])}`);

  // The same counting as onpage.test.ts: occurrences of each place in the
  // lower-cased title, then how many distinct places it names.
  const lower = title.toLowerCase();
  for (const place of R.places) {
    const occurrences = lower.split(place).length - 1;
    if (occurrences > 1) at('title-place-repeated', `names ${quoted(place)} ${occurrences} times`);
  }
  const places = R.places.filter((p) => lower.includes(p));
  if (places.length > R.maxPlaces) at('title-too-many-places', `names ${listOf(places)}`);

  // onpage.test.ts: no segment may appear twice either side of a "|".
  const seen = new Set<string>();
  for (const part of title.split('|').map((s) => s.trim().toLowerCase())) {
    if (seen.has(part)) {
      at('title-repeated-segment', part ? `repeats ${quoted(part)}` : 'repeats an empty segment');
      break;
    }
    seen.add(part);
  }

  return out;
}

function descriptionFindings(page: CheckPage, description: string): Finding[] {
  const out: Finding[] = [];
  const source = { source: page.descriptionSource };
  const at = (check: CheckId, detail: string) => out.push(make(check, page.path, detail, source));

  if (!description) {
    at('description-missing', 'no description and no default');
    return out;
  }

  const length = description.length;
  if (length <= R.descriptionMoreThan) at('description-too-short', `${length} characters`);
  else if (length > R.descriptionMax) at('description-over-limit', `${length} characters`);
  else if (page.descriptionSource === 'custom' && length > G.description.max) {
    at('description-long', `${length} characters`);
  }

  const superlative = description.match(R.superlatives);
  if (superlative) at('description-superlative', `uses ${quoted(superlative[0])}`);

  const guarantee = description.match(R.guarantees);
  if (guarantee) at('description-guarantee', `uses ${quoted(guarantee[0])}`);

  return out;
}

/** Pages sharing one value (case- and whitespace-insensitive), each told about the others. */
function duplicateFindings(
  pages: readonly CheckPage[],
  check: 'title-duplicate' | 'description-duplicate',
  value: (p: CheckPage) => string,
  sourceOf: (p: CheckPage) => TextSource,
): Finding[] {
  const groups = new Map<string, CheckPage[]>();
  for (const page of pages) {
    const key = value(page).toLowerCase();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  const out: Finding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const page of group) {
      const related = group.filter((p) => p !== page).map((p) => p.path);
      const others = related.length === 1 ? '1 other page' : `${related.length} other pages`;
      out.push(make(check, page.path, `also used on ${others}`, { source: sourceOf(page), related }));
    }
  }
  return out;
}

/**
 * Run every check over every page.
 *
 * Only live pages that are not hidden from search have their text checked —
 * those are the pages that can appear in results. A hidden page gets one
 * `hidden-from-search` note; a page that returns 404 gets a `not-live` note
 * when it has saved settings (they do nothing yet) and nothing otherwise.
 */
export function checkPages(pages: readonly CheckPage[]): Finding[] {
  const findings: Finding[] = [];
  const visible: CheckPage[] = [];

  for (const page of pages) {
    if (!page.live) {
      if (page.saved) findings.push(make('not-live', page.path, 'returns 404, settings saved'));
      continue;
    }
    if (page.noindex) {
      findings.push(make('hidden-from-search', page.path, page.nofollow ? 'noindex, nofollow' : 'noindex, follow'));
      continue;
    }
    visible.push(page);
    findings.push(...titleFindings(page, clean(page.title)), ...descriptionFindings(page, clean(page.description)));
  }

  findings.push(
    ...duplicateFindings(visible, 'title-duplicate', (p) => clean(p.title), (p) => p.titleSource),
    ...duplicateFindings(visible, 'description-duplicate', (p) => clean(p.description), (p) => p.descriptionSource),
  );

  return findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (CHECK_ORDER.get(a.check) as number) - (CHECK_ORDER.get(b.check) as number) ||
      a.path.localeCompare(b.path),
  );
}

/** Counts for the summary strip. */
export function summarize(pages: readonly CheckPage[], findings: readonly Finding[]): CheckSummary {
  const flagged = new Set(findings.filter((f) => f.severity !== 'info').map((f) => f.path));
  const count = (s: CheckSeverity) => findings.filter((f) => f.severity === s).length;
  return {
    pages: pages.length,
    checked: pages.filter((p) => p.live && !p.noindex).length,
    hidden: pages.filter((p) => p.live && p.noindex).length,
    notLive: pages.filter((p) => !p.live).length,
    withFindings: flagged.size,
    fix: count('fix'),
    review: count('review'),
    info: count('info'),
  };
}
