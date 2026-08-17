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

assert.equal(manifest.name, '@parallel-web/dsh-web-search');
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
assert.equal(manifest.author, 'Parallel Web');
assert.equal(manifest.type, 'module');
assert.equal(manifest.license, 'MIT');
assert.deepEqual(manifest.repository, {
  type: 'git',
  url: 'git+https://github.com/parallel-web/parallel-npm-packages.git',
  directory: 'packages/dsh-web-search',
});
assert.equal(manifest.packageManager, undefined);
assert.equal(rootManifest.packageManager, 'pnpm@11.21.0');
assert.equal(manifest.engines.node, '^22.19.0 || >=24.0.0');
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
assert.deepEqual(manifest.dependencies, {
  '@deepseek-ai/schemastery': '3.18.1',
  'parallel-web': '1.3.0',
});
assert.deepEqual(manifest.peerDependencies, {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-launch-environment': '0.1.0-rc.6',
  '@deepseek-ai/dsh-web': '0.1.0-rc.6',
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
assert.equal(manifest.devDependencies['js-yaml'], '4.2.0');
assert.equal(
  manifest.devDependencies['@deepseek-ai/dsh-invariants'],
  undefined
);
assert.equal(manifest.exports['./invariant'], undefined);
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
    id: 'web',
    name: '@deepseek-ai/dsh-web',
    config: { searchProvider: 'parallel' },
  },
  {
    insert: [
      {
        id: 'web-search-parallel',
        name: '@parallel-web/dsh-web-search',
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
assert.equal(
  'fetch' in built,
  false,
  'the search-only package must not export fetch'
);
assert.equal(
  'registerFetchProvider' in built,
  false,
  'the search-only package must not export a fetch registrar'
);
assert.equal(built.PARALLEL_PROVIDER_ID, 'parallel');
assert.equal(
  built.Config.dict.apiKey.meta.role,
  'secret',
  'the packaged API key schema must retain secret redaction metadata'
);

process.stdout.write('manifest, patch, and public export surface are valid\n');
