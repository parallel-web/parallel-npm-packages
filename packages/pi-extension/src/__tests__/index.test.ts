import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

const mocks = vi.hoisted(() => ({
  getParallelApiKey: vi.fn(),
  loginWithParallel: vi.fn(),
  clearStoredParallelApiKey: vi.fn(),
  runParallelSearch: vi.fn(),
  runParallelExtract: vi.fn(),
  isParallelAuthenticationError: vi.fn(),
}));

vi.mock('../parallel-auth.js', () => ({
  getParallelApiKey: mocks.getParallelApiKey,
  loginWithParallel: mocks.loginWithParallel,
  clearStoredParallelApiKey: mocks.clearStoredParallelApiKey,
}));

vi.mock('../parallel-client.js', () => ({
  runParallelSearch: mocks.runParallelSearch,
  runParallelExtract: mocks.runParallelExtract,
  isParallelAuthenticationError: mocks.isParallelAuthenticationError,
}));

type MockPi = {
  on: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
};

function createMockPi(): MockPi {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
  };
}

function getRegisteredCommand(pi: MockPi, name: string) {
  return pi.registerCommand.mock.calls.find(
    ([commandName]) => commandName === name
  )?.[1];
}

function getEventHandler(pi: MockPi, eventName: string) {
  return pi.on.mock.calls.find(([name]) => name === eventName)?.[1];
}

function getRegisteredTool(pi: MockPi, name: string) {
  return pi.registerTool.mock.calls
    .map(([tool]) => tool)
    .find((tool) => tool.name === name);
}

