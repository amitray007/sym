import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
