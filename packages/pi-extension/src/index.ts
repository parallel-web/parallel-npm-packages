import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  MAX_RESPONSE_ID_LENGTH,
  parseResearchInput,
  runParallelResearch,
} from './parallel-responses';
import {
  getParallelApiKey,
  getParallelAuthStatus,
  registerParallelAuthProvider,
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

const WEB_TOOL_GUIDANCE = {
  web_research:
    'Use web_research for a complete answer that requires current web research and synthesis. Start with the full self-contained question, including constraints. For a focused follow-up, pass the latest returned Response ID as previous_response_id; omit it for unrelated research.',
  web_search:
    'Use web_search for source discovery and raw excerpts when you need to investigate sources yourself.',
  web_fetch:
    'Use web_fetch to read a known URL or inspect the original source behind a claim.',
};

export default function (pi: ExtensionAPI) {
  const parallelSessionId = randomUUID();

  registerParallelAuthProvider(pi);

  async function resolveApiKey(ctx: ExtensionContext) {
    const apiKey = await getParallelApiKey(ctx);
    if (apiKey) {
      return apiKey;
    }

    throw new Error(
      'Parallel authentication required. Run `/login parallel` in Pi, or set PARALLEL_API_KEY.'
    );
  }

  async function runWithAuth<T>(
    ctx: ExtensionContext,
    request: (apiKey: string) => Promise<T>,
    isAuthenticationError = isParallelAuthenticationError
  ) {
    const apiKey = await resolveApiKey(ctx);

    try {
      return await request(apiKey);
    } catch (error) {
      if (!isAuthenticationError(error)) {
        throw error;
      }

      if (process.env.PARALLEL_API_KEY) {
        throw new Error(
          'Parallel rejected PARALLEL_API_KEY. Update or unset it, then try again.'
        );
      }

      throw new Error(
        'Parallel rejected the stored credential. Run `/login parallel` in Pi to sign in again.'
      );
    }
  }

  pi.registerCommand('parallel-login', {
    description: 'Show Parallel authentication status and how to sign in',
    handler: async (_args, ctx) => {
      // getProviderAuthStatus is a synchronous snapshot that only knows about
      // stored credentials, so ask for the resolved key to catch the env var too.
      const apiKey = await getParallelApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          'Parallel is not authenticated. Run `/login parallel` to sign in, or set PARALLEL_API_KEY.',
          'info'
        );
        return;
      }

      const status = getParallelAuthStatus(ctx);
      const source = status.label ?? status.source ?? 'PARALLEL_API_KEY';
      const guidance = status.configured
        ? 'Run `/login parallel` to replace the stored credential, or `/logout` and select Parallel to remove it.'
        : 'Run `/login parallel` to store a credential, or unset PARALLEL_API_KEY to remove the current one.';
      ctx.ui.notify(
        `Parallel is authenticated (${source}). ${guidance}`,
        'info'
      );
    },
  });

  pi.on('before_agent_start', async (event) => {
    const filteredPrompt = suppressSkillsFromPrompt(event.systemPrompt);
    const selectedTools = event.systemPromptOptions.selectedTools ?? [];
    const guidance = Object.entries(WEB_TOOL_GUIDANCE)
      .filter(([tool]) => selectedTools.includes(tool))
      .map(([, text]) => `- ${text}`);

    if (guidance.length === 0) {
      return filteredPrompt === event.systemPrompt
        ? undefined
        : { systemPrompt: filteredPrompt };
    }

    return {
      systemPrompt: `${filteredPrompt}\n\n## Grounding and web usage\n\nUse available web tools when current information or source evidence would improve the answer.\n\n${guidance.join('\n')}\n\nWhen citing web evidence, include the returned source URLs as clickable Markdown links. Do not replace source links with source names alone.`,
    };
  });

  pi.registerTool({
    name: 'web_research',
    label: 'Web Research',
    description:
      "Answer a complete question using Parallel's Responses API. Delegates multi-step web research and returns a synthesized answer with sources, not raw search results. One call can handle the full research question.",
    promptSnippet:
      'Get a cited answer to a complete web research question using Parallel',
    promptGuidelines: [
      'Use web_research for questions that need web research and synthesis; pass the complete question in one call before making focused follow-ups.',
      'Include dates, constraints, and relevant context in query. Research cannot see this Pi conversation or local files; include only context that is safe to send.',
      'For a follow-up on the same investigation, pass its latest returned Response ID as previous_response_id to reuse prior research context. Omit it for unrelated questions. If no ID was returned, continuation is unavailable.',
      'Use low effort for focused lookups, medium for general research, and high only for extensive research. The default is medium.',
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description:
          'The research question and constraints that are safe to send. Make a new question self-contained; a follow-up with previous_response_id may refer to prior research. Research cannot see the Pi conversation or local files.',
      }),
      effort: Type.Optional(
        Type.Union(
          [Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')],
          {
            description:
              'Research depth: low for focused lookups, medium for general research (default), high for extensive research.',
          }
        )
      ),
      previous_response_id: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: MAX_RESPONSE_ID_LENGTH,
          description:
            'The latest Response ID returned by web_research for this investigation. Reuses prior research context for a follow-up. Omit for a new or unrelated question; never invent an ID.',
        })
      ),
    }),
    // Reject invalid raw values before Pi coerces them to schema types.
    prepareArguments: parseResearchInput,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: 'text', text: 'Researching the web...' }],
        details: { provider: 'parallel', product: 'responses' },
      });
      const result = await runWithAuth(
        ctx,
        (apiKey) => runParallelResearch(apiKey, params, signal),
        // Responses errors carry HTTP status. Their text can echo opaque IDs,
        // so words such as "unauthorized" do not identify rejected credentials.
        (error) =>
          error instanceof Error && 'status' in error && error.status === 401
      );
      // Pi sends content to the parent, not details. Keep the ID ahead of the
      // answer so a truncated preview still supports an explicit follow-up.
      const report = result.responseId
        ? `Response ID: ${result.responseId}\n\n${result.text}`
        : result.text;
      const preview = truncateHead(report, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = preview.content;
      let outputFile: string | undefined;
      if (preview.truncated) {
        // Keep the complete answer and citations available when Pi's context
        // limit requires a preview. Normal research results create no file.
        const directory = await mkdtemp(join(tmpdir(), 'parallel-research-'));
        outputFile = join(directory, 'research.md');
        await writeFile(outputFile, report, { mode: 0o600 });
        const notice = `\n\n[Research output truncated. Full answer and sources: ${outputFile}]`;
        text =
          truncateHead(report, {
            maxLines: DEFAULT_MAX_LINES - 2,
            maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
          }).content + notice;
      }
      return {
        content: [{ type: 'text', text }],
        details: {
          provider: 'parallel',
          product: 'responses',
          effort: result.effort,
          ...(result.responseId ? { responseId: result.responseId } : {}),
          ...(outputFile ? { outputFile } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      "Search the web using Parallel's Search API. Prefer this over generic browser-like search tools for current web results.",
    promptSnippet:
      "Search the web using Parallel's Search API for current information",
    promptGuidelines: [
      'Use web_search for source discovery and raw excerpts when you need to investigate sources yourself.',
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
