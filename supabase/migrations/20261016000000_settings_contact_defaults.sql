-- ============================================================================
-- Settings contact defaults
--
-- On 2026-10-16 the business owner confirmed the public contact facts: the
-- centre is at 611, Annapurna Block (not 603) and the public email is
-- info@glorytecks.com (not gloryteckss@gmail.com). See
-- main-website/config/business.ts.
--
-- Changes the COLUMN DEFAULTS only. get_or_create_settings() inserts
-- `default values` when no settings row exists, so on a fresh database the
-- footer and contact page would otherwise show the old address and email. No
-- existing row changes: the live Settings row already holds both values.
--
-- 20260101000100_singletons.sql still declares the old defaults; applied
-- migrations are immutable (tests/guardrails.test.ts), so the correction
-- lives here.
-- Rollback: backend/supabase/rollbacks/20261016000000_settings_contact_defaults.down.sql.
-- ============================================================================

alter table public.settings
  alter column email set default 'info@glorytecks.com',
  alter column address set default $def$611, Annapurna Block, Aditya Enclave, Ameerpet, Hyderabad – 500038, Telangana, India$def$;
