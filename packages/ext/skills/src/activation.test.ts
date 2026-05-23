/**
 * Skill activation tests.
 * Tests both substring and regex pattern matching.
 */

import { describe, expect, it } from 'vitest';

import { buildSkillContext, matchSkills } from './activation.js';

import type { Skill } from './types.js';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    workspaceId: 'ws-1',
    slug: 'test',
    name: 'Test Skill',
    description: 'A test skill.',
    frontmatter: {
      name: 'Test Skill',
      description: 'A test skill.',
      extraFields: {},
    },
    bodyMd: '## Test\nDo something.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchSkills
// ---------------------------------------------------------------------------

describe('matchSkills', () => {
  it('returns skills whose activation_pattern is a case-insensitive substring match', () => {
    const skills = [
      makeSkill({ slug: 'sentry', activationPattern: 'sentry' }),
      makeSkill({ slug: 'github', activationPattern: 'github' }),
    ];

    const matched = matchSkills('Fix the Sentry error in the queue', skills);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.slug).toBe('sentry');
  });

  it('returns empty array when no patterns match', () => {
    const skills = [makeSkill({ slug: 'sentry', activationPattern: 'sentry' })];

    const matched = matchSkills('Check the deploy status', skills);
    expect(matched).toHaveLength(0);
  });

  it('does not match skills without an activationPattern', () => {
    const skills = [makeSkill({ slug: 'no-pattern' })];

    const matched = matchSkills('no-pattern is in this message', skills);
    expect(matched).toHaveLength(0);
  });

  it('matches multiple skills for one message', () => {
    const skills = [
      makeSkill({ slug: 'sentry', activationPattern: 'error' }),
      makeSkill({ slug: 'linear', activationPattern: 'issue' }),
    ];

    const matched = matchSkills('Create an issue for this error', skills);
    expect(matched).toHaveLength(2);
  });

  it('supports regex literal patterns', () => {
    const skills = [makeSkill({ slug: 'deploys', activationPattern: '/deploy(ment)?/i' })];

    expect(matchSkills('Run the deployment', skills)).toHaveLength(1);
    expect(matchSkills('deploy this please', skills)).toHaveLength(1);
    expect(matchSkills('check the PR', skills)).toHaveLength(0);
  });

  it('falls back to substring match for malformed regex literals', () => {
    const skills = [makeSkill({ slug: 'weird', activationPattern: '/[broken/i' })];

    // Malformed regex → substring match: check if "/[broken/i" is in the message
    expect(matchSkills('/[broken/i is here', skills)).toHaveLength(1);
    expect(matchSkills('something else', skills)).toHaveLength(0);
  });

  it('is case-insensitive for substring patterns', () => {
    const skills = [makeSkill({ slug: 'linear', activationPattern: 'linear' })];

    expect(matchSkills('Linear issue', skills)).toHaveLength(1);
    expect(matchSkills('LINEAR ISSUE', skills)).toHaveLength(1);
    expect(matchSkills('linear issue', skills)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildSkillContext
// ---------------------------------------------------------------------------

describe('buildSkillContext', () => {
  it('wraps skill body in active-skill tags', () => {
    const skill = makeSkill({
      slug: 'sentry',
      name: 'Sentry',
      bodyMd: '## Usage\nRun the CLI.',
    });

    const ctx = buildSkillContext(skill);
    expect(ctx).toContain('<active-skill slug="sentry"');
    expect(ctx).toContain('name="Sentry"');
    expect(ctx).toContain('## Usage');
    expect(ctx).toContain('</active-skill>');
  });

  it('escapes HTML special chars in the skill name', () => {
    const skill = makeSkill({
      name: 'A & B <skill>',
      slug: 'a-b',
    });

    const ctx = buildSkillContext(skill);
    expect(ctx).toContain('name="A &amp; B &lt;skill&gt;"');
  });
});
