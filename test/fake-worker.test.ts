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

  it("holds scripted questions until they are answered", async () => {
    const question = {
      requestId: "req-1",
      questions: [
        { id: "q-1", prompt: "Which branch?", options: [{ label: "main" }], multiSelect: false },
      ],
    };
    const worker = new FakeWorker({ script: [{ status: "waiting", questions: [question] }] });
    const thread = await worker.launch(request);
    await worker.wait(thread.id, 1000);

    expect(await worker.pendingQuestions(thread.id)).toEqual([question]);
    expect((await worker.readActivity(thread.id, null)).pendingRequests).toBe(1);

    await worker.answer(thread.id, "req-1", { "q-1": "main" });

    expect(worker.answers).toEqual([
      { threadId: thread.id, requestId: "req-1", answers: { "q-1": "main" } },
    ]);
    expect(await worker.pendingQuestions(thread.id)).toEqual([]);
    expect((await worker.readActivity(thread.id, null)).pendingRequests).toBe(0);
    await expect(worker.answer(thread.id, "req-1", {})).rejects.toThrow("no pending request");
  });

  it("records sends", async () => {
    const worker = new FakeWorker();
    const thread = await worker.launch(request);

    await worker.send(thread.id, "Also add tests", "queue", "send-1");

    expect(worker.sends).toEqual([
      { threadId: thread.id, text: "Also add tests", mode: "queue", requestId: "send-1" },
    ]);
  });

  it("records pull request watches and reports a repeat", async () => {
    const worker = new FakeWorker();
    const thread = await worker.launch({
      projectId: "project-1",
      title: "[J-1] x",
      message: "m",
      baseRef: "main",
    });
    const url = "https://github.com/o/r/pull/1";

    expect(await worker.watchPullRequest(thread.id, url, "k1")).toEqual({
      watching: true,
      alreadyWatching: false,
    });
    expect(await worker.watchPullRequest(thread.id, url, "k2")).toMatchObject({
      alreadyWatching: true,
    });
    worker.watchError = "merged";
    await expect(worker.watchPullRequest(thread.id, url, "k3")).rejects.toThrow("merged");
  });

  it("adds a wake as a notification item", async () => {
    const worker = new FakeWorker();
    const thread = await worker.launch({
      projectId: "project-1",
      title: "[J-1] x",
      message: "m",
      baseRef: "main",
    });
    worker.addWake(thread.id, "#1: checks failed");
    const activity = await worker.readActivity(thread.id, null);
    expect(activity.items).toEqual([
      { position: 0, type: "notification", text: "#1: checks failed" },
    ]);
  });
});
