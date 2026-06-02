/**
 * MCP connector config types — the typed shape of one connector entry.
 *
 * Shape (JSON array):
 * ```json
 * [
 *   {
 *     "name": "my-server",
 *     "transport": { "kind": "stdio", "command": "/usr/local/bin/my-mcp-server", "args": ["--flag"] },
 *     "auth": {
 *       "kind": "static",
 *       "secret": "sk-abc123",
 *       "inject": { "at": "env", "name": "API_KEY" }
 *     },
 *     "trust": true
 *   }
 * ]
 * ```
 *
 * Three axes:
 *  - Transport:    stdio (implemented) | http (implemented — C2)
 *  - Acquisition:  static inline (implemented) | oauth (implemented) | secretRef store (stub — later)
 *  - Injection:    env (implemented) | argv (implemented) | header (implemented) | file (implemented)
 *
 * `trust: true` means the owner has opted this server's tools into skipping
 * the confirm-before-destructive gate. Owner-set only — never derived from
 * server-reported annotations.
 *
 * Still stubbed (parsed structurally; fail cleanly at connect time, never crash):
 * `secretRef` static credentials (the store isn't wired for them yet) and
 * `prepare` (the gcloud-style pre-connect command). Everything else is implemented.
 *
 * The fail-open parsers live in `./config-parsers`; the public entry points
 * (`parseMcpServers`, `parseConnectorArray`) live in `./config`.
 */

// ---------------------------------------------------------------------------
// Injection types
// ---------------------------------------------------------------------------

export type Injection =
  | { at: 'header'; name: string; valueTemplate: string } // http — IMPLEMENTED (C2)
  | { at: 'env'; name: string; field?: string } // stdio — IMPLEMENTED
  | { at: 'argv'; template: string; field?: string } // stdio — IMPLEMENTED
  | { at: 'file'; path: string; pointerEnv?: string }; // stdio + Materializer (C2.5)

// ---------------------------------------------------------------------------
// Transport types
// ---------------------------------------------------------------------------

export type TransportConfig =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> }; // IMPLEMENTED (C2)

// ---------------------------------------------------------------------------
// Auth / credential types
// ---------------------------------------------------------------------------

/** Inline secret: a plain string token, or a multi-field record (e.g. user+pass). */
export type SecretMaterial = string | Record<string, string>;

export type AuthConfig =
  | {
      kind: 'static';
      /** Inline secret value (string or multi-field record). */
      secret?: SecretMaterial;
      /**
       * Reference to a named credential in the credential store.
       * C2.5 — not yet implemented; throws NotImplementedError at connect time.
       */
      secretRef?: string;
      /** Where to inject the resolved credential. One or many injection targets. */
      inject: Injection | Injection[];
    }
  | { kind: 'oauth' } // C3 — SdkOAuthAdapter + encrypted token store
  | { kind: 'ambient' }; // Wrapped CLI self-authenticates from disk; Sym injects nothing

// ---------------------------------------------------------------------------
// ConnectorConfig — the top-level shape
// ---------------------------------------------------------------------------

/**
 * Service-agnostic connector config. Each entry in `SYM_MCP_SERVERS` is one connector.
 *
 * Replaces the flat Chunk-1 stdio config with a structured shape that
 * separates transport, auth, and injection concerns.
 */
export interface ConnectorConfig {
  /** Logical name — used as the tool-name prefix: `<name>__<toolName>`. */
  name: string;
  /** How to connect to this server. */
  transport: TransportConfig;
  /** How to acquire and inject credentials. Absent ⇒ no auth. */
  auth?: AuthConfig;
  /**
   * Pre-connect command (C2.5 stub). Execution is not yet implemented;
   * presence is noted and will throw NotImplementedError at connect time.
   */
  prepare?: { command: string; args?: string[] };
  /**
   * Owner opt-in: skip the confirm-before-destructive gate for this server's tools.
   * Default: false — all MCP tools require confirmation.
   */
  trust?: boolean;
  /** Optional allowlist of tool names to expose from this server. Stored; enforcement optional. */
  tools?: { allow?: string[] };
}
