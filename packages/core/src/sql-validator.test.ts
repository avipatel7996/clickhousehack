import { isSafeSql, validateSql } from './sql-validator';
import { describe, expect, it } from 'vitest';

describe('validateSql', () => {
  it('accepts read-only statements', () => expect(validateSql('SELECT 1')).toBe('SELECT 1'));
  it('rejects mutations and multiple statements', () => {
    expect(isSafeSql('DROP TABLE users')).toBe(false);
    expect(isSafeSql('SELECT 1; SELECT 2')).toBe(false);
  });
});
