import {
  authorRepo,
  batchRepo,
  blogCategoryRepo,
  blogRepo,
  brochureRepo,
  chatEnquiryRepo,
  companyRepo,
  comparisonRepo,
  courseCategoryRepo,
  courseRepo,
  demoRequestRepo,
  faqRepo,
  galleryRepo,
  legalDocRepo,
  localityRepo,
  placementRepo,
  roadmapRepo,
  testimonialRepo,
  trainerRepo,
} from '../repositories';
import type { Filter } from '../repositories/BaseRepository';
import { ALL_CONTENT_STATUS, ALL_LEAD_STATUS, CONTENT_STATUS, type Role } from '../constants';
import {
  LEAD_REPOS,
  PAGE_SIZE,
  canSeeLeads,
  dayKey,
  isAdmin,
  leadQueue,
  parseBatchDate,
  readRemainingPages,
  section,
  series,
  trendWindow,
  type AnyRepo,
  type LeadKey,
  type LeadQueue,
  type Series,
  type TrendRange,
  type TrendWindow,
} from './dashboard.service';

/*
  One overview per sidebar section (Leads, Blog, Courses, Website, People &
  proof), each read from the records themselves: counts by status, breakdowns
  by a stored field, dated series and the latest changes. Nothing is
  estimated. Breakdowns read at most MAX_ROWS rows and say when they stopped
  (`truncated`), so a cut-off list is never presented as complete.

  Which section a role may open is decided by the router (the same role lists
  as the section's pages); inside a section, parts that belong to another
  module (lead demand on the Courses overview, batches and brochures) are
  included only for the roles that may open that module.
*/

const iso = (ms: number): string => new Date(ms).toISOString();

/** The most rows a breakdown reads. */
export const MAX_ROWS = 10_000;
/** Rows a breakdown lists before folding the rest into "other". */
const TOP = 10;

export interface Tally {
  label: string;
  count: number;
}

export interface Breakdown {
  /** The largest groups, biggest first (ties alphabetical). */
  items: Tally[];
  /** Everything after the listed groups, added up. */
  other: number;
  /** Rows counted. */
  total: number;
  /** More rows than MAX_ROWS: the breakdown covers the first rows only. */
  truncated: boolean;
}

const capitals = (s: string) => (s.match(/[A-Z]/g) ?? []).length;

/**
 * Group values, trimmed and case-insensitive. A group is named by its most
 * common spelling; on a tie, the one with more capitals ("Deloitte", not
 * "deloitte"). Pure.
 */
export function breakdown(values: readonly unknown[], top = TOP, blank = 'Not given', truncated = false): Breakdown {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const raw of values) {
    const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : raw == null ? '' : String(raw);
    const label = text || blank;
    const key = label.toLowerCase();
    const g = groups.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    g.count += 1;
    g.spellings.set(label, (g.spellings.get(label) ?? 0) + 1);
    groups.set(key, g);
  }
  const named: Tally[] = [...groups.values()].map((g) => ({
    label: [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || capitals(b[0]) - capitals(a[0]) || a[0].localeCompare(b[0]))[0][0],
    count: g.count,
  }));
  const sorted = named.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const items = sorted.slice(0, top);
  return { items, other: sorted.slice(top).reduce((n, g) => n + g.count, 0), total: values.length, truncated };
}

/** Read some fields of every matching row, up to MAX_ROWS. */
async function readRows(repo: AnyRepo, fields: string[], filter: Filter = {}): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const read = (page: number) => repo.list({ filter, fields, sort: [{ field: 'createdAt', direction: 1 }], page, limit: PAGE_SIZE });
  const first = await read(1);
  const rows = [...first.items, ...(await readRemainingPages(first.total, MAX_ROWS, read))];
  return { rows, truncated: first.total > MAX_ROWS };
}

async function fieldBreakdown(repo: AnyRepo, field: string, filter: Filter = {}, top = TOP, blank?: string): Promise<Breakdown> {
  const { rows, truncated } = await readRows(repo, [field], filter);
  return breakdown(rows.map((r) => r[field]), top, blank, truncated);
}

const asRepo = (r: unknown) => r as AnyRepo;

