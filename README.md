# Kaggle → ClickHouse Analyst

Next.js UI + Trigger.dev workers: import a public Kaggle dataset into ClickHouse, then run grounded questions against the imported table.

```bash
pnpm install
pnpm dev
pnpm exec trigger dev
```

Use email/password login. Apply `supabase/schema.sql` before testing live workflows. Deployment details and current known state are in [AGENT_HANDOFF.md](AGENT_HANDOFF.md).
