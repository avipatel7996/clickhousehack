import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { FeatherlessClient } from "../packages/analysis/src/client";
import { runAnalysis } from "../packages/analysis/src/runtime";
import { ClickHouseClient, createClickHouseConfig, validateReadOnlySql } from "../packages/clickhouse/src";

const inputSchema = z.object({
  analysisId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  datasetId: z.string().uuid(),
  question: z.string().min(1).max(4000),
  chartPreference: z.enum(["auto", "bar", "line", "scatter", "table"]).default("auto"),
});

/** Analysis runs receive IDs, never raw dataset rows. Tool execution is injected behind the read-only ClickHouse boundary. */
export const analyzeDataset = task({
  id: "analyze-dataset",
  queue: { name: "analysis", concurrencyLimit: 5 },
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 500, maxTimeoutInMs: 10000, randomize: true },
  run: async (payload: z.input<typeof inputSchema>) => {
    const input = inputSchema.parse(payload);
    if (!process.env.FEATHERLESS_API_KEY) throw new Error("FEATHERLESS_API_KEY is required");
    const supabase = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL
      ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
      : null;
    if (supabase) await supabase.from("analysis_runs").update({ status: "running" }).eq("id", input.analysisId);
    let physicalTables: string[] = [];
    let version = "unknown";
    if (supabase) {
      const result = await supabase.from("dataset_imports").select("physical_tables,source_version,status").eq("id", input.datasetId).eq("workspace_id", input.workspaceId).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("Dataset import was not found for this workspace. Sign in, import the dataset, and ask the question after the import is published.");
      physicalTables = Array.isArray(result.data.physical_tables) ? result.data.physical_tables.filter((value): value is string => typeof value === "string") : [];
      version = String(result.data.source_version ?? version);
      if (result.data.status !== "published" || !physicalTables.length) throw new Error("Dataset is not published or has no analytical table");
    }
    if (!physicalTables.length) throw new Error("No published dataset is available");
    const clickhouse = new ClickHouseClient(createClickHouseConfig());
    const schemaRows = await clickhouse.query<{ name: string; type: string }>(`DESCRIBE TABLE ${physicalTables[0]}`);
    const executor = {
      query: async <T = Record<string, unknown>>(sql: string, options: any) => {
        const check = validateReadOnlySql(sql, physicalTables);
        if (!check.ok) throw new Error(check.error);
        return clickhouse.query<T>(sql, options);
      },
    };
    const result = await runAnalysis(input.question, {
      client: new FeatherlessClient({ apiKey: process.env.FEATHERLESS_API_KEY, baseUrl: process.env.FEATHERLESS_BASE_URL, model: process.env.FEATHERLESS_MODEL }),
      queryExecutor: executor,
      schema: { datasetId: input.datasetId, version, table: physicalTables[0], columns: schemaRows.rows.map(row => ({ name: row.name, type: row.type })) },
      model: process.env.FEATHERLESS_MODEL,
    });
    if (supabase) {
      const update = await supabase.from("analysis_runs").update({ status: "completed", answer: result }).eq("id", input.analysisId);
      if (update.error) throw update.error;
    }
    return { status: "completed" as const, analysisId: input.analysisId, datasetId: input.datasetId, result };
  },
});
