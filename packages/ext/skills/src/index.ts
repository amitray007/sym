/**
 * `@sym/ext-skills` — skill loader + activation layer.
 *
 * Public API:
 *  Loader:
 *    - loadSkillFromRow     — from a `skills` DB row (frontmatterJson already parsed)
 *    - loadSkillFromMarkdown — from a raw `---frontmatter---\nbody` markdown string
 *  Activation:
 *    - matchSkills           — pattern-match skills against an incoming message
 *    - buildSkillContext     — build the context block to inject for an activated skill
 *  Types:
 *    - Skill, SkillFrontmatter
 *    - SkillSecretError, SkillParseError
 *  Secrets guard (exported for testing):
 *    - assertNoSecrets
 */

export { loadSkillFromRow, loadSkillFromMarkdown } from './loader.js';
export type { SkillRow } from './loader.js';

export { matchSkills, buildSkillContext } from './activation.js';

export { assertNoSecrets } from './secrets-guard.js';

export type { Skill, SkillFrontmatter } from './types.js';
export { SkillSecretError, SkillParseError } from './types.js';
