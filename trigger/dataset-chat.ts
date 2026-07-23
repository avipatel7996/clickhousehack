import { chat } from "@trigger.dev/sdk/ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { ClickHouseClient, createClickHouseConfig, validateReadOnlySql } from "../packages/clickhouse/src";

const clientDataSchema = z.object({
  datasetId: z.string().uuid(),
  provider: z.enum(["featherless", "gemini"]).default("featherless"),
  gemini: z.object({
    baseURL: z.string().trim().url().max(500).optional(),
    model: z.string().trim().max(160).optional(),
  }).optional(),
});

type ChatClientData = z.infer<typeof clientDataSchema>;

type DatasetColumn = { name: string; type: string };
type DatasetTable = { table: string; columns: DatasetColumn[]; sourcePath?: string };
type DatasetContext = {
  datasetId: string;
  version: string;
  tables: DatasetTable[];
};

const datasetContext = chat.local<DatasetContext>({ id: "dataset-context" });

function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials are required for the data agent");
  return createClient(url, key);
}

function resolveChatModel(clientData: ChatClientData) {
  if (clientData.provider === "gemini") {
    const config = clientData.gemini;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Set GEMINI_API_KEY in Trigger.dev before selecting Gemini");
    const baseURL = config?.baseURL || process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
    const model = config?.model || process.env.GEMINI_MODEL || "gemini-flash-latest";
    return createGoogleGenerativeAI({ apiKey, baseURL })(model);
  }
  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) throw new Error("FEATHERLESS_API_KEY is required");
  const provider = createOpenAI({ apiKey, baseURL: process.env.FEATHERLESS_BASE_URL ?? "https://api.featherless.ai/v1" });
  return provider.chat(process.env.FEATHERLESS_INTERACTIVE_MODEL ?? "Qwen/Qwen2.5-7B-Instruct");
}

function schemaCacheFromManifest(manifest: unknown, tableNames: string[]): DatasetTable[] {
  if (!Array.isArray(manifest)) return [];
  return tableNames.flatMap((table, index) => {
    const item = manifest[index];
    if (!item || typeof item !== "object") return [];
    const record = item as { path?: unknown; table?: unknown; columns?: unknown };
    if (record.table !== table || !Array.isArray(record.columns)) return [];
    const columns = record.columns.filter((column): column is DatasetColumn => Boolean(column) && typeof column === "object" && typeof (column as DatasetColumn).name === "string" && typeof (column as DatasetColumn).type === "string");
    return columns.length ? [{ table, columns, ...(typeof record.path === "string" ? { sourcePath: record.path } : {}) }] : [];
  });
}

async function resolveDataset(datasetId: string): Promise<DatasetContext> {
  const supabase = serviceSupabase();
  const { data, error } = await supabase
    .from("dataset_imports")
    .select("physical_tables,source_version,source_manifest,status")
    .eq("id", datasetId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "published" || !Array.isArray(data.physical_tables) || !data.physical_tables[0]) {
    throw new Error("This dataset is not published or is not available in this workspace");
  }
  const tableNames = data.physical_tables.filter((value): value is string => typeof value === "string" && value.length > 0);
  let tables = schemaCacheFromManifest(data.source_manifest, tableNames);
  if (tables.length !== tableNames.length) {
    const clickhouse = new ClickHouseClient(createClickHouseConfig());
    const schemas = await Promise.all(tableNames.map(async (table) => ({ table, columns: (await clickhouse.query<DatasetColumn>(`DESCRIBE TABLE ${table}`)).rows })));
    const existingManifest = Array.isArray(data.source_manifest) ? data.source_manifest : [];
    const schemaManifest = schemas.map(({ table, columns }, index) => {
      const existing = existingManifest[index] && typeof existingManifest[index] === "object" ? existingManifest[index] as Record<string, unknown> : {};
      return { ...existing, table, columns };
    });
    await supabase.from("dataset_imports").update({ source_manifest: schemaManifest }).eq("id", datasetId);
    tables = schemas.map(({ table, columns }, index) => {
      const path = (schemaManifest[index] as { path?: unknown }).path;
      return { table, columns, ...(typeof path === "string" ? { sourcePath: path } : {}) };
    });
  }
  return { datasetId, version: String(data.source_version ?? "unknown"), tables };
}

function quote(value: string) { return `'${value.replace(/'/g, "''")}'`; }

type AgentStage = "planning" | "inspecting" | "searching" | "querying" | "ranking" | "answering" | "error";
type AgentEvent = { at: string; stage: AgentStage; message: string; state: "started" | "completed" | "failed" };

function writeAgentStatus(stage: AgentStage, message: string) {
  chat.response.write({
    type: "data-agent-status",
    id: "agent-status",
    data: { stage, message, at: new Date().toISOString() },
    transient: true,
  } as never);
}

