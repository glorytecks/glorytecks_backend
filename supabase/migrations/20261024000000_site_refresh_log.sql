-- ============================================================================
-- Site refresh log
--
-- Additive only: one new table, nothing existing changes. Until this is
-- applied the API carries on as before — it notices the table is missing,
-- skips recording, and the admin dashboard says refresh history is not set up.
-- Rollback: backend/supabase/rollbacks/20261024000000_site_refresh_log.down.sql.
--
-- After a CMS write that changes something a visitor can see, the API asks the
-- marketing site to refresh the affected pages (POST /api/revalidate, see
-- backend/src/lib/siteRevalidation.ts). Until now the outcome was only written
-- to the function log, so a failing refresh — content that stays stale for up
-- to the site's 15-day ISR window — was invisible in the admin.
--
-- One row per attempt that was actually sent: 'sent' (the site accepted it) or
-- 'failed' (after the retry). Skipped notifications (nothing public changed,
-- or the webhook is not configured) are not recorded; the dashboard reports
-- the configuration itself. Rows hold the resource name, the site cache tags
-- (public slugs) and a short reason such as "HTTP 503" — never the request,
-- the secret or any lead data.
-- ============================================================================

create table if not exists public.site_refresh_log (
  id           uuid primary key default gen_random_uuid(),
  -- The CMS resource whose write triggered the refresh ('blogs', 'courses', …).
  resource     text        not null check (length(resource) between 1 and 60),
  -- The site cache tags sent, e.g. {blogs, blog:some-slug}.
  tags         text[]      not null default '{}',
  status       text        not null check (status in ('sent', 'failed')),
  -- Why it failed ('HTTP 503', 'timed out after 4000 ms', 'network error').
  reason       text        check (reason is null or length(reason) <= 200),
  http_status  integer,
  attempts     integer     not null default 1 check (attempts between 1 and 10),
  created_at   timestamptz not null default now()
);

create index if not exists site_refresh_log_created_idx
  on public.site_refresh_log (created_at desc);

-- Failures are what the dashboard looks for first.
create index if not exists site_refresh_log_failed_idx
  on public.site_refresh_log (created_at desc)
  where status = 'failed';

-- Deny-by-default, matching every other table (see 20260101000400_rls.sql).
-- The backend uses the service-role key, which bypasses RLS.
alter table public.site_refresh_log enable row level security;
