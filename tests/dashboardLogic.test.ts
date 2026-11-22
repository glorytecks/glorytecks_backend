import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketByDay,
  dayKey,
  mergeActivity,
  parseBatchDate,
  trendWindow,
  unresolvedFailures,
  type ActivityItem,
} from '../src/services/dashboard.service';
import { scopeStats, type DashboardStatsData } from '../src/controllers/dashboard.controller';
import type { ISiteRefreshEntry } from '../src/interfaces/common';

/**
 * The dashboard's arithmetic, without HTTP: how dates are read and bucketed,
 * which refresh failures still matter, and what each role is handed. These
 * decide whether a number on the screen is true, so they are pinned exactly.
 */

/* ── batch dates (free text in the database) ──────────────────────────────── */

test('batch dates: ISO dates are read as written', () => {
  assert.equal(parseBatchDate('2026-06-10'), '2026-06-10');
  assert.equal(parseBatchDate(' 2026-06-10 '), '2026-06-10');
});

test('batch dates: written-out dates are read on their calendar day', () => {
  assert.equal(parseBatchDate('Jun 10, 2026'), '2026-06-10');
  assert.equal(parseBatchDate('10 June 2026'), '2026-06-10');
});

test('batch dates: anything else is unreadable, never guessed', () => {
  for (const text of ['', 'TBA', 'Next month', '2026-02-30', '10/06/2026', 'Batch 5', 'June', null, undefined]) {
    assert.equal(parseBatchDate(text as string), null, String(text));
  }
});

/* ── calendar days at the caller's offset ─────────────────────────────────── */

test('dayKey reads the calendar date at a fixed UTC offset', () => {
  const ms = Date.parse('2026-10-23T20:00:00.000Z');
  assert.equal(dayKey(ms, 0), '2026-10-23');
  assert.equal(dayKey(ms, 330), '2026-10-24', 'IST is already the next day at 01:30');
  assert.equal(dayKey(ms, -300), '2026-10-23');
});

