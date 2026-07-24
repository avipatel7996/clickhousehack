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
  outcome: z.enum(["query", "not_possible"]),
  objective: z.string().trim().min(3).max(240),
  limitation: z.string().trim().max(500).optional(),
  queries: z.array(z.object({
    question: z.string().trim().min(3).max(220),
    sql: z.string().trim().min(8).max(5000),
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

function isLiteralEntitySearchTerm(value: string) {
  const analyticalWords = new Set(["top", "bottom", "best", "worst", "highest", "lowest", "player", "players", "record", "records", "match", "matches", "data", "dataset", "performance", "score", "scores", "total", "average", "rank", "ranking", "identify", "list", "show", "find", "compare", "provided"]);
  const tokens = value.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.length > 0 && tokens.some((token) => !analyticalWords.has(token));
}

async function createAnalysisPlan(model: LanguageModel, question: string, context: DatasetContext): Promise<AnalysisPlan> {
  const fallback: AnalysisPlan = {
    outcome: "not_possible",
    objective: question,
    limitation: "The SQL planner could not produce a safe executable query for this dataset.",
    queries: [],
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
      schemaDescription: "An executable ClickHouse query plan for a database question.",
      temperature: 0,
      prompt: `Write the minimum executable ClickHouse plan for this user question: ${JSON.stringify(question)}\n\nAvailable imported tables and columns: ${JSON.stringify(schemaSummary)}\n\nReturn outcome="query" with exact read-only ClickHouse SQL in queries, or outcome="not_possible" with a short limitation if the schema cannot answer the question.\n\nRules:\n- A simple lookup, preview, aggregate, or filter gets exactly one query. For example, “give first 10 rows” must be SELECT * FROM the exact imported table LIMIT 10.\n- Add a second or third query only when earlier data is genuinely needed to resolve an entity or verify a relationship; the final answer query must be last. Do not add generic planning prose.\n- Every query must be a single SELECT or WITH statement, use only exact table/column names from the supplied schema, and be bounded with LIMIT 50 or less unless it is an aggregate.\n- Do not use outside knowledge. Do not mutate data.`,
    });
    const plan = result.object;
    return {
      outcome: plan.outcome,
      objective: plan.objective,
      limitation: plan.limitation,
      queries: plan.queries.slice(0, 3),
    };
  } catch {
    return fallback;
  }
}

function normalizeTerm(term: string) {
  return term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term;
}

/** A phrase containing multiple named obligations must be checked separately. */
function atomicEntityTerms(terms: string[]) {
  return [...new Set(terms.flatMap((term) => term
    .split(/\s*(?:,|\band\b|\&|\bwith\b)\s*/i)
    .map((value) => value.trim())
    .filter((value) => value.length >= 2)))].slice(0, 6);
}

function questionTerms(question: string) {
  const ignored = new Set(["a", "an", "and", "are", "based", "best", "bottom", "can", "data", "do", "find", "give", "good", "highest", "identify", "in", "is", "list", "lowest", "match", "matches", "of", "on", "please", "provided", "rank", "ranking", "recommend", "recommendation", "results", "show", "some", "suggest", "the", "to", "top", "what", "which", "with", "you"]);
  return (question.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [])
    .map(normalizeTerm)
    .filter((term) => !ignored.has(term));
}

function isUnfilteredRankingRequest(question: string) {
  const text = question.toLowerCase();
  const asksForRanking = /\b(top|bottom|best|worst|highest|lowest|leading|recommend|suggest|good)\b/.test(text);
  // A named constraint needs the general evidence workflow. A bare ranking is
  // fully determined by schema semantics and can avoid an LLM call altogether.
  const hasConstraint = /\b(where|with|for|from|near|after|before|between|under|over|above|below|against|versus|vs)\b/.test(text) || /\b\d{4}\b/.test(text);
  return asksForRanking && !hasConstraint;
}

function firstColumn(columns: DatasetColumn[], names: string[]) {
  const byLowerName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]));
  for (const name of names) {
    const found = byLowerName.get(name);
    if (found) return found;
  }
  return undefined;
}

function entityColumns(columns: DatasetColumn[]) {
  return columns.filter((column) => /(^|[_-])(name|title|label)$/i.test(column.name));
}

