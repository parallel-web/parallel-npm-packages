/** Parallel Responses research-subagent provider for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-subagent';
import { ParallelResponsesProvider } from './provider.ts';

export { PARALLEL_RESPONSES_PROVIDER_ID } from './provider.ts';

export const name = 'subagent-parallel-responses';
export const inject = ['subagents'];

/** Deployment configuration for the fixed Parallel Responses provider. */
export interface Config {
  /** Explicit Parallel API key; omission uses the Harness launch snapshot. */
  apiKey?: string;
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
});

/**
 * Register the fixed `parallel-responses` provider.
 * @param ctx - context carrying the shared subagent service.
 * @param config - optional explicit Parallel credential.
 */
export function apply(ctx: Context, config: Config): void {
  const apiKey =
    config.apiKey ??
    launchEnvironmentOf(ctx).get('PARALLEL_API_KEY')?.value ??
    '';
  if (apiKey.trim().length === 0) {
    throw new Error(
      'dsh-responses-subagent: apiKey or PARALLEL_API_KEY is required'
    );
  }
  ctx.subagents.registerProvider(
    new ParallelResponsesProvider({
      apiKey,
      onError: (error) => {
        ctx.logger.warn(
          `subagent-parallel-responses: remote run failed: ${error.message}`
        );
      },
    })
  );
}
