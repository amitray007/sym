/**
 * Conventional Commits + Sym-specific scope hints.
 * Husky `commit-msg` hook invokes this via @commitlint/cli.
 *
 * Examples:
 *   fix(slack): dedupe events by event_id
 *   chore(repo): bump turbo to 2.4
 *   feat(agent): stream reply via response_url
 *   feat(mcp): add stdio connector pool
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'subject-case': [0],
    // We embed structured "Cross-unit impact" sections (lists, em-dashes,
    // URLs) in commit bodies per the cross-unit-impact discipline. Those lines
    // run long by design — keep the header limit, drop the body/footer limits.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'scope-enum': [
      1,
      'always',
      [
        // Infrastructure / repo
        'repo',
        'contracts',
        // Adapters + apps
        'slack',
        'kernel',
        'agent',
        'mcp',
        // Operator control tier (kept — see docs/FUTURE.md)
        'cli',
        'tui',
        // Meta
        'ci',
        'deps',
        'docs',
        'devex',
      ],
    ],
  },
};
