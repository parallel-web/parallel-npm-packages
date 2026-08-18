# Contributing

Thank you for improving the Parallel Responses research subagent for DeepSeek
Harness.

## Scope

Version one is intentionally one remote, answer-producing research worker. A
caller gives it one explicit text prompt; it makes one bounded Responses request
and returns the answer plus source URLs through Harness's existing subagent
contract.

The following are outside this package's current scope:

- a general Harness LLM provider or replacement for `web_search`;
- parent conversation, file, workspace, or environment inheritance;
- child tools, structured output, background jobs, continuation, or polling;
- retries, endpoint overrides, arbitrary model selection, or additional knobs;
- changing `@parallel-web/dsh-web-search`; and
- compatibility claims beyond the pinned Harness release.

Propose broader product or API changes before implementing them.

## Set up

Prerequisites are Node.js `^22.19.0 || >=24.0.0` and Corepack. Run these
commands from the monorepo root; the repository pins the pnpm version.

```sh
corepack enable
pnpm install --frozen-lockfile
```

Run the complete keyless package suite:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent check
```

`check` performs strict type checking, linting, deterministic tests, the
ESM/type build, manifest validation, and a package-content allowlist check.

`pnpm audit --prod` is monorepo-wide even with a workspace filter. Run it
separately and inspect whether a reported dependency path starts with
`packages__dsh-responses-subagent>`; unrelated advisories in another workspace
package do not make this package's keyless suite fail.

## Verify the packed artifact

Create one fresh tarball and verify its exact contents:

```sh
PACK_DIR="$(mktemp -d)"
pnpm --dir packages/dsh-responses-subagent pack --pack-destination "$PACK_DIR"
PACK_TGZ="$(find "$PACK_DIR" -name '*.tgz' -print -quit)"
node packages/dsh-responses-subagent/scripts/verify-packed-artifact.mjs \
  --tarball "$PACK_TGZ"
```

Use a disposable DSH home to prove installation, composition, and removal:

```sh
REVIEW_DSH_HOME="$(mktemp -d)"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-responses-subagent exec \
  dsh --profile web --dump-config > "$REVIEW_DSH_HOME/before.yml"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-responses-subagent exec \
  dsh plugin --profile web add "$PACK_TGZ"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-responses-subagent exec \
  dsh --profile web --dump-config > "$REVIEW_DSH_HOME/after.yml"
PACKAGE_VERSION="$(node -p "require('./packages/dsh-responses-subagent/package.json').version")"
node packages/dsh-responses-subagent/scripts/verify-packed-profile.mjs \
  --dsh-home "$REVIEW_DSH_HOME" \
  --expected-version "$PACKAGE_VERSION"
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-responses-subagent exec \
  dsh plugin --profile web remove @parallel-web/dsh-responses-subagent
DSH_HOME="$REVIEW_DSH_HOME" pnpm --dir packages/dsh-responses-subagent exec \
  dsh --profile web --dump-config > "$REVIEW_DSH_HOME/removed.yml"
node packages/dsh-responses-subagent/scripts/verify-profile-overlay.mjs \
  --before "$REVIEW_DSH_HOME/before.yml" \
  --after "$REVIEW_DSH_HOME/after.yml" \
  --removed "$REVIEW_DSH_HOME/removed.yml"
```

The packed-profile check verifies the public provider registration and one
shared Cordis/subagent runtime. The overlay check proves that both opt-in rows
appear only while installed and that the existing Search and built-in subagent
rows stay unchanged.

## Live end-to-end test

The normal suite is credentialless. `test:e2e` is opt-in because it sends one
real medium-tier Parallel Responses request and may cost $0.05 when successful.
Export `PARALLEL_API_KEY` in the shell first, then run exactly one attempt:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent test:e2e
```

The live receipt contains only package version, status, elapsed time, call
count, citation count, and URL hosts. It must not include the key, request
headers, raw server object, or complete answer. Do not retry a failed live test
automatically; diagnose it first.

## Secrets and public artifacts

- Never commit API keys, tokens, `.env` files, request headers, raw live API
  responses, or full environment dumps.
- Use obvious sentinel values and `.test` or loopback hosts in deterministic
  tests.
- Do not add local absolute paths, private repository facts, planning artifacts,
  or evaluation outputs to package contents.
- Inspect `pnpm pack --dry-run` before release. Only the files listed in
  `package.json` may ship.
- Preserve exact non-secret request counts and failure statuses in evaluation
  receipts; do not log authorization headers or raw response objects.

## Pull requests

Keep changes narrow and include focused proof for request shape, citations,
cancellation, disposal, and capacity. Before requesting review, run the keyless
suite and packed install/remove workflow above, then inspect the monorepo-wide
production audit by dependency path. State explicitly whether the single live
test ran.

For help, contact [support@parallel.ai](mailto:support@parallel.ai).
