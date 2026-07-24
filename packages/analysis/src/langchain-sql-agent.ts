import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool, toolCallLimitMiddleware, toolStrategy } from "langchain";
import { z } from "zod";

export type AgentDatasetTable = {
  table: string;
  columns: Array<{ name: string; type: string }>;
  sourcePath?: string;
};

export type SqlAgentProvider =
  | { kind: "gemini"; apiKey: string; model: string }
  | { kind: "openai-compatible"; apiKey: string; model: string; baseURL: string };

export type ExecutedSqlStep = {
  sql: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  tables: string[];
};

export type SqlAgentPresentation = {
  title: string;
  summary: string;
  caveat?: string;
};

const presentationSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(700),
  caveat: z.string().max(400).optional(),
});

function createModel(provider: SqlAgentProvider) {
  if (provider.kind === "gemini") {
    return new ChatGoogleGenerativeAI({
      apiKey: provider.apiKey,
      model: provider.model,
      temperature: 0,
      maxOutputTokens: 900,
    });
  }
  return new ChatOpenAI({
    apiKey: provider.apiKey,
    model: provider.model,
    temperature: 0,
    maxTokens: 900,
    configuration: { baseURL: provider.baseURL },
  });
}

/** A bounded ReAct loop: the model writes SQL, the application executes it. */
export async function runLangChainSqlAgent(input: {
  question: string;
  tables: AgentDatasetTable[];
  provider: SqlAgentProvider;
  executeSql: (sql: string) => Promise<{ rows: Array<Record<string, unknown>>; tables: string[] }>;
  onQuery?: (step: ExecutedSqlStep) => void;
}) {
  const executed: ExecutedSqlStep[] = [];
  const queryClickHouse = tool(
    async ({ sql }) => {
      const result = await input.executeSql(sql);
      const step: ExecutedSqlStep = { sql, rows: result.rows, rowCount: result.rows.length, tables: result.tables };
      executed.push(step);
      input.onQuery?.(step);
      // Keep model context bounded while returning enough evidence for a final
      // answer. The UI receives the same verified data via onQuery.
      return JSON.stringify({ sql, rowCount: step.rowCount, rows: step.rows.slice(0, 20), tables: step.tables });
    },
    {
      name: "query_clickhouse",
      description: "Execute exactly one read-only ClickHouse SELECT or WITH query against the imported dataset. Use this before answering any data question. The query is validated before execution.",
      schema: z.object({ sql: z.string().min(8).max(5000) }),
    },
  );
  const schema = input.tables.map((table) => ({
    table: table.table,
    source: table.sourcePath ?? table.table,
    columns: table.columns,
  }));
  const agent = createAgent({
    model: createModel(input.provider),
    tools: [queryClickHouse],
    responseFormat: toolStrategy(presentationSchema),
    middleware: [toolCallLimitMiddleware({ toolName: "query_clickhouse", runLimit: 4, exitBehavior: "end" })],
    systemPrompt: `You are a careful SQL analyst. The imported ClickHouse schema is: ${JSON.stringify(schema)}.

For every answer grounded in this dataset, call query_clickhouse before producing the final response. Write exact ClickHouse SQL using only the listed tables and columns.

Use one query for a simple preview, lookup, filter, or aggregate. Use additional queries only when a prior result is genuinely needed to resolve an entity or check a relationship; the last query must answer the user’s original question. Never make up rows, columns, meanings, or outside facts. If the schema cannot answer the question, explain that precisely in the structured response without calling a query. After queries complete, return a concise evidence-backed title and summary; the application will render the verified final query rows.`,
  });
  const state = await agent.invoke({ messages: [{ role: "user", content: input.question }] });
  const structured = state.structuredResponse as SqlAgentPresentation | undefined;
  return {
    executed,
    presentation: structured ?? {
      title: executed.length ? "Verified ClickHouse result" : "The dataset cannot answer this request",
      summary: executed.length ? "The agent completed a ClickHouse query." : "The agent did not produce a query for this dataset.",
    },
  };
}
