import { describe, expect, it } from 'vitest';
import { validateReadOnlySql } from './sql';

describe('validateReadOnlySql', () => {
  it('allows only allowlisted physical tables', () => {
    expect(validateReadOnlySql('SELECT count() FROM ws_1.table_1', ['ws_1.table_1']).ok).toBe(true);
    expect(validateReadOnlySql('SELECT * FROM ws_1.other', ['ws_1.table_1']).ok).toBe(false);
  });
  it('blocks table functions and system tables', () => {
    expect(validateReadOnlySql("SELECT * FROM url('https://example.com/a.csv', 'CSV')").ok).toBe(false);
    expect(validateReadOnlySql('SELECT * FROM system.query_log').ok).toBe(false);
  });
});
