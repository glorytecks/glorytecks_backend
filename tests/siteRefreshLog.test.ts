import './setup';
import { DB, MISSING, REQUESTS, SITE_HOST, resetDb, site } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSiteRefresh, resetSiteRefreshLogPause } from '../src/lib/siteRefreshLog';
import { invalidateResource } from '../src/lib/cacheInvalidation';

/**
 * Site refresh outcomes are recorded so the admin dashboard can show a refresh
 * that failed. Recording must never fail a CMS write, must store nothing but
 * the resource, the public tags and a short reason, and must stop trying when
 * the table has not been created yet.
 */

const SECRET = 'site-refresh-log-test-secret-0123456789abcdef';
const logWrites = () => REQUESTS.filter((r) => r === 'POST site_refresh_log');

test.beforeEach(() => {
  resetDb({ site_refresh_log: [] });
  resetSiteRefreshLogPause();
  process.env.SITE_REVALIDATE_URL = '';
  process.env.SITE_REVALIDATE_SECRET = '';
});

test('a skipped notification is not a refresh and is not recorded', async () => {
  await recordSiteRefresh('blogs', [], { status: 'skipped', reason: 'no public change' });
  await recordSiteRefresh('blogs', ['blogs'], { status: 'skipped', reason: 'SITE_REVALIDATE_URL is not set' });
  assert.deepEqual(logWrites(), []);
});

test('a sent refresh is recorded with its tags and HTTP status', async () => {
  await recordSiteRefresh('blogs', ['blogs', 'blog:p'], { status: 'sent', httpStatus: 200, attempts: 1 });
  assert.equal(DB.site_refresh_log.length, 1);
  const row = DB.site_refresh_log[0];
  assert.equal(row.resource, 'blogs');
  assert.deepEqual(row.tags, ['blogs', 'blog:p']);
  assert.equal(row.status, 'sent');
  assert.equal(row.http_status, 200);
  assert.equal(row.reason, null);
  assert.equal(row.attempts, 1);
});

test('a failed refresh is recorded with its reason', async () => {
  await recordSiteRefresh('courses', ['courses'], { status: 'failed', reason: 'timed out after 4000 ms', attempts: 2 });
  const row = DB.site_refresh_log[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.reason, 'timed out after 4000 ms');
  assert.equal(row.http_status, null);
  assert.equal(row.attempts, 2);
});

test('before the migration is applied, recording pauses instead of failing every save', async () => {
  MISSING.add('site_refresh_log');
  await recordSiteRefresh('blogs', ['blogs'], { status: 'sent', httpStatus: 200, attempts: 1 });
  await recordSiteRefresh('blogs', ['blogs'], { status: 'sent', httpStatus: 200, attempts: 1 });
  assert.equal(logWrites().length, 1, 'the second save does not try again');
});

test('a CMS save whose site refresh fails leaves a failed row, and the save still completes', async () => {
  process.env.SITE_REVALIDATE_URL = `https://${SITE_HOST}/api/revalidate`;
  process.env.SITE_REVALIDATE_SECRET = SECRET;
  site.answer = { status: 503 };
  const published = { slug: 'p', status: 'published', title: 'T' };

  await invalidateResource('blogs', { before: null, after: published });

  assert.equal(DB.site_refresh_log.length, 1);
  const row = DB.site_refresh_log[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.reason, 'HTTP 503');
  // A publish refreshes the archive and the post, not every page (2026-11-09).
  assert.deepEqual(row.tags, ['blog-index', 'blog:p']);
  assert.ok(!JSON.stringify(row).includes(SECRET), 'the secret is never stored');
});
