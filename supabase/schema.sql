create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  primary key (workspace_id, user_id)
);

create table if not exists public.dataset_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_url text not null,
  canonical_ref text not null,
  source_version integer not null,
  status text not null check (status in ('queued', 'inspecting', 'loading', 'published', 'failed')),
  source_manifest jsonb not null default '[]'::jsonb,
  physical_tables jsonb not null default '[]'::jsonb,
  row_count bigint,
  license text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  dataset_import_id uuid references public.dataset_imports(id) on delete restrict,
  question text not null,
  status text not null default 'queued',
  error_message text,
  answer jsonb,
  trigger_run_id text,
  created_at timestamptz not null default now()
);
alter table public.analysis_runs add column if not exists error_message text;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.dataset_imports enable row level security;
alter table public.analysis_runs enable row level security;

create policy workspace_member_read on public.workspaces for select using (
  exists (select 1 from public.workspace_members m where m.workspace_id = id and m.user_id = auth.uid())
);
create policy workspace_create on public.workspaces for insert with check (auth.uid() is not null);
create policy member_read on public.workspace_members for select using (user_id = auth.uid());
create policy member_create on public.workspace_members for insert with check (user_id = auth.uid());
create policy imports_member_read on public.dataset_imports for select using (
  exists (select 1 from public.workspace_members m where m.workspace_id = workspace_id and m.user_id = auth.uid())
);
create policy imports_member_create on public.dataset_imports for insert with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = workspace_id and m.user_id = auth.uid())
);
create policy analyses_member_read on public.analysis_runs for select using (
  exists (select 1 from public.workspace_members m where m.workspace_id = workspace_id and m.user_id = auth.uid())
);
create policy analyses_member_create on public.analysis_runs for insert with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = workspace_id and m.user_id = auth.uid())
);
