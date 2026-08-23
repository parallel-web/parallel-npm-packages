# Parallel Responses for DeepSeek Harness

This experimental plugin adds an opt-in `parallel_research` tool to DeepSeek
Harness. Each call sends one self-contained text prompt to
[Parallel Responses](https://docs.parallel.ai/api-reference/responses-beta/create-a-response)
and returns the completed answer with its citations.

It does not replace `web_search` or change
`@parallel-web/dsh-web-search`. It never sends parent conversation history,
files, workspace state, tools, or ambient environment details.

## Install from this checkout

The package is private and has not been published. Build and pack it from the
repository root, then add the local tarball to Harness's `web` profile:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent build
pnpm --dir packages/dsh-responses-subagent pack --pack-destination /tmp
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  /tmp/parallel-web-dsh-responses-subagent-0.1.0-rc.0.tgz
```

Start Harness from a shell where `PARALLEL_API_KEY` is already set:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

Ask the parent agent to call `parallel_research` with a complete, standalone
research question. The tool waits for the answer and returns its source URLs.

## Behavior

- One `POST /v1/responses` request per accepted research task.
- Fixed `parallel` model, medium reasoning effort, and no retries.
- At most two concurrent requests, with a 10-minute timeout.
- Parent cancellation or disposal aborts the remote request.
- No parent history, files, background jobs, continuation, or child tools.
- Compatibility is pinned to DeepSeek Harness `0.1.0-rc.6`.

Run the package checks from the repository root:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent check
```

To remove the experiment:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web remove @parallel-web/dsh-responses-subagent
```
