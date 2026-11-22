-- ============================================================================
-- Rollback for 20261016000000_settings_contact_defaults.sql
--
-- NOT a migration: this directory is outside supabase/migrations, so neither
-- `supabase db push` nor `supabase db reset` ever runs it. Run it by hand.
--
-- Restores the column defaults declared in 20260101000100_singletons.sql. No
-- row changes either way. These are the values the owner confirmed WRONG on
-- 2026-10-16, so a database rolled back this way creates a new settings row
-- with the old address and email.
-- ============================================================================

alter table public.settings
  alter column email set default 'gloryteckss@gmail.com',
  alter column address set default $def$603, Annapurna Block, Aditya Enclave, Ameerpet, Hyderabad – 500038, Telangana, India$def$;
