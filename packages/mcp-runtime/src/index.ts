// config — schema + parsers
export { parseMcpServers, parseConnectorArray } from './config.js';
export type {
  ConnectorConfig,
  TransportConfig,
  AuthConfig,
  Injection,
  SecretMaterial,
} from './config.js';

// source — config loading from file/env
export { loadConnectorConfigs, configPath } from './source.js';
export type { ConfigSource, LoadedConnectorConfig } from './source.js';

// cli-config — CLI allow/describe overrides
export { loadCliAllow, loadCliDescribe, readConfigFile } from './cli-config.js';

// pool — connection pool, McpDispatcher, helpers
export {
  McpDispatcher,
  initMcpPool,
  getActiveConfigs,
  MCP_TOOL_SEPARATOR,
  parseConnectTimeoutMs,
  _resetPoolForTesting,
} from './pool.js';

// reconcile — live pool reconciliation
export { reconcileConnectors } from './reconcile.js';
export type { ReconcileResult, ConnectorStatus } from './reconcile.js';

// introspect — connector detail/tool/test introspection
export { listConnectorDetails, getConnectorTools, testConnector } from './introspect.js';
export type { ConnectorDetail, ToolInfo, ConnectorTestResult } from './introspect.js';

// composite — CompositeDispatcher fan-out
export { CompositeDispatcher } from './composite.js';

// inject — transport construction + URL validation
export { buildTransport, validateMcpHttpUrl } from './inject.js';

// materialize — secret materialization
export { Materializer, _getActiveDirsForTesting } from './materialize.js';

// oauth-registry — pending-auth registry + OAuth completion
export {
  completeOAuth,
  getPendingAuth,
  registerPendingAuth,
  generateState,
  _resetRegistryForTesting,
} from './oauth-registry.js';

// store — encrypted credential store
export { SqliteCredentialStore, parseEncryptionKey, _resetStoreForTesting } from './store.js';
export type { SecretRef, CredentialStore } from './store.js';

// providers — credential providers
export { makeProvider, NotImplementedError } from './providers/provider.js';
export { StaticProvider } from './providers/static.js';
export { makeOAuthProvider } from './providers/oauth.js';
