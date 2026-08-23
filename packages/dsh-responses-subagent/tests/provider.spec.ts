import { Context } from '@deepseek-ai/cordis';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as plugin from '../src/index.ts';
import {
  PARALLEL_RESPONSES_MAX_INPUT_CHARS,
  PARALLEL_RESPONSES_TIMEOUT_MS,
  PARALLEL_RESPONSES_URL,
  PARALLEL_RESEARCH_INSTRUCTIONS,
  ParallelResponsesProvider,
  researchPrompt,
} from '../src/provider.ts';

type ContentBlock = ResolvedSubagentStartRequest['prompt'][number];

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'research this exactly' }],
  signal = new AbortController().signal
): ResolvedSubagentStartRequest {
  return {
    prompt,
    signal,
    parent: {} as ResolvedSubagentStartRequest['parent'],
    descriptor: {} as ResolvedSubagentStartRequest['descriptor'],
  };
}

function completed(
  text = 'The researched answer.',
  annotations: unknown[] = []
): Response {
  return Response.json({
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text, annotations }],
      },
    ],
  });
}

function abortableFetch() {
  return vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('transport aborted')),
          { once: true }
        );
      })
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Parallel Responses request and output', () => {
  it('sends one fixed request and tolerates imperfect, duplicate citations', async () => {
    const response = completed('Evidence-backed answer.', [
      {
        type: 'url_citation',
        title: 'Source A',
        url: 'https://a.test/report',
      },
      {
        type: 'url_citation',
        title: 'Duplicate title',
        url: 'https://a.test/report',
      },
      { type: 'url_citation', url: 'https://b.test/data' },
      { type: 'url_citation', url: '' },
      { type: 'url_citation', url: 42 },
      {
        type: 'url_citation',
        title: 42,
        url: 'https://c.test/report',
      },
      {
        type: 'url_citation',
        title: 'Recovered title',
        url: 'https://c.test/report',
      },
    ]);
    const fetch = vi.fn().mockResolvedValue(response);
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch,
    });
    const run = await provider.start(
      request([{ type: 'text', text: '  unchanged prompt  ' }])
    );

    await expect(run.result).resolves.toEqual({
      output: [
        {
          type: 'text',
          text:
            'Evidence-backed answer.\n\nSources:\n' +
            '- Source A — https://a.test/report\n' +
            '- https://b.test/data\n' +
            '- Recovered title — https://c.test/report',
        },
      ],
      stopReason: 'completed',
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(PARALLEL_RESPONSES_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'parallel',
      input: '  unchanged prompt  ',
      instructions: PARALLEL_RESEARCH_INSTRUCTIONS,
      reasoning: { effort: 'medium' },
      stream: false,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer parallel_test_provider');
    expect(headers.get('content-type')).toBe('application/json');
    expect(run.localAgent).toBeUndefined();
    const firstDispose = run.dispose();
    expect(run.dispose()).toBe(firstDispose);
    await firstDispose;
  });

  it.each(['low', 'medium', 'high'] as const)(
    'sends the configured %s research tier',
    async (effort) => {
      const fetch = vi.fn().mockResolvedValue(completed());
      const provider = new ParallelResponsesProvider({
        apiKey: 'parallel_test_provider',
        effort,
        fetch,
      });
      const run = await provider.start(request());

      await expect(run.result).resolves.toMatchObject({
        stopReason: 'completed',
      });
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
        instructions: PARALLEL_RESEARCH_INSTRUCTIONS,
        reasoning: { effort },
      });
      await run.dispose();
    }
  );

  it('preserves text block order and rejects blank or non-text prompts', () => {
    expect(
      researchPrompt(
        request([
          { type: 'text', text: 'one' },
          { type: 'text', text: ' two' },
        ])
      )
    ).toBe('one two');
    expect(() => researchPrompt(request([]))).toThrow('only text blocks');
    expect(() =>
      researchPrompt(request([{ type: 'text', text: ' \n ' }]))
    ).toThrow('must not be empty');
    expect(() =>
      researchPrompt(
        request([{ type: 'reasoning', text: 'private' } as ContentBlock])
      )
    ).toThrow('only text blocks');
  });

  it('rejects prompts that exceed the API limit with research instructions', () => {
    const available =
      PARALLEL_RESPONSES_MAX_INPUT_CHARS -
      PARALLEL_RESEARCH_INSTRUCTIONS.length -
      1;

    expect(
      researchPrompt(request([{ type: 'text', text: 'x'.repeat(available) }]))
    ).toHaveLength(available);
    expect(() =>
      researchPrompt(
        request([{ type: 'text', text: 'x'.repeat(available + 1) }])
      )
    ).toThrow('exceed 20,000 characters');
  });

  it.each([
    new Response('denied', { status: 403 }),
    Response.json({ status: 'failed' }),
    new Response('not-json'),
    Response.json({ status: 'completed', output: [] }),
  ])(
    'settles HTTP, API, malformed JSON, and empty-answer failures',
    async (response) => {
      const fetch = vi.fn().mockResolvedValue(response);
      const provider = new ParallelResponsesProvider({
        apiKey: 'parallel_test_provider',
        fetch,
      });
      const run = await provider.start(request());
      await expect(run.result).resolves.toEqual({
        output: [],
        stopReason: 'error',
      });
      expect(fetch).toHaveBeenCalledOnce();
      await run.dispose();
    }
  );

  it('reports safe diagnostics without leaking transport details', async () => {
    const onError = vi.fn();
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'dsh-responses-subagent: Bearer parallel_secret_value failed with private body'
        )
      );
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_secret_value',
      fetch,
      onError,
    });
    const run = await provider.start(request());

    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'error',
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: 'dsh-responses-subagent: Parallel Responses transport failed',
    });
    expect(String(onError.mock.calls[0]?.[0])).not.toContain(
      'parallel_secret_value'
    );
    await run.dispose();
  });

  it('keeps diagnostic sink failures inside the non-rejecting run seam', async () => {
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 429 })),
      onError: () => {
        throw new Error('diagnostic sink failed');
      },
    });
    const run = await provider.start(request());
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'error',
    });
    await run.dispose();
  });
});

