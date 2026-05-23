/**
 * Skills NEVER hold secrets — enforce in the loader (reject/scrub) and test it.
 *
 * This module provides a best-effort heuristic guard that rejects skill content
 * containing patterns that look like secrets.  It is not a silver bullet — it
 * prevents accidental inclusion, not adversarial smuggling.
 *
 * Patterns checked:
 *  1. Common secret key-value patterns (e.g. `token: xoxb-...`, `api_key=...`).
 *  2. High-entropy strings (≥40 chars of mixed alnum/special) in values.
 *  3. Known prefixes for popular service tokens (Slack `xoxb-`, GitHub `ghp_`, etc.).
 *  4. JWT-shaped strings (`eyJ...`).
 *  5. Private key PEM headers.
 *
 * The guard raises SkillSecretError so the loader can reject the skill.
 */

import { SkillSecretError } from './types.js';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Key names that suggest a field holds a secret. */
const SECRET_KEY_PATTERN =
  /\b(?:token|secret|password|passwd|api_?key|auth_?key|access_?key|private_?key|client_?secret|credential)\b/i;

/** Known token prefixes for popular services. */
const KNOWN_TOKEN_PREFIXES = [
  'xoxb-', // Slack bot token
  'xoxp-', // Slack user token
  'xoxa-', // Slack app token
  'xoxe-', // Slack socket token
  'ghp_', // GitHub personal access token
  'ghs_', // GitHub Actions secret
  'ghr_', // GitHub refresh token
  'glpat-', // GitLab personal access token
  'sk-', // OpenAI API key prefix
  'Bearer ', // Generic bearer (requires value check)
];

/** JWT shape: base64url.base64url.base64url */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/** PEM private key markers. */
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

/** High-entropy value: ≥40 alnum+special chars without whitespace. */
const HIGH_ENTROPY_PATTERN = /[A-Za-z0-9+/=_-]{40,}/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a string of content (frontmatter + body combined) for secret patterns.
 * Throws SkillSecretError if a potential secret is detected.
 */
export function assertNoSecrets(slug: string, content: string): void {
  // 1. PEM private key
  if (PEM_PRIVATE_KEY_PATTERN.test(content)) {
    throw new SkillSecretError(slug, 'contains a PEM private key');
  }

  // 2. JWT
  if (JWT_PATTERN.test(content)) {
    throw new SkillSecretError(slug, 'contains a JWT-shaped string');
  }

  // 3. Known token prefixes (scan line by line to get context)
  for (const line of content.split('\n')) {
    for (const prefix of KNOWN_TOKEN_PREFIXES) {
      if (line.includes(prefix)) {
        // Allow lines that are clearly documentation examples:
        // `xoxb-YOUR_TOKEN_HERE` or `xoxb-<token>` or `xoxb-xxx` are fine.
        const rest = line.slice(line.indexOf(prefix) + prefix.length).trim();
        if (looksLikePlaceholder(rest)) continue;
        throw new SkillSecretError(slug, `contains a token with prefix "${prefix}"`);
      }
    }
  }

  // 4. Secret key-value heuristic
  for (const line of content.split('\n')) {
    if (!SECRET_KEY_PATTERN.test(line)) continue;

    // Extract the value part (after `=`, `:`, or whitespace following the key).
    const valueMatch = /[:=]\s*([^\s#,'"}\]]+)/.exec(line);
    if (!valueMatch) continue;

    const value = valueMatch[1] ?? '';
    if (looksLikePlaceholder(value)) continue;
    if (looksLikeUrl(value)) continue;

    // Only flag if the value has high entropy.
    if (HIGH_ENTROPY_PATTERN.test(value) && value.length >= 20) {
      throw new SkillSecretError(
        slug,
        `line contains a secret-key pattern with a high-entropy value: "${line.slice(0, 80)}"`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Common placeholder patterns that are safe in docs. */
const PLACEHOLDER_PATTERNS = [
  /^<[^>]+>$/, // <YOUR_TOKEN>
  /^YOUR_/i, // YOUR_TOKEN_HERE
  /^xxx+/i, // xxx or XXXX...
  /^[*]+$/, // ****
  /^\$\{[A-Z_][A-Z0-9_]*\}$/, // ${ENV_VAR}
  /^host_managed_credential$/i,
  /^placeholder/i,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

function looksLikeUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}