test('trendWindow covers N calendar days ending today, and the N days before', () => {
  const now = new Date('2026-10-24T06:00:00.000Z'); // 11:30 in IST
  const w = trendWindow(7, 330, now);
  assert.deepEqual(w.dates, ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  assert.equal(w.from, '2026-10-17T18:30:00.000Z', 'midnight IST on the first day');
  assert.equal(w.previousFrom, '2026-10-10T18:30:00.000Z');
  assert.equal(w.to, now.toISOString());
});

test('bucketByDay counts each instant on its local calendar day and ignores the rest', () => {
  const dates = ['2026-10-22', '2026-10-23', '2026-10-24'];
  const counts = bucketByDay(
    [
      '2026-10-22T10:00:00.000Z',
      '2026-10-23T19:00:00.000Z', // 00:30 on the 24th in IST
      '2026-10-24T01:00:00.000Z',
      '2026-10-20T10:00:00.000Z', // before the window
      'not a date',
      null,
    ],
    dates,
    330,
  );
  assert.deepEqual(counts, [1, 0, 2]);
});

/* ── site refresh failures ────────────────────────────────────────────────── */

const row = (status: 'sent' | 'failed', tags: string[], at: string): ISiteRefreshEntry => ({
  id: `${status}-${at}`,
  resource: 'blogs',
  tags,
  status,
  attempts: status === 'failed' ? 2 : 1,
  reason: status === 'failed' ? 'HTTP 503' : null,
  createdAt: at,
});

test('a failed refresh stays unresolved until a later success covers all of its tags', () => {
  const newestFirst = [
    row('sent', ['courses'], '2026-10-24T10:00:00.000Z'), // a different page: does not help
    row('failed', ['blogs', 'blog:a'], '2026-10-24T09:00:00.000Z'),
    row('sent', ['blogs', 'blog:b', 'blog:c'], '2026-10-24T08:00:00.000Z'),
    row('failed', ['blogs', 'blog:b'], '2026-10-24T07:00:00.000Z'), // covered by 08:00
  ];
  const open = unresolvedFailures(newestFirst);
  assert.deepEqual(open.map((r) => r.tags), [['blogs', 'blog:a']]);
});

test('an earlier success never resolves a later failure', () => {
  const newestFirst = [row('failed', ['blogs'], '2026-10-24T09:00:00.000Z'), row('sent', ['blogs'], '2026-10-24T08:00:00.000Z')];
  assert.equal(unresolvedFailures(newestFirst).length, 1);
});

/* ── activity ─────────────────────────────────────────────────────────────── */

test('activity from both logs is merged newest first and capped', () => {
  const seo = (at: string): ActivityItem => ({
    kind: 'seo', id: `seo-${at}`, at, action: 'update', entityType: 'page_seo', path: '/', recordId: null, changedFields: ['metaTitle'], editor: 'A',
  });
  const site = (at: string): ActivityItem => ({
    kind: 'site', id: `site-${at}`, at, status: 'sent', resource: 'blogs', tags: ['blogs'], reason: null, attempts: 1,
  });
  const merged = mergeActivity(
    [
      [seo('2026-10-24T09:00:00.000Z'), seo('2026-10-24T07:00:00.000Z')],
      [site('2026-10-24T08:00:00.000Z'), site('')],
    ],
    2,
  );
  assert.deepEqual(merged.map((i) => i.id), ['seo-2026-10-24T09:00:00.000Z', 'site-2026-10-24T08:00:00.000Z']);
});

/* ── what each role is handed from the shared stats cache ─────────────────── */

const cached = (): DashboardStatsData => ({
  generatedAt: '2026-10-24T09:00:00.000Z',
  counts: {
    blogs: 3, publishedBlogs: 2, draftBlogs: 1, courses: 2, publishedCourses: 1, draftCourses: 1,
    trainers: 0, testimonials: 0, placements: 0, companies: 0, categories: 0,
    enquiries: 4, newEnquiries: 2, demoRequests: 1, newDemoRequests: 1, chatEnquiries: 0, newChatEnquiries: 0,
    gallery: 0, brochures: 0, mediaAssets: 0,
  },
  recent: {
    blogs: [{ id: 'b', title: 'Draft title' }] as never,
    courses: [{ id: 'c', title: 'Draft course' }] as never,
    enquiries: [{ id: 'e', name: 'Lead name', email: 'lead@x.invalid' }] as never,
    demoRequests: [{ id: 'd', name: 'Lead name', phone: '+911234567890' }] as never,
  },
});

test('scopeStats empties the lists a role may not read, and keeps the counts', () => {
  const expectations: Record<string, { content: boolean; leads: boolean }> = {
    admin: { content: true, leads: true },
    content_writer: { content: true, leads: false },
    receptionist: { content: false, leads: true },
    editor: { content: false, leads: false },
    viewer: { content: false, leads: false },
  };
  for (const [role, may] of Object.entries(expectations)) {
    const out = scopeStats(cached(), role as never);
    assert.equal(out.recent.blogs.length, may.content ? 1 : 0, `${role} blogs`);
    assert.equal(out.recent.courses.length, may.content ? 1 : 0, `${role} courses`);
    assert.equal(out.recent.enquiries.length, may.leads ? 1 : 0, `${role} enquiries`);
    assert.equal(out.recent.demoRequests.length, may.leads ? 1 : 0, `${role} demo requests`);
    assert.equal(out.counts.newEnquiries, 2, `${role} keeps the headline counts`);
    assert.equal(out.cacheTtlSeconds, 120);
    assert.equal(out.generatedAt, '2026-10-24T09:00:00.000Z');
  }
  assert.deepEqual(scopeStats(cached(), undefined).recent.enquiries, [], 'no role, no leads');
});

test('scopeStats never mutates the cached payload it is given', () => {
  const data = cached();
  const before = JSON.stringify(data);
  scopeStats(data, 'viewer' as never);
  scopeStats(data, 'receptionist' as never);
  assert.equal(JSON.stringify(data), before);
});

test('an entry cached before recent courses existed still scopes cleanly', () => {
  const data = cached();
  delete (data.recent as { courses?: unknown }).courses;
  assert.deepEqual(scopeStats(data, 'admin' as never).recent.courses, []);
});
