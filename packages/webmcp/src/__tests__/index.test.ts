import { afterEach, describe, expect, it, vi } from 'vitest';
import { installParallelWebMcp } from '../index.js';
import {
  createBrowser,
  fetchPayload,
  searchPayload,
  upstreamResponse,
  type TestTool,
} from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockSearch(payload = searchPayload()) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number };
    return upstreamResponse(body.id, payload);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('installParallelWebMcp', () => {
  it.each([undefined, {}])(
    'does nothing without browser WebMCP',
    async (page) => {
      vi.stubGlobal('document', page);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      expect(await installParallelWebMcp()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('registers two namespaced, read-only, untrusted tools only once', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);

    expect(await installParallelWebMcp()).toBe(true);
    expect(await installParallelWebMcp()).toBe(true);
    expect([...browser.registered.keys()]).toEqual([
      'parallel_web_search',
      'parallel_web_fetch',
    ]);
    expect(browser.context.registerTool).toHaveBeenCalledTimes(2);

    for (const tool of browser.registered.values()) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('session_id');
    }
    expect(
      browser.registered.get('parallel_web_search')?.inputSchema.properties
    ).toEqual({
      objective: { type: 'string', minLength: 1, maxLength: 500 },
    });
  });

  it('shares one installation between concurrent callers', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);

    expect(
      await Promise.all([installParallelWebMcp(), installParallelWebMcp()])
    ).toEqual([true, true]);
    expect(browser.context.registerTool).toHaveBeenCalledTimes(2);
  });

  it('exposes both tools only to explicitly permitted cross-origin agents', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const exposedTo = ['https://agent.example', 'https://partner.example'];

    expect(await installParallelWebMcp({ exposedTo })).toBe(true);

    for (const name of ['parallel_web_search', 'parallel_web_fetch']) {
      expect(browser.context.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name }),
        expect.objectContaining({ exposedTo })
      );
    }
  });

  it('keeps cross-origin access disabled unless explicitly configured', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);

    await installParallelWebMcp();

    for (const name of ['parallel_web_search', 'parallel_web_fetch']) {
      expect(browser.context.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name }),
        expect.not.objectContaining({ exposedTo: expect.anything() })
      );
    }
  });

  it('preserves unrelated page tools and rolls back partial registration', async () => {
    const unrelated = { name: 'page_owned_tool' } as TestTool;
    const browser = createBrowser({
      existing: [unrelated],
      failOn: 'parallel_web_fetch',
    });
    vi.stubGlobal('document', browser.document);

    await expect(installParallelWebMcp()).rejects.toThrow('already registered');
    expect([...browser.registered.keys()]).toEqual(['page_owned_tool']);
  });

  it('calls both upstream tools anonymously with the same stable session', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const requests: Array<{
      name: string;
      arguments: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          id: number;
          params: { name: string; arguments: Record<string, unknown> };
        };
        requests.push({
          ...body.params,
          headers: init.headers as Record<string, string>,
        });
        expect(init.credentials).toBe('omit');
        expect(init.referrerPolicy).toBe('origin');
        return upstreamResponse(
          body.id,
          body.params.name === 'web_search' ? searchPayload() : fetchPayload()
        );
      })
    );

    await installParallelWebMcp();
    expect(
      await browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'Find recent product announcements' })
    ).toMatchObject({
      results: [{ url: 'https://example.com/result' }],
    });
    expect(
      await browser.registered
        .get('parallel_web_fetch')!
        .execute({ url: 'https://example.com/article' })
    ).toMatchObject({
      results: [{ url: 'https://example.com/article' }],
    });

    expect(requests[0]?.arguments.session_id).toBe(
      requests[1]?.arguments.session_id
    );
    expect(requests[0]?.headers['Mcp-Session-Id']).toBe(
      requests[0]?.arguments.session_id
    );
    expect(requests[0]?.headers).not.toHaveProperty('Authorization');
    expect(requests[1]?.arguments).toMatchObject({ full_content: false });
  });

  it('reuses the anonymous session after a same-tab page reload', async () => {
    const storage = new Map<string, string>();
    const sessions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          id: number;
          params: { arguments: { session_id: string } };
        };
        sessions.push(body.params.arguments.session_id);
        return upstreamResponse(body.id, searchPayload());
      })
    );

    for (const browser of [
      createBrowser({ storage }),
      createBrowser({ storage }),
    ]) {
      vi.stubGlobal('document', browser.document);
      await installParallelWebMcp();
      await browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'news' });
    }

    expect(sessions[0]).toBe(sessions[1]);
  });

  it('keeps a stable in-memory session when browser storage is blocked', async () => {
    const browser = createBrowser({ storageBlocked: true });
    vi.stubGlobal('document', browser.document);
    const fetch = mockSearch();
    await installParallelWebMcp();
    const search = browser.registered.get('parallel_web_search')!;

    await search.execute({ objective: 'first' });
    await search.execute({ objective: 'second' });

    const first = JSON.parse(String(fetch.mock.calls[0]![1].body));
    const second = JSON.parse(String(fetch.mock.calls[1]![1].body));
    expect(first.params.arguments.session_id).toBe(
      second.params.arguments.session_id
    );
  });

  it('validates search inputs and rejects non-HTTP fetch URLs', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    await installParallelWebMcp();

    expect(() =>
      browser.registered.get('parallel_web_search')!.execute({ objective: ' ' })
    ).toThrow('objective');
    expect(() =>
      browser.registered
        .get('parallel_web_fetch')!
        .execute({ url: 'javascript:alert(1)' })
    ).toThrow('HTTP or HTTPS');
  });

  it.each([
    {
      name: 'parallel_web_search',
      limit: 500,
      input: {},
    },
    {
      name: 'parallel_web_fetch',
      limit: 200,
      input: { url: 'https://example.com/article' },
    },
  ])(
    'validates $name objectives by Unicode code point',
    async ({ name, limit, input }) => {
      const browser = createBrowser();
      vi.stubGlobal('document', browser.document);
      const fetch = mockSearch();
      await installParallelWebMcp();

      const objective = `${'a'.repeat(99)}${'🌍'.repeat(limit - 99)}`;
      const tool = browser.registered.get(name)!;
      await tool.execute({ ...input, objective });

      const request = JSON.parse(String(fetch.mock.calls[0]![1].body)) as {
        params: {
          arguments: { objective: string; search_queries?: string[] };
        };
      };
      expect(request.params.arguments.objective).toBe(objective);
      if (name === 'parallel_web_search') {
        expect(request.params.arguments.search_queries).toEqual([
          `${'a'.repeat(99)}🌍`,
        ]);
      } else {
        expect(request.params.arguments).not.toHaveProperty('search_queries');
      }
      expect(() =>
        tool.execute({ ...input, objective: `${objective}🌍` })
      ).toThrow(`1 to ${limit} characters`);
    }
  );

  it('rejects fetch URLs containing embedded credentials before contacting Parallel', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await installParallelWebMcp();

    expect(() =>
      browser.registered
        .get('parallel_web_fetch')!
        .execute({ url: 'https://username:password@example.com/article' })
    ).toThrow('HTTP or HTTPS');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never forwards URL fragments to the upstream fetch service', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const fetch = mockSearch();
    await installParallelWebMcp();

    await browser.registered.get('parallel_web_fetch')!.execute({
      url: 'https://example.com/article#access_token=private',
    });

    const request = JSON.parse(String(fetch.mock.calls[0]![1].body)) as {
      params: { arguments: { urls: string[] } };
    };
    expect(request.params.arguments.urls).toEqual([
      'https://example.com/article',
    ]);
    expect(String(fetch.mock.calls[0]![1].body)).not.toContain('private');
  });

  it('bounds untrusted UTF-8 output without exposing upstream metadata', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    mockSearch(
      searchPayload({
        session_id: 'private-upstream-session',
        results: [
          {
            url: 'https://example.com/source',
            title: 'Source',
            excerpts: ['🌍'.repeat(10_000)],
            full_content: 'never expose full content',
          },
        ],
      })
    );
    await installParallelWebMcp();

    const output = await browser.registered
      .get('parallel_web_search')!
      .execute({ objective: 'news' });

    expect(
      new TextEncoder().encode(JSON.stringify(output)).byteLength
    ).toBeLessThanOrEqual(12_000);
    expect(output).toMatchObject({ truncated: true });
    expect(output).not.toHaveProperty('session_id');
    expect(JSON.stringify(output)).not.toContain('full_content');
  });

  it('keeps every source citation even when the first excerpt is oversized', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const sources = Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.com/source-${index}`,
      excerpts: [index ? 'Short excerpt' : '🌍'.repeat(10_000)],
    }));
    mockSearch(searchPayload({ results: sources }));
    await installParallelWebMcp();

    const output = (await browser.registered
      .get('parallel_web_search')!
      .execute({ objective: 'news' })) as {
      results: Array<{ url: string }>;
    };

    expect(output.results.map((source) => source.url)).toEqual(
      sources.map((source) => source.url)
    );
  });

  it('accepts standard MCP text results without structured content', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstreamResponse(1, searchPayload(), { structured: false })
      )
    );
    await installParallelWebMcp();

    await expect(
      browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'news' })
    ).resolves.toMatchObject({
      results: [{ url: 'https://example.com/result' }],
    });
  });

  it.each([true, false])(
    'rejects failed webpage extraction from structured=%s MCP responses',
    async (structured) => {
      const browser = createBrowser();
      vi.stubGlobal('document', browser.document);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          upstreamResponse(
            1,
            {
              results: [],
              errors: [
                {
                  error_type: 'http_error',
                  message: 'private upstream diagnostics',
                },
              ],
            },
            { structured }
          )
        )
      );
      await installParallelWebMcp();

      await expect(
        browser.registered
          .get('parallel_web_fetch')!
          .execute({ url: 'https://example.com/missing' })
      ).rejects.toThrow(
        'Parallel Search could not fetch the requested webpage.'
      );
    }
  );

  it('forwards execution cancellation to the browser request', async () => {
    const browser = createBrowser();
    const controller = new AbortController();
    vi.stubGlobal('document', browser.document);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      })
    );
    await installParallelWebMcp();

    await expect(
      browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'news' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves cancellation while reading an upstream response body', async () => {
    const browser = createBrowser();
    const controller = new AbortController();
    vi.stubGlobal('document', browser.document);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          controller.abort();
          throw new DOMException('Aborted', 'AbortError');
        },
      }))
    );
    await installParallelWebMcp();

    await expect(
      browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'news' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports free-tier rate limits without retrying', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const fetch = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    await installParallelWebMcp();

    await expect(
      browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'news' })
    ).rejects.toThrow('free rate limit');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recognizes free-tier rate limits wrapped in successful JSON-RPC responses', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);
    const fetch = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message:
            "You've hit the free-tier rate limit for Parallel Search MCP. " +
            'To continue with higher limits, add your own API key.',
        },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await installParallelWebMcp();

    await expect(
      browser.registered
        .get('parallel_web_search')!
        .execute({ objective: 'news' })
    ).rejects.toThrow(
      'Parallel Search reached its free rate limit. Try again later.'
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['private diagnostics', 'rate limit reached: private diagnostics'])(
    'never exposes arbitrary server errors to the agent: %s',
    async (message) => {
      const browser = createBrowser();
      vi.stubGlobal('document', browser.document);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ id: 1, error: { code: -32000, message } })
        )
      );
      await installParallelWebMcp();

      await expect(
        browser.registered
          .get('parallel_web_search')!
          .execute({ objective: 'news' })
      ).rejects.toThrow('could not complete');
    }
  );

  it('registers both tools from the self-installing entry point', async () => {
    const browser = createBrowser();
    vi.stubGlobal('document', browser.document);

    await import('../auto.js');

    await vi.waitFor(() => {
      expect([...browser.registered.keys()]).toEqual([
        'parallel_web_search',
        'parallel_web_fetch',
      ]);
    });
  });
});
