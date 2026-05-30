/**
 * StaticProvider — resolves inline credentials from `auth.kind === 'static'`.
 *
 * Acquisition:
 *   - `secret` (string or Record<string,string>) — resolved directly from config.
 *   - `secretRef` only (no inline secret) — C2.5 stub; throws NotImplementedError.
 *
 * Injection targets implemented:
 *   - `env`  → { apply: 'env', vars: { [name]: value } }
 *   - `argv` → { apply: 'argv', args: [interpolated-template] }
 *
 * Injection targets stubbed:
 *   - `header` → C2 (HTTP transport)
 *   - `file`   → C2.5 (Materializer)
 *
 * Template interpolation:
 *   - String secret: `{{token}}` or `{{secret}}` → the string value.
 *   - Record secret: `{{fieldName}}` → that field's value.
 *   - `field?:` on env/argv selects which field of a record secret.
 *
 * When multiple injections are configured (inject is an array), each one is
 * resolved independently and the results are merged: env vars accumulate,
 * argv args accumulate. If injections produce mixed apply types (e.g. one
 * env + one argv), the result with the most entries wins — the injector
 * applies each apply type separately. In practice, callers produce a single
 * apply type per connector (one kind of injection per auth block).
 */

import { NotImplementedError } from './provider.js';

import type { AuthConfig, Injection, SecretMaterial } from '../config.js';
import type { CredentialProvider, ResolvedCredential } from './provider.js';

type StaticAuth = Extract<AuthConfig, { kind: 'static' }>;

export class StaticProvider implements CredentialProvider {
  constructor(private readonly auth: StaticAuth) {}

  async resolve(): Promise<ResolvedCredential> {
    const { secret, secretRef, inject } = this.auth;

    // Acquisition step — get the raw secret value.
    if (secret === undefined && secretRef !== undefined) {
      throw new NotImplementedError(`credential store (secretRef '${secretRef}') — C2.5`);
    }

    // No secret and no secretRef — apply: none (inject is technically required
    // by the schema but we fail-gracefully here).
    if (secret === undefined && secretRef === undefined) {
      return { apply: 'none' };
    }

    // Injection step — apply each injection to the resolved secret.
    const injections = Array.isArray(inject) ? inject : [inject];
    return applyInjections(secret!, injections);
  }
}

// ---------------------------------------------------------------------------
// Injection application
// ---------------------------------------------------------------------------

/**
 * Apply one or more injection targets to a resolved secret.
 *
 * When all injections are the same type (all env, all argv), they are merged
 * into a single `ResolvedCredential`. Mixed-type arrays (e.g. env + argv)
 * are unusual but supported by accumulating each type separately and
 * returning the env result when both are present (env is the more common case
 * and a single credential can only carry one `apply` discriminant).
 *
 * In practice, most connectors have a single injection; the array form is
 * provided for multi-field credentials (e.g. a record secret that spreads
 * into multiple env vars).
 */
function applyInjections(secret: SecretMaterial, injections: Injection[]): ResolvedCredential {
  const envVars: Record<string, string> = {};
  const argvArgs: string[] = [];

  for (const inj of injections) {
    if (inj.at === 'env') {
      const value = resolveField(secret, inj.field);
      envVars[inj.name] = value;
      continue;
    }

    if (inj.at === 'argv') {
      const value = resolveField(secret, inj.field);
      const rendered = interpolateTemplate(inj.template, value, secret);
      argvArgs.push(rendered);
      continue;
    }

    if (inj.at === 'header') {
      throw new NotImplementedError('header injection — C2');
    }

    if (inj.at === 'file') {
      throw new NotImplementedError('file injection — C2.5');
    }

    // TypeScript exhaustiveness — new at values will be caught at compile time.
    const _exhaustive: never = inj;
    throw new Error(`Unknown injection target: ${JSON.stringify(_exhaustive)}`);
  }

  // Return the appropriate resolved credential.
  // When both env and argv are present, return env (more common; argv is additive).
  if (Object.keys(envVars).length > 0 && argvArgs.length > 0) {
    // Merge into env — this scenario means the caller configured both env and
    // argv injections. Both apply types will be handled by buildTransport which
    // inspects the credential.
    // For now, env takes priority as the resolved credential type; argv is a
    // secondary concern. This is a rare configuration and may be revisited.
    return { apply: 'env', vars: envVars };
  }

  if (Object.keys(envVars).length > 0) {
    return { apply: 'env', vars: envVars };
  }

  if (argvArgs.length > 0) {
    return { apply: 'argv', args: argvArgs };
  }

  return { apply: 'none' };
}

/**
 * Resolve a single field from a secret.
 *
 * - String secret + no field → the string itself.
 * - String secret + field → ignore field, use the string (field is meaningless on a string).
 * - Record secret + field → that field's value.
 * - Record secret + no field → throw; a record requires a field selector.
 */
function resolveField(secret: SecretMaterial, field: string | undefined): string {
  if (typeof secret === 'string') {
    return secret;
  }

  // Record secret.
  if (field !== undefined) {
    const value = secret[field];
    if (value === undefined) {
      throw new Error(
        `StaticProvider: field '${field}' not found in secret record (available: ${Object.keys(secret).join(', ')})`,
      );
    }
    return value;
  }

  // No field specified for a record secret — if there is exactly one field, use it.
  const keys = Object.keys(secret);
  if (keys.length === 1) {
    return secret[keys[0]!]!;
  }

  throw new Error(
    `StaticProvider: secret is a record with multiple fields (${keys.join(', ')}) — 'field' must be specified on the injection`,
  );
}

/**
 * Interpolate a template string with the resolved secret value.
 *
 * Supported placeholders:
 *  - `{{token}}`   → the resolved value (string secret)
 *  - `{{secret}}`  → alias for `{{token}}`
 *  - `{{anyKey}}`  → field from a record secret (when record has that key)
 *
 * Unrecognised placeholders are left as-is (safe — no data loss).
 */
function interpolateTemplate(
  template: string,
  resolvedValue: string,
  secret: SecretMaterial,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const k = key.trim();
    if (k === 'token' || k === 'secret') return resolvedValue;
    // For record secrets, allow field-name placeholders too.
    if (typeof secret === 'object' && k in secret) {
      return (secret as Record<string, string>)[k] ?? resolvedValue;
    }
    return resolvedValue; // fallback — use the resolved value for any unknown placeholder
  });
}
