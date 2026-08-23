# Publishing Guide

This monorepo tracks five publishable npm packages, each versioned, tagged, and released
**independently**:

- `@parallel-web/ai-sdk-tools` — `packages/ai-sdk-tools`
- `@parallel-web/dsh-responses-subagent` — `packages/dsh-responses-subagent`
- `@parallel-web/dsh-web-search` — `packages/dsh-web-search`
- `@parallel-web/opencode-plugin` — `packages/opencode-plugin`
- `@parallel-web/pi-extension` — `packages/pi-extension`

`@parallel-web/dsh-responses-subagent` has not yet been published. It can be installed only
from a local tarball until an npm organization owner completes its reviewed first release.

(`@parallel-web/oauth` in `packages/parallel-oauth` is `private` — it is bundled into the
OpenCode plugin and Pi extension at build time and is never published.)

## How releases work

Routine releases are **PR-driven** and automated on merge. The manual exceptions are the
one-time bootstrap for a new npm package and recovery from an interrupted publish.

1. You run `./scripts/release.sh <package> <rc|stable|X.Y.Z>` locally. It bumps the version
   in that package's `package.json`, creates a `release/<package>-vX.Y.Z` branch, commits with
   message `chore(<package>): bump version to X.Y.Z`, pushes, and opens a PR.
2. You review and merge the PR.
3. `.github/workflows/release.yml` runs on the push to `main`. It detects existing public
   packages whose version changed, and for each whose `<package>-vX.Y.Z` git tag does not yet
   exist, it builds + lints + type-checks + tests that package, packs and publishes it to npm,
   creates the git tag `<package>-vX.Y.Z`, and cuts a GitHub Release. Adding a package or editing
   metadata without changing its version does not publish it.

### Per-package git tags

Tags are namespaced per package (e.g. `ai-sdk-tools-v1.1.0`, `opencode-plugin-v1.3.0`). They are
**not** tied to npm dist-tags and never collide across packages — each package has its own
independent version line. (The legacy shared `vX.Y.Z` tags are obsolete and unused.)

### RC support / npm dist-tags

Pre-releases publish under the `rc` npm dist-tag; stable releases publish under `latest`. The
version string drives this automatically:

- `1.2.0-rc.1` → published with `--tag rc`, GitHub Release marked as pre-release.
- `1.2.0` → published with `--tag latest`.

So `npm install @parallel-web/<package>` always resolves to the latest **stable** release;
`npm install @parallel-web/<package>@rc` opts into the latest pre-release.

### Trusted publishing (OIDC)

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) via GitHub
OIDC — **no npm token is stored in the repo**. The workflow upgrades npm to the latest version
first, because trusted publishing requires npm ≥ 11.5.1 (newer than what Node 20 bundles).
Skipping that upgrade causes a misleading `404 Not Found` on the publish `PUT`.

### First release of a new package

npm requires a package to exist before its trusted publisher can be configured. Adding a package
to this repository intentionally does not publish it. An npm organization owner must first publish
the reviewed bootstrap release manually from a clean, updated `main` checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @parallel-web/dsh-responses-subagent check
BOOTSTRAP_DIR="$(mktemp -d)"
pnpm --dir packages/dsh-responses-subagent pack --pack-destination "$BOOTSTRAP_DIR"
BOOTSTRAP_TARBALL="$(find "$BOOTSTRAP_DIR" -name '*.tgz' -print -quit)"
npm publish "$BOOTSTRAP_TARBALL" --access public --tag rc
npm view @parallel-web/dsh-responses-subagent dist-tags --json
```

The npm owner should inspect the tarball listing before the publish and complete npm's 2FA prompt.
The explicit `--tag rc` is required: npm otherwise assigns even a prerelease version to `latest`.
The bootstrap intentionally has no git tag or GitHub Release. After it succeeds, configure the
package's trusted publisher for:

- organization: `parallel-web`
- repository: `parallel-npm-packages`
- workflow: `release.yml`
- allowed action: `npm publish`

After that one-time bootstrap, use `scripts/release.sh` for every later RC and stable release; those
releases create the package git tag and GitHub Release normally. Never add a long-lived npm publish
token to this repository.

## Cutting a release

From a clean `main`:

```bash
git checkout main && git pull

# Release candidate (1.2.0 -> 1.3.0-rc.1, or 1.3.0-rc.1 -> 1.3.0-rc.2)
./scripts/release.sh ai-sdk-tools rc

# Promote the current RC to stable (1.3.0-rc.2 -> 1.3.0)
./scripts/release.sh ai-sdk-tools stable

# Set an explicit version
./scripts/release.sh opencode-plugin 2.0.0
./scripts/release.sh pi-extension 2.0.0-rc.1
```

The script refuses to run on a dirty tree, off `main`, or if the target tag already exists. It
prints the computed version and asks for confirmation before pushing. Merge the resulting PR to
trigger the publish.

## Verifying a release

```bash
# npm
npm view @parallel-web/ai-sdk-tools version          # latest stable
npm view @parallel-web/ai-sdk-tools dist-tags         # latest + rc

# git tags / GitHub Releases
git fetch --tags && git tag -l 'ai-sdk-tools-v*'
```

## Re-publishing / manual trigger

If a publish step failed after the version was already merged (so the tag was never created), use
the workflow's `workflow_dispatch` input on the `main` branch to re-run it for a single package at
its current `package.json` version. The release detector rejects every other branch or tag:

- Actions → **Release** → **Run workflow** → enter the package directory name (e.g.
  `opencode-plugin`).

The workflow packs the package before checking npm. If that exact tarball is already published,
it verifies the registry integrity and continues with tag and GitHub Release creation without
publishing again. If the published contents differ or the registry lookup fails, the workflow
stops before creating the tag.

If the tag already exists the run is a no-op (the package is considered already released); bump
to a new version with `scripts/release.sh` instead.

## Troubleshooting

### `404 Not Found` on `npm publish`

Trusted publishing requires npm ≥ 11.5.1. The workflow runs `npm install -g npm@latest` to
satisfy this; if you see this error, confirm that step ran and that the package's trusted
publisher is configured on npmjs.com for this repo + the `Release` workflow.

### `tag <package>-vX.Y.Z already exists`

That version was already released. Bump to a new version with `scripts/release.sh`.

### Tests fail during publish

Set the `PARALLEL_API_KEY` repository secret (used by `ai-sdk-tools` / `opencode-plugin` tests),
and run the package's tests locally first: `cd packages/<package> && pnpm test`.

## Rolling back

npm unpublish is discouraged. Prefer publishing a patch, or move the `latest` dist-tag:

```bash
npm dist-tag add @parallel-web/ai-sdk-tools@1.2.3 latest   # roll latest back to a known-good version
npm deprecate @parallel-web/ai-sdk-tools@1.2.4 "Use 1.2.5 instead"
```
