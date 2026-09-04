import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  toJsonSchema,
  type JsonSchema7ObjectType,
} from '@langchain/core/utils/json_schema';
import Parallel, { type APIError, type ClientOptions } from 'parallel-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtractTool, createSearchTool } from './index.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

const searchResponse: Parallel.SearchResult = {
  search_id: 'search_fixture',
  session_id: 'session_fixture',
  results: [
    {
      url: 'https://docs.example.com/search',
      title: 'Search API',
      publish_date: '2026-08-25',
      excerpts: ['Search returns relevant sources.', 'Each source has a URL.'],
    },
    {
      url: 'http://example.org/guide',
      title: null,
      publish_date: null,
      excerpts: ['A second source.'],
    },
  ],
  warnings: [
    {
      type: 'warning',
      message: 'Some sources could not be refreshed.',
      detail: { cached_sources: 1 },
    },
  ],
  usage: [{ name: 'search_advanced', count: 1 }],
};

const extractResponse: Parallel.ExtractResponse = {
  extract_id: 'extract_fixture',
  session_id: 'session_fixture',
  results: [
    {
      url: 'https://docs.example.com/search',
      title: 'Search API',
      publish_date: '2026-08-25',
      excerpts: ['An objective-focused excerpt.'],
      full_content: 'The complete source, including additional details.',
    },
  ],
  errors: [
    {
      url: 'https://example.org/missing',
      error_type: 'http_error',
      http_status_code: 404,
      content: '<html>The requested page was not found.</html>',
    },
  ],
  warnings: [
    {
      type: 'input_validation_warning',
      message: 'One URL could not be extracted.',
      detail: { failed_urls: 1 },
    },
  ],
  usage: [{ name: 'extract', count: 2 }],
};

