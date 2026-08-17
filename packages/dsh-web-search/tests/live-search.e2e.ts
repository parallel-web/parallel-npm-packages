import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import WebRuntime from '@deepseek-ai/dsh-web';
import { describe, expect, it } from 'vitest';
import * as parallelPlugin from '../src/index.ts';

const apiKey = process.env.PARALLEL_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error(
    'PARALLEL_API_KEY must be present for the single guarded live attempt'
  );
}

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('parallel-web');
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8')
).version;
const packageVersion = require('../package.json').version;

describe('Parallel provider real API', () => {
  it('returns ordered citeable sources in one attempt', async () => {
    const ctx = new Context();
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' });
    await ctx.plugin(parallelPlugin, { maxCharsTotal: 4_000 });

    const result = await ctx.web.search({
      query: 'DeepSeek Harness GitHub repository',
      maxResults: 3,
    });

    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) {
      const url = new URL(source.url);
      expect(['http:', 'https:']).toContain(url.protocol);
    }
    expect(result.truncated).toBe(false);

    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        packageVersion,
        sdkVersion,
        status: 'passed',
        sourceCount: result.sources.length,
        hostnames: result.sources.map(() => '<redacted>'),
      })}\n`
    );
  }, 70_000);
});