/** Counts of a content table by status. */
async function contentStatuses(repo: AnyRepo): Promise<Record<(typeof ALL_CONTENT_STATUS)[number], number> & { total: number }> {
  const [total, ...byStatus] = await Promise.all([repo.count(), ...ALL_CONTENT_STATUS.map((s) => repo.count({ status: s }))]);
  return { total, ...Object.fromEntries(ALL_CONTENT_STATUS.map((s, i) => [s, byStatus[i]])) } as Record<(typeof ALL_CONTENT_STATUS)[number], number> & { total: number };
}

async function activeCounts(repo: AnyRepo): Promise<{ total: number; active: number }> {
  const [total, active] = await Promise.all([repo.count(), repo.count({ isActive: true })]);
  return { total, active };
}

export interface RecentItem {
  kind: string;
  id: string;
  title: string;
  at: string | null;
}

/** The latest `limit` rows of several tables by a timestamp, merged. */
async function latest(sources: { kind: string; repo: AnyRepo; title: string }[], by: 'updatedAt' | 'createdAt', limit = 8): Promise<RecentItem[]> {
  const lists = await Promise.all(
    sources.map(async (s) =>
      (await s.repo.findMany({ sort: [{ field: by, direction: -1 }], limit, fields: [s.title, by] })).map((r) => ({
        kind: s.kind,
        id: String(r.id),
        title: String(r[s.title] ?? ''),
        at: (r[by] as string | undefined) ?? null,
      })),
    ),
  );
  return lists
    .flat()
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, limit);
}

interface Range {
  days: number;
  tzOffsetMinutes: number;
  window: TrendWindow;
}

const rangeOf = (days: TrendRange, tz: number, now: Date): Range => ({ days, tzOffsetMinutes: tz, window: trendWindow(days, tz, now) });

const rangeOut = (r: Range) => ({ days: r.days, tzOffsetMinutes: r.tzOffsetMinutes, ...r.window });

/** What leads asked about, across every lead kind, in the window. */
async function leadDemand(window: TrendWindow): Promise<Breakdown> {
  const reads = await Promise.all(
    (Object.keys(LEAD_REPOS) as LeadKey[]).map((k) => readRows(LEAD_REPOS[k], ['course'], { createdAt: { op: 'gte', value: window.from } })),
  );
  return breakdown(
    reads.flatMap((r) => r.rows.map((row) => row.course)),
    TOP,
    'No course given',
    reads.some((r) => r.truncated),
  );
}

/* ── Leads ────────────────────────────────────────────────────────────────── */

export async function leadsOverview(days: TrendRange, tz: number, now = new Date()) {
  const r = rangeOf(days, tz, now);
  const kinds = Object.keys(LEAD_REPOS) as LeadKey[];
  const [arrivals, statuses, waiting, demand, demoSources, chat] = await Promise.all([
    section<Record<LeadKey, Series>>('lead arrivals', async () => {
      const list = await Promise.all(kinds.map((k) => series(LEAD_REPOS[k], 'createdAt', r.window, tz)));
      return Object.fromEntries(kinds.map((k, i) => [k, list[i]])) as Record<LeadKey, Series>;
    }),
    // Status now, over every lead ever received: a team's own markings, not outcomes measured here.
    section('lead statuses', async () => {
      const out = await Promise.all(
        kinds.map(async (k) => {
          const counts = await Promise.all(ALL_LEAD_STATUS.map((s) => LEAD_REPOS[k].count({ status: s })));
          return [k, Object.fromEntries(ALL_LEAD_STATUS.map((s, i) => [s, counts[i]]))] as const;
        }),
      );
      return Object.fromEntries(out) as Record<LeadKey, Record<(typeof ALL_LEAD_STATUS)[number], number>>;
    }),
    section<Record<LeadKey, LeadQueue>>('lead waiting', async () => {
      const list = await Promise.all(kinds.map((k) => leadQueue(LEAD_REPOS[k], now)));
      return Object.fromEntries(kinds.map((k, i) => [k, list[i]])) as Record<LeadKey, LeadQueue>;
    }),
    section('lead demand', () => leadDemand(r.window)),
    section('demo sources', () => fieldBreakdown(asRepo(demoRequestRepo), 'source', { createdAt: { op: 'gte', value: r.window.from } }, TOP, 'Not recorded')),
    // The chat widget saves each step as it goes; "done" means the visitor answered every question.
    section('chat steps', async () => {
      const steps = await fieldBreakdown(asRepo(chatEnquiryRepo), 'step', { createdAt: { op: 'gte', value: r.window.from } }, 20, 'Not recorded');
      const completed = steps.items.find((s) => s.label.toLowerCase() === 'done')?.count ?? 0;
      return { started: steps.total, completed, steps };
    }),
  ]);
  return { generatedAt: now.toISOString(), range: rangeOut(r), arrivals, statuses, waiting, demand, demoSources, chat };
}

