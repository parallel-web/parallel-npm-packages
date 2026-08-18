import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent';
import { describe, it } from 'vitest';
import * as parallelResponses from '../src/index.ts';

const apiKey = process.env.PARALLEL_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error(
    'PARALLEL_API_KEY must be present for the single guarded live attempt'
  );
}

function request(signal: AbortSignal): ResolvedSubagentStartRequest {
  return {
    prompt: [
      {
        type: 'text',
        text:
          'Using current primary sources, explain what DeepSeek Harness is and ' +
          'identify its official GitHub repository. Give a concise answer with source links.',
      },
    ],
    signal,
    parent: {} as ResolvedSubagentStartRequest['parent'],
    descriptor: {} as ResolvedSubagentStartRequest['descriptor'],
  };
}

function answerText(blocks: ContentBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('');
}

describe('Parallel Responses provider real API', () => {
  it('returns one non-secret research result receipt', async () => {
    const startedAt = performance.now();
    const ctx = new Context();
    const runtimeFiber = await ctx.plugin(SubagentRuntime);
    const providerFiber = await ctx.plugin(parallelResponses, { apiKey });
    const provider = ctx.subagents.getProvider(
      parallelResponses.PARALLEL_RESPONSES_PROVIDER_ID
    );
    if (provider === undefined) {
      throw new Error('Parallel Responses provider did not register');
    }

    const run = await provider.start(request(new AbortController().signal));
    try {
      const result = await run.result;
      if (result.stopReason !== 'completed') {
        throw new Error(
          `Parallel Responses live run ended with ${result.stopReason}`
        );
      }
      const text = answerText(result.output);
      if (text.trim().length === 0) {
        throw new Error('Parallel Responses live run returned no answer text');
      }

      const sourceSection = text.split('\n\nSources:\n')[1] ?? '';
      const urls = sourceSection.match(/https?:\/\/\S+/gu) ?? [];
      const hostnames = urls.map((url) => new URL(url).hostname);

      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          packageVersion: '0.1.0-rc.0',
          status: 'passed',
          elapsedMs: Math.round(performance.now() - startedAt),
          callCount: 1,
          citationCount: urls.length,
          hostnames,
        })}\n`
      );
    } finally {
      await run.dispose();
      await providerFiber.dispose();
      await runtimeFiber.dispose();
    }
  }, 660_000);
});
