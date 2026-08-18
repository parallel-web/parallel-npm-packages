import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

describe('pi-subagents package contract', () => {
  it('ships the Parallel research agent through the Pi manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8')
    );

    expect(manifest.name).toBe('@parallel-web/pi-extension');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.files).toContain('agents');
    expect(manifest.pi.subagents.agents).toEqual(['./agents']);
  });

  it('pins a one-turn fresh agent to the Parallel research model', () => {
    const agent = readFileSync(
      resolve(packageRoot, 'agents', 'parallel-research.md'),
      'utf8'
    );

    expect(agent).toContain('name: parallel-research');
    expect(agent).toContain('model: parallel/research');
    expect(agent).toContain('thinking: medium');
    expect(agent).toContain('systemPromptMode: replace');
    expect(agent).toContain('inheritProjectContext: false');
    expect(agent).toContain('inheritSkills: false');
    expect(agent).toContain('defaultContext: fresh');
    expect(agent).toContain('completionGuard: false');
    expect(agent).toContain('turnBudget: {"maxTurns":1,"graceTurns":0}');
  });
});
