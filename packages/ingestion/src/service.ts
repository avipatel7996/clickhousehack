import { computeIdempotencyKey } from './identifiers';
import { parseKaggleDatasetUrl, type KaggleDatasetRef } from './url';
import { SUPPORTED_TABULAR_EXTENSIONS, validateManifest, type ManifestFile } from './manifest';

export interface KaggleFile extends ManifestFile { download(): Promise<ReadableStream<Uint8Array> | Uint8Array> }
export interface KaggleGateway {
  list(ref: KaggleDatasetRef): Promise<{ version: number; files: KaggleFile[]; title?: string; license?: string }>;
}
export interface ObjectStore { put(key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ key: string; etag?: string }> }
export interface ClickHouseLoader {
  /** True when the loader cannot read the uploaded source file itself. */
  needsContents?(files: ManifestFile[]): boolean;
  publish(input: { workspaceId: string; importId: string; sourceKeys: string[]; files: ManifestFile[]; contents?: Uint8Array[] }): Promise<{ tableIds: string[]; rowCount: number }>;
}
export interface ImportRepository {
  findByIdempotencyKey(key: string): Promise<{ importId: string; status: string } | null>;
  markFailed?(input: { importId: string; message: string }): Promise<void>;
  markPublished(input: { importId: string; source: KaggleDatasetRef; version: number; files: ManifestFile[]; tableIds: string[]; rowCount: number }): Promise<void>;
}
export interface ImportRequest { workspaceId: string; importId: string; kaggleUrl: string; selectedFiles?: string[] }

export type ImportProgress = {
  stage: "listing" | "downloading" | "uploading" | "publishing";
  completedFiles?: number;
  totalFiles?: number;
  completedBytes?: number;
  totalBytes?: number;
  message: string;
};

export interface ImportDatasetDependencies {
  kaggle: KaggleGateway;
  objects: ObjectStore;
  clickhouse: ClickHouseLoader;
  repository: ImportRepository;
  onProgress?: (progress: ImportProgress) => Promise<void> | void;
  fileConcurrency?: number;
}

export async function importDataset(request: ImportRequest, deps: ImportDatasetDependencies) {
  const source = parseKaggleDatasetUrl(request.kaggleUrl);
  await deps.onProgress?.({ stage: "listing", message: "Listing dataset files" });
  const manifest = await deps.kaggle.list(source);
  const selected = request.selectedFiles?.length
    ? manifest.files.filter((file) => request.selectedFiles!.includes(file.path))
    : manifest.files.filter((file) => SUPPORTED_TABULAR_EXTENSIONS.some((extension) => file.path.toLowerCase().endsWith(extension)));
  if (!selected.length) throw new Error('Kaggle dataset contains no supported tabular files (CSV, TSV, JSON, JSONL, NDJSON, or Parquet)');
  if (request.selectedFiles?.length && selected.length !== new Set(request.selectedFiles).size) throw new Error('One or more selected Kaggle files were not found');
  const validated = validateManifest(selected);
  const totalBytes = validated.totalBytes;
  const key = computeIdempotencyKey(source, { workspaceId: request.workspaceId, version: manifest.version, files: validated.files.map((file) => file.path) });
  const existing = await deps.repository.findByIdempotencyKey(key);
  if (existing) return { ...existing, idempotencyKey: key, deduplicated: true };
  const sourceKeys: string[] = new Array(selected.length);
  const retainContents = deps.clickhouse.needsContents?.(validated.files) ?? true;
  const contents: Uint8Array[] | undefined = retainContents ? new Array(selected.length) : undefined;
  let completedFiles = 0;
  let completedBytes = 0;
  await deps.onProgress?.({ stage: "downloading", completedFiles, totalFiles: selected.length, completedBytes, totalBytes, message: `Downloading ${selected.length} file${selected.length === 1 ? '' : 's'} from Kaggle` });
  await mapWithConcurrency(selected, Math.min(Math.max(1, deps.fileConcurrency ?? 3), selected.length), async (file, index) => {
    const body = await file.download();
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    await deps.onProgress?.({ stage: "uploading", completedFiles, totalFiles: selected.length, completedBytes, totalBytes, message: `Saving ${file.path}` });
    const stored = await deps.objects.put(`imports/${request.workspaceId}/${request.importId}/source/${file.path}`, bytes);
    sourceKeys[index] = stored.key;
    if (contents) contents[index] = bytes;
    completedFiles++;
    completedBytes += bytes.byteLength;
    await deps.onProgress?.({ stage: "uploading", completedFiles, totalFiles: selected.length, completedBytes, totalBytes, message: `Saved ${completedFiles} of ${selected.length} file${selected.length === 1 ? '' : 's'}` });
  });
  await deps.onProgress?.({ stage: "publishing", completedFiles, totalFiles: selected.length, completedBytes, totalBytes, message: "Creating ClickHouse tables" });
  const published = await deps.clickhouse.publish({ workspaceId: request.workspaceId, importId: request.importId, sourceKeys, files: validated.files, ...(contents ? { contents } : {}) });
  await deps.repository.markPublished({ importId: request.importId, source, version: manifest.version, files: validated.files, ...published });
  return { importId: request.importId, status: 'published' as const, idempotencyKey: key, ...published };
}

async function mapWithConcurrency<T>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const runWorker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runWorker));
}
