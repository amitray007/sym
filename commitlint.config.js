/**
 * Conventional Commits + Sym-specific scope hints.
 * Husky `commit-msg` hook invokes this via @commitlint/cli.
 *
 * Examples:
 *   feat(db): add memory_entries table
 *   fix(slack): dedupe events by event_id
 *   chore(repo): bump turbo to 2.4
 *   docs(plan): clarify Sp2 review gate
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'subject-case': [0],
    'scope-enum': [
      1,
      'always',
      [
        // Spine
        'repo',
        'db',
        'contracts',
        'secrets',
        // Streams
        'slack',
        'kernel',
        'fireworks',
        'dashboard',
        'onboarding',
        'mcp',
        'skills',
        'sandbox',
        'memory',
        'audit',
        'tasks',
        'soul',
        'devex',
        // Meta
        'ci',
        'deps',
        'docs',
        'specs',
      ],
    ],
  },
};
