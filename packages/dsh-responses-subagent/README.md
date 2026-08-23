# Parallel Responses for DeepSeek Harness

This DeepSeek Harness plugin adds `parallel_research`, an opt-in
[Parallel Responses](https://docs.parallel.ai/responses-api/examples/research-subagent)
subagent that returns complete, cited web research. It works alongside
`web_search` without changing the existing Parallel Search plugin.

Only the explicitly delegated question is forwarded as research input. Parent
history, files, workspace state, tools, and environment details are never
gathered automatically.

## Install

This package has not been published to npm. Install from the repository root:

```sh
pnpm --filter @parallel-web/dsh-responses-subagent build
pnpm --dir packages/dsh-responses-subagent pack --pack-destination /tmp
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  /tmp/parallel-web-dsh-responses-subagent-0.1.0-rc.0.tgz
```

Provide your [Parallel API key](https://platform.parallel.ai/) in the terminal
that starts Harness, then configure a parent model in **Settings > Models**:

```sh
export PARALLEL_API_KEY="your-key"
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

After the first npm release, replace the tarball path in the install command
with `@parallel-web/dsh-responses-subagent@rc`.

## Research depth and parallelism

Ask the parent agent to delegate a complete, standalone research question. It
receives guidance to preserve constraints, prioritize primary sources, and
cite the returned URLs.

To choose the research depth, edit the `subagent-parallel-responses` entry in
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: subagent-parallel-responses
  config:
    effort: low
```

Choose `low` for focused questions, `medium` (the default) for ordinary
research, or `high` for deeper synthesis. At low effort, the parent is
encouraged to dispatch independent questions together. Harness schedules
parallel tool calls itself, allowing 10 by default. To allow more, increase
**Settings > Plugins > Agent loop > Parallel tool calls**.

Keep `PARALLEL_API_KEY` in the launch environment, not in this profile.

## Remove

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web remove @parallel-web/dsh-responses-subagent
```
