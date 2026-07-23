import { describe, expect, it } from 'vitest';
import { idempotencyKey, normalizeIdentifier, parseKaggleDatasetUrl, validateManifest } from '../src/index.js';

describe('Kaggle URL parser', () => {
  it('parses and canonicalizes dataset URLs', () => expect(parseKaggleDatasetUrl('https://www.kaggle.com/datasets/Acme/My_Data/versions/3')).toEqual({ owner: 'acme', slug: 'my-data', version: 3, canonicalRef: 'acme/my-data/versions/3' }));
  it('rejects non Kaggle and malformed URLs', () => expect(() => parseKaggleDatasetUrl('https://example.com/datasets/a/b')).toThrow(/Kaggle/));
});

describe('manifest validation', () => {
  it('accepts supported files and totals bytes', () => expect(validateManifest([{ path: 'x.csv', sizeBytes: 10 }, { path: 'y.parquet', sizeBytes: 4 }]).totalBytes).toBe(14));
  it('rejects unsupported files and >2 GiB manifests', () => {
    expect(() => validateManifest([{ path: 'x.exe', sizeBytes: 1 }])).toThrow(/Unsupported/);
    expect(() => validateManifest([{ path: 'x.csv', sizeBytes: 2 * 1024 ** 3 + 1 }])).toThrow(/size limit/);
  });
});

it('normalizes identifiers and gives stable keys', () => {
  expect(normalizeIdentifier('  Café_Data ')).toBe('café-data');
  expect(idempotencyKey('Acme/Data', { b: 2, a: 1 })).toBe(idempotencyKey('acme/data', { b: 2, a: 1 }));
});
