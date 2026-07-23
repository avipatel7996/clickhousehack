import { IngestionError } from './errors';

export const MAX_MANIFEST_BYTES = 2 * 1024 ** 3;
export const SUPPORTED_TABULAR_EXTENSIONS = ['.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.parquet'] as const;
export type ManifestFile = { path: string; sizeBytes: number; etag?: string };
export type ManifestInputFile = ManifestFile | { path: string; size: number; etag?: string };
export type ManifestValidation = { files: ManifestFile[]; totalBytes: number; supported: true };

export function validateManifest(files: readonly ManifestInputFile[] | { files: readonly ManifestInputFile[] }, maxBytes = MAX_MANIFEST_BYTES): ManifestValidation {
  const entries = Array.isArray(files) ? files : ('files' in files ? files.files : undefined);
  if (!Array.isArray(entries)) throw new IngestionError('INVALID_MANIFEST', 'Manifest files must be an array');
  const seen = new Set<string>(); let totalBytes = 0;
  const normalized = entries.map((file) => {
    if (!file || typeof file.path !== 'string' || !file.path.trim() || file.path.startsWith('/') || file.path.split('/').includes('..')) throw new IngestionError('INVALID_MANIFEST', 'Manifest paths must be relative', { file });
    const sizeBytes = 'sizeBytes' in file ? file.sizeBytes : file.size;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new IngestionError('INVALID_MANIFEST', 'File size must be a non-negative integer', { path: file.path });
    if (seen.has(file.path)) throw new IngestionError('INVALID_MANIFEST', 'Duplicate manifest path', { path: file.path }); seen.add(file.path);
    const dot = file.path.lastIndexOf('.'); const ext = dot < 0 ? '' : file.path.slice(dot).toLowerCase();
    if (!(SUPPORTED_TABULAR_EXTENSIONS as readonly string[]).includes(ext)) throw new IngestionError('UNSUPPORTED_TABULAR_FORMAT', `Unsupported tabular format: ${ext || '<none>'}`, { path: file.path, extension: ext });
    totalBytes += sizeBytes;
    return { path: file.path, sizeBytes, ...(file.etag === undefined ? {} : { etag: file.etag }) };
  });
  if (totalBytes > maxBytes) throw new IngestionError('MANIFEST_TOO_LARGE', 'Manifest exceeds size limit', { totalBytes, maxBytes });
  return { files: normalized, totalBytes, supported: true };
}
