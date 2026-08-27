declare const __PACKAGE_VERSION__: string;

export const PARALLEL_RESPONSES_URL = 'https://api.parallel.ai/v1/responses';
export const PARALLEL_RESPONSES_MAX_INPUT_CHARS = 20_000;
export const PARALLEL_RESPONSES_TIMEOUT_MS = 120_000;
export const DEFAULT_RESEARCH_EFFORT = 'medium';

export type ResearchEffort = 'low' | 'medium' | 'high';

export interface ResearchInput {
  query: string;
  effort?: ResearchEffort;
}

// Only these instructions and the explicit question cross the research boundary.
// Do not assemble this prompt from Pi's session, system prompt, or local files.
const RESEARCH_INSTRUCTIONS =
  "Research the user's question using current web sources. Return a direct, evidence-based answer with citations. State uncertainty when the sources do not support a conclusion.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderResearch(payload: unknown): string {
  if (!isRecord(payload) || payload.status !== 'completed') {
    throw new Error('Parallel returned a response that was not completed.');
  }
  if (!Array.isArray(payload.output)) {
    throw new Error('Parallel returned a response without output messages.');
  }

  const texts: string[] = [];
  const sources = new Map<string, string>();
  for (const item of payload.output) {
    if (
      !isRecord(item) ||
      item.type !== 'message' ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const content of item.content) {
      if (
        !isRecord(content) ||
        content.type !== 'output_text' ||
        typeof content.text !== 'string'
      ) {
        continue;
      }
      texts.push(content.text);
      if (!Array.isArray(content.annotations)) continue;
      for (const citation of content.annotations) {
        if (
          !isRecord(citation) ||
          citation.type !== 'url_citation' ||
          typeof citation.url !== 'string'
        ) {
          continue;
        }
        let url: URL;
        try {
          url = new URL(citation.url);
        } catch {
          continue;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        const href = url.toString();
        const title =
          typeof citation.title === 'string' ? citation.title.trim() : '';
        if (!sources.has(href)) sources.set(href, title || href);
      }
    }
  }

  const text = texts.join('\n\n').trim();
  if (!text) throw new Error('Parallel returned an empty research response.');
  if (sources.size === 0) return text;

  const list = [...sources].map(([url, title], index) => {
    const label = title
      .replaceAll('\\', '\\\\')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]')
      .replace(/[\r\n]+/g, ' ');
    const href = url.replaceAll('<', '%3C').replaceAll('>', '%3E');
    return `${index + 1}. [${label}](<${href}>)`;
  });
  return `${text}\n\nSources:\n${list.join('\n')}`;
}

function safeError(error: unknown, apiKey: string): Error {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Unknown research failure';
  }
  if (apiKey) message = message.replaceAll(apiKey, '[REDACTED]');
  const result = new Error(
    (message.trim() || 'Unknown research failure').slice(0, 1_000)
  );
  // Preserve HTTP status for the extension's existing authentication guidance.
  if (isRecord(error) && typeof error.status === 'number') {
    Object.assign(result, { status: error.status });
  }
  return result;
}

export async function runParallelResearch(
  apiKey: string,
  input: ResearchInput,
  signal?: AbortSignal
): Promise<{ text: string; effort: ResearchEffort }> {
  if (typeof input.query !== 'string' || !input.query.trim()) {
    throw new Error('Parallel Research requires a non-empty question.');
  }
  const effort = input.effort ?? DEFAULT_RESEARCH_EFFORT;
  if (!['low', 'medium', 'high'].includes(effort)) {
    throw new Error('Parallel Research effort must be low, medium, or high.');
  }
  if (
    [...input.query].length + [...RESEARCH_INSTRUCTIONS].length >
    PARALLEL_RESPONSES_MAX_INPUT_CHARS
  ) {
    throw new Error(
      'Parallel Research exceeds the 20,000-character input limit, including research instructions.'
    );
  }
  if (!apiKey) {
    throw new Error(
      'Parallel authentication required. Run `/login parallel` in Pi, or set PARALLEL_API_KEY.'
    );
  }

  const deadline = new AbortController();
  const requestSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  // Keep the deadline active through body consumption, not just response headers.
  const timeout = setTimeout(
    () => deadline.abort(),
    PARALLEL_RESPONSES_TIMEOUT_MS
  );
  timeout.unref?.();
  try {
    requestSignal.throwIfAborted();
    const response = await fetch(PARALLEL_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Tool-Calling-Package': `npm:@parallel-web/pi-extension/v${__PACKAGE_VERSION__ ?? '0.0.0'}`,
      },
      body: JSON.stringify({
        model: 'parallel',
        input: input.query,
        instructions: RESEARCH_INSTRUCTIONS,
        reasoning: { effort },
        stream: false,
      }),
      signal: requestSignal,
      redirect: 'error',
    });

    if (!response.ok) {
      let message = response.statusText || 'request failed';
      try {
        const payload: unknown = await response.json();
        if (
          isRecord(payload) &&
          isRecord(payload.error) &&
          typeof payload.error.message === 'string'
        ) {
          message = payload.error.message;
        }
      } catch {
        // A non-JSON error still has a useful HTTP status.
      }
      requestSignal.throwIfAborted();
      throw Object.assign(
        new Error(
          `Parallel Responses request failed (${response.status}): ${message}`
        ),
        { status: response.status }
      );
    }

    const payload: unknown = await response.json();
    requestSignal.throwIfAborted();
    return { text: renderResearch(payload), effort };
  } catch (error) {
    if (signal?.aborted) throw new Error('Parallel Research cancelled.');
    if (deadline.signal.aborted)
      throw new Error('Parallel Research timed out after 120 seconds.');
    throw safeError(error, apiKey);
  } finally {
    clearTimeout(timeout);
  }
}