// Test responses let us exercise the real SDK without calling Parallel.
// The SDK still handles requests, headers, response decoding, retries and errors.
function fixtureClient(
  response: unknown,
  options: ClientOptions = {},
  status = 200
) {
  const requests: Request[] = [];
  const fetch = vi.fn(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit
    ) => {
      requests.push(new Request(input, init));
      return Response.json(response, {
        status,
        headers: { 'x-request-id': 'request_fixture' },
      });
    }
  );
  const client = new Parallel({
    apiKey: 'fixture-api-key',
    baseURL: 'https://parallel.test',
    maxRetries: 0,
    fetch,
    ...options,
  });
  return { client, fetch, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LangChain tool and SDK contracts', () => {
  it('invokes Search as plain text and sends normalized input to the GA API', async () => {
    const { client, requests } = fixtureClient(searchResponse);
    const search = createSearchTool({ client });
    const content = await search.invoke({
      search_queries: ['  parallel search  ', 'source citations'],
      objective: '  Find the API contract.  ',
    });

    expect(typeof content).toBe('string');
    expect(content).toContain(searchResponse.results[0].url);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://parallel.test/v1/search');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.get('x-api-key')).toBe('fixture-api-key');
    expect(requests[0].headers.get('x-tool-calling-package')).toBe(
      `npm:@parallel-web/langchain/v${version}`
    );
    expect(await requests[0].json()).toEqual({
      search_queries: ['parallel search', 'source citations'],
      objective: 'Find the API contract.',
      mode: 'advanced',
      max_chars_total: 20_000,
      advanced_settings: { max_results: 10 },
    });
  });

  it('returns a ToolMessage with the complete Search response as its artifact', async () => {
    const response = { ...searchResponse, future_metadata: { retained: true } };
    const { client } = fixtureClient(response);
    const search = createSearchTool({ client });
    const message = await search.invoke({
      type: 'tool_call',
      id: 'call_search',
      name: search.name,
      args: { search_queries: ['parallel search'], objective: null },
    });

    expect(message).toBeInstanceOf(ToolMessage);
    expect(message.tool_call_id).toBe('call_search');
    expect(message.name).toBe('parallel_web_search');
    expect(message.artifact).toStrictEqual(response);
    const content = String(message.content);
    for (const result of response.results) {
      expect(content).toContain(result.url);
      for (const excerpt of result.excerpts) {
        expect(content).toContain(excerpt);
        expect(content.indexOf(result.url)).toBeLessThan(
          content.indexOf(excerpt)
        );
      }
    }
    expect(content).toContain('2026-08-25');
    expect(content).toContain(searchResponse.warnings![0].message);
  });

  it('keeps developer Search settings out of the model schema and honors the injected client', async () => {
    const { client, requests } = fixtureClient(searchResponse, {
      defaultHeaders: { 'x-caller-setting': 'preserved' },
    });
    const sourcePolicy = {
      include_domains: ['example.com'],
      after_date: '2026-08-01',
    };
    const fetchPolicy = { max_age_seconds: 600, disable_cache_fallback: true };
    const search = createSearchTool({
      client,
      mode: 'fast',
      maxResults: 3,
      maxOutputChars: 2048,
      sessionId: 'session_research',
      sourcePolicy,
      fetchPolicy,
    });
    const schema = toJsonSchema(search.schema) as JsonSchema7ObjectType;
    expect(search.name).toBe('parallel_web_search');
    expect(search).toHaveProperty('responseFormat', 'content_and_artifact');
    expect(schema).toMatchObject({
      type: 'object',
      required: ['search_queries'],
      properties: {
        search_queries: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    });
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'objective',
      'search_queries',
    ]);
    await search.invoke({ search_queries: ['search contracts'] });
    expect(requests[0].headers.get('x-caller-setting')).toBe('preserved');
    expect(await requests[0].json()).toEqual({
      search_queries: ['search contracts'],
      mode: 'fast',
      max_chars_total: 2048,
      session_id: 'session_research',
      advanced_settings: {
        max_results: 3,
        source_policy: sourcePolicy,
        fetch_policy: fetchPolicy,
      },
    });
  });

  it('invokes Extract with a URL-only schema and full content disabled by default', async () => {
    const { client, requests } = fixtureClient(extractResponse);
    const extract = createExtractTool({ client });
    const schema = toJsonSchema(extract.schema) as JsonSchema7ObjectType;
    expect(extract.name).toBe('parallel_extract');
    expect(extract).toHaveProperty('responseFormat', 'content_and_artifact');
    expect(schema).toMatchObject({
      type: 'object',
      required: ['urls'],
      properties: { urls: { type: 'array', minItems: 1, maxItems: 20 } },
    });
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'objective',
      'urls',
    ]);

    const urls = [
      'https://docs.example.com/search',
      'http://example.org/guide',
    ];
    const content = await extract.invoke({ urls, objective: null });
    expect(typeof content).toBe('string');
    expect(content).toContain(extractResponse.results[0].excerpts[0]);
    expect(requests[0].url).toBe('https://parallel.test/v1/extract');
    expect(requests[0].headers.get('x-tool-calling-package')).toBe(
      `npm:@parallel-web/langchain/v${version}`
    );
    expect(await requests[0].json()).toEqual({
      urls,
      objective: null,
      max_chars_total: 20_000,
      advanced_settings: { full_content: false },
    });
  });

  it('preserves Extract full content and partial failures without sending error bodies to the model', async () => {
    const { client, requests } = fixtureClient(extractResponse);
    const fullContent = { max_chars_per_result: 50_000 };
    const fetchPolicy = { max_age_seconds: 600, timeout_seconds: 10 };
    const extract = createExtractTool({
      client,
      fullContent,
      fetchPolicy,
      sessionId: 'session_research',
    });
    const urls = [
      extractResponse.results[0].url,
      extractResponse.errors[0].url,
    ];
    const message = await extract.invoke({
      type: 'tool_call',
      id: 'call_extract',
      name: extract.name,
      args: { urls, objective: '  Read the source.  ' },
    });

    expect(message).toBeInstanceOf(ToolMessage);
    expect(message.tool_call_id).toBe('call_extract');
    expect(message.artifact).toStrictEqual(extractResponse);
    const content = String(message.content);
    expect(content).toContain(urls[0]);
    expect(content.indexOf(urls[0])).toBeLessThan(
      content.indexOf(extractResponse.results[0].excerpts[0])
    );
    expect(content).toContain(urls[1]);
    expect(content).toContain('http_error');
    expect(content).toContain('404');
    expect(content).not.toContain(extractResponse.errors[0].content);
    expect(content).toContain(extractResponse.warnings![0].message);
    expect(await requests[0].json()).toMatchObject({
      urls,
      objective: 'Read the source.',
      session_id: 'session_research',
      advanced_settings: {
        full_content: fullContent,
        fetch_policy: fetchPolicy,
      },
    });
  });

  it('accepts inputs at the documented Search and Extract boundaries', async () => {
    const searchFixture = fixtureClient(searchResponse);
    const searchQueries = Array.from({ length: 5 }, () => 'q'.repeat(200));
    const objective = 'o'.repeat(5000);
    await createSearchTool({ client: searchFixture.client }).invoke({
      search_queries: searchQueries,
      objective,
    });
    expect(await searchFixture.requests[0].json()).toMatchObject({
      search_queries: searchQueries,
      objective,
    });

    const extractFixture = fixtureClient(extractResponse);
    const urls = Array.from(
      { length: 20 },
      (_, i) => `https://example.com/${i}`
    );
    await createExtractTool({ client: extractFixture.client }).invoke({
      urls,
      objective,
    });
    expect(await extractFixture.requests[0].json()).toMatchObject({
      urls,
      objective,
    });
  });
});

