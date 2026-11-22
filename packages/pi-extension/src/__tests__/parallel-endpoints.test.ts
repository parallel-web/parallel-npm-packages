import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runParallelExtract, runParallelSearch } from '../parallel-client.js';
import { runParallelResearch } from '../parallel-responses.js';

const researchResult = {
  status: 'completed',
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'Proxy research answer.' }],
    },
  ],
};

beforeEach(() => {
  vi.stubEnv('PARALLEL_BASE_URL', '');
  delete process.env.PARALLEL_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Pi API endpoint configuration', () => {
  it.each(['/parallel', '/parallel/'])(
    'routes all three tools through a proxy with base path %s',
    async (path) => {
      const requests: {
        path: string | undefined;
        authorization: string | undefined;
        apiKey: string | string[] | undefined;
      }[] = [];
      const server = createServer((request, response) => {
        requests.push({
          path: request.url,
          authorization: request.headers.authorization,
          apiKey: request.headers['x-api-key'],
        });
        request.resume();
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            request.url?.endsWith('/responses')
              ? researchResult
              : { results: [], warnings: null, usage: [] }
          )
        );
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected a loopback TCP server.');
        }
        vi.stubEnv(
          'PARALLEL_BASE_URL',
          `http://127.0.0.1:${address.port}${path}`
        );
        await runParallelSearch('proxy-managed', {
          objective: 'Find Parallel documentation',
          search_queries: ['Parallel documentation'],
        });
        await runParallelExtract('proxy-managed', {
          urls: ['https://example.com'],
        });
        const result = await runParallelResearch('proxy-managed', {
          query: 'What is Parallel?',
        });

        expect(result.text).toBe('Proxy research answer.');
        expect(requests).toEqual(
          ['search', 'extract', 'responses'].map((endpoint) => ({
            path: `/parallel/v1/${endpoint}`,
            authorization:
              endpoint === 'responses' ? 'Bearer proxy-managed' : undefined,
            apiKey: endpoint === 'responses' ? undefined : 'proxy-managed',
          }))
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    }
  );

  it.each([undefined, '', '   '])(
    'uses the default Research endpoint for an unset or blank base: %j',
    async (baseURL) => {
      if (baseURL !== undefined) vi.stubEnv('PARALLEL_BASE_URL', baseURL);
      const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        Response.json(researchResult)
      );
      vi.stubGlobal('fetch', fetchMock);

      await runParallelResearch('test-key', { query: 'What is Parallel?' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.parallel.ai/v1/responses',
        expect.objectContaining({ redirect: 'error' })
      );
    }
  );

  it('reads the base for each Research request after the module was imported', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json(researchResult)
    );
    vi.stubGlobal('fetch', fetchMock);

    for (const base of [
      'https://first.example/proxy/',
      'https://second.example',
    ]) {
      vi.stubEnv('PARALLEL_BASE_URL', base);
      await runParallelResearch('test-key', { query: 'What is Parallel?' });
    }

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://first.example/proxy/v1/responses',
      'https://second.example/v1/responses',
    ]);
  });
});