function isNumericColumn(column: DatasetColumn) {
  return /int|float|decimal|double|numeric|real|uint/i.test(column.type);
}

function columnTerms(column: string) {
  return column.toLowerCase().split(/[_-]+/).map(normalizeTerm).filter(Boolean);
}

function rankingLimit(question: string) {
  const numeric = question.match(/\b(?:top|bottom|best|worst|highest|lowest|leading)\s+(\d{1,2})\b/i);
  if (numeric) return Math.min(25, Math.max(1, Number(numeric[1])));
  const named = question.match(/\b(?:top|bottom|best|worst|highest|lowest|leading)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i)?.[1]?.toLowerCase();
  const wordNumbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  return named ? wordNumbers[named] : 10;
}

function rankingDirection(question: string) {
  return /\b(bottom|worst|lowest)\b/i.test(question) ? "ASC" : "DESC";
}

function entityScore(column: DatasetColumn, terms: string[]) {
  const matches = columnTerms(column.name).filter((term) => terms.includes(term)).length;
  return 20 + matches * 30 + (/name|title|label/i.test(column.name) ? 10 : 0);
}

function metricScore(column: DatasetColumn, terms: string[]) {
  if (!isNumericColumn(column)) return Number.NEGATIVE_INFINITY;
  const name = column.name.toLowerCase();
  const words = columnTerms(name);
  const relevance = words.filter((term) => terms.includes(term)).length * 40;
  const quality = /performance|rating|score|rank|grade|points|value|revenue|sales|goals|assists|amount|count|volume/i.test(name) ? 30 : 0;
  const preferred = /^(performance|overall|composite|quality)[_-]score$/i.test(column.name) ? 60
    : /(?:^|[_-])rating$/i.test(column.name) || /^(average_rating|vote_average|imdb_rating)$/i.test(column.name) ? 50
      : /(?:^|[_-])score$/i.test(column.name) ? 40 : 0;
  const identifierPenalty = /(^|_)(id|number|year|age)$/i.test(name) ? -80 : 0;
  return relevance + quality + preferred + identifierPenalty;
}

function observationColumn(columns: DatasetColumn[]) {
  return firstColumn(columns, ["match_id", "game_id", "event_id", "transaction_id", "order_id", "session_id", "record_id"]);
}

function displayEntityLabel(column: string) {
  const withoutName = column.replace(/(?:[_-]name|[_-]title|[_-]label)$/i, "") || column;
  return humanizeColumn(withoutName);
}

function displayObservationLabel(column: string | undefined) {
  if (!column) return "Records";
  return humanizeColumn(column.replace(/(?:[_-]id)$/i, "") || column);
}

type RankingSource = {
  source: DatasetTable;
  entity: string;
  metric: string;
  observation: string | undefined;
  score: number;
};

