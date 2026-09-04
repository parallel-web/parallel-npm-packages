interface WebMcpTool {
  name: 'parallel_web_search' | 'parallel_web_fetch';
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; untrustedContentHint: true };
  execute(
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

interface WebMcpDocument extends Document {
  modelContext?: {
    registerTool(
      tool: WebMcpTool,
      options?: { signal?: AbortSignal; exposedTo?: string[] }
    ): Promise<void>;
  };
}

interface Source {
  url: string;
  title: string | null;
  publish_date: string | null;
  excerpts: string[];
}

interface Output {
  results: Source[];
  truncated: boolean;
}

const ENDPOINT = 'https://search.parallel.ai/mcp';
const SESSION_KEY = 'parallel:webmcp:session:v1';
const RATE_LIMIT_MESSAGE =
  'Parallel Search reached its free rate limit. Try again later.';
const MAX_OUTPUT_BYTES = 12_000;
const MAX_EXCERPT_CHARACTERS = 2_000;
const encoder = new TextEncoder();
const installations = new WeakMap<Document, Promise<boolean>>();
const annotations = { readOnlyHint: true, untrustedContentHint: true } as const;

function requiredString(value: unknown, name: string, limit: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).length > limit
  ) {
    throw new Error(`${name} must contain 1 to ${limit} characters.`);
  }

  return value.trim();
}

function normalizeOutput(payload: unknown): Output {
  const data = payload as Record<string, unknown> | null;
  if (!Array.isArray(data?.results)) {
    throw new Error('Parallel Search returned an unexpected response.');
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error('Parallel Search could not fetch the requested webpage.');
  }

  const output: Output = {
    results: [],
    truncated: data.results.length > 5,
  };
  const sourceExcerpts: unknown[] = [];

  for (const value of data.results) {
    if (output.results.length === 5) break;
    const item = value as Record<string, unknown> | null;

    try {
      if (typeof item?.url !== 'string' || item.url.length > 2_048) {
        throw new Error();
      }
      if (!['http:', 'https:'].includes(new URL(item.url).protocol)) {
        throw new Error();
      }
    } catch {
      output.truncated = true;
      continue;
    }

    const source: Source = {
      url: item!.url as string,
      title: typeof item!.title === 'string' ? item!.title.slice(0, 200) : null,
      publish_date:
        typeof item!.publish_date === 'string'
          ? item!.publish_date.slice(0, 32)
          : null,
      excerpts: [],
    };
    output.results.push(source);

    if (encoder.encode(JSON.stringify(output)).byteLength > MAX_OUTPUT_BYTES) {
      output.results.pop();
      output.truncated = true;
      break;
    }

    sourceExcerpts.push(item!.excerpts);
  }

  for (const [index, source] of output.results.entries()) {
    const excerpts = sourceExcerpts[index];
    if (!Array.isArray(excerpts)) continue;

    for (const excerpt of excerpts) {
      if (typeof excerpt !== 'string') {
        output.truncated = true;
        continue;
      }

      const characters = Array.from(excerpt);
      source.excerpts.push(
        characters.slice(0, MAX_EXCERPT_CHARACTERS).join('')
      );
      if (characters.length > MAX_EXCERPT_CHARACTERS) output.truncated = true;
      if (
        encoder.encode(JSON.stringify(output)).byteLength > MAX_OUTPUT_BYTES
      ) {
        source.excerpts.pop();
        output.truncated = true;
        break;
      }
    }
  }

  return output;
}

