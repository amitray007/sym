import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { recordFeedback } from "../feedback/feedback.ts";
import { getJobByRef, type Job, jobRef, json } from "../ledger/jobs.ts";
import { dropPost, enqueuePost, latestPost } from "../ledger/outbox.ts";
import { archiveCodeChannel, setChannelStatus } from "../slack/code-channel.ts";
import { workerNoun } from "../worker-label.ts";
import { Brief } from "./brief.ts";
import { RESULT_ACTION_IDS } from "./card.ts";
import { presentStart } from "./present.ts";
import { answeredPrompt, type PromptKind, promptPost } from "./prompts.ts";
import { deliverNow, endWithoutWorker, type JobDeps, JobSetupError, planLaunch } from "./run.ts";
import { cleanSteerText } from "./steer.ts";
import { workerCallbackInstructions, workerCapabilityEndpoint } from "./worker-capabilities.ts";

// The buttons on a finished job's result (decision 056). Fix continues the job's worker thread as
// a new job; Close settles the thread. A new job keeps the ledger simple: a finished job never
// runs again, and reconcile drives the follow-up like any job no task watches.

const FIXABLE = new Set(["done", "failed"]);
const TERMINAL = ["done", "failed", "cancelled"];
const TITLE_MAX = 80;

export interface FollowUpResult {
  answer: string;
  job?: Job;
}

// The message the worker thread gets. The person's words are data, so Sym cleans them, and the
// brief's limits still apply.
export function followUpMessage(
  ref: string,
  parentRef: string,
  text: string,
  brief: Brief,
  guardrails?: string[],
): string {
  const delivery = brief.openPullRequest
    ? "Commit on this worktree's branch, push it, and open a draft pull request."
    : "Commit on this worktree's branch. Do not push and do not open a pull request.";
  const rules = guardrails ?? ["Keep production systems and customer data read-only.", delivery];
  const constraints = [...brief.constraints, "Work only in this worktree.", ...rules]
    .map((rule) => `- ${rule}`)
    .join("\n");
  return `This is Sym job ${ref}, a follow-up on ${parentRef} in this thread.

A person in the Slack thread asked for this change:
${text}

Keep the brief constraints below. The current project rules below replace earlier project rules:
${constraints}

When you finish, end your last message with one JSON block in this shape:
\`\`\`json
{"summary": "", "pr_url": null, "tests": "", "files_changed": [], "open_questions": []}
\`\`\``;
}

