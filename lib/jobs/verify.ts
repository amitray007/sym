import type { OutputContract } from "./contract.ts";

// Deterministic result checks (docs/architecture.md, flow 4), run before any model review. They
// compare what the worker says it did with what the job allowed. No I/O: this module runs inside
// the workflow bundle, so it matches globs itself instead of importing node:path.

export interface ResultRules {
  // Glob patterns the worker may change, such as `src/**`. Absent means any path.
  allowedPaths?: string[];
  // Whether the job allowed a pull request at all.
  pullRequestAllowed: boolean;
}

export interface Verdict {
  verdict: "pass" | "concerns";
  concerns: string[];
}

export function checkResult(contract: OutputContract | null, rules: ResultRules): Verdict {
  if (!contract) {
    return { verdict: "concerns", concerns: ["The worker did not return its result block."] };
  }
  const concerns: string[] = [];
  if (rules.allowedPaths && rules.allowedPaths.length > 0) {
    const outside = contract.filesChanged.filter(
      (file) => !rules.allowedPaths?.some((pattern) => matchesGlob(file, pattern)),
    );
    if (outside.length > 0) {
      concerns.push(`Changed files outside the allowed paths: ${outside.join(", ")}.`);
    }
  }
  if (contract.prUrl && !rules.pullRequestAllowed) {
    concerns.push("The worker opened a pull request the job did not allow.");
  }
  if (contract.openQuestions.length > 0) {
    concerns.push(`The worker left ${contract.openQuestions.length} open question(s).`);
  }
  return { verdict: concerns.length > 0 ? "concerns" : "pass", concerns };
}

// `**` matches across folders, `*` within one folder, `?` one character. A leading `./` or `/` on
// the path is ignored, so worker paths and pack patterns compare the same way.
export function matchesGlob(path: string, pattern: string): boolean {
  const clean = path.replace(/^\.?\//, "");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*" && pattern[i + 1] === "*") {
      // `**/` also matches no folder at all, so `src/**/a.ts` matches `src/a.ts`.
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(clean);
}
