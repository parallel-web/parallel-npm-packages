import { vi } from 'vitest';

export interface TestTool {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  execute(
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

interface TestContext {
  registerTool(
    tool: TestTool,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
}

export interface TestBrowser {
  document: Document & { modelContext: TestContext };
  context: TestContext;
  registered: Map<string, TestTool>;
  storage: Map<string, string>;
}

export function createBrowser(
  options: {
    existing?: TestTool[];
    failOn?: string;
    storageBlocked?: boolean;
    storage?: Map<string, string>;
  } = {}
): TestBrowser {
  const registered = new Map(
    options.existing?.map((tool) => [tool.name, tool]) ?? []
  );
  const storage = options.storage ?? new Map<string, string>();

  const context: TestContext = {
    registerTool: vi.fn(async (tool, registration) => {
      if (registered.has(tool.name) || options.failOn === tool.name) {
        throw new Error(`Tool ${tool.name} is already registered.`);
      }

      registered.set(tool.name, tool);
      registration?.signal?.addEventListener(
        'abort',
        () => registered.delete(tool.name),
        { once: true }
      );
    }),
  };

  const sessionStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  };

  const defaultView = {};
  Object.defineProperty(defaultView, 'sessionStorage', {
    configurable: true,
    get() {
      if (options.storageBlocked) throw new Error('Storage is disabled.');
      return sessionStorage;
    },
  });

  const document = {
    modelContext: context,
    defaultView,
  } as TestBrowser['document'];
  return { document, context, registered, storage };
}

export function upstreamResponse(
  id: number,
  payload: Record<string, unknown>,
  options: { structured?: boolean } = {}
): Response {
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: {
      ...(options.structured === false ? {} : { structuredContent: payload }),
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  });
}

export function searchPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    search_id: 'search_test',
    session_id: 'upstream-session-should-not-be-returned',
    results: [
      {
        url: 'https://example.com/result',
        title: 'Example result',
        publish_date: '2026-08-25',
        excerpts: ['A useful public-web excerpt.'],
      },
    ],
    ...overrides,
  };
}

export function fetchPayload(): Record<string, unknown> {
  return {
    extract_id: 'extract_test',
    results: [
      {
        url: 'https://example.com/article',
        title: 'Example article',
        publish_date: null,
        excerpts: ['A useful extracted excerpt.'],
        full_content: 'This should never be returned.',
      },
    ],
  };
}
