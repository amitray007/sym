// Flat config — ESLint 9+
// Per-package configs can extend this via `export default [...root, ...local]`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'pnpm-lock.yaml',
      '**/scripts/**',
      '**/tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    // CommonJS tool-config files (e.g. .dependency-cruiser.cjs) use `module.exports`
    // + `require`, which are not defined in the default (module) global scope.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // TS strictness beyond defaults
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'off', // handled by unused-imports
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      // Import hygiene
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index'], 'type'],
          pathGroups: [
            {
              // Treat all @sym/* workspace packages as internal imports.
              pattern: '@sym/**',
              group: 'internal',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',

      // Architecture guard: packages/* must not import apps/* source.
      // (dependency-cruiser enforces this at the file level too, but this
      // gives in-editor feedback without running depcruise.)
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Any relative or absolute reference that escapes into apps/**
              // from within a packages/** file. Written as a regex on the
              // import source — we match the literal "apps/" prefix which
              // is what you'd see in a workspace-relative path.
              regex: '^(\\.\\.[\\/])*apps[\\/]',
              message:
                'packages/* must not import from apps/*. Move shared code to a package instead.',
            },
          ],
        },
      ],

      // General
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'warn',
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: [
            './packages/*/tsconfig.json',
            './packages/*/*/tsconfig.json',
            './apps/*/tsconfig.json',
          ],
        },
        node: true,
      },
    },
  },
  {
    // Size / complexity guard for production source files (not tests).
    //
    // max-lines is ERROR: every source file is under 500 lines (C24 split the
    // oversized ones — builtin-tools, handle-turn, server, loop, cli, mcp/config,
    // stream-reply, web-api-client, BuilderScreen). A regression to a giant file
    // now fails CI — the enforceable ceiling this refactor was about.
    //
    // complexity / max-depth / max-params stay WARN deliberately. The codebase
    // has inherently-branchy functions (config parsers, the CLI dispatch switch,
    // the streaming state machine, the tool-call gate) where driving the metric
    // under the threshold would fragment cohesive logic rather than improve it.
    // They are surfaced for judgement, not gated: tighten a function when a split
    // genuinely improves cohesion, never just to satisfy a number.
    files: ['**/src/**/*.{ts,tsx,mts,cts}'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/test/**', '**/tests/**'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 4],
    },
  },
  {
    // Test files relax certain rules
    files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**', '**/tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      // Tests can be long — exempt from size/complexity limits
      'max-lines': 'off',
      complexity: 'off',
      'max-depth': 'off',
      'max-params': 'off',
    },
  },
  {
    // The `sym` CLI: stdout IS the product, so plain console.log is correct.
    files: ['**/src/cli/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-console': 'off',
    },
  },
  // Must be last — disables stylistic rules that conflict with Prettier
  prettierConfig,
];
