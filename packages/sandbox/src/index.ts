/**
 * `@sym/sandbox` — trust boundary: per-turn sandbox + egress proxy.
 *
 * Pieces:
 * - JWT minter/verifier: sandbox identity tokens (short-lived, HS256).
 * - Lease store: hot in-memory map for O(1) proxy lookup.
 * - Lease issuer: writes leases to Postgres before sandbox spawn.
 * - Egress proxy: Hono service that verifies JWT → resolves credential → injects auth header.
 * - SandboxRunner: mockable interface for Docker+gVisor spawn.
 *
 * Network topology:
 *   sandbox → [egress proxy only] → internet
 *   The sandbox container has no direct internet access; all outbound traffic
 *   routes through the egress proxy. The proxy is the sole point where
 *   real provider credentials are injected. The sandbox never sees tokens.
 *
 * Required new env vars (for S8/.env.example):
 *   SANDBOX_JWT_SECRET  — signing key for sandbox JWTs (min 32 chars, keep secret).
 */

export {
  mintSandboxJwt,
  verifySandboxJwt,
  SandboxJwtError,
  SANDBOX_JWT_TTL_SECONDS,
} from './jwt.js';
export type { SandboxJwtConfig } from './jwt.js';

export { LeaseStore } from './lease-store.js';

export { LeaseIssuer } from './lease-issuer.js';
export type { IssueLeaseParams, IssueLeaseResult } from './lease-issuer.js';

export { createEgressProxy } from './egress-proxy.js';
export type { EgressProxyConfig, EgressAuditRecord } from './egress-proxy.js';

export { DockerSandboxRunner, MockSandboxRunner, SandboxRunnerError } from './runner.js';
export type { SandboxRunner, SpawnParams, SpawnResult } from './runner.js';
