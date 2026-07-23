import { validateSql } from '../../core/src/sql-validator';

export type SqlCheck = { ok: true; tables: string[] } | { ok: false; error: string };

/** Validate a query and, when supplied, enforce a table allow-list. */
export function validateReadOnlySql(sql: string, allowedTables: string[] = []): SqlCheck {
  try {
    const statement = validateSql(sql, { allowMetadataStatements: false, allowTrailingSemicolon: true });
    if (/\b(?:s3|url|file|hdfs|mysql|jdbc)\s*\(/i.test(statement)) return { ok: false, error: 'External table functions are not allowed' };
    if (/(?:^|\s|\.)system\./i.test(statement)) return { ok: false, error: 'System tables are not allowed' };
    // This intentionally handles ordinary FROM/JOIN references and is not a SQL parser.
    const tables: string[] = [];
    const re = /\b(?:FROM|JOIN)\s+([`"A-Za-z_][\w.$-]*(?:\.[`"A-Za-z_][\w.$-]*)?)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(statement))) {
      const table = match[1].replace(/[`\"]/g, '');
      if (!tables.includes(table)) tables.push(table);
    }
    if (allowedTables.length) {
      const allow = new Set(allowedTables.map((t) => t.replace(/[`\"]/g, '').toLowerCase()));
      const disallowed = tables.find((t) => !allow.has(t.toLowerCase()));
      if (disallowed) return { ok: false, error: `Table is not allowed: ${disallowed}` };
    }
    return { ok: true, tables };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
