-- ============================================================================
-- Technical SEO audit: runs, the URLs each run checked, and the issues found
--
-- Additive only: three new tables, nothing existing changes. Until this is
-- applied the API carries on as before — the admin's Technical SEO audit
-- screen says the audit is not set up, and nothing else reads these tables.
-- Rollback: backend/supabase/rollbacks/20261025000000_site_audit.down.sql.
--
-- The audit crawls the public site (one configured origin, see
-- backend/src/seo/audit/config.ts) with the site's own checks. The backend
-- runs as serverless functions, so a crawl cannot live inside one request:
-- a run is persisted here and advanced one short, time-boxed step at a time
-- by the admin screen. Each step takes a lease on the run row (lease_until,
-- lease_token) so two browsers can never advance one run at once, and a step
-- that dies simply lets its lease expire; the next step carries on.
--
-- Rows hold paths, HTTP statuses, short failure reasons and what the site's
-- checks read from public pages (titles, canonicals, headings, link targets).
-- No request headers, cookies, credentials or visitor data are stored.
-- ============================================================================

create table if not exists public.site_audit_runs (
  id           uuid primary key default gen_random_uuid(),
  -- The origin crawled, e.g. https://glorytecks.com. Issues are per origin.
  origin       text        not null check (origin ~ '^https://[a-z0-9.-]+$' and length(origin) <= 200),
  status       text        not null default 'queued'
                           check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  phase        text        not null default 'discover'
                           check (phase in ('discover', 'crawl', 'links', 'images', 'analyze', 'done')),
  -- The page budget this run was started with (SEO_AUDIT_MAX_PAGES).
  max_pages    integer     not null check (max_pages between 1 and 5000),
  started_by   uuid        references public.admin_users (id) on delete set null,
  -- The step lock. 'epoch' when free; a step may take the run only once it has passed.
  lease_until  timestamptz not null default 'epoch',
  lease_token  uuid,
  steps        integer     not null default 0 check (steps >= 0),
  -- URLs per kind and state, recounted after every step.
  progress     jsonb       not null default '{}'::jsonb,
  -- What the run could and could not reach (budget, robots.txt, failures).
  coverage     jsonb       not null default '{}'::jsonb,
  -- Issue counts once analysed: by severity and category, new, recurring, resolved.
  summary      jsonb,
  -- The step machine's working state (robots.txt, sitemap reads, site-file checks).
  state        jsonb       not null default '{}'::jsonb,
  -- Why the run failed, in words safe to show ("robots.txt answered HTTP 503").
  error        text        check (error is null or length(error) <= 300),
  -- Bulky per-page readings of an older run are cleared once a newer run is analysed.
  scratch_cleared boolean  not null default false,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists site_audit_runs_created_idx
  on public.site_audit_runs (origin, created_at desc);

-- At most one run in progress at a time, whoever starts it.
create unique index if not exists site_audit_runs_one_active_idx
  on public.site_audit_runs ((true))
  where status in ('queued', 'running');

create or replace trigger site_audit_runs_set_updated_at
  before update on public.site_audit_runs
  for each row execute function public.set_updated_at();

create table if not exists public.site_audit_pages (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid        not null references public.site_audit_runs (id) on delete cascade,
  -- page: read as HTML; link: a link target checked for its status; image: an image checked for its status.
  kind           text        not null check (kind in ('page', 'link', 'image')),
  -- Site path (+ query) for pages and links, the absolute URL for images.
  path           text        not null check (length(path) between 1 and 2048),
  state          text        not null default 'pending'
                             check (state in ('pending', 'done', 'failed', 'skipped')),
  -- Lower is crawled first: registry pages, CMS records, sitemaps, then links.
  priority       smallint    not null default 4,
  sources        text[]      not null default '{}',
  in_sitemap     boolean     not null default false,
  loc            text        check (loc is null or length(loc) <= 2048),
  expected_live  boolean     not null default false,
  expect_index   boolean,
  expect_follow  boolean,
  attempts       smallint    not null default 0 check (attempts between 0 and 10),
  status         smallint,
  final_status   smallint,
  final_url      text        check (final_url is null or length(final_url) <= 2048),
  hops           jsonb       not null default '[]'::jsonb,
  loop           boolean     not null default false,
  offsite        text        check (offsite is null or length(offsite) <= 300),
  error          text        check (error is null or length(error) <= 300),
  skip_reason    text        check (skip_reason is null or length(skip_reason) <= 300),
  -- What the site's checks read from the page (extract.ts → PageRecord).
  record         jsonb,
  links          jsonb,
  images         jsonb,
  ms             integer,
  fetched_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint site_audit_pages_unique unique (run_id, kind, path)
);

create index if not exists site_audit_pages_pending_idx
  on public.site_audit_pages (run_id, kind, priority, created_at)
  where state = 'pending';

create or replace trigger site_audit_pages_set_updated_at
  before update on public.site_audit_pages
  for each row execute function public.set_updated_at();

create table if not exists public.site_audit_issues (
  id              uuid primary key default gen_random_uuid(),
  -- sha256(origin, rule, path, target), cut to 40 hex characters: one row per issue, however many runs report it.
  fingerprint     text        not null unique check (fingerprint ~ '^[0-9a-f]{40}$'),
  origin          text        not null check (length(origin) <= 200),
  rule            text        not null check (length(rule) between 1 and 80),
  category        text        not null
                              check (category in ('availability', 'indexing', 'sitemap', 'links', 'on-page',
                                                  'structured-data', 'editorial', 'content')),
  severity        text        not null check (severity in ('fix', 'review', 'info')),
  -- 0 fix, 1 review, 2 info: the order the admin lists them in.
  severity_rank   smallint    not null check (severity_rank between 0 and 2),
  path            text        not null check (length(path) between 1 and 2048),
  target          text        check (target is null or length(target) <= 2048),
  page_type       text        not null default 'static' check (length(page_type) <= 40),
  detail          text        not null default '' check (length(detail) <= 500),
  evidence        jsonb       not null default '{}'::jsonb,
  -- Pages involved (link sources, pages using an image), at most 50; affected_count is the full number.
  affected        text[]      not null default '{}' check (cardinality(affected) <= 50),
  affected_count  integer     not null default 0 check (affected_count >= 0),
  -- Where to fix it in the admin, when there is an editor for it.
  admin_path      text        check (admin_path is null or length(admin_path) <= 300),
  status          text        not null default 'open' check (status in ('open', 'resolved')),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  resolved_at     timestamptz,
  first_run_id    uuid        references public.site_audit_runs (id) on delete set null,
  last_run_id     uuid        references public.site_audit_runs (id) on delete set null,
  resolved_run_id uuid        references public.site_audit_runs (id) on delete set null,
  times_seen      integer     not null default 1 check (times_seen >= 1),
  reopened_count  integer     not null default 0 check (reopened_count >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists site_audit_issues_list_idx
  on public.site_audit_issues (origin, status, severity_rank, last_seen_at desc);

create index if not exists site_audit_issues_rule_idx
  on public.site_audit_issues (origin, rule);

create or replace trigger site_audit_issues_set_updated_at
  before update on public.site_audit_issues
  for each row execute function public.set_updated_at();

-- Deny-by-default, matching every other table (see 20260101000400_rls.sql).
-- The backend uses the service-role key, which bypasses RLS.
alter table public.site_audit_runs   enable row level security;
alter table public.site_audit_pages  enable row level security;
alter table public.site_audit_issues enable row level security;
