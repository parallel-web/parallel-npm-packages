import { Context } from '@deepseek-ai/cordis';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import WebRuntime from '@deepseek-ai/dsh-web';
import Parallel from 'parallel-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as parallelPlugin from '../src/index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSearch(
  results: Array<{
    url: string;
    excerpts: string[];
    title?: string | null;
    publish_date?: string | null;
  }> = []
) {
  return vi.spyOn(Parallel.prototype, 'search').mockResolvedValue({
    results,
    search_id: 'search_test',
    session_id: 'session_test',
  });
}

describe('Parallel plugin config', () => {
  it('marks a literal API key as secret configuration', () => {
    const schema = parallelPlugin.Config as typeof parallelPlugin.Config & {
      dict: Record<string, { meta: { role?: string } }>;
    };
    expect(schema.dict.apiKey?.meta.role).toBe('secret');
  });

  it('materializes the default total character budget in the schema', () => {
    expect(parallelPlugin.Config({})).toEqual({
      maxCharsTotal: parallelPlugin.DEFAULT_MAX_CHARS_TOTAL,
    });
  });

  it('preserves an explicit total character budget override', () => {
    expect(parallelPlugin.Config({ maxCharsTotal: 4_000 })).toEqual({
      maxCharsTotal: 4_000,
    });
  });

  it.each(['turbo', 'basic', 'advanced'])(
    'accepts documented mode %s',
    (mode) => {
      expect(
        parallelPlugin.Config({
          mode: mode as NonNullable<parallelPlugin.Config['mode']>,
        })
      ).toEqual({
        mode,
        maxCharsTotal: parallelPlugin.DEFAULT_MAX_CHARS_TOTAL,
      });
    }
  );

  it.each(['fast', 'auto', ''])('rejects unsupported mode %j', (mode) => {
    expect(() =>
      parallelPlugin.Config({ mode } as unknown as parallelPlugin.Config)
    ).toThrow();
  });

  it.each([0, -1, 1.5])('rejects invalid character budget %s', (value) => {
    expect(() => parallelPlugin.Config({ maxCharsTotal: value })).toThrow();
    expect(() => parallelPlugin.Config({ maxCharsPerResult: value })).toThrow();
  });
});

describe('Parallel plugin registration', () => {
  it.each(['', 'parallel_test_plugin'])(
    'reuses a session per provider with API key %j',
    async (apiKey) => {
      const sessionIds: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        const sessionId =
          apiKey === '' ? body.params.arguments.session_id : body.session_id;
        sessionIds.push(sessionId);
        const result = { results: [], session_id: sessionId };
        return new Response(
          JSON.stringify(
            apiKey === ''
              ? { jsonrpc: '2.0', id: 1, result: { structuredContent: result } }
              : result
          ),
          { headers: { 'content-type': 'application/json' } }
        );
      });
      const ctx = new Context();
      await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
      const fiber = await ctx.plugin(parallelPlugin, { apiKey });
      try {
        await ctx.web.search({ query: 'first query' });
        await ctx.web.search({ query: 'second query' });
        expect(sessionIds[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(sessionIds[1]).toBe(sessionIds[0]);
      } finally {
        await fiber.dispose();
      }

      const next = await ctx.plugin(parallelPlugin, { apiKey });
      try {
        await ctx.web.search({ query: 'new provider' });
        expect(sessionIds[2]).toMatch(/^[0-9a-f-]{36}$/);
        expect(sessionIds[2]).not.toBe(sessionIds[0]);
      } finally {
        await next.dispose();
      }
    }
  );

  it('registers, selects, and disposes through the real WebRuntime', async () => {
    mockSearch();
    const ctx = new Context();
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
    const fiber = await ctx.plugin(parallelPlugin, {
      apiKey: 'parallel_test_plugin',
    });
    await expect(ctx.web.search({ query: 'q' })).resolves.toEqual({
      sources: [],
      truncated: false,
    });
    await fiber.dispose();
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    });
  });

  it('uses the launch-environment fallback', async () => {
    const search = mockSearch();
    const ctx = new Context();
    ctx.provide(
      'launchEnvironment',
      createLaunchEnvironmentSnapshot([
        {
          source: 'process',
          values: { PARALLEL_API_KEY: 'parallel_test_environment' },
        },
      ])
    );
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
    await ctx.plugin(parallelPlugin, {});
    await ctx.web.search({ query: 'q' });
    expect(search).toHaveBeenCalledOnce();
  });

  it('lets an explicit empty key choose free search over an environment key', async () => {
    const search = mockSearch();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { structuredContent: { results: [] } },
        })
      )
    );
    const ctx = new Context();
    ctx.provide(
      'launchEnvironment',
      createLaunchEnvironmentSnapshot([
        {
          source: 'process',
          values: { PARALLEL_API_KEY: 'parallel_test_environment' },
        },
      ])
    );
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
    await ctx.plugin(parallelPlugin, { apiKey: '' });
    await expect(ctx.web.search({ query: 'q' })).resolves.toEqual({
      sources: [],
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
  });

  it('uses free MCP search when no API key is configured', async () => {
    const search = mockSearch();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            structuredContent: {
              results: [
                {
                  url: 'https://example.test',
                  excerpts: ['Free search works'],
                },
              ],
            },
          },
        })
      )
    );
    const ctx = new Context();
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]));
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
    await ctx.plugin(parallelPlugin, {});
    await expect(ctx.web.search({ query: 'q' })).resolves.toEqual({
      sources: [
        {
          url: 'https://example.test',
          snippet: 'Free search works',
        },
      ],
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
  });

  it('lets the seam own final source truncation', async () => {
    mockSearch([
      { url: 'https://a.test', excerpts: ['a'] },
      { url: 'https://b.test', excerpts: ['b'] },
      { url: 'https://c.test', excerpts: ['c'] },
    ]);
    const ctx = new Context();
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
    await ctx.plugin(parallelPlugin, { apiKey: 'parallel_test_plugin' });
    await expect(
      ctx.web.search({ query: 'q', maxResults: 2 })
    ).resolves.toMatchObject({
      sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
      truncated: true,
    });
  });

  it('has a search-only namespace export surface', () => {
    expect('default' in parallelPlugin).toBe(false);
    expect('fetch' in parallelPlugin).toBe(false);
    expect('registerFetchProvider' in parallelPlugin).toBe(false);
    expect(parallelPlugin.PARALLEL_PROVIDER_ID).toBe('parallel');
  });
});
