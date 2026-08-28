import { APIConnectionTimeoutError, APIUserAbortError } from 'parallel-web';
import { errorChain } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CHARS_TOTAL,
  ParallelSearchProvider,
  buildSearchBody,
  mapParallelResponse,
  type SearchClient,
  type ParallelSearchProviderOptions,
} from '../src/provider.ts';

const baseOptions: ParallelSearchProviderOptions = {
  apiKey: 'parallel_test_provider',
  maxCharsTotal: DEFAULT_MAX_CHARS_TOTAL,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function providerWithSearch(
  search: SearchClient['search'],
  options: Partial<ParallelSearchProviderOptions> = {}
) {
  const factory = vi.fn((): SearchClient => ({ search }));
  return {
    provider: new ParallelSearchProvider(
      { ...baseOptions, ...options },
      factory
    ),
    factory,
  };
}

describe('Parallel request mapping', () => {
  it('maps one DSH query and result bound to the exact V1 shape', () => {
    expect(
      buildSearchBody(
        { query: 'unchanged query', maxResults: 8 },
        { mode: 'turbo', maxCharsTotal: 25_000, maxCharsPerResult: 2_000 }
      )
    ).toEqual({
      objective: 'unchanged query',
      search_queries: ['unchanged query'],
      mode: 'turbo',
      max_chars_total: 25_000,
      advanced_settings: {
        max_results: 8,
        excerpt_settings: { max_chars_per_result: 2_000 },
      },
    });
  });

  it('omits mode and empty nested settings', () => {
    expect(
      buildSearchBody(
        { query: '  preserved whitespace  ' },
        { maxCharsTotal: 25_000 }
      )
    ).toEqual({
      objective: '  preserved whitespace  ',
      search_queries: ['  preserved whitespace  '],
      max_chars_total: 25_000,
    });
  });

  it('passes exact SDK request options', async () => {
    const search = vi.fn().mockResolvedValue({ results: [] });
    const { provider } = providerWithSearch(search);
    const controller = new AbortController();
    await provider.search({ query: 'q', maxResults: 3 }, controller.signal);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[1]).toEqual({
      signal: controller.signal,
      maxRetries: 0,
      timeout: 60_000,
      fetchOptions: { redirect: 'error' },
    });
  });
});

describe('Parallel response mapping', () => {
  it('preserves order and maps complete citation fields', () => {
    expect(
      mapParallelResponse({
        results: [
          {
            url: 'https://a.test',
            title: 'A',
            excerpts: ['first', ' ', 'second'],
            publish_date: '2026-08-14',
          },
          { url: 'https://b.test', title: null, excerpts: [] },
        ],
      })
    ).toEqual({
      sources: [
        {
          url: 'https://a.test',
          title: 'A',
          snippet: 'first\n\nsecond',
          publishedAt: '2026-08-14',
        },
        { url: 'https://b.test' },
      ],
      truncated: false,
    });
  });

  it('omits blank optional fields without inventing content', () => {
    const result = mapParallelResponse({
      results: [
        {
          url: 'https://a.test',
          title: '  ',
          excerpts: ['  '],
          publish_date: '',
        },
      ],
    });
    expect(result).toEqual({
      sources: [{ url: 'https://a.test' }],
      truncated: false,
    });
    expect('content' in result).toBe(false);
  });

  it.each([
    {},
    { results: {} },
    { results: [null] },
    { results: [{ url: '', excerpts: [] }] },
    { results: [{ url: 42, excerpts: [] }] },
    { results: [{ url: 'https://a.test', excerpts: null }] },
    { results: [{ url: 'https://a.test', excerpts: [42] }] },
    { results: [{ url: 'https://a.test', excerpts: [], title: 42 }] },
    { results: [{ url: 'https://a.test', excerpts: [], publish_date: false }] },
  ])('rejects malformed response %#', (payload) => {
    expect(() => mapParallelResponse(payload)).toThrow(TypeError);
  });
});

