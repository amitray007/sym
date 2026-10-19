import { defineConfig } from "vitest/config";

// The local end-to-end run (test/e2e). Each file starts its own `eve dev` server, fakes, and
// database, so files run one at a time with long timeouts.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
