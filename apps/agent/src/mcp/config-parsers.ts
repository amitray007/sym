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

import type {
  AuthConfig,
  ConnectorConfig,
  Injection,
  SecretMaterial,
  TransportConfig,
} from './config-types.js';

export function parseEntry(entry: unknown, index: number): ConnectorConfig | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    console.warn(`[mcp] SYM_MCP_SERVERS[${index}] is not an object — skipping`);
    return null;
  }

  const e = entry as Record<string, unknown>;

  const name = e['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    console.warn(`[mcp] SYM_MCP_SERVERS[${index}] missing required 'name' string — skipping`);
    return null;
  }
  const trimmedName = name.trim();

  // ---------------------------------------------------------------------------
  // Transport (required) — a nested object with a 'kind' field.
  // ---------------------------------------------------------------------------
  const transportRaw = e['transport'];
  if (transportRaw === undefined || transportRaw === null) {
    console.warn(
      `[mcp] SYM_MCP_SERVERS[${index}] ('${trimmedName}') missing required 'transport' — skipping`,
    );
    return null;
  }

  const transport = parseTransport(transportRaw, index, trimmedName);
  if (transport === null) return null;

  // ---------------------------------------------------------------------------
  // Auth (optional)
  // ---------------------------------------------------------------------------
  const authResult = parseAuth(e['auth'], index, trimmedName);
  if (authResult === false) return null; // malformed
  const auth = authResult ?? undefined; // null ⇒ absent ⇒ undefined

  // ---------------------------------------------------------------------------
  // Prepare (optional, C2.5 stub — just validate shape)
  // ---------------------------------------------------------------------------
  const prepareResult = parsePrepare(e['prepare'], index, trimmedName);
  if (prepareResult === false) return null;
  const prepare = prepareResult ?? undefined;

  // ---------------------------------------------------------------------------
  // trust
  // ---------------------------------------------------------------------------
  const trust = e['trust'];
  if (trust !== undefined && typeof trust !== 'boolean') {
    console.warn(
      `[mcp] SYM_MCP_SERVERS[${index}] ('${trimmedName}') 'trust' must be a boolean — skipping`,
    );
    return null;
  }

  // ---------------------------------------------------------------------------
  // tools allowlist (optional)
  // ---------------------------------------------------------------------------
  const toolsResult = parseToolsAllowlist(e['tools'], index, trimmedName);
  if (toolsResult === false) return null;
  const tools = toolsResult ?? undefined;

  const config: ConnectorConfig = {
    name: trimmedName,
    transport,
    ...(auth !== undefined ? { auth } : {}),
    ...(prepare !== undefined ? { prepare } : {}),
    ...(trust === true ? { trust: true } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
  return config;
}

/**
 * Parse the `transport` field — a nested object `{ kind: 'stdio' | 'http', ... }`.
 *
 * Returns null if parsing fails (logged).
 */
function parseTransport(raw: unknown, index: number, name: string): TransportConfig | null {
  const label = `SYM_MCP_SERVERS[${index}] ('${name}')`;

  // New nested shape: { kind: 'stdio' | 'http', ... }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const t = raw as Record<string, unknown>;
    const kind = t['kind'];

    if (kind === 'stdio') {
      return parseStdioTransport(t, label);
    }

    if (kind === 'http') {
      const url = t['url'];
      if (typeof url !== 'string' || url.trim().length === 0) {
        console.warn(`[mcp] ${label} transport.kind='http' missing required 'url' — skipping`);
        return null;
      }
      const headers = parseStringRecord(t['headers'], `${label}.transport.headers`);
      if (headers === false) return null;
      return {
        kind: 'http',
        url: url.trim(),
        ...(headers !== null ? { headers } : {}),
      };
    }

    if (kind !== undefined) {
      console.warn(`[mcp] ${label} transport.kind='${String(kind)}' is not supported — skipping`);
      return null;
    }

    // Object with no 'kind' — malformed.
    console.warn(`[mcp] ${label} 'transport' object missing required 'kind' field — skipping`);
    return null;
  }

  if (typeof raw === 'string') {
    console.warn(
      `[mcp] ${label} transport='${raw}' is not supported as a string — skipping (use { kind: 'stdio', command: '...' })`,
    );
    return null;
  }

  console.warn(`[mcp] ${label} 'transport' must be an object with a 'kind' field — skipping`);
  return null;
}

