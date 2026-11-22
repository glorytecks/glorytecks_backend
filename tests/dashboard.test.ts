import './setup';
import { DB, FAILING, MISSING, SITE_HITS, SITE_HOST, SUBJECT, resetDb, site } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { resetSiteProbeMemo } from '../src/lib/siteProbe';
import { dayKey, MAX_TREND_ROWS } from '../src/services/dashboard.service';

/**
 * The dashboard endpoints through the real middleware stack: what each role is
 * handed, what happens when one source fails or does not exist yet, and that
 * every number comes from the stored records.
 */

type Role = keyof typeof SUBJECT;
const ROLES = Object.keys(SUBJECT) as Role[];

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());

const tokenFor = (who: Role) =>
  jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });

async function get(path: string, who: Role): Promise<{ status: number; raw: string; body: any }> {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${tokenFor(who)}` } });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : null };
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const dateAgo = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

const LEAD = { name: 'LeadSentinelName', email: 'lead-sentinel@dashboard.invalid', phone: '+10000000077' };
const DRAFT_POST = 'DraftPostSentinelTitle';
const DRAFT_COURSE = 'DraftCourseSentinelTitle';
const SECRET = 'dashboard-test-revalidate-secret-0123456789abcdef';

function seed() {
  resetDb({
    contact_enquiries: [
      { id: 'e1', ...LEAD, status: 'new', created_at: ago(3 * DAY) },
      { id: 'e2', ...LEAD, status: 'new', created_at: ago(2 * HOUR) },
      { id: 'e3', ...LEAD, status: 'contacted', created_at: ago(5 * DAY) },
      { id: 'e4', ...LEAD, status: 'new', created_at: ago(40 * DAY) },
      { id: 'e5', ...LEAD, status: 'closed', created_at: ago(100 * DAY) },
    ],
    demo_requests: [{ id: 'd1', ...LEAD, status: 'new', created_at: ago(26 * HOUR) }],
    chat_enquiries: [],
    blogs: [
      { id: 'b1', title: DRAFT_POST, slug: 'draft-post', status: 'draft', updated_at: ago(30 * DAY), created_at: ago(40 * DAY) },
      { id: 'b2', title: 'Fresh draft', slug: 'fresh', status: 'draft', updated_at: ago(2 * DAY), created_at: ago(2 * DAY) },
      { id: 'b3', title: 'Live post', slug: 'live', status: 'published', updated_at: ago(DAY), published_at: ago(3 * DAY), created_at: ago(9 * DAY) },
      { id: 'b4', title: 'Old post', slug: 'old', status: 'published', updated_at: ago(70 * DAY), published_at: ago(70 * DAY), created_at: ago(70 * DAY) },
    ],
    courses: [
      { id: 'c1', title: DRAFT_COURSE, slug: 'draft-course', status: 'draft', updated_at: ago(20 * DAY), created_at: ago(20 * DAY) },
      { id: 'c2', title: 'Live course', slug: 'live-course', status: 'published', updated_at: ago(DAY), created_at: ago(90 * DAY) },
    ],
    batches: [
      { id: 'bt1', course: 'Python', start_date: dateAgo(10), is_active: true, order_index: 1 },
      { id: 'bt2', course: 'Data Science', start_date: dateAgo(-10), is_active: true, order_index: 2 },
      { id: 'bt3', course: 'Power BI', start_date: 'Jan 5, 2020', is_active: true, order_index: 3 },
      { id: 'bt4', course: 'Gen AI', start_date: 'TBA', is_active: true, order_index: 4 },
      { id: 'bt5', course: 'Retired', start_date: dateAgo(100), is_active: false, order_index: 5 },
    ],
    seo_audit_log: [
      {
        id: 'a1', entity_type: 'page_seo', entity_key: '/', record_id: null, action: 'update',
        changed_fields: ['metaTitle'], editor_id: SUBJECT.admin,
        editor: { id: SUBJECT.admin, name: 'Asha Admin' }, created_at: ago(HOUR),
      },
    ],
    site_refresh_log: [
      { id: 'r1', resource: 'blogs', tags: ['blogs', 'blog:live'], status: 'failed', reason: 'HTTP 503', http_status: null, attempts: 2, created_at: ago(2 * HOUR) },
      { id: 'r2', resource: 'courses', tags: ['courses'], status: 'sent', reason: null, http_status: 200, attempts: 1, created_at: ago(30 * 60_000) },
    ],
  });
}

test.beforeEach(() => {
  seed();
  resetSiteProbeMemo();
  process.env.SITE_REVALIDATE_URL = '';
  process.env.SITE_REVALIDATE_SECRET = '';
});

/* ── /dashboard/status ────────────────────────────────────────────────────── */

test('status: every role learns whether the site and database answer; only an admin sees integrations', async () => {
  for (const who of ROLES) {
    const { status, body } = await get('/api/v1/dashboard/status', who);
    assert.equal(status, 200, who);
    assert.equal(body.data.database.ok, true, who);
    assert.equal(body.data.site.state, 'not-configured', `${who}: no site URL in this test`);
    const adminOnly = ['integrations', 'siteRefresh', 'deployment'];
    for (const key of adminOnly) {
      assert.equal(key in body.data, who === 'admin', `${who} ${key}`);
    }
  }
});

test('status: integrations are reported as states and variable names, never values', async () => {
  process.env.SITE_REVALIDATE_URL = `https://${SITE_HOST}/api/revalidate`;
  process.env.SITE_REVALIDATE_SECRET = SECRET;
  const { body, raw } = await get('/api/v1/dashboard/status', 'admin');
  assert.ok(!raw.includes(SECRET), 'the revalidation secret never leaves the server');
  assert.ok(!raw.includes('test-service-role-key'), 'nor does any other credential');
  const byId = Object.fromEntries(body.data.integrations.map((i: { id: string }) => [i.id, i]));
  assert.deepEqual(Object.keys(byId).sort(), ['analytics', 'cache', 'search-console', 'sign-in-links', 'site-key', 'site-refresh', 'uploads']);
  // setup.ts blanks the Google variables: optional, so "not configured", with names to set.
  assert.equal(byId['search-console'].state, 'not-configured');
  assert.deepEqual(byId['search-console'].envVars, ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GSC_SITE_URL']);
  assert.deepEqual(byId.analytics.envVars, ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GA4_PROPERTY_ID']);
  assert.equal(byId['site-refresh'].state, 'ok');
  assert.equal(byId.uploads.state, 'not-configured', 'setup.ts blanks Cloudinary');
  assert.deepEqual(byId.uploads.envVars, ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);
  assert.equal(byId.cache.state, 'off', 'setup.ts disables the cache');
});

test('status: the website probe is one HEAD to the configured host, reused for five minutes', async () => {
  process.env.SITE_REVALIDATE_URL = `https://${SITE_HOST}/api/revalidate`;
  const first = await get('/api/v1/dashboard/status', 'viewer');
  assert.equal(first.body.data.site.state, 'up');
  assert.equal(first.body.data.site.httpStatus, 200);
  assert.equal(first.body.data.site.host, SITE_HOST);
  assert.deepEqual(SITE_HITS, [{ method: 'HEAD', path: '/' }]);

  await get('/api/v1/dashboard/status', 'admin');
  assert.equal(SITE_HITS.length, 1, 'the second view reuses the result');
});

test('status: a site that answers with an error, or not at all, is down — and the endpoint still answers', async () => {
  process.env.SITE_REVALIDATE_URL = `https://${SITE_HOST}/api/revalidate`;
  site.answer = { status: 503 };
  const broken = await get('/api/v1/dashboard/status', 'admin');
  assert.equal(broken.status, 200);
  assert.equal(broken.body.data.site.state, 'down');
  assert.equal(broken.body.data.site.reason, 'HTTP 503');

  resetSiteProbeMemo();
  site.answer = 'refuse';
  const refused = await get('/api/v1/dashboard/status', 'admin');
  assert.equal(refused.body.data.site.state, 'down');
  assert.equal(refused.body.data.site.reason, 'could not connect');
});

test('status: refresh history lists failures no later refresh covered', async () => {
  const { body } = await get('/api/v1/dashboard/status', 'admin');
  const history = body.data.siteRefresh.history;
  assert.equal(history.state, 'ok');
  assert.equal(history.data.sent, 1);
  assert.equal(history.data.failed, 1);
  assert.deepEqual(history.data.unresolved.map((f: { id: string }) => f.id), ['r1'], 'the courses success does not cover a blog page');
  assert.equal(history.data.latest.status, 'sent');
  assert.ok(history.data.lastSuccessAt);
});

test('status: before the migration is applied, refresh history says so instead of failing', async () => {
  MISSING.add('site_refresh_log');
  const { status, body } = await get('/api/v1/dashboard/status', 'admin');
  assert.equal(status, 200);
  assert.equal(body.data.siteRefresh.history.state, 'not-set-up');
  assert.ok(Array.isArray(body.data.integrations), 'the rest of the status is unaffected');
});

/* ── /dashboard/attention ─────────────────────────────────────────────────── */

test('attention: an admin gets waiting leads, stale drafts and past-dated batches from the records', async () => {
  const { status, body } = await get('/api/v1/dashboard/attention', 'admin');
  assert.equal(status, 200);
  const { leads, drafts, batches, thresholds } = body.data;
  assert.deepEqual(thresholds, { waitingHours: 24, staleDraftDays: 14 });

  assert.equal(leads.state, 'ok');
  assert.equal(leads.data.enquiries.waiting, 2, 'e1 and e4 are new and older than a day; e3 is contacted');
  assert.equal(leads.data.enquiries.oldestWaitingAt, DB.contact_enquiries.find((r) => r.id === 'e4')!.created_at);
  assert.equal(leads.data.enquiries.receivedRecently, 1, 'e2 arrived in the last day');
  assert.equal(leads.data.demoRequests.waiting, 1);
  assert.equal(leads.data.chatEnquiries.waiting, 0);

  assert.equal(drafts.data.blogs.drafts, 2);
  assert.equal(drafts.data.blogs.stale, 1);
  assert.deepEqual(drafts.data.blogs.items.map((i: { title: string }) => i.title), [DRAFT_POST]);
  assert.equal(drafts.data.courses.stale, 1);

  assert.equal(batches.data.active, 4, 'the retired batch is not active');
  assert.deepEqual(batches.data.pastDated.items.map((b: { id: string }) => b.id), ['bt3', 'bt1'], 'oldest first');
  assert.deepEqual(batches.data.unreadable.items.map((b: { id: string }) => b.id), ['bt4']);
});

test('attention: each role gets only the sections it may open, and no lead details at all', async () => {
  const expected: Record<Role, string[]> = {
    admin: ['batches', 'drafts', 'leads'],
    receptionist: ['leads'],
    content_writer: ['drafts'],
    editor: [],
    viewer: [],
  };
  for (const who of ROLES) {
    const { status, raw, body } = await get('/api/v1/dashboard/attention', who);
    assert.equal(status, 200, who);
    const sections = ['leads', 'drafts', 'batches'].filter((k) => k in body.data).sort();
    assert.deepEqual(sections, expected[who], who);
    for (const value of Object.values(LEAD)) assert.ok(!raw.includes(value), `${who}: lead details never appear`);
    if (!expected[who].includes('drafts')) {
      assert.ok(!raw.includes(DRAFT_POST) && !raw.includes(DRAFT_COURSE), `${who}: no unpublished titles`);
    }
  }
});

test('attention: one failing source is reported on its own and the rest still load', async () => {
  FAILING.add('batches');
  const { status, body } = await get('/api/v1/dashboard/attention', 'admin');
  assert.equal(status, 200);
  assert.deepEqual(body.data.batches, { state: 'error' });
  assert.equal(body.data.leads.state, 'ok');
  assert.equal(body.data.drafts.state, 'ok');
});

/* ── /dashboard/activity ──────────────────────────────────────────────────── */

test('activity: refused to every role but administrator', async () => {
  for (const who of ROLES.filter((r) => r !== 'admin')) {
    const { status } = await get('/api/v1/dashboard/activity', who);
    assert.equal(status, 403, who);
  }
});

test('activity: SEO changes and site refreshes, merged newest first, as stored', async () => {
  const { status, body } = await get('/api/v1/dashboard/activity', 'admin');
  assert.equal(status, 200);
  assert.deepEqual(body.data.sources, { seo: 'ok', site: 'ok' });
  assert.deepEqual(body.data.items.map((i: { id: string }) => i.id), ['r2', 'a1', 'r1']);
  const seo = body.data.items.find((i: { kind: string }) => i.kind === 'seo');
  assert.equal(seo.editor, 'Asha Admin');
  assert.deepEqual(seo.changedFields, ['metaTitle']);
  assert.equal(seo.path, '/');
  const failed = body.data.items.find((i: { id: string }) => i.id === 'r1');
  assert.equal(failed.reason, 'HTTP 503');

  const onlySeo = await get('/api/v1/dashboard/activity?kind=seo', 'admin');
  assert.deepEqual(onlySeo.body.data.items.map((i: { kind: string }) => i.kind), ['seo']);
  assert.deepEqual(onlySeo.body.data.sources, { seo: 'ok' });
});

test('activity: a log that does not exist yet is reported, not fatal', async () => {
  MISSING.add('site_refresh_log');
  const { status, body } = await get('/api/v1/dashboard/activity', 'admin');
  assert.equal(status, 200);
  assert.deepEqual(body.data.sources, { seo: 'ok', site: 'not-set-up' });
  assert.deepEqual(body.data.items.map((i: { id: string }) => i.id), ['a1']);
});

test('activity: parameters outside their closed sets are refused', async () => {
  for (const q of ['kind=leads', 'limit=0', 'limit=51', 'limit=abc', 'kind=seo&kind=site']) {
    const { status } = await get(`/api/v1/dashboard/activity?${q}`, 'admin');
    assert.equal(status, 422, q);
  }
});

/* ── /dashboard/trends ────────────────────────────────────────────────────── */

test('trends: daily counts come from each record’s own date', async () => {
  const { status, body } = await get('/api/v1/dashboard/trends?range=30&tz=0', 'admin');
  assert.equal(status, 200);
  const { range, leads, publishing } = body.data;
  assert.equal(range.days, 30);
  assert.equal(range.dates.length, 30);
  assert.equal(range.dates.at(-1), dayKey(Date.now(), 0), 'ends today');

  const enquiries = leads.data.enquiries;
  assert.equal(enquiries.total, 3, 'e1, e2, e3 arrived in the last 30 days, whatever their status');
  assert.equal(enquiries.counts.reduce((a: number, b: number) => a + b, 0), 3);
  for (const id of ['e1', 'e2', 'e3']) {
    const at = DB.contact_enquiries.find((r) => r.id === id)!.created_at as string;
    const index = range.dates.indexOf(dayKey(Date.parse(at), 0));
    assert.ok(enquiries.counts[index] >= 1, `${id} is counted on its day`);
  }
  assert.equal(enquiries.previousTotal, 1, 'e4 arrived in the 30 days before; e5 shows the data reaches back');

  const demo = leads.data.demoRequests;
  assert.equal(demo.total, 1);
  assert.equal(demo.previousTotal, null, 'no demo request is older than the previous period: no comparison');

  const blogs = publishing.data.blogs;
  assert.equal(blogs.total, 1, 'b3 was published in the window; drafts and b4 are not');
  assert.equal(blogs.previousTotal, 0, 'b4 shows the data reaches back, so zero is a real zero');
});

test('trends: each role gets only the series it may see', async () => {
  const expected: Record<Role, string[]> = {
    admin: ['leads', 'publishing'],
    receptionist: ['leads'],
    content_writer: ['publishing'],
    editor: [],
    viewer: [],
  };
  for (const who of ROLES) {
    const { status, body } = await get('/api/v1/dashboard/trends?range=7&tz=330', who);
    assert.equal(status, 200, who);
    assert.deepEqual(['leads', 'publishing'].filter((k) => k in body.data), expected[who], who);
    assert.equal(body.data.range.tzOffsetMinutes, 330);
  }
});

test('trends: more than one page of records is read completely', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({
    id: `chat-${i}`, name: 'x', status: 'new', created_at: ago((i % 6) * DAY + HOUR),
  }));
  DB.chat_enquiries = many;
  const { body } = await get('/api/v1/dashboard/trends?range=7&tz=0', 'receptionist');
  const chats = body.data.leads.data.chatEnquiries;
  assert.equal(chats.total, 2500);
  assert.equal(chats.counts.reduce((a: number, b: number) => a + b, 0), 2500);
  assert.equal(chats.truncated, false);
  assert.ok(2500 < MAX_TREND_ROWS);
});

