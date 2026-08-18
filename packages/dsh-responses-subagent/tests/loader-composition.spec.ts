import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Include from '@deepseek-ai/cordis-plugin-include';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ParallelResponses from '../src/index.ts';

let temporaryRoot: string | undefined;
let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  temporaryRoot = undefined;
});

async function boot(): Promise<Context> {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-parallel-responses-'));
  const configPath = join(temporaryRoot, 'cordis.yml');
  await writeFile(
    configPath,
    [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-subagent'",
      "- name: '@parallel-web/dsh-responses-subagent'",
      '  config:',
      '    apiKey: parallel_test_loader',
      "- name: '@deepseek-ai/dsh-tool-subagent'",
      '  config:',
      '    provider: parallel-responses',
      '    toolName: parallel_research',
      '    enableRunInBackground: false',
      '    backgroundMode: one-shot',
      '    maxDepth: provider-managed',
      '',
    ].join('\n')
  );

  const ctx = new Context();
  context = ctx;
  ctx.baseUrl = pathToFileURL(temporaryRoot).href + '/';
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@parallel-web/dsh-responses-subagent', ParallelResponses],
    ['@deepseek-ai/dsh-tool-subagent', ToolSubagent],
  ]);
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) {
        throw new Error(`unexpected Loader import: ${specifier}`);
      }
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  });
  await ctx.loader.await();
  return ctx;
}

describe('Parallel Responses public Loader composition', () => {
  it('registers one foreground-only research tool without a network request', async () => {
    const ctx = await boot();

    const provider = ctx.subagents.getProvider('parallel-responses');
    expect(provider).toMatchObject({
      name: 'parallel-responses',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    });
    expect('prepareContinuable' in (provider ?? {})).toBe(false);

    const schema = ctx.tools
      .schemas()
      .find((candidate) => candidate.name === 'parallel_research');
    expect(schema).toBeDefined();
    if (schema === undefined) {
      throw new Error('parallel_research did not register');
    }
    const properties = (
      schema.parameters as { properties?: Record<string, unknown> }
    ).properties;
    expect(Object.keys(properties ?? {}).sort()).toEqual([
      'description',
      'prompt',
    ]);
    expect(schema.description).not.toContain('job_output');
  });
});
