# @parallel-web/pi-extension

Pi extension that adds `web_search`, `web_fetch`, and `web_research` backed by
Parallel. Keep your usual coding agent and give it web tools with one install.

Install it with:
```
pi install npm:@parallel-web/pi-extension
```

## What It Does

- Registers `web_search`
- Registers `web_fetch`
- Registers `web_research` for synthesized answers with sources through the
  Responses API
- Registers a `parallel` auth provider, so Pi's own `/login parallel` runs the
  Parallel browser OAuth flow and stores the API key in Pi's auth store
  (`auth.json`) alongside every other provider credential
- Adds a `parallel-login` command that reports current auth status

Auth resolution order (owned by Pi, not the extension):

1. The credential Pi stored for provider `parallel`
2. `PARALLEL_API_KEY`

Run `/parallel-login` inside Pi to check whether Parallel is configured. To
remove a stored credential, run `/logout` and select Parallel. Environment
variables are not affected by Pi's logout flow.

Requires `@earendil-works/pi-coding-agent` 0.83.0 or newer.

## Web Research

After installing this extension, run `/login parallel` and ask your usual Pi
agent a research question. No additional package or model selection is needed:

```text
Compare the current Node.js compatibility of Node and Bun for a production API server. Research the tradeoffs and cite primary sources.
```

The agent can call the research tool directly:

```javascript
web_research({
  query: "Compare the current Node.js compatibility of Node and Bun for a production API server. Cite primary sources.",
  effort: "medium"
});
```

| Tool | Use it for |
| --- | --- |
| `web_research` | A complete answer that needs web research and synthesis |
| `web_search` | Discovering sources and raw excerpts to investigate yourself |
| `web_fetch` | Reading known URLs or checking original sources |

Start with a complete, self-contained `query`. Research does not see the Pi
conversation or local files, so include relevant constraints and only context
that is safe to send.

When available, the result starts with a `Response ID`. For a focused follow-up
on the same investigation, pass that ID as `previous_response_id`:

```javascript
web_research({
  query: "Which of those compatibility gaps would matter for an API server that uses native Node.js addons?",
  previous_response_id: "resp_..." // Copy the actual ID from the previous result.
});
```

Use the new ID returned by each follow-up to continue from its answer. Omit the
ID for a new or unrelated question. Calls never chain automatically, and the
extension keeps no local research-session state. Continuation reuses saved
research context, including earlier answer summaries, not every internal step
of the research process. IDs are opaque; the tool accepts non-empty IDs up to
512 characters without whitespace or control characters.

Saved context is not guaranteed to remain available, and continuation is not
supported for zero data retention (ZDR) accounts. An unavailable ID or a ZDR
restriction returns an error without retrying as fresh research. A valid
answer without a usable new ID is still returned, but cannot be continued
through that result. If Pi loses an ID during conversation compaction, do not
invent a replacement.

`effort` is optional and defaults to `medium`, matching the Responses API
default. Use `low` for focused lookups, `medium` for general research, and
`high` for extensive research. Responses is billed per successful call; see
the [current pricing](https://docs.parallel.ai/getting-started/pricing).

Each invocation makes one non-streaming `POST /v1/responses` request, with no
automatic retries or background jobs. The local deadline
is 120 seconds, including reading the response; slower valid research can
exceed this client limit. Cancelling the tool
aborts the local request on a best-effort basis; it does not confirm that work
stopped on the server. A manual retry is a new request and may incur a new charge.

The request contains only the fixed research instructions and explicit query,
with the selected effort and `previous_response_id` only when explicitly
supplied. It does not automatically forward parent history,
local files, cwd, environment variables, Pi tools, or session metadata.
Anything the calling agent includes in `query` is sent to Parallel.

The tool rejects requests over 20,000 combined instruction and input
characters, including the separator the API counts, before sending them.
It preserves the answer and renders returned HTTP(S) citations as a
deduplicated Markdown source list. When a citation identifies a passage,
the source includes that exact quoted answer text and its location in the
original text part. These are passages from the answer, not excerpts from
the source page. Unresolved citation ranges keep the source link without
inventing a passage. Results that exceed Pi's output limits are shown as a
marked preview with a path to the complete answer and sources in a private
temporary file. The response ID stays visible in the preview and is included
in the complete report.

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
- the `web_research` tool
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
and run `/logout` and select Parallel to remove the stored credential.

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

- Search and Fetch use the `parallel-web` TypeScript SDK; Research calls the
  Responses endpoint directly.
- Search requests use Parallel SDK `fast` mode.
- Search requests include `client_model` when Pi has an active model selected.
- Search and extract requests reuse a generated `session_id` for the life of the current Pi session.
- The login flow tries to open your browser automatically.
- If automatic callback capture does not complete, the login dialog asks you to paste the callback URL.
- Credential storage is entirely Pi's; the extension only reads the resolved key
  through `ctx.modelRegistry.getApiKeyForProvider("parallel")`.
- Research requests do not reuse the Search/Extract `session_id`.
- Skill suppression inside the extension is prompt-level only. If you want a clean dogfooding session without your usual skills list, start Pi with `--no-skills`.
