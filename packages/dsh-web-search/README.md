# Parallel Search for DeepSeek Harness

This plugin makes DeepSeek Harness's built-in `web_search` tool use
[Parallel Search](https://docs.parallel.ai/search/search-quickstart). It does
not add a new tool or provide `web_fetch`.

## Quick start

You will need:

- Node.js 22.19 or later in the 22.x series, or Node.js 24 or newer;
- pnpm 10 or newer;
- a [DeepSeek API key](https://platform.deepseek.com/); and
- a [Parallel API key](https://platform.parallel.ai/).

Check your installed versions:

```sh
node --version
pnpm --version
```

If pnpm is missing, install it:

```sh
npm install --global pnpm@10
```

### 1. Get DeepSeek Harness

Run the supported Harness version:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --version
```

You should see `0.1.0-rc.6`. You do not need to install `dsh` globally. Keep
using the complete `npx` commands shown below.

DeepSeek Harness is still a developer preview, so later versions may need a
plugin update.

### 2. Install the Parallel plugin

Install the plugin into the `web` profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  @parallel-web/dsh-web-search@rc
```

The `@rc` suffix installs the current release candidate. After version `0.1.0`
is stable, you can leave the suffix off.

### 3. Start DeepSeek Harness

Make your Parallel API key available in the terminal where you will run
Harness:

```sh
export PARALLEL_API_KEY="your-key"
```

Then start Harness:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

Open [http://127.0.0.1:3080](http://127.0.0.1:3080) in your browser. The first
time you open Harness:

1. Open **Settings → Models**.
2. Add your DeepSeek API key.
3. Choose a workspace.
4. Start a new session.

### 4. Try a web search

You do not need to call a special Parallel tool. Ask Harness something that
requires current information, for example:

> Search the web for today's most important AI news and include links to your
> sources.

When Harness calls its built-in `web_search` tool, this plugin sends the search
through Parallel.

## Check that it worked

Inspect the profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile web --dump-config | \
  grep -E 'searchProvider: parallel|web-search-parallel'
```

You should see `searchProvider: parallel` and a `web-search-parallel` entry.
Seeing the built-in `web-search-deepseek` plugin as well is normal—the
`searchProvider` setting decides which provider handles searches.

For direct request evidence, start Harness with information-level Parallel
logging:

```sh
PARALLEL_LOG=info npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

After a `web_search` call, the terminal should show a successful request to
`https://api.parallel.ai/v1/search`. Review logs before sharing them.

## Optional settings

The defaults work without extra configuration. If you want to tune the search,
edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web-search-parallel
  config:
    mode: turbo
    maxCharsTotal: 12000
    maxCharsPerResult: 2000
```

| Setting | Default | What it controls |
| --- | --- | --- |
| `mode` | Parallel's `advanced` default | `turbo`, `basic`, or `advanced` search |
| `maxCharsTotal` | `25000` | Total excerpt characters returned to Harness |
| `maxCharsPerResult` | no limit | Excerpt characters kept for each result |

Keep `PARALLEL_API_KEY` in the environment rather than putting it in this file,
which is stored as readable text.

The plugin always sends requests to `https://api.parallel.ai` and ignores
`PARALLEL_BASE_URL`.

## If something goes wrong

- **`pnpm` is not found:** run `npm install --global pnpm@10`.
- **Port 3080 is already in use:** stop the older Harness process, then start
  Harness again.
- **Parallel Search is unavailable:** confirm `PARALLEL_API_KEY` is set in the
  same terminal that starts Harness.

## Remove

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web remove @parallel-web/dsh-web-search
```

Restart Harness after removing the plugin.

## Development and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development, tests, and the
packed-artifact review workflow. Report vulnerabilities according to
[SECURITY.md](./SECURITY.md).

For help, contact [support@parallel.ai](mailto:support@parallel.ai).

MIT licensed.
