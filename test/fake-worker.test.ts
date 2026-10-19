import { describe, expect, it } from "vitest";
import { FakeWorker } from "./fakes/worker.ts";

const request = { projectId: "project-1", title: "[J-1] Retry", message: "brief", baseRef: "main" };

describe("FakeWorker", () => {
  it("runs a launched thread through its script", async () => {
    const worker = new FakeWorker({
      script: [
        { status: "running", items: ["Writing code"] },
        { status: "completed", items: ["Opened PR"] },
      ],
    });
    const thread = await worker.launch(request);

    expect(await worker.wait(thread.id, 1000)).toEqual({ status: "running", timedOut: true });
    const first = await worker.readActivity(thread.id, null);
    expect(first.items.map((item) => item.text)).toEqual(["Writing code"]);

    expect(await worker.wait(thread.id, 1000)).toEqual({ status: "completed", timedOut: false });
    const second = await worker.readActivity(thread.id, first.cursor);
    expect(second.items.map((item) => item.text)).toEqual(["Opened PR"]);
  });

  it("creates the thread even when the launch response is lost", async () => {
    const worker = new FakeWorker({ loseNextLaunchResponse: true });

    await expect(worker.launch(request)).rejects.toThrow("launch response lost");

    expect(await worker.findByTitle("project-1", "[J-1]")).toMatchObject({ title: "[J-1] Retry" });
    expect(worker.launches).toBe(1);
  });
});
