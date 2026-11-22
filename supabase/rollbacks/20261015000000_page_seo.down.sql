-- guardrail: destructive-approved rollback of 20261015000000_page_seo.sql, run by hand only
-- ============================================================================
-- Rollback for 20261015000000_page_seo.sql
--
-- NOT a migration: this directory is outside supabase/migrations, so neither
-- `supabase db push` nor `supabase db reset` ever runs it. Run it by hand, and
-- only after the backend and admin builds that use these columns have been
-- rolled back, or their SEO endpoints will start failing.
--
-- It DELETES every saved page SEO override, the course/about social alt texts,
-- intent notes and nofollow flags, comparison meta descriptions and the SEO
-- audit history. Export first:
--
--   cd backend && npx tsx src/scripts/page-seo.ts export page-seo-backup.json
--
-- The marketing site needs no change: with these gone it renders every page's
-- built-in title and description again.
-- ============================================================================

begin;

drop table if exists public.seo_audit_log;
drop table if exists public.page_seo;

alter table public.courses    drop constraint if exists courses_seo_nofollow_requires_noindex;
alter table public.courses    drop column if exists seo_og_image_alt;
alter table public.courses    drop column if exists seo_nofollow;
alter table public.courses    drop column if exists seo_intent_note;

alter table public.about_page drop constraint if exists about_page_seo_nofollow_requires_noindex;
alter table public.about_page drop column if exists seo_og_image_alt;
alter table public.about_page drop column if exists seo_nofollow;
alter table public.about_page drop column if exists seo_intent_note;

alter table public.comparisons drop column if exists meta_description;

-- Supabase records applied migrations by version. Forget this one so the
-- forward migration can be applied again later.
delete from supabase_migrations.schema_migrations where version = '20261015000000';

commit;
