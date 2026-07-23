/** Error raised when a query is not safe for the read-only query endpoint. */
export class SqlValidationError extends Error {
  readonly code = 'UNSAFE_SQL';
  constructor(message: string) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

export interface SqlValidationOptions {
  /** Permit EXPLAIN/SHOW/DESCRIBE in addition to SELECT and WITH. */
  allowMetadataStatements?: boolean;
  /** Permit a trailing semicolon (multiple statements are never permitted). */
  allowTrailingSemicolon?: boolean;
}

const forbidden = /\b(INSERT|ALTER|DELETE|UPDATE|DROP|TRUNCATE|CREATE|RENAME|OPTIMIZE|SYSTEM|KILL|GRANT|REVOKE|ATTACH|DETACH|WATCH|SET|USE)\b/i;

/**
 * Validate that `sql` contains exactly one read-only ClickHouse statement.
 * This is intentionally conservative: callers should still use DB credentials
 * with only the permissions they need.
 */
export function validateSql(sql: string, options: SqlValidationOptions = {}): string {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlValidationError('SQL query must be a non-empty string');
  let text = sql.trim();
  if (text.includes('--') || text.includes('/*') || text.includes('*/')) {
    throw new SqlValidationError('SQL comments are not allowed');
  }
  const semis = [...text].filter((c) => c === ';').length;
  if (semis > 0) {
    if (!(options.allowTrailingSemicolon && semis === 1 && text.endsWith(';'))) {
      throw new SqlValidationError('Multiple SQL statements are not allowed');
    }
    text = text.slice(0, -1).trim();
  }
  if (forbidden.test(text)) throw new SqlValidationError('Only read-only SQL statements are allowed');
  const start = text.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  const allowed = options.allowMetadataStatements
    ? ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']
    : ['SELECT', 'WITH'];
  if (!start || !allowed.includes(start)) {
    throw new SqlValidationError(`Statement must begin with ${allowed.join(', ')}`);
  }
  return text;
}

export const isSafeSql = (sql: string, options?: SqlValidationOptions): boolean => {
  try { validateSql(sql, options); return true; } catch { return false; }
};
