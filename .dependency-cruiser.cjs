/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ─────────────────────────────────────────────────────────────────────
    // ERROR: packages/* must never import from apps/*
    // This enforces the DAG: contracts → kernel → adapter → apps/agent
    // ─────────────────────────────────────────────────────────────────────
    {
      name: 'not-to-apps',
      comment:
        'packages/* must not import from apps/* — apps sit at the top of the DAG and are consumers only.',
      severity: 'error',
      from: {
        path: '^packages/',
      },
      to: {
        path: '^apps/',
      },
    },

    // ─────────────────────────────────────────────────────────────────────
    // WARN: circular dependencies
    // The known type-only cycle stream-reply.ts ↔ handle-turn.ts is
    // acceptable (type imports are erased at runtime). dependency-cruiser
    // can't distinguish type-only cycles natively, so we whitelist it and
    // keep this at `warn` for all others.
    // ─────────────────────────────────────────────────────────────────────
    {
      name: 'no-circular',
      comment: 'Circular dependencies are usually a design problem. Fix or whitelist explicitly.',
      severity: 'warn',
      from: {},
      to: {
        circular: true,
        // Exclude the known acceptable type-only cycle between
        // stream-reply ↔ handle-turn in apps/agent/src.
        pathNot: '^apps/agent/src/(stream-reply|handle-turn)\\.(ts|js)$',
      },
    },

    // ─────────────────────────────────────────────────────────────────────
    // WARN: orphan modules (no in/out dependencies at all)
    // ─────────────────────────────────────────────────────────────────────
    {
      name: 'no-orphans',
      comment: 'Orphaned modules have no imports and are not imported — likely dead code.',
      severity: 'warn',
      from: {
        orphan: true,
        // Exclude entry points and config files that are legitimately standalone.
        pathNot: [
          '(^|/)index\\.(ts|js|mjs|cjs)$',
          '\\.d\\.ts$',
          '(^|/)vitest\\.config.*\\.(ts|js)$',
          '(^|/)vitest\\.plugins.*\\.(ts|js)$',
          '(^|/)eslint\\.config.*\\.(js|mjs|cjs)$',
          '(^|/)commitlint\\.config.*\\.(js|cjs)$',
          '(^|/)lint-staged\\.config.*\\.(js|mjs|cjs)$',
          '(^|/)prettier\\.config.*\\.(js|mjs|cjs)$',
          '\\.test\\.(ts|tsx)$',
          '\\.test-d\\.ts$',
          '\\.spec\\.(ts|tsx)$',
        ],
      },
      to: {},
    },
  ],

  options: {
    // ─────────────────────────────────────────────────────────────────────
    // Module resolution
    // ─────────────────────────────────────────────────────────────────────
    doNotFollow: {
      path: ['node_modules', 'dist', 'build', '\\.next', '\\.turbo', 'coverage'],
    },
    exclude: {
      path: ['node_modules', '\\.turbo', '\\.next', 'coverage', 'dist', '\\.tsbuildinfo$'],
    },
    includeOnly: {
      path: ['^(apps|packages)/'],
    },
    moduleSystems: ['es6', 'cjs'],
    combinedDependencies: true,
    tsPreCompilationDeps: true,

    // Use tsconfig for path resolution in the monorepo
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },

    // ─────────────────────────────────────────────────────────────────────
    // Report enhancements
    // ─────────────────────────────────────────────────────────────────────
    reporterOptions: {
      dot: {
        // Group by top-level folder for readability in --output-type dot
        collapsePattern: '^(node_modules|packages/[^/]+|apps/[^/]+)/.*',
      },
      archi: {
        collapsePattern: '^(node_modules|packages/[^/]+/src|apps/[^/]+/src)/.*',
      },
    },
  },
};
