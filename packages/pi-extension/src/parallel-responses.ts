declare const __PACKAGE_VERSION__: string;

import { readFileSync } from 'node:fs';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

export const PARALLEL_RESPONSES_API = 'parallel-responses';
export const PARALLEL_RESPONSES_URL = 'https://api.parallel.ai/v1/responses';
export const PARALLEL_RESPONSES_MAX_INPUT_CHARS = 20_000;
export const PARALLEL_RESPONSES_DEFAULT_TIMEOUT_MS = 120_000;

const RESPONSE_USAGE_CHARS_PER_TOKEN = 4;
const RESEARCH_MAX_OUTPUT_TOKENS = 32_000;

// Pi's assembled system prompt includes local runtime metadata. The shipped
// agent body is the complete instruction boundary for this remote provider.
const RESEARCH_INSTRUCTIONS = readFileSync(
  new URL('../agents/parallel-research.md', import.meta.url),
  'utf8'
)
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  .trim();

export const PARALLEL_RESEARCH_MODEL: Model<typeof PARALLEL_RESPONSES_API> = {
  id: 'research',
  name: 'Parallel Research',
  api: PARALLEL_RESPONSES_API,
  provider: 'parallel',
  baseUrl: 'https://api.parallel.ai',
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  },
  input: ['text'],
  // Parallel Responses is billed per successful call, not per token. The
  // custom stream records the fixed call price in usage.cost.total. Pi's
  // contextWindow includes input plus output tokens, while Responses limits
  // input in characters and reports usage with a four-chars-per-token
  // estimate. Keep that estimate in catalog metadata; the explicit character
  // check below remains the authoritative request limit.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow:
    Math.ceil(
      PARALLEL_RESPONSES_MAX_INPUT_CHARS / RESPONSE_USAGE_CHARS_PER_TOKEN
    ) + RESEARCH_MAX_OUTPUT_TOKENS,
  maxTokens: RESEARCH_MAX_OUTPUT_TOKENS,
};

type ResearchEffort = 'low' | 'medium' | 'high';

const COST_PER_SUCCESSFUL_CALL: Record<ResearchEffort, number> = {
  low: 0.01,
  medium: 0.05,
  high: 0.25,
};

interface UrlCitation {
  url: string;
  title: string;
}

interface ParsedResponse {
  text: string;
  citations: UrlCitation[];
  usage: {
    input: number;
    output: number;
    totalTokens: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function resolveEffort(
  reasoning: SimpleStreamOptions['reasoning']
): ResearchEffort {
  if (reasoning === 'minimal' || reasoning === 'low') return 'low';
  if (reasoning === 'high' || reasoning === 'xhigh' || reasoning === 'max') {
    return 'high';
  }
  return 'medium';
}

function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message.role !== 'user') continue;

    let text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');

    // pi-subagents duplicates its local artifact delivery instructions in the
    // task and system prompt. Pi persists the final answer; that matching
    // suffix is not part of the research question. Keep unmatched user text.
    const outputSeparator = '\n\n---\n**Output:**\n';
    const outputIndex = text.lastIndexOf(outputSeparator);
    if (outputIndex !== -1) {
      const delivery = text.slice(outputIndex + outputSeparator.length);
      const promptDelivery = `Runtime output path override:\n${delivery}`;
      if (
        context.systemPrompt?.endsWith(promptDelivery) ||
        context.systemPrompt?.includes(`${promptDelivery}\n\n`)
      ) {
        text = text.slice(0, outputIndex);
      }
    }

    if (text.trim()) return text;

    // The latest user turn is the task boundary. Never fall back to an older
    // user message when the current task is empty or non-textual, because that
    // would turn parent history into a new research request.
    break;
  }

  throw new Error('Parallel Research requires a non-empty textual user task.');
}

function parseCitation(value: unknown): UrlCitation | undefined {
  if (!isRecord(value) || value.type !== 'url_citation') return undefined;
  if (typeof value.url !== 'string' || typeof value.title !== 'string') {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  return {
    url: url.toString(),
    title: value.title,
  };
}

function parseResponse(payload: unknown): ParsedResponse {
  if (!isRecord(payload) || payload.status !== 'completed') {
    throw new Error('Parallel returned a response that was not completed.');
  }
  if (!Array.isArray(payload.output)) {
    throw new Error('Parallel returned a response without output messages.');
  }

  const texts: string[] = [];
  const citations: UrlCitation[] = [];
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
      if (Array.isArray(content.annotations)) {
        for (const annotation of content.annotations) {
          const citation = parseCitation(annotation);
          if (citation) citations.push(citation);
        }
      }
    }
  }

  const text = texts.join('\n\n').trim();
  if (!text) throw new Error('Parallel returned an empty research response.');

  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    text,
    citations,
    usage: {
      input: safeInteger(usage.input_tokens),
      output: safeInteger(usage.output_tokens),
      totalTokens: safeInteger(usage.total_tokens),
    },
  };
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function markdownUrl(value: string): string {
  return value.replaceAll('<', '%3C').replaceAll('>', '%3E');
}

