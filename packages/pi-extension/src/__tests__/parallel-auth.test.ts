import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

let fakeHome: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

vi.mock('@parallel-web/oauth', () => ({
  loginWithParallel: vi.fn(),
}));

function createCtx(): ExtensionContext {
  return {
    ui: {
      notify: vi.fn(),
      input: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

describe('parallel-auth', () => {
  beforeEach(async () => {
    vi.resetModules();
    fakeHome = mkdtempSync(join(tmpdir(), 'parallel-auth-test-'));
    delete process.env.PARALLEL_API_KEY;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns undefined when nothing is stored and no env var is set', async () => {
    const { getParallelApiKey } = await import('../parallel-auth.js');
    await expect(getParallelApiKey(createCtx())).resolves.toBeUndefined();
  });

  it('falls back to PARALLEL_API_KEY when nothing is stored', async () => {
    process.env.PARALLEL_API_KEY = 'env-key';
    const { getParallelApiKey } = await import('../parallel-auth.js');
    await expect(getParallelApiKey(createCtx())).resolves.toBe('env-key');
  });

  it('stores and retrieves an api key, taking precedence over the env var', async () => {
    process.env.PARALLEL_API_KEY = 'env-key';
    const { getParallelApiKey, storeParallelApiKey } = await import(
      '../parallel-auth.js'
    );
    const ctx = createCtx();

    storeParallelApiKey(ctx, 'stored-key');

    await expect(getParallelApiKey(ctx)).resolves.toBe('stored-key');
  });

  it('clears the stored api key', async () => {
    const { getParallelApiKey, storeParallelApiKey, clearStoredParallelApiKey } =
      await import('../parallel-auth.js');
    const ctx = createCtx();

    storeParallelApiKey(ctx, 'stored-key');
    clearStoredParallelApiKey(ctx);

    await expect(getParallelApiKey(ctx)).resolves.toBeUndefined();
  });

  it('logs in via the browser flow and persists the resulting key', async () => {
    const { loginWithParallel: runParallelOAuth } = await import(
      '@parallel-web/oauth'
    );
    vi.mocked(runParallelOAuth).mockResolvedValue({ apiKey: 'fresh-key' });

    const { getParallelApiKey, loginWithParallel } = await import(
      '../parallel-auth.js'
    );
    const ctx = createCtx();

    await expect(loginWithParallel(ctx)).resolves.toBe('fresh-key');
    await expect(getParallelApiKey(ctx)).resolves.toBe('fresh-key');
  });
});
