import { defineConfig } from 'vitest/config';

// Only the suite: a gremlin report's repro/*.spec.ts files are Playwright tests, not vitest ones.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
