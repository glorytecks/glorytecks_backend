/**
 * Bootstrap for the dashboard and SEO audit tests. Import AFTER `./setup`.
 *
 * An in-memory stand-in for PostgREST with what those reads and writes use:
 * eq/neq/lt/lte/gt/gte/in/is/ilike filters (repeatable on one column, for
 * closed ranges), order on several columns, offset/limit, `count=exact` with
 * or without rows, embedded relations stored on the row itself, inserts,
 * upserts (on_conflict with merge- or ignore-duplicates) and PATCH updates.
 * Tables listed in DEFAULTS get their column defaults on insert, and UNIQUE
 * constraints answer 23505 as PostgreSQL would. Two switches make a table
 * misbehave: MISSING answers as PostgREST does for a table that does not
 * exist (PGRST205 — a migration not yet applied), FAILING answers 500.
 *
 * The website the status probe checks is answered here too (SITE_HOST), so
 * no test ever reaches the network.
 */
process.env.SUPABASE_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'dashboard-test-hs256-secret-not-a-real-credential';

type Row = Record<string, unknown>;

export const SUBJECT = {
  admin: '00000000-0000-4000-8000-000000000001',
  receptionist: '00000000-0000-4000-8000-000000000002',
  content_writer: '00000000-0000-4000-8000-000000000003',
  editor: '00000000-0000-4000-8000-000000000004',
  viewer: '00000000-0000-4000-8000-000000000005',
} as const;

const ROLE_OF: Record<string, string> = Object.fromEntries(Object.entries(SUBJECT).map(([role, id]) => [id, role]));

export const DB: Record<string, Row[]> = {};
export const MISSING = new Set<string>();
export const FAILING = new Set<string>();
/** Every request the stand-in answered, as "METHOD table". */
export const REQUESTS: string[] = [];

/** Column defaults the database fills on insert (migration 20261025000000_site_audit). */
const DEFAULTS: Record<string, () => Row> = {
  site_audit_runs: () => ({
    status: 'queued', phase: 'discover', lease_until: '1970-01-01T00:00:00.000Z', lease_token: null, steps: 0, progress: {},
    coverage: {}, summary: null, state: {}, error: null, scratch_cleared: false, started_at: null, finished_at: null, started_by: null,
  }),
  site_audit_pages: () => ({
    state: 'pending', priority: 4, sources: [], in_sitemap: false, loc: null, expected_live: false, expect_index: null,
    expect_follow: null, attempts: 0, status: null, final_status: null, final_url: null, hops: [], loop: false, offsite: null,
    error: null, skip_reason: null, record: null, links: null, images: null, ms: null, fetched_at: null,
  }),
  site_audit_issues: () => ({
    target: null, page_type: 'static', detail: '', evidence: {}, affected: [], affected_count: 0, admin_path: null, status: 'open',
    resolved_at: null, first_run_id: null, last_run_id: null, resolved_run_id: null, times_seen: 1, reopened_count: 0,
  }),
};

/** Unique constraints, checked on insert. */
const UNIQUE: Record<string, string[][]> = {
  site_audit_pages: [['run_id', 'kind', 'path']],
  site_audit_issues: [['fingerprint']],
};

/** The website the status probe checks. */
export const SITE_HOST = 'site.dashboard.test';
export const SITE_HITS: { method: string; path: string }[] = [];
export const site: { answer: { status: number } | 'refuse' } = { answer: { status: 200 } };

let seq = 0;

export function resetDb(tables: Record<string, Row[]> = {}) {
  for (const k of Object.keys(DB)) delete DB[k];
  Object.assign(DB, structuredClone(tables));
  MISSING.clear();
  FAILING.clear();
  REQUESTS.length = 0;
  SITE_HITS.length = 0;
  site.answer = { status: 200 };
}

const json = { 'Content-Type': 'application/json' };

