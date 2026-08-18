import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live-responses.e2e.ts'],
  },
});
