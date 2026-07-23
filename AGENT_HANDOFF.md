# Agent handoff

## What works

- Kaggle HTTP import uses `KAGGLE_API_TOKEN`; it does **not** require Python or the Kaggle CLI.
- Local verification: Kaggle Iris files list/download works; ClickHouse has two prior Iris tables with 150 rows each.
- Trigger tasks: `ingest-dataset`, `analyze-dataset`.
- User auth defaults to required. `LOCAL_DEMO_AUTH=true` is an explicit non-live demo escape hatch only.
- Email/password sign-in and sign-up are implemented at `/login`.

## Required environment

Vercel: `NEXT_PUBLIC_APP_URL`, Supabase URL/anon key, `TRIGGER_SECRET_KEY`, `LOCAL_DEMO_AUTH=false`.

Trigger prod: `KAGGLE_API_TOKEN`, Supabase URL/service-role key, ClickHouse URL/user/password/database, R2 endpoint/bucket/key/secret, Featherless key/base URL/model.

## One required Supabase action

Run `supabase/schema.sql`, then ensure the Trigger service role can access app tables:

```sql
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
```

## Current design / gotchas

- Imports deduplicate per authenticated workspace + Kaggle owner/slug/version. The API now returns the existing import instead of creating another one.
- Earlier duplicate Iris tables came from local demo mode creating random workspace IDs; do not use demo mode for live tasks.
- The UI used to show a fake `Demo answer:` response; that fallback was removed. It polls `analysis_runs` for the real result.
- A valid Kaggle URL previously surfaced as “Invalid Kaggle dataset URL” when an unrelated setup step failed. URL validation is now separated and later failures are returned as `Import setup failed: …`.
- If analysis says dataset is missing, the import record was not created/published for the active authenticated workspace. Inspect `dataset_imports` and the Trigger run.

## Validate locally

1. Set `LOCAL_DEMO_AUTH=false` and sign in at `/login`.
2. Run `pnpm dev` and `pnpm exec trigger dev` in separate terminals.
3. Import `https://www.kaggle.com/datasets/uciml/iris`.
4. Wait for `ingest-dataset` to complete, then ask “How many rows are in this dataset?”

## Deployment

`vercel.json` points Vercel to `apps/web/.next`. Deploy Vercel after pushing web changes and deploy Trigger after changing files under `trigger/` or task dependencies.
