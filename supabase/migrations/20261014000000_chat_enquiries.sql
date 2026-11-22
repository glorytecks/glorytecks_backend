-- ============================================================================
-- chat_enquiries
--
-- Leads from the website chat widget. The widget asks one question at a time
-- (name → course → phone → email → profile → mode) and saves after EACH
-- answer, so a visitor who leaves half-way still leaves their partial details
-- here. A row is created when the visitor gives their name; nothing is stored
-- for a visitor who declines to chat.
--
-- Additive only: nothing else reads this table.
-- ============================================================================

create table if not exists public.chat_enquiries (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null check (length(btrim(name)) > 0),
  course     text,
  phone      text,
  email      text        check (email is null or email = lower(email)),
  profile    text,       -- student / fresher / working professional / career gap
  mode       text,       -- online / classroom / either
  page_url   text,       -- the page the chat was started on
  step       text        not null default 'name'
                         check (step in ('name', 'course', 'phone', 'email', 'profile', 'mode', 'done')),
  status     text        not null default 'new'
                         check (status in ('new', 'contacted', 'converted', 'closed')),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger chat_enquiries_set_updated_at
  before update on public.chat_enquiries
  for each row execute function public.set_updated_at();

create index if not exists chat_enquiries_status_created_idx
  on public.chat_enquiries (status, created_at desc);
create index if not exists chat_enquiries_created_idx
  on public.chat_enquiries (created_at desc);

-- Deny-by-default, matching every other table (see 20260101000400_rls.sql).
-- The backend uses the service-role key, which bypasses RLS.
alter table public.chat_enquiries enable row level security;
