import type { QueryExecutor, QueryOptions, QueryResult } from "../../core/src/types";
import type { ChatMessage, ChatTool, FeatherlessClient } from "./client";

export interface DatasetColumn { name: string; type: string; description?: string }
export interface DatasetSchema {
  datasetId: string;
  version: string | number;
  columns: DatasetColumn[];
  rowCount?: number;
  table?: string;
}
export interface RuntimeQueryEvidence {
  queryId: string;
  sql: string;
  datasetId: string;
  rowCount: number;
  elapsedMs?: number;
}
export interface RuntimeChart { type: "bar" | "line" | "scatter" | "table"; x?: string; y?: string; series?: string }
export interface StructuredAnalysisAnswer {
  answer: string;
  evidence: RuntimeQueryEvidence[];
  chart?: RuntimeChart;
  caveats: string[];
  datasetVersion: string;
}
/** Familiar aliases for consumers that use the shared analysis vocabulary. */
export type QueryEvidence = RuntimeQueryEvidence;
export type ChartSpec = RuntimeChart;
export type AnalysisResult = StructuredAnalysisAnswer;
export interface AnalysisRuntimeOptions {
  client: Pick<FeatherlessClient, "chat">;
  queryExecutor: QueryExecutor;
  schema: DatasetSchema;
  model?: string;
  maxToolCalls?: number;
  queryOptions?: QueryOptions;
  signal?: AbortSignal;
}

const queryTool: ChatTool = {
  type: "function",
  function: {
    name: "query_dataset",
    description: "Run one bounded, read-only SQL query against the dataset. Use this to ground the answer.",
    parameters: {
      type: "object", properties: { sql: { type: "string", description: "A SELECT or WITH query" } }, required: ["sql"], additionalProperties: false,
    },
  },
};

function assertReadOnly(sql: string): string {
  const normalized = sql.trim();
  if (!normalized || normalized.includes(";")) throw new Error("Only one read-only SQL statement is permitted");
  if (!/^(select|with)\b/i.test(normalized) || /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|optimize)\b/i.test(normalized)) {
    throw new Error("Query must be a read-only SELECT or WITH statement");
  }
  return normalized;
}

function parseToolArgs(raw: string): { sql?: string; query?: string } {
  try { return JSON.parse(raw) as { sql?: string; query?: string }; } catch { throw new Error("Invalid query tool arguments"); }
}

function parseAnswer(content: string | null, schema: DatasetSchema, evidence: RuntimeQueryEvidence[]): StructuredAnalysisAnswer {
  let parsed: Partial<StructuredAnalysisAnswer> = {};
  if (content) {
    try {
      const normalized = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      parsed = JSON.parse(normalized) as Partial<StructuredAnalysisAnswer>;
    }
    catch { parsed = { answer: content }; }
  }
  const chart = parsed.chart && ["bar", "line", "scatter", "table"].includes(parsed.chart.type) ? parsed.chart : undefined;
  return {
    answer: typeof parsed.answer === "string" ? parsed.answer : "Unable to produce an answer from the available data.",
    evidence,
    ...(chart ? { chart } : {}),
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats.filter((x): x is string => typeof x === "string") : [],
    datasetVersion: String(parsed.datasetVersion ?? schema.version),
  };
}

/** Runs a grounded Featherless tool-calling analysis using only the injected read-only executor. */
export async function runAnalysis(question: string, options: AnalysisRuntimeOptions): Promise<StructuredAnalysisAnswer> {
  if (!question.trim()) throw new Error("question is required");
  const schemaText = JSON.stringify(options.schema);
  const messages: ChatMessage[] = [
    { role: "system", content: `You are a data analyst. Dataset schema: ${schemaText}. Answer only from query results. Return JSON with answer (string), chart (optional {type,x,y,series}), caveats (string[]), and datasetVersion.` },
    { role: "user", content: question },
  ];
  const evidence: RuntimeQueryEvidence[] = [];
  const maxToolCalls = Math.max(0, options.maxToolCalls ?? 4);
  let calls = 0;
  while (true) {
    const needsTool = calls === 0 || messages[messages.length - 1]?.role === "tool";
    const response = await options.client.chat({
      messages,
      model: options.model,
      temperature: 0,
      ...(needsTool ? {} : { response_format: { type: "json_object" } }),
      tools: queryTool ? [queryTool] : [],
      tool_choice: calls === 0 ? { type: "function", function: { name: "query_dataset" } } : "auto",
    }, options.signal);
    const message = response.choices[0]?.message;
    if (!message) throw new Error("Featherless returned no assistant message");
    const toolCalls = message.tool_calls ?? [];
    messages.push({ role: "assistant", content: message.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) return parseAnswer(message.content, options.schema, evidence);
    if (calls + toolCalls.length > maxToolCalls) throw new Error(`Analysis exceeded the ${maxToolCalls}-query limit`);
    for (const call of toolCalls) {
      if (call.type !== "function" || call.function.name !== "query_dataset") throw new Error(`Unsupported tool: ${call.function.name}`);
      const toolArgs = parseToolArgs(call.function.arguments);
      const sql = assertReadOnly(toolArgs.sql ?? toolArgs.query ?? "");
      const started = Date.now();
      let result: QueryResult;
      try { result = await options.queryExecutor.query(sql, { ...options.queryOptions, signal: options.signal }); }
      catch (error) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) });
        calls++;
        continue;
      }
      const item: RuntimeQueryEvidence = { queryId: call.id || `query_${evidence.length + 1}`, sql, datasetId: options.schema.datasetId, rowCount: result.rows.length, elapsedMs: Date.now() - started };
      evidence.push(item);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ rows: result.rows, meta: result.meta, evidence: item }) });
      calls++;
    }
  }
}

export class FeatherlessAnalysisRuntime {
  constructor(private readonly options: AnalysisRuntimeOptions) {}
  run(question: string): Promise<StructuredAnalysisAnswer> { return runAnalysis(question, this.options); }
}
