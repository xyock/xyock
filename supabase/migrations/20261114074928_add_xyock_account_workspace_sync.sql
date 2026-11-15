-- Account-bound settings, projects, and project source files for cross-device sync.
-- Every row is owned by the Supabase Auth user and protected by RLS.

create table if not exists public.xyock_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint xyock_user_settings_object check (jsonb_typeof(settings) = 'object'),
  constraint xyock_user_settings_size check (pg_column_size(settings) < 1500000)
);

create table if not exists public.xyock_projects (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null default 'Untitled project',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint xyock_projects_id_length check (length(id) between 1 and 100),
  constraint xyock_projects_name_length check (length(name) between 1 and 160)
);

create table if not exists public.xyock_project_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id text not null,
  name text not null,
  size bigint not null default 0,
  status text not null default '',
  note text not null default '',
  content text,
  updated_at timestamptz not null default now(),
  constraint xyock_project_files_unique_name unique (user_id, project_id, name),
  constraint xyock_project_files_project_fk
    foreign key (user_id, project_id)
    references public.xyock_projects(user_id, id)
    on delete cascade,
  constraint xyock_project_files_size_nonnegative check (size >= 0),
  constraint xyock_project_files_status check (status in ('', 'warn', 'bad')),
  constraint xyock_project_files_content_size check (content is null or octet_length(content) <= 300000)
);

create index if not exists xyock_projects_user_updated_idx
  on public.xyock_projects(user_id, updated_at desc);
create index if not exists xyock_project_files_project_idx
  on public.xyock_project_files(user_id, project_id, name);

alter table public.xyock_user_settings enable row level security;
alter table public.xyock_projects enable row level security;
alter table public.xyock_project_files enable row level security;

drop policy if exists "Users manage own xyock settings" on public.xyock_user_settings;
create policy "Users manage own xyock settings" on public.xyock_user_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users manage own xyock projects" on public.xyock_projects;
create policy "Users manage own xyock projects" on public.xyock_projects
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users manage own xyock project files" on public.xyock_project_files;
create policy "Users manage own xyock project files" on public.xyock_project_files
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all privileges on table public.xyock_user_settings, public.xyock_projects, public.xyock_project_files from anon, authenticated;
grant select, insert, update, delete on table public.xyock_user_settings, public.xyock_projects, public.xyock_project_files to authenticated;