function parseStdioTransport(t: Record<string, unknown>, label: string): TransportConfig | null {
  const command = t['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    console.warn(`[mcp] ${label} transport.kind='stdio' missing required 'command' — skipping`);
    return null;
  }

  const args = parseStringArray(t['args'], `${label}.transport.args`);
  if (args === false) return null;

  const env = parseStringRecord(t['env'], `${label}.transport.env`);
  if (env === false) return null;

  return {
    kind: 'stdio',
    command: command.trim(),
    ...(args !== null ? { args } : {}),
    ...(env !== null ? { env } : {}),
  };
}

/**
 * Parse auth. Returns the parsed AuthConfig, null (absent), or false (invalid).
 */
function parseAuth(raw: unknown, index: number, name: string): AuthConfig | null | false {
  if (raw === undefined || raw === null) return null;
  const label = `SYM_MCP_SERVERS[${index}] ('${name}').auth`;

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[mcp] ${label} must be an object — skipping entry`);
    return false;
  }

  const a = raw as Record<string, unknown>;
  const kind = a['kind'];

  if (kind === 'static') {
    return parseStaticAuth(a, label);
  }

  if (kind === 'oauth') {
    // OAuth is implemented (SdkOAuthAdapter + encrypted store).
    return { kind: 'oauth' };
  }

  if (kind === 'ambient') {
    // Wrapped CLI self-authenticates from disk (e.g. `gcloud auth login`).
    // Sym injects nothing; relocate the CLI's config dir via transport.env if needed.
    return { kind: 'ambient' };
  }

  console.warn(`[mcp] ${label} kind='${String(kind)}' is not recognised — skipping entry`);
  return false;
}

function parseStaticAuth(a: Record<string, unknown>, label: string): AuthConfig | false {
  // secret: string | Record<string,string> | absent
  const secret = a['secret'];
  if (secret !== undefined && secret !== null) {
    if (typeof secret !== 'string' && (typeof secret !== 'object' || Array.isArray(secret))) {
      console.warn(
        `[mcp] ${label} 'secret' must be a string or Record<string,string> — skipping entry`,
      );
      return false;
    }
    if (typeof secret === 'object') {
      // Validate all values are strings
      if (!Object.values(secret as object).every((v) => typeof v === 'string')) {
        console.warn(`[mcp] ${label} 'secret' record values must all be strings — skipping entry`);
        return false;
      }
    }
  }

  const secretRef = a['secretRef'];
  if (secretRef !== undefined && typeof secretRef !== 'string') {
    console.warn(`[mcp] ${label} 'secretRef' must be a string — skipping entry`);
    return false;
  }

  // inject: one or many
  const injectRaw = a['inject'];
  if (injectRaw === undefined || injectRaw === null) {
    console.warn(`[mcp] ${label} missing required 'inject' — skipping entry`);
    return false;
  }

  const injectArr = Array.isArray(injectRaw) ? injectRaw : [injectRaw];
  const injections: Injection[] = [];
  for (const inj of injectArr) {
    const parsed = parseInjection(inj, label);
    if (parsed === null) return false;
    injections.push(parsed);
  }

  const inject: Injection | Injection[] = injections.length === 1 ? injections[0]! : injections;

  return {
    kind: 'static',
    ...(secret !== undefined && secret !== null ? { secret: secret as SecretMaterial } : {}),
    ...(typeof secretRef === 'string' ? { secretRef } : {}),
    inject,
  };
}

function parseInjection(raw: unknown, label: string): Injection | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[mcp] ${label} 'inject' entry must be an object — skipping entry`);
    return null;
  }

  const i = raw as Record<string, unknown>;
  const at = i['at'];

  if (at === 'env') {
    const envName = i['name'];
    if (typeof envName !== 'string' || envName.trim().length === 0) {
      console.warn(`[mcp] ${label} inject.at='env' missing required 'name' — skipping entry`);
      return null;
    }
    const field = i['field'];
    if (field !== undefined && typeof field !== 'string') {
      console.warn(`[mcp] ${label} inject.at='env' 'field' must be a string — skipping entry`);
      return null;
    }
    return {
      at: 'env',
      name: envName.trim(),
      ...(typeof field === 'string' ? { field } : {}),
    };
  }

  if (at === 'argv') {
    const template = i['template'];
    if (typeof template !== 'string' || template.trim().length === 0) {
      console.warn(`[mcp] ${label} inject.at='argv' missing required 'template' — skipping entry`);
      return null;
    }
    const field = i['field'];
    if (field !== undefined && typeof field !== 'string') {
      console.warn(`[mcp] ${label} inject.at='argv' 'field' must be a string — skipping entry`);
      return null;
    }
    return {
      at: 'argv',
      template: template.trim(),
      ...(typeof field === 'string' ? { field } : {}),
    };
  }

  if (at === 'header') {
    const headerName = i['name'];
    const valueTemplate = i['valueTemplate'];
    if (typeof headerName !== 'string' || headerName.trim().length === 0) {
      console.warn(`[mcp] ${label} inject.at='header' missing required 'name' — skipping entry`);
      return null;
    }
    if (typeof valueTemplate !== 'string') {
      console.warn(
        `[mcp] ${label} inject.at='header' missing required 'valueTemplate' — skipping entry`,
      );
      return null;
    }
    return { at: 'header', name: headerName.trim(), valueTemplate };
  }

  if (at === 'file') {
    const path = i['path'];
    if (typeof path !== 'string' || path.trim().length === 0) {
      console.warn(`[mcp] ${label} inject.at='file' missing required 'path' — skipping entry`);
      return null;
    }
    const pointerEnv = i['pointerEnv'];
    if (pointerEnv !== undefined && typeof pointerEnv !== 'string') {
      console.warn(
        `[mcp] ${label} inject.at='file' 'pointerEnv' must be a string — skipping entry`,
      );
      return null;
    }
    return {
      at: 'file',
      path: path.trim(),
      ...(typeof pointerEnv === 'string' ? { pointerEnv } : {}),
    };
  }

  console.warn(`[mcp] ${label} inject.at='${String(at)}' is not recognised — skipping entry`);
  return null;
}

