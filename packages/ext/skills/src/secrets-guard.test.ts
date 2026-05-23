/**
 * Secrets guard unit tests.
 * Tests all detection patterns.
 */

import { describe, expect, it } from 'vitest';

import { assertNoSecrets } from './secrets-guard.js';
import { SkillSecretError } from './types.js';

describe('assertNoSecrets', () => {
  // -------------------------------------------------------------------------
  // PEM
  // -------------------------------------------------------------------------

  it('rejects content with a PEM RSA private key', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----';
    expect(() => assertNoSecrets('test', content)).toThrowError(SkillSecretError);
  });

  it('rejects content with a PEM EC private key', () => {
    const content = '-----BEGIN EC PRIVATE KEY-----\nABC\n-----END EC PRIVATE KEY-----';
    expect(() => assertNoSecrets('test', content)).toThrowError(SkillSecretError);
  });

  it('rejects content with an OpenSSH private key', () => {
    const content = '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----';
    expect(() => assertNoSecrets('test', content)).toThrowError(SkillSecretError);
  });

  // -------------------------------------------------------------------------
  // JWT
  // -------------------------------------------------------------------------

  it('rejects content containing a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(() => assertNoSecrets('test', `token=${jwt}`)).toThrowError(SkillSecretError);
  });

  // -------------------------------------------------------------------------
  // Known token prefixes
  // -------------------------------------------------------------------------

  it('rejects Slack bot tokens (xoxb-...)', () => {
    const content = 'SLACK_TOKEN=xoxb-1234567890-abcdefghijklmnopqrstuvwxyz';
    expect(() => assertNoSecrets('test', content)).toThrowError(SkillSecretError);
  });

  it('rejects GitHub personal access tokens (ghp_...)', () => {
    const content = 'GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh';
    expect(() => assertNoSecrets('test', content)).toThrowError(SkillSecretError);
  });

  it('rejects GitLab tokens (glpat-...)', () => {
    const content = 'GL_TOKEN=glpat-ABCDEFGHIJKLMNOPQRST';
    expect(() => assertNoSecrets('test', content)).toThrowError(SkillSecretError);
  });

  // -------------------------------------------------------------------------
  // Placeholders are allowed
  // -------------------------------------------------------------------------

  it('allows placeholder: xoxb-YOUR_TOKEN_HERE', () => {
    expect(() => assertNoSecrets('test', 'Set SLACK_BOT_TOKEN=xoxb-YOUR_TOKEN_HERE')).not.toThrow();
  });

  it('allows placeholder: ghp_<YOUR_TOKEN>', () => {
    expect(() => assertNoSecrets('test', 'GH_TOKEN=ghp_<YOUR_TOKEN>')).not.toThrow();
  });

  it('allows placeholder: ${SLACK_TOKEN}', () => {
    expect(() => assertNoSecrets('test', 'SLACK_TOKEN=${SLACK_TOKEN}')).not.toThrow();
  });

  it('allows placeholder: host_managed_credential', () => {
    expect(() => assertNoSecrets('test', 'api_key=host_managed_credential')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Safe content
  // -------------------------------------------------------------------------

  it('allows normal skill markdown content', () => {
    const content = `## How to use

Run \`gh issue list --repo owner/repo\`.

The skill uses the provider-configured GitHub token through the sandbox egress proxy.
`;
    expect(() => assertNoSecrets('github', content)).not.toThrow();
  });

  it('allows YAML frontmatter without secrets', () => {
    const content = 'name: GitHub\ndescription: Work with GitHub issues.\n';
    expect(() => assertNoSecrets('github', content)).not.toThrow();
  });

  it('allows URLs that happen to contain secret-key words', () => {
    const content = 'See https://api.example.com/oauth/token for details.';
    expect(() => assertNoSecrets('test', content)).not.toThrow();
  });
});
