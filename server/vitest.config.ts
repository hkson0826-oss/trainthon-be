import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // PGlite instances are single-connection; keep DB-backed suites in one worker.
    fileParallelism: false,
  },
});