export async function startFollowUp(
  deps: JobDeps,
  parentRef: string,
  text: string,
  by: string,
  requestId: string,
): Promise<FollowUpResult> {
  const parent = await getJobByRef(deps.sql, parentRef);
  if (!parent) return { answer: `There is no job ${parentRef}.` };
  const name = jobRef(parent.id);
  if (!FIXABLE.has(parent.status)) {
    return {
      answer:
        parent.status === "cancelled"
          ? `${name} was cancelled. Ask for a new job instead.`
          : `${name} is still running. Steer it instead.`,
    };
  }
  if (!parent.workerThreadId) return { answer: `${name} never reached the ${workerNoun()}.` };
  if (await isClosed(deps.sql, parent.id)) return { answer: `${name} is closed.` };
  const clean = cleanSteerText(text);
  if (!clean) return { answer: "Nothing to send. Say what should change." };

  const requestKey = `fix:${requestId}`;
  const [earlier] = await deps.sql<{ id: number }[]>`
    select id from jobs where request_key = ${requestKey}
  `;
  if (earlier) return { answer: `Already sent as ${jobRef(Number(earlier.id))}.` };
  // One job reads a worker thread at a time, so their results do not mix.
  const [busy] = await deps.sql<{ id: number }[]>`
    select id from jobs
    where worker_thread_id = ${parent.workerThreadId} and status not in ${deps.sql(TERMINAL)}
    limit 1
  `;
  if (busy) {
    return {
      answer: `${jobRef(Number(busy.id))} is still working in this thread. Steer it instead.`,
    };
  }

  const later = await laterJob(deps.sql, parent);
  if (later) return { answer: `${later} continued this thread. Use its buttons instead.` };

  const brief = Brief.parse(parent.brief);
  if (!parent.workerIdentity || parent.workerIdentity !== deps.workerIdentity) {
    return { answer: `${name}'s worker has changed or is unknown. Ask for a new job instead.` };
  }
  let plan: Awaited<ReturnType<typeof planLaunch>>;
  try {
    plan = await planLaunch(deps, brief);
  } catch (error) {
    if (error instanceof JobSetupError) return { answer: error.message };
    throw error;
  }
  if (!parent.workerProjectId || parent.workerProjectId !== plan.projectId) {
    return { answer: `${name}'s worker project has changed. Ask for a new job instead.` };
  }
  const title = clip(`Fix: ${parent.title}`, TITLE_MAX);
  let job: Job;
  try {
    job = await insertFollowUp(deps.sql, parent, requestKey, {
      ...plan.brief,
      title,
      goal: `${brief.goal}\n\nFollow-up: ${clean}`,
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    // The same Enter twice at once collides on the request key; two Fixes at once collide on
    // the index of active jobs per thread. Either way only one job starts.
    const [same] = await deps.sql<{ id: number }[]>`
      select id from jobs where request_key = ${requestKey}
    `;
    if (same) return { answer: `Already sent as ${jobRef(Number(same.id))}.` };
    return { answer: "Another job just started in this thread. Steer it instead." };
  }
  const ref = jobRef(job.id);
  try {
    const endpoint = await workerCapabilityEndpoint(deps.sql, parent.id);
    const tools = endpoint ? await workerCallbackInstructions(deps.sql, job.id, endpoint) : "";
    await deps.worker.send(
      parent.workerThreadId,
      `${followUpMessage(ref, name, clean, plan.brief, plan.guardrails)}\n\n${tools}`,
      "auto",
      requestKey,
    );
  } catch (error) {
    const reason = `The ${workerNoun()} did not take the follow-up: ${(error as Error).message}`;
    // Free the request key, so the same box can try again.
    await deps.sql`update jobs set request_key = ${`${requestKey}:failed:${job.id}`} where id = ${job.id}`;
    await endWithoutWorker(deps, job, "failed", reason);
    return { answer: `${ref} could not start. ${reason}`, job };
  }

  // A fix is feedback on the parent job: the weekly learn pass groups repeated fixes.
  await recordFeedback(
    deps.sql,
    {
      jobId: parent.id,
      slackUser: by,
      kind: "fix",
      value: clean,
      channel: parent.slackChannel,
      messageTs: null,
    },
    deps.pack,
  );
  await presentStart(deps.sql, job, deps.now?.() ?? new Date(), deps.pack);
  // A follow-up in a code channel shows it is working again. Reconcile sets it back at the end.
  await setChannelStatus(deps, job, "processing");
  await editEndPost(deps.sql, parent, `Fix sent as ${ref} by <@${by}>.`);
  await deliverNow(deps);
  return { answer: `Sent to the ${workerNoun()} as ${ref}.`, job };
}

// The follow-up starts on the parent's thread, after the parent's last read. No task watches it:
// a one-minute lease keeps reconcile away until the send lands, and then reconcile takes it
// over. It also takes over the parent's pull request watch, so a later wake posts once, under
// the follow-up.
async function insertFollowUp(sql: Sql, parent: Job, requestKey: string, brief: Brief) {
  const [row] = await sql<{ id: number }[]>`
    insert into jobs (
      request_key, session_id, kind, title, owner, slack_channel, slack_thread_ts, code_channel, brief, worker,
      worker_project_id, worker_identity, worker_thread_id, worker_model, cursor, status, started_at, parent_job_id,
      pr_url, pr_watched_url, pr_wake_cursor, watch_until
    )
    select
      ${requestKey}, session_id, 'code-change', ${brief.title}, owner, slack_channel,
      slack_thread_ts, code_channel, ${json(sql, brief)}, worker, worker_project_id, worker_identity, worker_thread_id,
      worker_model, cursor, 'running', now(), id, pr_url, pr_watched_url, pr_wake_cursor,
      now() + interval '1 minute'
    from jobs where id = ${parent.id}
    returning id
  `;
  const job = row && (await getJobByRef(sql, jobRef(Number(row.id))));
  if (!job) throw new Error("insert into jobs returned no row");
  return job;
}

export async function closeJob(deps: JobDeps, ref: string, by: string): Promise<string> {
  const job = await getJobByRef(deps.sql, ref);
  if (!job) return `There is no job ${ref}.`;
  const name = jobRef(job.id);
  if (!TERMINAL.includes(job.status)) return `${name} is still running. Stop it first.`;
  // Settling a thread that a follow-up continued would settle the follow-up's work too.
  const later = await laterJob(deps.sql, job);
  if (later) return `${later} continued this thread. Close it instead.`;
  await deps.sql`
    update jobs set closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, ${by}),
      archive_state = case when code_channel and archive_state = 'none' then 'pending' else archive_state end
    where id = ${job.id}
  `;
  const answer = await completeClosure(deps, job.id);
  await deliverNow(deps);
  return answer;
}

// Close acceptance stops PR following through closed_at. External settlement and archive are
// separate confirmed facts. A row lock serializes retries; a restart resumes the unfinished steps.
async function completeClosure(deps: JobDeps, id: number): Promise<string> {
  return deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    await sql`select id from jobs where id = ${id} for update`;
    const job = await getJobByRef(sql, jobRef(id));
    if (!job?.closedAt) return `${jobRef(id)} has no close request.`;
    const local = { ...deps, sql };
    const ref = jobRef(id);
    if (!job.workerSettledAt) {
      if (job.workerThreadId) {
        if (!deps.worker.settle) {
          await closureNotice(
            local,
            job,
            "I couldn't settle the worker thread. Its connection needs repair.",
          );
          return `I stopped following ${ref}, but its worker thread still needs to be settled.`;
        }
        try {
          await deps.worker.settle(job.workerThreadId);
        } catch {
          await closureNotice(local, job, "I couldn't settle the worker thread. I'll retry.");
          return `I stopped following ${ref}, but couldn't settle its worker thread. I'll retry.`;
        }
      }
      await sql`update jobs set worker_settled_at = now() where id = ${id}`;
    }
    if (job.codeChannel && job.archiveState !== "archived") {
      const missing = !job.slackChannel ? "missing_channel" : !deps.slack ? "missing_client" : null;
      const [end] = await sql<{ slackTs: string | null }[]>`
        select slack_ts from outbox
        where job_id = ${id} and idempotency_key = ${`${ref}:end`} and status = 'sent'
      `;
      const archived = !missing && (await archiveCodeChannel(local, job, end?.slackTs ?? null));
      if (!archived) {
        await sql`update jobs set archive_state = ${missing ? "repair" : "pending"},
          archive_error = ${missing ?? "archive_failed"} where id = ${id}`;
        const text =
          missing === "missing_channel"
            ? `I couldn't archive ${ref}: its channel ID is missing. The saved job needs repair.`
            : missing === "missing_client"
              ? `I couldn't archive ${ref}: the Slack connection is missing. It needs repair.`
              : `I couldn't archive this channel for ${ref}. I'll retry.`;
        await closureNotice(local, job, text);
        return `I settled ${ref}'s worker thread and stopped following its PR. ${text}`;
      }
      await sql`update jobs set archive_state = 'archived', archive_error = null where id = ${id}`;
    }
    await clearClosureNotice(local, job);
    // No success stamp before external confirmation. Keep the existing result and its links.
    await editEndPost(
      sql,
      job,
      job.codeChannel
        ? `I've closed ${ref} and archived its channel.`
        : `I've closed ${ref} and stopped following its PR.`,
    );
    return job.codeChannel ? `Closed ${ref} and archived its channel.` : `Closed ${ref}.`;
  });
}

