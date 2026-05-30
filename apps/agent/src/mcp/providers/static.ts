/**
 * StaticProvider — resolves inline credentials from `auth.kind === 'static'`.
 *
 * Acquisition:
 *   - `secret` (string or Record<string,string>) — resolved directly from config.
 *   - `secretRef` only (no inline secret) — C2.5 stub; throws NotImplementedError.
 *
 * Injection targets implemented:
 *   - `env`    → { apply: 'env', vars: { [name]: value } }
 *   - `argv`   → { apply: 'argv', args: [interpolated-template] }
 *   - `file`   → { apply: 'files', dir, vars: { [pointerEnv]: absPath } }
 *   - `header` → { apply: 'headers', headers: { [name]: rendered } }  (C2)
 *
 * Template interpolation:
 *   - String secret: `{{token}}` or `{{secret}}` → the string value.
 *   - Record secret: `{{fieldName}}` → that field's value.
 *   - `field?:` on env/argv/header selects which field of a record secret.
 *
 * When multiple injections are configured (inject is an array), they must all
 * target the SAME channel — e.g. several env vars (basic-auth user+pass) which
 * accumulate. Mixing channels (env + argv, or file + anything) THROWS: a single
 * ResolvedCredential carries exactly one apply channel.
 *
 * One-channel rule: env/argv/files/headers must not be mixed in a single inject
 * array. Header injection (http) cannot be combined with env/argv/file (stdio).
 *
 * File injection is self-contained: the materialized dir + pointerEnv var are
 * returned together as a `files` credential. A `file` injection cannot be
 * combined with any other injection type.
 *
 * Note on Basic-over-http: the header injection resolves a secret value (or
 * record field via `field?`) and interpolates `valueTemplate`. A Basic auth
 * header requires a pre-encoded `username:password` value in the secret —
 * the static provider does NOT base64-encode it automatically (none of the
 * currently supported services need Basic-over-http). Defer if needed.
 */

import * as path from 'node:path';

import { defaultMaterializer } from '../materialize.js';
import { NotImplementedError } from './provider.js';

import type { AuthConfig, Injection, SecretMaterial } from '../config.js';
import type { Materializer } from '../materialize.js';
import type { CredentialProvider, ResolvedCredential } from './provider.js';

type StaticAuth = Extract<AuthConfig, { kind: 'static' }>;

export class StaticProvider implements CredentialProvider {
  private readonly materializer: Materializer;

  constructor(
    private readonly auth: StaticAuth,
    materializer?: Materializer,
  ) {
    this.materializer = materializer ?? defaultMaterializer;
  }

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

    // Detect file injection — must be a single-element array (no mixing).
    const fileInj = injections.find((i) => i.at === 'file');
    if (fileInj !== undefined) {
      return this.applyFileInjection(
        secret!,
        fileInj as Extract<Injection, { at: 'file' }>,
        injections,
      );
    }

    return applyInjections(secret!, injections);
  }

  /**
   * Handle a `file` injection: write the secret content to a temp file via
   * the Materializer and return a `files` credential.
   *
   * Constraints:
   *  - secret must be a STRING (a file is a single blob; records are rejected).
   *  - `file` must not be mixed with `env` or `argv` in the same inject array.
   */
  private async applyFileInjection(
    secret: SecretMaterial,
    inj: Extract<Injection, { at: 'file' }>,
    allInjections: Injection[],
  ): Promise<ResolvedCredential> {
    // A file injection must be the only injection (one channel per credential).
    if (allInjections.length > 1) {
      throw new Error(
        "StaticProvider: a connector's injections must all target one channel " +
          '(all env, all argv, or a single file); mixing file + env/argv is not supported',
      );
    }

    // Records are not supported for file injection — a file is a single blob.
    if (typeof secret !== 'string') {
      throw new Error(
        'StaticProvider: file injection requires a string secret (the file content); ' +
          'Record secrets are not supported for file injection',
      );
    }

    const { dir, cleanup: _cleanup } = await this.materializer.materialize(
      // Use the inject path's basename as a hint in connector naming
      'connector',
      [{ path: inj.path, content: secret }],
    );

    const absPath = path.join(dir, inj.path);
    const vars: Record<string, string> =
      inj.pointerEnv !== undefined ? { [inj.pointerEnv]: absPath } : {};

    return { apply: 'files', dir, vars };
  }
}

// ---------------------------------------------------------------------------
// Injection application
// ---------------------------------------------------------------------------

/**
 * Apply one or more injection targets to a resolved secret.
 *
 * One-channel rule: all injections in a single inject array must target the
 * same channel (all env, all argv, all header). Mixed-type arrays (e.g. env +
 * argv, or env + header) throw a clear error.
 *
 * Multiple injections of the same type accumulate:
 *   - env:    multiple env vars merged into one record.
 *   - argv:   multiple rendered args appended to the arg list.
 *   - header: multiple headers merged into one record.
 *
 * In practice, most connectors have a single injection; the array form is
 * provided for multi-field credentials (e.g. a record secret that spreads
 * into multiple env vars or headers).
 */
function applyInjections(secret: SecretMaterial, injections: Injection[]): ResolvedCredential {
  const envVars: Record<string, string> = {};
  const argvArgs: string[] = [];
  const headerMap: Record<string, string> = {};

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
      // header injection: interpolate the valueTemplate against the secret.
      // For a string secret, {{token}} / {{secret}} expand to the string.
      // For a record secret, {{fieldName}} expands to that field's value.
      // The `resolvedValue` arg to interpolateTemplate is used for {{token}}/{{secret}};
      // for record secrets that have no single "main" value we pass an empty
      // string — record field access goes through the {{field}} substitution
      // branch of interpolateTemplate instead.
      const resolvedValue = typeof secret === 'string' ? secret : '';
      const rendered = interpolateTemplate(inj.valueTemplate, resolvedValue, secret);
      headerMap[inj.name] = rendered;
      continue;
    }

    if (inj.at === 'file') {
      // Unreachable: file injection is handled earlier via applyFileInjection.
      throw new Error(
        'StaticProvider: file injection must be the only injection and is handled separately',
      );
    }

    // TypeScript exhaustiveness — new at values will be caught at compile time.
    const _exhaustive: never = inj;
    throw new Error(`Unknown injection target: ${JSON.stringify(_exhaustive)}`);
  }

  const hasEnv = Object.keys(envVars).length > 0;
  const hasArgv = argvArgs.length > 0;
  const hasHeaders = Object.keys(headerMap).length > 0;

  // One-channel rule: mixing channels in a single inject array is not allowed.
  // (Non-secret flags belong in transport.args / transport.env / transport.headers.)
  const channelCount = [hasEnv, hasArgv, hasHeaders].filter(Boolean).length;
  if (channelCount > 1) {
    throw new Error(
      "StaticProvider: a connector's injections must all target one channel " +
        '(all env, all argv, or all header); mixing channels is not supported',
    );
  }

  if (hasEnv) return { apply: 'env', vars: envVars };
  if (hasArgv) return { apply: 'argv', args: argvArgs };
  if (hasHeaders) return { apply: 'headers', headers: headerMap };
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
  return template.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string) => {
    const k = key.trim();
    if (k === 'token' || k === 'secret') return resolvedValue;
    // For record secrets, allow field-name placeholders.
    if (typeof secret === 'object' && k in secret) {
      return (secret as Record<string, string>)[k]!;
    }
    // Unknown placeholder — leave it as-is so a typo fails loudly downstream
    // instead of silently substituting the secret value.
    return match;
  });
}