/* ── Blog ─────────────────────────────────────────────────────────────────── */

/** Calendar months ("YYYY-MM"), oldest first, ending with the current month at the offset. Pure. */
export function lastMonths(n: number, now: Date, tz: number): string[] {
  const [y, m] = dayKey(now.getTime(), tz).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** The instant the first of these months starts, at the offset. Pure. */
const monthStart = (month: string, tz: number) => Date.parse(`${month}-01T00:00:00Z`) - tz * 60_000;

export async function blogOverview(days: TrendRange, tz: number, now = new Date()) {
  const r = rangeOf(days, tz, now);
  const blogs = asRepo(blogRepo);
  const published: Filter = { status: CONTENT_STATUS.PUBLISHED };
  const months = lastMonths(12, now, tz);
  const [statuses, flags, publishing, monthly, byCategory, byAuthor, byKind, recent, counts] = await Promise.all([
    section('blog statuses', () => contentStatuses(blogs)),
    section('blog flags', async () => {
      const [featured, trending, popular] = await Promise.all(['featured', 'trending', 'popular'].map((f) => blogs.count({ ...published, [f]: true })));
      return { featured, trending, popular };
    }),
    section('blog publishing', () => series(blogs, 'publishedAt', r.window, tz, published)),
    section('blog months', async () => {
      const { rows, truncated } = await readRows(blogs, ['publishedAt'], { ...published, publishedAt: { op: 'gte', value: iso(monthStart(months[0], tz)) } });
      const index = new Map(months.map((m, i) => [m, i]));
      const counts = months.map(() => 0);
      for (const row of rows) {
        const ms = typeof row.publishedAt === 'string' ? Date.parse(row.publishedAt) : NaN;
        if (Number.isNaN(ms)) continue;
        const i = index.get(dayKey(ms, tz).slice(0, 7));
        if (i !== undefined) counts[i] += 1;
      }
      return { months, counts, truncated };
    }),
    section('blog categories', () => fieldBreakdown(blogs, 'category', published)),
    section('blog authors', async () => {
      const [b, authors] = await Promise.all([
        fieldBreakdown(blogs, 'authorKey', published, TOP, 'No author'),
        authorRepo.findMany({ fields: ['key', 'name'], limit: 500 }),
      ]);
      const names = new Map(authors.map((a) => [String(a.key ?? '').toLowerCase(), String(a.name ?? '')]));
      return { ...b, items: b.items.map((t) => ({ ...t, label: names.get(t.label.toLowerCase()) || t.label })) };
    }),
    section('blog kinds', () => fieldBreakdown(blogs, 'kind', published, TOP, 'Article')),
    section('blog recent', async () =>
      (await blogRepo.findMany({ sort: [{ field: 'updatedAt', direction: -1 }], limit: 6, fields: ['title', 'status', 'updatedAt'] })).map((p) => ({
        id: String(p.id),
        title: String(p.title ?? ''),
        status: String(p.status ?? ''),
        updatedAt: (p.updatedAt as string | undefined) ?? null,
      })),
    ),
    section('blog counts', async () => {
      const [categories, authors] = await Promise.all([blogCategoryRepo.count(), authorRepo.count()]);
      return { categories, authors };
    }),
  ]);
  return { generatedAt: now.toISOString(), range: rangeOut(r), statuses, flags, publishing, monthly, byCategory, byAuthor, byKind, recent, counts };
}

/* ── Courses ──────────────────────────────────────────────────────────────── */

export async function coursesOverview(role: Role | undefined, days: TrendRange, tz: number, now = new Date()) {
  const r = rangeOf(days, tz, now);
  const courses = asRepo(courseRepo);
  const today = dayKey(now.getTime(), tz);
  const jobs = {
    statuses: section('course statuses', () => contentStatuses(courses)),
    flags: section('course flags', async () => {
      // Published only: drafts never reach the site, whatever their flags say (show_in_nav defaults to true).
      const published: Filter = { status: CONTENT_STATUS.PUBLISHED };
      const [featured, inNav] = await Promise.all([courses.count({ ...published, featured: true }), courses.count({ ...published, showInNav: true })]);
      return { featured, inNav };
    }),
    byCategory: section('course categories', () => fieldBreakdown(courses, 'category', { status: { op: 'neq', value: CONTENT_STATUS.ARCHIVED } })),
    counts: section('course counts', async () => ({ categories: await courseCategoryRepo.count() })),
    recent: section('course recent', async () =>
      (await courseRepo.findMany({ sort: [{ field: 'updatedAt', direction: -1 }], limit: 6, fields: ['title', 'status', 'updatedAt'] })).map((c) => ({
        id: String(c.id),
        title: String(c.title ?? ''),
        status: String(c.status ?? ''),
        updatedAt: (c.updatedAt as string | undefined) ?? null,
      })),
    ),
  };
  // Lead demand is lead data: only for roles that may read leads.
  const demand = canSeeLeads(role) ? section('course demand', () => leadDemand(r.window)) : undefined;
  // Batches and brochures are administrator modules.
  const batches = isAdmin(role)
    ? section('course batches', async () => {
        const { rows, truncated } = await readRows(asRepo(batchRepo), ['course', 'startDate', 'mode', 'seats'], { isActive: true });
        const read = rows.map((b) => ({ id: String(b.id), course: String(b.course ?? ''), startDate: String(b.startDate ?? ''), date: parseBatchDate(b.startDate as string), mode: String(b.mode ?? ''), seats: (b.seats as number | null | undefined) ?? null }));
        const upcoming = read.filter((b) => b.date && b.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return {
          active: await batchRepo.count({ isActive: true }),
          upcoming: upcoming.length,
          truncated,
          next: upcoming.slice(0, 6).map(({ id, course, date, mode, seats }) => ({ id, course, date: date as string, mode, seats })),
          pastDated: read.filter((b) => b.date && b.date < today).length,
          unreadable: read.filter((b) => !b.date).length,
        };
      })
    : undefined;
  const brochures = isAdmin(role)
    ? section('course brochures', async () => {
        const [brochureRead, courseRead] = await Promise.all([
          readRows(asRepo(brochureRepo), ['courseSlug'], { isActive: true }),
          readRows(courses, ['slug', 'title', 'brochureUrl'], { status: CONTENT_STATUS.PUBLISHED }),
        ]);
        const list = brochureRead.rows;
        const published = courseRead.rows;
        const covered = new Set(list.map((b) => String(b.courseSlug ?? '').toLowerCase()).filter(Boolean));
        const missing = published.filter((c) => !String(c.brochureUrl ?? '').trim() && !covered.has(String(c.slug ?? '').toLowerCase()));
        return {
          active: list.length,
          publishedCourses: published.length,
          withoutBrochure: missing.length,
          missing: missing.slice(0, 8).map((c) => ({ id: String(c.id), title: String(c.title ?? '') })),
          truncated: brochureRead.truncated || courseRead.truncated,
        };
      })
    : undefined;
  const [statuses, flags, byCategory, counts, recent, demandOut, batchesOut, brochuresOut] = await Promise.all([
    jobs.statuses,
    jobs.flags,
    jobs.byCategory,
    jobs.counts,
    jobs.recent,
    demand,
    batches,
    brochures,
  ]);
  return {
    generatedAt: now.toISOString(),
    range: rangeOut(r),
    statuses,
    flags,
    byCategory,
    counts,
    recent,
    ...(demandOut ? { demand: demandOut } : {}),
    ...(batchesOut ? { batches: batchesOut } : {}),
    ...(brochuresOut ? { brochures: brochuresOut } : {}),
  };
}

/* ── Website ──────────────────────────────────────────────────────────────── */

export async function websiteOverview(now = new Date()) {
  const [comparisons, legal, localities, faqs, roadmaps, gallery, faqScopes, galleryCategories, recent] = await Promise.all([
    section('comparisons', () => contentStatuses(asRepo(comparisonRepo))),
    section('legal pages', () => contentStatuses(asRepo(legalDocRepo))),
    section('localities', () => activeCounts(asRepo(localityRepo))),
    section('faqs', () => activeCounts(asRepo(faqRepo))),
    section('roadmaps', () => activeCounts(asRepo(roadmapRepo))),
    section('gallery', () => activeCounts(asRepo(galleryRepo))),
    section('faq scopes', () => fieldBreakdown(asRepo(faqRepo), 'scope', { isActive: true }, TOP, 'General')),
    section('gallery categories', () => fieldBreakdown(asRepo(galleryRepo), 'category', { isActive: true }, TOP, 'Uncategorised')),
    section('website recent', () =>
      latest(
        [
          { kind: 'comparisons', repo: asRepo(comparisonRepo), title: 'title' },
          { kind: 'legal', repo: asRepo(legalDocRepo), title: 'title' },
          { kind: 'localities', repo: asRepo(localityRepo), title: 'name' },
          { kind: 'faqs', repo: asRepo(faqRepo), title: 'question' },
          { kind: 'roadmaps', repo: asRepo(roadmapRepo), title: 'course' },
          { kind: 'gallery', repo: asRepo(galleryRepo), title: 'title' },
        ],
        'updatedAt',
      ),
    ),
  ]);
  return { generatedAt: now.toISOString(), comparisons, legal, localities, faqs, roadmaps, gallery, faqScopes, galleryCategories, recent };
}

/* ── People & proof ───────────────────────────────────────────────────────── */

/** Stars 1–5 among active testimonials, with the average. Pure. */
export function starSpread(values: readonly unknown[]): { counts: number[]; rated: number; average: number | null } {
  const counts = [0, 0, 0, 0, 0];
  let sum = 0;
  let rated = 0;
  for (const v of values) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 5) continue;
    counts[Math.round(n) - 1] += 1;
    sum += n;
    rated += 1;
  }
  return { counts, rated, average: rated ? sum / rated : null };
}

