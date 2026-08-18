import { Context } from '@deepseek-ai/cordis';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as plugin from '../src/index.ts';
import {
  PARALLEL_RESPONSES_TIMEOUT_MS,
  PARALLEL_RESPONSES_URL,
  ParallelResponsesProvider,
  researchPrompt,
} from '../src/provider.ts';

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

function sseEvent(type: string, response: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
}

function completed(
  text = 'The researched answer.',
  annotations: unknown[] = []
): string {
  return sseEvent('response.completed', {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text, annotations }],
      },
    ],
  });
}

function streamResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
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
  it('sends one fixed request and renders deduplicated title and URL citations', async () => {
    const event = completed('Evidence-backed answer.', [
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
    ]);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        streamResponse(
          'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n',
          event.slice(0, 19),
          event.slice(19)
        )
      );
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
            '- https://b.test/data',
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
      reasoning: { effort: 'medium' },
      stream: true,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer parallel_test_provider');
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(run.localAgent).toBeUndefined();
    const firstDispose = run.dispose();
    expect(run.dispose()).toBe(firstDispose);
    await firstDispose;
  });

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

  it.each([
    new Response('denied', { status: 403 }),
    streamResponse(sseEvent('response.failed', { status: 'failed' })),
    streamResponse('event: response.completed\ndata: not-json\n\n'),
    streamResponse(
      'event: response.created\ndata: {"type":"response.created"}\n\n'
    ),
  ])(
    'settles HTTP, in-band, and malformed stream failures',
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

describe('Parallel Responses capacity and lifecycle', () => {
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

  it('admits only two active requests and removes an aborted queued start', async () => {
    const fetch = abortableFetch();
    const provider = new ParallelResponsesProvider({
      apiKey: 'parallel_test_provider',
      fetch,
    });
    const first = await provider.start(request());
    const second = await provider.start(request());
    const queuedController = new AbortController();
    const queued = provider.start(request(undefined, queuedController.signal));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    queuedController.abort();
    await expect(queued).rejects.toThrow('waiting for capacity');
    expect(fetch).toHaveBeenCalledTimes(2);

    await first.dispose();
    const replacement = await provider.start(request());
    expect(fetch).toHaveBeenCalledTimes(3);
    await Promise.all([second.dispose(), replacement.dispose()]);
  });

  it('times out once with no retry and releases capacity', async () => {
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
    await fiber.dispose();
    expect(
      ctx.subagents.getProvider(plugin.PARALLEL_RESPONSES_PROVIDER_ID)
    ).toBeUndefined();
  });

  it('fails at load without an explicit or launch-time key', async () => {
    const ctx = new Context();
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
