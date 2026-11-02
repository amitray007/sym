import type { LanguageModel } from "ai";
import { type MockModelRequest, type MockModelResponse, mockModel } from "eve/evals";

// A scripted brain for local end-to-end runs (SYM_MODEL=fixture). It calls no model provider,
// so the whole system runs on one machine with fakes. It is a test fixture, not a product
// behavior: real deployments use a gateway model (decision 018).
//
// Script:
// - A message with a ```brief JSON block calls worker_job with that brief.
// - A scheduled run message with a ```brief block calls worker_job with that brief and the
//   schedule reference. A scheduled run that says "fixture-say" posts one line; any other run
//   without a brief ends the turn with no_reply.
// - A trigger run message reads only its instruction: a ```brief block calls worker_job with the
//   trigger reference, "fixture-say" echoes the event's text, "fixture-schedule" tries
//   schedule_create, and anything else ends the turn with no_reply.
// - A message that asks for an update or status calls jobs_status and repeats its answer.
// - A message that says "sign in to the worker" calls worker_sign_in.
// - A message that says "thinking out loud" calls no_reply (side talk, decision 050).
// - A message that says "move this to a code channel" calls code_channel, then answers in one line.
// - A message with "fixture-react <emoji>" calls slack_react, then ends the turn with no_reply.
// - A repeated-work review calls repeated_work, proposes one playbook for any title seen 3 or more
//   times, then ends the turn with no_reply.
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
  const researchResult =
    /<task_result\b[^>]*>[\s\S]*?Research fixture checked the saved ledger\.[\s\S]*?<\/task_result>/.exec(
      [text, ...since.map((message) => message.text)].join("\n"),
    );
  if (researchResult)
    return "Research fixture checked the saved ledger. No live worker state was checked.";
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
    if (result?.name === "eve__skill") return String(result.output);
    if (result?.name === "jobs_status") {
      const output = toolData(result.output) as { answer?: string };
      return output.answer ?? String(result.output);
    }
    // A reaction stands in for the reply.
    if (result?.name === "slack_react") return quiet(request);
    if (result?.name === "repeated_work") return proposeRepeated(request, result.output);
    if (result?.name === "repeated_work_propose") return quiet(request);
    if (result?.name === "schedule_create")
      return `Fixture schedule result: ${String(result.output).slice(0, 200)}`;
    if (result?.name === "code_channel")
      return `Code channel: ${String(result.output).slice(0, 200)}`;
    // The worker_job receipt: the job card and the brief speak for Sym while the job runs.
    return { text: "" };
  }

  // A reply in a thread carries the earlier thread messages first. Only the new message counts.
  const message = text.replace(/<slack_thread_context>[\s\S]*?<\/slack_thread_context>/g, "");
  if (/\bfixture-skill\b/.test(message)) {
    return { toolCalls: [{ name: "eve__skill", input: { name: "fixture-check" } }] };
  }
  if (/\bfixture-research\b/.test(message)) {
    return { toolCalls: [{ name: "research", input: { message: "Check saved job status." } }] };
  }
  const brief = briefIn(message);
  // A run message names the schedule. Its instruction may carry the brief to start.
  const schedule = /^Scheduled run of (S-\d+):/m.exec(message)?.[1];
  if (brief && schedule)
    return { toolCalls: [{ name: "worker_job", input: { ...brief, schedule } }] };
  if (schedule) {
    return /\bfixture-say\b/.test(message) ? "Fixture run: this needs a look." : quiet(request);
  }
  // A trigger run reads only its instruction for the script. The event's text is data, so a
  // brief or "fixture-say" written in the event message drives nothing (decision 088).
  const trigger = /^Trigger run of (T-\d+):/m.exec(message)?.[1];
  if (trigger) {
    const instruction = /^Instruction:\n([\s\S]*?)\n\nA Slack event started this run\./m.exec(
      message,
    )?.[1];
    const triggerBrief = briefIn(instruction ?? "");
    if (triggerBrief) {
      return { toolCalls: [{ name: "worker_job", input: { ...triggerBrief, trigger } }] };
    }
    if (/\bfixture-schedule\b/.test(instruction ?? "")) {
      return {
        toolCalls: [
          {
            name: "schedule_create",
            input: { title: "Run-made", instruction: "Say hello.", cron: "0 9 * * *" },
          },
        ],
      };
    }
    if (!/\bfixture-say\b/.test(instruction ?? "")) return quiet(request);
    const event = /^Event \(JSON data\):\n(.*)$/m.exec(message)?.[1] ?? "{}";
    const text = (toolData(event) as { text?: string }).text ?? "";
    return `Fixture trigger run saw: ${text.slice(0, 200)}`;
  }
  if (brief) return { toolCalls: [{ name: "worker_job", input: brief }] };
  const reaction = /\bfixture-react\s+(\S+)/.exec(message)?.[1];
  if (reaction) return { toolCalls: [{ name: "slack_react", input: { emoji: reaction } }] };
  if (/\bsign in to the worker\b/i.test(message)) {
    return { toolCalls: [{ name: "worker_sign_in", input: {} }] };
  }
  if (/\bthinking out loud\b/i.test(message)) return quiet(request);
  if (/\bmove this to a code channel\b/i.test(message)) {
    return {
      toolCalls: [
        { name: "code_channel", input: { message: "Continue here.", name: "Fixture work" } },
      ],
    };
  }
  if (/^Repeated-work review\./m.test(message)) {
    return { toolCalls: [{ name: "repeated_work", input: {} }] };
  }
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

// Groups the review's structured jobs by title and proposes the first title seen 3 or more times.
function proposeRepeated(request: MockModelRequest, output: unknown): MockModelResponse {
  const byTitle = new Map<string, string[]>();
  const data = toolData(output) as { jobs?: { ref: string; title: string }[] };
  for (const { ref, title } of data.jobs ?? []) {
    byTitle.set(title, [...(byTitle.get(title) ?? []), ref]);
  }
  const [title, jobs] = [...byTitle].find(([, refs]) => refs.length >= 3) ?? [];
  if (!title || !jobs) return quiet(request);
  const name = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const body = `Steps for "${title}": write the brief with the same project, goal, and done-when checks.`;
  return {
    toolCalls: [{ name: "repeated_work_propose", input: { proposals: [{ name, body, jobs }] } }],
  };
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

function toolData(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}
