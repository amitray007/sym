import { defineConfig } from 'vitest/config';

// @sym/contracts is types-only — there is no runtime to test. We use Vitest's
// typecheck mode to assert type-level invariants (brand nominality, interface
// shapes) in *.test-d.ts files. `pnpm test` runs `vitest run --typecheck`.
export default defineConfig({
  test: {
    include: [],
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