export async function retryClosures(deps: JobDeps): Promise<void> {
  const jobs = await deps.sql<{ id: number }[]>`
    select id from jobs where closed_at is not null
      and (worker_settled_at is null or archive_state in ('pending', 'repair'))
    order by id limit 20
  `;
  for (const job of jobs) await completeClosure(deps, Number(job.id));
}

async function closureNotice(deps: JobDeps, job: Job, text: string): Promise<void> {
  // A broken channel binding can still be explained in the saved origin conversation.
  const channel = job.slackChannel ?? job.originChannel;
  if (!channel) {
    await deps.sql`update jobs set archive_state = 'repair', archive_error = 'missing_channel' where id = ${job.id}`;
    console.warn(`Sym cannot deliver the repair notice for ${jobRef(job.id)}: no channel ID.`);
    return;
  }
  await enqueuePost(deps.sql, {
    idempotencyKey: `${jobRef(job.id)}:archive-retry`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: {
      channel,
      ...((job.slackThreadTs ?? job.originThreadTs)
        ? { thread_ts: job.slackThreadTs ?? job.originThreadTs }
        : {}),
      text,
    },
    display: promptDisplay(job, true),
  });
}

async function clearClosureNotice(deps: JobDeps, job: Job): Promise<void> {
  const ref = jobRef(job.id);
  const notice = await latestPost(deps.sql, job.id, `${ref}:archive-retry`);
  if (!notice) return;
  if (notice.status === "pending") {
    await dropPost(deps.sql, notice.id, "Closure completed before the notice was sent");
  } else if (notice.status === "sent" && notice.slackTs) {
    const payload = notice.payload as { channel: string };
    await enqueuePost(deps.sql, {
      idempotencyKey: `${ref}:archive-recovered`,
      jobId: job.id,
      method: "chat.update",
      payload: {
        channel: payload.channel,
        ts: notice.slackTs,
        text: job.codeChannel ? `I've archived ${ref}'s channel.` : `I've closed ${ref}.`,
        blocks: [],
      },
      display: promptDisplay(job, false),
    });
  }
}

