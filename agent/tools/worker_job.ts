import type { SessionAuthContext } from "eve/context";
import { isScheduleAuth } from "eve/schedules";
import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { createWebhook, FatalError, sleep } from "eve/workflow";
import type { Brief } from "../../lib/jobs/brief.ts";
import { callbackFor } from "../../lib/jobs/callback.ts";
import { parseOutputContract } from "../../lib/jobs/contract.ts";
import { resultConcerns } from "../../lib/jobs/present.ts";
import {
  answerQuestion,
  cancelJob,
  checkJob,
  closeUnlaunched,
  deliverNow,
  failJob,
  finishJob,
  launchOrAdopt,
  markScheduledCheck,
  showBrief,
  startJob,
  statusLine,
  verifierRequest,
  WATCH_LEASE_MS,
  writerRequest,
} from "../../lib/jobs/run.ts";
import { type ModelCheck, VerifierOutput, verifierEnabled } from "../../lib/jobs/verify.ts";
import { WriterOutput, writerEnabled } from "../../lib/jobs/writer.ts";
import { sessionInstructions } from "../../lib/learning/format.ts";
import { approvedForSession } from "../../lib/learning/rows.ts";
import { linkPlaybook, markAutoStarted, trustedPlaybookOf } from "../../lib/learning/trust.ts";
import { getJob, jobRef } from "../../lib/ledger/jobs.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { personaInstructions } from "../../lib/persona.ts";
import { storedPersonaOrNone } from "../../lib/persona-setting.ts";
import { checkProject } from "../../lib/projects/allowed.ts";
import { allowedFromEnv, ledger, ledgerDeps, pack, withJobDeps } from "../../lib/runtime.ts";
import { canSkipStart } from "../../lib/schedules/approval.ts";
import { ScheduledBrief } from "../../lib/schedules/input.ts";
import { runOutcome } from "../../lib/schedules/outcome.ts";
import {
  claimRunWhenAttached,
  finishRunForSession,
  getSchedule,
  parseScheduleRef,
} from "../../lib/schedules/rows.ts";
import {
  moveToCodeChannel,
  pointToQuestion,
  type SessionStatus,
  setChannelStatus,
  setContextBar,
} from "../../lib/slack/code-channel.ts";
import { workerLabel, workerNoun } from "../../lib/worker-label.ts";
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
// How long the `writer` subagent may take before the result posts with the template (decision
// 062). Local end-to-end runs can change it with SYM_WRITER_TIMEOUT_SECONDS.
const WRITER_SECONDS = 120;
// How long the `verifier` subagent may take before the result posts with the rule checks alone.
// With the writer after it, both stay under the watch lease (see jobTiming). Local end-to-end
// runs can change it with SYM_VERIFIER_TIMEOUT_SECONDS.
const VERIFIER_SECONDS = 300;

const START_OPTIONS = [
  { id: "start", label: "Start", style: "primary" as const },
  { id: "edit", label: "Edit" },
  { id: "cancel", label: "Cancel", style: "danger" as const },
];

// Sym posts each result in the job thread itself, so a lost session cannot lose it (decision
// 044). The result gives the brain no summary to repeat, only `posted: true`: when the result
// carried the worker's summary, the brain wrote it out a second time.
const POSTED = {
  posted: true,
  note: "Sym already posted the result in the job thread. Call no_reply and write nothing.",
} as const;

