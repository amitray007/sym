import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { afterAll, describe, expect, it } from "vitest";
import {
  bounded,
  capStream,
  containerName,
  type DockerCli,
  type DockerResult,
  dockerConnection,
  dockerLifecycle,
  reapIdleSandboxes,
} from "../lib/sandbox/docker.ts";

// Sym's Docker provider lifecycle (decision 089) against a fake Docker that keeps containers by
// ID and name: setup that fails part way, a half-set-up container, concurrent starts, a slow
// setup another caller must not replace, resume, root images, the idle reaper, and the caps on
// what Sym reads back.

const ok = (stdout = ""): DockerResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutBytes: new TextEncoder().encode(stdout),
});
const failed = (stderr: string, exitCode = 1): DockerResult => ({
  exitCode,
  stdout: "",
  stderr,
  stdoutBytes: new Uint8Array(),
});

interface Box {
  id: string;
  name: string;
  ready: boolean;
  created: number;
  // Seconds since the epoch of Sym's last touch, or undefined before the first.
  active?: number;
}

// A fake Docker daemon. Each container has an ID and a name; exec and rm take either.
function fakeDocker(
  options: { failWrites?: number; user?: string; writeDelayMs?: number; now?: () => number } = {},
) {
  const boxes = new Map<string, Box>();
  const calls: string[][] = [];
  let failWrites = options.failWrites ?? 0;
  let next = 1;
  const now = options.now ?? Date.now;
  const find = (ref: string) => boxes.get(ref) ?? [...boxes.values()].find((b) => b.name === ref);
  const add = (name: string, extra: Partial<Box> = {}) => {
    const box: Box = { id: `c${next++}`, name, ready: false, created: now(), ...extra };
    boxes.set(box.id, box);
    return box;
  };
  const cli: DockerCli = {
    async run(args) {
      calls.push(args);
      switch (args[0]) {
        case "version":
          return ok("29.0.0");
        case "container": {
          const box = find(args.at(-1) ?? "");
          if (!box) return failed("Error: No such container");
          return ok(`${box.id} true ${new Date(box.created).toISOString()}`);
        }
        case "run": {
          const name = args[args.indexOf("--name") + 1] ?? "";
          // Let a concurrent caller run while this one is between calls.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (find(name)) return failed("Conflict. The container name is already in use");
          return ok(add(name).id);
        }
        case "rm": {
          const box = find(args.at(-1) ?? "");
          if (box) boxes.delete(box.id);
          return ok();
        }
        case "ps":
          return ok([...boxes.keys()].join("\n"));
        case "exec": {
          const ref = args[args[1] === "--user" ? 3 : args[1] === "--interactive" ? 2 : 1] ?? "";
          const box = find(ref);
          if (!box) return failed("Error: No such container");
          if (args.includes("id") && args.includes("-u")) return ok(`${options.user ?? "1000"}\n`);
          if (args.includes("stat") && args.includes("/run/sym/active")) {
            return box.active === undefined ? failed("No such file") : ok(String(box.active));
          }
          if (args.includes("test") && args.includes("/run/sym/ready")) {
            return box.ready ? ok() : failed("", 1);
          }
          if (args.includes("touch") && args.includes("/run/sym/active")) {
            box.active = Math.floor(now() / 1000);
          }
          if (args.includes("touch") && args.includes("/run/sym/ready")) box.ready = true;
          if (args.includes("sym-write")) {
            if (options.writeDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, options.writeDelayMs));
            }
            if (failWrites > 0) {
              failWrites--;
              return failed("write failed: broken pipe");
            }
          }
          return ok();
        }
        default:
          return ok();
      }
    },
    stream() {
      throw new Error("not used");
    },
  };
  return { cli, calls, boxes, add, find };
}

const resources = mkdtempSync(join(tmpdir(), "sym-sandbox-resources-"));
mkdirSync(join(resources, "sym-docker", "skills", "notes"), { recursive: true });
writeFileSync(join(resources, "sym-docker", "skills", "notes", "SKILL.md"), "# Notes\n");

afterAll(() => rmSync(resources, { recursive: true, force: true }));

const ctx = (id = "session-1"): SandboxSessionContext => ({
  session: { id } as SandboxSessionContext["session"],
  kind: "session",
  storagePath: resources,
  resolveProjectPath: (path) => path,
});
const withSkills = { version: 1 as const, resources: "sym-docker" };
const plain = { version: 1 as const, resources: null };
const runs = (calls: string[][]) => calls.filter((args) => args[0] === "run").length;
const NAME = containerName("session-1");

