import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

const DEFAULT_PLATFORM_ORIGIN = 'https://platform.parallel.ai';
const DEFAULT_CALLBACK_TIMEOUT_MS = 120_000;
/** Loopback host the local OAuth callback server binds to. */
const LOOPBACK_HOST = '127.0.0.1';

export interface LoginWithParallelOptions {
  /** Override the platform origin. Defaults to PARALLEL_PLATFORM_URL or https://platform.parallel.ai. */
  platformOrigin?: string;
  /** Milliseconds to wait for the browser callback before giving up. */
  callbackTimeoutMs?: number;
  /** Whether to attempt to open the auth URL in the user's default browser. Default true. */
  openBrowser?: boolean;
  /** Invoked once the auth URL is known, before waiting on the callback. */
  onAuthUrl?: (authUrl: string, browserOpened: boolean) => void;
  /**
   * Called if the loopback callback times out, to ask the user to paste the
   * callback URL manually. Should return undefined to abort.
   */
  promptForCallback?: (authUrl: string) => Promise<string | undefined>;
}

export interface LoginWithParallelResult {
  apiKey: string;
}

function resolvePlatformOrigin(override?: string) {
  const raw =
    override ?? process.env.PARALLEL_PLATFORM_URL ?? DEFAULT_PLATFORM_ORIGIN;
  return raw.replace(/\/$/, '');
}

function toBase64Url(value: Buffer) {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePkce() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openExternalUrl(url: string) {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function writeCallbackResponse(
  res: ServerResponse,
  statusCode: number,
  body: string
) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body><p>${body}</p></body></html>`);
}

async function startCallbackListener() {
  let resolveCallback: ((value: string) => void) | undefined;
  let rejectCallback: ((reason?: unknown) => void) | undefined;

  const callbackUrlPromise = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = req.url ?? '/';
    const callbackUrl = `${callbackOrigin}${requestUrl}`;
    const url = new URL(callbackUrl);

    if (url.pathname !== '/callback') {
      writeCallbackResponse(res, 404, 'Not found.');
      return;
    }

    if (url.searchParams.get('error')) {
      writeCallbackResponse(
        res,
        400,
        'Parallel login was denied. You can close this tab.'
      );
    } else {
      writeCallbackResponse(
        res,
        200,
        'Parallel login completed. You can close this tab.'
      );
    }

    resolveCallback?.(callbackUrl);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const callbackOrigin = `http://${LOOPBACK_HOST}:${address.port}`;
  const redirectUri = `${callbackOrigin}/callback`;

  return {
    redirectUri,
    async waitForCallbackUrl(timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS) {
      const timer = setTimeout(() => {
        rejectCallback?.(new Error('Parallel login timed out.'));
      }, timeoutMs);
      try {
        return await callbackUrlPromise;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function exchangeCodeForApiKey(
  platformOrigin: string,
  code: string,
  verifier: string,
  redirectUri: string
) {
  const response = await fetch(`${platformOrigin}/getKeys/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: new URL(redirectUri).hostname,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Parallel token exchange failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Parallel token exchange did not return an API key.');
  }
  return payload.access_token;
}

/**
 * Runs the PKCE OAuth flow against platform.parallel.ai and returns a
 * long-lived API key. Storage of that key is the caller's responsibility.
 */
export async function loginWithParallel(
  opts: LoginWithParallelOptions = {}
): Promise<LoginWithParallelResult> {
  const platformOrigin = resolvePlatformOrigin(opts.platformOrigin);
  const callbackListener = await startCallbackListener();
  const { verifier, challenge } = generatePkce();
  const state = randomUUID();

  try {
    const authUrl = new URL(`${platformOrigin}/getKeys/authorize`);
    authUrl.searchParams.set(
      'client_id',
      new URL(callbackListener.redirectUri).hostname
    );
    authUrl.searchParams.set('redirect_uri', callbackListener.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'key:read');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    const browserOpened =
      opts.openBrowser === false ? false : openExternalUrl(authUrl.toString());

    opts.onAuthUrl?.(authUrl.toString(), browserOpened);

    let callbackUrl: string | undefined;
    try {
      callbackUrl = await callbackListener.waitForCallbackUrl(
        opts.callbackTimeoutMs
      );
    } catch {
      callbackUrl = await opts.promptForCallback?.(authUrl.toString());
    }

    if (!callbackUrl) {
      throw new Error('Parallel login was not completed.');
    }

    const url = new URL(callbackUrl);
    if (url.searchParams.get('state') !== state) {
      throw new Error('Parallel login state check failed.');
    }
    if (url.searchParams.get('error')) {
      throw new Error(
        `Parallel login failed: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`
      );
    }

    const code = url.searchParams.get('code');
    if (!code) {
      throw new Error(
        'Parallel login callback did not include an authorization code.'
      );
    }

    const apiKey = await exchangeCodeForApiKey(
      platformOrigin,
      code,
      verifier,
      callbackListener.redirectUri
    );

    return { apiKey };
  } finally {
    await callbackListener.close();
  }
}
