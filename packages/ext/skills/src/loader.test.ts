/**
 * Skill loader tests.
 * Tests both loadSkillFromRow and loadSkillFromMarkdown.
 * Importantly: tests the "skills NEVER hold secrets" enforcement.
 */

import { describe, expect, it } from 'vitest';

import { loadSkillFromMarkdown, loadSkillFromRow } from './loader.js';
import { SkillParseError, SkillSecretError } from './types.js';

// ---------------------------------------------------------------------------
// loadSkillFromRow
// ---------------------------------------------------------------------------

describe('loadSkillFromRow', () => {
  it('returns a typed Skill from a valid DB row', () => {
    const row = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      slug: 'github',
      name: 'GitHub',
      description: 'Work with GitHub issues.',
      frontmatterJson: { name: 'GitHub', description: 'Work with GitHub issues.' },
      bodyMd: '## Usage\nRun `gh issue list`.',
      activationPattern: null,
    };

    const skill = loadSkillFromRow(row);

    expect(skill.id).toBe('skill-1');
    expect(skill.slug).toBe('github');
    expect(skill.name).toBe('GitHub');
    expect(skill.description).toBe('Work with GitHub issues.');
    expect(skill.bodyMd).toBe('## Usage\nRun `gh issue list`.');
    expect(skill.activationPattern).toBeUndefined();
  });

  it('includes activationPattern when set', () => {
    const row = {
      id: 'skill-2',
      workspaceId: 'ws-1',
      slug: 'sentry',
      name: 'Sentry',
      description: 'Triage Sentry errors.',
      frontmatterJson: { name: 'Sentry', description: 'Triage Sentry errors.' },
      bodyMd: 'Use the sentry CLI.',
      activationPattern: 'sentry',
    };

    const skill = loadSkillFromRow(row);
    expect(skill.activationPattern).toBe('sentry');
  });

  it('throws SkillParseError when name is missing', () => {
    const row = {
      id: 'skill-3',
      workspaceId: 'ws-1',
      slug: 'bad-skill',
      name: '',
      description: 'No name here.',
      frontmatterJson: { description: 'No name here.' },
      bodyMd: 'body',
      activationPattern: null,
    };

    expect(() => loadSkillFromRow(row)).toThrowError(SkillParseError);
  });

  it('throws SkillParseError when description is missing', () => {
    const row = {
      id: 'skill-4',
      workspaceId: 'ws-1',
      slug: 'bad-skill',
      name: 'Bad',
      description: '',
      frontmatterJson: { name: 'Bad' },
      bodyMd: 'body',
      activationPattern: null,
    };

    expect(() => loadSkillFromRow(row)).toThrowError(SkillParseError);
  });

  // -------------------------------------------------------------------------
  // Secret enforcement
  // -------------------------------------------------------------------------

  it('throws SkillSecretError when body contains a PEM private key', () => {
    const row = {
      id: 'skill-secret',
      workspaceId: 'ws-1',
      slug: 'evil-skill',
      name: 'Evil',
      description: 'Has a private key.',
      frontmatterJson: { name: 'Evil', description: 'Has a private key.' },
      bodyMd: '-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----',
      activationPattern: null,
    };

    expect(() => loadSkillFromRow(row)).toThrowError(SkillSecretError);
  });

  it('throws SkillSecretError when body contains a Slack bot token', () => {
    const row = {
      id: 'skill-slack',
      workspaceId: 'ws-1',
      slug: 'slack-token-skill',
      name: 'Slack',
      description: 'Leaks a token.',
      frontmatterJson: { name: 'Slack', description: 'Leaks a token.' },
      bodyMd: 'The token is xoxb-1234567890-abcdefghijklmnop and must be kept secret.',
      activationPattern: null,
    };

    expect(() => loadSkillFromRow(row)).toThrowError(SkillSecretError);
  });

  it('throws SkillSecretError when body contains a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    const row = {
      id: 'skill-jwt',
      workspaceId: 'ws-1',
      slug: 'jwt-skill',
      name: 'JWT',
      description: 'Has a JWT.',
      frontmatterJson: { name: 'JWT', description: 'Has a JWT.' },
      bodyMd: `Here is the token: ${jwt}`,
      activationPattern: null,
    };

    expect(() => loadSkillFromRow(row)).toThrowError(SkillSecretError);
  });

  it('allows placeholder token values (e.g. xoxb-YOUR_TOKEN_HERE)', () => {
    const row = {
      id: 'skill-ok',
      workspaceId: 'ws-1',
      slug: 'safe-slack',
      name: 'Safe Slack',
      description: 'Safe docs.',
      frontmatterJson: { name: 'Safe Slack', description: 'Safe docs.' },
      bodyMd: 'Set SLACK_TOKEN=xoxb-YOUR_TOKEN_HERE in the environment.',
      activationPattern: null,
    };

    expect(() => loadSkillFromRow(row)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadSkillFromMarkdown
// ---------------------------------------------------------------------------

describe('loadSkillFromMarkdown', () => {
  const validMarkdown = `---
name: Linear
description: Manage Linear issues.
activation_pattern: linear
---

## How to use

Run \`linear issue list\`.
`;

  it('parses a valid markdown skill', () => {
    const skill = loadSkillFromMarkdown('linear', 'ws-1', 'skill-md-1', validMarkdown);

    expect(skill.slug).toBe('linear');
    expect(skill.name).toBe('Linear');
    expect(skill.description).toBe('Manage Linear issues.');
    expect(skill.activationPattern).toBe('linear');
    expect(skill.bodyMd).toContain('Run `linear issue list`');
  });

  it('throws SkillParseError when frontmatter is missing', () => {
    expect(() => loadSkillFromMarkdown('bad', 'ws-1', 'id-1', 'No frontmatter here.')).toThrowError(
      SkillParseError,
    );
  });

  it('throws SkillParseError when closing --- is missing', () => {
    const md = '---\nname: Broken\ndescription: No close\n# No body';
    expect(() => loadSkillFromMarkdown('bad', 'ws-1', 'id-1', md)).toThrowError(SkillParseError);
  });

  it('throws SkillParseError when YAML is invalid', () => {
    const md = '---\n: invalid: yaml: {\n---\nbody';
    expect(() => loadSkillFromMarkdown('bad', 'ws-1', 'id-1', md)).toThrowError(SkillParseError);
  });

  it('throws SkillSecretError when markdown contains a GitHub token', () => {
    const md = `---
name: GitHub
description: GitHub skill.
---

Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh as the token.
`;
    expect(() => loadSkillFromMarkdown('github', 'ws-1', 'id-1', md)).toThrowError(
      SkillSecretError,
    );
  });

  it('allows GitHub CLI examples without a real token', () => {
    const md = `---
name: GitHub
description: Work with GitHub.
---

Run \`gh issue list --repo owner/repo\`.
`;
    expect(() => loadSkillFromMarkdown('github', 'ws-1', 'id-1', md)).not.toThrow();
  });

  it('preserves extra frontmatter fields', () => {
    const md = `---
name: Custom
description: Has extras.
custom_field: some_value
another: 42
---
body
`;
    const skill = loadSkillFromMarkdown('custom', 'ws-1', 'id-1', md);
    expect(skill.frontmatter.extraFields['custom_field']).toBe('some_value');
    expect(skill.frontmatter.extraFields['another']).toBe(42);
  });
});
