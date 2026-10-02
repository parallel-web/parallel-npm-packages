# @parallel-web/tanstack-ai

A server-side [TanStack AI](https://tanstack.com/ai/latest) tool for
[Parallel Search](https://docs.parallel.ai/search/search-quickstart). Maintained by Parallel.

**Unpublished:** the proposed package name is `@parallel-web/tanstack-ai`. Until an npm
organization owner completes the first release, build and install a local tarball:

```bash
# From the monorepo root (Node >=22.13, pnpm 11.21.0)
pnpm install --frozen-lockfile
pnpm --dir packages/tanstack-ai pack --pack-destination /tmp

# From an application
npm install /tmp/parallel-web-tanstack-ai-0.1.0-rc.0.tgz @tanstack/ai@^0.63.0
```

This package is ESM-only, matching `@tanstack/ai`. Use it in server code and keep
`PARALLEL_API_KEY` out of client bundles. The examples below make paid API requests
when executed with real credentials.

## Usage

Add the tool to the `tools` array of an existing TanStack `chat()` call:

```ts
import { chat, type AnyTextAdapter } from '@tanstack/ai';
import { parallelSearchTool } from '@parallel-web/tanstack-ai';

// Use your existing provider adapter and its server-side credentials.
export async function research(adapter: AnyTextAdapter) {
  return chat({
    adapter,
    messages: [{ role: 'user', content: 'Find recent battery recycling research.' }],
    tools: [parallelSearchTool()], // Reads PARALLEL_API_KEY on the server.
    stream: false,
  });
}
```

The model supplies a `query`, an optional `objective`, and an optional `max_results`.
The tool returns `{ results }`, with each source's URL, excerpts, title, and publication
date. Title and date can be null or absent. Empty results remain empty; SDK errors
propagate to TanStack's tool error handling. Search content is untrusted external data.

## Options

```ts
const search = parallelSearchTool({
  apiKey: process.env.PARALLEL_API_KEY,
  mode: 'fast',
  maxResults: 5,
  sourcePolicy: { include_domains: ['nature.com'] },
  sessionId: 'research-session',
});
```

| Option | Behavior |
| --- | --- |
| `apiKey` | Defaults to `PARALLEL_API_KEY`. |
| `client` | Optional existing `parallel-web` SDK client; mutually exclusive with `apiKey`. Use it for custom transport, timeouts, or retry settings. |
| `mode` | `turbo`, `fast`, `basic`, or `advanced` (default). |
| `maxResults` | Default and upper limit for model-requested results; integer 1–40, default 10. |
| `sourcePolicy` | SDK source policy, controlled by the application. |
| `sessionId` | Optional shared search session ID. |

Blank objectives are omitted. Model input cannot change credentials, mode, or source
restrictions. TanStack's abort signal is forwarded to the SDK. SDK retry defaults apply;
this package adds no retry loop. Requests include the monorepo's
`X-Tool-Calling-Package` attribution header.

## Development and release

```bash
pnpm --filter @parallel-web/tanstack-ai test
pnpm --filter @parallel-web/tanstack-ai typecheck
pnpm --filter @parallel-web/tanstack-ai build
```

Tests use mocked HTTP responses and a fake model adapter with the real TanStack chat
loop and Parallel SDK. They require no credentials or paid calls. Compatibility is
currently tested with `@tanstack/ai` 0.63.0 and `parallel-web` 1.3.5.

The first release remains an npm organization owner action under the existing
[publishing guide](../../PUBLISHING.md#first-release-of-a-new-package). Confirm the
package name and maintenance owner before release. Once published, submit the small
TanStack docs listing offered in [TanStack AI #1205](https://github.com/TanStack/ai/pull/1205#issuecomment-5832074408).
