import type { ClickHouseConfig } from '../../core/src/types';

declare const process: { env: Record<string, string | undefined> };

const first = (...values: Array<string | undefined>) => values.find((v) => v !== undefined && v !== '');

/** Read ClickHouse connection settings from conventional environment variables. */
export function clickHouseConfigFromEnv(env: Record<string, string | undefined> = process.env): ClickHouseConfig {
  const url = first(env.CLICKHOUSE_URL, env.CLICKHOUSE_HOST, env.CH_URL, env.CH_HOST) || 'http://localhost:8123';
  return {
    url: url.replace(/\/$/, ''),
    username: first(env.CLICKHOUSE_USER, env.CLICKHOUSE_USERNAME, env.CH_USER),
    password: first(env.CLICKHOUSE_PASSWORD, env.CH_PASSWORD),
    database: first(env.CLICKHOUSE_DATABASE, env.CLICKHOUSE_DB, env.CH_DATABASE),
    timeoutMs: env.CLICKHOUSE_TIMEOUT_MS ? Number(env.CLICKHOUSE_TIMEOUT_MS) : undefined,
  };
}

export const getClickHouseConfig = clickHouseConfigFromEnv;
