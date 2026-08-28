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
      PARALLEL_RESPONSES_MAX_INPUT_CHARS - [...instructions].length - 1;
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

describe('Parallel research continuation', () => {
  it('forwards an explicit opaque ID and returns the new response ID', async () => {
    const fetchMock = mockResponse({ ...completed(), id: 'resp_new' });
    const result = await runParallelResearch(apiKey, {
      query: 'Which of those findings applies to our constraints?',
      previous_response_id: 'opaque.v2:branch-A',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      model: 'parallel',
      input: 'Which of those findings applies to our constraints?',
      instructions: expect.stringContaining('Research the user'),
      reasoning: { effort: 'medium' },
      stream: false,
      previous_response_id: 'opaque.v2:branch-A',
    });
    expect(result).toMatchObject({ responseId: 'resp_new', effort: 'medium' });
    expect(result.text).toContain('https://example.com/source');
  });

  it('chains only the IDs explicitly supplied and leaves unrelated calls independent', async () => {
    let count = 0;
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ ...completed(), id: `resp_${++count}` }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = await runParallelResearch(apiKey, { query });
    const second = await runParallelResearch(apiKey, {
      query: 'Compare the findings.',
      previous_response_id: first.responseId,
    });
    await runParallelResearch(apiKey, {
      query: 'Check the second answer.',
      previous_response_id: second.responseId,
    });
    await runParallelResearch(apiKey, {
      query: 'An unrelated research question.',
    });
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body))
    );
    expect(bodies.map((body) => body.previous_response_id)).toEqual([
      undefined,
      'resp_1',
      'resp_2',
      undefined,
    ]);
    expect(bodies[0]).not.toHaveProperty('previous_response_id');
    expect(bodies[3]).not.toHaveProperty('previous_response_id');
  });

  it.each([
    null,
    42,
    false,
    {},
    [],
    '',
    ' ',
    'resp one',
    'resp_\n',
    'resp_\u0000',
    'x'.repeat(513),
  ])(
    'rejects unusable explicit continuation IDs before dispatch: %j',
    async (previous_response_id) => {
      const fetchMock = mockResponse();
      await expect(
        runParallelResearch(apiKey, {
          query,
          previous_response_id,
        } as ResearchInput)
      ).rejects.toThrow('previous_response_id');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('accepts the tool ID length boundary without trimming or rewriting it', async () => {
    const id = 'x'.repeat(512);
    const fetchMock = mockResponse({ ...completed(), id });
    expect(
      (await runParallelResearch(apiKey, { query, previous_response_id: id }))
        .responseId
    ).toBe(id);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).previous_response_id
    ).toBe(id);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'resp one',
    'resp_\n',
    'resp_\u0000',
    'x'.repeat(513),
  ])(
    'keeps a valid answer without advertising unusable returned IDs: %j',
    async (id) => {
      mockResponse({ ...completed(), id, previous_response_id: 'resp_old' });
      const result = await runParallelResearch(apiKey, {
        query,
        previous_response_id: 'resp_old',
      });
      expect(result.text).toContain('The researched answer.');
      expect(result.text).toContain('https://example.com/source');
      expect(result).not.toHaveProperty('responseId');
    }
  );

  it.each([
    [404, 'Interaction context not found: resp_missing'],
    [
      400,
      'previous_interaction_id is not supported for zero data retention (ZDR) customers. Interaction context cannot be persisted under ZDR.',
    ],
  ])(
    'preserves continuation HTTP %s without retrying as fresh research',
    async (status, message) => {
      const fetchMock = mockResponse({ error: { message } }, Number(status));
      await expect(
        runParallelResearch(apiKey, {
          query,
          previous_response_id: 'resp_missing',
        })
      ).rejects.toMatchObject({
        status,
        message: expect.stringContaining(String(message)),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
          .previous_response_id
      ).toBe('resp_missing');
    }
  );
});

