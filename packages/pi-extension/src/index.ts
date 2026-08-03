import { randomUUID } from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  clearStoredParallelApiKey,
  getParallelApiKey,
  loginWithParallel,
} from './parallel-auth';
import {
  isParallelAuthenticationError,
  runParallelExtract,
  runParallelSearch,
} from './parallel-client';

function truncateJson(value: unknown) {
  const pretty = JSON.stringify(value, null, 2);
  const truncation = truncateHead(pretty, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
  }
  return text;
}

const SUPPRESSED_SKILL_NAMES = new Set([
  'parallel-cli-setup',
  'parallel-web-extract',
  'parallel-web-search',
]);

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function suppressSkillsFromPrompt(systemPrompt: string) {
  let nextPrompt = systemPrompt;

  for (const skillName of SUPPRESSED_SKILL_NAMES) {
    const pattern = new RegExp(
      String.raw`\n?\s*<skill>\s*<name>${escapeRegex(skillName)}</name>[\s\S]*?<\/skill>`,
      'g'
    );
    nextPrompt = nextPrompt.replace(pattern, '');
  }

  return nextPrompt.replace(
    /\n?<available_skills>\s*<\/available_skills>/g,
    ''
  );
}

const WEB_GROUNDING_GUIDANCE = `
## Grounding and web usage

You should proactively use available web tools to ground your answers when doing so would improve correctness, freshness, or source quality.

- Use web_search when the task involves current information, external facts, source discovery, recent changes, or any claim you are not highly confident about.
- Use web_fetch when the user provides a URL, when a search result should be verified against the source, or when primary-source content would improve the answer.
- Prefer grounded, sourced answers over unsupported recall when freshness or factual precision matters.
- If a grounded answer would likely be better than answering from memory, use the web tools first.
`;

export default function (pi: ExtensionAPI) {
  const parallelSessionId = randomUUID();

  async function resolveApiKey(ctx: ExtensionContext) {
    const apiKey = await getParallelApiKey(ctx);
    if (apiKey) {
      return apiKey;
    }

    if (!ctx.hasUI) {
      throw new Error(
        'Parallel authentication required. Set PARALLEL_API_KEY or run `parallel-login` in interactive Pi.'
      );
    }

    const ok = await ctx.ui.confirm(
      'Parallel authentication required',
      'This tool needs Parallel auth. Start browser login now?'
    );
    if (!ok) {
      throw new Error('Parallel authentication is required to use this tool.');
    }

    return await loginWithParallel(ctx);
  }

  async function runWithAuth<T>(
    ctx: ExtensionContext,
    request: (apiKey: string) => Promise<T>
  ) {
    let apiKey = await resolveApiKey(ctx);

    try {
      return await request(apiKey);
    } catch (error) {
      if (!isParallelAuthenticationError(error)) {
        throw error;
      }

      if (process.env.PARALLEL_API_KEY) {
        throw new Error(
          'Parallel rejected PARALLEL_API_KEY. Update or unset it, then try again.'
        );
      }

      clearStoredParallelApiKey(ctx);

      if (!ctx.hasUI) {
        throw new Error(
          'Stored Parallel authentication was rejected. Run `parallel-login` in interactive Pi to sign in again.'
        );
      }

      const ok = await ctx.ui.confirm(
        'Parallel authentication expired',
        'Stored Parallel auth was rejected. Sign in again now?'
      );
      if (!ok) {
        throw error;
      }

      apiKey = await loginWithParallel(ctx);
      return await request(apiKey);
    }
  }

  pi.registerCommand('parallel-login', {
    description: 'Run Parallel browser login and store the API key in Pi auth',
    handler: async (_args, ctx) => {
      await loginWithParallel(ctx);
      ctx.ui.notify('Parallel login completed.', 'info');
    },
  });

  pi.on('before_agent_start', async (event) => {
    const filteredPrompt = suppressSkillsFromPrompt(event.systemPrompt);
    const selectedTools = event.systemPromptOptions.selectedTools ?? [];
    const hasWebTools =
      selectedTools.includes('web_search') ||
      selectedTools.includes('web_fetch');

    if (!hasWebTools) {
      return filteredPrompt === event.systemPrompt
        ? undefined
        : { systemPrompt: filteredPrompt };
    }

    return {
      systemPrompt: `${filteredPrompt}\n${WEB_GROUNDING_GUIDANCE}`,
    };
  });

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      "Search the web using Parallel's Search API. Prefer this over generic browser-like search tools for current web results.",
    promptSnippet:
      "Search the web using Parallel's Search API for current information",
    promptGuidelines: [
      'Use web_search when the user asks for current web information, discovery, or source finding.',
      'Provide 2-3 concise keyword search queries when possible; search_queries is required.',
    ],
    parameters: Type.Object({
      objective: Type.String({
        description:
          'Natural-language description of the underlying question or goal driving the search. Used together with search_queries to focus results on the most relevant content. Should be self-contained with enough context to understand the intent of the search.',
      }),
      search_queries: Type.Array(
        Type.String({
          description:
            'Concise keyword search queries, 3-6 words each. At least one query is required, provide 2-3 for best results. Used together with objective to focus results on the most relevant content.',
        })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runWithAuth(ctx, (apiKey) =>
        runParallelSearch(
          apiKey,
          {
            objective: params.objective,
            search_queries: params.search_queries,
            client_model: ctx.model?.id,
            session_id: parallelSessionId,
          },
          signal
        )
      );

      return {
        content: [{ type: 'text', text: truncateJson(result) }],
        details: {
          provider: 'parallel',
          product: 'search',
        },
      };
    },
  });

  pi.registerTool({
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      "Fetch and extract content from a URL using Parallel's Extract API. Prefer this over raw HTML fetch tools for readable content extraction.",
    promptSnippet:
      "Fetch and extract readable webpage content from one or more URLs using Parallel's Extract API",
    promptGuidelines: [
      'Use web_fetch when the user provides one or more URLs and wants the page content or a clean extraction.',
      'Batch multiple URLs into one web_fetch call instead of parallelizing many single-URL calls.',
    ],
    parameters: Type.Object({
      urls: Type.Array(
        Type.String({
          description:
            'List of URLs to extract content from. Must be valid HTTP/HTTPS URLs. Up to 20 URLs.',
        })
      ),
      objective: Type.Optional(
        Type.String({
          description:
            'As in SearchRequest, a natural-language description of the underlying question or goal driving the request. Used together with search_queries to focus excerpts on the most relevant content.',
        })
      ),
      search_queries: Type.Optional(
        Type.Array(
          Type.String({
            description:
              'Optional keyword search queries, as in SearchRequest. Used together with objective to focus excerpts on the most relevant content.',
          })
        )
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runWithAuth(ctx, (apiKey) =>
        runParallelExtract(
          apiKey,
          {
            urls: params.urls,
            objective: params.objective,
            search_queries: params.search_queries,
            client_model: ctx.model?.id,
            session_id: parallelSessionId,
          },
          signal
        )
      );

      return {
        content: [{ type: 'text', text: truncateJson(result) }],
        details: {
          provider: 'parallel',
          product: 'extract',
          urls: params.urls,
        },
      };
    },
  });
}
