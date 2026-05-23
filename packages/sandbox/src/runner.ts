/**
 * SandboxRunner — mockable interface for spawning sandbox containers.
 *
 * Production: DockerSandboxRunner spawns Docker+gVisor containers.
 * Tests: use MockSandboxRunner or a plain object satisfying the interface.
 *
 * NEVER execute Docker in tests — CI/worktrees have no gVisor. The
 * SandboxRunner interface is the seam; inject a mock.
 *
 * Network topology (enforced by Docker, not this code):
 * - Sandbox container: --network=none (or a dedicated bridge to proxy only).
 * - Egress proxy: the only routable target from the sandbox network.
 * - Internet: reachable ONLY via the egress proxy.
 *
 * Sandbox JWT placement:
 * - SANDBOX_JWT is set in the container env (never written to disk or CLI args).
 * - EGRESS_PROXY_URL is set so the sandbox knows where to route requests.
 * - Real provider tokens are NEVER in the env — they stay in the proxy.
 *
 * gVisor (runsc) runtime note:
 * - All containers use --runtime=runsc for kernel-level isolation.
 * - Capabilities are dropped (--cap-drop=ALL) and not restored.
 * - The sandbox runs as a non-root user when the image supports it.
 *
 * Required Docker args summary:
 *   docker run
 *     --runtime=runsc           ← gVisor
 *     --network=<proxy-net>     ← sandbox-only network; no direct internet
 *     --cap-drop=ALL            ← drop all Linux capabilities
 *     --read-only               ← immutable rootfs (tmp via tmpfs)
 *     --tmpfs /tmp:size=256m    ← writable scratch space
 *     --env SANDBOX_JWT=<jwt>   ← injected identity (no real token)
 *     --env EGRESS_PROXY_URL=<url>
 *     --rm                      ← auto-remove on exit
 *     <image>
 *     <command...>
 */

import { spawn } from 'node:child_process';

import type { SandboxIdentity } from '@sym/contracts';

export interface SpawnParams {
  /** Docker image to run. */
  image: string;
  /** Command and arguments to run inside the container. */
  command: string[];
  /** The minted sandbox JWT (placed in SANDBOX_JWT env var). */
  sandboxJwt: string;
  /** URL of the egress proxy the sandbox should route traffic through. */
  egressProxyUrl: string;
  /** Additional non-secret env vars (e.g. GIT_AUTHOR_NAME, placeholder tokens). */
  extraEnv?: Record<string, string>;
  /** Timeout in ms before the container is force-killed. Default: 5 minutes. */
  timeoutMs?: number;
  /** The sandbox identity (for logging/audit; never logged with token values). */
  identity: SandboxIdentity;
}

export interface SpawnResult {
  /** Exit code of the container process. 0 = success. */
  exitCode: number;
  /** Combined stdout output (truncated to a safe limit). */
  stdout: string;
  /** Combined stderr output (truncated to a safe limit). */
  stderr: string;
}

/** The seam between the sandbox orchestration and the Docker runtime. */
export interface SandboxRunner {
  spawn(params: SpawnParams): Promise<SpawnResult>;
}

/** Reasonable output size limit to avoid memory pressure. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Production Docker+gVisor runner. Uses `docker run` with --runtime=runsc.
 *
 * DO NOT use in tests. Inject a MockSandboxRunner or SandboxRunner stub instead.
 */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(
    private readonly options: {
      /** Docker network name that connects sandbox to the proxy. */
      networkName: string;
      /** Docker image pull policy (default: 'if-not-present'). */
      pullPolicy?: 'always' | 'if-not-present' | 'never';
    },
  ) {}

  async spawn(params: SpawnParams): Promise<SpawnResult> {
    const timeout = params.timeoutMs ?? 5 * 60 * 1000;

    const dockerArgs: string[] = [
      'run',
      '--rm',
      '--runtime=runsc',
      `--network=${this.options.networkName}`,
      '--cap-drop=ALL',
      '--read-only',
      '--tmpfs',
      '/tmp:size=256m',
      '--env',
      `SANDBOX_JWT=${params.sandboxJwt}`,
      '--env',
      `EGRESS_PROXY_URL=${params.egressProxyUrl}`,
    ];

    for (const [key, value] of Object.entries(params.extraEnv ?? {})) {
      dockerArgs.push('--env', `${key}=${value}`);
    }

    if (this.options.pullPolicy === 'never') {
      dockerArgs.push('--pull=never');
    } else if (this.options.pullPolicy === 'always') {
      dockerArgs.push('--pull=always');
    }

    dockerArgs.push(params.image);
    dockerArgs.push(...params.command);

    return new Promise<SpawnResult>((resolve, reject) => {
      const proc = spawn('docker', dockerArgs, {
        // Inherit no real env — pass only what we explicitly set above
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
          stdoutBuf += chunk.toString('utf8');
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBuf.length < MAX_OUTPUT_BYTES) {
          stderrBuf += chunk.toString('utf8');
        }
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new SandboxRunnerError(`Sandbox timed out after ${timeout}ms`, 'timeout'));
      }, timeout);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new SandboxRunnerError(`Failed to spawn docker: ${err.message}`, 'spawn_failed', {
            cause: err,
          }),
        );
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      });
    });
  }
}

export class SandboxRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: 'spawn_failed' | 'timeout',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SandboxRunnerError';
  }
}

/**
 * Mock runner for tests. Records spawn calls and returns a configurable result.
 * Never executes Docker.
 */
export class MockSandboxRunner implements SandboxRunner {
  readonly calls: SpawnParams[] = [];
  private readonly result: SpawnResult;

  constructor(result: SpawnResult = { exitCode: 0, stdout: '', stderr: '' }) {
    this.result = result;
  }

  async spawn(params: SpawnParams): Promise<SpawnResult> {
    this.calls.push(params);
    return { ...this.result };
  }
}