function renderCitedResearch(parsed: ParsedResponse): string {
  const sources = new Map<string, string>();
  for (const citation of parsed.citations) {
    if (!sources.has(citation.url)) {
      sources.set(citation.url, citation.title.trim() || citation.url);
    }
  }
  if (sources.size === 0) return parsed.text;

  const list = [...sources].map(
    ([url, title], index) =>
      `${index + 1}. [${escapeMarkdownLabel(title)}](<${markdownUrl(url)}>)`
  );
  return `${parsed.text}\n\nSources:\n${list.join('\n')}`;
}

function responseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

function safeErrorMessage(error: unknown, apiKey: string): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Unknown provider failure';
  }

  if (apiKey) message = message.replaceAll(apiKey, '[REDACTED]');
  const trimmed = message.trim();
  return (trimmed || 'Unknown provider failure').slice(0, 1_000);
}

async function httpError(response: Response): Promise<Error> {
  let message = response.statusText || 'request failed';
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && isRecord(payload.error)) {
      if (typeof payload.error.message === 'string') {
        message = payload.error.message;
      }
    }
  } catch {
    // Status and statusText remain the useful, bounded diagnostic.
  }
  return new Error(
    `Parallel Responses request failed (${response.status}): ${message}`
  );
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}

export function streamParallelResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createOutput(model);

  void (async () => {
    const apiKey = options?.apiKey ?? '';
    const requestController = new AbortController();
    let cancelledByCaller = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const abortFromCaller = () => {
      cancelledByCaller = true;
      requestController.abort(options?.signal?.reason);
    };

    try {
      stream.push({ type: 'start', partial: output });
      if (!apiKey) {
        throw new Error(
          'Parallel authentication required. Run `/login parallel` in Pi, or set PARALLEL_API_KEY.'
        );
      }

      if (options?.signal?.aborted) abortFromCaller();
      options?.signal?.addEventListener('abort', abortFromCaller, {
        once: true,
      });

      const timeoutMs =
        options?.timeoutMs ?? PARALLEL_RESPONSES_DEFAULT_TIMEOUT_MS;
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          requestController.abort(new Error('Parallel Research timed out.'));
        }, timeoutMs);
        timeout.unref?.();
      }

      const input = latestUserText(context);
      if (
        input.length + RESEARCH_INSTRUCTIONS.length >
        PARALLEL_RESPONSES_MAX_INPUT_CHARS
      ) {
        throw new Error(
          `Parallel Research input exceeds the ${PARALLEL_RESPONSES_MAX_INPUT_CHARS.toLocaleString('en-US')}-character limit.`
        );
      }

      const effort = resolveEffort(options?.reasoning);
      let payload: unknown = {
        model: 'parallel',
        input,
        instructions: RESEARCH_INSTRUCTIONS,
        reasoning: { effort },
        stream: false,
      };
      // Pi exposes onPayload as an explicit inspect-or-replace hook. Normal
      // pi-subagents use does not replace this minimal body; a low-level caller
      // that does return a replacement owns the resulting data boundary.
      const replacement = await options?.onPayload?.(payload, model);
      if (replacement !== undefined) payload = replacement;

      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Tool-Calling-Package': `npm:@parallel-web/pi-extension/v${__PACKAGE_VERSION__ ?? '0.0.0'}`,
      });
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
      headers.set('Authorization', `Bearer ${apiKey}`);

      const fetchImpl = options?.fetch ?? globalThis.fetch;
      const response = await fetchImpl(PARALLEL_RESPONSES_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: requestController.signal,
        redirect: 'error',
      });
      await options?.onResponse?.(
        { status: response.status, headers: responseHeaders(response) },
        model
      );
      if (!response.ok) throw await httpError(response);

      const parsed = parseResponse(await response.json());
      const text = renderCitedResearch(parsed);
      output.content.push({ type: 'text', text });
      output.usage.input = parsed.usage.input;
      output.usage.output = parsed.usage.output;
      output.usage.totalTokens = parsed.usage.totalTokens;
      output.usage.cost.total = COST_PER_SUCCESSFUL_CALL[effort];
      output.stopReason = 'stop';

      stream.push({ type: 'text_start', contentIndex: 0, partial: output });
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: text,
        partial: output,
      });
      stream.push({
        type: 'text_end',
        contentIndex: 0,
        content: text,
        partial: output,
      });
      stream.push({ type: 'done', reason: 'stop', message: output });
    } catch (error) {
      const aborted = cancelledByCaller;
      output.stopReason = aborted ? 'aborted' : 'error';
      output.errorMessage = timedOut
        ? 'Parallel Research timed out.'
        : safeErrorMessage(error, apiKey);
      stream.push({
        type: 'error',
        reason: aborted ? 'aborted' : 'error',
        error: output,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', abortFromCaller);
      stream.end();
    }
  })();

  return stream;
}
