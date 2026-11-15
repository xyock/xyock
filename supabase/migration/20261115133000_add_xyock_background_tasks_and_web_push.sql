create table if not exists public.xyock_ai_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  answer text,
  sources jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists xyock_ai_tasks_user_created_idx
  on public.xyock_ai_tasks (user_id, created_at desc);

create table if not exists public.xyock_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%'),
  p256dh text not null,
  auth_secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists xyock_push_subscriptions_user_idx
  on public.xyock_push_subscriptions (user_id);

create table if not exists public.xyock_vapid_keys (
  id text primary key check (id = 'default'),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);

alter table public.xyock_ai_tasks enable row level security;
alter table public.xyock_push_subscriptions enable row level security;
alter table public.xyock_vapid_keys enable row level security;

revoke all on table public.xyock_ai_tasks from public, anon, authenticated;
revoke all on table public.xyock_push_subscriptions from public, anon, authenticated;
revoke all on table public.xyock_vapid_keys from public, anon, authenticated;

grant all on table public.xyock_ai_tasks to service_role;
grant all on table public.xyock_push_subscriptions to service_role;
grant all on table public.xyock_vapid_keys to service_role;

drop policy if exists "Deny client access to xyock AI tasks" on public.xyock_ai_tasks;
create policy "Deny client access to xyock AI tasks"
  on public.xyock_ai_tasks for all to anon, authenticated
  using (false) with check (false);

drop policy if exists "Deny client access to xyock push subscriptions" on public.xyock_push_subscriptions;
create policy "Deny client access to xyock push subscriptions"
  on public.xyock_push_subscriptions for all to anon, authenticated
  using (false) with check (false);

drop policy if exists "Deny client access to xyock VAPID keys" on public.xyock_vapid_keys;
create policy "Deny client access to xyock VAPID keys"
  on public.xyock_vapid_keys for all to anon, authenticated
  using (false) with check (false);
