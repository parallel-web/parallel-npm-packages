# @parallel-web npm packages

Monorepo for @parallel-web npm packages.

## Packages

- [`@parallel-web/ai-sdk-tools`](./packages/ai-sdk-tools) - AI SDK tools for Parallel Web
- [`@parallel-web/dsh-web-search`](./packages/dsh-web-search) - Parallel Search provider for DeepSeek Harness
- [`@parallel-web/opencode-plugin`](./packages/opencode-plugin) - Opencode plugin for Parallel Web
- [`@parallel-web/pi-extension`](./packages/pi-extension) - pi agent extension for Parallel Web
- `@parallel-web/oauth` - Internal, unpublished shared PKCE OAuth helper. Bundled into the opencode plugin and pi extension at build time (`noExternal`), so it is never installed by consumers and is intentionally marked `private`.

## Development

This is a pnpm monorepo requiring Node >= 22.13. The pnpm version is pinned by
the `packageManager` field in `package.json`, so use corepack rather than a
globally installed pnpm:

```bash
corepack enable
```

### Setup

Install dependencies:

```bash
pnpm install
```

#### With Nix (optional)

A flake provides Node and a corepack-backed `pnpm` matching CI:

```bash
nix develop
pnpm install
```

With [direnv](https://direnv.net), `echo "use flake" > .envrc && direnv allow`
enters the shell automatically. `.envrc` is gitignored, so this stays per-developer.

### Commands

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Run tests in CI mode (no watch)
pnpm test:ci

# Lint
pnpm lint

# Fix linting issues
pnpm lint:fix

# Format code
pnpm format

# Check formatting
pnpm format:check

# Type check
pnpm typecheck

# Clean build artifacts
pnpm clean
```

### Workspace Commands

To run a command in a specific package:

```bash
pnpm --filter @parallel-web/ai-sdk-tools build
pnpm --filter @parallel-web/ai-sdk-tools test
```

### Adding a New Package

1. Create a new directory in `packages/`
2. Add a `package.json` with the package name `@parallel-web/package-name`
3. Set up TypeScript config extending from root
4. Add build configuration appropriate for the package
5. Implement your package

## Publishing

Each package is versioned, tagged, and released **independently**. Releases are PR-driven:
a local script opens a version-bump PR, and merging it publishes to npm. See
[`PUBLISHING.md`](./PUBLISHING.md) for the full guide.

```bash
git checkout main && git pull

# Release candidate (1.2.0 -> 1.3.0-rc.1, or bump an existing rc)
./scripts/release.sh ai-sdk-tools rc

# Promote the current RC to stable (1.3.0-rc.2 -> 1.3.0)
./scripts/release.sh ai-sdk-tools stable

# Explicit version
./scripts/release.sh opencode-plugin 2.0.0
```

The script bumps the version, opens a `release/<package>-vX.Y.Z` PR, and on merge the
**Release** workflow (`.github/workflows/release.yml`) builds/tests the package, publishes to
npm, and creates the per-package git tag `<package>-vX.Y.Z` plus a GitHub Release.

- **RC support**: `x.y.z-rc.N` versions publish under the `rc` npm dist-tag; stable versions
  under `latest`. So `npm install @parallel-web/<package>` gets the latest stable, and
  `@rc` opts into pre-releases.
- **Per-package tags**: tags are namespaced per package and never collide.
- **Trusted publishing**: uses npm OIDC trusted publishing — no npm token is stored in the repo.

## License

MIT