describe('Parallel Responses lifecycle', () => {
  it('rejects cancellation before publication without making a request', async () => {
    const fetch = vi.fn();
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.start(request(undefined, controller.signal))
    ).rejects.toThrow('aborted');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts an active request, settles, and disposes idempotently', async () => {
    const fetch = abortableFetch();
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch,
    });
    const controller = new AbortController();
    const run = await provider.start(request(undefined, controller.signal));
    controller.abort();
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    });
    const disposal = run.dispose();
    expect(run.dispose()).toBe(disposal);
    await disposal;
  });

  it('does not throttle simultaneous research calls', async () => {
    const fetch = abortableFetch();
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch,
    });
    const runs = await Promise.all(
      Array.from({ length: 20 }, async () => await provider.start(request()))
    );

    expect(fetch).toHaveBeenCalledTimes(20);
    await Promise.all(runs.map(async (run) => await run.dispose()));
  });

  it('times out once with no retry', async () => {
    vi.useFakeTimers();
    const fetch = abortableFetch();
    const onError = vi.fn();
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch,
      onError,
    });
    const run = await provider.start(request());
    await vi.advanceTimersByTimeAsync(PARALLEL_RESPONSES_TIMEOUT_MS);
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'error',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'dsh-responses-subagent: Parallel Responses request timed out',
      })
    );
    await run.dispose();
  });
});

describe('Parallel Responses plugin registration', () => {
  it('marks the optional API key as secret configuration', () => {
    const schema = plugin.Config as typeof plugin.Config & {
      dict: Record<string, { meta: { role?: string } }>;
    };
    expect(schema.dict.apiKey?.meta.role).toBe('secret');
  });

  it('uses the launch environment and unregisters with its Cordis fiber', async () => {
    const ctx = new Context();
    const section = vi.fn();
    const get = vi.fn((): unknown => ({}));
    ctx.provide('systemPrompt', {
      section,
    } as unknown as Context['systemPrompt']);
    ctx.provide('tools', { get } as unknown as Context['tools']);
    ctx.provide(
      'launchEnvironment',
      createLaunchEnvironmentSnapshot([
        {
          source: 'process',
          values: { PARALLEL_API_KEY: 'parallel_test_environment' },
        },
      ])
    );
    await ctx.plugin(SubagentRuntime);
    const fiber = await ctx.plugin(plugin, {});
    expect(
      ctx.subagents.getProvider(plugin.PARALLEL_RESPONSES_PROVIDER_ID)
    ).toMatchObject({
      name: 'parallel-responses',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    });
    expect(section).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tool:parallel_research',
        text: expect.any(Function),
      })
    );
    const registration = section.mock.calls[0]?.[0] as {
      text: (context: { scope?: unknown }) => string;
    };
    expect(registration.text({})).toContain('complete, self-contained');
    get.mockReturnValue(undefined);
    expect(registration.text({})).toBe('');
    await fiber.dispose();
    expect(
      ctx.subagents.getProvider(plugin.PARALLEL_RESPONSES_PROVIDER_ID)
    ).toBeUndefined();
  });

  it('teaches low-effort parents to fan out independent research', async () => {
    const ctx = new Context();
    const section = vi.fn();
    ctx.provide('systemPrompt', {
      section,
    } as unknown as Context['systemPrompt']);
    ctx.provide('tools', {
      get: vi.fn(() => ({})),
    } as unknown as Context['tools']);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]));
    await ctx.plugin(SubagentRuntime);
    const fiber = await ctx.plugin(plugin, {
      apiKey: 'parallel_test_explicit',
      effort: 'low',
    });

    const registration = section.mock.calls[0]?.[0] as {
      text: (context: { scope?: unknown }) => string;
    };
    expect(registration.text({})).toContain('focused, independent questions');
    await fiber.dispose();
  });

  it('fails at load without an explicit or launch-time key', async () => {
    const ctx = new Context();
    ctx.provide('systemPrompt', {
      section: vi.fn(),
    } as unknown as Context['systemPrompt']);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]));
    await ctx.plugin(SubagentRuntime);
    await expect(ctx.plugin(plugin, {})).rejects.toThrow(
      'apiKey or PARALLEL_API_KEY is required'
    );
  });

  it('has a narrow namespace export surface', () => {
    expect('default' in plugin).toBe(false);
    expect('ParallelResponsesProvider' in plugin).toBe(false);
    expect(plugin.PARALLEL_RESPONSES_PROVIDER_ID).toBe('parallel-responses');
  });
});
