import type { AnswerEnvelope } from "../../analysis/src/envelope";
import { answerEnvelope, errorEnvelope } from "../../analysis/src/envelope";
import type { ForecastAnalyzer } from "./tasks";

export interface AnalyzeDatasetInput { dataset: string; question?: string; [key: string]: unknown }
export async function analyzeDataset(input: AnalyzeDatasetInput, analyzer: ForecastAnalyzer, signal?: AbortSignal): Promise<AnswerEnvelope<unknown>> {
  if (!input.dataset) return errorEnvelope("INVALID_DATASET", "dataset is required");
  try { return answerEnvelope(await analyzer.forecast({ ...input, signal }), { metadata: { dataset: input.dataset } }); }
  catch (error) { return errorEnvelope("ANALYSIS_FAILED", error instanceof Error ? error.message : String(error)); }
}
export const analyzeDatasetTask = analyzeDataset;
