import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { importDataset } from "../packages/ingestion/src/service";
import { KaggleApiGateway, KaggleCliGateway, S3R2ObjectStore, ClickHousePublisher } from "../packages/ingestion/src/runtime";
import { parseKaggleDatasetUrl } from "../packages/ingestion/src/url";
import { clickHouseConfigFromEnv } from "../packages/clickhouse/src/env";

const inputSchema = z.object({
  importId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  kaggleRef: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+(?:\/versions\/\d+)?$/i),
  selectedFiles: z.array(z.string()).max(20).default([]),
});

/** Durable entrypoint. Raw files stay in object storage; only references cross Trigger payload limits. */
export const ingestDataset = task({
  id: "ingest-dataset",
  queue: { name: "imports", concurrencyLimit: 2 },
  retry: { maxAttempts: 3, factor: 1.8, minTimeoutInMs: 1000, maxTimeoutInMs: 30000, randomize: true },
  run: async (payload: z.input<typeof inputSchema>) => {
    const input = inputSchema.parse(payload);
    const ref = parseKaggleDatasetUrl(`https://www.kaggle.com/datasets/${input.kaggleRef}`);
    const supabase = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL
      ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
      : null;
    if (supabase) await supabase.from("dataset_imports").update({ status: "inspecting" }).eq("id", input.importId).eq("workspace_id", input.workspaceId);
    if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) throw new Error("R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required");
    const repository = {
      async findByIdempotencyKey(key: string) {
        if (!supabase) return null;
        const result = await supabase.from("dataset_imports").select("id,status").eq("workspace_id", input.workspaceId).eq("idempotency_key", key).maybeSingle();
        if (result.error) throw result.error;
        return result.data ? { importId: result.data.id, status: result.data.status } : null;
      },
      async markFailed(data: { importId: string; message: string }) {
        if (!supabase) return;
        const result = await supabase.from("dataset_imports").update({ status: "failed", error_message: data.message }).eq("id", data.importId).eq("workspace_id", input.workspaceId);
        if (result.error) throw result.error;
      },
      async markPublished(data: { importId: string; source: typeof ref; version: number; files: unknown[]; tableIds: string[]; rowCount: number }) {
        if (!supabase) return;
        const result = await supabase.from("dataset_imports").update({ status: "published", source_manifest: data.files, physical_tables: data.tableIds, row_count: data.rowCount, source_version: data.version }).eq("id", data.importId);
        if (result.error) throw result.error;
      },
    };
    try {
    if (supabase) await supabase.from("dataset_imports").update({ status: "loading" }).eq("id", input.importId).eq("workspace_id", input.workspaceId);
    try {
      const result = await importDataset({ workspaceId: input.workspaceId, importId: input.importId, kaggleUrl: `https://www.kaggle.com/datasets/${input.kaggleRef}`, selectedFiles: input.selectedFiles }, {
        // pythonExtension creates this venv in the Trigger image. Do not rely on
        // the base image PATH (which may not contain `python` or `kaggle`).
        kaggle: process.env.KAGGLE_API_TOKEN
          ? new KaggleApiGateway({ token: process.env.KAGGLE_API_TOKEN })
          : new KaggleCliGateway({ executable: [process.env.PYTHON_BIN_PATH, process.env.KAGGLE_CLI_PATH].find((value) => value && value.includes("/")) || "/opt/venv/bin/python" }),
        objects: new S3R2ObjectStore({ endpoint: process.env.R2_ENDPOINT, bucket: process.env.R2_BUCKET, accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }),
        clickhouse: new ClickHousePublisher({ config: clickHouseConfigFromEnv(), table: `dataset_${input.importId.replace(/-/g, "_")}` }),
        repository,
      });
    return { status: "published" as const, importId: input.importId, workspaceId: input.workspaceId, result };
    } catch (error) {
      if (supabase) await supabase.from("dataset_imports").update({ status: "failed" }).eq("id", input.importId).eq("workspace_id", input.workspaceId);
      throw error;
    }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.markFailed?.({ importId: input.importId, message });
      throw error;
    }
  },
});