function createWorkflowReporter() {
  let nextEvent = 0;
  const event = (stage: AgentStage, message: string, state: AgentEvent["state"]) => {
    chat.response.write({
      type: "data-agent-event",
      id: `agent-event-${nextEvent++}`,
      data: { stage, message, state, at: new Date().toISOString() } satisfies AgentEvent,
    } as never);
  };
  return {
    status: writeAgentStatus,
    event,
    async activity<T>(stage: AgentStage, message: string, work: () => Promise<T>, completed: (result: T) => string) {
      writeAgentStatus(stage, message);
      event(stage, message, "started");
      try {
        const result = await work();
        const completion = completed(result);
        event(stage, completion, "completed");
        writeAgentStatus("answering", "Interpreting the verified result");
        return result;
      } catch (error) {
        event(stage, `${message} did not complete`, "failed");
        writeAgentStatus("error", "A data step failed; the analyst is stopping safely");
        throw error;
      }
    },
  };
}

type AnalystInsight = {
  title: string;
  summary: string;
  cards: Array<{ label: string; value: string; detail?: string }>;
  table: { columns: string[]; rows: Array<Record<string, string | number | boolean | null>> };
  chart: { type: "bar"; x: string; y: string; data: Array<Record<string, string | number | null>> };
  caveat: string;
};

function quoteIdentifier(value: string) { return `\`${value.replace(/`/g, "")}\``; }

function latestUserQuestion(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string).join(" ").trim();
      if (text) return text;
    }
  }
  return undefined;
}

function isMovieRecommendationQuestion(question: string) {
  const text = question.toLowerCase();
  return /\b(movie|movies|film|films)\b/.test(text) && /\b(suggest|recommend|good|best|top|rating|rated|watch)\b/.test(text);
}

function firstColumn(columns: DatasetColumn[], names: string[]) {
  const byLowerName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]));
  for (const name of names) {
    const found = byLowerName.get(name);
    if (found) return found;
  }
  return undefined;
}

type MovieRecommendationSource = {
  source: DatasetTable;
  title: string;
  rating: string;
  votes: string | undefined;
  release: string | undefined;
  score: number;
};

async function prepareMovieRecommendations(context: DatasetContext, question: string): Promise<AnalystInsight | null> {
  if (!isMovieRecommendationQuestion(question)) return null;
  const candidates = context.tables.map((source) => {
    const title = firstColumn(source.columns, ["title", "movie_title", "name", "original_title"]);
    const rating = firstColumn(source.columns, ["vote_average", "rating", "imdb_rating", "score"]);
    const votes = firstColumn(source.columns, ["vote_count", "votes", "rating_count", "review_count"]);
    const release = firstColumn(source.columns, ["release_date", "release_year", "year"]);
    return { source, title, rating, votes, release, score: Number(Boolean(title)) + Number(Boolean(rating)) * 4 + Number(Boolean(votes)) * 2 + Number(rating === "vote_average") * 2 };
  }).filter((candidate): candidate is MovieRecommendationSource => Boolean(candidate.title && candidate.rating));
  const target = candidates.sort((left, right) => right.score - left.score)[0];
  if (!target) return null;

  const workflow = createWorkflowReporter();
  workflow.status("planning", "Planning a four-step movie recommendation workflow");
  workflow.event("planning", "1/4 Identified a rating-based movie recommendation", "completed");
  const source = await workflow.activity("inspecting", "2/4 Mapping title, rating, and review columns", async () => target, (value) => `Mapped ${value.title}, ${value.rating}${value.votes ? `, and ${value.votes}` : ""}`);
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const title = quoteIdentifier(source.title);
  const rating = quoteIdentifier(source.rating);
  const votes = source.votes ? quoteIdentifier(source.votes) : undefined;
  const release = source.release ? quoteIdentifier(source.release) : undefined;
  const voteSelect = votes ? `, max(toInt64OrNull(${votes})) AS movie_votes` : "";
  const yearSelect = release ? `, max(toYear(${release})) AS release_year` : "";
  const voteFilter = votes ? ` HAVING max(toInt64OrNull(${votes})) >= 500` : "";
  const voteOrder = votes ? ", movie_votes DESC" : "";
  const sql = `SELECT ${title} AS movie_title, max(toFloat64OrNull(${rating})) AS movie_rating${voteSelect}${yearSelect} FROM ${source.source.table} WHERE ${title} IS NOT NULL AND toFloat64OrNull(${rating}) >= 7.5 GROUP BY ${title}${voteFilter} ORDER BY movie_rating DESC${voteOrder} LIMIT 8`;
  const result = await workflow.activity("querying", "3/4 Querying high-rated movies with enough reviews", async () => {
    const verified = validateReadOnlySql(sql, context.tables.map((table) => table.table));
    if (!verified.ok) throw new Error(verified.error);
    return clickhouse.query<Record<string, unknown>>(sql, { timeoutMs: 15_000 });
  }, (value) => `ClickHouse returned ${value.rows.length} recommendation${value.rows.length === 1 ? "" : "s"}`);
  if (!result.rows.length) return null;
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const rows = result.rows.map((row) => ({
    title: String(row.movie_title ?? "Untitled"),
    rating: number(row.movie_rating),
    votes: number(row.movie_votes),
    year: number(row.release_year) || null,
  }));
  workflow.event("answering", "4/4 Rendered an evidence-backed recommendation list", "completed");
  workflow.status("answering", "Streaming your movie recommendations");
  return {
    title: "Highly rated movies to try",
    summary: `These are ranked by dataset rating${votes ? " with at least 500 votes" : ""}, so one-off ratings do not dominate the list.`,
    cards: rows.slice(0, 3).map((row) => ({ label: row.title, value: `${row.rating.toFixed(1)} / 10`, detail: row.votes ? `${row.votes.toLocaleString()} votes${row.year ? ` · ${row.year}` : ""}` : row.year ? String(row.year) : undefined })),
    table: { columns: ["Movie", "Rating", "Votes", "Year"], rows: rows.map((row) => ({ Movie: row.title, Rating: row.rating.toFixed(1), Votes: row.votes ? row.votes.toLocaleString() : "—", Year: row.year ?? "—" })) },
    chart: { type: "bar", x: "title", y: "rating", data: rows.map((row) => ({ title: row.title, rating: row.rating })) },
    caveat: `Source: ${source.source.sourcePath ?? source.source.table}. Ask for a genre, year, or language to narrow this further.`,
  };
}