test('trends: a failing table fails its own series only', async () => {
  FAILING.add('blogs');
  const { status, body } = await get('/api/v1/dashboard/trends?range=30&tz=0', 'admin');
  assert.equal(status, 200);
  assert.deepEqual(body.data.publishing, { state: 'error' });
  assert.equal(body.data.leads.state, 'ok');
});

test('trends: range and offset outside their sets are refused', async () => {
  for (const q of ['range=14', 'range=0', 'tz=900', 'tz=-721', 'tz=5.5', 'range=7&range=30']) {
    const { status } = await get(`/api/v1/dashboard/trends?${q}`, 'admin');
    assert.equal(status, 422, q);
  }
});

/* ── /dashboard/stats additions ───────────────────────────────────────────── */

test('stats: recent courses follow the same rule as recent posts', async () => {
  for (const who of ROLES) {
    const { body, raw } = await get('/api/v1/dashboard/stats', who);
    const mayRead = who === 'admin' || who === 'content_writer';
    assert.equal(raw.includes(DRAFT_COURSE), mayRead, `${who} ${mayRead ? 'sees' : 'never sees'} the draft course title`);
    assert.equal(body.data.cacheTtlSeconds, 120);
    assert.ok(body.data.generatedAt, 'says when the counts were read');
    assert.equal(body.data.counts.draftCourses, 1);
    assert.equal(body.data.counts.publishedCourses, 1);
  }
});
