import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  publishPackage,
  publishedIntegrity,
  tarballIntegrity,
} from './publish-package.mjs';

const fixturePaths = new Set();

after(() => {
  for (const path of fixturePaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-publishing-'));
  fixturePaths.add(cwd);
  const packageDir = join(cwd, 'package');
  const tarball = join(cwd, 'package.tgz');
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@parallel-web/example', version: '1.2.3' })
  );
  writeFileSync(tarball, 'packed contents');
  return { packageDir, tarball };
}

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test('computes npm-compatible sha512 integrity', () => {
  const f = fixture();
  assert.equal(
    tarballIntegrity(f.tarball),
    'sha512-yjR9D73WpIfVktyY6zgucfroT7uDZ9Yq0eP5bthQAcHt9GnReVuO1XoKjWR4Db/TZlE0s2pw3pwxLk+KtV3dbQ=='
  );
});

test('publishes the tarball when the version does not exist', async () => {
  const f = fixture();
  const calls = [];
  const result = await publishPackage({
    ...f,
    tag: 'latest',
    fetchImpl: async () => response(404),
    publish: (options) => calls.push(options),
    log: () => {},
  });

  assert.equal(result, 'published');
  assert.deepEqual(calls, [{ tarball: f.tarball, tag: 'latest' }]);
});

test('skips publishing when the existing tarball matches', async () => {
  const f = fixture();
  let published = false;
  const result = await publishPackage({
    ...f,
    tag: 'rc',
    fetchImpl: async () =>
      response(200, { dist: { integrity: tarballIntegrity(f.tarball) } }),
    publish: () => {
      published = true;
    },
    log: () => {},
  });

  assert.equal(result, 'already-published');
  assert.equal(published, false);
});

test('refuses to continue when the existing tarball differs', async () => {
  const f = fixture();
  let published = false;
  await assert.rejects(
    publishPackage({
      ...f,
      tag: 'latest',
      fetchImpl: async () =>
        response(200, { dist: { integrity: 'sha512-different' } }),
      publish: () => {
        published = true;
      },
      log: () => {},
    }),
    /already exists with different contents/
  );
  assert.equal(published, false);
});

test('fails closed on registry errors and missing integrity', async () => {
  await assert.rejects(
    publishedIntegrity({
      name: '@parallel-web/example',
      version: '1.2.3',
      fetchImpl: async () => response(500),
    }),
    /HTTP 500/
  );
  await assert.rejects(
    publishedIntegrity({
      name: '@parallel-web/example',
      version: '1.2.3',
      fetchImpl: async () => response(200, { dist: {} }),
    }),
    /missing dist.integrity/
  );
});

test('uses the exact package version endpoint', async () => {
  let requested;
  await publishedIntegrity({
    name: '@parallel-web/example',
    version: '1.2.3-rc.1',
    registry: 'https://registry.example.test/custom/',
    fetchImpl: async (url) => {
      requested = url.href;
      return response(404);
    },
  });

  assert.equal(
    requested,
    'https://registry.example.test/custom/%40parallel-web%2Fexample/1.2.3-rc.1'
  );
});
