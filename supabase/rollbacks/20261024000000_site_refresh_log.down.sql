-- guardrail: destructive-approved rollback of 20261024000000_site_refresh_log.sql, run by hand only
-- ============================================================================
-- Rollback for 20261024000000_site_refresh_log.sql
--
-- NOT a migration: this directory is outside supabase/migrations, so neither
-- `supabase db push` nor `supabase db reset` ever runs it. Run it by hand.
--
-- It DELETES the site refresh history. Nothing else depends on the table: the
-- API detects that it is missing, stops recording, and the admin dashboard
-- reports refresh history as not set up. Content and the site are unaffected.
-- ============================================================================

begin;

drop table if exists public.site_refresh_log;

commit;
