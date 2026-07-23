/** Production adapters for the ingestion service. All side effects are injectable for tests. */
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ClickHouseConfig } from '../../core/src/types';
import type { KaggleDatasetRef } from './url';
import type { KaggleFile, KaggleGateway, ObjectStore, ClickHouseLoader } from './service';
import type { ManifestFile } from './manifest';
import { normalizeIdentifier } from './identifiers';

type ExecResult = { stdout: string; stderr: string };
export type ExecFile = (file: string, args: readonly string[], options?: { maxBuffer?: number }) => Promise<ExecResult>;
const defaultExec: ExecFile = (file, args, options) => promisify(nodeExecFile)(file, args as string[], { ...options, encoding: 'utf8' }) as unknown as Promise<ExecResult>;

function parseListing(stdout: string): Array<{ path: string; sizeBytes: number; etag?: string }> {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    const rows = Array.isArray(value) ? value : (value && typeof value === 'object' && 'files' in value ? (value as { files: unknown }).files : []);
    if (Array.isArray(rows)) return rows.map((r) => {
      const x = r as Record<string, unknown>;
      return { path: String(x.name ?? x.path ?? ''), sizeBytes: Number(x.sizeBytes ?? x.size ?? 0), ...(x.etag ? { etag: String(x.etag) } : {}) };
    });
  } catch { /* CLI versions print a table; parse that below. */ }
  return text.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean).map(line => {
    const cols = line.split(/\s{2,}|\t/).filter(Boolean);
    return { path: cols[0] ?? '', sizeBytes: Number((cols[1] ?? '0').replace(/[^0-9]/g, '')) || 0 };
  });
}

export interface KaggleCliOptions { executable?: string; execFile?: ExecFile; tempDir?: string }

/** Kaggle's HTTP API adapter. This avoids relying on a Python executable in a
 * managed Trigger worker; the API token is supplied as a Bearer credential. */