describe("Sym's Docker provider lifecycle", () => {
  it("sets up a new container, copies skill files, and marks it ready", async () => {
    const docker = fakeDocker();
    const { state } = await dockerLifecycle({}, docker.cli).start(ctx(), undefined, withSkills);
    expect(state).toEqual({ version: 2, container: "c1" });
    expect(docker.find(NAME)?.ready).toBe(true);
    expect(docker.calls).toContainEqual(
      expect.arrayContaining(["sym-write", "/tmp/home/.agents/skills/notes/SKILL.md"]),
    );
  });

  it("refuses an image whose user is root", async () => {
    const docker = fakeDocker({ user: "0" });
    await expect(
      dockerLifecycle({ image: "example/root" }, docker.cli).start(ctx(), undefined, plain),
    ).rejects.toThrow(/runs commands as root/);
    expect(docker.boxes.size).toBe(0);
  });

  it("removes a container whose setup failed, by ID, and sets up a fresh one next time", async () => {
    const docker = fakeDocker({ failWrites: 1 });
    const lifecycle = dockerLifecycle({}, docker.cli);
    await expect(lifecycle.start(ctx(), undefined, withSkills)).rejects.toThrow(/broken pipe/);
    expect(docker.boxes.size).toBe(0);
    expect(docker.calls).toContainEqual(["rm", "--force", "c1"]);

    await lifecycle.start(ctx(), undefined, withSkills);
    expect(docker.find(NAME)).toMatchObject({ id: "c2", ready: true });
    expect(runs(docker.calls)).toBe(2);
  });

  it("replaces a half-set-up container once its setup time has passed", async () => {
    const docker = fakeDocker();
    docker.add(NAME, { created: Date.now() - 60_000 });
    await dockerLifecycle({}, docker.cli, { setupMs: 50 }).start(ctx(), undefined, plain);
    expect(docker.calls).toContainEqual(["rm", "--force", "c1"]);
    expect(docker.find(NAME)).toMatchObject({ id: "c2", ready: true });
  });

  it("gives concurrent starts one container, set up once", async () => {
    const docker = fakeDocker();
    const lifecycle = dockerLifecycle({}, docker.cli);
    const [a, b] = await Promise.all([
      lifecycle.start(ctx(), undefined, withSkills),
      lifecycle.start(ctx(), undefined, withSkills),
    ]);
    expect(a.state).toEqual(b.state);
    expect(runs(docker.calls)).toBe(1);
  });

  it("lets another process finish a slow setup instead of replacing it", async () => {
    // Process A's setup is slow; process B, with its own lifecycle, starts the same session.
    const docker = fakeDocker({ writeDelayMs: 150 });
    const a = dockerLifecycle({}, docker.cli, { setupMs: 2000 });
    const b = dockerLifecycle({}, docker.cli, { setupMs: 2000 });
    const first = a.start(ctx(), undefined, withSkills);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const [fromA, fromB] = await Promise.all([first, b.start(ctx(), undefined, withSkills)]);
    expect(fromA.state).toEqual(fromB.state);
    expect(runs(docker.calls)).toBe(1);
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("removes only its own container when a setup runs out of time", async () => {
    const docker = fakeDocker({ writeDelayMs: 200 });
    const a = dockerLifecycle({}, docker.cli, { setupMs: 50 });
    await expect(a.start(ctx(), undefined, withSkills)).rejects.toThrow(/took too long/);
    // A newer container under the same name, from another caller, survives A's cleanup.
    const newer = docker.add(NAME, { ready: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(docker.boxes.has(newer.id)).toBe(true);
    expect(docker.calls.filter((args) => args[0] === "rm")).toEqual([["rm", "--force", "c1"]]);
  });

  it("resumes a ready container and resets its idle clock as root", async () => {
    const docker = fakeDocker();
    const lifecycle = dockerLifecycle({}, docker.cli);
    const { state } = await lifecycle.start(ctx(), undefined, plain);
    docker.calls.length = 0;
    await lifecycle.resume(ctx(), plain, state);
    expect(docker.calls).toContainEqual([
      "exec",
      "--user",
      "root",
      state.container,
      ...bounded(55, ["touch", "/run/sym/active"]),
    ]);
  });

  it("reports a removed, replaced, or half-set-up container as gone, with its files", async () => {
    const docker = fakeDocker();
    const lifecycle = dockerLifecycle({}, docker.cli);
    const state = { version: 2 as const, container: "c9" };
    await expect(lifecycle.resume(ctx(), plain, state)).rejects.toThrow(/gone, with its files/);
    const half = docker.add(NAME);
    await expect(
      lifecycle.resume(ctx(), plain, { version: 2, container: half.id }),
    ).rejects.toThrow(/gone/);
    expect(docker.boxes.size).toBe(0);
  });
});

describe("the idle reaper", () => {
  it("removes containers Sym has not touched within the idle limit, and keeps the rest", async () => {
    const clock = { now: Date.UTC(2026, 10, 3, 12) };
    const docker = fakeDocker({ now: () => clock.now });
    const seconds = Math.floor(clock.now / 1000);
    const idle = docker.add("sym-sbx-idle", { active: seconds - 31 * 60 });
    const busy = docker.add("sym-sbx-busy", { active: seconds - 60 });
    // Never touched (setup crashed early): its creation time counts.
    const old = docker.add("sym-sbx-old", { created: clock.now - 40 * 60_000 });
    const removed = await reapIdleSandboxes(docker.cli, 30 * 60, clock.now);
    expect(removed.sort()).toEqual([idle.id, old.id].sort());
    expect(docker.boxes.has(busy.id)).toBe(true);
    // It reads the root-owned activity file, so a command cannot hold the container open.
    expect(docker.calls).toContainEqual(
      expect.arrayContaining(["--user", "root", "stat", "/run/sym/active"]),
    );
  });

  it("does nothing when Docker is unreachable", async () => {
    const cli: DockerCli = {
      run: async () => failed("Cannot connect to the Docker daemon"),
      stream() {
        throw new Error("not used");
      },
    };
    expect(await reapIdleSandboxes(cli)).toEqual([]);
  });
});

describe("what Sym reads back from a sandbox", () => {
  it("refuses a file that is not regular or is too large", async () => {
    const answer = (args: string[]): DockerResult =>
      args.includes("/dev/zero")
        ? failed("it is not a regular file", 44)
        : { ...ok(), killed: "overflow" };
    const calls: { args: string[]; maxBytes?: number }[] = [];
    const cli: DockerCli = {
      async run(args, options) {
        calls.push({ args, ...(options?.maxBytes ? { maxBytes: options.maxBytes } : {}) });
        return answer(args);
      },
      stream() {
        throw new Error("not used");
      },
    };
    const connection = dockerConnection(cli, "sym-sbx-a", { readBytes: 1000 });
    await expect(connection.readFile({ path: "/dev/zero" })).rejects.toThrow(/not a regular file/);
    await expect(connection.readFile({ path: "/workspace/big" })).rejects.toThrow(
      /larger than 1000 bytes/,
    );
    const read = calls.find((call) => call.args.includes("sym-read"));
    expect(read?.maxBytes).toBe(1000);
    expect(read?.args.at(-1)).toBe("1000");
  });

  it("stops a command whose output passes the cap", async () => {
    let killed = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(400).fill(65));
      },
    });
    const text = await new Response(capStream(source, 1000, () => killed++)).text();
    expect(text.startsWith("A".repeat(1000))).toBe(true);
    expect(text).toContain("Sym stopped the command: output passed 1000 bytes");
    expect(killed).toBe(1);
  });

  it("caps a spawned command's stdout and kills it", async () => {
    const calls: string[][] = [];
    let streamKilled = false;
    const cli: DockerCli = {
      async run(args) {
        calls.push(args);
        return ok();
      },
      stream() {
        return {
          stdout: new ReadableStream({
            pull: (controller) => controller.enqueue(new Uint8Array(512).fill(66)),
          }),
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
          wait: async () => ({ exitCode: 137 }),
          kill: async () => {
            streamKilled = true;
          },
        };
      },
    };
    const child = await dockerConnection(cli, "sym-sbx-a", { outputBytes: 2048 }).spawn({
      command: "cat /dev/zero",
      env: {},
      workingDirectory: "/workspace",
    });
    const out = await new Response(child.stdout).text();
    expect(out.length).toBeLessThan(2200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(streamKilled).toBe(true);
    expect(calls.some((args) => args.includes("sym-kill"))).toBe(true);
  });
});
