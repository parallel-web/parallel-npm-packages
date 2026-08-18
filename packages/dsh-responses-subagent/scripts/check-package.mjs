import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, 'npm_execpath is required to run the pinned pnpm CLI');

const result = spawnSync(
  process.execPath,
  [pnpmCli, 'pack', '--dry-run', '--json'],
  {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  }
);
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const jsonStart = result.stdout.lastIndexOf('\n{');
assert.notEqual(jsonStart, -1, 'pnpm pack did not emit a JSON receipt');
const pack = JSON.parse(result.stdout.slice(jsonStart + 1));
const files = pack.files.map((file) => file.path).sort();
assert.deepEqual(files, [
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'cordis.patch.yml',
  'lib/index.d.ts',
  'lib/index.js',
  'package.json',
]);
process.stdout.write('package dry-run allowlist is valid\n');
