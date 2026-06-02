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
      // Threshold ENFORCEMENT is deferred to C24 (promote quality gates) once C09
      // fills the highest-risk gaps. For now coverage is reported, not enforced,
      // so the blind spots become visible without breaking a green build.
    },
  },
});
