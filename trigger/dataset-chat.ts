import { chat } from "@trigger.dev/sdk/ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, stepCountIs, streamText, tool, type LanguageModel } from "ai";
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
  const eventScope = crypto.randomUUID();
  const event = (stage: AgentStage, message: string, state: AgentEvent["state"]) => {
    chat.response.write({
      type: "data-agent-event",
      id: `agent-event-${eventScope}-${nextEvent++}`,
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
  chart?: { type: "bar"; x: string; y: string; data: Array<Record<string, string | number | null>> };
  caveat: string;
};

const analysisPlanSchema = z.object({
  objective: z.string().trim().min(3).max(240),
  subquestions: z.array(z.string().trim().min(3).max(220)).min(1).max(3),
  entityTerms: z.array(z.string().trim().min(2).max(100)).max(3),
  requirements: z.array(z.object({
    purpose: z.string().trim().min(3).max(160),
    matchingColumns: z.array(z.string().trim().min(1).max(120)).max(8),
  })).max(3),
});

type AnalysisPlan = z.infer<typeof analysisPlanSchema>;

function quoteIdentifier(value: string) { return `\`${value.replace(/`/g, "")}\``; }

// ClickHouse's *OrNull conversion functions accept text only. Converting the
// source to text first makes the analyst work with imported Float/Int columns
// as well as CSV/JSON columns that were inferred as String.
function floatOrNull(expression: string) { return `toFloat64OrNull(toString(${expression}))`; }
function intOrNull(expression: string) { return `toInt64OrNull(toString(${expression}))`; }

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

async function createAnalysisPlan(model: LanguageModel, question: string, context: DatasetContext): Promise<AnalysisPlan> {
  const availableColumns = new Set(context.tables.flatMap((source) => source.columns.map((column) => column.name)));
  const fallback: AnalysisPlan = {
    objective: question,
    subquestions: ["Run one bounded ClickHouse query that answers the request from the available fields."],
    entityTerms: [],
    requirements: [],
  };
  try {
    const schemaSummary = context.tables.slice(0, 12).map((source) => ({
      source: source.sourcePath ?? source.table,
      table: source.table,
      columns: source.columns.slice(0, 80),
    }));
    const result = await generateObject({
      model,
      schema: analysisPlanSchema,
      schemaName: "analysis_plan",
      schemaDescription: "A minimal, executable plan for a database question.",
      temperature: 0,
      prompt: `Create the minimum executable evidence plan for this user question: ${JSON.stringify(question)}\n\nAvailable imported tables and columns: ${JSON.stringify(schemaSummary)}\n\nRules:\n- Use one sub-question for a simple aggregate or lookup; add steps only for distinct entities, filters, or dependent evidence. Never add generic filler.\n- Put each distinct person, title, product, player, or other named entity in entityTerms separately.\n- For every required relationship/filter that needs a specific field, add a requirement with the exact matchingColumns from the schema. If the schema has no field that can verify it, use an empty matchingColumns array.\n- Never use world knowledge or invent a schema column.`,
    });
    const plan = result.object;
    return {
      objective: plan.objective,
      subquestions: [...new Set(plan.subquestions)].slice(0, 3),
      entityTerms: [...new Set(plan.entityTerms)].slice(0, 3),
      requirements: plan.requirements.map((requirement) => ({
        purpose: requirement.purpose,
        matchingColumns: requirement.matchingColumns.filter((column) => availableColumns.has(column)),
      })).slice(0, 3),
    };
  } catch {
    return fallback;
  }
}

function normalizeTerm(term: string) {
  return term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term;
}