function buildTools(context: DatasetContext, datasetId: string) {
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const workflow = createWorkflowReporter();
  const primary = context.tables[0];
  const allowedTables = context.tables.map((source) => source.table);
  const runQuery = async (stage: Extract<AgentStage, "inspecting" | "searching" | "querying" | "ranking">, message: string, sql: string) => {
    return workflow.activity(stage, message, async () => {
      const verified = validateReadOnlySql(sql, allowedTables);
      if (!verified.ok) throw new Error(verified.error);
      const result = await clickhouse.query<Record<string, unknown>>(sql, { timeoutMs: 15_000 });
      return { sql, rows: result.rows.slice(0, 20), rowCount: result.rows.length, table: verified.tables[0] ?? primary.table };
    }, (result) => `ClickHouse returned ${result.rowCount} row${result.rowCount === 1 ? "" : "s"}`);
  };
  return {
    inspect_dataset: tool({
      description: "Return the dataset schema, table name, and a small sample. Call this before answering an unfamiliar question.",
      inputSchema: z.object({}),
      execute: async () => {
        const sample = await runQuery("inspecting", "Reading a small dataset sample", `SELECT * FROM ${primary.table} LIMIT 3`);
        return { datasetId, version: context.version, tables: context.tables, sample: sample.rows };
      },
    }),
    search_records: tool({
      description: "Fuzzy-search people, titles, entities, and phrases across text-like columns. Use this before giving up on spelling variations, partial names, or multiple entities in one question.",
      inputSchema: z.object({ query: z.string().min(1).max(160), limit: z.number().int().min(1).max(20).default(10) }),
      execute: async ({ query, limit }) => {
        const searchable = primary.columns.map((column) => column.name).slice(0, 40);
        const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1).slice(0, 6);
        const predicates = terms.flatMap((term) => searchable.map((column) => `positionCaseInsensitiveUTF8(toString(\`${column.replace(/`/g, "")}\`), ${quote(term)}) > 0`));
        if (!predicates.length) return { query, rows: [], note: "No searchable terms supplied" };
        return runQuery("searching", `Searching matching records for “${query}”`, `SELECT * FROM ${primary.table} WHERE ${predicates.join(" OR ")} LIMIT ${limit}`);
      },
    }),
    query_clickhouse: tool({
      description: "Run one read-only ClickHouse SELECT query. Always use the exact table name and columns returned by inspect_dataset. Prefer LIMIT 50 or less unless aggregating.",
      inputSchema: z.object({ sql: z.string().min(8).max(5000) }),
      execute: async ({ sql }) => runQuery("querying", "Running a read-only ClickHouse query", sql),
    }),
    rank_entities: tool({
      description: "Rank entities such as players or movies using multiple numeric columns. Use this for top/best/strongest questions instead of ordering by one arbitrary metric. The score normalizes each selected metric to 0..1 before averaging.",
      inputSchema: z.object({ entityColumn: z.string().min(1), metricColumns: z.array(z.string().min(1)).min(2).max(8), limit: z.number().int().min(1).max(25).default(10) }),
      execute: async ({ entityColumn, metricColumns, limit }) => {
        const allowed = new Set(primary.columns.map((column) => column.name));
        if (!allowed.has(entityColumn) || metricColumns.some((column) => !allowed.has(column))) throw new Error("Ranking requested columns that are not in the dataset schema");
        const quoteIdentifier = (value: string) => `\`${value.replace(/`/g, "")}\``;
        const bounds = metricColumns.map((column, index) => `min(toFloat64OrNull(${quoteIdentifier(column)})) AS min_${index}, max(toFloat64OrNull(${quoteIdentifier(column)})) AS max_${index}`).join(", ");
        const components = metricColumns.map((column, index) => `ifNull((toFloat64OrNull(${quoteIdentifier(column)}) - min_${index}) / nullIf(max_${index} - min_${index}, 0), 0)`).join(" + ");
        const selected = metricColumns.map((column) => quoteIdentifier(column)).join(", ");
        const sql = `WITH bounds AS (SELECT ${bounds} FROM ${primary.table}), scored AS (SELECT ${quoteIdentifier(entityColumn)} AS entity, (${components}) / ${metricColumns.length} AS composite_score, ${selected} FROM ${primary.table} CROSS JOIN bounds) SELECT * FROM scored WHERE entity IS NOT NULL ORDER BY composite_score DESC LIMIT ${limit}`;
        return runQuery("ranking", `Ranking ${entityColumn} using ${metricColumns.length} metrics`, sql);
      },
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
      execute: async (insight) => {
        workflow.event("answering", "Prepared the evidence-backed answer", "completed");
        workflow.status("answering", "Streaming the answer");
        return insight;
      },
    }),
  };
}

