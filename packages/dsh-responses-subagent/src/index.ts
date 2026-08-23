/** Parallel Responses research-subagent provider for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-subagent';
import {
  DEFAULT_MAX_ACTIVE_RUNS,
  MAX_ACTIVE_RUN_LIMIT,
  PARALLEL_RESPONSES_EFFORTS,
  ParallelResponsesProvider,
  type ParallelResponsesEffort,
} from './provider.ts';

export { PARALLEL_RESPONSES_PROVIDER_ID } from './provider.ts';
export type { ParallelResponsesEffort } from './provider.ts';

export const name = 'subagent-parallel-responses';
export const inject = ['subagents', 'systemPrompt'];

const RESEARCH_TOOL_GUIDANCE =
  'Use parallel_research for current web research and primary-source ' +
  'verification. It delegates to an autonomous web-research specialist and ' +
  'returns a synthesized, citation-backed answer, not raw search results. ' +
  'Pass a complete, self-contained natural-language research question that ' +
  'preserves every requested entity, date, unit, and constraint. Do not ' +
  'invent JSON schemas, machine-output requirements, or keyword fragments. ';

function researchToolGuidance(effort: ParallelResponsesEffort): string {
  const strategy =
    effort === 'low'
      ? 'Break multi-part research into focused, independent questions and ' +
        'start those calls together when possible. Reconcile their answers ' +
        'and make focused follow-up calls only for missing evidence.'
      : 'For a connected question, prefer one complete handoff and use ' +
        'focused follow-up calls only for material unresolved facts.';
  return `${RESEARCH_TOOL_GUIDANCE}${strategy} Preserve and cite the returned source URLs.`;
}

/** Deployment configuration for the fixed Parallel Responses provider. */
export interface Config {
  /** Explicit Parallel API key; omission uses the Harness launch snapshot. */
  apiKey?: string;
  /** Research tier; higher effort trades cost for deeper investigation. */
  effort?: ParallelResponsesEffort;
  /** Maximum simultaneous research calls, including parallel fan-out. */
  maxConcurrentRuns?: number;
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  effort: z.union(PARALLEL_RESPONSES_EFFORTS),
  maxConcurrentRuns: z
    .number()
    .step(1)
    .min(1)
    .max(MAX_ACTIVE_RUN_LIMIT)
    .default(DEFAULT_MAX_ACTIVE_RUNS),
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
      ...(config.effort === undefined ? {} : { effort: config.effort }),
      ...(config.maxConcurrentRuns === undefined
        ? {}
        : { maxConcurrentRuns: config.maxConcurrentRuns }),
      onError: (error) => {
        ctx.logger.warn(
          `subagent-parallel-responses: remote run failed: ${error.message}`
        );
      },
    })
  );
  ctx.systemPrompt.section({
    name: 'tool:parallel_research',
    order: 110.5,
    text: (context) =>
      ctx.get('tools')?.get('parallel_research', context.scope) === undefined
        ? ''
        : researchToolGuidance(config.effort ?? 'medium'),
  });
}
