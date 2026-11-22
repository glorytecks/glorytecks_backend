import { body, ValidationChain } from 'express-validator';
import { SEO_LIMITS } from './pageSeoRegistry';

/**
 * The SEO fields an editor can set on a non-blog page, in one shape whether
 * they are stored in `page_seo` (by path) or in a record's `seo_*` group
 * (courses, about). Comparisons and legal pages keep their older two-field
 * shape (metaTitle / metaDescription) on the record.
 *
 * Deliberately absent:
 *  • canonicalUrl — generated from the site's route registry. The column still
 *    exists on the seo_* groups but no write path accepts it.
 *  • any "meta keywords" output — `keywords` is editorial targeting only and
 *    is never sent to the public site.
 */
export const SEO_TEXT_FIELDS = ['metaTitle', 'metaDescription', 'ogTitle', 'ogDescription', 'ogImageAlt'] as const;
export const SEO_FIELDS = [...SEO_TEXT_FIELDS, 'ogImage', 'keywords', 'noindex', 'nofollow', 'intentNote'] as const;
export type SeoField = (typeof SEO_FIELDS)[number];

/** Fields that only an administrator may change. */
export const ROBOTS_FIELDS = ['noindex', 'nofollow'] as const;

/** Never leave the CMS: stripped from every public response. */
const PRIVATE_FIELDS = ['keywords', 'intentNote', 'canonicalUrl'] as const;

export interface SeoValues {
  metaTitle?: string | null;
  metaDescription?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  ogImageAlt?: string | null;
  keywords?: string[];
  noindex?: boolean;
  nofollow?: boolean;
  intentNote?: string | null;
}

/* ── Normalisation ────────────────────────────────────────────────────────── */

/**
 * Characters that have no business in a title or snippet: C0/C1 controls,
 * zero-width characters and bidirectional overrides (which can make a stored
 * title render differently from how it reads in the editor).
 */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/** Trim, collapse runs of whitespace to one space; empty means "unset" (null). */
export function singleLine(value: string): string | null {
  const out = value.replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}

/** Trim and normalise line endings, keeping line breaks; empty → null. */
function multiLine(value: string): string | null {
  const out = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  return out === '' ? null : out;
}

/** Trim, drop blanks and case-insensitive duplicates, keep the editor's order. */
export function normaliseKeywords(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const k = singleLine(v);
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

/* ── Validation (one chain per field: validate() runs chains concurrently) ── */

const LABELS: Record<SeoField, string> = {
  metaTitle: 'SEO title',
  metaDescription: 'Meta description',
  ogTitle: 'Social title',
  ogDescription: 'Social description',
  ogImage: 'Social image',
  ogImageAlt: 'Social image alt text',
  keywords: 'Target keywords',
  noindex: 'Hide from search results',
  nofollow: 'Do not follow links',
  intentNote: 'Search intent note',
};

const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';

function singleLineRule(path: string, field: (typeof SEO_TEXT_FIELDS)[number]): ValidationChain {
  const label = LABELS[field];
  const max = SEO_LIMITS[field];
  return body(path)
    .optional({ values: 'undefined' })
    .custom(isTextOrNull)
    .withMessage(`${label} must be text`)
    .bail()
    .custom((v: string | null) => v === null || !INVISIBLE.test(v))
    .withMessage(`${label} contains invisible or control characters`)
    .bail()
    .customSanitizer((v: string | null) => (v === null ? null : singleLine(v)))
    .custom((v: string | null) => v === null || v.length <= max)
    .withMessage(`${label} must be at most ${max} characters`);
}

/**
 * The same rule for the older two-field SEO on comparisons and legal docs,
 * whose columns are `not null default ''`: empty is stored as ''.
 */
export function recordSeoText(field: 'metaTitle' | 'metaDescription'): ValidationChain {
  const label = LABELS[field];
  const max = SEO_LIMITS[field];
  return body(field)
    .optional({ values: 'undefined' })
    .custom(isTextOrNull)
    .withMessage(`${label} must be text`)
    .bail()
    .custom((v: string | null) => v === null || !INVISIBLE.test(v))
    .withMessage(`${label} contains invisible or control characters`)
    .bail()
    .customSanitizer((v: string | null) => (v === null ? '' : singleLine(v) ?? ''))
    .custom((v: string) => v.length <= max)
    .withMessage(`${label} must be at most ${max} characters`);
}

/**
 * Rules for an SEO object at `prefix` — '' for a body that IS the SEO object
 * (page_seo), 'seo.' for a record's nested group (courses, about).
 */
export function seoRules(prefix: string): ValidationChain[] {
  const p = (f: string) => `${prefix}${f}`;
  return [
    ...SEO_TEXT_FIELDS.map((f) => singleLineRule(p(f), f)),

    body(p('ogImage'))
      .optional({ values: 'undefined' })
      .custom(isTextOrNull)
      .withMessage('Social image must be a URL')
      .bail()
      .customSanitizer((v: string | null) => (v === null ? null : v.trim() || null))
      .custom((v: string | null) => v === null || (/^https:\/\/[^\s]+$/i.test(v) && v.length <= 2048))
      .withMessage('Social image must be an absolute https URL'),
    // The host allowlist and scheme rules for `ogImage` are enforced again,
    // for every request, by guardMediaUrls (utils/mediaUrl.ts → MEDIA_URL_FIELDS).

    body(p('keywords'))
      .optional({ values: 'undefined' })
      .isArray()
      .withMessage('Target keywords must be a list')
      .bail()
      .custom((v: unknown[]) => v.every((k) => typeof k === 'string' && !INVISIBLE.test(k)))
      .withMessage('Each target keyword must be plain text')
      .bail()
      .customSanitizer((v: unknown[]) => normaliseKeywords(v))
      .custom((v: string[]) => v.length <= SEO_LIMITS.keywords)
      .withMessage(`List at most ${SEO_LIMITS.keywords} target keywords`)
      .bail()
      .custom((v: string[]) => v.every((k) => k.length <= SEO_LIMITS.keyword))
      .withMessage(`Each target keyword must be at most ${SEO_LIMITS.keyword} characters`),

    body(p('noindex')).optional({ values: 'undefined' }).isBoolean({ strict: true }).withMessage('noindex must be true or false'),
    body(p('nofollow')).optional({ values: 'undefined' }).isBoolean({ strict: true }).withMessage('nofollow must be true or false'),

    body(p('intentNote'))
      .optional({ values: 'undefined' })
      .custom(isTextOrNull)
      .withMessage('Search intent note must be text')
      .bail()
      .custom((v: string | null) => v === null || !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))
      .withMessage('Search intent note contains control characters')
      .bail()
      .customSanitizer((v: string | null) => (v === null ? null : multiLine(v)))
      .custom((v: string | null) => v === null || v.length <= SEO_LIMITS.intentNote)
      .withMessage(`Search intent note must be at most ${SEO_LIMITS.intentNote} characters`),
  ];
}

