# Parallel Responses for DeepSeek Harness

This DeepSeek Harness plugin adds `parallel_research`, an opt-in
[Parallel Responses](https://docs.parallel.ai/responses-api/examples/research-subagent)
subagent that returns complete, cited web research. It works alongside
`web_search` without changing the existing Parallel Search plugin.

Only the explicitly delegated question is forwarded as research input. Parent
history, files, workspace state, tools, and environment details are never
gathered automatically.

## Availability

This plugin is an unreleased preview. It is not published to npm, and there is
no release tarball to download yet. The setup below requires a locally built
preview tarball. If you want to build one yourself, see [Development](#development).

## Set up a preview

You will need:

- Node.js 22.19 or later in the 22.x series, or Node.js 24 or newer;
- pnpm 10 or newer, available in your terminal;
- a [Parallel API key](https://platform.parallel.ai/); and
- a preview `.tgz` file for this plugin.

### 1. Install the plugin

Install into Harness's `web` profile. Replace `/absolute/path/to/plugin.tgz`
with the path to your preview tarball:

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 \
  plugin --profile web add /absolute/path/to/plugin.tgz
```

### 2. Start Harness

Set your Parallel API key in the same terminal that starts Harness:

```sh
export PARALLEL_API_KEY="your-key"
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 web
```

Open [http://127.0.0.1:3080](http://127.0.0.1:3080), configure your parent
model and its credentials in **Settings > Models**, choose a workspace, and
start a new session. Restart Harness if it was already running when you
installed the plugin or set the key.

### 3. Try a research question

Ask Harness to use the plugin, for example:

> Use parallel_research to compare Node.js 22 and 24 support schedules. Include
> links to the official sources.

The agent calls `parallel_research` and receives a researched answer with
source URLs. It can still use `web_search` separately.

To check that the plugin is installed in the profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 --profile web --dump-config
```

Look for `subagent-parallel-responses` and `toolName: parallel_research`.
If the plugin reports that `PARALLEL_API_KEY` is required, set the key in the
terminal that starts Harness and restart it.

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
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 \
  plugin --profile web remove @parallel-web/dsh-responses-subagent
```

Restart Harness after removing the plugin.

## Development

These steps are for building a preview from source. Use a checkout containing
this package, available in [PR #42](https://github.com/parallel-web/parallel-npm-packages/pull/42).
From the repository root, enable Corepack to use the pinned pnpm version,
install dependencies, and run the package checks:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @parallel-web/dsh-responses-subagent check
```

The checks include the build. Pack it into a local tarball:

```sh
PREVIEW_PACK_DIR="$(mktemp -d)"
pnpm --dir packages/dsh-responses-subagent pack --pack-destination "$PREVIEW_PACK_DIR"
```

Use the tarball path printed by `pack` in the [preview setup](#1-install-the-plugin).
This does not publish the package.
