/**
 * admin-client — HTTP client for the agent's loopback admin routes.
 *
 * Used by the `sym` CLI to drive the running agent's admin surface:
 *   POST /admin/reload  — re-read config and reconcile the live connector pool
 *   GET  /admin/status  — inspect the currently-active connectors and tool count
 *
 * The base URL defaults to `http://127.0.0.1:<AGENT_PORT>` (port 3001) and can
 * be overridden via `SYM_ADMIN_URL` for non-standard deployments.
 */

import type {
  ConnectorDetail,
  ConnectorStatus,
  ConnectorTestResult,
  ReconcileResult,
  ToolInfo,
} from '@sym/mcp-runtime';

// Re-export so callers can import these types from here.
export type { ConnectorStatus, ConnectorDetail, ToolInfo, ConnectorTestResult };

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the admin base URL from the environment.
 *
 * Priority:
 *  1. `SYM_ADMIN_URL` — explicit override (useful for remote / non-loopback)
 *  2. `http://127.0.0.1:<AGENT_PORT>` — loopback at the configured port
 *  3. `http://127.0.0.1:3001`         — hardcoded default
 */
function adminBaseUrl(): string {
  const explicit = process.env['SYM_ADMIN_URL'];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const port = process.env['AGENT_PORT'] ?? '3001';
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// Response types (mirror the route handler shapes in server.ts exactly)
// ---------------------------------------------------------------------------

/**
 * Response from `POST /admin/reload`.
 *
 * Extends `ReconcileResult` (which carries `connectors` and `totalTools`) with
 * the source label and resolved path of the config file that was loaded.
 */
export interface ReloadResponse extends ReconcileResult {
  /** Human-readable label for where the config was loaded from (e.g. "file"). */
  source: string;
  /** Resolved filesystem path of the config file. */
  path: string;
}

/**
 * Response from `GET /admin/status`.
 *
 * Read-only snapshot: connector names and total live tool count.
 */
export interface StatusResponse {
  /** Names of the currently active connectors. */
  connectors: string[];
  /** Total number of tools currently served across all healthy connectors. */
  totalTools: number;
}

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

/**
 * POST `<base>/admin/reload` — re-read the config file and reconcile the live
 * connector pool. Returns the per-connector status report.
 *
 * @param baseUrl Override the admin base URL (default: `adminBaseUrl()`).
 * @throws Error with status + body text on a non-OK HTTP response.
 * @throws Error with a friendly "could not reach" message on network failure.
 */
export async function applyReload(baseUrl?: string): Promise<ReloadResponse> {
  const base = baseUrl ?? adminBaseUrl();
  const url = `${base}/admin/reload`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST' });
  } catch (err) {
    throw new Error(`could not reach the Sym admin endpoint at ${url} — is the agent running?`, {
      cause: err,
    });
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`admin reload failed: HTTP ${response.status.toString()} — ${body}`);
  }
  return response.json() as Promise<ReloadResponse>;
}

/**
 * GET `<base>/admin/status` — retrieve the currently active connector set and
 * total live tool count.
 *
 * @param baseUrl Override the admin base URL (default: `adminBaseUrl()`).
 * @throws Error with status + body text on a non-OK HTTP response.
 * @throws Error with a friendly "could not reach" message on network failure.
 */
export async function fetchStatus(baseUrl?: string): Promise<StatusResponse> {
  const base = baseUrl ?? adminBaseUrl();
  const url = `${base}/admin/status`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`could not reach the Sym admin endpoint at ${url} — is the agent running?`, {
      cause: err,
    });
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`admin status failed: HTTP ${response.status.toString()} — ${body}`);
  }
  return response.json() as Promise<StatusResponse>;
}

/** Shared request helper for the richer admin routes (same error semantics). */
async function adminRequest<T>(
  path: string,
  baseUrl: string | undefined,
  init?: RequestInit,
): Promise<T> {
  const base = baseUrl ?? adminBaseUrl();
  const url = `${base}${path}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new Error(`could not reach the Sym admin endpoint at ${url} — is the agent running?`, {
      cause: err,
    });
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`admin request failed: HTTP ${response.status.toString()} — ${body}`);
  }
  return response.json() as Promise<T>;
}

/** GET `/admin/connectors` — per-connector wiring + live health (dashboard rows). */
export async function fetchConnectors(baseUrl?: string): Promise<ConnectorDetail[]> {
  const body = await adminRequest<{ connectors: ConnectorDetail[] }>('/admin/connectors', baseUrl);
  return body.connectors;
}

/** GET `/admin/connectors/:name/tools` — the tools a connector serves. */
export async function fetchConnectorTools(name: string, baseUrl?: string): Promise<ToolInfo[]> {
  const body = await adminRequest<{ tools: ToolInfo[] }>(
    `/admin/connectors/${encodeURIComponent(name)}/tools`,
    baseUrl,
  );
  return body.tools;
}

/** POST `/admin/connectors/:name/test` — re-connect one connector in isolation. */
export async function testConnector(name: string, baseUrl?: string): Promise<ConnectorTestResult> {
  return adminRequest<ConnectorTestResult>(
    `/admin/connectors/${encodeURIComponent(name)}/test`,
    baseUrl,
    { method: 'POST' },
  );
}
