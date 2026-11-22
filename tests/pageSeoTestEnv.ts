/**
 * Bootstrap for the Page SEO route tests. Import AFTER `./setup`.
 *
 * An in-memory stand-in for PostgREST: tables are arrays of rows (database
 * column names), reads honour `eq`/`neq`/`is` filters, and every insert,
 * upsert, update and delete is applied AND recorded in `WRITES`, so a test can
 * assert exactly what reached the database — and what did not.
 *
 * Like authzTestEnv, it must load before `src/app`: SUPABASE_JWT_SECRET has
 * to be set for local token verification, and `fetch` must answer before any
 * repository runs.
 */
process.env.SUPABASE_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'page-seo-test-hs256-secret-not-a-real-credential';

type Row = Record<string, unknown>;

export const SUBJECT = {
  admin: '00000000-0000-4000-8000-000000000001',
  receptionist: '00000000-0000-4000-8000-000000000002',
  content_writer: '00000000-0000-4000-8000-000000000003',
  editor: '00000000-0000-4000-8000-000000000004',
  viewer: '00000000-0000-4000-8000-000000000005',
} as const;

const ROLE_OF: Record<string, string> = Object.fromEntries(Object.entries(SUBJECT).map(([role, id]) => [id, role]));

export const IDS = {
  course: 'c0000000-0000-4000-8000-000000000001',
  comparison: 'c0000000-0000-4000-8000-000000000002',
  about: 'c0000000-0000-4000-8000-000000000003',
} as const;

export const DB: Record<string, Row[]> = {};
export const WRITES: { method: string; table: string; body: unknown; query: string }[] = [];

let seq = 0;
const now = () => '2026-10-15T00:00:00.000Z';

/** Fresh tables for each test. */
export function resetDb(extra: Partial<Record<string, Row[]>> = {}) {
  WRITES.length = 0;
  for (const k of Object.keys(DB)) delete DB[k];
  Object.assign(DB, {
    page_seo: [],
    seo_audit_log: [],
    courses: [
      {
        id: IDS.course,
        slug: 'data-science',
        title: 'Data Science',
        tagline: 'From data to decisions',
        duration: '6 Months',
        modules: ['Python', 'Statistics'],
        tools: ['Python', 'SQL'],
        status: 'published',
        seo_keywords: [],
        seo_noindex: false,
        seo_nofollow: false,
        created_at: now(),
        updated_at: now(),
      },
    ],
    localities: [{ id: 'l1', slug: 'ameerpet', name: 'Ameerpet', is_active: true }],
    comparisons: [
      {
        id: IDS.comparison,
        slug: 'power-bi-vs-tableau',
        title: 'Power BI vs Tableau',
        meta_title: 'Power BI vs Tableau 2026',
        meta_description: '',
        intro: 'Power BI and Tableau are the two leading business intelligence tools.',
        status: 'published',
        item_a: 'Power BI',
        item_b: 'Tableau',
      },
    ],
    legal_docs: [],
    about_page: [{ id: IDS.about, sections: [], stats: [], seo_keywords: [], seo_noindex: false, seo_nofollow: false }],
    ...extra,
  });
}
resetDb();

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (['select', 'on_conflict', 'order', 'limit', 'offset', 'columns'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    const cell = row[key];
    if (op === 'eq' && String(cell) !== value) return false;
    if (op === 'neq' && String(cell) === value) return false;
    if (op === 'is' && value === 'null' && cell !== null && cell !== undefined) return false;
  }
  return true;
}

const json = { 'Content-Type': 'application/json' };

function reply(rows: Row[], accept: string) {
  if (accept.includes('pgrst.object')) {
    return rows.length
      ? new Response(JSON.stringify(rows[0]), { status: 200, headers: json })
      : new Response(null, { status: 204, headers: json });
  }
  return new Response(JSON.stringify(rows), { status: 200, headers: json });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
  if (!href.includes('127.0.0.1:54321')) return realFetch(input, init);

  const url = new URL(href);
  const method = (init?.method ?? 'GET').toUpperCase();
  // supabase-js passes a plain object for table reads but a Headers instance
  // for RPCs; normalise both.
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  const accept = headers.get('accept') ?? '';
  const prefer = headers.get('prefer') ?? '';
  const table = url.pathname.split('/rest/v1/')[1] ?? '';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  // requireAuth's identity lookup.
  if (table === 'admin_users') {
    const id = url.searchParams.get('id')?.replace(/^eq\./, '') ?? '';
    const role = ROLE_OF[id];
    const rows = role ? [{ id, name: `Test ${role}`, email: `${role}@test.invalid`, role, is_active: true }] : [];
    return reply(rows, accept);
  }

  // The about_page singleton is read through an RPC.
  if (table === 'rpc/get_or_create_about_page') return reply(DB.about_page.slice(0, 1), accept);

  if (prefer.includes('count=')) {
    return new Response(null, { status: 200, headers: { ...json, 'Content-Range': `0-0/${(DB[table] ?? []).length}` } });
  }

  const rows = (DB[table] ??= []);

  if (method === 'GET' || method === 'HEAD') {
    let found = rows.filter((r) => matches(r, url.searchParams));
    const limit = Number(url.searchParams.get('limit'));
    if (limit) found = found.slice(0, limit);
    return reply(found, accept);
  }

  WRITES.push({ method, table, body, query: url.search });

  if (method === 'POST') {
    const conflict = url.searchParams.get('on_conflict');
    const out: Row[] = [];
    for (const item of Array.isArray(body) ? body : [body]) {
      const existing = conflict ? rows.find((r) => r[conflict] === item[conflict]) : undefined;
      if (existing) {
        Object.assign(existing, item, { updated_at: now() });
        out.push(existing);
      } else {
        const row = { id: `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`, created_at: now(), updated_at: now(), ...item };
        rows.push(row);
        out.push(row);
      }
    }
    return reply(out, accept);
  }

  if (method === 'PATCH') {
    const hit = rows.filter((r) => matches(r, url.searchParams));
    for (const r of hit) Object.assign(r, body, { updated_at: now() });
    return reply(hit, accept);
  }

  if (method === 'DELETE') {
    const hit = rows.filter((r) => matches(r, url.searchParams));
    DB[table] = rows.filter((r) => !hit.includes(r));
    return reply(hit, accept);
  }

  return new Response(null, { status: 405 });
}) as typeof fetch;