describe('validation before dispatch', () => {
  it.each([
    {},
    { search_queries: [] },
    { search_queries: Array(6).fill('query') },
    { search_queries: [' \n\t '] },
    { search_queries: ['q'.repeat(201)] },
    { search_queries: ['query'], objective: '   ' },
    { search_queries: ['query'], objective: 'o'.repeat(5001) },
  ])(
    'rejects invalid Search input %# without an HTTP request',
    async (input) => {
      const { client, fetch } = fixtureClient(searchResponse);
      await expect(
        // An agent can generate input that violates the TypeScript contract.
        // @ts-expect-error Deliberately include missing required fields.
        createSearchTool({ client }).invoke(input)
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    {},
    { urls: [] },
    { urls: Array(21).fill('https://example.com') },
    { urls: ['not a URL'] },
    { urls: ['file:///etc/hosts'] },
    { urls: ['ftp://example.com/file'] },
    { urls: ['https://example.com'], objective: '   ' },
    { urls: ['https://example.com'], objective: 'o'.repeat(5001) },
  ])(
    'rejects invalid Extract input %# without an HTTP request',
    async (input) => {
      const { client, fetch } = fixtureClient(extractResponse);
      await expect(
        // @ts-expect-error Deliberately include missing required fields.
        createExtractTool({ client }).invoke(input)
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([1023, 1024.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the unsafe output limit %s for both tools',
    (maxOutputChars) => {
      const { client, fetch } = fixtureClient(searchResponse);
      for (const factory of [createSearchTool, createExtractTool]) {
        expect(() => factory({ client, maxOutputChars })).toThrow(RangeError);
      }
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([0, 41, 1.5])('rejects the invalid result count %s', (maxResults) => {
    const { client } = fixtureClient(searchResponse);
    expect(() => createSearchTool({ client, maxResults })).toThrow();
  });

  it('rejects ambiguous credentials for JavaScript callers as well as TypeScript callers', () => {
    const { client } = fixtureClient(searchResponse);
    for (const factory of [createSearchTool, createExtractTool]) {
      expect(() =>
        Reflect.apply(factory, undefined, [{ client, apiKey: 'another-key' }])
      ).toThrow(/apiKey.*client/);
    }
  });

  it('uses the SDK configuration error when no API key is available', () => {
    const originalKey = process.env.PARALLEL_API_KEY;
    delete process.env.PARALLEL_API_KEY;
    try {
      for (const factory of [createSearchTool, createExtractTool]) {
        expect(() => factory()).toThrow(Parallel.ParallelError);
        expect(() => factory()).toThrow(/apiKey|PARALLEL_API_KEY/);
      }
    } finally {
      if (originalKey === undefined) delete process.env.PARALLEL_API_KEY;
      else process.env.PARALLEL_API_KEY = originalKey;
    }
  });

  it('uses an explicitly supplied API key with the SDK transport', async () => {
    const { fetch, requests } = fixtureClient(searchResponse);
    vi.stubGlobal('fetch', fetch);
    await createSearchTool({ apiKey: 'explicit-fixture-key' }).invoke({
      search_queries: ['search contract'],
    });
    expect(requests[0].headers.get('x-api-key')).toBe('explicit-fixture-key');
  });
});

describe('bounded model content and complete artifacts', () => {
  it.each(['excerpts', 'full content', 'error URL'] as const)(
    'keeps extraction failures visible when %s exceeds the text budget',
    async (oversized) => {
      const response = {
        ...extractResponse,
        results:
          oversized === 'error URL'
            ? []
            : [
                {
                  ...extractResponse.results[0],
                  excerpts: oversized === 'excerpts' ? ['x'.repeat(1024)] : [],
                  full_content: 'Full page content '.repeat(100),
                },
              ],
        errors: [
          {
            ...extractResponse.errors[0],
            url:
              oversized === 'error URL'
                ? `https://oversize.example.com/${'x'.repeat(2000)}`
                : extractResponse.errors[0].url,
          },
        ],
        warnings: [],
      };
      const { client } = fixtureClient(response);
      const extract = createExtractTool({
        client,
        fullContent: true,
        maxOutputChars: 1024,
      });
      const args = {
        urls: [...response.results, ...response.errors].map(({ url }) => url),
      };
      const message = await extract.invoke({
        type: 'tool_call',
        id: 'call_truncated_failure',
        name: extract.name,
        args,
      });
      const content = String(message.content);
      expect(content).toMatch(/extraction failed/i);
      expect(content.length).toBeLessThanOrEqual(1024);
      expect(content).toMatch(/truncat/i);
      expect(message.artifact).toStrictEqual(response);
      expect(await extract.invoke(args)).toBe(content);
      if (response.results.length) {
        expect(content).toContain(response.results[0].url);
        if (oversized === 'full content') {
          expect(content).toContain('Full page content');
          expect(content.indexOf(response.results[0].url)).toBeLessThan(
            content.indexOf('Full page content')
          );
        }
      } else {
        expect(content).not.toContain('https://oversize.example.com/');
      }
    }
  );

  it('bounds large titles and excerpts while retaining all source metadata', async () => {
    const response = {
      ...searchResponse,
      results: [
        {
          ...searchResponse.results[0],
          title: 'Large title '.repeat(1000),
          excerpts: ['Large excerpt '.repeat(5000)],
        },
      ],
    };
    const { client } = fixtureClient(response);
    const search = createSearchTool({ client, maxOutputChars: 1024 });
    const message = await search.invoke({
      type: 'tool_call',
      id: 'call_bounded_search',
      name: search.name,
      args: { search_queries: ['query'] },
    });
    const content = String(message.content);
    expect(content.length).toBeLessThanOrEqual(1024);
    expect(content).toMatch(/truncat/i);
    expect(content).toContain(response.results[0].url);
    expect(content.indexOf(response.results[0].url)).toBeLessThan(
      content.indexOf('Large title')
    );
    expect(message.artifact).toStrictEqual(response);
  });

  it('bounds warnings and all-failed extraction responses without losing their details', async () => {
    const response = {
      ...extractResponse,
      results: [],
      errors: [
        { ...extractResponse.errors[0], content: 'Error body '.repeat(5000) },
      ],
      warnings: [
        {
          type: 'warning' as const,
          message: 'Long warning '.repeat(5000),
          detail: { explanation: 'Diagnostic detail '.repeat(5000) },
        },
      ],
    };
    const { client } = fixtureClient(response);
    const extract = createExtractTool({ client, maxOutputChars: 1024 });
    const message = await extract.invoke({
      type: 'tool_call',
      id: 'call_failed_extract',
      name: extract.name,
      args: { urls: [response.errors[0].url] },
    });
    const content = String(message.content);
    expect(content.length).toBeLessThanOrEqual(1024);
    expect(content).toMatch(/truncat/i);
    expect(content).toContain(response.errors[0].url);
    expect(content).toContain('http_error');
    expect(content).not.toContain('Error body');
    expect(message.artifact).toStrictEqual(response);
  });

  it('omits an oversized source URL and its text together instead of cutting the URL', async () => {
    const response = {
      ...searchResponse,
      results: [
        searchResponse.results[0],
        {
          url: `https://oversize.example.com/${'x'.repeat(2000)}`,
          title: 'This source must not appear without its URL',
          excerpts: ['A source-dependent statement.'],
        },
      ],
    };
    const { client } = fixtureClient(response);
    const search = createSearchTool({ client, maxOutputChars: 1024 });
    const message = await search.invoke({
      type: 'tool_call',
      id: 'call_long_url',
      name: search.name,
      args: { search_queries: ['query'] },
    });
    const content = String(message.content);
    expect(content).toContain(response.results[0].url);
    expect(content).not.toContain('https://oversize.example.com/');
    expect(content).not.toContain(response.results[1].title);
    expect(content).not.toContain(response.results[1].excerpts[0]);
    expect(content.length).toBeLessThanOrEqual(1024);
    expect(content).toMatch(/truncat/i);
    expect(message.artifact).toStrictEqual(response);
  });
});

describe('SDK failures and retries', () => {
  it.each([
    { status: 401, errorType: Parallel.AuthenticationError },
    { status: 429, errorType: Parallel.RateLimitError },
  ])(
    'rejects with the original SDK $status error and response details',
    async ({ status, errorType }) => {
      const response = {
        type: 'error',
        error: {
          message: 'Request rejected.',
          ref_id: 'error_fixture',
          detail: { status },
        },
      };
      const { client, fetch } = fixtureClient(response, {}, status);
      const calls: {
        tool: StructuredToolInterface;
        args: Record<string, unknown>;
      }[] = [
        {
          tool: createSearchTool({ client }),
          args: { search_queries: ['query'] },
        },
        {
          tool: createExtractTool({ client }),
          args: { urls: ['https://example.com'] },
        },
      ];
      for (const { tool, args } of calls) {
        const error = await tool
          .invoke({
            type: 'tool_call',
            id: 'call_error',
            name: tool.name,
            args,
          })
          .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(errorType);
        expect(error).toMatchObject({ status, error: response });
        expect((error as APIError).headers?.get('x-request-id')).toBe(
          'request_fixture'
        );
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it('preserves the retry configuration on an injected SDK client', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: 'Try again.' } },
          {
            status: 429,
            headers: { 'retry-after-ms': '1' },
          }
        )
      )
      .mockResolvedValueOnce(Response.json(searchResponse));
    const client = new Parallel({
      apiKey: 'fixture-key',
      fetch,
      maxRetries: 1,
    });
    const result = await createSearchTool({ client }).invoke({
      search_queries: ['query'],
    });
    expect(result).toContain(searchResponse.results[0].url);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

async function stalledServer() {
  let requests = 0;
  let disconnected = false;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.on('close', () => {
      disconnected = !response.writableEnded;
    });
    // Deliberately leave the response open so only cancellation can finish it.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get requests() {
      return requests;
    },
    get disconnected() {
      return disconnected;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

describe('cancellation through the real HTTP transport', () => {
  it('rejects pre-aborted calls without dispatching either tool', async () => {
    const reason = new Error('Caller canceled before dispatch.');
    const signal = AbortSignal.abort(reason);
    const { client, fetch } = fixtureClient(searchResponse);
    await expect(
      createSearchTool({ client }).invoke(
        { search_queries: ['query'] },
        { signal }
      )
    ).rejects.toBe(reason);
    await expect(
      createExtractTool({ client }).invoke(
        { urls: ['https://example.com'] },
        { signal }
      )
    ).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['caller signal', 'runnable timeout', 'SDK timeout'] as const)(
    'closes an in-flight request on %s',
    async (cancellation) => {
      const server = await stalledServer();
      const controller = new AbortController();
      const reason = new Error('Caller canceled during the request.');
      const client = new Parallel({
        apiKey: 'fixture-key',
        baseURL: server.baseURL,
        maxRetries: 0,
        timeout: cancellation === 'SDK timeout' ? 250 : 10_000,
      });
      const invocation =
        cancellation === 'runnable timeout'
          ? createExtractTool({ client }).invoke(
              { urls: ['https://example.com'] },
              { timeout: 250 }
            )
          : createSearchTool({ client }).invoke(
              { search_queries: ['query'] },
              { signal: controller.signal }
            );
      // Attach a rejection handler immediately, before waiting on the server.
      const outcome = invocation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      );
      try {
        await vi.waitFor(() => expect(server.requests).toBe(1), {
          timeout: 2000,
        });
        if (cancellation === 'caller signal') controller.abort(reason);
        await vi.waitFor(() => expect(server.disconnected).toBe(true), {
          timeout: 2000,
        });
        const { value, error } = await outcome;
        expect(value).toBeUndefined();
        if (cancellation === 'caller signal') expect(error).toBe(reason);
        else if (cancellation === 'runnable timeout')
          expect(error).toMatchObject({ name: 'TimeoutError' });
        else expect(error).toBeInstanceOf(Parallel.APIConnectionTimeoutError);
        expect(server.requests).toBe(1);
      } finally {
        controller.abort();
        await server.close();
        await outcome;
      }
    }
  );
});
