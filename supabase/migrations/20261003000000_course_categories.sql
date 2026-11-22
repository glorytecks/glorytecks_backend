-- ============================================================================
-- course_categories
--
-- Controlled category list for the course catalogue.
-- The existing courses.category text field is intentionally retained so the
-- public website remains backward-compatible.
-- ============================================================================

create table if not exists public.course_categories (
  id           uuid primary key default gen_random_uuid(),

  slug         text not null unique
               check (
                 slug = lower(slug)
                 and length(btrim(slug)) > 0
               ),

  name         text not null
               check (length(btrim(name)) > 0),

  description  text not null default '',

  order_index  integer not null default 0,

  is_active    boolean not null default true,

  created_at   timestamptz not null default now(),

  updated_at   timestamptz not null default now()
);

-- Prevent "Generic" and "generic" from becoming two categories.
create unique index if not exists
  course_categories_name_lower_unique
on public.course_categories (lower(btrim(name)));

create index if not exists
  course_categories_active_order_idx
on public.course_categories (is_active, order_index, name);

create trigger course_categories_set_updated_at
  before update on public.course_categories
  for each row
  execute function public.set_updated_at();

-- Deny-by-default, matching every other table (see 20260101000400_rls.sql).
-- The backend uses the service-role key, which bypasses RLS.
alter table public.course_categories enable row level security;


-- ============================================================================
-- Backfill categories from existing course records.
--
-- This means existing courses are not left without a category in the new
-- admin dropdown.
-- ============================================================================

with source as (
  select distinct on (lower(btrim(category)))
    btrim(category) as name
  from public.courses
  where length(btrim(coalesce(category, ''))) > 0
  order by lower(btrim(category)), category
),
normalised as (
  select
    name,
    trim(
      both '-'
      from regexp_replace(
        replace(lower(name), '&', ' and '),
        '[^a-z0-9]+',
        '-',
        'g'
      )
    ) as slug
  from source
)
insert into public.course_categories (
  slug,
  name,
  order_index
)
select
  slug,
  name,
  row_number() over (order by name) - 1
from normalised
where slug <> ''
on conflict (slug) do nothing;


-- ============================================================================
-- Ensure the standard GloryTecks categories exist even if the courses table
-- was empty when this migration was applied.
-- ============================================================================

insert into public.course_categories (slug, name, order_index)
values
  ('data-science-and-analytics', 'Data Science & Analytics', 0),
  ('gen-ai', 'Gen AI', 1),
  ('cloud-and-data-engineering', 'Cloud & Data Engineering', 2),
  ('programming-and-databases', 'Programming & Databases', 3)
on conflict do nothing;