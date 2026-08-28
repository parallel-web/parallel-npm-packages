declare const __PACKAGE_VERSION__: string;

export const PARALLEL_RESPONSES_URL = 'https://api.parallel.ai/v1/responses';
export const PARALLEL_RESPONSES_MAX_INPUT_CHARS = 20_000;
export const PARALLEL_RESPONSES_TIMEOUT_MS = 120_000;
export const DEFAULT_RESEARCH_EFFORT = 'medium';
export const MAX_RESPONSE_ID_LENGTH = 512;

export type ResearchEffort = 'low' | 'medium' | 'high';

export interface ResearchInput {
  query: string;
  effort?: ResearchEffort;
  previous_response_id?: string;
}

// Only these instructions, the explicit question and optional continuation ID
// cross the research boundary.
// Do not assemble this prompt from Pi's session, system prompt, or local files.
const RESEARCH_INSTRUCTIONS =
  "Research the user's question using current web sources. Return a direct, evidence-based answer with citations. State uncertainty when the sources do not support a conclusion.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// IDs are opaque. Bound their size and keep the displayed continuation header
// on one line without coupling the tool to the server's current ID format.
function isResponseId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RESPONSE_ID_LENGTH &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

function renderResearch(payload: unknown): string {
  if (!isRecord(payload) || payload.status !== 'completed') {
    throw new Error('Parallel returned a response that was not completed.');
  }
  if (!Array.isArray(payload.output)) {
    throw new Error('Parallel returned a response without output messages.');
  }

  const texts: string[] = [];
  const sources = new Map<string, { title: string; passages: Set<string> }>();
  for (const item of payload.output) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      throw new Error('Parallel returned malformed research output.');
    }
    if (item.type !== 'message') continue;
    if (item.status !== undefined && item.status !== 'completed') {
      throw new Error('Parallel returned an answer that was not completed.');
    }
    if (!Array.isArray(item.content)) {
      throw new Error('Parallel returned malformed research output.');
    }
    for (const content of item.content) {
      if (!isRecord(content) || typeof content.type !== 'string') {
        throw new Error('Parallel returned malformed research output.');
      }
      if (content.type !== 'output_text') continue;
      if (typeof content.text !== 'string') {
        throw new Error('Parallel returned malformed research output.');
      }
      texts.push(content.text);
      if (!Array.isArray(content.annotations)) continue;
      // API citation offsets count Unicode code points, not UTF-16 units.
      const characters = [...content.text];
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
        let source = sources.get(href);
        if (!source) {
          source = { title: title || href, passages: new Set() };
          sources.set(href, source);
        }
        const start = citation.start_index;
        const end = citation.end_index;
        if (
          typeof start === 'number' &&
          typeof end === 'number' &&
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start >= 0 &&
          end > start &&
          end <= characters.length
        ) {
          const passage = characters.slice(start, end).join('');
          source.passages.add(
            `Cited answer passage (part ${texts.length}, characters ${start}:${end}): ${JSON.stringify(passage)}`
          );
        }
      }
    }
  }

  const text = texts.join('\n\n');
  if (!text.trim())
    throw new Error('Parallel returned an empty research response.');
  if (sources.size === 0) return text;

  const list = [...sources].map(([url, { title, passages }], index) => {
    const label = title
      .replaceAll('\\', '\\\\')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]')
      .replace(/[\r\n]+/g, ' ');
    const href = url
      .replaceAll('\\', '%5C')
      .replaceAll('<', '%3C')
      .replaceAll('>', '%3E');
    const link = `${index + 1}. [${label}](<${href}>)`;
    return [link, ...[...passages].map((passage) => `   ${passage}`)].join(
      '\n'
    );
  });
  const rangeNote = [...sources.values()].some((source) => source.passages.size)
    ? 'Passage locations use zero-based Unicode character offsets within each original text part; the end is exclusive.\n'
    : '';
  return `${text}\n\nSources:\n${rangeNote}${list.join('\n')}`;
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

export function parseResearchInput(
  input: unknown
): ResearchInput & { effort: ResearchEffort } {
  if (
    !isRecord(input) ||
    typeof input.query !== 'string' ||
    !input.query.trim()
  ) {
    throw new Error('Parallel Research requires a non-empty question.');
  }
  const effort =
    input.effort === undefined ? DEFAULT_RESEARCH_EFFORT : input.effort;
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    throw new Error('Parallel Research effort must be low, medium, or high.');
  }
  if (
    [...`${RESEARCH_INSTRUCTIONS}\n${input.query}`].length >
    PARALLEL_RESPONSES_MAX_INPUT_CHARS
  ) {
    throw new Error(
      'Parallel Research exceeds the 20,000-character input limit, including research instructions.'
    );
  }
  const previousResponseId = input.previous_response_id;
  if (previousResponseId !== undefined && !isResponseId(previousResponseId)) {
    throw new Error(
      `Parallel Research previous_response_id must be a non-empty string of at most ${MAX_RESPONSE_ID_LENGTH} characters without whitespace or control characters.`
    );
  }
  return {
    query: input.query,
    effort,
    ...(previousResponseId !== undefined
      ? { previous_response_id: previousResponseId }
      : {}),
  };
}

export async function runParallelResearch(
  apiKey: string,
  input: ResearchInput,
  signal?: AbortSignal
): Promise<{ text: string; effort: ResearchEffort; responseId?: string }> {
  const { query, effort, previous_response_id } = parseResearchInput(input);
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
        input: query,
        instructions: RESEARCH_INSTRUCTIONS,
        reasoning: { effort },
        stream: false,
        previous_response_id,
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
    return {
      text: renderResearch(payload),
      effort,
      ...(isRecord(payload) && isResponseId(payload.id)
        ? { responseId: payload.id }
        : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw new Error('Parallel Research cancelled.');
    if (deadline.signal.aborted)
      throw new Error('Parallel Research timed out after 120 seconds.');
    // JSON parser errors can include body excerpts, even partial credentials.
    if (error instanceof SyntaxError)
      throw new Error('Parallel returned malformed research JSON.');
    throw safeError(error, apiKey);
  } finally {
    clearTimeout(timeout);
  }
}