export default defineWorkflowTool({
  description:
    "Hand a coding task to a worker agent in a new worktree of a project the worker knows. " +
    "Use it for the work your instructions give to the worker, not for a quick check. " +
    "The owner sees the brief and presses Start before anything runs. A scheduled run passes " +
    "its stored brief unchanged with its schedule reference, and starts without a click. Runs as a task: you get " +
    "a receipt now and the result later. Write a complete brief.",
  inputSchema: ScheduledBrief,
  label: {
    start: (brief) => `${workerLabel()} job: ${brief.title}`,
    delta: (_brief, progress: { status: string }) => progress.status,
  },
  async *task(input, ctx) {
    "use workflow";
    const { schedule, ...brief } = input;
    // Decision 042: a project outside Sym's list never gets a job row or a brief post. The
    // reason names only the allowed projects, whether or not the asked-for project exists.
    const refusal = await projectRefusal(brief.project);
    if (refusal) {
      await endRefusedRun(ctx.session.id);
      return { status: "not_started", reason: refusal };
    }
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
      const preApproved = await isPreApproved(
        schedule,
        brief,
        ctx.session.auth.initiator,
        ctx.session.id,
        job.id,
      );
      // Decision 059: a brief that follows a playbook the owner trusts skips the click. The step
      // reads the trust from the ledger, so the model cannot grant it.
      const trusted = preApproved ? null : await trustedStart(job.id, ctx.session.auth.current);
      if (preApproved) {
        // A scheduled check speaks only when something needs attention (decision 031).
        await markScheduled(job.id);
        await linkRun(ctx.session.id, job.id);
      } else {
        // The brief is Sym's own post; Eve's prompt card keeps only about 200 characters.
        await postBrief(job.id, trusted);
      }
      yield {
        status: statusLine(
          ref,
          preApproved ? "Starting scheduled run" : trusted ? "Starting" : "Waiting for Start",
        ),
      };
      const decision =
        preApproved || trusted
          ? ({ status: "answered", optionId: "start" } as const)
          : await Promise.race([
              ctx.ask({
                prompt: `Start ${ref}: ${brief.title}? The Full brief button is above.`,
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
          next: "Rewrite the brief with these edits and call worker_job again.",
        };
      }
      if (decision.optionId !== "start") {
        await closeBeforeStart(job.id, "Cancelled before start");
        return { job: ref, status: "cancelled" };
      }

      // Decision 067: a job a person started moves into its own code channel, when that is on.
      // A scheduled check stays quiet in its thread.
      const inChannel = preApproved ? false : await toCodeChannel(job.id);
      yield { status: statusLine(ref, `Launching ${workerNoun()} thread`) };
      const callback = createWebhook();
      const threadId = await launch(job.id, callback.url);
      yield { status: statusLine(ref, `${workerLabel()} thread started`) };

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
          if (inChannel) await channelStatus(job.id, "active");
          return { job: ref, status: "cancelled", threadId, ...POSTED };
        }
        if (woke === "callback") calledBack = true;

        const result = await check(job.id, timing.verify, timing.write ?? false);
        yield { status: statusLine(ref, result.summary) };

        // The worker finished a code job. With SYM_VERIFIER=on, the `verifier` subagent checks
        // the result (flow 4, decisions 032 and 054). Then the `writer` subagent writes the one
        // result message in the persona's voice (decision 062).
        if (result.status === "checking") {
          let verdict: ModelCheck | undefined | "stopped";
          // A run that started before the writer existed replays a timing with no `verify`; it
          // held the job in `checking` only for the verifier.
          if (timing.verify ?? true) {
            yield { status: statusLine(ref, "Checking the result") };
            verdict = await runVerifier(ctx, job.id, stopped, timing.verifierMs);
          }
          const modelCheck = verdict === "stopped" ? undefined : verdict;
          let written: WriterOutput | undefined | "stopped";
          if (timing.write && timing.writerMs > 0 && verdict !== "stopped") {
            yield { status: statusLine(ref, "Writing the result") };
            written = await runWriter(ctx, job.id, modelCheck, stopped, timing.writerMs);
          }
          // Stopped while checking or writing: the work is done, so it ends as done with what
          // is ready, and the template.
          const end = await finish(job.id, modelCheck, written === "stopped" ? undefined : written);
          await endRun(ctx.session.id, job.id, end.status, end.lastMessage, end.concerns);
          if (inChannel) await channelStatus(job.id, "active");
          return {
            job: ref,
            status: end.status,
            threadId,
            ...POSTED,
          };
        }

        if (inChannel && result.questions.length > 0) await channelStatus(job.id, "suspended");
        for (const question of result.questions) {
          if (inChannel) await linkQuestion(job.id, question);
          const answers = await askQuestion(ctx.ask, ref, question, stopped);
          if (answers === "stopped") {
            await cancel(job.id);
            if (inChannel) await channelStatus(job.id, "active");
            return { job: ref, status: "cancelled", threadId, ...POSTED };
          }
          if (answers) await answer(job.id, question.requestId, answers);
        }
        // Eve sets the channel's status for each brain turn there, so the job sets its own again
        // after every check.
        if (inChannel && !result.terminal) await channelStatus(job.id, "processing");

        if (result.terminal) {
          await endRun(ctx.session.id, job.id, result.status, result.lastMessage);
          if (inChannel) await channelStatus(job.id, "active");
          return {
            job: ref,
            status: result.status,
            threadId,
            ...POSTED,
          };
        }
      }
    } catch (error) {
      // A failed task must not leave the job looking like it still runs.
      const status = await markFailed(
        job.id,
        error instanceof Error ? error.message : String(error),
      );
      await endRun(ctx.session.id, job.id, status, null);
      await channelStatus(job.id, "active").catch(() => {});
      throw error;
    }
  },
});

type Ask = WorkflowToolContext["ask"];

