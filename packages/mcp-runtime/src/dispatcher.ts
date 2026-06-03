/**
 * mcp/dispatcher.ts — Re-export shim for backward compatibility.
 *
 * The dispatcher module has been split into focused sub-modules:
 *   - mcp/pool.ts       — connection pool, McpDispatcher, initMcpPool
 *   - mcp/reconcile.ts  — reconcileConnectors, ConnectorStatus, ReconcileResult
 *   - mcp/introspect.ts — listConnectorDetails, getConnectorTools, testConnector
 *
 * Existing consumers (tests, composite.ts, etc.) that import from
 * `./dispatcher.js` continue to work without changes. New code should prefer
 * importing directly from the specific sub-module.
 */

export {
  McpDispatcher,
  initMcpPool,
  getActiveConfigs,
  MCP_TOOL_SEPARATOR,
  _resetPoolForTesting,
  parseConnectTimeoutMs,
} from './pool.js';

export { reconcileConnectors } from './reconcile.js';
export type { ConnectorStatus, ReconcileResult } from './reconcile.js';

export { listConnectorDetails, getConnectorTools, testConnector } from './introspect.js';
export type { ConnectorDetail, ToolInfo, ConnectorTestResult } from './introspect.js';
