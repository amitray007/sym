/**
 * The full Sym schema — the lingua franca every stream reads/writes through.
 * Drizzle-kit reads this barrel; the migrator and client import it too.
 * Grouped by domain to match docs/db-schema-draft.md.
 */

// Identity
export * from './workspaces.js';
export * from './admins.js';

// Configuration
export * from './config.js';

// Voice
export * from './soul.js';

// Memory
export * from './memory.js';

// Per-user auth
export * from './oauth.js';

// Runtime conversation
export * from './runtime.js';

// Runtime queue
export * from './queue.js';

// Audit
export * from './audit.js';

// Sandbox
export * from './leases.js';
