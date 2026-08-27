import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Pi research package contract', () => {
  it('ships research through the existing extension without a child package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    );
    expect(manifest.name).toBe('@parallel-web/pi-extension');
    expect(manifest.pi.extensions).toEqual(['./dist/index.js']);
    expect(manifest.pi.subagents).toBeUndefined();
    expect(manifest.files).not.toContain('agents');
    expect(manifest.dependencies['pi-subagents']).toBeUndefined();
    expect(manifest.peerDependencies['pi-subagents']).toBeUndefined();
  });
});
