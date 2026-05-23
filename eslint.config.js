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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
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
      '@typescript-eslint/no-explicit-any': 'warn',
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
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',

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
    // Test files relax certain rules
    files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**', '**/tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  // Must be last — disables stylistic rules that conflict with Prettier
  prettierConfig,
];
