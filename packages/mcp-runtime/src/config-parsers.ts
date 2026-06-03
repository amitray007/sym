/**
 * Internal fail-open parsers for MCP connector config.
 *
 * Every malformed entry is logged and skipped; these never throw into the
 * server startup path. The public entry points (`parseMcpServers`,
 * `parseConnectorArray`) live in `./config`; the typed shapes in `./config-types`.
 *
 * `secretRef` static creds and `prepare` are parsed structurally but fail
 * cleanly at connect time (not yet wired); everything else is implemented.
 */

import { z } from 'zod';

import type {
  AuthConfig,
  ConnectorConfig,
  Injection,
  SecretMaterial,
  TransportConfig,
} from './config-types.js';

// ---------------------------------------------------------------------------
// Zod schemas — mirror config-types.ts
// ---------------------------------------------------------------------------

const stringRecordSchema = z.record(z.string(), z.string());

const stdioTransportSchema = z.object({
  kind: z.literal('stdio'),
  command: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
});

const httpTransportSchema = z.object({
  kind: z.literal('http'),
  url: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  headers: stringRecordSchema.optional(),
});

const transportSchema = z.discriminatedUnion('kind', [stdioTransportSchema, httpTransportSchema]);

const envInjectionSchema = z.object({
  at: z.literal('env'),
  name: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  field: z.string().optional(),
});

const argvInjectionSchema = z.object({
  at: z.literal('argv'),
  template: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  field: z.string().optional(),
});

const headerInjectionSchema = z.object({
  at: z.literal('header'),
  name: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  valueTemplate: z.string(),
});

const fileInjectionSchema = z.object({
  at: z.literal('file'),
  path: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  pointerEnv: z.string().optional(),
});

const injectionSchema = z.discriminatedUnion('at', [
  envInjectionSchema,
  argvInjectionSchema,
  headerInjectionSchema,
  fileInjectionSchema,
]);

const secretMaterialSchema = z.union([z.string(), stringRecordSchema]);

const staticAuthSchema = z.object({
  kind: z.literal('static'),
  secret: secretMaterialSchema.optional(),
  secretRef: z.string().optional(),
  inject: z.union([injectionSchema, z.array(injectionSchema)]),
});

const oauthAuthSchema = z.object({ kind: z.literal('oauth') });
const ambientAuthSchema = z.object({ kind: z.literal('ambient') });

const authSchema = z.discriminatedUnion('kind', [
  staticAuthSchema,
  oauthAuthSchema,
  ambientAuthSchema,
]);

const prepareSchema = z.object({
  command: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  args: z.array(z.string()).optional(),
});

const connectorEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
  transport: transportSchema,
  auth: authSchema.optional(),
  prepare: prepareSchema.optional(),
  trust: z.boolean().optional(),
  tools: z.object({ allow: z.array(z.string()).optional() }).optional(),
});

// ---------------------------------------------------------------------------
// parseEntry — the public per-entry parser
// ---------------------------------------------------------------------------

