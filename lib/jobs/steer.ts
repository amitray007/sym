import { getJobByRef, type Job, jobRef, updateJob } from "../ledger/jobs.ts";
import { workerNoun } from "../worker-label.ts";
import type { SendMode, WorkerAnswers } from "../workers/types.ts";
import { answerQuestion, cancelJob, type JobDeps } from "./run.ts";
import { shortHash } from "./worker-calls.ts";

// Steering and stopping from the job thread (docs/architecture.md, flow 5). The text comes from
// a person in Slack, so it is data: Sym cleans and caps it before the worker sees it.

export const STEER_TEXT_MAX = 1_000;
const SUMMARY_TEXT_MAX = 80;
const FINISHED = new Set(["done", "failed", "cancelled"]);

// Drops control characters, collapses whitespace, and cuts to the cap.
export function cleanSteerText(text: string): string {
  const spaced = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? " " : ch;
  }).join("");
  const plain = spaced.replace(/\s+/g, " ").trim();
  return plain.length <= STEER_TEXT_MAX ? plain : `${plain.slice(0, STEER_TEXT_MAX - 1)}…`;
}

// One steering request is one tool call, so the call ID keys it: a re-run of that call sends
// once, and the same words said again later are a new request. Without a call ID, the text keys
// it.
export function steerRequestId(ref: string, text: string, callId?: string): string {
  const key = callId ?? text;
  return `steer-${ref}-${shortHash(key)}`;
}

type Found = { job: Job } | { answer: string };

async function findActive(deps: JobDeps, ref: string): Promise<Found> {
  const job = await getJobByRef(deps.sql, ref);
  if (!job) return { answer: `There is no job ${ref}.` };
  const name = jobRef(job.id);
  if (FINISHED.has(job.status)) return { answer: `${name} already finished (${job.status}).` };
  if (!job.workerThreadId) return { answer: `${name} has not started yet. Nothing to steer.` };
  return { job };
}

export async function steerJob(
  deps: JobDeps,
  ref: string,
  text: string,
  mode: SendMode = "steer",
  callId?: string,
  answer?: { requestId?: string | undefined; answers?: WorkerAnswers | undefined },
): Promise<string> {
  const found = await findActive(deps, ref);
  if ("answer" in found) return found.answer;
  const { job } = found;
  const name = jobRef(job.id);
  const clean = cleanSteerText(text);
  if (!clean) return "Nothing to send. Say what should change.";
  if (job.status === "waiting_input" || answer?.requestId || answer?.answers) {
    const pending = await deps.worker.pendingQuestions(job.workerThreadId as string);
    const question = answer?.requestId
      ? pending.find((q) => q.requestId === answer.requestId)
      : pending.length === 1
        ? pending[0]
        : undefined;
    if (!question)
      return `I couldn't match that to one pending question for ${name}. Ask me which question is waiting.`;
    const answers =
      answer?.answers ??
      (question.questions.length === 1 && question.questions[0]
        ? { [question.questions[0].id]: clean }
        : undefined);
    if (!answers)
      return `There are several parts to ${name}'s question. Which answers should I send?`;
    const sent = await answerQuestion(deps, job.id, question.requestId, answers);
    return sent
      ? `I passed your answer to ${name}'s ${workerNoun()}.`
      : `That question for ${name} is no longer waiting.`;
  }
  await deps.worker.send(
    job.workerThreadId as string,
    `Direction from the person in the Slack thread: ${clean}`,
    mode,
    steerRequestId(name, clean, callId),
  );
  const short =
    clean.length <= SUMMARY_TEXT_MAX ? clean : `${clean.slice(0, SUMMARY_TEXT_MAX - 1)}…`;
  await updateJob(deps.sql, job.id, { lastSummary: `I passed on: ${short}` });
  return `Sent to ${name}'s ${workerNoun()}: ${short}`;
}

export async function stopJob(deps: JobDeps, ref: string): Promise<string> {
  const found = await findActive(deps, ref);
  if ("answer" in found) return found.answer;
  const name = jobRef(found.job.id);
  await cancelJob(deps, found.job.id);
  return `Stopped ${name}.`;
}
