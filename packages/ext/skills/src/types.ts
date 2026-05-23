/**
 * Skill types for `@sym/ext-skills`.
 *
 * A Skill is the parsed, validated representation of a `skills` DB row.
 * Skills NEVER hold secrets — enforced in the loader.
 */

/**
 * Parsed skill frontmatter (from YAML before the markdown body).
 * Only the fields the ext-skills layer cares about are typed here;
 * unknown fields are allowed through as `extraFields`.
 */
export interface SkillFrontmatter {
  /** Human-readable name (required). */
  name: string;
  /** Short description of what the skill does (required). */
  description: string;
  /** Any additional frontmatter fields. */
  extraFields: Record<string, unknown>;
}

/**
 * A fully loaded Skill — frontmatter + body, ready to be injected into a turn.
 */
export interface Skill {
  /** DB row id. */
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  frontmatter: SkillFrontmatter;
  /** The markdown body (everything after the frontmatter delimiter). */
  bodyMd: string;
  /**
   * Optional activation pattern.  When set, the skill is activated when the
   * incoming message matches this pattern (case-insensitive substring match
   * or regex literal `/…/flags`).
   */
  activationPattern?: string;
}

/**
 * Error thrown when the loader detects a secret in skill content.
 * Skills must never hold secrets — this is a hard reject.
 */
export class SkillSecretError extends Error {
  constructor(
    public readonly slug: string,
    public readonly reason: string,
  ) {
    super(`Skill "${slug}" contains a potential secret: ${reason}`);
    this.name = 'SkillSecretError';
  }
}

/**
 * Error thrown when the skill frontmatter is invalid.
 */
export class SkillParseError extends Error {
  constructor(
    public readonly slug: string,
    public readonly reason: string,
  ) {
    super(`Skill "${slug}" frontmatter parse error: ${reason}`);
    this.name = 'SkillParseError';
  }
}
