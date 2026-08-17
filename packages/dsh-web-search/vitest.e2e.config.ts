import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live-search.e2e.ts'],
  },
});
