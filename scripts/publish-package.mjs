import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export function tarballIntegrity(path) {
  return `sha512-${createHash('sha512')
    .update(readFileSync(path))
    .digest('base64')}`;
}

export async function publishedIntegrity({
  name,
  version,
  registry = DEFAULT_REGISTRY,
  fetchImpl = fetch,
}) {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const url = new URL(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    base
  );
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
  }

  const metadata = await response.json();
  const integrity = metadata?.dist?.integrity;
  if (typeof integrity !== 'string' || integrity.length === 0) {
    throw new Error('npm registry response is missing dist.integrity');
  }
  return integrity;
}

function publishTarball({ tarball, tag }) {
  const result = spawnSync(
    'npm',
    ['publish', tarball, '--access', 'public', '--tag', tag],
    { stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm publish failed with exit code ${result.status}`);
  }
}

export async function publishPackage({
  packageDir,
  tarball,
  tag,
  registry = process.env.npm_config_registry ?? DEFAULT_REGISTRY,
  fetchImpl = fetch,
  publish = publishTarball,
  log = console.log,
}) {
  const manifest = JSON.parse(
    readFileSync(resolve(packageDir, 'package.json'), 'utf8')
  );
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('package manifest must contain a name and version');
  }

  const localIntegrity = tarballIntegrity(tarball);
  const remoteIntegrity = await publishedIntegrity({
    name: manifest.name,
    version: manifest.version,
    registry,
    fetchImpl,
  });

  if (remoteIntegrity === null) {
    publish({ tarball, tag });
    log(`Published ${manifest.name}@${manifest.version}`);
    return 'published';
  }

  if (remoteIntegrity !== localIntegrity) {
    throw new Error(
      `${manifest.name}@${manifest.version} already exists with different contents`
    );
  }

  log(
    `${manifest.name}@${manifest.version} is already published with matching contents`
  );
  return 'already-published';
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'usage: publish-package.mjs --package-dir <dir> --tarball <path> --tag <tag>'
      );
    }
    options[key.slice(2)] = value;
  }
  if (!options['package-dir'] || !options.tarball || !options.tag) {
    throw new Error(
      'usage: publish-package.mjs --package-dir <dir> --tarball <path> --tag <tag>'
    );
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parseArgs(process.argv.slice(2));
  await publishPackage({
    packageDir: options['package-dir'],
    tarball: options.tarball,
    tag: options.tag,
  });
}
