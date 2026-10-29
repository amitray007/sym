import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finishedSteps,
  type Harness,
  messageText,
  newConversation,
  SAMPLE_CONTRACT,
  settle,
  startHarness,
  startJob,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

// The written result end to end (decision 062): with the writer on, a finished code job's result
// is the `writer` subagent's text in a markdown block, with Sym's footer and buttons. The fixture
// writer answers "Written: <ref> - <summary>".

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_writer", env: { SYM_RESULT_WRITER: "on" } });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

describe("written result", () => {
  it("posts the writer's text with the footer and the result buttons", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Writer sync");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");

    const result = await until(
      () => c.botMessages().find((m) => (m.text ?? "").includes(`Written: ${ref}`)),
      { label: `${ref} written result` },
    );
    await settle(h);
    const blocks = JSON.stringify(result.blocks);
    expect(messageText(result)).toContain(`Written: ${ref} - ${SAMPLE_CONTRACT.summary}`);
    expect(result.text).toContain("Tests passed");
    expect(blocks).toContain(ref);
    expect(blocks).not.toContain('"action_id":"sym_job_ok"');
    expect(blocks).toContain(SAMPLE_CONTRACT.pr_url);
    // No template headline: the writer's text replaced it.
    expect(blocks).not.toContain("tl;dr");
    // One result only.
    expect(c.botMessages().filter((m) => (m.text ?? "").includes(`Written: ${ref}`))).toHaveLength(
      1,
    );
  });
});