function createToolContext(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: false,
    ui: {
      confirm: vi.fn(),
      notify: vi.fn(),
      input: vi.fn(),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

describe('@parallel-web/pi-extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PARALLEL_API_KEY;
    mocks.isParallelAuthenticationError.mockReturnValue(false);
  });

  it('should export the extension as default', async () => {
    const module = await import('../index.js');
    expect(module.default).toBeDefined();
    expect(typeof module.default).toBe('function');
  });

  it('should register the login command and web tools', async () => {
    const extension = (await import('../index.js')).default;
    const pi = createMockPi();

    extension(pi as unknown as ExtensionAPI);

    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'parallel-login',
      expect.objectContaining({
        description:
          'Run Parallel browser login and store the API key in Pi auth',
        handler: expect.any(Function),
      })
    );

    expect(pi.registerTool).toHaveBeenCalledTimes(2);

    const searchTool = getRegisteredTool(pi, 'web_search');
    expect(searchTool).toEqual(
      expect.objectContaining({
        name: 'web_search',
        label: 'Web Search',
        description: expect.stringContaining("Parallel's Search API"),
        promptSnippet: expect.stringContaining("Parallel's Search API"),
        promptGuidelines: [
          'Use web_search when the user asks for current web information, discovery, or source finding.',
          'Provide 2-3 concise keyword search queries when possible; search_queries is required.',
        ],
        execute: expect.any(Function),
      })
    );

    const fetchTool = getRegisteredTool(pi, 'web_fetch');
    expect(fetchTool).toEqual(
      expect.objectContaining({
        name: 'web_fetch',
        label: 'Web Fetch',
        description: expect.stringContaining("Parallel's Extract API"),
        promptSnippet: expect.stringContaining("Parallel's Extract API"),
        promptGuidelines: [
          'Use web_fetch when the user provides one or more URLs and wants the page content or a clean extraction.',
          'Batch multiple URLs into one web_fetch call instead of parallelizing many single-URL calls.',
        ],
        execute: expect.any(Function),
      })
    );
  });

  it('should append web grounding guidance to the system prompt when web tools are active', async () => {
    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const handler = getEventHandler(pi, 'before_agent_start');
    const result = await handler({
      systemPrompt: 'Base system prompt',
      systemPromptOptions: {
        selectedTools: ['web_search', 'read'],
      },
    });

    expect(result).toEqual({
      systemPrompt: expect.stringContaining('Base system prompt'),
    });
    expect(result.systemPrompt).toContain('Grounding and web usage');
    expect(result.systemPrompt).toContain('Use web_search');
    expect(result.systemPrompt).toContain('Use web_fetch');
  });

  it('should suppress overlapping Parallel skills from the system prompt', async () => {
    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const handler = getEventHandler(pi, 'before_agent_start');
    const result = await handler({
      systemPrompt: `Base system prompt
<available_skills>
  <skill>
    <name>parallel-web-search</name>
    <description>Search skill</description>
  </skill>
  <skill>
    <name>parallel-cli-setup</name>
    <description>Setup skill</description>
  </skill>
  <skill>
    <name>result</name>
    <description>Allowed skill</description>
  </skill>
</available_skills>`,
      systemPromptOptions: {
        selectedTools: ['read'],
      },
    });

    expect(result.systemPrompt).not.toContain(
      '<name>parallel-web-search</name>'
    );
    expect(result.systemPrompt).not.toContain(
      '<name>parallel-cli-setup</name>'
    );
    expect(result.systemPrompt).toContain('<name>result</name>');
  });

  it('parallel-login should run browser login and notify on success', async () => {
    mocks.loginWithParallel.mockResolvedValue('stored-api-key');

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const command = getRegisteredCommand(pi, 'parallel-login');
    const ctx = createToolContext();

    await command.handler([], ctx);

    expect(mocks.loginWithParallel).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Parallel login completed.',
      'info'
    );
  });

  it('web_search should use the stored api key when available', async () => {
    mocks.getParallelApiKey.mockResolvedValue('stored-api-key');
    mocks.runParallelSearch.mockResolvedValue({
      results: [{ title: 'Example' }],
    });

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const searchTool = getRegisteredTool(pi, 'web_search');
    const result = await searchTool.execute(
      'tool-call-id',
      {
        objective: 'Find current AI news',
        search_queries: ['ai news', 'llm updates'],
      },
      undefined,
      undefined,
      createToolContext()
    );

    expect(mocks.runParallelSearch).toHaveBeenCalledWith(
      'stored-api-key',
      {
        objective: 'Find current AI news',
        search_queries: ['ai news', 'llm updates'],
        client_model: undefined,
        session_id: expect.any(String),
      },
      undefined
    );
    expect(result.content[0].text).toBe(
      JSON.stringify({ results: [{ title: 'Example' }] }, null, 2)
    );
  });

  it('web_search should prompt for auth, login, and retry when no credentials are present', async () => {
    mocks.getParallelApiKey.mockResolvedValue(undefined);
    mocks.loginWithParallel.mockResolvedValue('fresh-api-key');
    mocks.runParallelSearch.mockResolvedValue({ ok: true });

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const searchTool = getRegisteredTool(pi, 'web_search');
    const ctx = createToolContext({
      hasUI: true,
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        notify: vi.fn(),
        input: vi.fn(),
      },
    });

    const result = await searchTool.execute(
      'tool-call-id',
      { objective: 'Find docs', search_queries: ['parallel docs'] },
      undefined,
      undefined,
      ctx
    );

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      'Parallel authentication required',
      'This tool needs Parallel auth. Start browser login now?'
    );
    expect(mocks.loginWithParallel).toHaveBeenCalledWith(ctx);
    expect(mocks.runParallelSearch).toHaveBeenCalledWith(
      'fresh-api-key',
      {
        objective: 'Find docs',
        search_queries: ['parallel docs'],
        client_model: undefined,
        session_id: expect.any(String),
      },
      undefined
    );
    expect(result.content[0].text).toBe(JSON.stringify({ ok: true }, null, 2));
  });

  it('web_search should reauthenticate and retry on auth failures when UI is available', async () => {
    mocks.getParallelApiKey.mockResolvedValue('stale-api-key');
    mocks.isParallelAuthenticationError.mockReturnValue(true);
    mocks.runParallelSearch
      .mockRejectedValueOnce(new Error('unauthorized'))
      .mockResolvedValueOnce({ ok: true });
    mocks.loginWithParallel.mockResolvedValue('fresh-api-key');

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const searchTool = getRegisteredTool(pi, 'web_search');
    const ctx = createToolContext({
      hasUI: true,
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        notify: vi.fn(),
        input: vi.fn(),
      },
    });

    const result = await searchTool.execute(
      'tool-call-id',
      { objective: 'Find docs', search_queries: ['parallel docs'] },
      undefined,
      undefined,
      ctx
    );

    expect(mocks.clearStoredParallelApiKey).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      'Parallel authentication expired',
      'Stored Parallel auth was rejected. Sign in again now?'
    );
    expect(mocks.runParallelSearch).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toBe(JSON.stringify({ ok: true }, null, 2));
  });

  it('web_search should reject invalid PARALLEL_API_KEY values clearly', async () => {
    process.env.PARALLEL_API_KEY = 'bad-key';
    mocks.getParallelApiKey.mockResolvedValue('bad-key');
    mocks.isParallelAuthenticationError.mockReturnValue(true);
    mocks.runParallelSearch.mockRejectedValue(new Error('unauthorized'));

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const searchTool = getRegisteredTool(pi, 'web_search');

    await expect(
      searchTool.execute(
        'tool-call-id',
        { objective: 'Find docs', search_queries: ['parallel docs'] },
        undefined,
        undefined,
        createToolContext({ hasUI: true })
      )
    ).rejects.toThrow(
      'Parallel rejected PARALLEL_API_KEY. Update or unset it, then try again.'
    );
  });

  it('web_fetch should pass through the objective when provided', async () => {
    mocks.getParallelApiKey.mockResolvedValue('stored-api-key');
    mocks.runParallelExtract.mockResolvedValue({
      url: 'https://parallel.ai/docs',
    });

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const fetchTool = getRegisteredTool(pi, 'web_fetch');
    const result = await fetchTool.execute(
      'tool-call-id',
      {
        urls: ['https://parallel.ai/docs', 'https://parallel.ai/blog'],
        objective: 'Summarize the authentication flow',
        search_queries: ['parallel auth flow'],
      },
      undefined,
      undefined,
      createToolContext()
    );

    expect(mocks.runParallelExtract).toHaveBeenCalledWith(
      'stored-api-key',
      {
        urls: ['https://parallel.ai/docs', 'https://parallel.ai/blog'],
        objective: 'Summarize the authentication flow',
        search_queries: ['parallel auth flow'],
        client_model: undefined,
        session_id: expect.any(String),
      },
      undefined
    );
    expect(result.details).toEqual({
      provider: 'parallel',
      product: 'extract',
      urls: ['https://parallel.ai/docs', 'https://parallel.ai/blog'],
    });
  });

  it('tool results should be truncated when the sdk returns large payloads', async () => {
    mocks.getParallelApiKey.mockResolvedValue('stored-api-key');
    mocks.runParallelSearch.mockResolvedValue({
      items: Array.from({ length: 5000 }, (_, index) => `result-${index}`),
    });

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const searchTool = getRegisteredTool(pi, 'web_search');
    const result = await searchTool.execute(
      'tool-call-id',
      { objective: 'Find many results', search_queries: ['many results'] },
      undefined,
      undefined,
      createToolContext()
    );

    expect(result.content[0].text).toContain('[Output truncated: showing');
  });

  it('should forward the active model id as client_model', async () => {
    mocks.getParallelApiKey.mockResolvedValue('stored-api-key');
    mocks.runParallelSearch.mockResolvedValue({ ok: true });

    const extension = (await import('../index.js')).default;
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    const searchTool = getRegisteredTool(pi, 'web_search');
    await searchTool.execute(
      'tool-call-id',
      { objective: 'Find docs', search_queries: ['parallel docs'] },
      undefined,
      undefined,
      createToolContext({ model: { id: 'gpt-5.4' } })
    );

    expect(mocks.runParallelSearch).toHaveBeenCalledWith(
      'stored-api-key',
      expect.objectContaining({
        client_model: 'gpt-5.4',
      }),
      undefined
    );
  });
});
