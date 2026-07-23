import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KaggleCliGateway, R2ObjectStore, ClickHousePublisher } from '../src/runtime';

describe('runtime ingestion adapters', () => {
  it('uses fixed Kaggle CLI arguments and downloads a selected file', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === 'files') return { stdout: JSON.stringify([{ name: 'data.csv', size: 3 }]), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    // Listing is independently testable; download behavior is exercised by real CLI in deployments.
    const gateway = new KaggleCliGateway({ execFile: exec });
    const listed = await gateway.list({ owner: 'acme', slug: 'demo', version: 2, canonicalRef: 'acme/demo/versions/2' });
    expect(calls[0]).toEqual(['datasets', 'files', '-d', 'acme/demo/versions/2', '--format', 'json']);
    expect(listed.files[0].path).toBe('data.csv');
  });

  it('invokes Kaggle as a module when the configured Python executable is absolute', async () => {
    const exec = vi.fn(async (_bin: string, args: readonly string[]) => ({
      stdout: JSON.stringify([{ name: 'data.csv', size: 3 }]), stderr: ''
    }));
    const gateway = new KaggleCliGateway({ executable: '/opt/venv/bin/python', execFile: exec });
    await gateway.list({ owner: 'acme', slug: 'demo', canonicalRef: 'acme/demo' });
    expect(exec).toHaveBeenCalledWith('/opt/venv/bin/python', ['-m', 'kaggle', 'datasets', 'files', '-d', 'acme/demo', '--format', 'json']);
  });

  it('accepts a uniquely normalized percent-encoded filename after the Kaggle CLI unzips it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kaggle-gateway-test-'));
    try {
      const exec = vi.fn(async (_bin: string, args: readonly string[]) => {
        if (args.includes('files')) return { stdout: JSON.stringify([{ name: 'Top_rated_movies (1).csv', size: 5 }]), stderr: '' };
        const outputDir = args[args.indexOf('-p') + 1];
        await writeFile(join(outputDir, 'Top_rated_movies%20(1).csv'), 'id\n1\n');
        return { stdout: '', stderr: '' };
      });
      const gateway = new KaggleCliGateway({ execFile: exec, tempDir });
      const [file] = (await gateway.list({ owner: 'acme', slug: 'demo', canonicalRef: 'acme/demo' })).files;
      expect(new TextDecoder().decode(await file.download())).toBe('id\n1\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the only downloaded file when the Kaggle CLI changes its filename', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kaggle-gateway-test-'));
    try {
      const exec = vi.fn(async (_bin: string, args: readonly string[]) => {
        if (args.includes('files')) return { stdout: JSON.stringify([{ name: 'Top_rated_movies (1).csv', size: 5 }]), stderr: '' };
        const outputDir = args[args.indexOf('-p') + 1];
        await writeFile(join(outputDir, 'kaggle-download.csv'), 'id\n1\n');
        return { stdout: '', stderr: '' };
      });
      const gateway = new KaggleCliGateway({ execFile: exec, tempDir });
      const [file] = (await gateway.list({ owner: 'acme', slug: 'demo', canonicalRef: 'acme/demo' })).files;
      expect(new TextDecoder().decode(await file.download())).toBe('id\n1\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('PUTs objects and publishes JSONEachRow with injected fetches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, _init) => new Response('', { status: 200, headers: { etag: 'abc' } }));
    const object = await new R2ObjectStore({ endpoint: 'https://r2.test', fetch }).put('imports/a.csv', new Uint8Array([1]));
    expect(object).toEqual({ key: 'imports/a.csv', etag: 'abc' });
    const publisher = new ClickHousePublisher({ config: { url: 'https://ch.test' }, fetch });
    const result = await publisher.publish({ workspaceId: 'w', importId: 'i', sourceKeys: ['imports/a.csv'], files: [{ path: 'a.csv', sizeBytes: 1 }] });
    expect(result.rowCount).toBe(1);
    expect(String(fetch.mock.calls[1][1]?.body)).toContain('"path":"a.csv"');
  });

  it('lets ClickHouse import typed CSV directly from a short-lived object URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const query = new URL(String(url)).searchParams.get('query') ?? '';
      return new Response(query.startsWith('SELECT count()') ? '3\n' : '', { status: 200 });
    });
    const publisher = new ClickHousePublisher({
      config: { url: 'https://ch.test' },
      fetch,
      sourceUrlForKey: async () => 'https://r2.test/signed.csv?expires=soon',
    });
    const result = await publisher.publish({ workspaceId: 'w', importId: 'i', sourceKeys: ['imports/a.csv'], files: [{ path: 'a.csv', sizeBytes: 3 }] });
    expect(publisher.needsContents([{ path: 'a.csv', sizeBytes: 3 }])).toBe(false);
    expect(result).toEqual({ tableIds: ['dataset_i_0'], rowCount: 3 });
    const queries = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('query'));
    expect(queries.some((query) => query?.includes("CSVWithNames"))).toBe(true);
  });
});
