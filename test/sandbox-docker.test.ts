import { randomUUID } from "node:crypto";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { afterAll, describe, expect, it } from "vitest";
import { sandboxDisk } from "../lib/sandbox/config.ts";
import { createDockerCli, dockerLifecycle } from "../lib/sandbox/docker.ts";

// Sym's Docker provider against a real Docker daemon (decision 089). Opt-in, because it needs
// Docker and pulls Eve's sandbox image the first time:
//   SYM_SANDBOX_DOCKER_TEST=1 pnpm exec vitest run test/sandbox-docker.test.ts

const enabled = process.env.SYM_SANDBOX_DOCKER_TEST === "1";

const ctx: SandboxSessionContext = {
  session: { id: `sym-test-${randomUUID()}` } as SandboxSessionContext["session"],
  kind: "session",
  storagePath: "/tmp",
  resolveProjectPath: (path) => path,
};

const lifecycle = dockerLifecycle({}, createDockerCli());
const cli = createDockerCli();

async function run(
  connection: Awaited<ReturnType<typeof lifecycle.start>>["connection"],
  command: string,
) {
  const process = await connection.spawn({
    command,
    env: { AI_AGENT: "eve" },
    workingDirectory: "/workspace",
  });
  const [stdout, stderr, { exitCode }] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.wait(),
  ]);
  return { stdout, stderr, exitCode };
}

describe.skipIf(!enabled)("Sym's Docker sandbox on a real daemon", () => {
  const idleCtx = { ...ctx, session: { ...ctx.session, id: `${ctx.session.id}-idle` } };
  const idle = dockerLifecycle({ idleSeconds: 1 }, cli);

  afterAll(async () => {
    await lifecycle.onSessionEnd(ctx, null, { reason: "completed" });
    await idle.onSessionEnd(idleCtx, null, { reason: "completed" });
  });

  it("runs bash, keeps files, and holds no secrets, network, or root", async () => {
    const { connection } = await lifecycle.start(ctx, undefined, { version: 1, resources: null });

    const echo = await run(connection, "echo hello from the sandbox");
    expect(echo).toEqual({ stdout: "hello from the sandbox\n", stderr: "", exitCode: 0 });

    await connection.writeFiles({
      files: [{ path: "/workspace/data/n.txt", content: new TextEncoder().encode("2\n3\n") }],
    });
    const sum = await run(connection, "awk '{s+=$1} END {print s}' data/n.txt");
    expect(sum.stdout).toBe("5\n");
    const read = await connection.readFile({ path: "/workspace/data/n.txt" });
    expect(new TextDecoder().decode(read as Uint8Array)).toBe("2\n3\n");
    expect(await connection.readFile({ path: "/workspace/missing.txt" })).toBeNull();

    const env = await run(connection, "env");
    expect(env.stdout).toContain("AI_AGENT=eve");
    expect(env.stdout).not.toMatch(/TOKEN|SECRET|API_KEY|DATABASE_URL/);

    // No route out, so no network.
    const routes = await run(connection, "tail -n +2 /proc/net/route");
    expect(routes.stdout.trim()).toBe("");
    const curl = await run(connection, "curl -sS --max-time 5 https://example.com");
    expect(curl.exitCode).not.toBe(0);

    const sudo = await run(connection, "sudo -n true");
    expect(sudo.exitCode).not.toBe(0);

    // The image's own files are read-only, and the activity file is root's.
    expect((await run(connection, "touch /usr/local/x")).exitCode).not.toBe(0);
    expect((await run(connection, "touch -d 2099-01-01 /run/sym/active")).exitCode).not.toBe(0);
  }, 300_000);

  it("bounds disk, reads, and output", async () => {
    const { connection } = await lifecycle.start(ctx, undefined, { version: 1, resources: null });
    const workspaceMb = sandboxDisk().fileBytes / 1024 ** 2;
    // A file larger than the workspace fails inside the sandbox; the host disk is never touched.
    const big = await run(
      connection,
      `dd if=/dev/zero of=big bs=1M count=${workspaceMb + 64} 2>&1; echo "exit $?"`,
    );
    expect(big.stdout).toMatch(/exit [1-9]/);
    expect(big.stdout).toMatch(/File size limit exceeded|No space left/);
    expect((await run(connection, "rm -f big")).exitCode).toBe(0);

    await expect(connection.readFile({ path: "/dev/zero" })).rejects.toThrow(/not a regular file/);
    await run(connection, "head -c 40000000 /dev/zero > large.bin");
    await expect(connection.readFile({ path: "/workspace/large.bin" })).rejects.toThrow(/larger/);
    await run(connection, "rm -f large.bin");

    const flood = await run(connection, "cat /dev/zero");
    expect(flood.stdout).toContain("Sym stopped the command");
    expect(flood.stdout.length).toBeLessThan(9 * 1024 ** 2);
    // The sandbox still works after the flood was stopped.
    expect((await run(connection, "echo still here")).stdout).toBe("still here\n");
  }, 300_000);

  it("removes an idle container, and resume then reports it gone", async () => {
    const artifact = { version: 1 as const, resources: null };
    const { connection, state } = await idle.start(idleCtx, undefined, artifact);
    expect((await run(connection, "echo kept > kept.txt")).exitCode).toBe(0);
    const gone = async () =>
      (await cli.run(["container", "inspect", state.container])).exitCode !== 0;
    const deadline = Date.now() + 60_000;
    while (!(await gone())) {
      if (Date.now() > deadline) throw new Error("the idle container was not removed");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await expect(idle.resume(idleCtx, artifact, state)).rejects.toThrow(/gone/);
  }, 120_000);
});
