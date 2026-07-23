import { createHash } from 'node:crypto';

export function normalizeIdentifier(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}.-]+/gu, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

export function idempotencyKey(dataset: string | { owner: string; slug: string; version?: number }, manifest: unknown): string {
  const identity = typeof dataset === 'string' ? normalizeIdentifier(dataset) : `${normalizeIdentifier(dataset.owner)}/${normalizeIdentifier(dataset.slug)}${dataset.version == null ? '' : `/versions/${dataset.version}`}`;
  const canonical = JSON.stringify(canonicalize({ dataset: identity, manifest }));
  return createHash('sha256').update(canonical).digest('hex');
}

export const computeIdempotencyKey = idempotencyKey;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
