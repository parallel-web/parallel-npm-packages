import { afterEach, describe, expect, it, vi } from 'vitest';
import { runParallelSearch } from '../parallel-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runParallelSearch', () => {
  it('uses fast mode for interactive Pi searches', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            search_id: 'search_test',
            results: [],
            warnings: null,
            usage: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await runParallelSearch('test-key', {
      objective: 'Find current Parallel Search documentation',
      search_queries: ['Parallel Search modes'],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.parallel.ai/v1/search');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      objective: 'Find current Parallel Search documentation',
      search_queries: ['Parallel Search modes'],
      mode: 'fast',
    });
  });
});