/** Durable chat.agent: every turn is a session-backed, observable ClickHouse analysis. */
export const datasetChat = chat
  .withClientData({ schema: clientDataSchema })
  .agent({
    id: "dataset-chat",
    machine: "small-1x",
    maxDuration: 90,
    // A chat session is suspended (not consuming compute) while it waits for
    // another question. Keep that wait short so abandoned browser tabs do not
    // look like stuck work in the Trigger dashboard.
    idleTimeoutInSeconds: 10,
    turnTimeout: "2m",
    preloadIdleTimeoutInSeconds: 10,
    preloadTimeout: "30s",
    exitAfterPreloadIdle: true,
    uiMessageStreamOptions: {
      sendReasoning: false,
      onError: () => "The analyst could not complete this request. Please try again.",
    },
    onBoot: async ({ clientData }) => {
      if (!clientData) throw new Error("Dataset context is required");
      datasetContext.init(await resolveDataset(clientData.datasetId));
    },
    tools: async () => buildTools(datasetContext.get(), datasetContext.datasetId),
    onTurnStart: async ({ writer }) => {
      writer.write({
        type: "data-agent-status",
        id: "agent-status",
        data: { stage: "planning", message: "Understanding your question", at: new Date().toISOString() },
        transient: true,
      } as never);
    },
    run: async ({ messages, tools, clientData, signal }) => {
      if (!clientData) throw new Error("Dataset context is required");
      const context = datasetContext.get();
      const question = latestUserQuestion(messages);
      const recommendation = question ? await prepareMovieRecommendations(context, question) : null;
      if (recommendation) {
        chat.response.write({
          type: "data-analyst-insight",
          id: "analyst-insight",
          data: recommendation,
        } as never);
      }
      return streamText({
        ...chat.toStreamTextOptions({ tools }),
        // Gemini is selected per session; Featherless retains its fast
        // non-reasoning default for sessions that do not opt into Gemini.
        model: resolveChatModel(clientData),
        system: `You are a precise, fast data analyst. Answer only from ClickHouse results. Dataset tables and schemas: ${JSON.stringify(context.tables)}. The schema is already available, so for a straightforward question call query_clickhouse directly with one bounded query, then answer from its result. Use search_records only for names, titles, or fuzzy text lookup; use rank_entities only for multi-metric rankings. Do not inspect the dataset unless the user explicitly asks for a sample or schema. Call present_insight only when a table, chart, or cards materially improve the answer. ${recommendation ? "A verified recommendation table and chart have already been emitted. Give a one-sentence introduction only; do not call any tools or repeat the rows." : "Give the direct result first and keep ordinary answers under 160 words."} Do not describe hidden reasoning. Never invent facts.`,
        messages,
        abortSignal: signal,
        maxOutputTokens: recommendation ? 100 : 240,
        temperature: 0,
        ...(recommendation ? { toolChoice: "none" as const, stopWhen: stepCountIs(1) } : { stopWhen: stepCountIs(3) }),
      });
    },
  });