describe('Parallel research evidence', () => {
  it.each([
    '    const answer = 42;\n    console.log(answer);\n',
    '\tconst answer = "🔎";\r\n',
    '\n\nA researched answer.\n\n',
    'A researched answer.  ',
  ])('preserves answer whitespace without citations: %j', async (answer) => {
    mockResponse(completed(answer, []));
    expect((await runParallelResearch(apiKey, { query })).text).toBe(answer);
  });

  it('preserves the cited passages for each source using Unicode character ranges', async () => {
    const first = 'Alpha shipped in 2024.';
    const second = 'Beta shipped in 2025.';
    const answer = '🔎 ' + first + ' ' + second;
    const firstCitation = {
      type: 'url_citation',
      url: 'https://example.com/alpha',
      title: 'Alpha source',
      start_index: 2,
      end_index: 2 + [...first].length,
    };
    mockResponse(
      completed(answer, [
        firstCitation,
        firstCitation,
        {
          ...firstCitation,
          url: 'https://example.com/both',
          title: 'Combined source',
        },
        {
          ...firstCitation,
          url: 'https://example.com/both',
          title: 'Combined source',
          start_index: 3 + [...first].length,
          end_index: [...answer].length,
        },
      ])
    );
    const { text } = await runParallelResearch(apiKey, { query });
    expect(text.startsWith(answer + '\n\nSources:\n')).toBe(true);
    const sources = text.split('\nSources:\n')[1];
    const alpha = sources.slice(sources.indexOf('1. '), sources.indexOf('2. '));
    const both = sources.slice(sources.indexOf('2. '));
    expect(alpha.match(/Cited answer passage/g)).toHaveLength(1);
    expect(alpha).toContain(JSON.stringify(first));
    expect(alpha).not.toContain(JSON.stringify(second));
    expect(both).toContain(JSON.stringify(first));
    expect(both).toContain(JSON.stringify(second));
    expect(alpha).toContain('part 1, characters 2:24');
  });

  it('retains separate locations and overlapping spans for the same source', async () => {
    const claim = 'Revenue increased 10%.';
    const answer = 'Company A\n' + claim + '\n\nCompany B\n' + claim;
    const startA = [...'Company A\n'].length;
    const startB = [...('Company A\n' + claim + '\n\nCompany B\n')].length;
    const citation = {
      type: 'url_citation',
      url: 'https://example.com/revenue',
      start_index: startA,
      end_index: startA + [...claim].length,
    };
    mockResponse(
      completed(answer, [
        citation,
        {
          ...citation,
          start_index: startB,
          end_index: startB + [...claim].length,
        },
        { ...citation, end_index: startA + [...'Revenue increased'].length },
      ])
    );
    const { text } = await runParallelResearch(apiKey, { query });
    const sources = text.split('\nSources:\n')[1];
    expect(sources.match(/Cited answer passage/g)).toHaveLength(3);
    expect(sources.match(/"Revenue increased 10%."/g)).toHaveLength(2);
    expect(sources).toContain('characters 10:32');
    expect(sources).toContain('characters 44:66');
    expect(sources).toContain('"Revenue increased"');
  });

  it('resolves each passage against its original text part without editing Markdown', async () => {
    const first = '    🔎 A [link](https://example.com/path).\n';
    const second = 'Code:\n\n~~~js\nconst value = "🔎";\n~~~\n';
    const passage = 'const value = "🔎";';
    const firstStart = [...'    🔎 '].length;
    const secondStart = [...'Code:\n\n~~~js\n'].length;
    const payload = completed(first, [
      {
        type: 'url_citation',
        url: 'https://example.com/first',
        start_index: firstStart,
        end_index: [...first].length - 1,
      },
    ]);
    payload.output[0].content.push({
      type: 'output_text',
      text: second,
      annotations: [
        {
          type: 'url_citation',
          url: 'https://example.com/code',
          start_index: secondStart,
          end_index: secondStart + [...passage].length,
        },
      ],
    });
    mockResponse(payload);
    const { text } = await runParallelResearch(apiKey, { query });
    expect(text.split('\n\nSources:\n')[0]).toBe([first, second].join('\n\n'));
    expect(text).toContain('part 1, characters 6:');
    expect(text).toContain('part 2, characters 13:');
    expect(text).toContain(JSON.stringify(passage));
    expect(text).toContain(
      JSON.stringify('A [link](https://example.com/path).')
    );
  });

  it.each([
    [0, 0],
    [-1, 5],
    [3, 3],
    [5, 1],
    [0, 200],
    [0.5, 3],
    [0, 3.5],
    ['0', 4],
    [0, '4'],
    [null, 4],
    [0, null],
    [undefined, 4],
    [0, undefined],
  ])(
    'keeps the source without inventing a passage for indices %j:%j',
    async (start, end) => {
      mockResponse(
        completed('A finding.', [
          {
            type: 'url_citation',
            url: 'https://example.com/source',
            start_index: start,
            end_index: end,
          },
        ])
      );
      const { text } = await runParallelResearch(apiKey, { query });
      expect(text).toContain('](<https://example.com/source>)');
      expect(text).not.toContain('Cited answer passage');
      expect(text).not.toContain('character offsets');
    }
  );

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
    ['https://example.com/?q=\\[tag]', 'https://example.com/?q=%5C[tag]'],
    ['https://example.com/#trail\\', 'https://example.com/#trail%5C'],
  ])('preserves literal backslashes in source URLs: %s', async (url, href) => {
    mockResponse(completed('Answer.', [{ type: 'url_citation', url }]));
    expect((await runParallelResearch(apiKey, { query })).text).toContain(
      `](<${href}>)`
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

  it('does not expose response excerpts through JSON parse errors', async () => {
    const secret = 'fixture-secret-key-0123456789abcdefghijklmnopqrstuvwxyz';
    const fetchMock = vi.fn(async () => new Response(secret));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runParallelResearch(secret, { query })).rejects.toThrow(
      'Parallel returned malformed research JSON.'
    );
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