function isUnfilteredRatingRecommendation(question: string, context: DatasetContext) {
  const text = question.toLowerCase();
  const asksForRecommendation = /\b(suggest|recommend|good|best|top|highest|highly rated|watch)\b/.test(text);
  const hasSpecificFilter = /\b(by|with|near|from|in|after|before|between|under|over|above|for)\b/.test(text) || /\b\d{4}\b/.test(text);
  const genericWords = new Set(["a", "an", "and", "are", "based", "best", "can", "do", "for", "give", "good", "highest", "highly", "i", "me", "on", "please", "rated", "rating", "ratings", "recommend", "recommendation", "recommendations", "recommended", "should", "show", "some", "suggest", "suggestion", "suggestions", "the", "to", "top", "us", "watch", "what", "which", "you"]);
  const datasetTerms = new Set(context.tables.flatMap((source) => [source.table, source.sourcePath ?? "", ...source.columns.map((column) => column.name)]).flatMap((value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(normalizeTerm));
  const topicWords = (text.match(/[a-z0-9]+/g) ?? []).filter((word) => !genericWords.has(word));
  // Keep the fast path narrow: unknown topic words (a person, location, genre,
  // or arbitrary filter) must go through the general evidence workflow first.
  return asksForRecommendation && !hasSpecificFilter && topicWords.length > 0 && topicWords.every((word) => datasetTerms.has(normalizeTerm(word)));
}

function firstColumn(columns: DatasetColumn[], names: string[]) {
  const byLowerName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]));
  for (const name of names) {
    const found = byLowerName.get(name);
    if (found) return found;
  }
  return undefined;
}

function entityColumn(columns: DatasetColumn[]) {
  return firstColumn(columns, ["title", "name", "label", "product_name", "item_name", "restaurant_name", "company_name", "artist_name", "player_name", "original_title"])
    ?? columns.find((column) => /(^|_)(name|title|label)$/i.test(column.name))?.name;
}

type RatingRecommendationSource = {
  source: DatasetTable;
  entity: string;
  rating: string;
  votes: string | undefined;
  release: string | undefined;
  score: number;
};

