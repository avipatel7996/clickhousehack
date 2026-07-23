# Kaggle → ClickHouse Analyst

Import a public Kaggle dataset once, then ask grounded questions through the web dashboard or Telegram. Trigger.dev owns durable imports and analysis runs; ClickHouse stores immutable analytical snapshots.

## Quick start

```bash
pnpm install
pnpm dev
```

`pnpm dev` loads `.env.local` when present and falls back to `.env.example` for this demo. Before committing or deploying, move real secrets out of `.env.example` and use local/hosting secret stores.

For live ingestion workers, install the official Kaggle CLI in the Trigger runtime (or local Python environment):

```bash
python3 -m pip install -r requirements.txt
```

## Activate live workflows

Apply [`supabase/schema.sql`](supabase/schema.sql) to the Supabase project, then authenticate the Trigger CLI once and deploy the two tasks:

```bash
npx trigger.dev@latest login
pnpm trigger:deploy
```

Until the Trigger deployment is active, the web API can validate requests and dispatch runs, but those runs remain queued in Trigger Cloud. Local development defaults to `LOCAL_DEMO_AUTH=true`; set it to `false` to exercise Supabase magic-link authentication.

The web app runs without cloud credentials in demo mode: it validates import URLs and shows the intended workflow. Add ClickHouse, Supabase, Trigger, Featherless, Kaggle, Telegram, and R2 secrets for live runs.

## Invariants

- Public Kaggle Dataset URLs only; supported tabular files are CSV, TSV, JSONL, and Parquet.
- 2 GiB maximum per import. Source files and published ClickHouse tables are immutable until the workspace explicitly deletes an import.
- User questions can execute only bounded, allowlisted read-only SQL. Every answer carries dataset version, SQL/query evidence, and caveats.

## Developer workflow

Install Trigger.dev's agent skills with `npx trigger.dev@latest skills` and use its MCP server in read-only mode for project docs, deployment, and run inspection. Do not expose that developer MCP server to end users.
