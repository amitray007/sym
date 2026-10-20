import { describe, expect, it } from "vitest";
import type { OutputContract } from "../lib/jobs/contract.ts";
import { checkResult, matchesGlob, repoPath } from "../lib/jobs/verify.ts";

const contract = (extra: Partial<OutputContract> = {}): OutputContract => ({
  summary: "Added retry",
  prUrl: null,
  tests: "12 passed",
  filesChanged: ["src/sync.ts", "test/sync.test.ts"],
  openQuestions: [],
  ...extra,
});

describe("matchesGlob", () => {
  it.each([
    ["src/sync.ts", "src/**", true],
    ["src/deep/a/b.ts", "src/**", true],
    ["src/a.ts", "src/**/a.ts", true],
    ["src/x/a.ts", "src/**/a.ts", true],
    ["src/a.ts", "src/*.ts", true],
    ["src/x/a.ts", "src/*.ts", false],
    ["./src/a.ts", "src/**", true],
    ["config/prod.yml", "src/**", false],
    ["docs/a.md", "docs/?.md", true],
    ["docs/ab.md", "docs/?.md", false],
    ["src.ts", "src/**", false],
  ])("%s against %s is %s", (path, pattern, expected) => {
    expect(matchesGlob(path, pattern)).toBe(expected);
  });
});

describe("checkResult", () => {
  it("passes a result inside the rules", () => {
    expect(
      checkResult(contract(), { allowedPaths: ["src/**", "test/**"], pullRequestAllowed: false }),
    ).toEqual({ verdict: "pass", concerns: [] });
  });

  it("flags a missing result block", () => {
    expect(checkResult(null, { pullRequestAllowed: true }).concerns).toEqual([
      "worker did not return its result block.",
    ]);
  });

  it("lists files outside the allowed paths", () => {
    const verdict = checkResult(contract({ filesChanged: ["src/a.ts", "config/prod.yml"] }), {
      allowedPaths: ["src/**"],
      pullRequestAllowed: true,
    });
    expect(verdict).toEqual({
      verdict: "concerns",
      concerns: ["changed files outside the allowed paths: config/prod.yml."],
    });
  });

  it("flags a pull request the job did not allow, and open questions", () => {
    const verdict = checkResult(
      contract({ prUrl: "https://github.com/example/app/pull/7", openQuestions: ["Keep v1?"] }),
      { pullRequestAllowed: false },
    );
    expect(verdict.concerns).toEqual([
      "worker opened a PR the job didn't allow.",
      "worker left 1 open question(s).",
    ]);
  });

  it("allows any path when the job set none", () => {
    expect(
      checkResult(contract({ filesChanged: ["anything/x"] }), { pullRequestAllowed: true }),
    ).toEqual({ verdict: "pass", concerns: [] });
  });
});

describe("repoPath", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src//a.ts", "src/a.ts"],
    ["src/x/../a.ts", "src/a.ts"],
    ["src/../../outside.txt", undefined],
    ["/etc/passwd", undefined],
    ["C:/temp/x", undefined],
    ["..", undefined],
  ])("%s gives %s", (input, expected) => {
    expect(repoPath(input)).toBe(expected);
  });

  it("does not let a climbing path pass the allowed-path check", () => {
    const verdict = checkResult(contract({ filesChanged: ["src/../../outside.txt"] }), {
      allowedPaths: ["src/**"],
      pullRequestAllowed: true,
    });
    expect(verdict.concerns).toEqual([
      "changed files outside the allowed paths: src/../../outside.txt.",
    ]);
  });
});