export function parseEntry(entry: unknown, index: number): ConnectorConfig | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    console.warn(`[mcp] SYM_MCP_SERVERS[${index}] is not an object — skipping`);
    return null;
  }

  // Quick pre-check for name (to keep the same per-field warning messages the
  // tests may depend on, we still extract name early for labelling).
  const e = entry as Record<string, unknown>;
  const rawName = e['name'];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    console.warn(`[mcp] SYM_MCP_SERVERS[${index}] missing required 'name' string — skipping`);
    return null;
  }
  const name = rawName.trim();

  // Quick pre-check for transport existence (to produce a better message than a
  // generic Zod failure when transport is entirely absent).
  if (e['transport'] === undefined || e['transport'] === null) {
    console.warn(
      `[mcp] SYM_MCP_SERVERS[${index}] ('${name}') missing required 'transport' — skipping`,
    );
    return null;
  }

  // Check for unsupported string transport (produce the same specific message).
  if (typeof e['transport'] === 'string') {
    console.warn(
      `[mcp] SYM_MCP_SERVERS[${index}] ('${name}') transport='${String(e['transport'])}' is not supported as a string — skipping (use { kind: 'stdio', command: '...' })`,
    );
    return null;
  }

  // Check for unknown transport.kind before Zod so the warning is specific.
  if (
    e['transport'] !== null &&
    typeof e['transport'] === 'object' &&
    !Array.isArray(e['transport'])
  ) {
    const t = e['transport'] as Record<string, unknown>;
    if (!('kind' in t)) {
      console.warn(
        `[mcp] SYM_MCP_SERVERS[${index}] ('${name}') 'transport' object missing required 'kind' field — skipping`,
      );
      return null;
    }
    const k = t['kind'];
    if (k !== 'stdio' && k !== 'http') {
      console.warn(
        `[mcp] SYM_MCP_SERVERS[${index}] ('${name}') transport.kind='${String(k)}' is not supported — skipping`,
      );
      return null;
    }
    // Check auth.kind before Zod for a specific warning.
    if (
      e['auth'] !== undefined &&
      e['auth'] !== null &&
      typeof e['auth'] === 'object' &&
      !Array.isArray(e['auth'])
    ) {
      const a = e['auth'] as Record<string, unknown>;
      const authKind = a['kind'];
      if (authKind !== 'static' && authKind !== 'oauth' && authKind !== 'ambient') {
        console.warn(
          `[mcp] SYM_MCP_SERVERS[${index}] ('${name}').auth kind='${String(authKind)}' is not recognised — skipping entry`,
        );
        return null;
      }
    }
  }

  const result = connectorEntrySchema.safeParse(entry);
  if (!result.success) {
    console.warn(
      `[mcp] SYM_MCP_SERVERS[${index}] ('${name}') invalid config — skipping:`,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    return null;
  }

  const parsed = result.data;

  // trust: only set when true (undefined or false → absent in output, preserving
  // the existing "not toHaveProperty('trust')" test assertions).
  const trustField: { trust?: true } = parsed.trust === true ? { trust: true } : {};

  // prepare: emit info log (preserve the existing behaviour in parsePrepare).
  if (parsed.prepare !== undefined) {
    console.info(
      `[mcp] SYM_MCP_SERVERS[${index}] ('${name}').prepare found — 'prepare' execution is a C2.5 stub`,
    );
  }

  // Build the typed ConnectorConfig.
  const config: ConnectorConfig = {
    name: parsed.name,
    transport: buildTransportConfig(parsed.transport),
    ...(parsed.auth !== undefined ? { auth: buildAuthConfig(parsed.auth) } : {}),
    ...(parsed.prepare !== undefined ? { prepare: buildPrepare(parsed.prepare) } : {}),
    ...trustField,
    ...(parsed.tools !== undefined
      ? {
          tools: parsed.tools.allow !== undefined ? { allow: parsed.tools.allow } : {},
        }
      : {}),
  };
  return config;
}

// ---------------------------------------------------------------------------
// Helpers to convert Zod output → typed config shapes
// ---------------------------------------------------------------------------

type ZodTransport = z.infer<typeof transportSchema>;
type ZodAuth = z.infer<typeof authSchema>;
type ZodInjection = z.infer<typeof injectionSchema>;
type ZodPrepare = z.infer<typeof prepareSchema>;

function buildTransportConfig(t: ZodTransport): TransportConfig {
  if (t.kind === 'stdio') {
    return {
      kind: 'stdio',
      command: t.command,
      ...(t.args !== undefined ? { args: t.args } : {}),
      ...(t.env !== undefined ? { env: t.env } : {}),
    };
  }
  // http
  return {
    kind: 'http',
    url: t.url,
    ...(t.headers !== undefined ? { headers: t.headers } : {}),
  };
}

function buildInjection(inj: ZodInjection): Injection {
  switch (inj.at) {
    case 'env':
      return {
        at: 'env',
        name: inj.name,
        ...(inj.field !== undefined ? { field: inj.field } : {}),
      };
    case 'argv':
      return {
        at: 'argv',
        template: inj.template,
        ...(inj.field !== undefined ? { field: inj.field } : {}),
      };
    case 'header':
      return { at: 'header', name: inj.name, valueTemplate: inj.valueTemplate };
    case 'file':
      return {
        at: 'file',
        path: inj.path,
        ...(inj.pointerEnv !== undefined ? { pointerEnv: inj.pointerEnv } : {}),
      };
  }
}

function buildAuthConfig(a: ZodAuth): AuthConfig {
  if (a.kind === 'oauth') return { kind: 'oauth' };
  if (a.kind === 'ambient') return { kind: 'ambient' };

  // static
  const injectRaw = a.inject;
  const injectArr: Injection[] = Array.isArray(injectRaw)
    ? injectRaw.map((i) => buildInjection(i))
    : [buildInjection(injectRaw)];
  const inject: Injection | Injection[] = injectArr.length === 1 ? injectArr[0]! : injectArr;

  const secret: SecretMaterial | undefined =
    a.secret !== undefined ? (a.secret as SecretMaterial) : undefined;

  return {
    kind: 'static',
    ...(secret !== undefined ? { secret } : {}),
    ...(typeof a.secretRef === 'string' ? { secretRef: a.secretRef } : {}),
    inject,
  };
}

function buildPrepare(p: ZodPrepare): { command: string; args?: string[] } {
  return {
    command: p.command,
    ...(p.args !== undefined ? { args: p.args } : {}),
  };
}