export async function peopleOverview(now = new Date()) {
  const [trainers, testimonials, placements, companies, stars, byCompany, byCourse, recent] = await Promise.all([
    section('trainers', async () => ({ ...(await activeCounts(asRepo(trainerRepo))), featured: await trainerRepo.count({ featured: true }) })),
    section('testimonials', async () => ({ ...(await activeCounts(asRepo(testimonialRepo))), featured: await testimonialRepo.count({ featured: true }) })),
    section('placements', () => activeCounts(asRepo(placementRepo))),
    section('companies', () => activeCounts(asRepo(companyRepo))),
    section('testimonial stars', async () => {
      const { rows, truncated } = await readRows(asRepo(testimonialRepo), ['stars'], { isActive: true });
      return { ...starSpread(rows.map((r) => r.stars)), truncated };
    }),
    section('placements by company', () => fieldBreakdown(asRepo(placementRepo), 'company', { isActive: true }, TOP, 'Not given')),
    section('placements by course', () => fieldBreakdown(asRepo(placementRepo), 'course', { isActive: true }, TOP, 'Not given')),
    section('people recent', () =>
      latest(
        [
          { kind: 'trainers', repo: asRepo(trainerRepo), title: 'name' },
          { kind: 'testimonials', repo: asRepo(testimonialRepo), title: 'name' },
          { kind: 'placements', repo: asRepo(placementRepo), title: 'name' },
          { kind: 'companies', repo: asRepo(companyRepo), title: 'name' },
        ],
        'createdAt',
      ),
    ),
  ]);
  return { generatedAt: now.toISOString(), trainers, testimonials, placements, companies, stars, byCompany, byCourse, recent };
}
