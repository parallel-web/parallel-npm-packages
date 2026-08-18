import { describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessageEvent,
  Context,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  PARALLEL_RESEARCH_MODEL,
  PARALLEL_RESPONSES_MAX_INPUT_CHARS,
  PARALLEL_RESPONSES_URL,
  streamParallelResponses,
} from '../parallel-responses.js';

function completedResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'resp_test',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'Parallel found the answer.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.com/source',
                title: 'Example [source]',
                start_index: 0,
                end_index: 14,
              },
              {
                type: 'url_citation',
                url: 'https://example.com/source',
                title: 'Duplicate title',
                start_index: 15,
                end_index: 21,
              },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      total_tokens: 46,
    },
    ...overrides,
  };
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'x-request-id': 'request-test' },
  });
}

function researchContext(): Context {
  return {
    systemPrompt: 'Research carefully and cite sources.',
    messages: [
      { role: 'user', content: 'Do not send this parent-history question.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Do not send this prior answer.' }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: 'stop',
        timestamp: 1,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Research the current API contract.' },
          { type: 'image', data: 'not-forwarded', mimeType: 'image/png' },
        ],
        timestamp: 2,
      },
    ],
    tools: [
      {
        name: 'read',
        description: 'Must not be forwarded',
        parameters: { type: 'object' },
      },
    ],
  } as Context;
}

async function collect(
  options: SimpleStreamOptions,
  context = researchContext()
) {
  const stream = streamParallelResponses(
    PARALLEL_RESEARCH_MODEL,
    context,
    options
  );
  const resultPromise = stream.result();
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await resultPromise };
}

describe('Parallel Responses model', () => {
  it('maps one stateless request and returns cited text with usage and cost', async () => {
    const fetchMock = vi.fn(async () => response(completedResponse()));
    const onPayload = vi.fn();
    const onResponse = vi.fn();

    const { events, result } = await collect({
      apiKey: 'test-api-key',
      fetch: fetchMock,
      onPayload,
      onResponse,
      reasoning: 'medium',
      metadata: {
        sessionId: 'not-forwarded',
        cwd: '/not-forwarded',
        worktree: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      PARALLEL_RESPONSES_URL,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'parallel',
      input: 'Research the current API contract.',
      instructions: 'Research carefully and cite sources.',
      reasoning: { effort: 'medium' },
      stream: false,
    });
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-api-key');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-tool-calling-package')).toBe(
      'npm:@parallel-web/pi-extension/v1.2.0'
    );
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 200,
        headers: expect.objectContaining({ 'x-request-id': 'request-test' }),
      },
      PARALLEL_RESEARCH_MODEL
    );

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: [
          'Parallel found the answer.',
          '',
          'Sources:',
          '1. [Example \\[source\\]](<https://example.com/source>)',
        ].join('\n'),
      },
    ]);
    expect(result.usage).toEqual(
      expect.objectContaining({
        input: 12,
        output: 34,
        totalTokens: 46,
        cost: expect.objectContaining({ total: 0.05 }),
      })
    );
    expect(result.stopReason).toBe('stop');
  });

  it.each([
    ['minimal', 'low', 0.01],
    ['low', 'low', 0.01],
    ['medium', 'medium', 0.05],
    ['high', 'high', 0.25],
    ['xhigh', 'high', 0.25],
    ['max', 'high', 0.25],
  ] as const)(
    'maps %s thinking to %s effort',
    async (thinking, effort, cost) => {
      const fetchMock = vi.fn(async () => response(completedResponse()));

      const { result } = await collect({
        apiKey: 'test-api-key',
        fetch: fetchMock,
        reasoning: thinking,
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(init.body)).reasoning).toEqual({ effort });
      expect(result.usage.cost.total).toBe(cost);
    }
  );

  it('honors an explicit caller-owned payload replacement', async () => {
    const fetchMock = vi.fn(async () => response(completedResponse()));
    const replacement = {
      model: 'parallel',
      input: 'Trusted caller replacement.',
      reasoning: { effort: 'low' },
      stream: false,
    };

    await collect({
      apiKey: 'test-api-key',
      fetch: fetchMock,
      onPayload: () => replacement,
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(replacement);
  });

  it('does not fall back to history for a non-textual latest task', async () => {
    const fetchMock = vi.fn();
    const context = researchContext();
    context.messages.push({
      role: 'user',
      content: [
        { type: 'image', data: 'latest-image-only', mimeType: 'image/png' },
      ],
      timestamp: 3,
    });

    const { result } = await collect(
      { apiKey: 'test-api-key', fetch: fetchMock },
      context
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe(
      'Parallel Research requires a non-empty textual user task.'
    );
  });

  it('fails oversized input before making a request', async () => {
    const fetchMock = vi.fn();
    const context = researchContext();
    context.systemPrompt = 'x'.repeat(PARALLEL_RESPONSES_MAX_INPUT_CHARS);

    const { events, result } = await collect(
      { apiKey: 'test-api-key', fetch: fetchMock },
      context
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', reason: 'error' })
    );
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('20,000-character limit');
  });

  it('does not retry HTTP errors and redacts the credential', async () => {
    const fetchMock = vi.fn(async () =>
      response({ error: { message: 'key test-api-key is unauthorized' } }, 401)
    );

    const { result } = await collect({
      apiKey: 'test-api-key',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe(
      'Parallel Responses request failed (401): key [REDACTED] is unauthorized'
    );
    expect(result.errorMessage).not.toContain('test-api-key');
  });

  it('does not retry malformed completed responses', async () => {
    const fetchMock = vi.fn(async () =>
      response(completedResponse({ output: [] }))
    );

    const { result } = await collect({
      apiKey: 'test-api-key',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe(
      'Parallel returned an empty research response.'
    );
  });

  it('propagates caller cancellation to the request signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by caller'));
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    const { events, result } = await collect({
      apiKey: 'test-api-key',
      fetch: fetchMock as typeof fetch,
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'error', reason: 'aborted' })
    );
    expect(result.stopReason).toBe('aborted');
  });

  it('terminates a hung request at the local timeout without retrying', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Timed out', 'AbortError')),
            { once: true }
          );
        })
    );

    const { result } = await collect({
      apiKey: 'test-api-key',
      fetch: fetchMock as typeof fetch,
      timeoutMs: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('Parallel Research timed out.');
  });
});
