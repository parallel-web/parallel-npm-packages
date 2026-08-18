import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  ApiKeyCredential,
  AuthContext,
  AuthResult,
  Provider,
  ProviderAuthInteraction,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { loginWithParallel as runParallelOAuth } from '@parallel-web/oauth';
import {
  PARALLEL_RESEARCH_MODEL,
  streamParallelResponses,
} from './parallel-responses';

/** Provider id under which Pi stores the Parallel credential in its auth store. */
export const PARALLEL_PROVIDER = 'parallel';

const API_KEY_ENV_VAR = 'PARALLEL_API_KEY';

async function loginToParallel(
  interaction: ProviderAuthInteraction
): Promise<ApiKeyCredential> {
  interaction.signal.throwIfAborted();

  const { apiKey } = await runParallelOAuth({
    onAuthUrl: (url, browserOpened) => {
      interaction.notify({
        type: 'auth_url',
        url,
        instructions: browserOpened
          ? 'Opening Parallel login in your browser.'
          : 'Open this URL to sign in to Parallel.',
      });
    },
    promptForCallback: async (authUrl) => {
      try {
        return await interaction.prompt({
          type: 'manual_code',
          message: 'Paste the Parallel callback URL from your browser',
          placeholder: authUrl,
          signal: interaction.signal,
        });
      } catch {
        // Cancelled or aborted: abort the login rather than keep waiting.
        return undefined;
      }
    },
  });

  interaction.signal.throwIfAborted();
  return { type: 'api_key', key: apiKey };
}

async function resolveParallelAuth(input: {
  ctx: AuthContext;
  credential?: ApiKeyCredential;
  signal: AbortSignal;
}): Promise<AuthResult | undefined> {
  input.signal.throwIfAborted();

  if (input.credential?.key) {
    return {
      auth: { apiKey: input.credential.key },
      source: 'stored credential',
    };
  }

  const envApiKey = await input.ctx.env(API_KEY_ENV_VAR);
  return envApiKey
    ? { auth: { apiKey: envApiKey }, source: API_KEY_ENV_VAR }
    : undefined;
}

/**
 * Parallel's provider owns both the shared credential boundary and the static
 * research model. Pi owns auth.json, `/login parallel`, the `/logout` provider
 * picker, and the `PARALLEL_API_KEY` fallback; both web tools and the model
 * reuse that resolved credential without adding another auth concept.
 */
function createParallelProvider(): Provider {
  return {
    id: PARALLEL_PROVIDER,
    name: 'Parallel',
    auth: {
      apiKey: {
        name: 'Parallel',
        login: loginToParallel,
        resolve: resolveParallelAuth,
      },
    },
    getModels: () => [PARALLEL_RESEARCH_MODEL],
    stream(model, context, options) {
      return streamParallelResponses(
        model,
        context,
        options as SimpleStreamOptions
      );
    },
    streamSimple(model, context, options) {
      return streamParallelResponses(model, context, options);
    },
  };
}

export function registerParallelAuthProvider(pi: ExtensionAPI) {
  pi.registerProvider(createParallelProvider());
}

export async function getParallelApiKey(ctx: ExtensionContext) {
  return await ctx.modelRegistry.getApiKeyForProvider(PARALLEL_PROVIDER);
}

/** Structural mirror of Pi's AuthStatus, which it does not export from its root. */
export type ParallelAuthStatus = {
  configured: boolean;
  source?: string;
  label?: string;
};

export function getParallelAuthStatus(
  ctx: ExtensionContext
): ParallelAuthStatus {
  return ctx.modelRegistry.getProviderAuthStatus(PARALLEL_PROVIDER);
}
