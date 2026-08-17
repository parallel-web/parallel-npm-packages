import Parallel, {
  APIUserAbortError,
  type Parallel as ParallelTypes,
} from 'parallel-web';
import { WebError } from '@deepseek-ai/dsh-web';
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web';

export const PARALLEL_PROVIDER_ID = 'parallel';
export const PARALLEL_API_ORIGIN = 'https://api.parallel.ai';
export const DEFAULT_MAX_CHARS_TOTAL = 25_000;
export const PARALLEL_SEARCH_MODES = ['turbo', 'basic', 'advanced'] as const;

export type ParallelSearchMode = (typeof PARALLEL_SEARCH_MODES)[number];

export interface ParallelSearchProviderOptions {
  apiKey: string;
  mode?: ParallelSearchMode;
  maxCharsTotal: number;
  maxCharsPerResult?: number;
}

export interface SearchClient {
  search(
    body: ParallelTypes.SearchParams,
    options: ParallelTypes.RequestOptions
  ): PromiseLike<unknown>;
}

export type SearchClientFactory = (apiKey: string) => SearchClient;

const createProductionClient: SearchClientFactory = (apiKey) =>
  new Parallel({
    apiKey,
    baseURL: PARALLEL_API_ORIGIN,
  });

/**
 * Parallel-backed search provider. The SDK client is created lazily so an
 * unavailable provider never constructs a credential-bearing client.
 */
export class ParallelSearchProvider implements WebSearchProvider {
  readonly id = PARALLEL_PROVIDER_ID;
  private client: SearchClient | undefined;

  constructor(
    private readonly options: ParallelSearchProviderOptions,
    private readonly createClient: SearchClientFactory = createProductionClient
  ) {}

  available(): boolean {
    return (
      this.options.apiKey.length > 0 &&
      isMode(this.options.mode) &&
      isPositiveInteger(this.options.maxCharsTotal) &&
      (this.options.maxCharsPerResult === undefined ||
        isPositiveInteger(this.options.maxCharsPerResult))
    );
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal
  ): Promise<WebSearchResult> {
    if (signal?.aborted) throw abortedError();

    let payload: unknown;
    try {
      payload = await this.getClient().search(
        buildSearchBody(request, this.options),
        {
          signal,
          maxRetries: 0,
          timeout: 60_000,
          fetchOptions: { redirect: 'error' },
        }
      );
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof APIUserAbortError)
        throw abortedError(error, this.options.apiKey);
      throw providerError(
        'Parallel search request failed',
        error,
        this.options.apiKey
      );
    }

    try {
      return mapParallelResponse(payload);
    } catch (error: unknown) {
      throw providerError(
        'Parallel returned an invalid search response',
        error,
        this.options.apiKey
      );
    }
  }

  private getClient(): SearchClient {
    return (this.client ??= this.createClient(this.options.apiKey));
  }
}

export function buildSearchBody(
  request: WebSearchRequest,
  options: Pick<
    ParallelSearchProviderOptions,
    'mode' | 'maxCharsTotal' | 'maxCharsPerResult'
  >
): ParallelTypes.SearchParams {
  const excerptSettings =
    options.maxCharsPerResult === undefined
      ? undefined
      : { max_chars_per_result: options.maxCharsPerResult };
  const advancedSettings =
    request.maxResults === undefined && excerptSettings === undefined
      ? undefined
      : {
          ...(request.maxResults === undefined
            ? {}
            : { max_results: request.maxResults }),
          ...(excerptSettings === undefined
            ? {}
            : { excerpt_settings: excerptSettings }),
        };

  return {
    objective: request.query,
    search_queries: [request.query],
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    max_chars_total: options.maxCharsTotal,
    ...(advancedSettings === undefined
      ? {}
      : { advanced_settings: advancedSettings }),
  };
}

export function mapParallelResponse(payload: unknown): WebSearchResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new TypeError('response.results must be an array');
  }

  return {
    sources: payload.results.map(mapParallelResult),
    truncated: false,
  };
}

function mapParallelResult(value: unknown): WebSearchSource {
  if (!isRecord(value)) throw new TypeError('each result must be an object');
  if (typeof value.url !== 'string' || value.url.trim().length === 0) {
    throw new TypeError('result.url must be a nonblank string');
  }
  if (
    !Array.isArray(value.excerpts) ||
    !value.excerpts.every((excerpt) => typeof excerpt === 'string')
  ) {
    throw new TypeError('result.excerpts must be an array of strings');
  }

  const title = optionalNonblankString(value.title, 'result.title');
  const publishedAt = optionalNonblankString(
    value.publish_date,
    'result.publish_date'
  );
  const excerpts = value.excerpts.filter(
    (excerpt) => excerpt.trim().length > 0
  );

  return {
    url: value.url,
    ...(title === undefined ? {} : { title }),
    ...(excerpts.length === 0 ? {} : { snippet: excerpts.join('\n\n') }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

function optionalNonblankString(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string')
    throw new TypeError(`${field} must be a string, null, or absent`);
  return value.trim().length === 0 ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isMode(value: unknown): value is ParallelSearchMode | undefined {
  return (
    value === undefined || PARALLEL_SEARCH_MODES.some((mode) => mode === value)
  );
}

function abortedError(cause?: unknown, apiKey = ''): WebError {
  return new WebError(
    'Parallel search aborted',
    'WEB_ABORTED',
    cause === undefined ? {} : { cause: safeDiagnostic(cause, apiKey) }
  );
}

function providerError(
  message: string,
  cause: unknown,
  apiKey: string
): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR', {
    cause: safeDiagnostic(cause, apiKey),
  });
}

/**
 * Preserve one useful diagnostic message without retaining an SDK error,
 * stack, nested cause, or credential-bearing transport metadata.
 */
function safeDiagnostic(error: unknown, apiKey: string): Error {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Unrenderable provider failure';
  }

  if (apiKey.length > 0) message = message.replaceAll(apiKey, '[REDACTED]');
  return new Error(
    message.trim().length > 0 ? message : 'Unknown provider failure'
  );
}
