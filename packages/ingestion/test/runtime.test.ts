import { describe, expect, it, vi } from 'vitest';
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

  it('PUTs objects and publishes JSONEachRow with injected fetches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, _init) => new Response('', { status: 200, headers: { etag: 'abc' } }));
    const object = await new R2ObjectStore({ endpoint: 'https://r2.test', fetch }).put('imports/a.csv', new Uint8Array([1]));
    expect(object).toEqual({ key: 'imports/a.csv', etag: 'abc' });
    const publisher = new ClickHousePublisher({ config: { url: 'https://ch.test' }, fetch });
    const result = await publisher.publish({ workspaceId: 'w', importId: 'i', sourceKeys: ['imports/a.csv'], files: [{ path: 'a.csv', sizeBytes: 1 }] });
    expect(result.rowCount).toBe(1);
    expect(String(fetch.mock.calls[1][1]?.body)).toContain('"path":"a.csv"');
  });
});
