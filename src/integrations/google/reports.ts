import type { GscRow } from './searchConsole';

/**
 * Pure report arithmetic for the Search Console and GA4 views: date windows,
 * period totals, comparisons, gains and drops, and the "worth reviewing"
 * lists. No I/O, so every number the admin shows can be tested from fixtures.
 *
 * Nothing here estimates rankings or traffic. Comparisons are between the
 * same metric in two equal periods; a missing previous value is "not
 * comparable", never zero.
 */

export const RANGES = [7, 28, 90] as const;
export type RangeDays = (typeof RANGES)[number];

/* ── Dates ────────────────────────────────────────────────────────────────── */

const DAY = 86_400_000;

/** YYYY-MM-DD for an instant, in a time zone. */
export function dateInZone(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Shift a calendar date by whole days (no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY).toISOString().slice(0, 10);
}

export interface Period {
  startDate: string;
  endDate: string;
}

/** The current period ending on `end` (inclusive), and the equal period just before it. */
export function periods(end: string, days: number): { current: Period; previous: Period } {
  const start = addDays(end, -(days - 1));
  return {
    current: { startDate: start, endDate: end },
    previous: { startDate: addDays(start, -days), endDate: addDays(start, -1) },
  };
}

/** Every date of a period, oldest first. */
export function datesOf(p: Period): string[] {
  const out: string[] = [];
  for (let d = p.startDate; d <= p.endDate; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Search Console reports days in Pacific Time. */
export const GSC_TIME_ZONE = 'America/Los_Angeles';

/* ── Comparisons ──────────────────────────────────────────────────────────── */

export interface Change {
  current: number;
  previous: number | null;
  /** current − previous; null when there is nothing to compare with. */
  delta: number | null;
  /** Relative change in percent; null when previous is null or zero. */
  pct: number | null;
}

export function change(current: number, previous: number | null): Change {
  if (previous === null) return { current, previous: null, delta: null, pct: null };
  return { current, previous, delta: current - previous, pct: previous !== 0 ? ((current - previous) / previous) * 100 : null };
}

/* ── Search Console ───────────────────────────────────────────────────────── */

export interface GscTotals {
  clicks: number;
  impressions: number;
  /** clicks / impressions, 0–1. */
  ctr: number;
  /** Impression-weighted average position, as Search Console averages it; null without impressions. */
  position: number | null;
}

/** Totals over rows (e.g. one per day): clicks and impressions add; CTR and position are recomputed. */
export function gscTotals(rows: readonly Pick<GscRow, 'clicks' | 'impressions' | 'position'>[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weighted += r.position * r.impressions;
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? weighted / impressions : null };
}

export interface GscDay {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

/** One entry per day of the period; a day with no row had no impressions (Search Console omits empty days). */
export function gscDaily(rows: readonly GscRow[], p: Period): GscDay[] {
  const byDate = new Map(rows.map((r) => [r.keys[0], r]));
  return datesOf(p).map((date) => {
    const r = byDate.get(date);
    return r
      ? { date, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }
      : { date, clicks: 0, impressions: 0, ctr: 0, position: null };
  });
}

export interface GscItem {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export const toItems = (rows: readonly GscRow[]): GscItem[] =>
  rows.map((r) => ({ key: r.keys[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

export interface Mover {
  key: string;
  clicks: Change;
  impressions: Change;
  position: { current: number; previous: number };
}

/**
 * Biggest gains and drops in clicks among items that appear in BOTH periods'
 * lists. An item in only one list may simply have fallen below the list's
 * cut-off in the other period, so it is not called a gain or a drop.
 */
export function movers(current: readonly GscItem[], previous: readonly GscItem[], n = 5): { gains: Mover[]; drops: Mover[] } {
  const before = new Map(previous.map((i) => [i.key, i]));
  const both: Mover[] = [];
  for (const now of current) {
    const was = before.get(now.key);
    if (!was) continue;
    both.push({
      key: now.key,
      clicks: change(now.clicks, was.clicks),
      impressions: change(now.impressions, was.impressions),
      position: { current: now.position, previous: was.position },
    });
  }
  const delta = (m: Mover) => m.clicks.delta ?? 0;
  return {
    gains: both.filter((m) => delta(m) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, n),
    drops: both.filter((m) => delta(m) < 0).sort((a, b) => delta(a) - delta(b)).slice(0, n),
  };
}

export interface ReviewItem {
  key: string;
  /** Why it is listed; the admin puts it into words from the numbers below. */
  reason: 'near-first-page' | 'low-ctr-on-first-page' | 'clicks-dropped';
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** clicks-dropped only: clicks in the previous period. */
  previousClicks: number | null;
}

/** Thresholds for the "worth reviewing" lists — suggestions for a person, not predictions. */
export const REVIEW_THRESHOLDS = {
  // Past the first ten results: positions 1–10 are page one, where low CTR is the signal instead.
  nearFirstPage: { minPosition: 10.5, maxPosition: 20, minImpressions: 50 },
  lowCtr: { maxPosition: 10, minImpressions: 200, maxCtr: 0.01 },
  dropped: { minPreviousClicks: 10, minDropPct: 30 },
};

/**
 * Queries or pages a person may want to look at, each with the reason it was
 * picked. These are prompts for review based on Search Console's own numbers;
 * they do not predict what a change would do.
 */
export function worthReviewing(current: readonly GscItem[], previous: readonly GscItem[], n = 10): ReviewItem[] {
  const t = REVIEW_THRESHOLDS;
  const out: ReviewItem[] = [];
  const seen = new Set<string>();
  const add = (i: GscItem, reason: ReviewItem['reason'], previousClicks: number | null = null) => {
    if (seen.has(i.key)) return;
    seen.add(i.key);
    out.push({ key: i.key, reason, clicks: i.clicks, impressions: i.impressions, ctr: i.ctr, position: i.position, previousClicks });
  };

  const byImpressions = [...current].sort((a, b) => b.impressions - a.impressions);
  const before = new Map(previous.map((i) => [i.key, i]));
  for (const i of byImpressions) {
    const was = before.get(i.key);
    if (was && was.clicks >= t.dropped.minPreviousClicks && i.clicks <= was.clicks * (1 - t.dropped.minDropPct / 100)) {
      add(i, 'clicks-dropped', was.clicks);
    }
  }
  for (const i of byImpressions) {
    if (i.position <= t.lowCtr.maxPosition && i.impressions >= t.lowCtr.minImpressions && i.ctr < t.lowCtr.maxCtr) add(i, 'low-ctr-on-first-page');
  }
  for (const i of byImpressions) {
    if (i.position >= t.nearFirstPage.minPosition && i.position <= t.nearFirstPage.maxPosition && i.impressions >= t.nearFirstPage.minImpressions) {
      add(i, 'near-first-page');
    }
  }
  return out.slice(0, n);
}

/* ── GA4 ──────────────────────────────────────────────────────────────────── */

/** The GA4 metrics the visitor view shows, by their Data API names. */
export const GA4_TOTAL_METRICS = ['activeUsers', 'sessions', 'screenPageViews', 'engagedSessions', 'engagementRate', 'keyEvents'] as const;
export type Ga4TotalMetric = (typeof GA4_TOTAL_METRICS)[number];

/** GA4 dates come as YYYYMMDD. */
export const ga4Date = (yyyymmdd: string): string =>
  /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : yyyymmdd;
