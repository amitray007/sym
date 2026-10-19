import type { SessionAuthContext } from "eve/context";
import { isScheduleAuth } from "eve/schedules";
import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { createWebhook, FatalError, sleep } from "workflow";
import type { Brief } from "../../lib/jobs/brief.ts";
import { callbackFor } from "../../lib/jobs/callback.ts";
import { parseOutputContract } from "../../lib/jobs/contract.ts";
import { resultConcerns } from "../../lib/jobs/present.ts";
import {
  answerQuestion,
  cancelJob,
  checkJob,
  closeUnlaunched,
  failJob,
  launchOrAdopt,
  markScheduledCheck,
  showBrief,
  startJob,
  statusLine,
} from "../../lib/jobs/run.ts";
import { getJob, jobRef } from "../../lib/ledger/jobs.ts";
import { ledger, ledgerDeps, pack, withJobDeps } from "../../lib/runtime.ts";
import { canSkipStart } from "../../lib/schedules/approval.ts";
import { ScheduledBrief } from "../../lib/schedules/input.ts";
import { runOutcome } from "../../lib/schedules/outcome.ts";
import { finishRunForSession, getSchedule, parseScheduleRef } from "../../lib/schedules/rows.ts";
import type { WorkerAnswers, WorkerQuestion } from "../../lib/workers/types.ts";

// One worker job from brief to result (docs/architecture.md, flows 1 and 3, decision 017). It
// runs as a task, so the conversation stays open while the worker runs. The owner starts each
// job from the brief: the job can write code, so it needs approval (AGENTS.md).

// Polling fallback when the worker's callback does not arrive, and the quicker re-check after
// the callback in case the worker posted before its run ended. Local end-to-end runs shorten
// both with SYM_JOB_POLL_SECONDS and SYM_JOB_POLL_AFTER_CALLBACK_SECONDS.
const POLL_SECONDS = 240;
const POLL_AFTER_CALLBACK_SECONDS = 30;
// How long one check blocks on the worker. The adapter gives the MCP request a margin on top.
const WAIT_MS = 60_000;

const START_OPTIONS = [
  { id: "start", label: "Start", style: "primary" as const },
  { id: "edit", label: "Edit" },
  { id: "cancel", label: "Cancel", style: "danger" as const },
];

// Sym posts each result in the job thread itself, so a lost session cannot lose it.
const POSTED_NOTE =
  "Sym already posted this in the job thread. Call no_reply unless the person asked for more.";

