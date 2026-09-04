# Parallel WebMCP

Let agents visiting your site search the web and read pages with Parallel.
Add this package to your site's browser code, and compatible agents can call
`parallel_web_search` and `parallel_web_fetch` while your page is open.

Both tools use the existing free
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
and return excerpts with source URLs. You don't need an API key or a backend,
and your visitors don't need to configure an MCP server. The package has no
runtime dependencies.

## Install

After the first npm release, install it with:

```bash
npm install @parallel-web/webmcp@rc
```

Add this to your site's browser entry point:

```ts
import { installParallelWebMcp } from '@parallel-web/webmcp';

await installParallelWebMcp();
```

The installer returns `true` once both tools are registered. If the browser
doesn't support WebMCP, it returns `false` without making a network request.
It's safe to call during server-side rendering, and calling it again won't
register duplicate tools. The browser removes the tools when the page closes
or navigates away.

If an agent runs on another origin, list the origins you trust:

```ts
await installParallelWebMcp({
  exposedTo: ['https://agent.example'],
});
```

The agent also needs to include your site in its discovery call:
`document.modelContext.getTools({ fromOrigins: ['https://your-site.example'] })`.
Cross-origin access is off by default. Use the installer above when you need it,
since the script tag below doesn't accept options.

After publication, you can also use this script tag. It pins the package version
and registers the tools automatically:

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@parallel-web/webmcp@0.1.0-rc.0/dist/auto.js"
  crossorigin="anonymous"
></script>
```

## Browser requirements

WebMCP is still a proposed browser standard. Your visitors need a browser that
exposes `document.modelContext.registerTool`.

For a live site using Chrome:

- Use Chrome 149 or later and enroll your site's origin in the
  [WebMCP origin trial](https://developer.chrome.com/origintrials/#/register_trial/4163014905550602241).
- Serve the page over HTTPS and keep origin isolation enabled. Don't opt out with
  `Origin-Agent-Cluster: ?0`.
- Register tools in the top-level document or a same-origin iframe. A
  cross-origin iframe needs `allow="tools"`, for example:
  `<iframe src="https://example.com" allow="tools"></iframe>`.
  Sharing its tools with another origin also requires `exposedTo`.

For local testing, enable `chrome://flags/#enable-webmcp-testing` and restart
Chrome. This only enables WebMCP in your own browser. For the full setup, see the
[Chrome WebMCP guide](https://developer.chrome.com/docs/ai/webmcp) and the
[WebMCP specification](https://webmachinelearning.github.io/webmcp/).

## Security and privacy

- Both tools are marked read-only. Results are marked as untrusted because they
  come from third-party webpages.
- Requests send the search terms or requested URL to
  `https://search.parallel.ai/mcp`, along with an anonymous session ID for the
  tab. The referrer contains only your site's origin. The package strips URL
  fragments and leaves out browser credentials.
- Fetch accepts only HTTP and HTTPS URLs. The Search MCP service handles
  destination safety, and the package limits the excerpts returned to the agent.
- The package doesn't automatically collect page content, cookies, signed-in
  user data, or agent history.
- If a request hits the free rate limit, it fails without retrying automatically.

When the browser supplies a cancellation signal, the package passes it to
`fetch()` so the request can stop.
[Chrome 152 doesn't yet supply that signal](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.76/third_party/blink/renderer/core/script_tools/model_context_tool.idl),
so cancelling a tool call there won't stop its network request.

If your site uses a Content Security Policy, allow the Search MCP endpoint:

```text
connect-src https://search.parallel.ai
```

If you use the CDN script, allow its origin in `script-src` too. Keep Parallel
API keys out of browser code. For paid usage, send requests through your own
authenticated server so the key stays private.

## Development

```bash
pnpm --filter @parallel-web/webmcp typecheck
pnpm --filter @parallel-web/webmcp test
pnpm --filter @parallel-web/webmcp build
```
