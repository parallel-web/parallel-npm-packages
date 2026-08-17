import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return process.argv[index + 1];
}

const dshHome = resolve(argument('--dsh-home'));
const expectedVersion = argument('--expected-version');
const profileManifest = join(dshHome, 'profiles', 'web', 'package.json');
const profileRequire = createRequire(profileManifest);
const pluginManifest = profileRequire.resolve(
  '@parallel-web/dsh-web-search/package.json'
);
const pluginRequire = createRequire(pluginManifest);

const pluginPackage = pluginRequire(pluginManifest);
assert.equal(pluginPackage.version, expectedVersion);

const resolutions = {};
for (const packageName of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-launch-environment',
]) {
  const fromProfile = realpathSync(profileRequire.resolve(packageName));
  const fromPlugin = realpathSync(pluginRequire.resolve(packageName));
  assert.equal(
    fromPlugin,
    fromProfile,
    `${packageName} must resolve to one shared entrypoint`
  );
  resolutions[packageName] = fromProfile;
}

const pluginEntry = profileRequire.resolve('@parallel-web/dsh-web-search');
const plugin = await import(pathToFileURL(pluginEntry).href);
const cordis = await import(
  pathToFileURL(resolutions['@deepseek-ai/cordis']).href
);
const web = await import(
  pathToFileURL(resolutions['@deepseek-ai/dsh-web']).href
);

const ctx = new cordis.Context();
await ctx.plugin(web.default, { searchProvider: 'parallel' });
const fiber = await ctx.plugin(plugin, {
  apiKey: 'parallel_test_packed_profile',
});

const controller = new AbortController();
controller.abort();
await assert.rejects(
  ctx.web.search({ query: 'packed profile', maxResults: 1 }, controller.signal),
  (error) => error?.code === 'WEB_ABORTED'
);

await fiber.dispose();
await assert.rejects(
  ctx.web.search({ query: 'packed profile', maxResults: 1 }),
  (error) => error?.code === 'WEB_PROVIDER_CONFIGURED_MISSING'
);

process.stdout.write(
  `packed profile valid: ${JSON.stringify({ version: pluginPackage.version, shared: Object.keys(resolutions) })}\n`
);
