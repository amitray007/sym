import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackError } from "../lib/pack/load.ts";
import { applyPackOverlay, skillMarkdown } from "../lib/pack/overlay.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/pack");
let app: string;

beforeEach(() => {
  app = mkdtempSync(join(tmpdir(), "sym-overlay-"));
  mkdirSync(join(app, "agent"));
  writeFileSync(join(app, "agent/instructions.md"), "core\n");
});
afterEach(() => rmSync(app, { recursive: true, force: true }));

describe("applyPackOverlay", () => {
  it("adds instructions and playbooks and keeps the core file", () => {
    const result = applyPackOverlay(FIXTURE, app);
    expect(result.instructions).toEqual(["agent/instructions/tone.md"]);
    expect(result.skills).toEqual(["agent/skills/release-steps.md"]);
    expect(readFileSync(join(app, "agent/instructions.md"), "utf8")).toBe("core\n");
    expect(readFileSync(join(app, "agent/instructions/tone.md"), "utf8")).toContain("short, plain");
    expect(readFileSync(join(app, "agent/skills/release-steps.md"), "utf8")).toContain(
      "description: Steps to cut",
    );
  });

  it("replaces a built-in skill with the same name", () => {
    mkdirSync(join(app, "agent/skills/release-steps"), { recursive: true });
    writeFileSync(join(app, "agent/skills/release-steps/SKILL.md"), "built-in");
    const result = applyPackOverlay(FIXTURE, app);
    expect(result.replacedSkills).toEqual(["release-steps"]);
    expect(existsSync(join(app, "agent/skills/release-steps"))).toBe(false);
    expect(existsSync(join(app, "agent/skills/release-steps.md"))).toBe(true);
  });

  it("refuses to overwrite an existing instruction file", () => {
    mkdirSync(join(app, "agent/instructions"));
    writeFileSync(join(app, "agent/instructions/tone.md"), "built-in");
    expect(() => applyPackOverlay(FIXTURE, app)).toThrow(/Refusing to overwrite/);
    expect(readFileSync(join(app, "agent/instructions/tone.md"), "utf8")).toBe("built-in");
  });

  it("refuses a folder that is not the Sym app", () => {
    rmSync(join(app, "agent/instructions.md"));
    expect(() => applyPackOverlay(FIXTURE, app)).toThrow(PackError);
  });

  it("rejects an invalid pack before it writes", () => {
    const bad = mkdtempSync(join(tmpdir(), "sym-badpack-"));
    writeFileSync(join(bad, "sym.config.yaml"), "unknown: true\n");
    try {
      expect(() => applyPackOverlay(bad, app)).toThrow(PackError);
      expect(existsSync(join(app, "agent/instructions"))).toBe(false);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});

describe("skillMarkdown", () => {
  it("adds a description from the first line when frontmatter is missing", () => {
    expect(skillMarkdown("x", "# Do the thing\n\nbody\n")).toBe(
      '---\ndescription: "Do the thing"\n---\n\n# Do the thing\n\nbody\n',
    );
  });

  it("keeps a playbook that already has a description", () => {
    const text = "---\ndescription: Mine.\n---\nbody\n";
    expect(skillMarkdown("x", text)).toBe(text);
  });

  it("adds a description inside frontmatter that lacks one", () => {
    expect(skillMarkdown("x", "---\ndeferred: true\n---\nHello\n")).toBe(
      '---\ndescription: "Hello"\ndeferred: true\n---\nHello\n',
    );
  });
});
