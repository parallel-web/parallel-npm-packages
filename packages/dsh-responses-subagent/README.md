# Parallel Responses research for DeepSeek Harness

This opt-in plugin adds a `parallel_research` tool to DeepSeek Harness. The
tool sends one explicit, self-contained research prompt to
[Parallel Responses](https://docs.parallel.ai/api-reference/responses-beta/create-a-response)
and returns the final answer with its source URLs visible to the parent model.

This is a focused remote research worker, not a general Harness model provider.
It does not receive parent conversation history, files, workspace state, tools,
or ambient environment details. It does not change Harness's built-in
`web_search` tool or the separate `@parallel-web/dsh-web-search` package.

## Quick start

You will need:

- Node.js 22.19 or later in the 22.x series, or Node.js 24 or newer;
- pnpm 10 or newer;
- a model API key supported by your Harness setup; and
- a [Parallel API key](https://platform.parallel.ai/).

Check the supported Harness version without installing it globally:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --version
```

You should see `0.1.0-rc.6`. Harness is still a developer preview, so later
versions may need a plugin update.

### 1. Install the plugin

Install the release candidate into the `web` profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  @parallel-web/dsh-responses-subagent@rc
```

The `@rc` suffix installs the current release candidate. After version `0.1.0`
is stable, you can leave the suffix off.

### 2. Start Harness

Make the Parallel key available in the terminal that starts Harness:

```sh
export PARALLEL_API_KEY="your-key"
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

Open [http://127.0.0.1:3080](http://127.0.0.1:3080). Configure a parent model
and workspace in Harness, then start a session.

### 3. Delegate a research question

Ask Harness to use the dedicated tool and give it a standalone question, for
example:

> Use `parallel_research` to explain the current DeepSeek Harness plugin model.
> Include useful primary sources and their links.

The call runs in the foreground. The parent waits for the remote research
answer, then continues with the returned text and source URLs.

## Check that it installed

Inspect the profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile web --dump-config | \
  grep -E 'subagent-parallel-responses|tool-subagent-parallel-responses|parallel_research'
```

You should see one provider row and one tool row. The tool row should name
`parallel_research`, select the `parallel-responses` provider, and set
`enableRunInBackground: false`.

## Fixed v1 behavior

Version one intentionally has a small contract:

- one `POST https://api.parallel.ai/v1/responses` request per accepted run;
- fixed `model: "parallel"`, medium reasoning effort, and streaming transport;
- at most two active requests in one plugin instance;
- a fixed 10-minute internal timeout and no automatic retries;
- text-only, self-contained prompts;
- no background jobs, continuation, child tools, structured output, endpoint
  override, or arbitrary model selection; and
- caller cancellation and `SubagentRun.dispose()` abort outstanding work and
  wait for cleanup. Plugin disposal unregisters the provider; callers retain
  ownership of runs they already started.

Parallel charges Responses by successful request. Review current pricing before
running many calls; the medium reasoning tier is currently documented at $0.05
per successful request.

The only package setting is an optional literal `apiKey`. Prefer
`PARALLEL_API_KEY`: profile files and configuration dumps are readable text,
whereas the plugin's schema only protects a literal key from ordinary config
display.

## If something goes wrong

- **The provider is unavailable:** confirm `PARALLEL_API_KEY` is set in the same
  terminal that starts Harness.
- **The request is rejected immediately:** pass non-empty text only, and make
  the prompt fully understandable without the parent conversation.
- **The remote call fails:** inspect the Harness warning. It reports a safe HTTP,
  Responses, timeout, or generic transport diagnostic without response bodies,
  headers, nested causes, stack traces, or credentials. The plugin deliberately
  does not retry.
- **The capacity limit is reached:** wait for an active call to finish or cancel
  one before starting more work.
- **Port 3080 is in use:** stop the older Harness process, then start Harness
  again.

## Remove

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web remove @parallel-web/dsh-responses-subagent
```

Restart Harness after removing the plugin.

## Development and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local validation and the packed
install/remove workflow. Report vulnerabilities according to
[SECURITY.md](./SECURITY.md).

For help, contact [support@parallel.ai](mailto:support@parallel.ai).

MIT licensed.
