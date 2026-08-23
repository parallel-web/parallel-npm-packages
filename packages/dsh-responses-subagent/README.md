# Parallel Responses for DeepSeek Harness

This DeepSeek Harness plugin adds an opt-in `parallel_research` tool. Each call
sends one self-contained text prompt to
[Parallel Responses](https://docs.parallel.ai/responses-api/examples/research-subagent)
and returns the completed answer with its citations.

It does not replace `web_search` or change
`@parallel-web/dsh-web-search`. It never sends parent conversation history,
files, workspace state, tools, or ambient environment details.

## Install from this checkout

This package is ready for a future release but has not been published to npm.
Until an npm organization owner completes its first release, install it from a
local tarball. From the repository root:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent build
pnpm --dir packages/dsh-responses-subagent pack --pack-destination /tmp
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  /tmp/parallel-web-dsh-responses-subagent-0.1.0-rc.0.tgz
```

Make your [Parallel API key](https://platform.parallel.ai/) available in the
same terminal that starts Harness:

```sh
export PARALLEL_API_KEY="your-key"
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

For an interactive session, configure a model and its API key in Harness
**Settings > Models**. The plugin works alongside
`@parallel-web/dsh-web-search`: use `web_search` for individual searches and
`parallel_research` when the parent should delegate a complete research task.

Ask the parent agent to call `parallel_research` with a complete, standalone
research question. The tool waits for the answer and returns its source URLs.
The parent receives specific guidance to preserve the original question, avoid
inventing JSON schemas, cite primary sources, and make focused follow-up calls
when the first answer leaves an important gap.

### After the first npm release

The registry install below will work only after the package has actually been
published with the `rc` dist-tag. It is not currently available:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  @parallel-web/dsh-responses-subagent@rc
```

## Research depth and concurrency

Add optional settings to the `subagent-parallel-responses` entry in your Harness
profile, `~/.dsh/profiles/web/cordis.patch.yml`, when a workload needs a
different research strategy:

```yaml
- id: subagent-parallel-responses
  config:
    effort: high
    maxConcurrentRuns: 4
```

`effort` accepts `low`, `medium`, or `high`; the default remains `medium`.
Use `low` for several independent, focused questions, `medium` for ordinary
multi-hop research, and `high` for difficult research that needs extensive
source comparison or synthesis. `maxConcurrentRuns` defaults to 2 and accepts
values from 1 through 20. Configure it deliberately when the parent should fan
out independent low-effort questions. Harness also applies its own
`maxParallelToolCalls` limit, which defaults to 10. The effective concurrency
is whichever configured limit is lower. To run more than 10 requests together,
raise both `maxConcurrentRuns` and Harness's **Settings > Plugins > Agent
loop > Parallel tool calls** setting.

## Behavior

- One `POST /v1/responses` request per accepted research task.
- Fixed `parallel` model, configurable reasoning effort, and no retries.
- Configurable bounded concurrency, with a 10-minute timeout per request.
- Research answers include the returned citation titles and source URLs.
- Parent cancellation or disposal aborts the remote request.
- No parent history, files, background jobs, continuation, or child tools.
- Compatibility is pinned to DeepSeek Harness `0.1.0-rc.6`.

Run the package checks from the repository root:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent check
```

To remove the plugin:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web remove @parallel-web/dsh-responses-subagent
```
