import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Provider } from '@earendil-works/pi-ai';

const mocks = vi.hoisted(() => ({
  runParallelOAuth: vi.fn(),
}));

vi.mock('@parallel-web/oauth', () => ({
  loginWithParallel: mocks.runParallelOAuth,
}));

function registerProvider(): Provider {
  const pi = { registerProvider: vi.fn() };
  registerParallelAuthProvider(pi as unknown as ExtensionAPI);
  return pi.registerProvider.mock.calls[0][0] as Provider;
}

function createAuthContext(env: Record<string, string> = {}) {
  return {
    ctx: {
      env: async (name: string) => env[name],
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  };
}

function createInteraction(
  overrides: Record<string, unknown> = {}
): Parameters<NonNullable<Provider['auth']['apiKey']>['login']>[0] {
  return {
    signal: new AbortController().signal,
    notify: vi.fn(),
    prompt: vi.fn(),
    ...overrides,
  } as never;
}

let registerParallelAuthProvider: (typeof import('../parallel-auth.js'))['registerParallelAuthProvider'];
let getParallelApiKey: (typeof import('../parallel-auth.js'))['getParallelApiKey'];
let getParallelAuthStatus: (typeof import('../parallel-auth.js'))['getParallelAuthStatus'];
let PARALLEL_PROVIDER: string;

describe('parallel-auth', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ({
      registerParallelAuthProvider,
      getParallelApiKey,
      getParallelAuthStatus,
      PARALLEL_PROVIDER,
    } = await import('../parallel-auth.js'));
  });

  it('registers a Parallel provider that serves no models', () => {
    const provider = registerProvider();

    expect(provider.id).toBe('parallel');
    expect(provider.name).toBe('Parallel');
    expect(provider.getModels()).toEqual([]);
    expect(provider.auth.apiKey).toBeDefined();
    expect(provider.auth.oauth).toBeUndefined();
  });

  it('resolves the credential Pi has stored', async () => {
    const provider = registerProvider();

    await expect(
      provider.auth.apiKey?.resolve({
        ...createAuthContext(),
        credential: { type: 'api_key', key: 'stored-key' },
      })
    ).resolves.toEqual({
      auth: { apiKey: 'stored-key' },
      source: 'stored credential',
    });
  });

  it('falls back to PARALLEL_API_KEY when nothing is stored', async () => {
    const provider = registerProvider();

    await expect(
      provider.auth.apiKey?.resolve(
        createAuthContext({ PARALLEL_API_KEY: 'env-key' })
      )
    ).resolves.toEqual({
      auth: { apiKey: 'env-key' },
      source: 'PARALLEL_API_KEY',
    });
  });

  it('reports unconfigured when there is no credential and no env var', async () => {
    const provider = registerProvider();

    await expect(
      provider.auth.apiKey?.resolve(createAuthContext())
    ).resolves.toBeUndefined();
  });

  it('prefers the stored credential over the env var', async () => {
    const provider = registerProvider();

    await expect(
      provider.auth.apiKey?.resolve({
        ...createAuthContext({ PARALLEL_API_KEY: 'env-key' }),
        credential: { type: 'api_key', key: 'stored-key' },
      })
    ).resolves.toEqual({
      auth: { apiKey: 'stored-key' },
      source: 'stored credential',
    });
  });

  it('delegates browser opening to Pi and returns an api_key credential', async () => {
    mocks.runParallelOAuth.mockImplementation(async (options) => {
      options.onAuthUrl('https://platform.parallel.ai/oauth', false);
      return { apiKey: 'fresh-key' };
    });

    const provider = registerProvider();
    const interaction = createInteraction();

    await expect(provider.auth.apiKey?.login?.(interaction)).resolves.toEqual({
      type: 'api_key',
      key: 'fresh-key',
    });

    expect(mocks.runParallelOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ openBrowser: false })
    );
    expect(interaction.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'auth_url',
        url: 'https://platform.parallel.ai/oauth',
      })
    );
  });

  it('prompts through Pi when the loopback callback times out', async () => {
    mocks.runParallelOAuth.mockImplementation(async (options) => {
      const pasted = await options.promptForCallback(
        'https://platform.parallel.ai/oauth'
      );
      return { apiKey: `key-from-${pasted}` };
    });

    const provider = registerProvider();
    const interaction = createInteraction({
      prompt: vi.fn().mockResolvedValue('callback-url'),
    });

    await expect(provider.auth.apiKey?.login?.(interaction)).resolves.toEqual({
      type: 'api_key',
      key: 'key-from-callback-url',
    });
    expect(interaction.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manual_code' })
    );
  });

  it('aborts the login when the user cancels the manual prompt', async () => {
    mocks.runParallelOAuth.mockImplementation(async (options) => {
      const pasted = await options.promptForCallback(
        'https://platform.parallel.ai/oauth'
      );
      expect(pasted).toBeUndefined();
      throw new Error('Parallel login cancelled');
    });

    const provider = registerProvider();
    const interaction = createInteraction({
      prompt: vi.fn().mockRejectedValue(new Error('cancelled')),
    });

    await expect(provider.auth.apiKey?.login?.(interaction)).rejects.toThrow(
      'Parallel login cancelled'
    );
  });

  it('reads the resolved key back through the model registry', async () => {
    const getApiKeyForProvider = vi.fn().mockResolvedValue('resolved-key');
    const ctx = {
      modelRegistry: { getApiKeyForProvider },
    } as unknown as ExtensionContext;

    await expect(getParallelApiKey(ctx)).resolves.toBe('resolved-key');
    expect(getApiKeyForProvider).toHaveBeenCalledWith(PARALLEL_PROVIDER);
  });

  it('reads the auth status back through the model registry', () => {
    const getProviderAuthStatus = vi
      .fn()
      .mockReturnValue({ configured: true, source: 'stored' });
    const ctx = {
      modelRegistry: { getProviderAuthStatus },
    } as unknown as ExtensionContext;

    expect(getParallelAuthStatus(ctx)).toEqual({
      configured: true,
      source: 'stored',
    });
    expect(getProviderAuthStatus).toHaveBeenCalledWith(PARALLEL_PROVIDER);
  });
});
