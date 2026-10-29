import type { LanguageModel } from "ai";
import { type MockModelRequest, type MockModelResponse, mockModel } from "eve/evals";
import { respondAsFixture as base } from "../../lib/brain/fixture.ts";

// Test-only brain routes for conversation tools. The e2e harness copies this into its isolated
// app beside the original fixture. No production brain or instruction file is changed.
export function conversationBrain(): LanguageModel {
  return mockModel({ modelId: "sym-conversation-fixture", provider: "sym", respond });
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const text = request.lastUserMessage ?? "";
  const authoredAt = request.messages.findLastIndex(
    (message) => message.role === "user" && message.text === text,
  );
  if (request.messages.slice(authoredAt + 1).some((message) => message.role === "tool")) {
    const result = request.toolResults.at(-1);
    if (result?.name === "jobs_status") {
      let value: unknown = result.output;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          return value as string;
        }
      }
      if (value && typeof value === "object" && "answer" in value) return String(value.answer);
    }
    return base(request);
  }
  const withoutHistory = text.replace(
    /<slack_thread_context>[\s\S]*?<\/slack_thread_context>/g,
    "",
  );
  const message =
    /<content>\s*([\s\S]*?)\s*<\/content>/.exec(withoutHistory)?.[1] ?? withoutHistory;
  const action = /fixture-(steer|followup|close|stop)\s+(J-\d+)(?::\s*([\s\S]+))?/i.exec(message);
  if (action) {
    const [, kind, ref, change] = action;
    if (kind === "followup")
      return {
        toolCalls: [{ name: "job_followup", input: { ref, change: change ?? "add a test" } }],
      };
    if (kind === "close") return { toolCalls: [{ name: "job_close", input: { ref } }] };
    return {
      toolCalls: [
        {
          name: kind === "stop" ? "job_stop" : "job_steer",
          input: { job: ref, ...(kind === "steer" ? { text: change ?? "continue" } : {}) },
        },
      ],
    };
  }
  if (message.includes("fixture-choices"))
    return {
      toolCalls: [
        {
          name: "offer_choices",
          input: { message: "What would you like next?", choices: ["Show details", "Leave it"] },
        },
      ],
    };
  const context = request.messages.map((message) => message.text).join("\n");
  const job = [...context.matchAll(/This conversation is about (J-\d+)/g)].at(-1)?.[1];
  // Choice clicks are ordinary attributed message parts, never bare approval text.
  const chosen = /^<@[UW][A-Z0-9]+> chose this conversation option: ("(?:[^"\\]|\\.)*")$/.exec(
    message,
  )?.[1];
  const answer = chosen ? (JSON.parse(chosen) as string) : message;
  if (job && /^staging[.!]?$/i.test(answer.trim()))
    return { toolCalls: [{ name: "job_steer", input: { job, text: "staging" } }] };
  const result = base(request);
  return typeof result === "string" && result.startsWith("Fixture brain heard:")
    ? `Fixture brain heard: ${message.slice(0, 200)}`
    : result;
}

export const conversationFixturePath = import.meta.filename;
