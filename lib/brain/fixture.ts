import type { LanguageModel } from "ai";
import { type MockModelRequest, type MockModelResponse, mockModel } from "eve/evals";

// A scripted brain for local end-to-end runs (SYM_MODEL=fixture). It calls no model provider,
// so the whole system runs on one machine with fakes. It is a test fixture, not a product
// behavior: real deployments use a gateway model (decision 018).
//
// Script:
// - A message with a ```brief JSON block calls worker_job with that brief.
// - A scheduled run message calls worker_job with its brief and its schedule reference.
// - A message that asks for an update or status calls jobs_status and repeats its answer.
// - A message that says "sign in to the worker" calls worker_sign_in.
// - A message that says "thinking out loud" calls no_reply (side talk, decision 050).
// - A task result, or a tool result with `posted: true`, ends the turn with no_reply.
// - Anything else gets a one-line echo.
export function fixtureBrain(): LanguageModel {
  return mockModel({ modelId: "sym-fixture", provider: "sym", respond: respondAsFixture });
}

export function respondAsFixture(request: MockModelRequest): MockModelResponse | string {
  const text = request.lastUserMessage ?? "";
  // Eve adds framework messages after a tool call, such as the [Tasks] list after a task
  // receipt, so the turn's own progress is whatever follows the latest authored message.
  const authoredAt = request.messages.findLastIndex(
    (message) => message.role === "user" && message.text === text,
  );
  const since = request.messages.slice(authoredAt + 1);
  // A task result, or any result with `posted: true`, means Sym already posted (decision 044).
  const posted = (m: { text: string }) => /"posted"\s*:\s*true/.test(m.text);
  if (
    text.includes("<task_result") ||
    since.some((m) => m.text.includes("<task_result") || posted(m))
  ) {
    return quiet(request);
  }
  if (since.some((message) => message.role === "tool")) {
    const result = request.toolResults.at(-1);
    if (result?.name === "jobs_status") return String(result.output);
    // The worker_job receipt: the job card and the brief speak for Sym while the job runs.
    return { text: "" };
  }

  // A reply in a thread carries the earlier thread messages first. Only the new message counts.
  const message = text.replace(/<slack_thread_context>[\s\S]*?<\/slack_thread_context>/g, "");
  const brief = briefIn(message);
  // A dispatch message names the schedule. The brief goes back unchanged, with the reference.
  const schedule = /^Scheduled run of (S-\d+):/m.exec(message)?.[1];
  if (brief && schedule)
    return { toolCalls: [{ name: "worker_job", input: { ...brief, schedule } }] };
  if (brief) return { toolCalls: [{ name: "worker_job", input: brief }] };
  if (/\bsign in to the worker\b/i.test(message)) {
    return { toolCalls: [{ name: "worker_sign_in", input: {} }] };
  }
  if (/\bthinking out loud\b/i.test(message)) return quiet(request);
  if (/\b(update|status)\b/i.test(message)) {
    const job = /\bJ-\d+\b/.exec(message)?.[0];
    return { toolCalls: [{ name: "jobs_status", input: job ? { job } : {} }] };
  }
  return `Fixture brain heard: ${message.slice(0, 200)}`;
}

function quiet(request: MockModelRequest): MockModelResponse {
  const canStayQuiet = request.tools.some((tool) => tool.name === "no_reply");
  return canStayQuiet
    ? { toolCalls: [{ name: "no_reply", input: { reason: "Sym posted the job result." } }] }
    : { text: "" };
}

function briefIn(text: string): Record<string, unknown> | undefined {
  const block = /```brief\s*([\s\S]*?)```/.exec(text)?.[1];
  if (!block) return undefined;
  try {
    const value: unknown = JSON.parse(block);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
