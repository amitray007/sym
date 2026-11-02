import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDockerCli } from "../lib/sandbox/docker.ts";

// The docker CLI wrapper Sym's sandbox uses (decision 089), driven against small scripts that
// stand in for `docker` through EVE_DOCKER_PATH. An early exit, a flood of output, a stall, and
// a cancel each settle the call; none of them may crash Sym's process.

const dir = mkdtempSync(join(tmpdir(), "sym-fake-docker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function fakeDocker(name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  vi.stubEnv("EVE_DOCKER_PATH", path);
}

// More than a pipe buffer, so writing it to a process that exits early breaks the pipe.
const LARGE = new Uint8Array(8 * 1024 * 1024).fill(120);

describe("the docker CLI wrapper", () => {
  it("settles a write whose docker exits early as a failure, with no crash", async () => {
    fakeDocker("early-exit", 'echo "container is not running" >&2; exit 3');
    const result = await createDockerCli().run(["exec", "-i", "x", "cat"], { stdin: LARGE });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("container is not running");
  });

  it("survives a streamed stdin that breaks", async () => {
    fakeDocker("early-exit-stream", "exit 4");
    const child = createDockerCli().stream(["exec", "-i", "x", "cat"], { stdin: true });
    const writer = child.stdin?.getWriter();
    const wrote = writer?.write(LARGE).then(
      () => "written",
      () => "refused",
    );
    expect(await child.wait()).toEqual({ exitCode: 4 });
    expect(["written", "refused"]).toContain(await wrote);
  });

  it("stops a call whose output passes the cap", async () => {
    fakeDocker("flood", "yes");
    const result = await createDockerCli().run(["exec", "x", "cat", "/dev/zero"], {
      maxBytes: 4096,
    });
    expect(result.killed).toBe("overflow");
    expect(result.stdoutBytes.byteLength).toBeLessThanOrEqual(4096);
  });

  it("stops a call that runs past its timeout", async () => {
    fakeDocker("stall", "sleep 10");
    const started = Date.now();
    const result = await createDockerCli().run(["exec", "x", "cat", "fifo"], { timeoutMs: 200 });
    expect(result.killed).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects a cancelled call and stops the process", async () => {
    fakeDocker("cancel", "sleep 10");
    const controller = new AbortController();
    const call = createDockerCli().run(["exec", "x", "sleep"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(call).rejects.toThrow(/abort/i);
  });

  it("says Docker is not installed when the binary is missing", async () => {
    vi.stubEnv("EVE_DOCKER_PATH", join(dir, "missing-docker"));
    await expect(createDockerCli().run(["version"])).rejects.toThrow(/not installed/);
  });
});
