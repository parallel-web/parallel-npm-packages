/**
 * One-shot Parallel Responses transport for the DeepSeek Harness subagent seam.
 *
 * @module @parallel-web/dsh-responses-subagent/provider
 */

import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent';

export const PARALLEL_RESPONSES_PROVIDER_ID = 'parallel-responses';
export const PARALLEL_RESPONSES_URL = 'https://api.parallel.ai/v1/responses';
export const PARALLEL_RESPONSES_TIMEOUT_MS = 10 * 60_000;

const MAX_ACTIVE_RUNS = 2;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface CapacityWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

class Capacity {
  private active = 0;
  private readonly waiters: CapacityWaiter[] = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw cancellationError('before capacity admission');
    if (this.active < MAX_ACTIVE_RUNS) {
      this.active += 1;
      return this.releaseOnce();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(cancellationError('while waiting for capacity'));
      };
      const waiter: CapacityWaiter = { signal, resolve, reject, onAbort };
      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.admitNext();
    };
  }

  private admitNext(): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(cancellationError('while waiting for capacity'));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseOnce());
      return;
    }
  }
}

function cancellationError(when: string): Error {
  return new Error(`dsh-responses-subagent: request was aborted ${when}`);
}

function diagnosticError(error: unknown): Error {
  if (
    error instanceof Error &&
    (/^dsh-responses-subagent: Parallel Responses returned HTTP \d{3}$/u.test(
      error.message
    ) ||
      error.message ===
        'dsh-responses-subagent: Parallel Responses reported response.failed' ||
      error.message ===
        'dsh-responses-subagent: Parallel Responses request timed out')
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
  if (request.prompt.length === 0) {
    throw new Error(
      'dsh-responses-subagent: the research prompt must contain only text blocks'
    );
  }
  const texts: string[] = [];
  for (const block of request.prompt) {
    if (block.type !== 'text') {
      throw new Error(
        'dsh-responses-subagent: the research prompt must contain only text blocks'
      );
    }
    texts.push(block.text);
  }
  const prompt = texts.join('');
  if (prompt.trim().length === 0) {
    throw new Error(
      'dsh-responses-subagent: the research prompt must not be empty'
    );
  }
  return prompt;
}

function citationLine(title: string | undefined, url: string): string {
  const compactTitle = title?.replace(/\s+/gu, ' ').trim();
  return compactTitle === undefined || compactTitle.length === 0
    ? `- ${url}`
    : `- ${compactTitle} — ${url}`;
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
    if (!isRecord(item) || item.type !== 'message') continue;
    if (!Array.isArray(item.content)) {
      throw new TypeError(
        'dsh-responses-subagent: completed message has no content array'
      );
    }
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== 'output_text') continue;
      if (typeof content.text !== 'string') {
        throw new TypeError(
          'dsh-responses-subagent: completed output text is malformed'
        );
      }
      answerParts.push(content.text);
      if (content.annotations === undefined) continue;
      if (!Array.isArray(content.annotations)) {
        throw new TypeError(
          'dsh-responses-subagent: completed annotations are malformed'
        );
      }
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') {
          continue;
        }
        if (typeof annotation.url !== 'string' || annotation.url.length === 0) {
          throw new TypeError(
            'dsh-responses-subagent: URL citation is malformed'
          );
        }
        if (
          annotation.title !== undefined &&
          typeof annotation.title !== 'string'
        ) {
          throw new TypeError(
            'dsh-responses-subagent: citation title is malformed'
          );
        }
        const priorTitle = citations.get(annotation.url);
        if (
          !citations.has(annotation.url) ||
          priorTitle === undefined ||
          priorTitle.trim().length === 0
        ) {
          citations.set(annotation.url, annotation.title);
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
  const sourceLines = [...citations].map(([url, title]) =>
    citationLine(title, url)
  );
  const text =
    sourceLines.length === 0
      ? answer
      : `${answer}\n\nSources:\n${sourceLines.join('\n')}`;
  return { output: [{ type: 'text', text }], stopReason: 'completed' };
}

/** Construction inputs kept private from Cordis configuration. */
export interface ParallelResponsesProviderOptions {
  readonly apiKey: string;
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
  private readonly fetch: Fetch;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly capacity = new Capacity();

  constructor(options: ParallelResponsesProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.onError = options.onError;
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const prompt = researchPrompt(request);
    if (this.apiKey.trim().length === 0) {
      throw new Error('dsh-responses-subagent: PARALLEL_API_KEY is required');
    }

    const release = await this.capacity.acquire(request.signal);
    if (request.signal.aborted) {
      release();
      throw cancellationError('before run publication');
    }

    const controller = new AbortController();
    let cancelled = false;
    const requestCancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      controller.abort(cancellationError('during the remote run'));
    };
    request.signal.addEventListener('abort', requestCancel, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new Error(
          'dsh-responses-subagent: Parallel Responses request timed out'
        )
      );
    }, PARALLEL_RESPONSES_TIMEOUT_MS);

    const result: Promise<SubagentResult> = (async () => {
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
            reasoning: { effort: 'medium' },
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
        if (cancelled) return { output: [], stopReason: 'aborted' };
        if (timedOut) {
          throw new Error(
            'dsh-responses-subagent: Parallel Responses request timed out'
          );
        }
        return terminal;
      } catch (error: unknown) {
        if (!cancelled) {
          try {
            this.onError?.(
              diagnosticError(
                timedOut
                  ? new Error(
                      'dsh-responses-subagent: Parallel Responses request timed out'
                    )
                  : error
              )
            );
          } catch {
            // A diagnostic sink must not violate the non-rejecting run seam.
            return { output: [], stopReason: 'error' };
          }
        }
        return {
          output: [],
          stopReason: cancelled ? 'aborted' : 'error',
        };
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', requestCancel);
        release();
      }
    })();

    let disposal: Promise<void> | undefined;
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      result,
      dispose: (): Promise<void> => {
        if (disposal !== undefined) return disposal;
        request.signal.removeEventListener('abort', requestCancel);
        requestCancel();
        disposal = result.then(() => undefined);
        return disposal;
      },
    };
  }
}
