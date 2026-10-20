import { describe, expect, it } from "vitest";
import { nearDuplicate } from "../lib/jobs/similar.ts";
import { mergeConcerns } from "../lib/jobs/verify.ts";

describe("nearDuplicate", () => {
  it("ignores case, punctuation, and stop words", () => {
    expect(nearDuplicate("The tests were NOT run!", "tests not run")).toBe(true);
  });

  it("treats a short line inside a longer one as a repeat", () => {
    expect(
      nearDuplicate(
        "CI status for head 271896a was not checked",
        "CI status for head 271896a was not checked before recommending merge.",
      ),
    ).toBe(true);
  });

  it("expands n't so wasn't matches was not", () => {
    expect(nearDuplicate("CI on 271896a wasn't checked", "CI on 271896a was not checked")).toBe(
      true,
    );
  });

  it("keeps lines that differ in meaning", () => {
    expect(nearDuplicate("Tests were not run", "The worker opened a pull request")).toBe(false);
    expect(nearDuplicate("No test covers the retry limit", "No test covers the timeout")).toBe(
      false,
    );
  });

  it("never matches an empty line", () => {
    expect(nearDuplicate("", "the a an")).toBe(false);
  });
});

describe("mergeConcerns near duplicates", () => {
  it("drops a model concern that rewords a rule concern", () => {
    expect(
      mergeConcerns(
        ["The worker opened a pull request the job did not allow."],
        ["worker opened a PULL REQUEST the job didn't allow", "No test covers the retry limit."],
      ),
    ).toEqual([
      "The worker opened a pull request the job did not allow.",
      "No test covers the retry limit.",
    ]);
  });
});