export default defineWorkflowTool({
  description:
    "Hand a coding task to a worker agent in a new worktree of a project the worker knows. " +
    "The owner sees the brief and presses Start before anything runs. A scheduled run passes " +
    "its stored brief unchanged with its schedule reference, and starts without a click. Runs as a task: you get " +
    "a receipt now and the result later. Write a complete brief.",
  inputSchema: ScheduledBrief,
  label: {
    start: (brief) => `Worker job: ${brief.title}`,
    delta: (_brief, progress: { status: string }) => progress.status,
  },
  async *task(input, ctx) {
    "use workflow";
    const { schedule, ...brief } = input;
    const job = await recordJob(brief, ctx.callId, ctx.session.id);
    const ref = jobRef(job.id);
    const timing = await jobTiming();

    // A body parked on a sleep, a webhook, or a question does not see the abort on its own,
    // so every wait races it.
    const stopped = new Promise<"stopped">((resolve) => {
      if (ctx.abortSignal.aborted) resolve("stopped");
      ctx.abortSignal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });

    try {
      // Decision 024: only an approved schedule run skips the click. The step checks the
      // session's initiator, the schedule row, and the brief, so the model cannot widen it.
      const preApproved = await isPreApproved(schedule, brief, ctx.session.auth.initiator);
      if (preApproved) {
        // A scheduled check speaks only when something needs attention (decision 031).
        await markScheduled(job.id);
        await linkRun(ctx.session.id, job.id);
      } else {
        // The full brief is Sym's own post; Eve's prompt card keeps only about 200 characters.
        await postBrief(job.id);
      }
      yield {
        status: statusLine(ref, preApproved ? "Starting scheduled run" : "Waiting for Start"),
      };
      const decision = preApproved
        ? ({ status: "answered", optionId: "start" } as const)
        : await Promise.race([
            ctx.ask({
              prompt: `Start ${ref}: ${brief.title}? The brief is above.`,
              display: "confirmation",
              options: START_OPTIONS,
            }),
            stopped,
          ]);
      if (decision === "stopped") {
        await closeBeforeStart(job.id, "Cancelled before start");
        return { job: ref, status: "cancelled" };
      }
      if (decision.status === "unavailable") {
        // A session without a person, such as a schedule, cannot approve. Fail closed.
        await closeBeforeStart(job.id, "No one could approve the brief");
        await endRun(ctx.session.id, job.id, "cancelled", null);
        return { job: ref, status: "not_started", reason: "This session cannot ask for approval." };
      }
      if (decision.status !== "answered" || decision.optionId === "cancel") {
        await closeBeforeStart(job.id, "Cancelled before start");
        return { job: ref, status: "cancelled" };
      }
      if (decision.optionId === "edit") {
        const edits = await Promise.race([
          ctx.ask({ prompt: `What should change in ${ref}?`, display: "text" }),
          stopped,
        ]);
        await closeBeforeStart(job.id, "Brief edited");
        if (edits === "stopped" || edits.status !== "answered") {
          return { job: ref, status: "cancelled" };
        }
        return {
          job: ref,
          status: "edit_requested",
          edits: edits.text ?? edits.optionId ?? "",
          next: "Rewrite the brief with these edits and call t3_job again.",
        };
      }
      if (decision.optionId !== "start") {
        await closeBeforeStart(job.id, "Cancelled before start");
        return { job: ref, status: "cancelled" };
      }

      yield { status: statusLine(ref, "Launching worker thread") };
      const callback = createWebhook();
      const threadId = await launch(job.id, callback.url);
      yield { status: statusLine(ref, "Worker thread started") };

      let calledBack = false;
      for (;;) {
        const timer = sleep(calledBack ? timing.afterCallbackMs : timing.pollMs).then(
          () => "timer" as const,
        );
        const woke = await Promise.race([
          timer,
          stopped,
          ...(calledBack ? [] : [callback.then(() => "callback" as const)]),
        ]);
        if (woke === "stopped") {
          await cancel(job.id);
          await endRun(ctx.session.id, job.id, "cancelled", null);
          return { job: ref, status: "cancelled", threadId, note: POSTED_NOTE };
        }
        if (woke === "callback") calledBack = true;

        const result = await check(job.id);
        yield { status: statusLine(ref, result.summary) };

        for (const question of result.questions) {
          const answers = await askQuestion(ctx.ask, ref, question, stopped);
          if (answers === "stopped") {
            await cancel(job.id);
            return { job: ref, status: "cancelled", threadId, note: POSTED_NOTE };
          }
          if (answers) await answer(job.id, question.requestId, answers);
        }

        if (result.terminal) {
          await endRun(ctx.session.id, job.id, result.status, result.lastMessage);
          return {
            job: ref,
            status: result.status,
            threadId,
            summary: result.summary,
            lastMessage: result.lastMessage,
            note: POSTED_NOTE,
          };
        }
      }
    } catch (error) {
      // A failed task must not leave the job looking like it still runs.
      await markFailed(job.id, error instanceof Error ? error.message : String(error));
      await endRun(ctx.session.id, job.id, "failed", null);
      throw error;
    }
  },
});

type Ask = WorkflowToolContext["ask"];

