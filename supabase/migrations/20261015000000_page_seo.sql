-- ============================================================================
-- Page SEO (non-blog pages)
--
-- Additive only. No existing row changes and nothing reads the new columns
-- until a value is saved, so applying this migration changes no rendered page.
-- Rollback: backend/supabase/rollbacks/20261015000000_page_seo.down.sql.
--
-- 1. page_seo — search and social overrides for pages that have no natural
--    CMS record: the fixed pages, the resource detail pages and the
--    course × locality landing pages. One row per canonical path. A missing
--    row, or a null column, means "use the page's built-in default"; the
--    marketing site never depends on a row existing.
--
-- 2. courses / about_page — the existing seo_* group gains the three fields
--    page_seo has and they lacked: a social image alt text, a nofollow flag
--    and an internal intent note. Courses and /about keep their SEO on their
--    own record rather than gaining a second copy in page_seo.
--
-- 3. comparisons — gains meta_description beside its existing meta_title,
--    matching legal_docs.
--
-- 4. seo_audit_log — who changed which SEO fields of which page, and when.
--    Field NAMES only: no values, so nothing here duplicates page content and
--    nothing secret can land in it.
--
-- Canonical URLs are deliberately absent from page_seo: they are generated
-- from the site's route registry, never typed into the CMS.
-- ============================================================================

create table if not exists public.page_seo (
  id               uuid primary key default gen_random_uuid(),
  -- Canonical site-relative path, exactly as the route registry spells it.
  path             text        not null unique
                               check (path = '/' or path ~ '^(/[a-z0-9]+(-[a-z0-9]+)*)+$'),
  meta_title       text        check (meta_title is null
                                      or (length(meta_title) between 1 and 120 and meta_title = btrim(meta_title))),
  meta_description text        check (meta_description is null
                                      or (length(meta_description) between 1 and 320 and meta_description = btrim(meta_description))),
  og_title         text        check (og_title is null
                                      or (length(og_title) between 1 and 120 and og_title = btrim(og_title))),
  og_description   text        check (og_description is null
                                      or (length(og_description) between 1 and 320 and og_description = btrim(og_description))),
  og_image         text        check (og_image is null or (og_image ~ '^https://' and length(og_image) <= 2048)),
  og_image_alt     text        check (og_image_alt is null
                                      or (length(og_image_alt) between 1 and 200 and og_image_alt = btrim(og_image_alt))),
  -- Editorial targeting only. Never rendered (the site emits no meta keywords).
  keywords         text[]      not null default '{}' check (cardinality(keywords) <= 10),
  -- Robots can only narrow what the route registry allows: a page the
  -- registry keeps out of the index can never be made indexable here.
  noindex          boolean     not null default false,
  nofollow         boolean     not null default false,
  -- Internal note for editors (the search intent the page serves). Never public.
  intent_note      text        check (intent_note is null
                                      or (length(intent_note) between 1 and 500 and intent_note = btrim(intent_note))),
  updated_by       uuid        references public.admin_users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- "index, nofollow" is not offered: a page worth indexing should pass its links.
  constraint page_seo_nofollow_requires_noindex check (not nofollow or noindex)
);

create trigger page_seo_set_updated_at
  before update on public.page_seo
  for each row execute function public.set_updated_at();

alter table public.courses
  add column if not exists seo_og_image_alt text,
  add column if not exists seo_nofollow     boolean not null default false,
  add column if not exists seo_intent_note  text;

alter table public.about_page
  add column if not exists seo_og_image_alt text,
  add column if not exists seo_nofollow     boolean not null default false,
  add column if not exists seo_intent_note  text;

-- Guarded so a re-apply after the rollback script cannot fail half-way.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'courses_seo_nofollow_requires_noindex') then
    alter table public.courses
      add constraint courses_seo_nofollow_requires_noindex check (not seo_nofollow or seo_noindex);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'about_page_seo_nofollow_requires_noindex') then
    alter table public.about_page
      add constraint about_page_seo_nofollow_requires_noindex check (not seo_nofollow or seo_noindex);
  end if;
end
$$;

alter table public.comparisons
  add column if not exists meta_description text not null default '';

create table if not exists public.seo_audit_log (
  id             uuid primary key default gen_random_uuid(),
  entity_type    text        not null
                             check (entity_type in ('page_seo', 'course', 'about', 'comparison', 'legal')),
  -- The canonical path of the page whose SEO changed.
  entity_key     text        not null,
  -- The record's id when the page is record-backed (course, comparison, …).
  record_id      uuid,
  action         text        not null check (action in ('create', 'update', 'delete')),
  changed_fields text[]      not null default '{}',
  editor_id      uuid        references public.admin_users (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists seo_audit_log_key_created_idx
  on public.seo_audit_log (entity_key, created_at desc);

-- Deny-by-default, matching every other table (see 20260101000400_rls.sql).
-- The backend uses the service-role key, which bypasses RLS.
alter table public.page_seo      enable row level security;
alter table public.seo_audit_log enable row level security;
