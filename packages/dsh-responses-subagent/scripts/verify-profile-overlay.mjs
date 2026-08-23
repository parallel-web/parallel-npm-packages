import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  const value = process.argv[index + 1];
  assert.ok(value, `missing value for ${name}`);
  return resolve(value);
}

async function load(path) {
  return yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema });
}

function flatten(entries) {
  const rows = [];
  for (const entry of entries) {
    rows.push(entry);
    if (entry?.group === true && Array.isArray(entry.config)) {
      rows.push(...flatten(entry.config));
    }
  }
  return rows;
}

function one(rows, id) {
  const matches = rows.filter((row) => row?.id === id);
  assert.equal(matches.length, 1, `expected exactly one ${id} row`);
  return matches[0];
}

const before = flatten(await load(argument('--before')));
const after = flatten(await load(argument('--after')));
const removed = flatten(await load(argument('--removed')));

for (const rows of [before, removed]) {
  assert.equal(
    rows.some((row) => row?.id === 'subagent-parallel-responses'),
    false
  );
  assert.equal(
    rows.some((row) => row?.id === 'tool-subagent-parallel-responses'),
    false
  );
}

assert.deepEqual(one(after, 'subagent-parallel-responses'), {
  id: 'subagent-parallel-responses',
  name: '@parallel-web/dsh-responses-subagent',
});
assert.deepEqual(one(after, 'tool-subagent-parallel-responses'), {
  id: 'tool-subagent-parallel-responses',
  name: '@deepseek-ai/dsh-tool-subagent',
  config: {
    provider: 'parallel-responses',
    toolName: 'parallel_research',
    enableRunInBackground: false,
    backgroundMode: 'one-shot',
    maxDepth: 'provider-managed',
  },
});

for (const id of [
  'subagent',
  'tool-subagent',
  'web',
  'web-search-deepseek',
  'tool-web',
]) {
  assert.deepEqual(one(after, id), one(before, id), `${id} changed on install`);
  assert.deepEqual(
    one(removed, id),
    one(before, id),
    `${id} changed after removal`
  );
}

process.stdout.write(
  'profile overlay valid: provider and foreground-only research tool install/remove cleanly; existing Search and subagent rows preserved\n'
);