function humanizeColumn(name: string) {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function prepareUnfilteredRanking(context: DatasetContext, question: string): Promise<AnalystInsight | null> {
  if (!isUnfilteredRankingRequest(question)) return null;
  const terms = questionTerms(question);
  const candidates = context.tables.flatMap((source) => entityColumns(source.columns).flatMap((entity) => source.columns
    .filter(isNumericColumn)
    .map((metric) => ({
      source,
      entity: entity.name,
      metric: metric.name,
      observation: observationColumn(source.columns),
      // Terms that identify the grouped entity (e.g. "player" in
      // player_name) are not evidence that player_rating is the requested
      // measure. Keep dimension matching and metric matching separate.
      score: entityScore(entity, terms) + metricScore(metric, terms.filter((term) => !columnTerms(entity.name).includes(term))),
    })))).filter((candidate): candidate is RankingSource => Number.isFinite(candidate.score) && candidate.score > 0);
  const target = candidates.sort((left, right) => right.score - left.score)[0];
  if (!target) return null;

  const limit = rankingLimit(question);
  const direction = rankingDirection(question);
  const workflow = createWorkflowReporter();
  const entityLabel = displayEntityLabel(target.entity);
  const metricLabel = humanizeColumn(target.metric);
  const observationLabel = displayObservationLabel(target.observation);
  chat.response.write({
    type: "data-analysis-plan",
    id: `analysis-plan-${crypto.randomUUID()}`,
    data: {
      objective: `Rank ${entityLabel.toLowerCase()} records using the available ${metricLabel.toLowerCase()} data.`,
      subquestions: [`Aggregate ${metricLabel} by ${entityLabel}, then return the ${direction === "ASC" ? "lowest" : "highest"} ${limit}.`],
      entityTerms: [],
      requirements: [
        { purpose: "Group the records by entity", matchingColumns: [target.entity] },
        { purpose: "Aggregate the ranking metric", matchingColumns: [target.metric] },
      ],
    },
  } as never);
  workflow.status("planning", "Planning one schema-driven aggregate");
  workflow.event("planning", "1/3 Classified this as an unfiltered ranking", "completed");
  const source = await workflow.activity("inspecting", "2/3 Mapping the entity and performance columns", async () => target, (value) => `Mapped ${value.entity} and ${value.metric}${value.observation ? ` across ${value.observation}` : ""}`);
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const entity = quoteIdentifier(source.entity);
  const metric = quoteIdentifier(source.metric);
  const metricValue = floatOrNull(metric);
  const observation = source.observation ? quoteIdentifier(source.observation) : undefined;
  const observationSelect = observation ? `, countDistinct(${observation}) AS observation_count` : ", count() AS observation_count";
  const sql = `SELECT ${entity} AS entity_name, avg(${metricValue}) AS aggregate_metric${observationSelect} FROM ${source.source.table} WHERE ${entity} IS NOT NULL AND ${metricValue} IS NOT NULL GROUP BY ${entity} ORDER BY aggregate_metric ${direction}, observation_count DESC LIMIT ${limit}`;
  const result = await workflow.activity("ranking", "3/3 Aggregating and ranking the imported records", async () => {
    const verified = validateReadOnlySql(sql, context.tables.map((table) => table.table));
    if (!verified.ok) throw new Error(verified.error);
    return clickhouse.query<Record<string, unknown>>(sql, { timeoutMs: 15_000 });
  }, (value) => `ClickHouse returned ${value.rows.length} ranked record${value.rows.length === 1 ? "" : "s"}`);
  if (!result.rows.length) return null;
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const rows = result.rows.map((row) => ({
    entity: String(row.entity_name ?? "Untitled"),
    metric: number(row.aggregate_metric),
    observations: number(row.observation_count),
  }));
  workflow.event("answering", "Rendered an evidence-backed ranking", "completed");
  workflow.status("answering", "Streaming the verified ranking");
  const rankingTitle = `${direction === "ASC" ? "Lowest" : "Top"} ${rows.length} ${entityLabel}${/s$/i.test(entityLabel) ? "" : "s"}`;
  return {
    title: rankingTitle,
    summary: `Ranked by average ${metricLabel} across each ${observationLabel.toLowerCase()} in the imported data. The number of ${observationLabel.toLowerCase()} records breaks ties.`,
    cards: rows.slice(0, 3).map((row) => ({ label: row.entity, value: String(Number(row.metric.toFixed(2))), detail: `${row.observations.toLocaleString()} ${observationLabel.toLowerCase()} record${row.observations === 1 ? "" : "s"}` })),
    table: { columns: [entityLabel, `Average ${metricLabel}`, `${observationLabel} Records`], rows: rows.map((row) => ({ [entityLabel]: row.entity, [`Average ${metricLabel}`]: Number(row.metric.toFixed(2)), [`${observationLabel} Records`]: row.observations })) },
    caveat: `Source: ${source.source.sourcePath ?? source.source.table}. This is a schema-driven aggregate, not a text search or outside-knowledge recommendation.`,
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

type ExecutedPlanQuery = {
  question: string;
  sql: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  tables: string[];
};

function displayQueryValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  return JSON.stringify(value) ?? null;
}

async function executeSqlPlan(context: DatasetContext, plan: AnalysisPlan) {
  const workflow = createWorkflowReporter();
  const clickhouse = new ClickHouseClient(createClickHouseConfig());
  const allowedTables = context.tables.map((source) => source.table);
  const completed: ExecutedPlanQuery[] = [];
  for (const [index, step] of plan.queries.entries()) {
    const result = await workflow.activity("querying", `${index + 1}/${plan.queries.length} ${step.question}`, async () => {
      const verified = validateReadOnlySql(step.sql, allowedTables);
      if (!verified.ok) throw new Error(verified.error);
      const query = await clickhouse.query<Record<string, unknown>>(step.sql, { timeoutMs: 15_000 });
      return { rows: query.rows, tables: verified.tables };
    }, (value) => `ClickHouse returned ${value.rows.length} row${value.rows.length === 1 ? "" : "s"}`);
    const evidence: ExecutedPlanQuery = { question: step.question, sql: step.sql, rows: result.rows, rowCount: result.rows.length, tables: result.tables };
    completed.push(evidence);
    chat.response.write({
      type: "data-sql-step",
      id: `sql-step-${crypto.randomUUID()}`,
      data: evidence,
    } as never);
  }
  return completed;
}

function planInsight(context: DatasetContext, plan: AnalysisPlan, completed: ExecutedPlanQuery[]): AnalystInsight {
  const final = completed.at(-1);
  if (!final) {
    return {
      title: "The dataset cannot answer this request",
      summary: plan.limitation ?? "No safe executable ClickHouse query could be produced from the imported schema.",
      cards: [],
      table: { columns: ["Status"], rows: [{ Status: "Not possible from the imported data" }] },
      caveat: "No result was inferred outside the dataset.",
    };
  }
  const source = final.tables.map((table) => context.tables.find((candidate) => candidate.table === table)?.sourcePath ?? table).join(", ");
  const columns = final.rows.length ? Object.keys(final.rows[0]) : [];
  const rows = final.rows.slice(0, 20).map((row) => Object.fromEntries(columns.map((column) => [column, displayQueryValue(row[column])]))) as Array<Record<string, string | number | boolean | null>>;
  return {
    title: plan.objective,
    summary: `Executed ${completed.length} validated ClickHouse ${completed.length === 1 ? "query" : "queries"}; the final query returned ${final.rowCount} row${final.rowCount === 1 ? "" : "s"}.`,
    cards: [{ label: "Final rows", value: String(final.rowCount) }, { label: "SQL steps", value: String(completed.length) }],
    table: { columns, rows },
    caveat: `Source: ${source || "imported dataset"}. Results are limited to the rows returned by the final query.`,
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
    run: async ({ messages, clientData }) => {
      if (!clientData) throw new Error("Dataset context is required");
      const context = datasetContext.get();
      const question = latestUserQuestion(messages);
      if (!question) throw new Error("A question is required");
      const model = resolveChatModel(clientData);
      const planner = createWorkflowReporter();
      const plan = await planner.activity(
        "planning",
        "Writing an executable ClickHouse plan",
        () => createAnalysisPlan(model, question, context),
        (value) => value.outcome === "query"
          ? `Created ${value.queries.length} executable SQL step${value.queries.length === 1 ? "" : "s"}`
          : "Determined that the imported schema cannot answer this request",
      );
      chat.response.write({
        type: "data-analysis-plan",
        id: `analysis-plan-${crypto.randomUUID()}`,
        data: { objective: plan.objective, subquestions: plan.queries.map((step) => step.question), outcome: plan.outcome, limitation: plan.limitation },
      } as never);
      if (plan.outcome !== "query" || !plan.queries.length) {
        chat.response.write({
          type: "data-analyst-insight",
          id: `analyst-limitation-${crypto.randomUUID()}`,
          data: planInsight(context, plan, []),
        } as never);
        return;
      }
      try {
        const completed = await executeSqlPlan(context, plan);
        chat.response.write({
          type: "data-analyst-insight",
          id: `analyst-insight-${crypto.randomUUID()}`,
          data: planInsight(context, plan, completed),
        } as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chat.response.write({
          type: "data-analyst-insight",
          id: `analyst-query-error-${crypto.randomUUID()}`,
          data: {
            title: "The SQL plan could not be executed",
            summary: "The agent produced a query that ClickHouse rejected, so no answer was inferred.",
            cards: [],
            table: { columns: ["Status", "Detail"], rows: [{ Status: "Query failed", Detail: message }] },
            caveat: "The visible SQL step is retained for diagnosis and correction.",
          } satisfies AnalystInsight,
        } as never);
      }
    },
  });