describe('free Parallel MCP search', () => {
  it.each([
    { maxCharsTotal: 4, snippets: ['abcd', undefined] },
    { maxCharsTotal: 9, maxCharsPerResult: 6, snippets: ['abcd\n\n', 'ijk'] },
    { maxCharsTotal: 12, snippets: ['abcd\n\nefgh', 'ij'] },
    { maxCharsTotal: 30, snippets: ['abcd\n\nefgh', 'ijklmnop'] },
  ])(
    'bounds normalized excerpts with $maxCharsTotal total characters',
    async ({ snippets, ...limits }) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              structuredContent: {
                results: [
                  { url: 'https://empty.test', excerpts: [] },
                  {
                    url: 'https://a.test',
                    title: 'A',
                    excerpts: ['abcd', 'efgh'],
                  },
                  { url: 'https://b.test', excerpts: ['ijklmnop'] },
                ],
              },
            },
          })
        )
      );
      const provider = new ParallelSearchProvider({ apiKey: '', ...limits });

      await expect(provider.search({ query: 'q' })).resolves.toEqual({
        sources: [
          { url: 'https://empty.test' },
          { url: 'https://a.test', title: 'A', snippet: snippets[0] },
          {
            url: 'https://b.test',
            ...(snippets[1] === undefined ? {} : { snippet: snippets[1] }),
          },
        ],
        truncated: false,
      });
    }
  );

  it('searches without credentials and reuses one session across free searches', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              structuredContent: {
                results: [
                  {
                    url: 'https://example.test',
                    title: 'Example',
                    excerpts: ['Useful excerpt'],
                  },
                ],
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    );
    const clientFactory = vi.fn();
    const provider = new ParallelSearchProvider(
      { ...baseOptions, apiKey: '' },
      clientFactory
    );

    await expect(provider.search({ query: 'first query' })).resolves.toEqual({
      sources: [
        {
          url: 'https://example.test',
          title: 'Example',
          snippet: 'Useful excerpt',
        },
      ],
      truncated: false,
    });
    await provider.search({ query: 'second query' });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://search.parallel.ai/mcp');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
    });
    expect(options?.headers).not.toHaveProperty('Authorization');
    expect(options?.headers).not.toHaveProperty('x-api-key');

    const firstBody = JSON.parse(options?.body as string);
    const secondBody = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string);
    expect(firstBody).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search',
        arguments: {
          objective: 'first query',
          search_queries: ['first query'],
          session_id: expect.any(String),
        },
      },
    });
    expect(secondBody.params.arguments.session_id).toBe(
      firstBody.params.arguments.session_id
    );
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('maps free MCP HTTP failures to WEB_PROVIDER_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 })
    );
    const provider = new ParallelSearchProvider({
      ...baseOptions,
      apiKey: '',
    });

    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      cause: { message: expect.stringContaining('429') },
    });
  });

  it('maps free MCP JSON-RPC failures to WEB_PROVIDER_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32603, message: 'Search temporarily unavailable' },
        })
      )
    );
    const provider = new ParallelSearchProvider({
      ...baseOptions,
      apiKey: '',
    });

    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      cause: { message: 'Search temporarily unavailable' },
    });
  });

  it('maps free MCP caller aborts to WEB_ABORTED', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();
      throw new Error('transport stopped');
    });
    const provider = new ParallelSearchProvider({
      ...baseOptions,
      apiKey: '',
    });

    await expect(
      provider.search({ query: 'q' }, controller.signal)
    ).rejects.toMatchObject({ code: 'WEB_ABORTED' });
  });
});

describe('Parallel provider availability and errors', () => {
  it('is available with or without a key when locked options are valid', () => {
    expect(new ParallelSearchProvider(baseOptions).available()).toBe(true);
    expect(
      new ParallelSearchProvider({ ...baseOptions, apiKey: '' }).available()
    ).toBe(true);
    expect(
      new ParallelSearchProvider({
        ...baseOptions,
        maxCharsTotal: 0,
      }).available()
    ).toBe(false);
    expect(
      new ParallelSearchProvider({
        ...baseOptions,
        maxCharsPerResult: 1.5,
      }).available()
    ).toBe(false);
  });

  it('rejects a pre-aborted request without constructing a client', async () => {
    const search = vi.fn();
    const { provider, factory } = providerWithSearch(search);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.search({ query: 'q' }, controller.signal)
    ).rejects.toMatchObject({ code: 'WEB_ABORTED' });
    expect(factory).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('maps the SDK user-abort class to WEB_ABORTED', async () => {
    const { provider } = providerWithSearch(
      vi.fn().mockRejectedValue(new APIUserAbortError())
    );
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_ABORTED',
    });
  });

  it('maps an in-flight caller abort to WEB_ABORTED', async () => {
    const controller = new AbortController();
    const search = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('transport stopped')),
            { once: true }
          );
        })
    );
    const { provider } = providerWithSearch(search);
    const pending = provider.search({ query: 'q' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' });
  });

  it('maps an SDK timeout to WEB_PROVIDER_ERROR', async () => {
    const timeout = new APIConnectionTimeoutError();
    const { provider } = providerWithSearch(vi.fn().mockRejectedValue(timeout));
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      cause: { message: timeout.message },
    });
  });

  it.each([401, 403, 422, 429, 500, 503])(
    'maps HTTP %i to WEB_PROVIDER_ERROR',
    async (status) => {
      const error = Object.assign(new Error(`HTTP ${status}`), { status });
      const { provider } = providerWithSearch(vi.fn().mockRejectedValue(error));
      await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
      });
    }
  );

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    const networkError = new TypeError('connection refused');
    const { provider } = providerWithSearch(
      vi.fn().mockRejectedValue(networkError)
    );
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      cause: { message: networkError.message },
    });
  });

  it('redacts the key from the complete Harness diagnostic chain', async () => {
    const key = 'parallel_test_must_not_leak';
    const transportError = new Error(`bad ${key}`, {
      cause: new Error(`nested ${key}`),
    });
    const { provider } = providerWithSearch(
      vi.fn().mockRejectedValue(transportError),
      { apiKey: key }
    );
    let caught: unknown;
    try {
      await provider.search({ query: 'q' });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    expect(errorChain(caught)).toBe(
      'Parallel search request failed: bad [REDACTED]'
    );
    expect(errorChain(caught)).not.toContain(key);
    expect((caught as Error).cause).not.toBe(transportError);
  });

  it('wraps malformed success data as WEB_PROVIDER_ERROR', async () => {
    const { provider } = providerWithSearch(
      vi.fn().mockResolvedValue({ results: {} })
    );
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    });
  });
});