function parsePrepare(
  raw: unknown,
  index: number,
  name: string,
): { command: string; args?: string[] } | null | false {
  if (raw === undefined || raw === null) return null;
  const label = `SYM_MCP_SERVERS[${index}] ('${name}').prepare`;

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[mcp] ${label} must be an object — skipping entry`);
    return false;
  }

  const p = raw as Record<string, unknown>;
  const command = p['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    console.warn(`[mcp] ${label} missing required 'command' — skipping entry`);
    return false;
  }

  const args = parseStringArray(p['args'], `${label}.args`);
  if (args === false) return false;

  console.info(`[mcp] ${label} found — 'prepare' execution is a C2.5 stub`);
  return {
    command: command.trim(),
    ...(args !== null ? { args } : {}),
  };
}

function parseToolsAllowlist(
  raw: unknown,
  index: number,
  name: string,
): { allow?: string[] } | null | false {
  if (raw === undefined || raw === null) return null;
  const label = `SYM_MCP_SERVERS[${index}] ('${name}').tools`;

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[mcp] ${label} must be an object — skipping entry`);
    return false;
  }

  const t = raw as Record<string, unknown>;
  const allow = parseStringArray(t['allow'], `${label}.allow`);
  if (allow === false) return false;

  return { ...(allow !== null ? { allow } : {}) };
}

/** Returns the array, null (absent/undefined), or false (present but invalid). */
function parseStringArray(raw: unknown, label: string): string[] | null | false {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    console.warn(`[mcp] ${label} must be an array of strings — skipping entry`);
    return false;
  }
  return raw as string[];
}

/** Returns the record, null (absent/undefined), or false (present but invalid). */
function parseStringRecord(raw: unknown, label: string): Record<string, string> | null | false {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !Object.values(raw as object).every((v) => typeof v === 'string')
  ) {
    console.warn(`[mcp] ${label} must be a Record<string,string> — skipping entry`);
    return false;
  }
  return raw as Record<string, string>;
}
