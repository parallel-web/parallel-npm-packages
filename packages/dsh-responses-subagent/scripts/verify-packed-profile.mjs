import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  const value = process.argv[index + 1];
  assert.ok(value, `missing value for ${name}`);
  return value;
}

const dshHome = resolve(argument('--dsh-home'));
const expectedVersion = argument('--expected-version');
const profileManifest = join(dshHome, 'profiles', 'web', 'package.json');
const profileRequire = createRequire(profileManifest);
const pluginManifest = profileRequire.resolve(
  '@parallel-web/dsh-responses-subagent/package.json'
);
const pluginRequire = createRequire(pluginManifest);

const pluginPackage = pluginRequire(pluginManifest);
assert.equal(pluginPackage.version, expectedVersion);

const resolutions = {};
for (const packageName of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tool-subagent',
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

const pluginEntry = profileRequire.resolve(
  '@parallel-web/dsh-responses-subagent'
);
const plugin = await import(pathToFileURL(pluginEntry).href);
const cordis = await import(
  pathToFileURL(resolutions['@deepseek-ai/cordis']).href
);
const subagents = await import(
  pathToFileURL(resolutions['@deepseek-ai/dsh-subagent']).href
);

assert.equal('default' in plugin, false);
assert.equal(plugin.PARALLEL_RESPONSES_PROVIDER_ID, 'parallel-responses');
assert.equal(plugin.Config.dict.apiKey.meta.role, 'secret');

const ctx = new cordis.Context();
const runtimeFiber = await ctx.plugin(subagents.default);
const providerFiber = await ctx.plugin(plugin, {
  apiKey: 'parallel_test_packed_profile',
});
assert.deepEqual(ctx.subagents.list(), ['parallel-responses']);
const provider = ctx.subagents.getProvider('parallel-responses');
assert.ok(provider);
assert.equal(provider.name, 'parallel-responses');
assert.deepEqual(provider.capabilities, {
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
});
assert.equal(provider.inheritsParentContext, false);
assert.equal(typeof provider.start, 'function');
assert.equal('prepareContinuable' in provider, false);

await providerFiber.dispose();
assert.equal(ctx.subagents.getProvider('parallel-responses'), undefined);
await runtimeFiber.dispose();

process.stdout.write(
  `packed profile valid: ${JSON.stringify({ version: pluginPackage.version, shared: Object.keys(resolutions) })}\n`
);
