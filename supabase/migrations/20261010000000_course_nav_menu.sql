-- ============================================================================
-- Courses menu: per-course visibility and position
--
-- show_in_nav  Whether the course is listed in the website header's Courses
--              menu (desktop dropdown and mobile menu). Nothing else reads
--              it: the course page, the courses list, the footer and the
--              sitemap still show every published course.
-- nav_order    The course's position in that menu, 1 = first. The admin form
--              requires it while show_in_nav is on; it is ignored while off.
--
-- Additive only, so a backend that does not know these columns keeps working.
-- ============================================================================

alter table public.courses
  add column if not exists show_in_nav boolean not null default true,
  add column if not exists nav_order integer
    check (nav_order is null or nav_order >= 1);

-- Keep today's menu exactly as it is: number every existing course in the
-- order the menu already uses (order_index, then title).
update public.courses c
set nav_order = ranked.position
from (
  select id, row_number() over (order by order_index, title) as position
  from public.courses
) ranked
where c.id = ranked.id
  and c.nav_order is null;
