import { afterEach, describe, expect, it, vi } from 'vitest';
import { version } from '../../package.json';
import {
  PARALLEL_RESPONSES_MAX_INPUT_CHARS,
  PARALLEL_RESPONSES_TIMEOUT_MS,
  PARALLEL_RESPONSES_URL,
  runParallelResearch,
  type ResearchInput,
} from '../parallel-responses.js';

const apiKey = 'test-api-key';
const query = 'Compare the current Node.js compatibility of Node and Bun.';

function completed(
  text = 'The researched answer.',
  annotations: unknown[] = [
    {
      type: 'url_citation',
      url: 'https://example.com/source',
      title: 'Example [source]',
    },
    {
      type: 'url_citation',
      url: 'https://example.com/source',
      title: 'Duplicate',
    },
  ]
) {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text, annotations }],
      },
    ],
  };
}

function mockResponse(payload: unknown = completed(), status = 200) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Parallel research request', () => {
  it('sends only the explicit question and fixed instructions, returning cited text', async () => {
    const fetchMock = mockResponse();
    const result = await runParallelResearch(apiKey, {
      query,
      history: 'private-history',
      systemPrompt: 'private-system-prompt',
      cwd: '/private-project',
      sessionId: 'private-session',
      tools: ['read'],
    } as ResearchInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PARALLEL_RESPONSES_URL);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'parallel',
      input: query,
      instructions: expect.stringContaining('Research the user'),
      reasoning: { effort: 'medium' },
      stream: false,
    });
    expect(String(init?.body)).not.toContain('private-');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Tool-Calling-Package')).toBe(
      `npm:@parallel-web/pi-extension/v${version}`
    );
    expect(result).toEqual({
      effort: 'medium',
      text: 'The researched answer.\n\nSources:\n1. [Example \\[source\\]](<https://example.com/source>)',
    });
  });

  it.each(['low', 'medium', 'high'] as const)(
    'sends explicit %s effort',
    async (effort) => {
      const fetchMock = mockResponse();
      expect(
        (await runParallelResearch(apiKey, { query, effort })).effort
      ).toBe(effort);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).reasoning
      ).toEqual({ effort });
    }
  );

  it.each([
    [{ query: '' }, 'non-empty question'],
    [{ query: ' \n\t' }, 'non-empty question'],
    [{ query: null }, 'non-empty question'],
    [{ query, effort: 'extreme' }, 'effort must be'],
    [{ query, effort: null }, 'effort must be'],
    [
      { query: 'x'.repeat(PARALLEL_RESPONSES_MAX_INPUT_CHARS) },
      '20,000-character',
    ],
  ])(
    'rejects invalid input before making a request: %j',
    async (input, error) => {
      const fetchMock = mockResponse();
      await expect(
        runParallelResearch(apiKey, input as ResearchInput)
      ).rejects.toThrow(String(error));
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('counts both instructions and Unicode characters at the exact input boundary', async () => {
    const fetchMock = mockResponse();
    await runParallelResearch(apiKey, { query });
    const { instructions } = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body)
    );
    const capacity =
      PARALLEL_RESPONSES_MAX_INPUT_CHARS - [...instructions].length;
    fetchMock.mockClear();

    await runParallelResearch(apiKey, { query: '🔎'.repeat(capacity) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      runParallelResearch(apiKey, { query: '🔎'.repeat(capacity + 1) })
    ).rejects.toThrow('20,000-character');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires authentication before sending a request', async () => {
    const fetchMock = mockResponse();
    await expect(runParallelResearch('', { query })).rejects.toThrow(
      '/login parallel'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Parallel research evidence', () => {
  it('keeps multiple text parts and safe citations without fabricating sources', async () => {
    const payload = completed('First finding.', [
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
      { type: 'url_citation', url: 'not-a-url' },
      {
        type: 'url_citation',
        url: 'https://example.com/a(b)',
        title: 'A [label]\nnext',
      },
      { type: 'url_citation', url: 'https://example.com/fallback' },
    ]);
    payload.output.push({
      type: 'message',
      content: [
        { type: 'output_text', text: 'Second finding.', annotations: [] },
      ],
    });
    mockResponse({
      ...payload,
      output: [{ type: 'reasoning', summary: [] }, ...payload.output],
    });
    const { text } = await runParallelResearch(apiKey, { query });
    expect(text).toContain('First finding.\n\nSecond finding.');
    expect(text).toContain('[A \\[label\\] next](<https://example.com/a(b)>)');
    expect(text).toContain(
      '[https://example.com/fallback](<https://example.com/fallback>)'
    );
    expect(text).not.toContain('javascript:');
    expect(text).not.toContain('not-a-url');
  });

  it('does not invent citations when no sources were returned', async () => {
    mockResponse(completed('No reliable evidence was found.', []));
    expect((await runParallelResearch(apiKey, { query })).text).toBe(
      'No reliable evidence was found.'
    );
  });

  it.each([
    [{ status: 'in_progress', output: [] }, 'not completed'],
    [{ status: 'completed' }, 'without output messages'],
    [{ status: 'completed', output: [] }, 'empty research response'],
    [completed(' \n'), 'empty research response'],
  ])('rejects incomplete or empty responses: %j', async (payload, error) => {
    const fetchMock = mockResponse(payload);
    await expect(runParallelResearch(apiKey, { query })).rejects.toThrow(
      String(error)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['in_progress', 'incomplete'])(
    'rejects an answer message marked %s even when the response is completed',
    async (status) => {
      const payload = completed('Partial answer.');
      Object.assign(payload.output[0], { status });
      const fetchMock = mockResponse(payload);
      await expect(runParallelResearch(apiKey, { query })).rejects.toThrow(
        'not completed'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    null,
    {},
    { type: 'message', content: null },
    { type: 'message', content: [null] },
    {
      type: 'message',
      content: [{ type: 'output_text', text: 42 }],
    },
  ])(
    'rejects malformed answer parts instead of returning partial text: %j',
    async (item) => {
      const payload = completed('Only the first part of the answer.');
      const fetchMock = mockResponse({
        ...payload,
        output: [...payload.output, item],
      });
      await expect(runParallelResearch(apiKey, { query })).rejects.toThrow(
        'malformed research output'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});

describe('Parallel research failure lifecycle', () => {
  it.each([401, 429, 500])(
    'does not retry HTTP %s and preserves safe status',
    async (status) => {
      const fetchMock = mockResponse(
        { error: { message: `Rejected key ${apiKey}` } },
        status
      );
      await expect(
        runParallelResearch(apiKey, { query })
      ).rejects.toMatchObject({
        status,
        message: `Parallel Responses request failed (${status}): Rejected key [REDACTED]`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('reports non-JSON HTTP errors with their status', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>Unavailable</html>', { status: 503 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(runParallelResearch(apiKey, { query })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry malformed JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('not JSON'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runParallelResearch(apiKey, { query })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds network errors and redacts the key', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`${apiKey} ${'x'.repeat(5_000)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const error = await runParallelResearch(apiKey, { query }).catch(
      (value: Error) => value
    );
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(apiKey);
    expect(message.length).toBeLessThanOrEqual(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends no request when already cancelled', async () => {
    const fetchMock = mockResponse();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runParallelResearch(apiKey, { query }, controller.signal)
    ).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an in-flight request without retrying', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = runParallelResearch(apiKey, { query }, controller.signal);
    const assertion = expect(result).rejects.toThrow('cancelled');
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body'])(
    'keeps the timeout active while waiting for %s',
    async (phase) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (phase === 'headers') {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true }
            );
          });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":'));
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('aborted')),
                { once: true }
              );
            },
          })
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const result = runParallelResearch(apiKey, { query });
      const assertion = expect(result).rejects.toThrow(
        'timed out after 120 seconds'
      );
      await vi.advanceTimersByTimeAsync(PARALLEL_RESPONSES_TIMEOUT_MS);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
