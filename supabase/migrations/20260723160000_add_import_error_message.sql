-- Required by the import progress API and worker. `IF NOT EXISTS` keeps this
-- safe for environments where the original schema.sql was already applied.
alter table public.dataset_imports add column if not exists error_message text;
alter table public.analysis_runs add column if not exists error_message text;
