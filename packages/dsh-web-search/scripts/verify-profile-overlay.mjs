import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return resolve(process.argv[index + 1]);
}

async function load(path) {
  return yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema });
}

function flatten(entries) {
  const rows = [];
  for (const entry of entries) {
    rows.push(entry);
    if (entry?.group === true && Array.isArray(entry.config))
      rows.push(...flatten(entry.config));
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
  assert.deepEqual(one(rows, 'web'), {
    id: 'web',
    name: '@deepseek-ai/dsh-web',
    config: { searchProvider: 'deepseek-official' },
  });
  assert.equal(
    rows.some((row) => row?.id === 'web-search-parallel'),
    false
  );
}

assert.deepEqual(one(after, 'web'), {
  id: 'web',
  name: '@deepseek-ai/dsh-web',
  config: { searchProvider: 'parallel' },
});
assert.deepEqual(one(after, 'web-search-parallel'), {
  id: 'web-search-parallel',
  name: '@parallel-web/dsh-web-search',
});

const toolBefore = one(before, 'tool-web');
const toolAfter = one(after, 'tool-web');
const toolRemoved = one(removed, 'tool-web');
assert.deepEqual(toolAfter, toolBefore);
assert.deepEqual(toolRemoved, toolBefore);

process.stdout.write(
  'profile overlay valid: deepseek-official -> parallel -> deepseek-official; tool-web preserved\n'
);
