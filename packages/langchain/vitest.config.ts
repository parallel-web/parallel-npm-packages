import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
);

export default defineConfig({
  resolve: {
    alias: {
      '@parallel-web/langchain': fileURLToPath(
        new URL('./src/index.ts', import.meta.url)
      ),
    },
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'examples/**/*.test.ts'],
  },
});
