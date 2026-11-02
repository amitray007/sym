import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack } from "../lib/pack/load.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const channels = "channels:\n  default: C0EXAMPLE\n";
const manifest = `
owner:
  slackUserId: U0OWNER01
${channels}workers:
  - name: laptop
    kind: t3
    mcpUrl: https://laptop.example.ts.net/mcp
projects:
  - name: example-app
    worker: laptop
    allowedPaths: ["src/**"]
`;

const entry = `
- key: weekday-check
  title: Weekday check
  cron: "0 9 * * 1-5"
  instruction: Look for failing checks on example-app and list each one.
`;

function packWith(schedules?: string, config = manifest): string {
  const dir = mkdtempSync(join(tmpdir(), "sym-pack-sched-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sym.config.yaml"), config);
  if (schedules !== undefined) writeFileSync(join(dir, "schedules.yaml"), schedules);
  return dir;
}

describe("pack schedules.yaml", () => {
  it("loads a good file and fills the channel and the builder mode", () => {
    const [schedule] = loadPack(packWith(entry)).schedules;
    expect(schedule).toEqual({
      key: "weekday-check",
      title: "Weekday check",
      cron: "0 9 * * 1-5",
      channel: "C0EXAMPLE",
      instruction: "Look for failing checks on example-app and list each one.",
      builder: "ask",
    });
  });

  it("keeps an auto-start builder mode and rejects an unknown one", () => {
    expect(loadPack(packWith(`${entry}  builder: auto\n`)).schedules[0]?.builder).toBe("auto");
    expect(() => loadPack(packWith(`${entry}  builder: always\n`))).toThrow(/builder/);
  });

  it("rejects an entry without an instruction, such as an old brief entry", () => {
    const old = entry.replace(
      "  instruction: Look for failing checks on example-app and list each one.\n",
      "  brief:\n    project: example-app\n",
    );
    expect(() => loadPack(packWith(old))).toThrow(/instruction/);
    expect(() => loadPack(packWith(old))).toThrow(/brief/);
  });

  it("keeps a channel set on the entry", () => {
    const text = entry.replace("  cron:", "  channel: C0OTHER01\n  cron:");
    expect(loadPack(packWith(text)).schedules[0]?.channel).toBe("C0OTHER01");
  });

  it("means no schedules without the file or with an empty one", () => {
    expect(loadPack(packWith()).schedules).toEqual([]);
    expect(loadPack(packWith("")).schedules).toEqual([]);
  });

  it("names the file, the entry, and the field for an unknown field", () => {
    const text = entry.replace("  cron:", "  extra: 1\n  cron:");
    expect(() => loadPack(packWith(text))).toThrow(/schedules\.yaml, entry 1 \("weekday-check"\)/);
    expect(() => loadPack(packWith(text))).toThrow(/extra/);
  });

  it("rejects a bad cron", () => {
    expect(() => loadPack(packWith(entry.replace("0 9 * * 1-5", "every day")))).toThrow(/cron/);
  });

  it("rejects a bad key", () => {
    expect(() => loadPack(packWith(entry.replace("weekday-check", "Weekday Check")))).toThrow(
      /key/,
    );
  });

  it("rejects a duplicate key", () => {
    expect(() => loadPack(packWith(entry + entry))).toThrow(/entry 2.*used twice/);
  });

  it("rejects a file that is not a list", () => {
    expect(() => loadPack(packWith("key: x"))).toThrow(/must be a list/);
  });

  it("needs a channel when the manifest has no default", () => {
    const dir = packWith(entry, manifest.replace(channels, ""));
    expect(() => loadPack(dir)).toThrow(/channel/);
  });
});
