import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { detectReleases } from './detect-releases.mjs';

const fixturePaths = new Set();

after(() => {
  for (const path of fixturePaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writePackage(cwd, directory, manifest) {
  const path = join(cwd, 'packages', directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-detection-'));
  fixturePaths.add(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'config', 'user.email', 'release-test@example.test');
  writePackage(cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.0.0',
  });
  writePackage(cwd, 'private-tool', {
    name: '@parallel-web/private-tool',
    version: '1.0.0',
    private: true,
  });
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'baseline');
  return { cwd, before: git(cwd, 'rev-parse', 'HEAD') };
}

function pushResult(f) {
  const sha = git(f.cwd, 'rev-parse', 'HEAD');
  return detectReleases({
    cwd: f.cwd,
    eventName: 'push',
    before: f.before,
    sha,
  });
}

test('newly added packages do not publish', () => {
  const f = fixture();
  writePackage(f.cwd, 'new-package', {
    name: '@parallel-web/new-package',
    version: '0.1.0-rc.0',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'add package');
  assert.deepEqual(pushResult(f).matrix.include, []);
});

test('metadata-only manifest changes do not publish', () => {
  const f = fixture();
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.0.0',
    description: 'metadata only',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'edit metadata');
  assert.deepEqual(pushResult(f).matrix.include, []);
});

test('stable version changes publish to latest', () => {
  const f = fixture();
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.0.1',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'bump stable');
  assert.deepEqual(pushResult(f).matrix.include, [
    {
      name: 'existing',
      dir: 'packages/existing',
      version: '1.0.1',
      tag: 'existing-v1.0.1',
      npm_tag: 'latest',
      prerelease: false,
    },
  ]);
});

test('release candidates publish to rc', () => {
  const f = fixture();
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.1.0-rc.1',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'bump rc');
  assert.equal(pushResult(f).matrix.include[0].npm_tag, 'rc');
  assert.equal(pushResult(f).matrix.include[0].prerelease, true);
});

test('private packages and existing release tags are skipped', () => {
  const f = fixture();
  writePackage(f.cwd, 'private-tool', {
    name: '@parallel-web/private-tool',
    version: '1.0.1',
    private: true,
  });
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.0.1',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'bump packages');
  git(f.cwd, 'tag', 'existing-v1.0.1');
  assert.deepEqual(pushResult(f).matrix.include, []);
});

test('manual dispatch explicitly selects an untagged package', () => {
  const f = fixture();
  const result = detectReleases({
    cwd: f.cwd,
    eventName: 'workflow_dispatch',
    inputPackage: 'existing',
    ref: 'refs/heads/main',
    sha: f.before,
  });
  assert.equal(result.any, true);
  assert.equal(result.matrix.include[0].name, 'existing');
});

test('manual dispatch rejects invalid and missing package names', () => {
  const f = fixture();
  for (const inputPackage of [undefined, '', '../existing', 'missing']) {
    assert.throws(
      () =>
        detectReleases({
          cwd: f.cwd,
          eventName: 'workflow_dispatch',
          inputPackage,
          ref: 'refs/heads/main',
          sha: f.before,
        }),
      inputPackage === 'missing'
        ? /no package found/
        : /must be a package directory name/
    );
  }
});

test('manual dispatch rejects any ref other than main', () => {
  const f = fixture();
  for (const ref of [undefined, 'refs/heads/feature', 'refs/tags/v1.0.0']) {
    assert.throws(
      () =>
        detectReleases({
          cwd: f.cwd,
          eventName: 'workflow_dispatch',
          inputPackage: 'existing',
          ref,
          sha: f.before,
        }),
      /must run from main/
    );
  }
});

test('push detection rejects mismatched package names', () => {
  const f = fixture();
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/wrong-name',
    version: '1.0.1',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'mismatch package name');
  assert.throws(() => pushResult(f), /must be named @parallel-web\/existing/);
});

test('push detection rejects unsupported versions', () => {
  const f = fixture();
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.0.1-beta.1',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'unsupported version');
  assert.throws(() => pushResult(f), /has unsupported version/);
});

test('push detection falls back to the valid head parent', () => {
  const f = fixture();
  writePackage(f.cwd, 'existing', {
    name: '@parallel-web/existing',
    version: '1.0.1',
  });
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-m', 'bump with missing before');
  const sha = git(f.cwd, 'rev-parse', 'HEAD');
  const result = detectReleases({
    cwd: f.cwd,
    eventName: 'push',
    before: 'missing',
    sha,
  });
  assert.equal(result.matrix.include[0].version, '1.0.1');
});

test('push detection fails closed without a valid base or head', () => {
  const f = fixture();
  assert.throws(
    () =>
      detectReleases({
        cwd: f.cwd,
        eventName: 'push',
        before: 'missing',
        sha: 'missing',
      }),
    /refusing to publish/
  );
});
