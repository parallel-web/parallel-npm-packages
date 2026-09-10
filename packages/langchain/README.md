# Parallel tools for LangChain

Give your LangChain JavaScript agent two tools: Search to find sources and
Extract to read them. Both use the
[Parallel SDK](https://github.com/parallel-web/parallel-sdk-typescript) to call
the Search and Extract APIs.

`@parallel-web/langchain` isn't on npm yet. For now, you can run it from this
repo or install a tarball you build locally.

## Try it locally

You'll need Node.js 22.13 or newer. These commands use the pnpm version pinned
in this repo. Run them from the repo root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @parallel-web/langchain build
corepack pnpm --filter @parallel-web/langchain test
```

To try it in another project, build a tarball:

```bash
mkdir -p artifacts
corepack pnpm --dir packages/langchain pack --pack-destination ../../artifacts
```

Install that tarball alongside `@langchain/core` 1.2.9 or a later 1.x release.
The package supports ESM, CommonJS, and TypeScript. Importing it doesn't need
an API key.

## Add the tools

Set `PARALLEL_API_KEY` on your server, or pass `apiKey` when you create a tool.
Keep the key out of browser code.

```ts
import { randomUUID } from 'node:crypto';
import { createSearchTool, createExtractTool } from '@parallel-web/langchain';

const sessionId = randomUUID();
const search = createSearchTool({
  mode: 'fast',
  maxResults: 5,
  maxOutputChars: 12_000,
  sessionId,
});
const extract = createExtractTool({ maxOutputChars: 12_000, sessionId });

// Add these to your LangChain agent's tools array.
const tools = [search, extract];

// You can also call a tool directly to get text back.
const content = await search.invoke({
  search_queries: ['Parallel Search API documentation'],
  objective: 'Find the current Search API documentation and its search modes.',
});
console.log(content);
```

The tool names are `parallel_web_search` and `parallel_extract`,
matching the [Python integration](https://github.com/parallel-web/langchain-parallel).

Search accepts one to five nonblank `search_queries`, each up to 200 characters.
Extract accepts one to twenty HTTP or HTTPS `urls`.
Both accept an optional `objective` of up to 5,000 characters, or `null`.
The tools check these inputs before making a request. Your app controls the
credentials and request settings; the model doesn't see those in its tool schema.

## Get the full response

Calling `invoke(args)` returns text. If you pass a tool call with an ID, you
get a `ToolMessage` with both the text and the full SDK response in `artifact`.
This is LangChain's `content_and_artifact` format:

```ts
const message = await extract.invoke({
  type: 'tool_call',
  id: 'read-docs',
  name: extract.name,
  args: {
    urls: ['https://docs.parallel.ai/search/modes'],
    objective: 'Explain the supported search modes.',
  },
});

console.log(message.content); // Text for the model
console.log(message.artifact); // Full API response for your app
```

The artifact keeps every response field, including source details, request and
session IDs, usage, warnings, and errors for individual URLs. Full page content
and error bodies stay there too, when the API returns them.

The text sent to the model is capped at 20,000 characters by default, including
source details and notices. Each source URL appears in full before its text.
If the URL won't fit, the tool leaves out that source's section. A notice tells
the model when output has been shortened.

The tools ask the API for the same excerpt budget, then apply the text limit
locally to account for source details and full content. The artifact stays
complete, so you'll need your own storage limit if you save it.

## Change the settings

| Option | Applies to | Default / behavior |
| --- | --- | --- |
| `apiKey` | Both | Uses `PARALLEL_API_KEY` if you don't pass a key |
| `client` | Both | Your own `Parallel` SDK client; use instead of `apiKey` |
| `maxOutputChars` | Both | 20,000; a safe integer of at least 1,024 |
| `sessionId` | Both | Optional; share one ID across related Search and Extract calls |
| `fetchPolicy` | Both | SDK policy for cache freshness and live fetching |
| `mode` | Search | `advanced`; also supports `turbo`, `fast`, and `basic` |
| `maxResults` | Search | 10; an integer from 1 to 40 |
| `sourcePolicy` | Search | SDK domain and freshness policy |
| `fullContent` | Extract | `false`; accepts `true` or SDK full-content settings |

`sourcePolicy` applies only to Search. If your app needs to restrict Extract
URLs, check them before calling the tool. When you request full content, it
stays in the artifact. The text uses excerpts where available and falls back
to full content when there are none.

To set retries or timeouts, pass your own SDK client. Add `parallel-web` as a
direct dependency of your app to use this example:

```ts
import { Parallel } from 'parallel-web';

const client = new Parallel({
  apiKey: process.env.PARALLEL_API_KEY,
  timeout: 30_000,
  maxRetries: 1,
});
const searchWithClient = createSearchTool({ client, mode: 'fast' });

const controller = new AbortController();
const pending = searchWithClient.invoke(
  { search_queries: ['Parallel Search API'] },
  { signal: controller.signal }
);
// Call controller.abort() if the user cancels the request.
await pending;
```

An already-aborted signal stops the call before it sends a request. Aborting
during a request cancels it through the SDK. LangChain runnable timeouts use
the same signal path.

SDK errors, including authentication failures, rate limits, and timeouts,
reject the tool call. Extract can also succeed for some URLs and fail for
others. You'll see those failures in the text and in `artifact.errors`. The
failure count stays visible even when the text limit leaves out error details.

Calls use your Parallel API key and your account's access, limits, and billing.
Requests include an `X-Tool-Calling-Package` header with the package name and version.

## Run a research agent

The [research example](./examples/research.mjs) puts both tools into a LangChain
agent. Each run gets a new session ID, shared across its Search and Extract calls.
The prompt asks the agent to read sources, cite them in its answer, and ignore
instructions found in retrieved pages. The example's model adapter is a
development dependency.

Set `PARALLEL_API_KEY`, `OPENAI_API_KEY`, and `RESEARCH_MODEL` in your environment.
Choose a model your account can access that supports tool calling. After the
local setup above, run this from the repo root:

```bash
corepack pnpm --filter @parallel-web/langchain example:research -- \
  'What are the current Parallel Search modes? Cite the official documentation.'
```

This makes live calls to Parallel and your model provider, so normal usage
charges apply. Missing environment variables stop the example before it makes
any requests. The tests run the same agent flow with a scripted model and
test responses, without calling either service.

## Development

```bash
corepack pnpm --filter @parallel-web/langchain test
corepack pnpm --filter @parallel-web/langchain typecheck
corepack pnpm --filter @parallel-web/langchain build
```

Run the root checks before opening a PR. Adding this package doesn't publish
it to npm. The first release needs a Parallel npm organization owner to follow
the [publishing guide](../../PUBLISHING.md) from an updated `main` checkout.
