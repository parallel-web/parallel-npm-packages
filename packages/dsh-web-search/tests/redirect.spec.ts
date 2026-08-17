import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import Parallel from 'parallel-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CHARS_TOTAL,
  ParallelSearchProvider,
} from '../src/provider.ts';

const apiKey = 'parallel_test_redirect';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null)
        resolve(address.port);
      else reject(new Error('server did not bind a TCP port'));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
}

describe('production origin and redirect isolation', () => {
  it('ignores PARALLEL_BASE_URL and carries redirect rejection into fetch', async () => {
    const previous = process.env.PARALLEL_BASE_URL;
    process.env.PARALLEL_BASE_URL = 'https://attacker.test';
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [],
        search_id: 'search_test',
        session_id: 'session_test',
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new ParallelSearchProvider({
        apiKey,
        maxCharsTotal: DEFAULT_MAX_CHARS_TOTAL,
      });
      await provider.search({ query: 'q', maxResults: 1 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [input, init] = fetchMock.mock.calls[0] as unknown as [
        RequestInfo | URL,
        RequestInit,
      ];
      expect(String(input)).toBe('https://api.parallel.ai/v1/search');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('x-api-key')).toBe(apiKey);
    } finally {
      if (previous === undefined) delete process.env.PARALLEL_BASE_URL;
      else process.env.PARALLEL_BASE_URL = previous;
    }
  });

  it('does not contact or forward credentials to a redirect target', async () => {
    let firstCount = 0;
    let secondCount = 0;
    let firstHeaders: IncomingHttpHeaders = {};
    let secondHeaders: IncomingHttpHeaders = {};

    const second = createServer((request, response) => {
      secondCount += 1;
      secondHeaders = request.headers;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ results: [], search_id: 's', session_id: 's' })
      );
    });
    const secondPort = await listen(second);
    const first = createServer((request, response) => {
      firstCount += 1;
      firstHeaders = request.headers;
      response.writeHead(302, {
        location: `http://127.0.0.1:${secondPort}/stolen`,
      });
      response.end();
    });
    const firstPort = await listen(first);

    try {
      const provider = new ParallelSearchProvider(
        { apiKey, maxCharsTotal: DEFAULT_MAX_CHARS_TOTAL },
        (key) =>
          new Parallel({
            apiKey: key,
            baseURL: `http://127.0.0.1:${firstPort}`,
          })
      );
      await expect(
        provider.search({ query: 'q', maxResults: 1 })
      ).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
      expect(firstCount).toBe(1);
      expect(firstHeaders['x-api-key']).toBe(apiKey);
      expect(secondCount).toBe(0);
      expect(secondHeaders['x-api-key']).toBeUndefined();
    } finally {
      await Promise.all([close(first), close(second)]);
    }
  });
});
