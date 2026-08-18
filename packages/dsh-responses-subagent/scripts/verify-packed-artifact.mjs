import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tarballIndex = process.argv.indexOf('--tarball');
assert.notEqual(
  tarballIndex,
  -1,
  'usage: verify-packed-artifact.mjs --tarball <path>'
);
const tarballArgument = process.argv[tarballIndex + 1];
assert.ok(tarballArgument, 'missing tarball path');
const tarball = resolve(tarballArgument);

function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const entries = tar(['-tzf', tarball])
  .split('\n')
  .filter(Boolean)
  .filter((entry) => !entry.endsWith('/'))
  .sort();

assert.deepEqual(entries, [
  'package/CONTRIBUTING.md',
  'package/LICENSE',
  'package/README.md',
  'package/SECURITY.md',
  'package/cordis.patch.yml',
  'package/lib/index.d.ts',
  'package/lib/index.js',
  'package/package.json',
]);

const manifest = JSON.parse(tar(['-xOzf', tarball, 'package/package.json']));
assert.equal(manifest.name, '@parallel-web/dsh-responses-subagent');
assert.equal(manifest.version, '0.1.0-rc.0');
assert.equal(manifest.author, 'Parallel Web');
assert.deepEqual(manifest.repository, {
  type: 'git',
  url: 'git+https://github.com/parallel-web/parallel-npm-packages.git',
  directory: 'packages/dsh-responses-subagent',
});
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
assert.deepEqual(manifest.dependencies, {
  '@deepseek-ai/schemastery': '3.18.1',
});
for (const name of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tool-subagent',
]) {
  assert.equal(
    manifest.peerDependencies[name],
    name === '@deepseek-ai/cordis' ? '4.0.1' : '0.1.0-rc.6'
  );
}

const combinedPublicText = entries
  .filter((entry) => /\.(?:js|d\.ts|md|yml|json)$/.test(entry))
  .map((entry) => tar(['-xOzf', tarball, entry]))
  .join('\n');

for (const forbidden of [
  `/${'Users'}/`,
  ['developer', 'parallel', 'code'].join('/'),
  `${'.agent'}/`,
  'Authorization: Bearer',
]) {
  assert.equal(
    combinedPublicText.includes(forbidden),
    false,
    `packed artifact contains forbidden text: ${forbidden}`
  );
}

for (const required of [
  'https://api.parallel.ai/v1/responses',
  'parallel-responses',
  'parallel_research',
  'enableRunInBackground: false',
]) {
  assert.equal(
    combinedPublicText.includes(required),
    true,
    `packed artifact must retain contract text: ${required}`
  );
}

process.stdout.write(`packed artifact valid: ${tarball}\n`);