/** Reject keys that are not SEO fields — with a specific answer for canonicals. */
export function seoObjectGuard(path: string, opts: { allowRoot?: readonly string[] } = {}): ValidationChain {
  const allowed = new Set<string>([...SEO_FIELDS, ...(opts.allowRoot ?? [])]);
  const chain = path ? body(path).optional({ values: 'null' }).isObject().withMessage('SEO must be an object').bail() : body();
  return chain.custom((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.includes('canonicalUrl') || keys.includes('canonical')) {
      throw new Error('Canonical URLs are generated from the route registry and cannot be set in the CMS');
    }
    const unknown = keys.filter((k) => !allowed.has(k));
    if (unknown.length) throw new Error(`Unexpected SEO field${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}`);
    return true;
  });
}

/* ── Robots ───────────────────────────────────────────────────────────────── */

/** "index, nofollow" is not offered; the database enforces the same rule. */
export function robotsProblem(seo: { noindex?: boolean | null; nofollow?: boolean | null } | null | undefined): string | null {
  if (seo?.nofollow && !seo?.noindex) return 'Links can only be marked nofollow on a page that is also hidden from search results';
  return null;
}

/** True when the write would change noindex or nofollow. */
export function changesRobots(before: SeoValues | null | undefined, incoming: Partial<SeoValues> | null | undefined): boolean {
  if (!incoming) return false;
  return ROBOTS_FIELDS.some(
    (f) => incoming[f] !== undefined && Boolean(incoming[f]) !== Boolean(before?.[f]),
  );
}

/* ── Diff (audit) and public projection ───────────────────────────────────── */

const comparable = (v: unknown) => {
  if (v === undefined || v === null || v === '' || v === false) return null;
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null;
  return JSON.stringify(v);
};

/** Names of the fields whose value differs. Unset, '', [] and false are equal. */
export function changedFields<K extends string>(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: readonly K[],
): K[] {
  return fields.filter((f) => comparable(before?.[f]) !== comparable(after?.[f]));
}

/** Fields the public site renders. Everything else stays in the CMS. */
export const PUBLIC_SEO_FIELDS = [
  'metaTitle',
  'metaDescription',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'ogImageAlt',
  'noindex',
  'nofollow',
] as const;

/** The public part of a page_seo row: set fields only, no ids, editors or notes. */
export function publicOverride(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PUBLIC_SEO_FIELDS) {
    const v = row[f];
    if (v === null || v === undefined || v === '' || v === false) continue;
    out[f] = v;
  }
  return out;
}

/** The part of an SEO group the public site may see. */
export function publicSeo(seo: unknown): Record<string, unknown> | undefined {
  if (!seo || typeof seo !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seo as Record<string, unknown>)) {
    if ((PRIVATE_FIELDS as readonly string[]).includes(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** A record with its `seo` group reduced to the public part. */
export function withPublicSeo<T>(doc: T): T {
  if (!doc || typeof doc !== 'object' || !('seo' in (doc as object))) return doc;
  return { ...(doc as object), seo: publicSeo((doc as { seo?: unknown }).seo) } as T;
}