// Asks each part of a worker question as Slack buttons, with free text for other answers.
// Returns nothing when a person dismissed a part, so the worker keeps waiting for the owner.
async function askQuestion(
  ask: Ask,
  ref: string,
  question: WorkerQuestion,
  stopped: Promise<"stopped">,
): Promise<WorkerAnswers | "stopped" | undefined> {
  const answers: WorkerAnswers = {};
  for (const part of question.questions) {
    const reply = await Promise.race([
      ask({
        prompt: `${ref} asks: ${part.header ? `${part.header}: ` : ""}${part.prompt}`,
        display: part.options.length > 0 ? "select" : "text",
        options: part.options.map((option) => ({
          id: option.label,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        allowFreeform: true,
      }),
      stopped,
    ]);
    if (reply === "stopped") return "stopped";
    if (reply.status !== "answered") return undefined;
    answers[part.id] = reply.optionId ?? reply.text ?? "";
  }
  return answers;
}

// Read in a step, so a replay of the body sees the same values.
async function jobTiming() {
  "use step";
  const seconds = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    pollMs: seconds("SYM_JOB_POLL_SECONDS", POLL_SECONDS) * 1000,
    afterCallbackMs:
      seconds("SYM_JOB_POLL_AFTER_CALLBACK_SECONDS", POLL_AFTER_CALLBACK_SECONDS) * 1000,
  };
}

async function recordJob(brief: Brief, callId: string, sessionId: string) {
  "use step";
  // A tool call ID is unique only inside its session, so the session scopes the key.
  const requestKey = `${sessionId}:${callId}`;
  const job = await startJob(ledger(), { requestKey, sessionId, brief });
  return { id: job.id };
}

async function markScheduled(jobId: number) {
  "use step";
  await markScheduledCheck(ledger(), jobId);
}

async function postBrief(jobId: number) {
  "use step";
  await showBrief(ledgerDeps(), jobId);
}

async function launch(jobId: number, webhookUrl: string): Promise<string> {
  "use step";
  const callbackUrl = callbackFor(webhookUrl, process.env.SYM_CALLBACK_URL);
  try {
    const job = await withJobDeps((deps) => launchOrAdopt(deps, jobId, callbackUrl));
    if (!job.workerThreadId) throw new Error(`${jobRef(jobId)} has no worker thread`);
    return job.workerThreadId;
  } catch (error) {
    // An unknown project or worker model cannot succeed on retry.
    if (error instanceof Error && error.name === "JobSetupError") {
      throw new FatalError(error.message);
    }
    throw error;
  }
}

async function check(jobId: number) {
  "use step";
  return withJobDeps((deps) => checkJob(deps, jobId, WAIT_MS));
}

async function answer(jobId: number, requestId: string, answers: WorkerAnswers) {
  "use step";
  await withJobDeps((deps) => answerQuestion(deps, jobId, requestId, answers));
}

async function cancel(jobId: number) {
  "use step";
  await withJobDeps((deps) => cancelJob(deps, jobId));
}

async function closeBeforeStart(jobId: number, reason: string) {
  "use step";
  await closeUnlaunched(ledgerDeps(), jobId, reason);
}

async function markFailed(jobId: number, reason: string) {
  "use step";
  await failJob(ledgerDeps(), jobId, reason);
}

// True only for a run the owner approved ahead of time (decision 024). The initiator travels in
// as data, and the principal check, the row lookup, and the brief comparison run in this step.
async function isPreApproved(
  schedule: string | undefined,
  brief: unknown,
  initiator: SessionAuthContext | null | undefined,
): Promise<boolean> {
  "use step";
  const id = schedule ? parseScheduleRef(schedule) : undefined;
  if (id === undefined || !isScheduleAuth(initiator)) return false;
  return canSkipStart({
    isSchedulePrincipal: true,
    schedule: await getSchedule(ledger(), id),
    brief,
  });
}

async function linkRun(sessionId: string, jobId: number) {
  "use step";
  await finishRunForSession(ledger(), sessionId, "started", jobId);
}

// Records how a scheduled run ended for the digest. A session without a run row is not a
// scheduled run, so the update changes nothing.
async function endRun(
  sessionId: string,
  jobId: number,
  status: string,
  lastMessage: string | null,
) {
  "use step";
  const contract = parseOutputContract(lastMessage);
  const job = await getJob(ledger(), jobId);
  const concerns = job ? resultConcerns(job, contract, pack()) : [];
  await finishRunForSession(ledger(), sessionId, runOutcome(status, contract, concerns), jobId);
}
