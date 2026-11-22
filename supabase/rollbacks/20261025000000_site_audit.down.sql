-- guardrail: destructive-approved rollback of 20261025000000_site_audit.sql, run by hand only
-- ============================================================================
-- Rollback for 20261025000000_site_audit.sql
--
-- NOT a migration: this directory is outside supabase/migrations, so neither
-- `supabase db push` nor `supabase db reset` ever runs it. Run it by hand.
--
-- It DELETES the technical SEO audit's history: every run, the URLs each run
-- checked, and every issue with its first-seen / last-seen dates. Nothing else
-- depends on these tables: the API notices they are missing and the admin's
-- Technical SEO audit screen says the audit is not set up. Content, page SEO
-- settings and the public site are unaffected.
-- ============================================================================

begin;

drop table if exists public.site_audit_issues;
drop table if exists public.site_audit_pages;
drop table if exists public.site_audit_runs;

commit;
