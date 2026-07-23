import { chat } from "@trigger.dev/sdk/ai";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { ClickHouseClient, createClickHouseConfig, validateReadOnlySql } from "../packages/clickhouse/src";

const clientDataSchema = z.object({
  datasetId: z.string().uuid(),
});

type DatasetContext = {
  table: string;
  version: string;
  columns: Array<{ name: string; type: string }>;
};

function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials are required for the data agent");
  return createClient(url, key);
}

async function resolveDataset(datasetId: string): Promise<DatasetContext> {
  const supabase = serviceSupabase();
  const { data, error } = await supabase
    .from("dataset_imports")
    .select("physical_tables,source_version,status")
    .eq("id", datasetId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "published" || !Array.isArray(data.physical_tables) || !data.physical_tables[0]) {
    throw new Error("This dataset is not published or is not available in this workspace");
  }
  const table = String(data.physical_tables[0]);
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const schema = await clickhouse.query<{ name: string; type: string }>(`DESCRIBE TABLE ${table}`);
  return { table, version: String(data.source_version ?? "unknown"), columns: schema.rows };
}

function quote(value: string) { return `'${value.replace(/'/g, "''")}'`; }

function buildTools(context: DatasetContext, datasetId: string) {
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const runQuery = async (sql: string) => {
    const verified = validateReadOnlySql(sql, [context.table]);
    if (!verified.ok) throw new Error(verified.error);
    const result = await clickhouse.query<Record<string, unknown>>(sql, { timeoutMs: 15_000 });
    return { sql, rows: result.rows.slice(0, 50), rowCount: result.rows.length, table: context.table };
  };
  return {
    inspect_dataset: tool({
      description: "Return the dataset schema, table name, and a small sample. Call this before answering an unfamiliar question.",
      inputSchema: z.object({}),
      execute: async () => {
        const sample = await runQuery(`SELECT * FROM ${context.table} LIMIT 5`);
        return { datasetId, version: context.version, table: context.table, columns: context.columns, sample: sample.rows };
      },
    }),
    search_records: tool({
      description: "Fuzzy-search people, titles, entities, and phrases across text-like columns. Use this before giving up on spelling variations, partial names, or multiple entities in one question.",
      inputSchema: z.object({ query: z.string().min(1).max(160), limit: z.number().int().min(1).max(20).default(10) }),
      execute: async ({ query, limit }) => {
        const searchable = context.columns.map((column) => column.name).slice(0, 40);
        const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1).slice(0, 6);
        const predicates = terms.flatMap((term) => searchable.map((column) => `positionCaseInsensitiveUTF8(toString(\`${column.replace(/`/g, "")}\`), ${quote(term)}) > 0`));
        if (!predicates.length) return { query, rows: [], note: "No searchable terms supplied" };
        return runQuery(`SELECT * FROM ${context.table} WHERE ${predicates.join(" OR ")} LIMIT ${limit}`);
      },
    }),
    query_clickhouse: tool({
      description: "Run one read-only ClickHouse SELECT query. Always use the exact table name and columns returned by inspect_dataset. Prefer LIMIT 50 or less unless aggregating.",
      inputSchema: z.object({ sql: z.string().min(8).max(5000) }),
      execute: async ({ sql }) => runQuery(sql),
    }),
    present_insight: tool({
      description: "Present a completed data-backed answer as safe structured UI. Call this after using one or more data tools. Only include facts that appeared in tool results.",
      inputSchema: z.object({
        title: z.string().min(1).max(120),
        summary: z.string().min(1).max(1200),
        cards: z.array(z.object({ label: z.string(), value: z.string(), detail: z.string().optional() })).max(6).default([]),
        table: z.object({ columns: z.array(z.string()).max(8), rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(12) }).optional(),
        chart: z.object({ type: z.enum(["bar", "line", "none"]), x: z.string().optional(), y: z.string().optional(), data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(20).default([]) }).optional(),
        caveat: z.string().max(500).optional(),
      }),
      execute: async (insight) => insight,
    }),
  };
}

/** Durable chat.agent: every turn is a session-backed, observable ClickHouse analysis. */
export const datasetChat = chat
  .withClientData({ schema: clientDataSchema })
  .agent({
    id: "dataset-chat",
    tools: async ({ clientData }) => {
      if (!clientData) throw new Error("Dataset context is required");
      return buildTools(await resolveDataset(clientData.datasetId), clientData.datasetId);
    },
    onTurnStart: async () => {
      chat.response.write({ type: "data-agent-status", data: { stage: "planning" } } as never);
    },
    run: async ({ messages, tools, clientData, signal }) => {
      if (!clientData) throw new Error("Dataset context is required");
      const context = await resolveDataset(clientData.datasetId);
      const apiKey = process.env.FEATHERLESS_API_KEY;
      if (!apiKey) throw new Error("FEATHERLESS_API_KEY is required");
      const provider = createOpenAI({ apiKey, baseURL: process.env.FEATHERLESS_BASE_URL ?? "https://api.featherless.ai/v1" });
      return streamText({
        ...chat.toStreamTextOptions({ tools }),
        model: provider.chat(process.env.FEATHERLESS_MODEL ?? "meta-llama/Meta-Llama-3.1-70B-Instruct"),
        system: `You are a precise data analyst. You answer questions only with evidence from ClickHouse. Dataset table: ${context.table}. Columns: ${JSON.stringify(context.columns)}. First inspect or search the dataset, then run any required SQL. For people, titles, and names use search_records with spelling variations before concluding there is no match. After evidence is available, call present_insight to create the response UI, then provide a concise final answer. Never invent facts.`,
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(8),
      });
    },
  });
