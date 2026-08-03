import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loginWithParallel as runParallelOAuth } from '@parallel-web/oauth';

const CREDENTIALS_DIR = join(homedir(), '.parallel');
const CREDENTIALS_PATH = join(CREDENTIALS_DIR, 'pi-credentials.json');

type StoredCredentials = {
  apiKey: string;
};

function readStoredCredentials(): StoredCredentials | undefined {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.apiKey === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredCredentials(credentials: StoredCredentials) {
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  // Write to a temp file first so a crash mid-write can't corrupt the credentials file.
  const tmpPath = `${CREDENTIALS_PATH}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(credentials), { mode: 0o600 });
  rmSync(CREDENTIALS_PATH, { force: true });
  writeFileSync(CREDENTIALS_PATH, readFileSync(tmpPath), { mode: 0o600 });
  rmSync(tmpPath, { force: true });
}

export async function getParallelApiKey(_ctx: ExtensionContext) {
  const stored = readStoredCredentials()?.apiKey;
  if (stored) {
    return stored;
  }

  return process.env.PARALLEL_API_KEY;
}

export function clearStoredParallelApiKey(_ctx: ExtensionContext) {
  rmSync(CREDENTIALS_PATH, { force: true });
}

export function storeParallelApiKey(_ctx: ExtensionContext, apiKey: string) {
  writeStoredCredentials({ apiKey });
}

export async function loginWithParallel(ctx: ExtensionContext) {
  const { apiKey } = await runParallelOAuth({
    onAuthUrl: (_url, browserOpened) => {
      if (browserOpened) {
        ctx.ui.notify('Opening Parallel login in your browser.', 'info');
      }
    },
    promptForCallback: async (authUrl) => {
      return await ctx.ui.input(
        'Paste the Parallel callback URL from your browser',
        authUrl
      );
    },
  });

  storeParallelApiKey(ctx, apiKey);
  return apiKey;
}
