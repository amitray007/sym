/**
 * OpenTelemetry wiring for the audit subsystem.
 *
 * The tracer and meter are obtained from the OTel API's global provider.
 * By default (when no SDK is installed) the global provider is the no-op
 * provider — spans and metrics are collected but never exported.  The host
 * application (agent / dashboard) configures and installs a real provider
 * (OTLP exporter) before loading this package.
 *
 * Environment variable:
 *   SYM_OTEL_EXPORTER_ENDPOINT — when set, signals to the host that an OTLP
 *   exporter should be pointed at this URL.  This package does NOT read the
 *   variable itself — it is documented here for .env.example / ops reference.
 *   The host application owns SDK setup.
 *
 * Semantic keys: aligned with specs/logging/semantics.md.  `app.audit.*`
 * namespace is used for Sym-specific fields that have no OTel semantic key.
 */

import { metrics, trace } from '@opentelemetry/api';

/** The instrumentation scope name for all audit spans / metrics. */
export const AUDIT_SCOPE = '@sym/audit';

/** Tracer scoped to the audit subsystem.  No-op until an SDK is installed. */
export const tracer = trace.getTracer(AUDIT_SCOPE, '0.0.0');

/** Meter scoped to the audit subsystem.  No-op until an SDK is installed. */
export const meter = metrics.getMeter(AUDIT_SCOPE, '0.0.0');

// ---------------------------------------------------------------------------
// Semantic attribute key constants
// Sourced from specs/logging/semantics.md — use OTel-standard names where they
// exist, fall back to `app.audit.*` for Sym-specific fields.
// ---------------------------------------------------------------------------

/** The workspace this audit event belongs to. */
export const ATTR_WORKSPACE_ID = 'app.audit.workspace_id' as const;

/** The `kind` column — open-namespace event kind, e.g. `app.memory.write`. */
export const ATTR_AUDIT_KIND = 'app.audit.kind' as const;

/** Actor kind: `slack_user | admin | system | sandbox`. */
export const ATTR_ACTOR_KIND = 'app.audit.actor_kind' as const;

/** Actor id (slack user id, clerk id, `'system'`, jti, etc.). */
export const ATTR_ACTOR_ID = 'app.audit.actor_id' as const;

/** The target kind when present (e.g. `memory`, `tool`, `lease`). */
export const ATTR_TARGET_KIND = 'app.audit.target_kind' as const;

/** The target id when present. */
export const ATTR_TARGET_ID = 'app.audit.target_id' as const;

/**
 * Whether the hash chain link was valid for a given audit event during
 * verification.
 */
export const ATTR_CHAIN_VALID = 'app.audit.chain_valid' as const;

/** The bigserial id of the audit event row. */
export const ATTR_AUDIT_EVENT_ID = 'app.audit.event_id' as const;

// OTel standard keys reused directly (no aliasing needed — keep names clear)

/** enduser.id — the requester / actor Slack user id when applicable. */
export const ATTR_ENDUSER_ID = 'enduser.id' as const;

/** messaging.system = "slack" for Slack-sourced events. */
export const ATTR_MESSAGING_SYSTEM = 'messaging.system' as const;

/** error.type — low-cardinality error class. */
export const ATTR_ERROR_TYPE = 'error.type' as const;

// ---------------------------------------------------------------------------
// Pre-built counters / histograms
// These are lazily created the first time they're referenced, matching the
// OTel API's own lazy semantics.  They're no-op until an SDK is configured.
// ---------------------------------------------------------------------------

/** Counter: total audit events appended. Labels: workspace_id, kind. */
export const appendCounter = meter.createCounter('audit.append.count', {
  description: 'Total number of audit events appended to the hash chain.',
});

/** Histogram: payload size in bytes per append. */
export const payloadSizeHistogram = meter.createHistogram('audit.payload.bytes', {
  description: 'Size of the audit event payload_json in bytes at append time.',
  unit: 'By',
});

/** Counter: hash-chain verification failures detected. */
export const chainBreakCounter = meter.createCounter('audit.chain.break.count', {
  description: 'Number of hash-chain integrity breaks detected by verifyChain.',
});
