import type { TriggerLogger } from "./tasks";

export interface IngestDatasetInput { dataset: string; rows: unknown[]; source?: string }
export interface IngestDatasetDependencies { ingest(input: IngestDatasetInput, signal?: AbortSignal): Promise<{ rowsIngested: number }>; logger?: TriggerLogger }
export type IngestDatasetResult = { ok: true; rowsIngested: number; dataset: string } | { ok: false; error: string; dataset: string };

export async function ingestDataset(input: IngestDatasetInput, deps: IngestDatasetDependencies, signal?: AbortSignal): Promise<IngestDatasetResult> {
  if (!input.dataset || !Array.isArray(input.rows)) return { ok: false, error: "dataset and rows are required", dataset: input.dataset ?? "" };
  try {
    const result = await deps.ingest(input, signal);
    deps.logger?.info?.("dataset ingested", { dataset: input.dataset, rowsIngested: result.rowsIngested });
    return { ok: true, rowsIngested: result.rowsIngested, dataset: input.dataset };
  } catch (error) {
    deps.logger?.error?.("dataset ingestion failed", { error: String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error), dataset: input.dataset };
  }
}

/** Task-shaped alias; wire this handler into Trigger.dev's task() in the app. */
export const ingestDatasetTask = ingestDataset;
