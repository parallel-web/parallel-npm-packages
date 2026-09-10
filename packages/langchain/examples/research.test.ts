import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BaseChatModel,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { Parallel } from 'parallel-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runResearch } from './research.mjs';

class ScriptedModel extends BaseChatModel {
  boundTools: BindToolsInput[] = [];

  constructor(private respond: (messages: BaseMessage[]) => AIMessage) {
    super({});
  }

  _llmType() {
    return 'fixture';
  }

  bindTools(tools: BindToolsInput[]) {
    this.boundTools = tools;
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.respond(messages);
    return { generations: [{ text: message.text, message }] };
  }
}

const sourceUrl = 'https://example.com/releases';
const sourceFact = 'This release adds streaming responses.';
const searchCall = () =>
  new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'call_search',
        name: 'parallel_web_search',
        args: { search_queries: ['latest release streaming responses'] },
      },
    ],
  });

describe('research example', () => {
  beforeEach(() => {
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('runs search and extraction through the agent and retains cited sources', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const responses: unknown[] = [];
    const client = new Parallel({
      apiKey: 'fixture-key',
      maxRetries: 0,
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(init?.body as string);
        requests.push({ path, body });
        expect(['/v1/search', '/v1/extract']).toContain(path);
        const response = {
          ...(path === '/v1/search'
            ? { search_id: 'search_fixture' }
            : { extract_id: 'extract_fixture', errors: [] }),
          session_id: body.session_id,
          results: [
            { url: sourceUrl, title: 'Release notes', excerpts: [sourceFact] },
          ],
        };
        responses.push(response);
        return new Response(JSON.stringify(response), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const model = new ScriptedModel((messages) => {
      const observations = messages.filter(ToolMessage.isInstance);
      if (!observations.length) return searchCall();

      expect(observations[0].text).toContain(sourceUrl);
      if (observations.length === 1) {
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call_extract',
              name: 'parallel_extract',
              args: { urls: [sourceUrl], objective: 'What changed?' },
            },
          ],
        });
      }

      const extracted = observations[1].text;
      expect(extracted).toContain(sourceUrl);
      const fact = extracted.match(/This release adds [^.]+\./)?.[0];
      if (!fact) throw new Error('The extracted fact did not reach the model.');
      return new AIMessage(`${fact} [Release notes](${sourceUrl})`);
    });

    const result = await runResearch({
      question: 'What changed in the latest release?',
      model,
      client,
    });

    expect(model.boundTools.map((tool) => 'name' in tool && tool.name)).toEqual(
      ['parallel_web_search', 'parallel_extract']
    );
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/search',
      '/v1/extract',
    ]);
    expect(requests[1].body.urls).toEqual([sourceUrl]);
    expect(requests[0].body.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1].body.session_id).toBe(requests[0].body.session_id);
    expect(
      result.messages
        .filter(ToolMessage.isInstance)
        .map((message) => message.artifact)
    ).toEqual(responses);
    expect(result.messages.at(-1)?.text).toBe(
      `${sourceFact} [Release notes](${sourceUrl})`
    );
  });

  it('cancels an in-flight SDK request when its caller aborts', async () => {
    let transportAborted = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const client = new Parallel({
      apiKey: 'fixture-key',
      maxRetries: 0,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              transportAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true }
          );
          markStarted();
        }),
    });
    const controller = new AbortController();
    const pending = runResearch({
      question: 'Research a release.',
      model: new ScriptedModel(searchCall),
      client,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await started;
    controller.abort(new Error('Research cancelled.'));
    await rejected;
    expect(transportAborted).toBe(true);
  });

  it('stops an agent that keeps asking for more searches', async () => {
    let requestCount = 0;
    const client = new Parallel({
      apiKey: 'fixture-key',
      maxRetries: 0,
      fetch: async () => {
        requestCount += 1;
        return new Response(
          JSON.stringify({
            search_id: 'search_fixture',
            session_id: 'session_fixture',
            results: [],
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      },
    });

    await expect(
      runResearch({
        question: 'Research a release.',
        model: new ScriptedModel(searchCall),
        client,
      })
    ).rejects.toThrow(/recursion limit/i);
    expect(requestCount).toBeGreaterThan(0);
    expect(requestCount).toBeLessThanOrEqual(12);
  });

  it('reports missing CLI configuration before creating API clients', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./research.mjs', import.meta.url)), 'A question'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PARALLEL_API_KEY: '',
          OPENAI_API_KEY: '',
          RESEARCH_MODEL: '',
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'Missing configuration: PARALLEL_API_KEY, OPENAI_API_KEY, RESEARCH_MODEL.'
    );
    expect(result.stderr).toContain(
      'RESEARCH_MODEL must support tool calling.'
    );
  });
});
