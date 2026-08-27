declare const __PACKAGE_VERSION__: string;

import Parallel from 'parallel-web';

export interface ParallelSearchInput {
  objective: string;
  search_queries: string[];
  client_model?: string;
  session_id?: string;
}

export interface ParallelExtractInput {
  urls: string[];
  objective?: string;
  search_queries?: string[];
  client_model?: string;
  session_id?: string;
}

function createParallelClient(apiKey: string) {
  return new Parallel({
    apiKey,
    defaultHeaders: {
      'X-Tool-Calling-Package': `npm:@parallel-web/pi-extension/v${__PACKAGE_VERSION__ ?? '0.0.0'}`,
    },
  });
}

export async function runParallelSearch(
  apiKey: string,
  input: ParallelSearchInput,
  signal?: AbortSignal
) {
  const client = createParallelClient(apiKey);
  return await client.search(
    {
      objective: input.objective,
      search_queries: input.search_queries,
      mode: 'fast',
      client_model: input.client_model,
      session_id: input.session_id,
    },
    { signal }
  );
}

export async function runParallelExtract(
  apiKey: string,
  input: ParallelExtractInput,
  signal?: AbortSignal
) {
  const client = createParallelClient(apiKey);
  // Rely on the default excerpt behavior: with an objective/search_queries the
  // excerpts are focused on the relevant content; without them Extract returns
  // whole-page markdown. We intentionally do NOT force `full_content` — enabling
  // it without an objective/search_queries makes excerpts redundant (and the API
  // warns about it). See https://docs.parallel.ai/extract/best-practices.
  return await client.extract(
    {
      urls: input.urls,
      objective: input.objective,
      search_queries: input.search_queries,
      client_model: input.client_model,
      session_id: input.session_id,
    },
    { signal }
  );
}

export function isParallelAuthenticationError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;

  return (
    status === 401 ||
    error.name === 'AuthenticationError' ||
    /unauthorized|authentication|api key/i.test(error.message)
  );
}
