import { defineConfig } from 'vitest/config';

import { nodeNewBuiltinsPlugin } from './vitest.plugins.js';

// Real-wire integration suite (`*.integration.test.ts`): spawns subprocess MCP
// servers and local HTTP servers, so it is slower and isolated from the fast
// unit run. Invoked by `pnpm test:integration`. Longer timeouts accommodate the
// subprocess + network setup.
export default defineConfig({
  plugins: [nodeNewBuiltinsPlugin()],
  test: {
    include: ['tests/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
