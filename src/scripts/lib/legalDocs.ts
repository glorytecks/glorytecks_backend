import { legalDocRepo } from '../../repositories';
import type { ILegalDoc } from '../../interfaces/common';
import type { LegalDoc } from '../../seed/sitedata/legal';
import { recordSeoAudit } from '../../lib/seoAudit';
import { invalidateResource } from '../../lib/cacheInvalidation';
import { changedFields } from '../../seo/seoFields';

/**
 * Planning and applying a reviewed set of policy texts (seed/sitedata/legal.ts)
 * to the CMS. Used by src/scripts/legal-docs.ts; the CLI owns the safety
 * checks (dry run by default, --confirm, local-only unless --allow-remote).
 */

/** The fields a reviewed draft replaces. Slug and status are never changed. */
const CONTENT_FIELDS = ['title', 'metaTitle', 'metaDescription', 'intro', 'sections'] as const;

type Row = Record<string, unknown>;

const sortKeys = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(sortKeys)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x as Row)
            .sort()
            .map((k) => [k, sortKeys((x as Row)[k])]),
        )
      : x;

/** Equal regardless of key order (jsonb does not keep it) and of '' vs missing. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(sortKeys(a ?? '')) === JSON.stringify(sortKeys(b ?? ''));

export interface DocPlan {
  slug: string;
  /** missing: no CMS row; unchanged: text identical; update: text differs. */
  action: 'missing' | 'unchanged' | 'update';
  changed: string[];
  headingsBefore: string[];
  headingsAfter: string[];
  currentUpdated: string | null;
}

export function planLegalUpdate(live: readonly ILegalDoc[], drafts: readonly LegalDoc[]): DocPlan[] {
  return drafts.map((draft) => {
    const row = live.find((r) => r.slug === draft.slug) as Row | undefined;
    const headingsAfter = draft.sections.map((s) => s.heading);
    if (!row) {
      return { slug: draft.slug, action: 'missing', changed: [], headingsBefore: [], headingsAfter, currentUpdated: null };
    }
    const changed = CONTENT_FIELDS.filter((f) => !same(row[f], (draft as Row)[f]));
    return {
      slug: draft.slug,
      action: changed.length ? 'update' : 'unchanged',
      changed,
      headingsBefore: ((row.sections as { heading?: string }[] | undefined) ?? []).map((s) => s.heading ?? ''),
      headingsAfter,
      currentUpdated: (row.updated as string | undefined) || null,
    };
  });
}

/** A real YYYY-MM-DD calendar date. */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Today in India (the date a reader there would see), as YYYY-MM-DD. */
export function todayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/**
 * Why an effective date cannot be used, or null. It must be a real date, not
 * before today (a new text must never claim an earlier "Last updated" date)
 * and not before the date the live text already shows.
 */
export function effectiveDateProblem(date: string | undefined, plans: readonly DocPlan[], today = todayInIndia()): string | null {
  if (!date) return '--effective-date YYYY-MM-DD is required: it becomes the "Last updated" date on each page';
  if (!isCalendarDate(date)) return `--effective-date "${date}" is not a real YYYY-MM-DD date`;
  if (date < today) return `--effective-date ${date} is earlier than today (${today}); a new text must not show an earlier date`;
  for (const p of plans) {
    if (p.action === 'update' && p.currentUpdated && date < p.currentUpdated) {
      return `--effective-date ${date} is earlier than the date ${p.slug} already shows (${p.currentUpdated})`;
    }
  }
  return null;
}

export interface ApplyResult {
  slug: string;
  written: boolean;
}

/**
 * Write the drafts whose text differs. Each changed document gets `updated` =
 * effectiveDate; unchanged ones keep their date. Audits SEO field changes and
 * refreshes the site (Redis purge + revalidation webhook, when configured).
 */
export async function applyLegalDocs(opts: {
  drafts: readonly LegalDoc[];
  effectiveDate: string;
  only?: readonly string[];
}): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const draft of opts.drafts) {
    if (opts.only?.length && !opts.only.includes(draft.slug)) continue;
    const before = await legalDocRepo.findOne({ slug: draft.slug });
    if (!before) {
      results.push({ slug: draft.slug, written: false });
      continue;
    }
    const [plan] = planLegalUpdate([before], [draft]);
    if (plan.action !== 'update') {
      results.push({ slug: draft.slug, written: false });
      continue;
    }
    const after = await legalDocRepo.updateById(before.id, {
      title: draft.title,
      metaTitle: draft.metaTitle,
      metaDescription: draft.metaDescription,
      intro: draft.intro,
      sections: draft.sections,
      updated: opts.effectiveDate,
    });
    await recordSeoAudit({
      entityType: 'legal',
      entityKey: `/${draft.slug}`,
      recordId: before.id,
      action: 'update',
      changedFields: changedFields(before as unknown as Row, after as unknown as Row, ['metaTitle', 'metaDescription']),
      editorId: null,
    });
    await invalidateResource('legal', { before: before as unknown as Row, after: after as unknown as Row });
    results.push({ slug: draft.slug, written: true });
  }
  return results;
}

/** Restore exported rows (their text and their own original date). */
export async function restoreLegalDocs(rows: readonly ILegalDoc[]): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const row of rows) {
    const current = await legalDocRepo.findOne({ slug: row.slug });
    if (!current) {
      results.push({ slug: row.slug, written: false });
      continue;
    }
    const after = await legalDocRepo.updateById(current.id, {
      title: row.title,
      metaTitle: row.metaTitle,
      metaDescription: row.metaDescription,
      intro: row.intro,
      sections: row.sections,
      updated: row.updated,
    });
    await invalidateResource('legal', { before: current as unknown as Row, after: after as unknown as Row });
    results.push({ slug: row.slug, written: true });
  }
  return results;
}