function humanizeColumn(name: string) {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function prepareRatingRecommendations(context: DatasetContext, question: string): Promise<AnalystInsight | null> {
  if (!isUnfilteredRatingRecommendation(question, context)) return null;
  const candidates = context.tables.map((source) => {
    const entity = entityColumn(source.columns);
    const rating = firstColumn(source.columns, ["vote_average", "rating", "imdb_rating", "score"]);
    const votes = firstColumn(source.columns, ["vote_count", "votes", "rating_count", "review_count"]);
    const release = firstColumn(source.columns, ["release_date", "release_year", "year", "date"]);
    return { source, entity, rating, votes, release, score: Number(Boolean(entity)) + Number(Boolean(rating)) * 4 + Number(Boolean(votes)) * 2 + Number(rating === "vote_average") * 2 };
  }).filter((candidate): candidate is RatingRecommendationSource => Boolean(candidate.entity && candidate.rating));
  const target = candidates.sort((left, right) => right.score - left.score)[0];
  if (!target) return null;

  const workflow = createWorkflowReporter();
  workflow.status("planning", "Planning a four-step rating-based recommendation workflow");
  workflow.event("planning", "1/4 Identified an unfiltered rating recommendation", "completed");
  const source = await workflow.activity("inspecting", "2/4 Mapping entity, rating, and review columns", async () => target, (value) => `Mapped ${value.entity}, ${value.rating}${value.votes ? `, and ${value.votes}` : ""}`);
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const entity = quoteIdentifier(source.entity);
  const rating = quoteIdentifier(source.rating);
  const votes = source.votes ? quoteIdentifier(source.votes) : undefined;
  const release = source.release ? quoteIdentifier(source.release) : undefined;
  const ratingValue = floatOrNull(rating);
  const voteValue = votes ? intOrNull(votes) : undefined;
  const voteSelect = voteValue ? `, max(${voteValue}) AS review_count` : "";
  const yearSelect = release ? `, max(toYear(parseDateTimeBestEffortOrNull(toString(${release})))) AS release_year` : "";
  const voteOrder = voteValue ? ", review_count DESC" : "";
  const sql = `SELECT ${entity} AS entity_name, max(${ratingValue}) AS entity_rating${voteSelect}${yearSelect} FROM ${source.source.table} WHERE ${entity} IS NOT NULL AND ${ratingValue} IS NOT NULL GROUP BY ${entity} ORDER BY entity_rating DESC${voteOrder} LIMIT 8`;
  const result = await workflow.activity("querying", "3/4 Ranking records by their dataset rating", async () => {
    const verified = validateReadOnlySql(sql, context.tables.map((table) => table.table));
    if (!verified.ok) throw new Error(verified.error);
    return clickhouse.query<Record<string, unknown>>(sql, { timeoutMs: 15_000 });
  }, (value) => `ClickHouse returned ${value.rows.length} recommendation${value.rows.length === 1 ? "" : "s"}`);
  if (!result.rows.length) return null;
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const rows = result.rows.map((row) => ({
    entity: String(row.entity_name ?? "Untitled"),
    rating: number(row.entity_rating),
    reviews: number(row.review_count),
    year: number(row.release_year) || null,
  }));
  const entityLabel = humanizeColumn(source.entity);
  workflow.event("answering", "4/4 Rendered an evidence-backed recommendation list", "completed");
  workflow.status("answering", "Streaming your recommendations");
  return {
    title: "Highly rated recommendations",
    summary: `These are ranked by the dataset's ${humanizeColumn(source.rating)}${voteValue ? "; review count breaks rating ties and is shown for context" : ""}.`,
    cards: rows.slice(0, 3).map((row) => ({ label: row.entity, value: String(Number(row.rating.toFixed(2))), detail: row.reviews ? `${row.reviews.toLocaleString()} reviews${row.year ? ` · ${row.year}` : ""}` : row.year ? String(row.year) : undefined })),
    table: { columns: [entityLabel, "Rating", "Reviews", "Year"], rows: rows.map((row) => ({ [entityLabel]: row.entity, Rating: String(Number(row.rating.toFixed(2))), Reviews: row.reviews ? row.reviews.toLocaleString() : "—", Year: row.year ?? "—" })) },
    caveat: `Source: ${source.source.sourcePath ?? source.source.table}. Ask for a specific filter to narrow this further.`,
  };
}

type SearchResult = {
  query: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  searched: Array<{ source: string; fields: string[] }>;
  note: string;
};

function entityEvidence(result: SearchResult) {
  const needle = result.query.toLowerCase();
  const candidates = result.rows.slice(0, 5).map((row, index) => {
    const matched = Object.entries(row)
      .filter(([key, value]) => !key.startsWith("_") && String(value ?? "").toLowerCase().includes(needle))
      .slice(0, 2)
      .map(([field, value]) => ({ field, value: String(value).slice(0, 220) }));
    const label = [row.title, row.name, row.original_title].find((value) => typeof value === "string" && value.trim()) ?? `Match ${index + 1}`;
    return { label: String(label), source: String(row._source_file ?? "Imported dataset"), matched };
  });
  return {
    query: result.query,
    candidates,
    searched: result.searched.map(({ source, fields }) => ({ source, fields })),
    conclusion: result.rowCount
      ? result.rowCount === 1
        ? "One matching record was found. Its fields—not outside knowledge—are the evidence for any next step."
        : `${result.rowCount} matching records were found. A text match alone does not establish a person’s role; use the matching fields to disambiguate.`
      : "No matching record was found in the imported data. The analyst will not infer an identity from outside knowledge.",
  };
}

function textColumns(source: DatasetTable) {
  return source.columns.filter((column) => /string|fixedstring|lowcardinality|enum/i.test(column.type)).slice(0, 40);
}

async function searchImportedTextFields(context: DatasetContext, clickhouse: ClickHouseClient, query: string, limit: number): Promise<SearchResult> {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1).slice(0, 6);
  if (!terms.length) return { query, rows: [], rowCount: 0, searched: [], note: "No searchable terms supplied" };
  const sources = context.tables.map((source) => ({ source, columns: textColumns(source) })).filter(({ columns }) => columns.length);
  const resultSets = await Promise.all(sources.map(async ({ source, columns }) => {
    const predicates = terms.map((term) => `(${columns.map((column) => `positionCaseInsensitiveUTF8(toString(${quoteIdentifier(column.name)}), ${quote(term)}) > 0`).join(" OR ")})`);
    const sql = `SELECT *, ${quote(source.sourcePath ?? source.table)} AS _source_file FROM ${source.table} WHERE ${predicates.join(" AND ")} LIMIT ${limit}`;
    const verified = validateReadOnlySql(sql, [source.table]);
    if (!verified.ok) throw new Error(verified.error);
    return clickhouse.query<Record<string, unknown>>(sql, { timeoutMs: 15_000 });
  }));
  const rows = resultSets.flatMap((result) => result.rows).slice(0, limit);
  return {
    query,
    rows,
    rowCount: rows.length,
    searched: sources.map(({ source, columns }) => ({ source: source.sourcePath ?? source.table, fields: columns.map((column) => column.name) })),
    note: rows.length
      ? `Found ${rows.length} matching record${rows.length === 1 ? "" : "s"} across ${sources.length} imported file${sources.length === 1 ? "" : "s"}`
      : `No matching values in ${sources.length} imported file${sources.length === 1 ? "" : "s"}; do not infer an entity from outside this dataset`,
  };
}

