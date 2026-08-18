# @parallel-web/pi-extension

Pi extension that adds `web_search`, `web_fetch`, and a cited research model
backed by Parallel.

Install it with:
```
pi install npm:@parallel-web/pi-extension
```

## What It Does

- Registers `web_search`
- Registers `web_fetch`
- Registers the `parallel/research` model, which makes one stateless Parallel
  Responses API call
- Ships a `parallel-research` agent for
  [pi-subagents](https://github.com/nicobailon/pi-subagents)
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

## Parallel Research Subagent

Install both packages to add the native research agent:

```bash
pi install npm:pi-subagents
pi install npm:@parallel-web/pi-extension
```

This integration requires pi-subagents 0.50.0 or newer. The rest of the Pi
extension still works without pi-subagents.

Run one research child directly:

```text
/run parallel-research Compare the current JavaScript runtimes in Node and Bun. Cite primary sources.
```

The agent is also an ordinary pi-subagents child in JavaScript code mode. Its
`output` is the cited research text, so a later branch can use it directly:

```javascript
const research = await runs.run("research", {
  agent: "parallel-research",
  task: "Which JavaScript runtime currently has stronger Node API compatibility? Cite primary sources.",
  thinking: "medium",
  context: "fresh",
  worktree: false
});

if (/Bun/i.test(research.output)) {
  return { recommendation: "evaluate-bun", evidence: research.output };
}
return { recommendation: "stay-on-node", evidence: research.output };
```

The default research effort is `medium`. A run may select `low`, `medium`, or
`high` with its `thinking` option. Current
[prices](https://docs.parallel.ai/getting-started/pricing) per successful
response are:

| Thinking | Price | Typical use |
| --- | ---: | --- |
| `low` | $0.01 | Focused lookup |
| `medium` | $0.05 | General research |
| `high` | $0.25 | Hard, high-value research |

The provider makes one `POST /v1/responses` request and does not retry it. It
does not use `previous_response_id`, background jobs, or a remote status loop.
Stopping the child aborts the local HTTP request on a best-effort basis;
Parallel does not expose acknowledged server-side cancellation for Responses.

The research request contains only the packaged agent instructions and the
latest textual child task. It does not send parent history, local files, cwd,
environment variables, Pi tools, session state, or git worktree data. The
agent cannot read or edit the local filesystem. A worktree therefore adds no
research capability and should normally remain disabled.

Parallel Responses accepts at most 20,000 combined instruction and input
characters. The adapter fails before making a request when that boundary is
exceeded. It renders the returned URL citations as a deduplicated Markdown
source list.

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
- the `parallel/research` model
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
- Search requests use Parallel SDK `basic` mode.
- Search requests include `client_model` when Pi has an active model selected.
- Search and extract requests reuse a generated `session_id` for the life of the current Pi session.
- The login flow tries to open your browser automatically.
- If automatic callback capture does not complete, the login dialog asks you to paste the callback URL.
- Credential storage is entirely Pi's; the extension only reads the resolved key
  through `ctx.modelRegistry.getApiKeyForProvider("parallel")`.
- The research model is stateless and separate from the Search/Extract
  `session_id` used by the web tools.
- Skill suppression inside the extension is prompt-level only. If you want a clean dogfooding session without your usual skills list, start Pi with `--no-skills`.
