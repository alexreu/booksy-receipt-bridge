import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // Raised from the 5 s default because of pdf.js: its first parse loads a
    // worker and its font tables, which takes several seconds on a cold
    // Windows runner. The suite finishes in about three seconds on a warm
    // machine, so this ceiling only ever catches a genuine hang.
    testTimeout: 30_000,
  },
});