async function executeAnalysisPlan(context: DatasetContext, plan: AnalysisPlan) {
  const terms = plan.entityTerms.slice(0, 3);
  if (!terms.length) return [] as SearchResult[];
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const workflow = createWorkflowReporter();
  const results = await Promise.all(terms.map((term) => workflow.activity(
    "searching",
    `Executing plan: resolving “${term}” across imported data`,
    () => searchImportedTextFields(context, clickhouse, term, 10),
    (result) => result.rowCount
      ? `Resolved “${term}”: ${result.rowCount} matching record${result.rowCount === 1 ? "" : "s"}`
      : `No matching values for “${term}” across ${result.searched.length} imported files`,
  )));
  for (const result of results) {
    chat.response.write({
      type: "data-entity-evidence",
      id: `entity-evidence-${crypto.randomUUID()}`,
      data: entityEvidence(result),
    } as never);
  }
  return results;
}

function blockerInsight(question: string, plan: AnalysisPlan, results: SearchResult[]): AnalystInsight | null {
  const unsupported = plan.requirements.filter((requirement) => !requirement.matchingColumns.length);
  const missing = results.filter((result) => !result.rowCount);
  if (!unsupported.length && !missing.length) return null;
  const rows = [
    ...unsupported.map((requirement) => ({ Check: requirement.purpose, Outcome: "No matching field in this dataset" })),
    ...missing.map((result) => ({ Check: `Find “${result.query}”`, Outcome: "No matching values in imported text fields" })),
  ];
  return {
    title: "The dataset cannot verify this request yet",
    summary: `The plan found a specific evidence gap for: ${question}`,
    cards: rows.slice(0, 3).map((row) => ({ label: row.Check, value: "Not verifiable", detail: row.Outcome })),
    table: { columns: ["Check", "Outcome"], rows },
    caveat: "The analyst stopped rather than infer an answer from outside the imported data. Import data containing the missing field or use a narrower question.",
  };
}

