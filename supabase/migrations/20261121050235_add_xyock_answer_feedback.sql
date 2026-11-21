create table if not exists public.xyock_answer_votes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  answer_id text not null check (char_length(answer_id) between 1 and 160),
  vote text not null check (vote in ('up', 'down')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint xyock_answer_votes_user_answer_key unique (user_id, answer_id)
);

create table if not exists public.xyock_answer_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  answer_id text not null check (char_length(answer_id) between 1 and 160),
  answer_text text not null default '' check (char_length(answer_text) <= 4000),
  category text not null check (category in ('incorrect', 'unsafe', 'harassment', 'privacy', 'spam', 'other')),
  reason text not null default '' check (char_length(reason) <= 1500),
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'pending_config', 'failed')),
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz not null default now()
);

alter table public.xyock_answer_votes enable row level security;
alter table public.xyock_answer_reports enable row level security;

revoke all on table public.xyock_answer_votes from public, anon, authenticated;
revoke all on table public.xyock_answer_reports from public, anon, authenticated;
grant all on table public.xyock_answer_votes to service_role;
grant all on table public.xyock_answer_reports to service_role;

create index if not exists xyock_answer_votes_vote_idx
  on public.xyock_answer_votes (vote);
create index if not exists xyock_answer_reports_created_at_idx
  on public.xyock_answer_reports (created_at desc);
