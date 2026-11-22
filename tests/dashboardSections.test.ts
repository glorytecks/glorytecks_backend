import './setup';
import { FAILING, SUBJECT, resetDb } from './dashboardTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { breakdown, lastMonths, starSpread } from '../src/services/dashboardSections.service';

/**
 * The section overviews (Leads, Blog, Courses, Website, People & proof)
 * through the real middleware: who may open each, that every number is read
 * from the stored records, and that parts belonging to another module are
 * left out for roles that may not open it.
 */

type Role = keyof typeof SUBJECT;
let server: http.Server;
let base: string;
test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());

const tokenFor = (who: Role) => jwt.sign({ sub: SUBJECT[who], aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string, { expiresIn: '1h' });
async function get(path: string, who: Role) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${tokenFor(who)}` } });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : null };
}

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const dateIn = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
const PII = { name: 'SectionLeadName', email: 'section-lead@dashboard.invalid', phone: '+10000000099' };

function seed() {
  resetDb({
    contact_enquiries: [
      { id: 'e1', ...PII, course: 'Python Programming', status: 'new', created_at: ago(2) },
      { id: 'e2', ...PII, course: ' python  programming ', status: 'contacted', created_at: ago(5) },
      { id: 'e3', ...PII, course: '', status: 'converted', created_at: ago(8) },
      { id: 'e4', ...PII, course: 'Data Science', status: 'closed', created_at: ago(60) },
    ],
    demo_requests: [
      { id: 'd1', ...PII, course: 'Data Science', source: 'demo-modal:hero', status: 'new', created_at: ago(1) },
      { id: 'd2', ...PII, course: 'Python Programming', source: 'demo-modal:hero', status: 'converted', created_at: ago(3) },
      { id: 'd3', ...PII, course: 'Power BI', source: null, status: 'new', created_at: ago(9) },
    ],
    chat_enquiries: [
      { id: 'c1', ...PII, course: 'Power BI', step: 'done', status: 'new', created_at: ago(1) },
      { id: 'c2', ...PII, course: 'Power BI', step: 'phone', status: 'new', created_at: ago(2) },
      { id: 'c3', ...PII, course: null, step: 'done', status: 'contacted', created_at: ago(4) },
    ],
    blogs: [
      { id: 'b1', title: 'Post one', status: 'published', category: 'Data Science', author_key: 'asha', kind: 'guide', featured: true, published_at: ago(3), created_at: ago(400), updated_at: ago(1) },
      { id: 'b2', title: 'Post two', status: 'published', category: 'data science', author_key: 'asha', kind: null, published_at: ago(40), created_at: ago(400), updated_at: ago(2) },
      { id: 'b3', title: 'Post three', status: 'published', category: 'Python', author_key: 'ravi', kind: 'comparison', trending: true, published_at: ago(200), created_at: ago(400), updated_at: ago(3) },
      { id: 'b4', title: 'Draft four', status: 'draft', category: 'Python', author_key: 'ravi', created_at: ago(10), updated_at: ago(4) },
      { id: 'b5', title: 'Old five', status: 'archived', category: 'Python', created_at: ago(500), updated_at: ago(300) },
    ],
    authors: [
      { id: 'a1', key: 'asha', name: 'Asha Rao' },
      { id: 'a2', key: 'ravi', name: 'Ravi Kumar' },
    ],
    blog_categories: [{ id: 'bc1', name: 'Data Science' }],
    courses: [
      { id: 'k1', slug: 'python-programming', title: 'Python Programming', category: 'Programming', status: 'published', featured: true, show_in_nav: true, brochure_url: '', updated_at: ago(1) },
      { id: 'k2', slug: 'data-science', title: 'Data Science', category: 'Data', status: 'published', brochure_url: 'https://cdn.test/ds.pdf', updated_at: ago(2) },
      { id: 'k3', slug: 'power-bi', title: 'Power BI', category: 'Data', status: 'published', brochure_url: '', updated_at: ago(3) },
      { id: 'k4', slug: 'old', title: 'Old course', category: 'Legacy', status: 'archived', featured: true, show_in_nav: true, updated_at: ago(90) },
    ],
    course_categories: [{ id: 'cc1', name: 'Data' }, { id: 'cc2', name: 'Programming' }],
    brochures: [{ id: 'br1', course_slug: 'power-bi', is_active: true }],
    batches: [
      { id: 't1', course: 'Python Programming', start_date: dateIn(10), mode: 'Online', seats: 20, is_active: true },
      { id: 't2', course: 'Data Science', start_date: dateIn(3), mode: 'Classroom', seats: 15, is_active: true },
      { id: 't3', course: 'Power BI', start_date: dateIn(-5), mode: 'Online', seats: 10, is_active: true },
      { id: 't4', course: 'AWS', start_date: 'soon', mode: 'Online', seats: 10, is_active: true },
      { id: 't5', course: 'Retired', start_date: dateIn(20), is_active: false },
    ],
    comparisons: [
      { id: 'cm1', title: 'Python vs Java', status: 'published', updated_at: ago(1) },
      { id: 'cm2', title: 'Tableau vs Power BI', status: 'draft', updated_at: ago(6) },
    ],
    legal_docs: [{ id: 'l1', title: 'Privacy policy', status: 'published', updated_at: ago(30) }],
    localities: [
      { id: 'lo1', name: 'Ameerpet', is_active: true, updated_at: ago(2) },
      { id: 'lo2', name: 'Kukatpally', is_active: false, updated_at: ago(20) },
    ],
    faqs: [
      { id: 'f1', question: 'Do you place?', scope: 'home', is_active: true, updated_at: ago(3) },
      { id: 'f2', question: 'Fees?', scope: 'home', is_active: true, updated_at: ago(4) },
      { id: 'f3', question: 'Old?', scope: 'courses', is_active: false, updated_at: ago(50) },
    ],
    roadmaps: [{ id: 'r1', course: 'Data Science', is_active: true, updated_at: ago(7) }],
    gallery_items: [{ id: 'g1', title: 'Classroom', category: 'campus', is_active: true, updated_at: ago(8) }],
    trainers: [
      { id: 'tr1', name: 'Trainer A', is_active: true, featured: true, created_at: ago(5) },
      { id: 'tr2', name: 'Trainer B', is_active: false, created_at: ago(50) },
    ],
    testimonials: [
      { id: 's1', name: 'Student A', stars: 5, is_active: true, created_at: ago(2) },
      { id: 's2', name: 'Student B', stars: 4, is_active: true, created_at: ago(3) },
      { id: 's3', name: 'Student C', stars: 5, is_active: true, featured: true, created_at: ago(4) },
      { id: 's4', name: 'Hidden', stars: 1, is_active: false, created_at: ago(5) },
    ],
    placements: [
      { id: 'p1', name: 'Alumnus A', company: 'Deloitte', course: 'Data Science', is_active: true, created_at: ago(1) },
      { id: 'p2', name: 'Alumnus B', company: 'deloitte', course: 'Python Programming', is_active: true, created_at: ago(6) },
      { id: 'p3', name: 'Alumnus C', company: 'TCS', course: 'Data Science', is_active: true, created_at: ago(9) },
    ],
    companies: [{ id: 'co1', name: 'Deloitte', is_active: true, created_at: ago(30) }],
  });
}

const SECTIONS: [string, Role[]][] = [
  ['/api/v1/dashboard/sections/leads', ['admin', 'receptionist']],
  ['/api/v1/dashboard/sections/blog', ['admin', 'content_writer']],
  ['/api/v1/dashboard/sections/courses', ['admin', 'content_writer']],
  ['/api/v1/dashboard/sections/website', ['admin']],
  ['/api/v1/dashboard/sections/people', ['admin', 'content_writer']],
];

test('each overview opens only for the roles that may open that section', async () => {
  seed();
  for (const [path, allowed] of SECTIONS) {
    for (const who of Object.keys(SUBJECT) as Role[]) {
      const { status } = await get(path, who);
      assert.equal(status, allowed.includes(who) ? 200 : 403, `${who} ${path}`);
    }
  }
});

test('range and tz outside their closed sets are refused', async () => {
  for (const q of ['range=14', 'range=30&range=7', 'tz=9999']) {
    assert.equal((await get(`/api/v1/dashboard/sections/leads?${q}`, 'admin')).status, 422, q);
  }
});

test('leads: statuses, demand by course, demo sources and chat completion from the records — no names or contacts', async () => {
  seed();
  const { body, raw } = await get('/api/v1/dashboard/sections/leads?range=30&tz=330', 'receptionist');
  const d = body.data;
  assert.equal(d.range.days, 30);
  assert.deepEqual(d.statuses.data.enquiries, { new: 1, contacted: 1, converted: 1, closed: 1 });
  assert.deepEqual(d.statuses.data.demoRequests, { new: 2, contacted: 0, converted: 1, closed: 0 });
  assert.equal(d.arrivals.data.enquiries.total, 3, 'three enquiries in the last 30 days');
  assert.equal(d.arrivals.data.chatEnquiries.total, 3);
  // " python  programming " groups with "Python Programming"; the blank course is named, not dropped.
  const demand = Object.fromEntries(d.demand.data.items.map((t: any) => [t.label, t.count]));
  assert.deepEqual(demand, { 'Python Programming': 3, 'Power BI': 3, 'Data Science': 1, 'No course given': 2 });
  assert.equal(d.demand.data.total, 9);
  assert.deepEqual(d.demoSources.data.items, [
    { label: 'demo-modal:hero', count: 2 },
    { label: 'Not recorded', count: 1 },
  ]);
  assert.equal(d.chat.data.started, 3);
  assert.equal(d.chat.data.completed, 2);
  for (const pii of Object.values(PII)) assert.equal(raw.includes(pii), false, 'no lead name, email or phone');
});

test('blog: statuses, flags, categories, authors by name, kinds and twelve months of publishing', async () => {
  seed();
  const d = (await get('/api/v1/dashboard/sections/blog?range=30&tz=0', 'content_writer')).body.data;
  assert.deepEqual(d.statuses.data, { total: 5, draft: 1, published: 3, archived: 1 });
  assert.deepEqual(d.flags.data, { featured: 1, trending: 1, popular: 0 });
  assert.equal(d.publishing.data.total, 1, 'one post first published in the last 30 days');
  assert.deepEqual(d.byCategory.data.items, [
    { label: 'Data Science', count: 2 },
    { label: 'Python', count: 1 },
  ]);
  assert.deepEqual(d.byAuthor.data.items, [
    { label: 'Asha Rao', count: 2 },
    { label: 'Ravi Kumar', count: 1 },
  ]);
  assert.equal(d.monthly.data.months.length, 12);
  assert.equal(d.monthly.data.counts.reduce((a: number, b: number) => a + b, 0), 3, 'all three published posts fall in the last 12 months');
  assert.deepEqual(d.recent.data.map((p: any) => p.title), ['Post one', 'Post two', 'Post three', 'Draft four', 'Old five']);
  assert.deepEqual(d.counts.data, { categories: 1, authors: 2 });
});

test('courses: admins see demand, batches and brochures; content writers see the course side only', async () => {
  seed();
  const admin = (await get('/api/v1/dashboard/sections/courses?range=30&tz=0', 'admin')).body.data;
  assert.deepEqual(admin.statuses.data, { total: 4, draft: 0, published: 3, archived: 1 });
  assert.deepEqual(admin.flags.data, { featured: 1, inNav: 1 }, 'the archived course is featured and in the menu, but never reaches the site');
  assert.deepEqual(admin.byCategory.data.items, [
    { label: 'Data', count: 2 },
    { label: 'Programming', count: 1 },
  ]);
  assert.ok(admin.demand.data.total > 0);
  assert.equal(admin.batches.data.active, 4);
  assert.equal(admin.batches.data.upcoming, 2);
  assert.deepEqual(admin.batches.data.next.map((b: any) => b.course), ['Data Science', 'Python Programming'], 'soonest first');
  assert.equal(admin.batches.data.pastDated, 1);
  assert.equal(admin.batches.data.unreadable, 1, '"soon" is not guessed');
  // Data Science has a brochure_url, Power BI an active brochure: only Python Programming is missing one.
  assert.deepEqual(admin.brochures.data, { active: 1, publishedCourses: 3, withoutBrochure: 1, missing: [{ id: 'k1', title: 'Python Programming' }], truncated: false });

  const writer = (await get('/api/v1/dashboard/sections/courses?range=30&tz=0', 'content_writer')).body.data;
  assert.equal(writer.demand, undefined, 'lead data is not for content writers');
  assert.equal(writer.batches, undefined);
  assert.equal(writer.brochures, undefined);
  assert.ok(writer.statuses.data.total === 4);
});

test('website: counts by status or active, breakdowns, and the latest edits across its pages', async () => {
  seed();
  const d = (await get('/api/v1/dashboard/sections/website', 'admin')).body.data;
  assert.deepEqual(d.comparisons.data, { total: 2, draft: 1, published: 1, archived: 0 });
  assert.deepEqual(d.localities.data, { total: 2, active: 1 });
  assert.deepEqual(d.faqs.data, { total: 3, active: 2 });
  assert.deepEqual(d.faqScopes.data.items, [{ label: 'home', count: 2 }]);
  assert.deepEqual(d.recent.data.slice(0, 3).map((r: any) => [r.kind, r.title]), [
    ['comparisons', 'Python vs Java'],
    ['localities', 'Ameerpet'],
    ['faqs', 'Do you place?'],
  ]);
});

test('people & proof: active counts, star spread of shown testimonials, placements by company and course', async () => {
  seed();
  const d = (await get('/api/v1/dashboard/sections/people', 'content_writer')).body.data;
  assert.deepEqual(d.trainers.data, { total: 2, active: 1, featured: 1 });
  assert.deepEqual(d.stars.data.counts, [0, 0, 0, 1, 2], 'hidden testimonials are not counted');
  assert.equal(Math.round(d.stars.data.average * 100) / 100, 4.67);
  assert.deepEqual(d.byCompany.data.items, [
    { label: 'Deloitte', count: 2 },
    { label: 'TCS', count: 1 },
  ]);
  assert.equal(d.recent.data[0].title, 'Alumnus A');
});

test('one failing table fails only its own part of an overview', async () => {
  seed();
  FAILING.add('placements');
  try {
    const d = (await get('/api/v1/dashboard/sections/people', 'admin')).body.data;
    assert.equal(d.placements.state, 'error');
    assert.equal(d.byCompany.state, 'error');
    assert.equal(d.trainers.state, 'ok');
  } finally {
    FAILING.delete('placements');
  }
});

test('breakdown, months and stars (pure)', () => {
  const b = breakdown(['A', 'a', ' A ', 'B', null, '', 'C', 'D'], 2, 'None');
  assert.deepEqual(b.items, [
    { label: 'A', count: 3 },
    { label: 'None', count: 2 },
  ]);
  assert.equal(b.other, 3);
  assert.equal(b.total, 8);
  assert.deepEqual(lastMonths(3, new Date('2026-01-15T00:00:00Z'), 0), ['2025-11', '2025-12', '2026-01']);
  assert.deepEqual(starSpread([5, '4', 0, 6, null, 3.4]), { counts: [0, 0, 1, 1, 1], rated: 3, average: (5 + 4 + 3.4) / 3 });
});
