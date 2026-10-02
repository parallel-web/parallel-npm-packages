import { afterEach, describe, expect, it, vi } from 'vitest';
import Parallel from 'parallel-web';
import { parallelSearchTool } from './index.js';
import { fetchCall, mockFetch, searchResponse } from './test-utils.js';

const sources = [
  {
    url: 'https://example.com',
    title: null,
    publish_date: null,
    excerpts: ['Evidence.'],
  },
];

function fixture() {
  const fetch = mockFetch(searchResponse(sources));
  const client = new Parallel({ apiKey: 'fixture-key', fetch, maxRetries: 0 });
  return { fetch, client };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parallelSearchTool', () => {
  it('sends validated input through the SDK with authentication and attribution', async () => {
    const { fetch, client } = fixture();
    const tool = parallelSearchTool({ client });
    const output = await tool.execute!({
      query: '  current research  ',
      objective: '  Find evidence.  ',
    });
    const request = fetchCall(fetch);
    expect(request.url).toBe('https://api.parallel.ai/v1/search');
    expect(request.body).toEqual({
      search_queries: ['current research'],
      objective: 'Find evidence.',
      mode: 'advanced',
      advanced_settings: { max_results: 10 },
    });
    const headers = new Headers(request.init.headers);
    expect(headers.get('x-api-key')).toBe('fixture-key');
    expect(headers.get('x-tool-calling-package')).toBe(
      'npm:@parallel-web/tanstack-ai/v0.1.0-rc.0'
    );
    expect(tool.__toolSide).toBe('server');
    expect(tool.outputSchema.parse(output)).toEqual({ results: sources });
  });

  it.each([undefined, '', '   '])(
    'omits an empty objective (%j)',
    async (objective) => {
      const { fetch, client } = fixture();
      await parallelSearchTool({ client }).execute!({
        query: 'research',
        objective,
      });
      expect(fetchCall(fetch).body).not.toHaveProperty('objective');
    }
  );

  it.each([
    [undefined, 5],
    [2, 2],
    [40, 5],
  ])(
    'caps model result limit %j at the application limit',
    async (requested, expected) => {
      const { fetch, client } = fixture();
      const sourcePolicy = { include_domains: ['example.com'] };
      await parallelSearchTool({
        client,
        maxResults: 5,
        mode: 'fast',
        sourcePolicy,
        sessionId: 'shared-session',
      }).execute!({ query: 'research', max_results: requested });
      expect(fetchCall(fetch).body).toMatchObject({
        mode: 'fast',
        session_id: 'shared-session',
        advanced_settings: {
          max_results: expected,
          source_policy: sourcePolicy,
        },
      });
    }
  );

  it.each([
    { query: '   ' },
    { query: 'q'.repeat(201) },
    { query: 'research', objective: 'x'.repeat(5001) },
    { query: 'research', max_results: 0 },
    { query: 'research', max_results: 1.5 },
    { query: 'research', max_results: 41 },
  ])(
    'rejects invalid model input before sending a request: %j',
    async (input) => {
      const { fetch, client } = fixture();
      await expect(
        parallelSearchTool({ client }).execute!(input)
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 1.5, 41, NaN, Infinity])(
    'rejects invalid application limit %j',
    (maxResults) => {
      const { client } = fixture();
      expect(() => parallelSearchTool({ client, maxResults })).toThrow();
    }
  );

  it('reads credentials from the environment and allows an explicit override', async () => {
    vi.stubEnv('PARALLEL_API_KEY', 'environment-fixture-key');
    const fetch = mockFetch(searchResponse());
    vi.stubGlobal('fetch', fetch);
    try {
      await parallelSearchTool().execute!({ query: 'research' });
      await parallelSearchTool({ apiKey: 'explicit-fixture-key' }).execute!({
        query: 'research',
      });
      expect(
        new Headers(fetchCall(fetch, 0).init.headers).get('x-api-key')
      ).toBe('environment-fixture-key');
      expect(
        new Headers(fetchCall(fetch, 1).init.headers).get('x-api-key')
      ).toBe('explicit-fixture-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails when credentials are missing', () => {
    vi.stubEnv('PARALLEL_API_KEY', '');
    delete process.env.PARALLEL_API_KEY;
    expect(() => parallelSearchTool()).toThrow();
  });

  it('does not send a request when already aborted', async () => {
    const { fetch, client } = fixture();
    const abortSignal = AbortSignal.abort();
    await expect(
      parallelSearchTool({ client }).execute!(
        { query: 'research' },
        { abortSignal, emitCustomEvent: vi.fn() }
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels an in-flight SDK request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        throw new DOMException('Aborted', 'AbortError');
      }
    );
    const client = new Parallel({
      apiKey: 'fixture-key',
      fetch,
      maxRetries: 0,
    });
    await expect(
      parallelSearchTool({ client }).execute!(
        { query: 'research' },
        { abortSignal: controller.signal, emitCustomEvent: vi.fn() }
      )
    ).rejects.toBeInstanceOf(Parallel.APIUserAbortError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates SDK errors without converting failures into empty results', async () => {
    const fetch = mockFetch(
      { error: { message: 'Forbidden' } },
      403,
      'Forbidden'
    );
    const client = new Parallel({
      apiKey: 'fixture-key',
      fetch,
      maxRetries: 0,
    });
    await expect(
      parallelSearchTool({ client }).execute!({ query: 'research' })
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
