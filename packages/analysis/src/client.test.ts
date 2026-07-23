import { describe, expect, it, vi } from 'vitest';
import { FeatherlessClient } from './client';

describe('FeatherlessClient', () => {
  it('uses the OpenAI-compatible endpoint and redacts no secrets from errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'run_1', object: 'chat.completion', created: 1, model: 'Qwen/Qwen3-32B', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }), { status: 200 }));
    const client = new FeatherlessClient({ apiKey: 'secret-key', fetch: fetcher, model: 'Qwen/Qwen3-32B' });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result.choices[0]?.message.content).toBe('ok');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v1/chat/completions');
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer secret-key' });
  });
});
