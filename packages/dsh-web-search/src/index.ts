import type { Context } from '@deepseek-ai/cordis';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-web';
import {
  DEFAULT_MAX_CHARS_TOTAL,
  PARALLEL_SEARCH_MODES,
  ParallelSearchProvider,
  type ParallelSearchMode,
} from './provider.ts';

export { DEFAULT_MAX_CHARS_TOTAL, PARALLEL_PROVIDER_ID } from './provider.ts';
export type { ParallelSearchMode } from './provider.ts';

export const name = 'web-search-parallel';
export const inject = ['web'];

export interface Config {
  apiKey?: string;
  mode?: ParallelSearchMode;
  maxCharsTotal?: number;
  maxCharsPerResult?: number;
}

interface ResolvedConfig extends Config {
  maxCharsTotal: number;
}

export const Config: z<Config, ResolvedConfig> = z.object({
  apiKey: z.string().role('secret'),
  mode: z.union(PARALLEL_SEARCH_MODES),
  maxCharsTotal: z.number().step(1).min(1).default(DEFAULT_MAX_CHARS_TOTAL),
  maxCharsPerResult: z.number().step(1).min(1),
});

export function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.web.registerSearchProvider(
    new ParallelSearchProvider({
      apiKey:
        config.apiKey ??
        launchEnvironmentOf(ctx).get('PARALLEL_API_KEY')?.value ??
        '',
      ...(config.mode === undefined ? {} : { mode: config.mode }),
      maxCharsTotal: config.maxCharsTotal,
      ...(config.maxCharsPerResult === undefined
        ? {}
        : { maxCharsPerResult: config.maxCharsPerResult }),
    })
  );
}