// Runs the `verifier` subagent in the workflow body: `ctx.agent` is not available in a step. A
// failure, a malformed reply, or a timeout gives an unavailable check, so the result still posts.
async function runVerifier(
  ctx: WorkflowToolContext,
  jobId: number,
  stopped: Promise<"stopped">,
  timeoutMs: number,
): Promise<ModelCheck | undefined | "stopped"> {
  const message = await verifierInput(jobId);
  if (!message) return undefined;
  const reply = (async () => {
    const response = await ctx
      .agent("verifier")
      .send(message, { outputSchema: VerifierOutput, signal: ctx.abortSignal });
    return response.result();
  })();
  // A reply that fails after a timeout or a stop must not surface as an unhandled rejection.
  reply.catch(() => undefined);
  try {
    const outcome = await Promise.race([
      reply,
      sleep(timeoutMs).then(() => "timeout" as const),
      stopped,
    ]);
    if (outcome === "stopped") return "stopped";
    if (outcome === "timeout") return unavailable("The model check timed out.");
    if (outcome.status === "failed" || outcome.data === undefined) {
      return unavailable(outcome.error?.message ?? "The verifier gave no verdict.");
    }
    // finishJob parses the reply again, so a wrong shape becomes an unavailable check.
    return { status: "checked", output: outcome.data as VerifierOutput };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

// Runs the `writer` subagent in the workflow body, like the verifier. A failure, a malformed
// reply, or a timeout gives nothing, and the result posts with the template.
async function runWriter(
  ctx: WorkflowToolContext,
  jobId: number,
  check: ModelCheck | undefined,
  stopped: Promise<"stopped">,
  timeoutMs: number,
): Promise<WriterOutput | undefined | "stopped"> {
  // A failed input read, such as an unreadable persona file, gets the template.
  const message = await writerInput(jobId, check).catch(() => null);
  if (!message) return undefined;
  const reply = (async () => {
    const response = await ctx
      .agent("writer")
      .send(message, { outputSchema: WriterOutput, signal: ctx.abortSignal });
    return response.result();
  })();
  reply.catch(() => undefined);
  try {
    const outcome = await Promise.race([
      reply,
      sleep(timeoutMs).then(() => "timeout" as const),
      stopped,
    ]);
    if (outcome === "stopped") return "stopped";
    if (outcome === "timeout" || outcome.status === "failed") return undefined;
    // finishJob parses the text again, so a wrong shape gets the template.
    return outcome.data as WriterOutput | undefined;
  } catch {
    return undefined;
  }
}

function unavailable(reason: string): ModelCheck {
  return { status: "unavailable", reason };
}

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
  const verify = verifierEnabled();
  const verifierMs = seconds("SYM_VERIFIER_TIMEOUT_SECONDS", VERIFIER_SECONDS) * 1000;
  // The verifier and the writer run one after the other in `checking`. Together they stay under
  // the watch lease with a minute to spare, so reconcile does not finish the job first.
  const writerRoom = WATCH_LEASE_MS - 60_000 - (verify ? verifierMs : 0);
  return {
    pollMs: seconds("SYM_JOB_POLL_SECONDS", POLL_SECONDS) * 1000,
    afterCallbackMs:
      seconds("SYM_JOB_POLL_AFTER_CALLBACK_SECONDS", POLL_AFTER_CALLBACK_SECONDS) * 1000,
    verifierMs,
    writerMs: Math.max(
      0,
      Math.min(seconds("SYM_WRITER_TIMEOUT_SECONDS", WRITER_SECONDS) * 1000, writerRoom),
    ),
    verify: verify as boolean | undefined,
    write: writerEnabled() as boolean | undefined,
  };
}

async function projectRefusal(project: string): Promise<string | undefined> {
  "use step";
  return checkProject(allowedFromEnv(), project);
}

// A scheduled run that is refused has no job. The digest shows it as failed.
async function endRefusedRun(sessionId: string) {
  "use step";
  await finishRunForSession(ledger(), sessionId, "failed");
}

async function recordJob(brief: Brief, callId: string, sessionId: string) {
  "use step";
  // A tool call ID is unique only inside its session, so the session scopes the key.
  const requestKey = `${sessionId}:${callId}`;
  const job = await startJob(ledger(), { requestKey, sessionId, brief });
  // The job class for the trust ladder: the approved playbook the brief names, if any.
  await linkPlaybook(ledger(), job.id, brief.playbook);
  return { id: job.id };
}

// The name of the trusted playbook that lets this job start without the click, or null. Only a
// person's turn qualifies: a worker thread or an app session never starts a trusted job.
async function trustedStart(
  jobId: number,
  caller: SessionAuthContext | null | undefined,
): Promise<string | null> {
  "use step";
  if (!slackUserOfPrincipal(caller?.principalId)) return null;
  const sql = ledger();
  const playbook = await trustedPlaybookOf(sql, jobId);
  if (!playbook) return null;
  await markAutoStarted(sql, jobId);
  return playbook.name;
}

async function markScheduled(jobId: number) {
  "use step";
  await markScheduledCheck(ledger(), jobId);
}

async function postBrief(jobId: number, trustedPlaybook: string | null) {
  "use step";
  await showBrief(ledgerDeps(), jobId, trustedPlaybook ?? undefined);
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

// `verify` is undefined for a run that started before the writer existed: read it here then.
async function check(jobId: number, verify: boolean | undefined, write: boolean) {
  "use step";
  return withJobDeps((deps) =>
    checkJob(deps, jobId, WAIT_MS, { verify: verify ?? verifierEnabled(), write }),
  );
}

async function verifierInput(jobId: number) {
  "use step";
  return verifierRequest(ledgerDeps(), jobId);
}

// The persona and the learned rows are read here, in the step, so a replay sees the same text.
async function writerInput(jobId: number, check: ModelCheck | undefined) {
  "use step";
  const sql = ledger();
  let persona: string | null = null;
  try {
    const stored = await storedPersonaOrNone(ledger);
    persona = personaInstructions({
      ...(stored ? { stored } : {}),
      env: process.env.SYM_PERSONA,
      pack: pack(),
    });
  } catch (error) {
    // Like the brain's persona loader: a failed read writes without a persona.
    console.warn("writer: could not load the persona", error);
  }
  const learned = sessionInstructions(await approvedForSession(sql).catch(() => []));
  return writerRequest(ledgerDeps(), jobId, { persona, learned }, check);
}

// True when the job now lives in its own code channel, so later steps know to keep it current.
async function toCodeChannel(jobId: number): Promise<boolean> {
  "use step";
  const deps = ledgerDeps();
  const job = await getJob(deps.sql, jobId);
  return job ? (await moveToCodeChannel(deps, job)).codeChannel : false;
}

async function linkQuestion(jobId: number, question: WorkerQuestion) {
  "use step";
  const deps = ledgerDeps();
  const job = await getJob(deps.sql, jobId);
  if (!job?.codeChannel) return;
  await pointToQuestion(deps, job, question.requestId, question.questions[0]?.prompt ?? "");
  await deliverNow(deps);
}

// The code channel's status follows the job; at the end the context bar gains the pull request.
async function channelStatus(jobId: number, status: SessionStatus) {
  "use step";
  const deps = ledgerDeps();
  const job = await getJob(deps.sql, jobId);
  if (!job?.codeChannel) return;
  await setChannelStatus(deps, job, status);
  if (status === "active") await setContextBar(deps, job);
}

async function finish(jobId: number, verdict: ModelCheck | undefined, written?: WriterOutput) {
  "use step";
  return finishJob(ledgerDeps(), jobId, verdict, written);
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
  return failJob(ledgerDeps(), jobId, reason);
}

// True only for a run the owner approved ahead of time (decision 024). The initiator travels in
// as data, and the principal check, the row lookup, and the brief comparison run in this step.
async function isPreApproved(
  schedule: string | undefined,
  brief: unknown,
  initiator: SessionAuthContext | null | undefined,
  sessionId: string,
  jobId: number,
): Promise<boolean> {
  "use step";
  const id = schedule ? parseScheduleRef(schedule) : undefined;
  if (id === undefined || !isScheduleAuth(initiator)) return false;
  const sql = ledger();
  const allowed = canSkipStart({
    isSchedulePrincipal: true,
    schedule: await getSchedule(sql, id),
    brief,
  });
  // The approval covers one job of this session's own run, once. Another job, or a run of
  // another schedule, gets the normal Start prompt.
  return allowed && (await claimRunWhenAttached(sql, sessionId, id, jobId));
}

async function linkRun(sessionId: string, jobId: number) {
  "use step";
  await finishRunForSession(ledger(), sessionId, "started", jobId);
}

// Records how a scheduled run ended for the digest. A session without a run row is not a
// scheduled run, so the update changes nothing. `concerns` comes from finishJob when the job
// went through the model check; otherwise the rule checks run here.
async function endRun(
  sessionId: string,
  jobId: number,
  status: string,
  lastMessage: string | null,
  concerns?: string[],
) {
  "use step";
  const contract = parseOutputContract(lastMessage);
  const job = concerns ? undefined : await getJob(ledger(), jobId);
  concerns ??= job ? resultConcerns(job, contract, pack()) : [];
  await finishRunForSession(ledger(), sessionId, runOutcome(status, contract, concerns), jobId);
}
