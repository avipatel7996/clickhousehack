/** Shared domain types used by the ClickHouse adapter and API consumers. */
export type SqlParams = Record<string, string | number | boolean | null | Date>;

export type ImportStatus = "queued" | "inspecting" | "loading" | "published" | "failed";
export interface Workspace { id: string; name: string; createdAt: string }
export interface DatasetImport {
  id: string;
  workspaceId: string;
  sourceUrl: string;
  canonicalRef: string;
  version: number;
  status: ImportStatus;
  sourceFiles: Array<{ path: string; sizeBytes: number; checksum?: string }>;
  physicalTables: string[];
  rowCount?: number;
  license?: string;
}
export interface QueryEvidence { queryId: string; sql: string; datasetId: string; rowCount: number; elapsedMs?: number }
export interface ChartSpec { type: "bar" | "line" | "scatter" | "table"; x?: string; y?: string; series?: string }
export interface AnalysisResult { answer: string; evidence: QueryEvidence[]; chart?: ChartSpec; caveats: string[]; datasetVersion: string }

export interface QueryOptions {
  /** Maximum time, in milliseconds, a request may take. */
  timeoutMs?: number;
  /** Values are sent as ClickHouse query parameters where supported. */
  params?: SqlParams;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  meta?: Array<{ name: string; type: string }>;
  statistics?: { elapsed?: number; rowsRead?: number; bytesRead?: number };
}

export interface ClickHouseConfig {
  url: string;
  username?: string;
  password?: string;
  database?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Optional fetch implementation for tests or non-browser runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, options?: QueryOptions): Promise<QueryResult<T>>;
}
