import { installParallelWebMcp } from './index.js';

void installParallelWebMcp().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.warn(
    `[parallel-webmcp] Could not register website tools: ${message}`
  );
});
