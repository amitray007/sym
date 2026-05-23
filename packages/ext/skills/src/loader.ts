/**
 * Skill loader — reads a `skills` DB row, parses YAML frontmatter + markdown
 * body, enforces the "skills NEVER hold secrets" rule, and returns a typed Skill.
 *
 * The loader supports two calling modes:
 *  1. From a raw DB row (frontmatterJson already parsed by Drizzle).
 *  2. From a raw markdown string (with `---` YAML frontmatter delimiters).
 *
 * In both cases the secrets guard is applied to the complete content.
 */

import yaml from 'js-yaml';

import { assertNoSecrets } from './secrets-guard.js';
import { SkillParseError } from './types.js';

import type { Skill, SkillFrontmatter } from './types.js';

// ---------------------------------------------------------------------------
// DB row shape (mirrors the `skills` table columns we need)
// ---------------------------------------------------------------------------

export interface SkillRow {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  frontmatterJson: Record<string, unknown>;
  bodyMd: string;
  activationPattern?: string | null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a Skill from a DB row.
 *
 * @throws SkillSecretError if the body contains a potential secret.
 * @throws SkillParseError if the frontmatterJson is malformed.
 */
export function loadSkillFromRow(row: SkillRow): Skill {
  // Enforce secret guard on the combined content.
  const combined = yamlStringify(row.frontmatterJson) + '\n' + row.bodyMd;
  assertNoSecrets(row.slug, combined);

  const frontmatter = parseFrontmatter(row.slug, row.frontmatterJson);

  const skill: Skill = {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    frontmatter,
    bodyMd: row.bodyMd,
  };

  if (row.activationPattern != null) {
    skill.activationPattern = row.activationPattern;
  }

  return skill;
}

/**
 * Parse a raw markdown string with YAML frontmatter.
 *
 * Format:
 *   ---
 *   name: My Skill
 *   description: Does something useful.
 *   ---
 *   Markdown body...
 *
 * @throws SkillParseError if frontmatter is missing or malformed.
 * @throws SkillSecretError if the content contains a potential secret.
 */
export function loadSkillFromMarkdown(
  slug: string,
  workspaceId: string,
  id: string,
  raw: string,
): Skill {
  // Enforce secret guard on the full raw content before parsing.
  assertNoSecrets(slug, raw);

  const { frontmatterRaw, bodyMd } = splitFrontmatter(slug, raw);

  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatterRaw);
  } catch (err) {
    throw new SkillParseError(
      slug,
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new SkillParseError(slug, 'frontmatter must be a YAML object');
  }

  const raw_ = parsed as Record<string, unknown>;
  const frontmatter = parseFrontmatter(slug, raw_);

  const skill: Skill = {
    id,
    workspaceId,
    slug,
    name: frontmatter.name,
    description: frontmatter.description,
    frontmatter,
    bodyMd,
  };

  const ap = raw_['activation_pattern'];
  if (typeof ap === 'string') {
    skill.activationPattern = ap;
  }

  return skill;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(slug: string, raw: Record<string, unknown>): SkillFrontmatter {
  const name = raw['name'];
  const description = raw['description'];

  if (typeof name !== 'string' || name.trim() === '') {
    throw new SkillParseError(slug, '`name` must be a non-empty string');
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new SkillParseError(slug, '`description` must be a non-empty string');
  }

  const { name: _n, description: _d, ...rest } = raw;

  return {
    name,
    description,
    extraFields: rest,
  };
}

function splitFrontmatter(slug: string, raw: string): { frontmatterRaw: string; bodyMd: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new SkillParseError(slug, 'missing YAML frontmatter (expected `---` at start)');
  }

  // Find closing `---`
  const rest = trimmed.slice(3);
  const closeIdx = rest.indexOf('\n---');
  if (closeIdx === -1) {
    throw new SkillParseError(slug, 'unclosed YAML frontmatter (missing closing `---`)');
  }

  const frontmatterRaw = rest.slice(0, closeIdx);
  const bodyMd = rest.slice(closeIdx + 4).trimStart(); // skip \n---

  return { frontmatterRaw, bodyMd };
}

function yamlStringify(obj: Record<string, unknown>): string {
  try {
    return yaml.dump(obj);
  } catch {
    return JSON.stringify(obj);
  }
}
