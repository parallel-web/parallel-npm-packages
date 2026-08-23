/**
 * One-shot Parallel Responses transport for the DeepSeek Harness subagent seam.
 *
 * @module @parallel-web/dsh-responses-subagent/provider
 */

import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  NO_START_CAPABILITIES,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent';

export const PARALLEL_RESPONSES_PROVIDER_ID = 'parallel-responses';
export const PARALLEL_RESPONSES_URL = 'https://api.parallel.ai/v1/responses';
export const PARALLEL_RESPONSES_TIMEOUT_MS = 10 * 60_000;
export const PARALLEL_RESPONSES_MAX_INPUT_CHARS = 20_000;
export const PARALLEL_RESPONSES_EFFORTS = ['low', 'medium', 'high'] as const;
export const PARALLEL_RESEARCH_INSTRUCTIONS =
  'You are an autonomous live-web research specialist. Answer the actual ' +
  'research question with current evidence, prioritizing official ' +
  'documentation, original announcements, direct repository evidence, and ' +
  'other primary sources. Cover every requested entity and constraint. Verify ' +
  'dates, versions, prices, and units, distinguish confirmed facts from ' +
  'uncertainty, and cite direct supporting source URLs. Return a complete ' +
  'synthesized answer for the parent agent. Do not reject a valid research ' +
  'question merely because its wording mentions JSON or an output schema.';

export type ParallelResponsesEffort =
  (typeof PARALLEL_RESPONSES_EFFORTS)[number];

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function diagnosticError(error: unknown): Error {
  if (
    error instanceof Error &&
    /^dsh-responses-subagent: Parallel Responses (?:returned HTTP \d{3}|reported response\.failed|request timed out)$/u.test(
      error.message
    )
  ) {
    return new Error(error.message);
  }
  return new Error(
    'dsh-responses-subagent: Parallel Responses transport failed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Preserve the exact text sequence of a non-empty, text-only delegated task.
 * @param request - resolved Harness request carrying the standalone prompt.
 * @returns the exact concatenated text supplied to Parallel Responses.
 */
export function researchPrompt(request: ResolvedSubagentStartRequest): string {
  if (
    request.prompt.length === 0 ||
    !request.prompt.every((block) => block.type === 'text')
  ) {
    throw new Error(
      'dsh-responses-subagent: the research prompt must contain only text blocks'
    );
  }
  const prompt = request.prompt.map((block) => block.text).join('');
  if (prompt.trim().length === 0) {
    throw new Error(
      'dsh-responses-subagent: the research prompt must not be empty'
    );
  }
  if (
    prompt.length + PARALLEL_RESEARCH_INSTRUCTIONS.length + 1 >
    PARALLEL_RESPONSES_MAX_INPUT_CHARS
  ) {
    throw new Error(
      `dsh-responses-subagent: the research prompt and instructions exceed ${PARALLEL_RESPONSES_MAX_INPUT_CHARS.toLocaleString('en-US')} characters`
    );
  }
  return prompt;
}

function completedResult(payload: unknown): SubagentResult {
  if (!isRecord(payload) || payload.status !== 'completed') {
    if (isRecord(payload) && payload.status === 'failed') {
      throw new Error(
        'dsh-responses-subagent: Parallel Responses reported response.failed'
      );
    }
    throw new TypeError(
      'dsh-responses-subagent: Parallel Responses response was not completed'
    );
  }
  if (!Array.isArray(payload.output)) {
    throw new TypeError(
      'dsh-responses-subagent: completed response has no output array'
    );
  }

  const answerParts: string[] = [];
  const citations = new Map<string, string | undefined>();
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
      answerParts.push(content.text);
      if (!Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (
          !isRecord(annotation) ||
          annotation.type !== 'url_citation' ||
          typeof annotation.url !== 'string' ||
          annotation.url.length === 0
        ) {
          continue;
        }
        if (!citations.get(annotation.url)?.trim()) {
          citations.set(
            annotation.url,
            typeof annotation.title === 'string' ? annotation.title : undefined
          );
        }
      }
    }
  }

  const answer = answerParts.join('');
  if (answer.trim().length === 0) {
    throw new TypeError(
      'dsh-responses-subagent: completed response contains no answer text'
    );
  }
  const sourceLines = [...citations].map(([url, title]) => {
    const compactTitle = title?.replace(/\s+/gu, ' ').trim();
    return compactTitle ? `- ${compactTitle} — ${url}` : `- ${url}`;
  });
  const text =
    sourceLines.length === 0
      ? answer
      : `${answer}\n\nSources:\n${sourceLines.join('\n')}`;
  return { output: [{ type: 'text', text }], stopReason: 'completed' };
}

/** Construction inputs kept private from Cordis configuration. */
export interface ParallelResponsesProviderOptions {
  readonly apiKey: string;
  readonly effort?: ParallelResponsesEffort;
  readonly fetch?: Fetch;
  /** Safe diagnostic sink for failures flattened into an error result. */
  readonly onError?: (error: Error) => void;
}

/** Fixed, one-shot remote research provider. */
export class ParallelResponsesProvider implements SubagentProvider {
  readonly name = PARALLEL_RESPONSES_PROVIDER_ID;
  readonly capabilities = NO_START_CAPABILITIES;
  readonly inheritsParentContext = false;

  private readonly apiKey: string;
  private readonly effort: ParallelResponsesEffort;
  private readonly fetch: Fetch;
  private readonly onError: ((error: Error) => void) | undefined;

  constructor(options: ParallelResponsesProviderOptions) {
    this.apiKey = options.apiKey;
    this.effort = options.effort ?? 'medium';
    this.fetch = options.fetch ?? globalThis.fetch;
    this.onError = options.onError;
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const prompt = researchPrompt(request);
    if (request.signal.aborted) {
      throw new Error('dsh-responses-subagent: request was aborted');
    }

    const controller = new AbortController();
    let cancelled = false;
    const requestCancel = (): void => {
      cancelled = true;
      controller.abort();
    };
    request.signal.addEventListener('abort', requestCancel, { once: true });

    let timedOut = false;
    const timeoutError = new Error(
      'dsh-responses-subagent: Parallel Responses request timed out'
    );
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
    }, PARALLEL_RESPONSES_TIMEOUT_MS);

    const result = settleRunResult({
      attempt: async () => {
        try {
          const response = await this.fetch(PARALLEL_RESPONSES_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'parallel',
              input: prompt,
              instructions: PARALLEL_RESEARCH_INSTRUCTIONS,
              reasoning: { effort: this.effort },
              stream: false,
            }),
            redirect: 'error',
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(
              `dsh-responses-subagent: Parallel Responses returned HTTP ${response.status}`
            );
          }
          const terminal = completedResult(await response.json());
          if (timedOut) throw timeoutError;
          return terminal;
        } finally {
          clearTimeout(timer);
        }
      },
      collectOutput: () => [],
      cancelled: () => cancelled,
      signal: request.signal,
      onAbort: requestCancel,
      onError: (error) => {
        this.onError?.(diagnosticError(timedOut ? timeoutError : error));
      },
    });

    return subprocessRunHandle({
      id: SessionId(randomUUID()),
      result,
      signal: request.signal,
      onAbort: requestCancel,
      requestCancel,
      teardown: () => result.then(() => undefined),
    });
  }
}
