/**
 * The processing ledger for the blog rewrite programme (Phase 11,
 * docs/BLOG_REWRITE_FINAL_REPORT.md). Pure: no I/O. `blog-status.ts` and
 * `blog-publish.ts` read and write the ledger file.
 *
 * One entry per article, keyed by the article's database id. Each entry
 * carries its batch, timestamps, word counts, validation results, the
 * Supabase write result and an append-only history of every status change,
 * so any article's path can be traced and a crashed run resumed.
 *
 *   pending ─► rewritten ─► validated ─► processing ─► supabase_updated
 *                  │            │             │
 *                  └──────┬─────┴─────► failed (retryable: → validated)
 *                         ▼
 *                    needs_review
 *
 *   pending ─► merge_candidate | noindex_candidate | needs_review   (from the audit)
 *
 * `processing` means a database write is in flight. A run that finds an entry
 * left in `processing` (a crash mid-write) re-reads the row and settles it as
 * `supabase_updated` or `failed` before doing anything else.
 */

export const PROCESSING_STATUSES = [
  'pending',
  'rewritten',
  'validated',
  'processing',
  'supabase_updated',
  'failed',
  'needs_review',
  'merge_candidate',
  'noindex_candidate',
] as const;

export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/** Terminal for the rewrite programme: the job is done when every article is in one of these. */
export const SETTLED: readonly ProcessingStatus[] = ['supabase_updated', 'needs_review', 'merge_candidate', 'noindex_candidate', 'failed'];

export const TRANSITIONS: Readonly<Record<ProcessingStatus, readonly ProcessingStatus[]>> = {
  pending: ['rewritten', 'needs_review', 'merge_candidate', 'noindex_candidate'],
  rewritten: ['validated', 'needs_review', 'rewritten'],
  validated: ['processing', 'needs_review', 'rewritten'],
  processing: ['supabase_updated', 'failed'],
  supabase_updated: ['needs_review', 'rewritten'],
  failed: ['validated', 'needs_review', 'rewritten'],
  needs_review: ['rewritten', 'merge_candidate', 'noindex_candidate', 'pending'],
  merge_candidate: ['rewritten', 'needs_review', 'pending'],
  noindex_candidate: ['rewritten', 'needs_review', 'pending'],
};

export interface HistoryEvent {
  at: string;
  from: ProcessingStatus | string | null;
  to: ProcessingStatus;
  by: string;
  note: string;
}

export interface CheckResult {
  ok: boolean;
  failures: string[];
  checkedAt: string;
}

export interface LedgerEntry {
  id: string;
  slug: string;
  status: ProcessingStatus;
  batch?: string;
  startedAt?: string;
  completedAt?: string;
  wordsBefore?: number;
  wordsAfter?: number;
  quality?: CheckResult;
  metadata?: CheckResult;
  supabase?: { result: 'updated' | 'failed' | 'rolled_back'; at: string; verified: boolean; updatedAt?: string; snapshot?: string };
  error?: string;
  updatedAt: string;
  history: HistoryEvent[];
}

export interface Ledger {
  version: 2;
  articles: Record<string, LedgerEntry>;
}

export const isStatus = (value: unknown): value is ProcessingStatus =>
  typeof value === 'string' && (PROCESSING_STATUSES as readonly string[]).includes(value);

/** A new ledger with every article `pending`. */
export function seedLedger(rows: readonly { id: string; slug: string }[], at: string, by: string): Ledger {
  const articles: Record<string, LedgerEntry> = {};
  for (const { id, slug } of rows) {
    articles[id] = { id, slug, status: 'pending', updatedAt: at, history: [{ at, from: null, to: 'pending', by, note: 'Added to the ledger.' }] };
  }
  return { version: 2, articles };
}

export interface TransitionInput {
  to: ProcessingStatus;
  by: string;
  note: string;
  at: string;
  batch?: string;
}

/**
 * Move one article to a new status, recording who and why. Mutates the ledger
 * only when the move is allowed; returns the reason when it is not.
 */
export function transition(ledger: Ledger, id: string, input: TransitionInput): string | null {
  const entry = ledger.articles[id];
  if (!entry) return `no ledger entry for ${id}`;
  if (!input.by.trim()) return 'a transition must say who made it (--by)';
  if (!input.note.trim()) return 'a transition must say why (--note)';
  if (!TRANSITIONS[entry.status].includes(input.to)) {
    return `${entry.slug}: ${entry.status} → ${input.to} is not allowed (allowed: ${TRANSITIONS[entry.status].join(', ') || 'none'})`;
  }
  entry.history.push({ at: input.at, from: entry.status, to: input.to, by: input.by, note: input.note });
  entry.status = input.to;
  entry.updatedAt = input.at;
  if (input.batch) entry.batch = input.batch;
  return null;
}

