import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCESSING_STATUSES,
  TRANSITIONS,
  countByStatus,
  inFlight,
  ledgerProblem,
  migrateV1,
  nextToProcess,
  parseCsv,
  seedLedger,
  statusForAction,
  transition,
  unsettled,
  writeBlocker,
} from '../src/scripts/lib/blogStatus';

/**
 * The processing ledger decides what a run may write and lets a crashed run
 * resume, so its transitions, the write gate and resume logic are pinned here.
 */

const at = '2026-09-24T00:00:00.000Z';
const fresh = () => seedLedger([{ id: 'a', slug: 'alpha' }, { id: 'b', slug: 'beta' }], at, 'test');
const move = (l: ReturnType<typeof fresh>, id: string, to: (typeof PROCESSING_STATUSES)[number]) =>
  transition(l, id, { to, by: 'editor', note: 'because', at });

test('a new ledger starts every article as pending, with a history', () => {
  const l = fresh();
  assert.equal(l.version, 2);
  assert.equal(l.articles.a.status, 'pending');
  assert.equal(ledgerProblem(l), null);
  assert.equal(countByStatus(l).pending, 2);
  assert.equal(unsettled(l).length, 2);
});

test('the write path is pending → rewritten → validated → processing → supabase_updated, recorded', () => {
  const l = fresh();
  for (const to of ['rewritten', 'validated', 'processing', 'supabase_updated'] as const) assert.equal(move(l, 'a', to), null, to);
  assert.deepEqual(l.articles.a.history.map((h) => h.to), ['pending', 'rewritten', 'validated', 'processing', 'supabase_updated']);
  assert.equal(ledgerProblem(l), null);
});

test('nothing reaches the database without passing validation', () => {
  const l = fresh();
  assert.match(String(move(l, 'a', 'processing')), /not allowed/);
  move(l, 'a', 'rewritten');
  assert.match(String(move(l, 'a', 'processing')), /not allowed/);
  assert.match(String(writeBlocker(l.articles.a)), /"rewritten"/);
  move(l, 'a', 'validated');
  assert.equal(writeBlocker(l.articles.a), null);
  assert.match(String(writeBlocker(undefined)), /not in the processing ledger/);
});

test('a write in flight can only settle as updated or failed, and a failure is retryable after validation', () => {
  const l = fresh();
  for (const to of ['rewritten', 'validated', 'processing'] as const) move(l, 'a', to);
  assert.deepEqual(inFlight(l).map((e) => e.id), ['a']);
  assert.match(String(move(l, 'a', 'needs_review')), /not allowed/);
  assert.equal(move(l, 'a', 'failed'), null);
  assert.equal(move(l, 'a', 'validated'), null);
});

test('resume picks pending articles, and failed ones only when asked', () => {
  const l = fresh();
  for (const to of ['rewritten', 'validated', 'processing', 'failed'] as const) move(l, 'a', to);
  assert.deepEqual(nextToProcess(l).map((e) => e.slug), ['beta']);
  assert.deepEqual(nextToProcess(l, { retryFailed: true }).map((e) => e.slug), ['alpha', 'beta']);
});

test('every transition needs a who and a why', () => {
  const l = fresh();
  assert.match(String(transition(l, 'a', { to: 'rewritten', by: '', note: 'x', at })), /who/);
  assert.match(String(transition(l, 'a', { to: 'rewritten', by: 'x', note: ' ', at })), /why/);
  assert.match(String(transition(l, 'zzz', { to: 'rewritten', by: 'x', note: 'x', at })), /no ledger entry/);
  for (const s of PROCESSING_STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), s);
});

test('audit actions map to the right starting status', () => {
  assert.equal(statusForAction('DEEP REWRITE'), 'pending');
  assert.equal(statusForAction('MERGE'), 'merge_candidate');
  assert.equal(statusForAction('REDIRECT'), 'merge_candidate');
  assert.equal(statusForAction('NOINDEX'), 'noindex_candidate');
  assert.equal(statusForAction('MANUAL REVIEW'), 'needs_review');
});

test('a version 1 ledger migrates with its history, and saved rewrites become rewritten', () => {
  const v1 = {
    version: 1 as const,
    articles: {
      a: { id: 'a', slug: 'alpha', status: 'needs_review', updatedAt: at, history: [{ at, from: null, to: 'needs_review', by: 'x', note: 'y' }] },
      b: { id: 'b', slug: 'beta', status: 'analyzed', updatedAt: at, history: [{ at, from: null, to: 'analyzed', by: 'x', note: 'y' }] },
      c: { id: 'c', slug: 'gamma', status: 'redirected', updatedAt: at, history: [{ at, from: null, to: 'redirected', by: 'x', note: 'y' }] },
      d: { id: 'd', slug: 'delta', status: 'needs_review', updatedAt: at, history: [{ at, from: null, to: 'needs_review', by: 'x', note: 'y' }] },
    },
  };
  const v2 = migrateV1(v1 as never, new Set(['a']), at, 'migration');
  assert.equal(ledgerProblem(v2), null);
  assert.deepEqual([v2.articles.a.status, v2.articles.b.status, v2.articles.c.status, v2.articles.d.status], ['rewritten', 'pending', 'merge_candidate', 'needs_review']);
  assert.equal(v2.articles.a.history.length, 2);
  assert.match(String(ledgerProblem({ version: 1 })), /version must be 2/);
});

test('a ledger whose status disagrees with its history is rejected', () => {
  const l = fresh();
  l.articles.a.status = 'supabase_updated';
  assert.match(String(ledgerProblem(l)), /does not match/);
});

test('the CSV reader handles quotes, commas and newlines inside fields', () => {
  const rows = parseCsv('id,recommended_action,action_reason\r\na,DEEP REWRITE,"Template body, 99% shared"\nb,MERGE,"Line one\nline ""two"""\n');
  assert.deepEqual(rows, [
    { id: 'a', recommended_action: 'DEEP REWRITE', action_reason: 'Template body, 99% shared' },
    { id: 'b', recommended_action: 'MERGE', action_reason: 'Line one\nline "two"' },
  ]);
});