export class KaggleApiGateway implements KaggleGateway {
  constructor(private readonly options: { token: string; baseUrl?: string; fetch?: typeof globalThis.fetch }) {
    if (!options.token) throw new Error('KAGGLE_API_TOKEN is required');
  }
  private get fetchImpl() { return this.options.fetch ?? globalThis.fetch; }
  private apiUrl(path: string) { return `${(this.options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '')}/${path}`; }
  async list(ref: KaggleDatasetRef) {
    const version = ref.version ?? 1;
    const response = await this.fetchImpl(this.apiUrl(`datasets/list/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.slug)}`), { headers: { Authorization: `Bearer ${this.options.token}` } });
    if (!response.ok) throw new Error(`Kaggle API listing failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { datasetFiles?: Array<{ name?: string; totalBytes?: number; ref?: string }> };
    const files = (body.datasetFiles ?? []).map((file) => ({
      path: String(file.name ?? ''), sizeBytes: Number(file.totalBytes ?? 0), etag: file.ref || undefined,
      download: () => this.download(ref, String(file.name ?? '')),
    })).filter((file) => file.path);
    return { version, files };
  }
  private async download(ref: KaggleDatasetRef, path: string): Promise<Uint8Array> {
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe Kaggle file path');
    const response = await this.fetchImpl(this.apiUrl(`datasets/download/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.slug)}/${path.split('/').map(encodeURIComponent).join('/')}`), { headers: { Authorization: `Bearer ${this.options.token}` } });
    if (!response.ok) throw new Error(`Kaggle API download failed (${response.status}): ${await response.text()}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class KaggleCliGateway implements KaggleGateway {
  private readonly executable: string; private readonly run: ExecFile; private readonly tempDir?: string;
  constructor(options: KaggleCliOptions = {}) { this.executable = options.executable ?? 'kaggle'; this.run = options.execFile ?? defaultExec; this.tempDir = options.tempDir; }
  private command(args: readonly string[]) {
    // Trigger's Python build extension installs console scripts in a Python
    // environment that is not always on Node's PATH. Running the module keeps
    // the production worker independent of that console-script location.
    // Trigger's Python extension exposes an absolute interpreter path (for
    // example /opt/venv/bin/python). Passing the Kaggle subcommand directly
    // to that binary makes Python look for /app/datasets as a script.
    // Detect the interpreter by basename so both PATH and absolute paths work.
    if (/^python(?:\d+(?:\.\d+)?)?$/.test(basename(this.executable))) return { file: this.executable, args: ['-m', 'kaggle', ...args] };
    return { file: this.executable, args: [...args] };
  }
  async list(ref: KaggleDatasetRef) {
    const datasetRef = ref.version === undefined ? `${ref.owner}/${ref.slug}` : `${ref.owner}/${ref.slug}/versions/${ref.version}`;
    const args = ['datasets', 'files', '-d', datasetRef, '--format', 'json'];
    const command = this.command(args);
    const { stdout } = await this.run(command.file, command.args);
    const files = parseListing(stdout).map(file => ({ ...file, async download() { throw new Error('download() is bound by KaggleCliGateway.list'); } }));
    const version = ref.version ?? 1;
    return { version, files: files.map(file => ({ ...file, download: () => this.download(ref, file.path) })) };
  }
  private async download(ref: KaggleDatasetRef, path: string): Promise<Uint8Array> {
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe Kaggle file path');
    const dir = await mkdtemp(join(this.tempDir ?? tmpdir(), 'kaggle-'));
    try {
      const datasetRef = ref.version === undefined ? `${ref.owner}/${ref.slug}` : `${ref.owner}/${ref.slug}/versions/${ref.version}`;
      const args = ['datasets', 'download', '-d', datasetRef, '-f', path, '-p', dir, '--unzip', '--force'];
      const command = this.command(args);
      await this.run(command.file, command.args);
      return new Uint8Array(await this.readDownloadedFile(dir, path));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  private async readDownloadedFile(dir: string, requestedPath: string): Promise<Buffer> {
    const directPath = join(dir, requestedPath);
    try {
      return await readFile(directPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    // Kaggle's CLI occasionally normalizes duplicate filenames during unzip
    // (`Movie (1).csv` becomes `Movie.csv`) or extracts them under a folder.
    // Resolve only an exact basename or a single duplicate-suffix variant so
    // we never silently upload a different dataset file.
    const entries = await readdir(dir, { recursive: true });
    const requestedName = basename(requestedPath);
    const exact = entries.find((entry) => basename(entry) === requestedName);
    const normalized = entries.filter((entry) => kaggleFilenameKey(basename(entry)) === kaggleFilenameKey(requestedName));
    const resolved = exact ?? (normalized.length === 1 ? normalized[0] : undefined);
    if (!resolved) {
      const found = entries.slice(0, 20).join(", ") || "no files";
      throw new Error(`Kaggle download did not produce ${requestedPath}. Found: ${found}`);
    }
    return readFile(join(dir, resolved));
  }
}

function kaggleFilenameKey(filename: string) {
  let decoded = filename;
  try { decoded = decodeURIComponent(filename); } catch { /* Keep the literal name when malformed. */ }
  return decoded.toLocaleLowerCase().replace(/ \(\d+\)(?=\.[^.]+$)/, "");
}

export interface R2ObjectStoreOptions { endpoint: string; token?: string; fetch?: typeof globalThis.fetch; urlForKey?: (key: string) => string }
export class R2ObjectStore implements ObjectStore {
  private readonly options: R2ObjectStoreOptions; private readonly fetchImpl: typeof globalThis.fetch;
  constructor(options: R2ObjectStoreOptions) { new URL(options.endpoint); this.options = options; this.fetchImpl = options.fetch ?? globalThis.fetch; if (!this.fetchImpl) throw new Error('A fetch implementation is required'); }
  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array) {
    if (!key || key.startsWith('/') || key.split('/').includes('..')) throw new Error('Unsafe object key');
    const base = this.options.urlForKey ? this.options.urlForKey(key) : `${this.options.endpoint.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const headers: Record<string, string> = {}; if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const response = await this.fetchImpl(base, { method: 'PUT', headers, body: body as BodyInit });
    if (!response.ok) throw new Error(`Object store PUT failed (${response.status})`);
    return { key, etag: response.headers.get('etag') ?? undefined };
  }
}

/** Cloudflare R2's native S3-compatible adapter. Uses access-key credentials and keeps keys workspace-scoped. */
export class S3R2ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly options: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }) {
    new URL(options.endpoint);
    this.client = new S3Client({ endpoint: options.endpoint, region: options.region ?? 'auto', credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
  }
  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array) {
    if (!key || key.startsWith('/') || key.split('/').includes('..')) throw new Error('Unsafe object key');
    const payload = body instanceof Uint8Array ? body : body as unknown as ReadableStream<Uint8Array>;
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: payload as any }));
    return { key, etag: result.ETag };
  }
  async getReadUrl(key: string) {
    if (!key || key.startsWith('/') || key.split('/').includes('..')) throw new Error('Unsafe object key');
    // The URL contains only a short-lived signature, never the R2 secret key.
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { expiresIn: 900 });
  }
}

export interface ClickHousePublisherOptions {
  config: ClickHouseConfig;
  table?: string;
  fetch?: typeof globalThis.fetch;
  sourceUrlForKey?: (key: string) => Promise<string>;
}
export class ClickHousePublisher implements ClickHouseLoader {
  private readonly options: ClickHousePublisherOptions; private readonly fetchImpl: typeof globalThis.fetch;
  constructor(options: ClickHousePublisherOptions) { this.options = options; this.fetchImpl = options.fetch ?? options.config.fetch ?? globalThis.fetch; if (!this.fetchImpl) throw new Error('A fetch implementation is required'); }
  needsContents(files: ManifestFile[]) {
    // JSON arrays need the existing in-memory parser. JSONEachRow/NDJSON and
    // self-describing Parquet are safely handled by ClickHouse itself.
    return !this.options.sourceUrlForKey || files.some(file => file.path.toLowerCase().endsWith('.json'));
  }
  async publish(input: { workspaceId: string; importId: string; sourceKeys: string[]; files: ManifestFile[]; contents?: Uint8Array[] }) {
    if (this.options.sourceUrlForKey && !this.needsContents(input.files)) return this.publishFromObjectStore(input);
    if (input.contents?.length) return this.publishDatasets({ ...input, contents: input.contents });
    const table = this.options.table ?? 'ingestion_files';
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table)) throw new Error('Unsafe ClickHouse table identifier');
    const rows = input.files.map((file, i) => ({ workspace_id: input.workspaceId, import_id: input.importId, source_key: input.sourceKeys[i], path: file.path, size_bytes: file.sizeBytes, etag: file.etag ?? null }));
    const params = new URLSearchParams({ query: `INSERT INTO ${table} FORMAT JSONEachRow` }); if (this.options.config.database) params.set('database', this.options.config.database);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-ndjson', ...(this.options.config.headers ?? {}) }; if (this.options.config.username) headers['X-ClickHouse-User'] = this.options.config.username; if (this.options.config.password) headers['X-ClickHouse-Key'] = this.options.config.password;
    const response = await this.fetchImpl(`${this.options.config.url.replace(/\/$/, '')}/?${params}`, { method: 'POST', headers, body: rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '') });
    if (!response.ok) throw new Error(`ClickHouse publish failed (${response.status}): ${await response.text()}`);
    return { tableIds: [table], rowCount: rows.length };
  }

  private async publishDatasets(input: { workspaceId: string; importId: string; sourceKeys: string[]; files: ManifestFile[]; contents: Uint8Array[] }) {
    const tableIds: string[] = [];
    let totalRows = 0;
    for (let index = 0; index < input.files.length; index++) {
      const file = input.files[index];
      const content = input.contents[index];
      const rows = parseTabular(content, file.path);
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const table = `${this.options.table ?? 'dataset'}_${normalizeIdentifier(input.importId).replace(/-/g, '_')}_${index}`;
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table)) throw new Error('Unsafe ClickHouse table identifier');
      const definitions = columns.map(column => `${quoteIdentifier(column)} Nullable(String)`).join(', ');
      await this.execute(`CREATE TABLE IF NOT EXISTS ${table} (${definitions}) ENGINE = MergeTree ORDER BY tuple()`);
      const payload = rows.map(row => JSON.stringify(Object.fromEntries(columns.map(column => [column, row[column] == null ? null : String(row[column])]))) ).join('\n') + '\n';
      await this.execute(`INSERT INTO ${table} FORMAT JSONEachRow`, payload, 'application/x-ndjson');
      tableIds.push(table); totalRows += rows.length;
    }
    return { tableIds, rowCount: totalRows };
  }

  private async publishFromObjectStore(input: { workspaceId: string; importId: string; sourceKeys: string[]; files: ManifestFile[] }) {
    const tableIds: string[] = [];
    let totalRows = 0;
    for (let index = 0; index < input.files.length; index++) {
      const file = input.files[index];
      const sourceKey = input.sourceKeys[index];
      if (!sourceKey) throw new Error(`Missing object-store key for ${file.path}`);
      const table = `${this.options.table ?? 'dataset'}_${normalizeIdentifier(input.importId).replace(/-/g, '_')}_${index}`;
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table)) throw new Error('Unsafe ClickHouse table identifier');
      const format = clickHouseFormatForPath(file.path);
      const sourceUrl = await this.options.sourceUrlForKey!(sourceKey);
      const source = `url(${quoteString(sourceUrl)}, ${quoteString(format)})`;
      // Import IDs are immutable and task retries are serial. Recreate this
      // unique table so a retry cannot append a duplicate partial import.
      await this.execute(`DROP TABLE IF EXISTS ${table}`);
      await this.execute(`CREATE TABLE ${table} ENGINE = MergeTree ORDER BY tuple() EMPTY AS SELECT * FROM ${source}`);
      await this.execute(`INSERT INTO ${table} SELECT * FROM ${source}`);
      const count = Number((await this.execute(`SELECT count() FROM ${table}`)).trim());
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Could not determine ClickHouse row count for ${file.path}`);
      tableIds.push(table);
      totalRows += count;
    }
    return { tableIds, rowCount: totalRows };
  }

  private async execute(query: string, body?: string, contentType = 'text/plain') {
    const params = new URLSearchParams({ query });
    if (this.options.config.database) params.set('database', this.options.config.database);
    const headers: Record<string, string> = { 'Content-Type': contentType, ...(this.options.config.headers ?? {}) };
    if (this.options.config.username) headers['X-ClickHouse-User'] = this.options.config.username;
    if (this.options.config.password) headers['X-ClickHouse-Key'] = this.options.config.password;
    const response = await this.fetchImpl(`${this.options.config.url.replace(/\/$/, '')}/?${params}`, { method: 'POST', headers, body });
    const responseBody = await response.text();
    if (!response.ok) throw new Error(`ClickHouse query failed (${response.status}): ${responseBody}`);
    return responseBody;
  }
}

function quoteIdentifier(value: string) { return `\`${value.replace(/`/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^\d/, '_$&') || 'column'}\``; }
function quoteString(value: string) { return `'${value.replace(/'/g, "\\'")}'`; }
function clickHouseFormatForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) return 'CSVWithNames';
  if (lower.endsWith('.tsv')) return 'TSVWithNames';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'JSONEachRow';
  if (lower.endsWith('.parquet')) return 'Parquet';
  throw new Error(`ClickHouse object-store import does not support ${path}`);
}
function parseTabular(bytes: Uint8Array, path: string): Array<Record<string, unknown>> {
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (['.jsonl', '.ndjson'].includes(ext)) return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (ext === '.json') { const value = JSON.parse(text); return Array.isArray(value) ? value : [value]; }
  if (ext === '.parquet') throw new Error('Parquet requires a ClickHouse S3 table function; configure an object-store URL for this source');
  const delimiter = ext === '.tsv' ? '\t' : ',';
  const records = parseDelimited(text, delimiter);
  const headers = (records.shift() ?? []).map((header, index) => String(header || `column_${index + 1}`));
  return records.map(record => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? null])));
}
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) { const char = text[index]; const next = text[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && next === '\n') index++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(values => values.some(value => value.length));
}
