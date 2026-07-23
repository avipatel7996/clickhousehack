import type { ClickHouseConfig, QueryExecutor, QueryOptions, QueryResult } from '../../core/src/types';
import { validateSql } from '../../core/src/sql-validator';

declare const process: { env: Record<string, string | undefined> };

export class ClickHouseError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) { super(message); this.name = 'ClickHouseError'; this.status = status; }
}

export class ClickHouseClient implements QueryExecutor {
  readonly config: ClickHouseConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  constructor(config: ClickHouseConfig) {
    this.config = { ...config, url: config.url.replace(/\/$/, '') };
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('A fetch implementation is required');
  }

  async query<T = Record<string, unknown>>(sql: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    const statement = validateSql(sql, { allowMetadataStatements: true, allowTrailingSemicolon: true });
    const controller = new AbortController();
    const timeout = options.timeoutMs ?? this.config.timeoutMs;
    const timer = timeout && setTimeout(() => controller.abort(), timeout);
    if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const params = new URLSearchParams({ query: statement, default_format: 'JSONEachRow' });
    if (this.config.database) params.set('database', this.config.database);
    for (const [key, value] of Object.entries(options.params || {})) params.set(`param_${key}`, String(value ?? ''));
    const headers: Record<string, string> = { Accept: 'application/json', ...this.config.headers };
    if (this.config.username) headers['X-ClickHouse-User'] = this.config.username;
    if (this.config.password) headers['X-ClickHouse-Key'] = this.config.password;
    let response: Response;
    try { response = await this.fetchImpl(`${this.config.url}/?${params.toString()}`, { method: 'POST', headers, signal: controller.signal }); }
    catch (error) { throw new ClickHouseError(error instanceof Error ? error.message : String(error)); }
    finally { if (timer) clearTimeout(timer); }
    const body = await response.text();
    if (!response.ok) throw new ClickHouseError(body || response.statusText, response.status);
    const rows: T[] = [];
    for (const line of body.split(/\r?\n/).filter(Boolean)) {
      try { rows.push(JSON.parse(line)); } catch { throw new ClickHouseError('Invalid JSON returned by ClickHouse'); }
    }
    return { rows };
  }

  async health(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    try { await this.query('SELECT 1', { ...options, timeoutMs: 5000 }); return true; } catch { return false; }
  }
}

export const createClickHouseClient = (config: ClickHouseConfig) => new ClickHouseClient(config);

export function createClickHouseConfig(overrides: Partial<ClickHouseConfig> = {}): ClickHouseConfig {
  const env = typeof process !== 'undefined' ? process.env : {};
  return {
    url: overrides.url || env.CLICKHOUSE_URL || env.CLICKHOUSE_HOST || 'http://localhost:8123',
    username: overrides.username ?? env.CLICKHOUSE_USER,
    password: overrides.password ?? env.CLICKHOUSE_PASSWORD,
    database: overrides.database ?? env.CLICKHOUSE_DATABASE,
    timeoutMs: overrides.timeoutMs ?? (env.CLICKHOUSE_TIMEOUT_MS ? Number(env.CLICKHOUSE_TIMEOUT_MS) : undefined),
    headers: overrides.headers,
    fetch: overrides.fetch,
  };
}

export async function readOnlyQuery<T = Record<string, unknown>>(
  sql: string,
  config: ClickHouseConfig = createClickHouseConfig(),
  options?: QueryOptions,
): Promise<QueryResult<T>> {
  return createClickHouseClient(config).query<T>(sql, options);
}
