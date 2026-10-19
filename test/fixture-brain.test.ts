import type { MockModelRequest } from "eve/evals";
import { describe, expect, it } from "vitest";
import { respondAsFixture } from "../lib/brain/fixture.ts";

type Message = MockModelRequest["messages"][number];
type ToolResult = MockModelRequest["toolResults"][number];

function request(
  text: string | null,
  options: { tools?: string[]; toolResults?: ToolResult[]; messages?: Message[] } = {},
): MockModelRequest {
  const messages: Message[] = options.messages ?? (text === null ? [] : [{ role: "user", text }]);
  return {
    messages,
    userMessages: text === null ? [] : [text],
    lastUserMessage: text,
    userMessageCount: text === null ? 0 : 1,
    tools: (options.tools ?? []).map((name) => ({ name })),
    toolResults: options.toolResults ?? [],
  };
}

const BRIEF = {
  project: "test-repo",
  title: "Billing sync retry",
  goal: "Add retry.",
  constraints: [],
  doneWhen: ["Tests pass."],
  baseRef: "main",
  openPullRequest: false,
  estimatedMinutes: 15,
};

describe("respondAsFixture", () => {
  it("calls t3_job with the JSON of a brief block", () => {
    const text = `Please do this.\n\`\`\`brief\n${JSON.stringify(BRIEF)}\n\`\`\`\nThanks`;
    expect(respondAsFixture(request(text))).toEqual({
      toolCalls: [{ name: "t3_job", input: BRIEF }],
    });
  });

  it("echoes when the brief block is not valid JSON", () => {
    const text = "```brief\n{not json\n```";
    expect(respondAsFixture(request(text))).toBe(`Fixture brain heard: ${text}`);
  });

  it("echoes at most 200 characters", () => {
    const text = "a".repeat(300);
    expect(respondAsFixture(request(text))).toBe(`Fixture brain heard: ${"a".repeat(200)}`);
  });

  it("asks jobs_status for one job when the message names it", () => {
    expect(respondAsFixture(request("what's the update on J-7"))).toEqual({
      toolCalls: [{ name: "jobs_status", input: { job: "J-7" } }],
    });
  });

  it("asks jobs_status for all jobs on a plain status message", () => {
    expect(respondAsFixture(request("status"))).toEqual({
      toolCalls: [{ name: "jobs_status", input: {} }],
    });
  });

  it("does not match update or status inside another word", () => {
    expect(respondAsFixture(request("statuses and updated"))).toBe(
      "Fixture brain heard: statuses and updated",
    );
  });

  it("repeats the output of a jobs_status result", () => {
    const answer = "J-7 Billing sync retry: running for 4m.";
    const result = respondAsFixture(
      request("status", {
        messages: [
          { role: "user", text: "status" },
          { role: "tool", text: answer },
        ],
        toolResults: [{ id: "c1", name: "jobs_status", output: answer, isError: false }],
      }),
    );
    expect(result).toBe(answer);
  });

  it("says nothing after a t3_job receipt", () => {
    const result = respondAsFixture(
      request("go", {
        messages: [
          { role: "user", text: "go" },
          { role: "tool", text: "started" },
        ],
        toolResults: [{ id: "c1", name: "t3_job", output: "started", isError: false }],
      }),
    );
    expect(result).toEqual({ text: "" });
  });

  it("says nothing after a t3_job receipt that Eve follows with its task list", () => {
    const text = `\`\`\`brief\n${JSON.stringify(BRIEF)}\n\`\`\``;
    const result = respondAsFixture(
      request(text, {
        messages: [
          { role: "user", text },
          { role: "assistant", text: "" },
          { role: "tool", text: "Started task t3_job-1." },
          { role: "user", text: '[Tasks]\n<tasks><task id="t3_job-1" status="working"/></tasks>' },
        ],
        toolResults: [
          { id: "c1", name: "t3_job", output: "Started task t3_job-1.", isError: false },
        ],
      }),
    );
    expect(result).toEqual({ text: "" });
  });

  it("reads only the new message after the thread context", () => {
    const text =
      `<slack_thread_context>\n\`\`\`brief\n${JSON.stringify(BRIEF)}\n\`\`\`\n` +
      "</slack_thread_context>\n\nwhat's the update?";
    expect(respondAsFixture(request(text))).toEqual({
      toolCalls: [{ name: "jobs_status", input: {} }],
    });
  });

  it("calls no_reply for a task result when the tool exists", () => {
    expect(
      respondAsFixture(request('<task_result id="x">done</task_result>', { tools: ["no_reply"] })),
    ).toEqual({
      toolCalls: [{ name: "no_reply", input: { reason: "Sym posted the job result." } }],
    });
  });

  it("answers with empty text for a task result when no_reply is missing", () => {
    expect(
      respondAsFixture(request('<task_result id="x">done</task_result>', { tools: ["t3_job"] })),
    ).toEqual({ text: "" });
  });

  it("handles a request with no user message", () => {
    expect(respondAsFixture(request(null))).toBe("Fixture brain heard: ");
  });
});

describe("respondAsFixture scheduled runs", () => {
  it("calls t3_job with the stored brief and the schedule reference", () => {
    const text = `Scheduled run of S-3: On-call check.\n\nCall t3_job.\n\n\`\`\`brief\n${JSON.stringify(BRIEF)}\n\`\`\`\n\nWhen nothing, call no_reply.`;
    expect(respondAsFixture(request(text))).toEqual({
      toolCalls: [{ name: "t3_job", input: { ...BRIEF, schedule: "S-3" } }],
    });
  });
});
