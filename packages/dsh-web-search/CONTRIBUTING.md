# Contributing

Thank you for improving the Parallel Search provider for DeepSeek Harness.

## Scope

Version one is intentionally a native, search-only DSH provider. Changes should
preserve the existing `web_search` tool and the provider-neutral `ctx.web`
boundary.

The following are not part of this package's current scope:

- a `web_fetch` provider or Parallel Extract adapter;
- a second model-facing or MCP tool;
- configurable API endpoints or retries;
- answer, session, model, location, freshness, or source-filter options; and
- compatibility claims beyond the pinned DSH release.

Propose broader product or API changes before implementing them.

## Set up

Prerequisites are Node.js `^22.19.0 || >=24.0.0` and Corepack. Run these
commands from the monorepo root; the repository pins the pnpm version.

```sh
corepack enable
pnpm install --frozen-lockfile
```

Run the complete keyless validation suite:

```sh
pnpm --filter @parallel-web/dsh-web-search check
```

`check` performs strict type checking, linting, deterministic tests, the
ESM/type build, manifest validation, and a package-content allowlist check.

`pnpm audit --prod` is monorepo-wide even when pnpm receives a workspace
filter. Run it separately and inspect whether any reported dependency path
starts with `packages__dsh-web-search>`; unrelated advisories in
another workspace package do not make this package's keyless suite fail.

## Verify the packed artifact

Create one fresh tarball and verify its exact contents:

```sh
PACK_DIR="$(mktemp -d)"
pnpm --dir packages/dsh-web-search pack --pack-destination "$PACK_DIR"
PACK_TGZ="$(find "$PACK_DIR" -name '*.tgz' -print -quit)"
node packages/dsh-web-search/scripts/verify-packed-artifact.mjs --tarball "$PACK_TGZ"
```

Use a disposable DSH home to prove the complete install lifecycle:

```sh
REVIEW_DSH_HOME="$(mktemp -d)"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-web-search exec dsh --profile web --dump-config > "$REVIEW_DSH_HOME/before.yml"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-web-search exec dsh plugin --profile web add "$PACK_TGZ"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-web-search exec dsh --profile web --dump-config > "$REVIEW_DSH_HOME/after.yml"
PACKAGE_VERSION="$(node -p "require('./packages/dsh-web-search/package.json').version")"
node packages/dsh-web-search/scripts/verify-packed-profile.mjs \
  --dsh-home "$REVIEW_DSH_HOME" \
  --expected-version "$PACKAGE_VERSION"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-web-search exec dsh plugin --profile web remove @parallel-web/dsh-web-search
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-web-search exec dsh --profile web --dump-config > "$REVIEW_DSH_HOME/removed.yml"
node packages/dsh-web-search/scripts/verify-profile-overlay.mjs \
  --before "$REVIEW_DSH_HOME/before.yml" \
  --after "$REVIEW_DSH_HOME/after.yml" \
  --removed "$REVIEW_DSH_HOME/removed.yml"
```

The packed-profile check verifies that the installed plugin and DSH profile
resolve one shared Cordis/web runtime. The overlay check proves the transition
`deepseek-official -> parallel -> deepseek-official` while preserving the
native `tool-web` row.

## Live end-to-end test

The normal test suite is credentialless. `pnpm run test:e2e` is opt-in because
it sends one real request to Parallel Search and may consume account balance.
Export `PARALLEL_API_KEY` in the shell first, then run:

```sh
pnpm --filter @parallel-web/dsh-web-search test:e2e
```

Do not retry a failed live test automatically. Diagnose the failure first and
make another attempt only with the credential owner's authorization.

## Secrets and public artifacts

- Never commit API keys, tokens, `.env` files, request headers, or raw live API
  responses.
- Use obvious sentinel values and `.test` or loopback hosts in deterministic
  tests.
- Do not add local absolute paths, private repository facts, or planning
  artifacts to source, documentation, fixtures, logs, or package contents.
- Inspect `pnpm pack --dry-run` before release. Only the files listed in
  `package.json` may ship.
- Use `PARALLEL_LOG=info`, not `debug`, for routine endpoint/status evidence,
  and review logs before sharing them.

## Pull requests

Keep changes narrow and include the focused tests that prove the changed
contract. Before requesting review, run the keyless suite and packed
install/remove workflow above, then review the monorepo-wide production audit
by dependency path. State explicitly if the live test was not run and why.

For help, contact [support@parallel.ai](mailto:support@parallel.ai).