/** Compare a cell with a filter value: as instants when both are dates, else as text. */
function compare(cell: unknown, value: string): number {
  if (typeof cell === 'number' && value.trim() !== '' && !Number.isNaN(Number(value))) return cell - Number(value);
  const a = typeof cell === 'string' ? Date.parse(cell) : NaN;
  const b = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
  const s = String(cell ?? '');
  return s < value ? -1 : s > value ? 1 : 0;
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    const cell = row[key];
    switch (op) {
      case 'eq':
        if (String(cell) !== value) return false;
        break;
      case 'neq':
        if (String(cell) === value) return false;
        break;
      case 'lt':
        if (cell == null || compare(cell, value) >= 0) return false;
        break;
      case 'lte':
        if (cell == null || compare(cell, value) > 0) return false;
        break;
      case 'gt':
        if (cell == null || compare(cell, value) <= 0) return false;
        break;
      case 'gte':
        if (cell == null || compare(cell, value) < 0) return false;
        break;
      case 'in': {
        const set = value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''));
        if (!set.includes(String(cell))) return false;
        break;
      }
      case 'ilike': {
        // A LIKE pattern: % is any run, _ one character, and a backslash escapes either.
        const escape = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let re = '';
        for (let i = 0; i < value.length; i++) {
          const ch = value[i];
          if (ch === '\\' && i + 1 < value.length) re += escape(value[++i]);
          else if (ch === '%') re += '.*';
          else if (ch === '_') re += '.';
          else re += escape(ch);
        }
        if (!new RegExp(`^${re}$`, 'is').test(String(cell ?? ''))) return false;
        break;
      }
      case 'is':
        if (value === 'null' && cell != null) return false;
        if (value === 'true' && cell !== true) return false;
        if (value === 'false' && cell !== false) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const specs = order.split(',').map((part) => {
    const [col, dir, nulls] = part.split('.');
    return { col, sign: dir === 'desc' ? -1 : 1, nullsFirst: nulls === 'nullsfirst' };
  });
  return [...rows].sort((x, y) => {
    for (const { col, sign, nullsFirst } of specs) {
      const a = x[col];
      const b = y[col];
      if (a == null || b == null) {
        if (a == null && b == null) continue;
        return (a == null ? -1 : 1) * (nullsFirst ? 1 : -1);
      }
      const c = compare(a, String(b));
      if (c !== 0) return c * sign;
    }
    return 0;
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
  const method = (init?.method ?? 'GET').toUpperCase();

  // The public website, as the status probe and the refresh webhook see it.
  if (new URL(href).hostname === SITE_HOST) {
    SITE_HITS.push({ method, path: new URL(href).pathname });
    if (site.answer === 'refuse') {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }
    return new Response(null, { status: site.answer.status });
  }

  if (!href.includes('127.0.0.1:54321')) return realFetch(input, init);

  const url = new URL(href);
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  const accept = headers.get('accept') ?? '';
  const prefer = headers.get('prefer') ?? '';
  const table = url.pathname.split('/rest/v1/')[1] ?? '';
  REQUESTS.push(`${method} ${table}`);

  // requireAuth's identity lookup.
  if (table === 'admin_users' && url.searchParams.get('id')?.startsWith('eq.')) {
    const id = url.searchParams.get('id')!.slice(3);
    const role = ROLE_OF[id];
    const rows = role ? [{ id, name: `Test ${role}`, email: `${role}@test.invalid`, role, is_active: true }] : [];
    if (accept.includes('pgrst.object')) {
      return rows.length
        ? new Response(JSON.stringify(rows[0]), { status: 200, headers: json })
        : new Response(null, { status: 204, headers: json });
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: json });
  }

  if (MISSING.has(table)) {
    return new Response(
      JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache`, details: null, hint: null }),
      { status: 404, headers: json },
    );
  }
  if (FAILING.has(table)) {
    return new Response(JSON.stringify({ code: 'XX000', message: 'injected failure', details: null, hint: null }), {
      status: 500,
      headers: json,
    });
  }

  const rows = (DB[table] ??= []);

  if (method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const conflict = url.searchParams.get('on_conflict')?.split(',');
    const ignore = prefer.includes('resolution=ignore-duplicates');
    const merge = prefer.includes('resolution=merge-duplicates');
    const same = (keys: string[], a: Row, b: Row) => keys.every((k) => String(a[k]) === String(b[k]));
    const written: Row[] = [];
    for (const item of (Array.isArray(body) ? body : [body]) as Row[]) {
      const existing = conflict ? rows.find((r) => same(conflict, r, item)) : undefined;
      if (existing && ignore) continue;
      if (existing && merge) {
        Object.assign(existing, item, { updated_at: new Date().toISOString() });
        written.push(existing);
        continue;
      }
      if ((UNIQUE[table] ?? []).some((keys) => rows.some((r) => same(keys, r, item)))) {
        const body409 = { code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null };
        return new Response(JSON.stringify(body409), { status: 409, headers: json });
      }
      const at = new Date().toISOString();
      const row = {
        id: `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`,
        created_at: at,
        ...(DEFAULTS[table] ? { ...DEFAULTS[table](), updated_at: at } : {}),
        ...item,
      };
      rows.push(row);
      written.push(row);
    }
    if (accept.includes('pgrst.object')) {
      return new Response(JSON.stringify(written[0]), { status: 201, headers: json });
    }
    return new Response(JSON.stringify(written), { status: 201, headers: json });
  }

  if (method === 'PATCH') {
    const patch = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    const found = rows.filter((r) => matches(r, url.searchParams));
    for (const r of found) Object.assign(r, patch, { updated_at: new Date().toISOString() });
    if (!prefer.includes('return=representation')) return new Response(null, { status: 204 });
    if (accept.includes('pgrst.object')) {
      return found.length
        ? new Response(JSON.stringify(found[0]), { status: 200, headers: json })
        : new Response(null, { status: 204, headers: json });
    }
    return new Response(JSON.stringify(found), { status: 200, headers: json });
  }

  if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 });

  const found = sortRows(rows.filter((r) => matches(r, url.searchParams)), url.searchParams.get('order'));
  const total = found.length;
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : total;
  const page = found.slice(offset, offset + limit);
  const range = { 'Content-Range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${total}` };

  if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...json, ...range } });
  if (accept.includes('pgrst.object')) {
    return page.length
      ? new Response(JSON.stringify(page[0]), { status: 200, headers: json })
      : new Response(null, { status: 204, headers: json });
  }
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { ...json, ...(prefer.includes('count=') ? range : {}) },
  });
}) as typeof fetch;
