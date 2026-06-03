import { defineConfig } from 'vitest/config';

import { nodeNewBuiltinsPlugin } from './vitest.plugins.js';

// Fast unit suite. Real-wire integration tests (`*.integration.test.ts`) spawn
// subprocess MCP servers + local HTTP servers, so they are excluded here and run
// separately via `pnpm test:integration` (see vitest.config.integration.ts).
export default defineConfig({
  plugins: [nodeNewBuiltinsPlugin()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/**/*.integration.test.ts', '**/node_modules/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // Regression floor — set a few points below current coverage (lines ~78%,
      // branches ~83%, funcs ~84%) so a real drop fails CI, while small untested
      // additions don't immediately break a green build. Raise as coverage climbs.
      thresholds: {
        lines: 75,
        statements: 75,
        branches: 78,
        functions: 80,
      },
    },
  },
});