/** Where the audit's recommended action leaves an article before any rewrite. */
export function statusForAction(action: string): ProcessingStatus {
  switch (action.trim().toUpperCase()) {
    case 'MERGE':
    case 'REDIRECT':
      return 'merge_candidate';
    case 'NOINDEX':
      return 'noindex_candidate';
    case 'MANUAL REVIEW':
      return 'needs_review';
    default:
      return 'pending';
  }
}

/** Articles a run may pick up, in a stable order: pending first, then retryable failures when asked. */
export function nextToProcess(ledger: Ledger, opts: { retryFailed?: boolean } = {}): LedgerEntry[] {
  return Object.values(ledger.articles)
    .filter((e) => e.status === 'pending' || (opts.retryFailed && e.status === 'failed'))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Entries left mid-write by a crashed run. They must be settled before anything else. */
export const inFlight = (ledger: Ledger): LedgerEntry[] => Object.values(ledger.articles).filter((e) => e.status === 'processing');

/** Why an article may not be written to the database now, or null when it may. */
export function writeBlocker(entry: LedgerEntry | undefined): string | null {
  if (!entry) return 'article is not in the processing ledger';
  if (entry.status !== 'validated') return `ledger status is "${entry.status}", not "validated"`;
  return null;
}

export function countByStatus(ledger: Ledger): Record<ProcessingStatus, number> {
  const counts = Object.fromEntries(PROCESSING_STATUSES.map((s) => [s, 0])) as Record<ProcessingStatus, number>;
  for (const entry of Object.values(ledger.articles)) counts[entry.status] += 1;
  return counts;
}

/** The job is finished when no article is pending, rewritten, validated or in flight. */
export const unsettled = (ledger: Ledger): LedgerEntry[] => Object.values(ledger.articles).filter((e) => !SETTLED.includes(e.status));

/** Shape check for a ledger read from disk. */
export function ledgerProblem(value: unknown): string | null {
  const l = value as Partial<Ledger> | null;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'not a JSON object';
  if (l.version !== 2) return `version must be 2 (found ${String(l.version)}; run blog-status.ts migrate)`;
  if (!l.articles || typeof l.articles !== 'object') return 'articles is required';
  for (const [id, e] of Object.entries(l.articles)) {
    if (!e || e.id !== id) return `entry ${id} has a mismatched id`;
    if (!isStatus(e.status)) return `entry ${id} has an unknown status "${String(e.status)}"`;
    if (!Array.isArray(e.history) || e.history.length === 0) return `entry ${id} has no history`;
    if (e.history[e.history.length - 1].to !== e.status) return `entry ${id}: status does not match its last history event`;
  }
  return null;
}

/**
 * Version 1 ledgers (Phase 11 batch 1) used a different status set. Map them
 * onto version 2, keeping every history event and recording the migration.
 *   analyzed → pending · approved_for_rewrite → pending · quality_checked → validated
 *   published → supabase_updated · redirected → merge_candidate (already 301'd in Phase 1)
 *   needs_review with a saved rewrite → rewritten (to be re-validated) · otherwise unchanged
 */
export function migrateV1(v1: { version: 1; articles: Record<string, { id: string; slug: string; status: string; batch?: string; updatedAt: string; history: HistoryEvent[] }> }, rewritten: ReadonlySet<string>, at: string, by: string): Ledger {
  const map: Record<string, ProcessingStatus> = {
    pending: 'pending',
    analyzed: 'pending',
    approved_for_rewrite: 'pending',
    rewritten: 'rewritten',
    quality_checked: 'validated',
    published: 'supabase_updated',
    needs_review: 'needs_review',
    merge_candidate: 'merge_candidate',
    noindex_candidate: 'noindex_candidate',
    redirected: 'merge_candidate',
  };
  const articles: Record<string, LedgerEntry> = {};
  for (const [id, e] of Object.entries(v1.articles)) {
    let to = map[e.status] ?? 'pending';
    if (rewritten.has(id) && (e.status === 'needs_review' || e.status === 'rewritten')) to = 'rewritten';
    const note =
      e.status === 'redirected'
        ? 'Ledger v2 migration: already merged and 301-redirected in Phase 1; kept as merge_candidate so it is never rewritten.'
        : `Ledger v2 migration from "${e.status}".`;
    articles[id] = {
      id,
      slug: e.slug,
      status: to,
      ...(e.batch ? { batch: e.batch } : {}),
      updatedAt: at,
      history: [...e.history, { at, from: e.status, to, by, note }],
    };
  }
  return { version: 2, articles };
}

/**
 * Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, embedded commas
 * and newlines), enough for the audit CSVs the website package writes.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