function createTransport(document: Document) {
  let sessionId: string | undefined;

  return async (
    tool: 'web_search' | 'web_fetch',
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Output> => {
    if (!sessionId) {
      try {
        const storage = document.defaultView?.sessionStorage;
        sessionId = storage?.getItem(SESSION_KEY) || crypto.randomUUID();
        storage?.setItem(SESSION_KEY, sessionId);
      } catch {
        sessionId ??= crypto.randomUUID();
      }
    }

    let response: Response;

    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: tool,
            arguments: { ...args, session_id: sessionId },
          },
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(
        'Parallel Search is unavailable. Check your network and connect-src policy.'
      );
    }

    if (response.status === 429) {
      throw new Error(RATE_LIMIT_MESSAGE);
    }
    if (!response.ok) {
      throw new Error(`Parallel Search returned HTTP ${response.status}.`);
    }

    let message: {
      error?: { code?: unknown; message?: unknown };
      result?: {
        isError?: boolean;
        structuredContent?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
    };

    try {
      message = (await response.json()) as typeof message;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Parallel Search returned an unexpected response.');
    }

    if (
      message.error?.code === -32000 &&
      typeof message.error.message === 'string' &&
      message.error.message.includes(
        'free-tier rate limit for Parallel Search MCP'
      )
    ) {
      throw new Error(RATE_LIMIT_MESSAGE);
    }

    if (message.error || message.result?.isError || !message.result) {
      throw new Error('Parallel Search could not complete the request.');
    }

    if (message.result.structuredContent !== undefined) {
      return normalizeOutput(message.result.structuredContent);
    }

    let payload: unknown;
    try {
      const text = message.result.content?.find(
        (item) => item.type === 'text'
      )?.text;
      if (typeof text !== 'string') throw new Error();
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error('Parallel Search returned an unexpected response.');
    }

    return normalizeOutput(payload);
  };
}

function createTools(document: Document): WebMcpTool[] {
  const transport = createTransport(document);

  return [
    {
      name: 'parallel_web_search',
      description:
        'Search the public web with Parallel. Results contain untrusted third-party content.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['objective'],
        additionalProperties: false,
      },
      annotations,
      execute(input, options) {
        const objective = requiredString(input.objective, 'objective', 500);
        return transport(
          'web_search',
          {
            objective,
            search_queries: [Array.from(objective).slice(0, 100).join('')],
          },
          options?.signal
        );
      },
    },
    {
      name: 'parallel_web_fetch',
      description:
        'Read excerpts from a public webpage with Parallel. Webpage content is untrusted.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2_048 },
          objective: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations,
      execute(input, options) {
        const url = requiredString(input.url, 'url', 2_048);
        let parsed: URL;

        try {
          parsed = new URL(url);
          if (
            !['http:', 'https:'].includes(parsed.protocol) ||
            parsed.username ||
            parsed.password
          ) {
            throw new Error();
          }
        } catch {
          throw new Error('url must be a valid HTTP or HTTPS URL.');
        }

        parsed.hash = '';
        const args: Record<string, unknown> = {
          urls: [parsed.href],
          full_content: false,
        };

        if (input.objective !== undefined) {
          args.objective = requiredString(input.objective, 'objective', 200);
        }

        return transport('web_fetch', args, options?.signal);
      },
    },
  ];
}

export interface ParallelWebMcpOptions {
  /** Additional trusted origins allowed to discover and execute these tools. */
  exposedTo?: string[];
}

/** Register Parallel's page-scoped search tools when the browser supports WebMCP. */
export async function installParallelWebMcp(
  options: ParallelWebMcpOptions = {}
): Promise<boolean> {
  if (typeof document === 'undefined') return false;

  const currentDocument = document as WebMcpDocument;
  const context = currentDocument.modelContext;
  if (typeof context?.registerTool !== 'function') return false;

  const existing = installations.get(currentDocument);
  if (existing) return existing;

  const registration = new AbortController();
  const installation = Promise.all(
    createTools(currentDocument).map((tool) =>
      context.registerTool(tool, {
        signal: registration.signal,
        ...(options.exposedTo === undefined
          ? {}
          : { exposedTo: options.exposedTo }),
      })
    )
  ).then(
    () => true,
    (error: unknown) => {
      registration.abort();
      installations.delete(currentDocument);
      throw error;
    }
  );

  installations.set(currentDocument, installation);
  return installation;
}