function buildTools(context: DatasetContext, datasetId: string) {
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const workflow = createWorkflowReporter();
  const primary = context.tables[0];
  const allowedTables = context.tables.map((source) => source.table);
  const searchCache = new Map<string, Promise<SearchResult>>();
  const sourceForTable = (table?: string) => {
    const source = table ? context.tables.find((candidate) => candidate.table === table) : primary;
    if (!source) throw new Error("The requested table is not part of this dataset");
    return source;
  };
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
      description: "Return the stored schema and a small sample for one imported table. The schema for every table is already available in the system context; call this only when an unfamiliar table needs sample values.",
      inputSchema: z.object({ table: z.string().optional() }),
      execute: async ({ table }) => {
        const source = sourceForTable(table);
        const sample = await runQuery("inspecting", "Reading a small dataset sample", `SELECT * FROM ${source.table} LIMIT 3`);
        return { datasetId, version: context.version, tables: context.tables, sample: sample.rows };
      },
    }),
    search_records: tool({
      description: "Search every imported table for one person, title, entity, or phrase using case-insensitive substring matching. Call exactly once for each named entity before making an assumption. Do not combine distinct names into one search; resolve each separately, then query their intersection. The result identifies the searched files and fields. If it returns zero rows, say the dataset has no evidence; never substitute a person from outside knowledge. If it returns multiple candidates, explain the candidate evidence and your selection.",
      inputSchema: z.object({ query: z.string().min(1).max(160), limit: z.number().int().min(1).max(20).default(10) }),
      execute: async ({ query, limit }) => {
        const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1).slice(0, 6);
        if (!terms.length) return { query, rows: [], rowCount: 0, searched: [], note: "No searchable terms supplied" } satisfies SearchResult;
        const cacheKey = `${terms.join(" ")}:${limit}`;
        let search = searchCache.get(cacheKey);
        const isNewSearch = !search;
        if (!search) {
          search = workflow.activity("searching", `Searching all imported text fields for “${query}”`, () => searchImportedTextFields(context, clickhouse, query, limit), (result) => result.rowCount
            ? `Found ${result.rowCount} matching record${result.rowCount === 1 ? "" : "s"} across all imported files`
            : `No matching values across ${result.searched.length} imported files`);
          searchCache.set(cacheKey, search);
        }
        const result = await search;
        if (isNewSearch) {
          chat.response.write({
            type: "data-entity-evidence",
            id: `entity-evidence-${crypto.randomUUID()}`,
            data: entityEvidence(result),
          } as never);
        }
        return result;
      },
    }),
    query_clickhouse: tool({
      description: "Run one read-only ClickHouse SELECT query. Always use the exact table name and columns returned by inspect_dataset. Prefer LIMIT 50 or less unless aggregating.",
      inputSchema: z.object({ sql: z.string().min(8).max(5000) }),
      execute: async ({ sql }) => runQuery("querying", "Running a read-only ClickHouse query", sql),
    }),
    rank_entities: tool({
      description: "Rank records from a selected imported table using multiple numeric columns. Use this for top/best/strongest questions instead of ordering by one arbitrary metric. The score normalizes each selected metric to 0..1 before averaging.",
      inputSchema: z.object({ table: z.string().optional(), entityColumn: z.string().min(1), metricColumns: z.array(z.string().min(1)).min(2).max(8), limit: z.number().int().min(1).max(25).default(10) }),
      execute: async ({ table, entityColumn, metricColumns, limit }) => {
        const source = sourceForTable(table);
        const allowed = new Set(source.columns.map((column) => column.name));
        if (!allowed.has(entityColumn) || metricColumns.some((column) => !allowed.has(column))) throw new Error("Ranking requested columns that are not in the dataset schema");
        const quoteIdentifier = (value: string) => `\`${value.replace(/`/g, "")}\``;
        const bounds = metricColumns.map((column, index) => `min(${floatOrNull(quoteIdentifier(column))}) AS min_${index}, max(${floatOrNull(quoteIdentifier(column))}) AS max_${index}`).join(", ");
        const components = metricColumns.map((column, index) => `ifNull((${floatOrNull(quoteIdentifier(column))} - min_${index}) / nullIf(max_${index} - min_${index}, 0), 0)`).join(" + ");
        const selected = metricColumns.map((column) => quoteIdentifier(column)).join(", ");
        const sql = `WITH bounds AS (SELECT ${bounds} FROM ${source.table}), scored AS (SELECT ${quoteIdentifier(entityColumn)} AS entity, (${components}) / ${metricColumns.length} AS composite_score, ${selected} FROM ${source.table} CROSS JOIN bounds) SELECT * FROM scored WHERE entity IS NOT NULL ORDER BY composite_score DESC LIMIT ${limit}`;
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
      const recommendation = question ? await prepareRatingRecommendations(context, question) : null;
      const model = resolveChatModel(clientData);
      const planner = question && !recommendation ? createWorkflowReporter() : undefined;
      const plan = question && planner ? await planner.activity(
        "planning",
        "Creating the minimum evidence plan",
        () => createAnalysisPlan(model, question, context),
        (value) => `Created ${value.subquestions.length} focused sub-question${value.subquestions.length === 1 ? "" : "s"}`,
      ) : undefined;
      if (plan) {
        chat.response.write({
          type: "data-analysis-plan",
          id: `analysis-plan-${crypto.randomUUID()}`,
          data: plan,
        } as never);
      }
      const plannedEvidence = plan ? await executeAnalysisPlan(context, plan) : [];
      const blocker = question && plan ? blockerInsight(question, plan, plannedEvidence) : null;
      if (recommendation) {
        chat.response.write({
          type: "data-analyst-insight",
          id: "analyst-insight",
          data: recommendation,
        } as never);
      }
      if (blocker) {
        chat.response.write({
          type: "data-analyst-insight",
          id: "analyst-blocker",
          data: blocker,
        } as never);
      }
      const streamOptions = chat.toStreamTextOptions({ tools });
      const preflight = plan ? JSON.stringify({
        plan: { objective: plan.objective, subquestions: plan.subquestions, requirements: plan.requirements },
        entityEvidence: plannedEvidence.map((result) => ({ query: result.query, rowCount: result.rowCount, note: result.note, rows: result.rows.slice(0, 3) })),
      }) : "No preflight plan was required.";
      return streamText({
        ...streamOptions,
        // Gemini is selected per session; Featherless retains its fast
        // non-reasoning default for sessions that do not opt into Gemini.
        model,
        system: `You are a precise, fast data analyst for arbitrary imported datasets. Answer only from ClickHouse results. Dataset tables and schemas: ${JSON.stringify(context.tables)}. The orchestrator has already created and executed this evidence plan: ${preflight}. Use those completed checks; do not repeat them. If a blocker is present, do not call tools or emit text because the structured blocker is the final answer. Otherwise, identify the relevant table and requested constraints; resolve any additional named entity with its own search_records call before querying; run a bounded read-only query that applies every supported constraint; compare the result with the original question before answering, and explicitly state unsupported constraints or zero evidence. search_records searches every imported text field using substring matching. If it finds nothing, say what was searched and never infer an identity from outside knowledge. If it finds multiple candidates, state the candidates and the data-backed reason for any selection before continuing. Never repeat an identical tool call. Use rank_entities only for multi-metric rankings and select its table explicitly when necessary. Do not inspect the dataset unless a sample is necessary. End every non-blocked workflow with present_insight: it is the final answer contract and must include either verified results or a precise data limitation. ${recommendation ? "A verified generic rating recommendation table has already been emitted. Do not call tools or emit text; the structured result is the complete answer." : blocker ? "A structured blocker has already been emitted. Do not call tools or emit text." : "Keep any supporting text under 120 words."} Do not describe hidden reasoning. Never invent facts.`,
        messages,
        abortSignal: signal,
        maxOutputTokens: recommendation ? 100 : 240,
        temperature: 0,
        ...(recommendation || blocker ? {
          toolChoice: "none" as const,
          stopWhen: stepCountIs(1),
        } : {
          stopWhen: stepCountIs(4),
        }),
        onFinish: async (event) => {
          const producedInsight = event.steps.some((step) => step.toolCalls.some((call) => call.toolName === "present_insight"));
          if (!recommendation && !blocker && !event.text.trim() && !producedInsight) {
            chat.response.write({
              type: "data-analyst-insight",
              id: "analyst-incomplete-workflow",
              data: {
                title: "The analyst did not complete a verifiable answer",
                summary: "The workflow ended before it produced a final evidence-backed result.",
                cards: [],
                table: { columns: ["Status", "Next step"], rows: [{ Status: "Incomplete workflow", "Next step": "Retry the question; the visible plan and evidence are preserved for diagnosis." }] },
                caveat: "No answer was inferred from incomplete work.",
              } satisfies AnalystInsight,
            } as never);
          }
        },
      });
    },
  });
