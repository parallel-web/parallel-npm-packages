# @parallel-web/pi-extension

Pi extension that adds `web_search` and `web_fetch` backed by Parallel.

Install it with:
```
pi install npm:@parallel-web/pi-extension
```

## What It Does

- Registers `web_search`
- Registers `web_fetch`
- Registers a `parallel` auth provider, so Pi's own `/login parallel` runs the
  Parallel browser OAuth flow and stores the API key in Pi's auth store
  (`auth.json`) alongside every other provider credential
- Adds a `parallel-login` command that reports current auth status

Auth resolution order (owned by Pi, not the extension):

1. The credential Pi stored for provider `parallel`
2. `PARALLEL_API_KEY`

`/logout parallel` removes the stored credential, and
`pi auth check --provider parallel` reports whether it is configured.

Requires `@earendil-works/pi-coding-agent` 0.83.0 or newer.

## Dogfooding Locally

Build the extension first:

```bash
pnpm --filter @parallel-web/pi-extension build
```

### Option 1: Load It Directly With `pi -e`

This is the fastest way to test a local checkout.

From the repo root:

```bash
pi --no-extensions --no-skills -e ./packages/pi-extension/dist/index.js
```

If the extension loads successfully, Pi will have:

- the `web_search` tool
- the `web_fetch` tool
- `parallel` listed under `/login`
- the `parallel-login` status command
- per-session Parallel `session_id` reuse inside that Pi session

### Option 2: Symlink It Into Pi Extensions

This is better if you want Pi to auto-discover it and support `/reload`.

First build it:

```bash
pnpm --filter @parallel-web/pi-extension build
```

Then symlink the package directory into Pi's global extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s \
  parallel-npm-packages/packages/pi-extension \
  ~/.pi/agent/extensions/parallel-pi-extension
```

Then start Pi normally:

```bash
pi
```

After code changes, rebuild and run `/reload` inside Pi:

```bash
pnpm --filter @parallel-web/pi-extension build
```

## Local Auth Testing

### Use Stored Pi Auth

Inside Pi, run:

```text
/login parallel
```

That opens the browser for Parallel OAuth. On success, Pi stores the API key in
its auth store under `parallel`. Run `/parallel-login` to see the current status,
and `/logout parallel` to remove the credential.

### Use Environment Variable Instead

```bash
export PARALLEL_API_KEY=your_key_here
pi --no-extensions --no-skills -e ./packages/pi-extension/dist/index.js
```

Note: stored Pi auth is preferred over `PARALLEL_API_KEY` if both exist.

### Override The OAuth Platform URL

For local or staging OAuth testing, set `PARALLEL_PLATFORM_URL` before starting Pi:

```bash
export PARALLEL_PLATFORM_URL=https://your-platform-host
pi --no-extensions --no-skills -e ./packages/pi-extension/dist/index.js
```

This changes the browser login endpoints used by `/login parallel`.

## Quick Smoke Test

Once Pi is running with the extension loaded, ask something that should force web usage, for example:

```text
Search the web for the latest Parallel docs on OAuth and summarize them.
```

Or ask Pi to call the tool explicitly.

`web_search` requires `search_queries`.

`web_fetch` accepts multiple URLs in a single call, so the agent can batch extraction work instead of parallelizing many single-URL requests.

## Dev Loop

```bash
pnpm --filter @parallel-web/pi-extension build
pnpm --filter @parallel-web/pi-extension test
pnpm --filter @parallel-web/pi-extension typecheck
```

## Notes

- The extension uses the `parallel-web` TypeScript SDK directly.
- Search requests use Parallel SDK `fast` mode.
- Search requests include `client_model` when Pi has an active model selected.
- Search and extract requests reuse a generated `session_id` for the life of the current Pi session.
- The login flow tries to open your browser automatically.
- If automatic callback capture does not complete, the login dialog asks you to paste the callback URL.
- Credential storage is entirely Pi's; the extension only reads the resolved key
  through `ctx.modelRegistry.getApiKeyForProvider("parallel")`.
- Skill suppression inside the extension is prompt-level only. If you want a clean dogfooding session without your usual skills list, start Pi with `--no-skills`.
