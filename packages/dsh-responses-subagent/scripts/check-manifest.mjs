import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
const rootManifest = JSON.parse(
  await readFile(new URL('../../../package.json', import.meta.url), 'utf8')
);

assert.equal(manifest.name, '@parallel-web/dsh-responses-subagent');
assert.equal(manifest.version, '0.1.0-rc.0');
assert.equal(manifest.author, 'Parallel Web');
assert.equal(manifest.type, 'module');
assert.equal(manifest.sideEffects, false);
assert.equal(manifest.license, 'MIT');
assert.deepEqual(manifest.repository, {
  type: 'git',
  url: 'git+https://github.com/parallel-web/parallel-npm-packages.git',
  directory: 'packages/dsh-responses-subagent',
});
assert.equal(manifest.packageManager, undefined);
assert.equal(rootManifest.packageManager, 'pnpm@11.21.0');
assert.equal(manifest.engines.node, '^22.19.0 || >=24.0.0');
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
assert.deepEqual(manifest.dependencies, {
  '@deepseek-ai/schemastery': '3.18.1',
});
assert.deepEqual(manifest.peerDependencies, {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-launch-environment': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session': '0.1.0-rc.6',
  '@deepseek-ai/dsh-subagent': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tool-subagent': '0.1.0-rc.6',
});
for (const [name, version] of Object.entries(manifest.peerDependencies)) {
  assert.equal(
    manifest.devDependencies[name],
    version,
    `${name} must have a matching exact development dependency`
  );
}
assert.equal(manifest.devDependencies['@deepseek-ai/dsh'], '0.1.0-rc.6');
assert.equal(manifest.devDependencies['@deepseek-ai/dsh-llm'], '0.1.0-rc.6');
assert.equal(
  manifest.devDependencies['@deepseek-ai/cordis-plugin-include'],
  '1.0.6'
);
assert.equal(
  manifest.devDependencies['@deepseek-ai/cordis-plugin-loader'],
  '1.0.2'
);
assert.equal(
  manifest.devDependencies['@deepseek-ai/dsh-system-prompt'],
  '0.1.0-rc.6'
);
assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], '0.1.0-rc.6');
assert.equal(manifest.devDependencies['js-yaml'], '4.2.0');
assert.deepEqual(manifest.files, [
  'lib/index.js',
  'lib/index.d.ts',
  'cordis.patch.yml',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
]);

const patchText = await readFile(
  new URL('../cordis.patch.yml', import.meta.url),
  'utf8'
);
const patch = yaml.load(patchText, { schema: entryListSchema });
assert.deepEqual(patch, [
  {
    insert: [
      {
        id: 'subagent-parallel-responses',
        name: '@parallel-web/dsh-responses-subagent',
      },
      {
        id: 'tool-subagent-parallel-responses',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: {
          provider: 'parallel-responses',
          toolName: 'parallel_research',
          enableRunInBackground: false,
          backgroundMode: 'one-shot',
          maxDepth: 'provider-managed',
        },
      },
    ],
  },
]);

const built = await import(
  new URL(`../lib/index.js?check=${Date.now()}`, import.meta.url)
);
assert.equal(
  'default' in built,
  false,
  'the Cordis namespace plugin must not have a default export'
);
assert.deepEqual(
  Object.keys(built).sort(),
  ['Config', 'PARALLEL_RESPONSES_PROVIDER_ID', 'apply', 'inject', 'name'],
  'the public surface must stay limited to the Cordis plugin contract'
);
assert.equal(built.PARALLEL_RESPONSES_PROVIDER_ID, 'parallel-responses');
assert.equal(built.name, 'subagent-parallel-responses');
assert.deepEqual(built.inject, ['subagents']);
assert.equal(
  built.Config.dict.apiKey.meta.role,
  'secret',
  'the packaged API key schema must retain secret redaction metadata'
);

process.stdout.write('manifest, patch, and public export surface are valid\n');