// The newest later job on the same worker thread, such as a follow-up, as a reference.
async function laterJob(sql: Sql, job: Job): Promise<string | undefined> {
  if (!job.workerThreadId) return undefined;
  const [row] = await sql<{ id: number }[]>`
    select id from jobs
    where worker_thread_id = ${job.workerThreadId} and id > ${job.id}
    order by id desc limit 1
  `;
  return row ? jobRef(Number(row.id)) : undefined;
}

export async function isClosed(sql: Sql, jobId: number): Promise<boolean> {
  const [row] = await sql<{ closed: boolean }[]>`
    select closed_at is not null as closed from jobs where id = ${jobId}
  `;
  return row?.closed === true;
}

// Edits the job's sent result message: its Looks good, Fix, and Close buttons go, the Open PR
// button stays, and a note says what happened. The edit keeps the result post's display.
export async function editEndPost(sql: Sql, job: Job, note: string): Promise<void> {
  const ref = jobRef(job.id);
  const [post] = await sql<
    {
      payload: { channel?: string; text?: string; blocks?: Record<string, unknown>[] };
      slackTs: string;
      display: never;
    }[]
  >`
    select payload, slack_ts, display from outbox
    where idempotency_key = ${`${ref}:end`} and status = 'sent' and slack_ts is not null
  `;
  if (!post?.payload.channel) return;
  // A second note, such as Close after a Fix, keeps the first: start from the latest edit.
  const [edited] = await sql<{ payload: { blocks?: Record<string, unknown>[] } }[]>`
    select payload from outbox
    where job_id = ${job.id} and starts_with(idempotency_key, ${`${ref}:end-edit:`})
    order by id desc limit 1
  `;
  const blocks = [
    ...withoutResultButtons(edited?.payload.blocks ?? post.payload.blocks ?? []),
    { type: "context", elements: [{ type: "mrkdwn", text: note }] },
  ];
  await enqueuePost(sql, {
    idempotencyKey: `${ref}:end-edit:${note}`,
    jobId: job.id,
    method: "chat.update",
    payload: {
      channel: post.payload.channel,
      ts: post.slackTs,
      text: post.payload.text ?? "",
      blocks,
    },
    display: post.display,
  });
}

function withoutResultButtons(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  return blocks.flatMap((block) => {
    if (block.type !== "actions" || !Array.isArray(block.elements)) return [block];
    const kept = (block.elements as { action_id?: string }[]).filter(
      (element) => !RESULT_ACTION_IDS.includes(element.action_id ?? ""),
    );
    return kept.length > 0 ? [{ ...block, elements: kept }] : [];
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Posts the Steer or Fix text box in the job thread, or says why not. One box per person and
// minute, so a double click posts once.
export async function postPrompt(
  deps: JobDeps,
  kind: PromptKind,
  ref: string,
  by: string,
): Promise<string | undefined> {
  const job = await getJobByRef(deps.sql, ref);
  if (!job?.slackChannel) return `There is no job ${ref}.`;
  const name = jobRef(job.id);
  if (!job.workerThreadId) return `${name} has not started yet.`;
  if (kind === "steer" && TERMINAL.includes(job.status)) return `${name} already finished.`;
  if (kind === "fix") {
    if (!FIXABLE.has(job.status)) return `${name} cannot take a fix now.`;
    if (await isClosed(deps.sql, job.id)) return `${name} is closed.`;
    const later = await laterJob(deps.sql, job);
    if (later) return `${later} continued this thread. Use its buttons instead.`;
  }
  const post = promptPost(kind, name);
  const minute = Math.floor((deps.now?.() ?? new Date()).getTime() / 60_000);
  await enqueuePost(deps.sql, {
    idempotencyKey: `${name}:${kind}-prompt:${by}:${minute}`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: {
      channel: job.slackChannel,
      ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
      ...post,
    },
    display: promptDisplay(job, true),
  });
  await deliverNow(deps);
  return undefined;
}

// Replaces a sent text box with what the person wrote and what Sym did with it.
export async function answerPrompt(
  deps: JobDeps,
  job: Job,
  where: { channel: string; ts: string },
  by: string,
  text: string,
  outcome: string,
): Promise<void> {
  await enqueuePost(deps.sql, {
    idempotencyKey: `prompt-answer:${where.channel}:${where.ts}`,
    jobId: job.id,
    method: "chat.update",
    payload: { channel: where.channel, ts: where.ts, ...answeredPrompt(by, text, outcome) },
    display: promptDisplay(job, false),
  });
  await deliverNow(deps);
}

function promptDisplay(job: Job, isNew: boolean) {
  return chooseDisplay({
    kind: job.kind,
    needsAction: true,
    isNew,
    estMinutes: 0,
    steps: 0,
    lines: 1,
    surface: /^D/.test(job.slackChannel ?? "") ? "dm" : "channel",
    quiet: false,
  });
}
