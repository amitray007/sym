import { describe, expect, it } from "vitest";
import { renderJobCard } from "../lib/jobs/card.ts";
import { permissionBlockMessage } from "../lib/jobs/messages.ts";
import { workerLabel, workerLabelInstructions, workerNoun } from "../lib/worker-label.ts";
import { signInText } from "../lib/workers/expiry.ts";

describe("workerLabel", () => {
  it("defaults to Worker", () => {
    expect(workerLabel({})).toBe("Worker");
    expect(workerLabel({ SYM_WORKER_LABEL: "   " })).toBe("Worker");
    expect(workerNoun({})).toBe("worker");
  });

  it("uses a custom label, trimmed", () => {
    expect(workerLabel({ SYM_WORKER_LABEL: "  Builder " })).toBe("Builder");
    expect(workerNoun({ SYM_WORKER_LABEL: "Builder" })).toBe("builder");
  });

  it("cuts a label that is too long", () => {
    const label = workerLabel({ SYM_WORKER_LABEL: "x".repeat(80) });
    expect(label).toHaveLength(30);
  });

  it("tells the brain the label and the rules", () => {
    const text = workerLabelInstructions({ SYM_WORKER_LABEL: "Builder" });
    expect(text).toContain('"Builder"');
    expect(text).toContain("Never name the software");
    expect(text).toContain("Never mention tool names");
  });
});

describe("messages with a custom label", () => {
  it("uses the label and never says T3", () => {
    process.env.SYM_WORKER_LABEL = "Builder";
    try {
      const texts = [
        permissionBlockMessage("J-1"),
        signInText("warn", {
          expiresAt: new Date("2026-11-10T00:00:00Z"),
          now: new Date("2026-11-06T00:00:00Z"),
        } as never),
        JSON.stringify(
          renderJobCard({
            ref: "J-1",
            title: "Retry",
            status: "waiting_permission",
            worker: "Builder",
            startedAt: 0,
            now: 60_000,
            version: 1,
          }),
        ),
      ];
      for (const text of texts) {
        expect(text.toLowerCase()).toContain("builder");
        expect(text).not.toMatch(/T3/i);
      }
      expect(permissionBlockMessage("J-1")).toBe(
        "J-1 is waiting on a permission in Builder. I can't approve that from Slack.",
      );
    } finally {
      delete process.env.SYM_WORKER_LABEL;
    }
  });
});
