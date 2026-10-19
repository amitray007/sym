import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack, PackError, packFromEnv } from "../lib/pack/load.ts";
import { briefGuardrails, isAllowedSlackUser, resolvePackProject } from "../lib/pack/policy.ts";

const FIXTURE = new URL("./fixtures/pack", import.meta.url).pathname;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packWith(manifest: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sym-pack-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sym.config.yaml"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const base = { owner: { slackUserId: "U0OWNER01" } };

describe("loadPack", () => {
  it("loads the fixture with defaults and referenced files", () => {
    const pack = loadPack(FIXTURE);
    expect(pack.config.owner.slackUserId).toBe("U0OWNER01");
    expect(pack.config.projects.map((p) => p.name)).toEqual(["sync-service", "docs-site"]);
    expect(pack.config.projects[1]).toMatchObject({
      defaultBaseBranch: "main",
      prPolicy: "none",
      productionData: "read-only",
    });
    expect(pack.instructions[0]?.content).toContain("short, plain replies");
    expect(pack.playbooks[0]?.path).toBe("playbooks/release-steps.md");
  });

  it("accepts an owner-only pack", () => {
    const pack = loadPack(packWith(base));
    expect(pack.config.workers).toEqual([]);
    expect(pack.config.allowList).toEqual([]);
  });

  it("names the field when a required field is missing", () => {
    expect(() => loadPack(packWith({}))).toThrow(/owner/);
  });

  it("names the field for an unknown worker", () => {
    const manifest = {
      ...base,
      projects: [{ name: "a", worker: "nope", allowedPaths: ["src/**"] }],
    };
    expect(() => loadPack(packWith(manifest))).toThrow(
      /projects\.0\.worker: unknown worker "nope"/,
    );
  });

  it("rejects secret-looking fields at any depth", () => {
    const manifest = {
      ...base,
      workers: [{ name: "w", kind: "t3", mcpUrl: "https://w.example/mcp", apiKey: "x" }],
    };
    expect(() => loadPack(packWith(manifest))).toThrow(/workers\[0\]\.apiKey looks like a secret/);
    expect(() => loadPack(packWith({ ...base, slackBotToken: "x" }))).toThrow(/slackBotToken/);
    expect(() => loadPack(packWith({ ...base, db: { password: "x" } }))).toThrow(/db\.password/);
  });

  it("rejects credentials inside the MCP URL", () => {
    const manifest = {
      ...base,
      workers: [{ name: "w", kind: "t3", mcpUrl: "https://w.example/mcp?auth=abc" }],
    };
    expect(() => loadPack(packWith(manifest))).toThrow(/mcpUrl/);
  });

  it("rejects a missing referenced file with its path", () => {
    const dir = packWith({ ...base, playbooks: ["playbooks/missing.md"] });
    expect(() => loadPack(dir)).toThrow(PackError);
    expect(() => loadPack(dir)).toThrow(/missing\.md: ENOENT/);
  });

  it("rejects a referenced file outside the pack folder", () => {
    const dir = packWith({ ...base, instructions: ["../outside.md"] });
    expect(() => loadPack(dir)).toThrow(/outside the pack folder/);
  });

  it("reports a missing manifest and bad YAML with the path", () => {
    const empty = mkdtempSync(join(tmpdir(), "sym-pack-"));
    dirs.push(empty);
    expect(() => loadPack(empty)).toThrow(/sym\.config\.yaml: ENOENT/);
    writeFileSync(join(empty, "sym.config.yaml"), "{ nope");
    expect(() => loadPack(empty)).toThrow(/is not valid YAML/);
  });
});

describe("packFromEnv", () => {
  it("returns undefined when SYM_PACK_DIR is unset or blank", () => {
    expect(packFromEnv({})).toBeUndefined();
    expect(packFromEnv({ SYM_PACK_DIR: "  " })).toBeUndefined();
  });

  it("loads the pack named by SYM_PACK_DIR", () => {
    expect(packFromEnv({ SYM_PACK_DIR: FIXTURE })?.config.channels?.default).toBe("C0EXAMPLE");
  });
});

describe("pack policy", () => {
  const pack = loadPack(FIXTURE);

  it("resolves a project case-insensitively to its worker project", () => {
    const result = resolvePackProject(pack, " Sync-Service ");
    expect(result.ok && result.workerProject).toBe("sync-service-main");
    expect(result.ok && result.worker.mcpUrl).toBe("https://laptop.example.ts.net/mcp");
    const fallback = resolvePackProject(pack, "docs-site");
    expect(fallback.ok && fallback.workerProject).toBe("docs-site");
  });

  it("refuses a project outside the pack", () => {
    expect(resolvePackProject(pack, "billing")).toEqual({
      ok: false,
      reason: `"billing" is not in the pack's allowed projects.`,
    });
  });

  it("builds guardrails from paths and PR policy", () => {
    const drafting = resolvePackProject(pack, "sync-service");
    const closed = resolvePackProject(pack, "docs-site");
    if (!drafting.ok || !closed.ok) throw new Error("fixture projects missing");
    expect(briefGuardrails(pack, drafting.project)).toEqual([
      "Change only files that match: src/**, test/**.",
      "A draft pull request is allowed. Never mark it ready for review.",
      "Keep production data read-only.",
    ]);
    expect(briefGuardrails(pack, closed.project)[1]).toBe(
      "Do not push and do not open a pull request.",
    );
  });

  it("allows the owner and listed users only", () => {
    expect(isAllowedSlackUser(pack, "U0OWNER01")).toBe(true);
    expect(isAllowedSlackUser(pack, "U0SAM0001")).toBe(true);
    expect(isAllowedSlackUser(pack, "U0STRANGER")).toBe(false);
    const ownerOnly = loadPack(packWith(base));
    expect(isAllowedSlackUser(ownerOnly, "U0OWNER01")).toBe(true);
    expect(isAllowedSlackUser(ownerOnly, "U0SAM0001")).toBe(false);
  });
});
