import { computeIdempotencyKey } from './identifiers';
import { parseKaggleDatasetUrl, type KaggleDatasetRef } from './url';
import { validateManifest, type ManifestFile } from './manifest';

export interface KaggleFile extends ManifestFile { download(): Promise<ReadableStream<Uint8Array> | Uint8Array> }
export interface KaggleGateway {
  list(ref: KaggleDatasetRef): Promise<{ version: number; files: KaggleFile[]; title?: string; license?: string }>;
}
export interface ObjectStore { put(key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ key: string; etag?: string }> }
export interface ClickHouseLoader {
  publish(input: { workspaceId: string; importId: string; sourceKeys: string[]; files: ManifestFile[]; contents?: Uint8Array[] }): Promise<{ tableIds: string[]; rowCount: number }>;
}
export interface ImportRepository {
  findByIdempotencyKey(key: string): Promise<{ importId: string; status: string } | null>;
  markPublished(input: { importId: string; source: KaggleDatasetRef; version: number; files: ManifestFile[]; tableIds: string[]; rowCount: number }): Promise<void>;
}
export interface ImportRequest { workspaceId: string; importId: string; kaggleUrl: string; selectedFiles?: string[] }

export async function importDataset(request: ImportRequest, deps: { kaggle: KaggleGateway; objects: ObjectStore; clickhouse: ClickHouseLoader; repository: ImportRepository }) {
  const source = parseKaggleDatasetUrl(request.kaggleUrl);
  const manifest = await deps.kaggle.list(source);
  const selected = request.selectedFiles?.length ? manifest.files.filter((file) => request.selectedFiles!.includes(file.path)) : manifest.files;
  if (request.selectedFiles?.length && selected.length !== new Set(request.selectedFiles).size) throw new Error('One or more selected Kaggle files were not found');
  const validated = validateManifest(selected);
  const key = computeIdempotencyKey(source, { workspaceId: request.workspaceId, version: manifest.version, files: validated.files.map((file) => file.path) });
  const existing = await deps.repository.findByIdempotencyKey(key);
  if (existing) return { ...existing, idempotencyKey: key, deduplicated: true };
  const sourceKeys: string[] = [];
  const contents: Uint8Array[] = [];
  for (const file of selected) {
    const body = await file.download();
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    const stored = await deps.objects.put(`imports/${request.workspaceId}/${request.importId}/source/${file.path}`, bytes);
    sourceKeys.push(stored.key);
    contents.push(bytes);
  }
  const published = await deps.clickhouse.publish({ workspaceId: request.workspaceId, importId: request.importId, sourceKeys, files: validated.files, contents });
  await deps.repository.markPublished({ importId: request.importId, source, version: manifest.version, files: validated.files, ...published });
  return { importId: request.importId, status: 'published' as const, idempotencyKey: key, ...published };
}
