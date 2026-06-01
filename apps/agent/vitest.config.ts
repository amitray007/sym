import { createRequire } from 'node:module';

import { defineConfig, type Plugin } from 'vitest/config';

const _require = createRequire(import.meta.url);

/**
 * Vite 5 does not know about Node 24 built-ins (e.g. node:sqlite) that are
 * not in its hardcoded `builtinModules` list. It strips the `node:` prefix
 * during import analysis, then tries to load the bare `sqlite` specifier as
 * a file, which fails.
 *
 * This plugin intercepts both `node:sqlite` and `sqlite` (after Vite strips
 * the prefix) in the `load` hook and provides the module content directly
 * by loading it via `require('node:sqlite')` in the Vite Node process.
 *
 * The `resolveId` hook normalizes both spellings to a stable virtual ID so the
 * `load` hook can match it.
 */
function nodeNewBuiltinsPlugin(): Plugin {
  const VIRTUAL_PREFIX = '\0node-builtin:';
  const NEW_BUILTINS: Record<string, string> = {
    'node:sqlite': 'node:sqlite',
    sqlite: 'node:sqlite',
  };

  return {
    name: 'vitest:node-new-builtins',
    enforce: 'pre',
    resolveId(id) {
      const canonical = NEW_BUILTINS[id];
      if (canonical !== undefined) {
        return VIRTUAL_PREFIX + canonical;
      }
      return undefined;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return undefined;
      const canonical = id.slice(VIRTUAL_PREFIX.length);
      // Load the module via CJS require in the Vite Node process and re-export
      // its named exports as ESM. This works because Node 24 has node:sqlite.
      const mod = _require(canonical) as Record<string, unknown>;
      const names = Object.keys(mod).filter((k) => k !== 'default');
      const exportsCode = names.map((n) => `export const ${n} = mod.${n};`).join('\n');
      return `
import { createRequire } from 'node:module';
const _r = createRequire(import.meta.url);
const mod = _r(${JSON.stringify(canonical)});
${exportsCode}
export default mod;
`;
    },
  };
}

export default defineConfig({
  plugins: [nodeNewBuiltinsPlugin()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
