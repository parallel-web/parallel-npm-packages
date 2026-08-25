import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { connect, type Socket } from 'node:net';
import { loginWithParallel } from '../index.js';

const PLATFORM_ORIGIN = 'https://example.test';

/**
 * Hits the local callback server the flow spins up. Uses node:http directly so
 * it is not affected by tests that stub the global `fetch`.
 */
function hitCallback(callbackUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(callbackUrl, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
  });
}

function toBase64Url(value: Buffer) {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** Builds a successful token-exchange fetch mock and installs it globally. */
function stubTokenExchange(accessToken = 'sk-test-key') {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ access_token: accessToken }), {
        status: 200,
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Drives the flow to completion by replying to the callback the way the
 * platform would. `respond` receives the parsed authorize URL and returns the
 * query string appended to the redirect URI.
 */
async function login(
  respond: (authUrl: URL) => string,
  opts: { onAuthUrl?: (authUrl: URL) => void } = {}
) {
  return loginWithParallel({
    platformOrigin: PLATFORM_ORIGIN,
    openBrowser: false,
    onAuthUrl: (rawUrl) => {
      const authUrl = new URL(rawUrl);
      opts.onAuthUrl?.(authUrl);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      if (!redirectUri) throw new Error('missing redirect_uri');
      void hitCallback(`${redirectUri}${respond(authUrl)}`);
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loginWithParallel', () => {
  it('builds an authorize URL with the required PKCE parameters', async () => {
    stubTokenExchange();
    let captured: URL | undefined;

    await login(
      (authUrl) => {
        const state = authUrl.searchParams.get('state') ?? '';
        return `?code=abc&state=${encodeURIComponent(state)}`;
      },
      { onAuthUrl: (authUrl) => (captured = authUrl) }
    );

    expect(captured).toBeDefined();
    const params = captured!.searchParams;
    expect(captured!.origin + captured!.pathname).toBe(
      `${PLATFORM_ORIGIN}/getKeys/authorize`
    );
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('key:read');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('state')).toBeTruthy();
    expect(params.get('client_id')).toBe('127.0.0.1');
    expect(params.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/
    );
  });

  it('sends a code_challenge that is the S256 hash of the exchanged verifier', async () => {
    const fetchMock = stubTokenExchange();
    let challenge: string | undefined;

    await login(
      (authUrl) => {
        const state = authUrl.searchParams.get('state') ?? '';
        return `?code=abc&state=${encodeURIComponent(state)}`;
      },
      {
        onAuthUrl: (authUrl) => {
          challenge = authUrl.searchParams.get('code_challenge') ?? undefined;
        },
      }
    );

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    const verifier = body.get('code_verifier');
    expect(verifier).toBeTruthy();

    const expected = toBase64Url(
      createHash('sha256')
        .update(verifier as string)
        .digest()
    );
    expect(challenge).toBe(expected);
  });

  it('exchanges the authorization code for an API key', async () => {
    const fetchMock = stubTokenExchange('sk-live-123');

    const result = await login((authUrl) => {
      const state = authUrl.searchParams.get('state') ?? '';
      return `?code=the-code&state=${encodeURIComponent(state)}`;
    });

    expect(result.apiKey).toBe('sk-live-123');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PLATFORM_ORIGIN}/getKeys/token`);
    const body = init?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBeTruthy();
  });

  it('rejects when the callback state does not match', async () => {
    const fetchMock = stubTokenExchange();

    await expect(
      login(() => `?code=abc&state=not-the-real-state`)
    ).rejects.toThrow(/state check failed/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the callback returns an error', async () => {
    const fetchMock = stubTokenExchange();

    await expect(
      login((authUrl) => {
        const state = authUrl.searchParams.get('state') ?? '';
        return `?error=access_denied&error_description=nope&state=${encodeURIComponent(state)}`;
      })
    ).rejects.toThrow(/login failed: nope/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('finishes login without waiting for the callback client to disconnect', async () => {
    stubTokenExchange();
    let socket: Socket | undefined;

    const loginPromise = loginWithParallel({
      platformOrigin: PLATFORM_ORIGIN,
      openBrowser: false,
      onAuthUrl: (rawUrl) => {
        const authUrl = new URL(rawUrl);
        const redirectUri = new URL(
          authUrl.searchParams.get('redirect_uri') ?? ''
        );
        const state = authUrl.searchParams.get('state') ?? '';
        socket = connect(Number(redirectUri.port), redirectUri.hostname, () => {
          socket?.write(
            `POST ${redirectUri.pathname}?code=abc&state=${encodeURIComponent(state)} HTTP/1.1\r\n` +
              `Host: ${redirectUri.host}\r\n` +
              'Transfer-Encoding: chunked\r\n' +
              'Connection: keep-alive\r\n\r\n' +
              '1\r\nx\r\n'
          );
        });
        socket.on('error', () => {});
        socket.resume();
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      loginPromise.then((result) => ({ result })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), 1_000);
      }),
    ]);

    clearTimeout(timer);
    socket?.destroy();
    await loginPromise;

    expect(outcome).toEqual({ result: { apiKey: 'sk-test-key' } });
  });

  it('handles a follow-up request while the callback listener is closing', async () => {
    let socket: Socket | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        setImmediate(() => {
          socket?.write(
            '0\r\n\r\n' +
              'GET /favicon.ico HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Connection: close\r\n\r\n'
          );
        });
        return new Response(JSON.stringify({ access_token: 'sk-test-key' }), {
          status: 200,
        });
      })
    );

    const result = await loginWithParallel({
      platformOrigin: PLATFORM_ORIGIN,
      openBrowser: false,
      onAuthUrl: (rawUrl) => {
        const authUrl = new URL(rawUrl);
        const redirectUri = new URL(
          authUrl.searchParams.get('redirect_uri') ?? ''
        );
        const state = authUrl.searchParams.get('state') ?? '';
        socket = connect(Number(redirectUri.port), redirectUri.hostname, () => {
          socket?.write(
            `POST ${redirectUri.pathname}?code=abc&state=${encodeURIComponent(state)} HTTP/1.1\r\n` +
              `Host: ${redirectUri.host}\r\n` +
              'Transfer-Encoding: chunked\r\n' +
              'Connection: keep-alive\r\n\r\n' +
              '1\r\nx\r\n'
          );
        });
        socket.on('error', () => {});
        socket.resume();
        socket.setTimeout(1_000, () => socket?.destroy());
      },
    });

    expect(result.apiKey).toBe('sk-test-key');
  });
});
