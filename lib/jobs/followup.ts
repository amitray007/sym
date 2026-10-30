import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { recordFeedback } from "../feedback/feedback.ts";
import { getJob, getJobByRef, type Job, jobRef, json } from "../ledger/jobs.ts";
import { dropPost, enqueuePost, latestPost } from "../ledger/outbox.ts";
import { proposalBlocks, propose } from "../ledger/proposals.ts";
import { archiveCodeChannel, setChannelStatus } from "../slack/code-channel.ts";
import { workerNoun } from "../worker-label.ts";
import { Brief } from "./brief.ts";
import { RESULT_ACTION_IDS } from "./card.ts";
import { escapeMrkdwn } from "./messages.ts";
import { presentStart } from "./present.ts";
import { answeredPrompt, type PromptKind } from "./prompts.ts";
import { deliverNow, type JobDeps, JobSetupError, planLaunch } from "./run.ts";
import { cleanSteerText } from "./steer.ts";
import { workerCallbackInstructions, workerCapabilityEndpoint } from "./worker-capabilities.ts";

// The buttons on a finished job's result (decision 056). Fix continues the job's worker thread as
// a new job; Close settles the thread. A new job keeps the ledger simple: a finished job never
// runs again, and reconcile drives the follow-up like any job no task watches.

const FIXABLE = new Set(["done", "failed"]);
const TERMINAL = ["done", "failed", "cancelled"];
const TITLE_MAX = 80;
// Serialize one child's idempotent send and boundary write.
const FOLLOWUP_SEND_LOCK = 4_242_003;

export interface FollowUpResult {
  answer: string;
  job?: Job;
  refused?: true;
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

When you finish, write a short human report, then end your last message with one JSON block in this shape:
\`\`\`json
{"summary": "", "pr_url": null, "tests": "", "tests_status": "unknown", "ci_status": "unknown", "files_changed": [], "open_questions": []}
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
  if (!parent) return { refused: true, answer: "I couldn't find that work." };
  if (!FIXABLE.has(parent.status)) {
    return {
      refused: true,
      answer:
        parent.status === "cancelled"
          ? "This was cancelled. Ask for new work instead."
          : "I'm still working on this. Tell me what to change and I'll pass it on.",
    };
  }
  if (!parent.workerThreadId)
    return { refused: true, answer: `This never reached the ${workerNoun()}.` };
  if (await isClosed(deps.sql, parent.id)) return { refused: true, answer: "This is closed." };
  const clean = cleanSteerText(text);
  if (!clean) return { refused: true, answer: "Nothing to send. Say what should change." };

  const requestKey = `fix:${requestId}`;
  const [earlier] = await deps.sql<Job[]>`select * from jobs where request_key = ${requestKey}`;
  if (earlier) {
    const existing = await getJob(deps.sql, Number(earlier.id));
    if (existing?.followupSentAt) {
      return { answer: "I already sent that follow-up.", job: existing };
    }
    if (existing?.status === "cancelled")
      return { refused: true, answer: existing.lastSummary ?? "That follow-up was cancelled." };
    let plan: Awaited<ReturnType<typeof planLaunch>>;
    try {
      plan = await planLaunch(deps, Brief.parse(parent.brief));
    } catch (error) {
      if (error instanceof JobSetupError) return { refused: true, answer: error.message };
      throw error;
    }
    if (
      !existing ||
      !parent.workerIdentity ||
      parent.workerIdentity !== deps.workerIdentity ||
      parent.workerProjectId !== plan.projectId
    )
      return { refused: true, answer: "The worker or project changed. Ask for a new job." };
    return sendFollowUp(deps, parent, existing, clean, by, requestKey, plan.brief, plan.guardrails);
  }
  // One job reads a worker thread at a time, so their results do not mix.
  const [busy] = await deps.sql<Job[]>`
    select * from jobs
    where worker_thread_id = ${parent.workerThreadId} and status not in ${deps.sql(TERMINAL)}
    limit 1
  `;
  if (busy?.requestKey === requestKey) {
    return {
      answer: "I already recorded that follow-up.",
      job: { ...busy, id: Number(busy.id) },
    };
  }
  if (busy) {
    return {
      refused: true,
      answer: "I'm still working on this. Tell me what to change and I'll pass it on.",
    };
  }

  const later = await laterJob(deps.sql, parent);
  if (later) {
    // The same request may have inserted its child after our earlier request-key lookup.
    const [same] = await deps.sql<Job[]>`select * from jobs where request_key = ${requestKey}`;
    if (same)
      return {
        answer: "I already recorded that follow-up.",
        job: { ...same, id: Number(same.id) },
      };
    return { refused: true, answer: "A follow-up continued this thread. Use the latest work." };
  }

  const brief = Brief.parse(parent.brief);
  if (!parent.workerIdentity || parent.workerIdentity !== deps.workerIdentity) {
    return {
      refused: true,
      answer: "The worker has changed or is unknown. Ask for new work instead.",
    };
  }
  let plan: Awaited<ReturnType<typeof planLaunch>>;
  try {
    plan = await planLaunch(deps, brief);
  } catch (error) {
    if (error instanceof JobSetupError) return { refused: true, answer: error.message };
    throw error;
  }
  if (!parent.workerProjectId || parent.workerProjectId !== plan.projectId) {
    return {
      refused: true,
      answer: "The worker project has changed. Ask for new work instead.",
    };
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
    if (error instanceof JobSetupError) return { refused: true, answer: error.message };
    if ((error as { code?: string }).code !== "23505") throw error;
    // The same Enter twice at once collides on the request key; two Fixes at once collide on
    // the index of active jobs per thread. Either way only one job starts.
    const [same] = await deps.sql<Job[]>`select * from jobs where request_key = ${requestKey}`;
    if (same)
      return {
        answer: "I already recorded that follow-up.",
        job: { ...same, id: Number(same.id) },
      };
    return { refused: true, answer: "Another job just started in this thread. Steer it instead." };
  }
  return sendFollowUp(deps, parent, job, clean, by, requestKey, plan.brief, plan.guardrails);
}

async function sendFollowUp(
  deps: JobDeps,
  parent: Job,
  job: Job,
  clean: string,
  by: string,
  requestKey: string,
  brief: Brief,
  guardrails?: string[],
): Promise<FollowUpResult> {
  const lock = await deps.sql.reserve();
  let result: FollowUpResult;
  try {
    await lock`select pg_advisory_lock(${FOLLOWUP_SEND_LOCK}, ${job.id})`;
    const current = await getJob(lock, job.id);
    if (current?.status === "cancelled")
      return {
        refused: true,
        answer: current.lastSummary ?? "That follow-up was cancelled.",
      };
    if (current?.followupSentAt)
      return {
        answer: "I already sent that follow-up.",
        job: current,
      };
    result = await sendFollowUpOnce(
      { ...deps, sql: lock },
      parent,
      job,
      clean,
      by,
      requestKey,
      brief,
      guardrails,
    );
  } finally {
    await lock`select pg_advisory_unlock(${FOLLOWUP_SEND_LOCK}, ${job.id})`.catch(() => {});
    lock.release();
  }
  // Deliver on the pooled client: a reserved connection has no `begin` for card edits.
  await deliverNow(deps);
  return result;
}

async function sendFollowUpOnce(
  deps: JobDeps,
  parent: Job,
  job: Job,
  clean: string,
  by: string,
  requestKey: string,
  brief: Brief,
  guardrails?: string[],
): Promise<FollowUpResult> {
  const name = jobRef(parent.id);
  const ref = jobRef(job.id);
  try {
    const endpoint = await workerCapabilityEndpoint(deps.sql, parent.id);
    const tools = endpoint ? await workerCallbackInstructions(deps.sql, job.id, endpoint) : "";
    const message = `${followUpMessage(ref, name, clean, brief, guardrails)}\n\n${tools}`;
    await deps.worker.send(parent.workerThreadId as string, message, "auto", requestKey);
    const at = deps.now?.() ?? new Date();
    // Use this send's echo, not activity or status left by the parent's run. A fast worker
    // may already have replied after the echo; leave those items for checkJob.
    let cursor = parent.cursor;
    let boundary: string | null = null;
    for (let page = 0; page < 10; page++) {
      const activity = await deps.worker.readActivity(parent.workerThreadId as string, cursor);
      const echo = activity.items.find(
        (item) =>
          item.type === "user_message" &&
          (item.text.trim() === message.trim() ||
            (item.rest && message.trimStart().startsWith(item.text.trimStart()))),
      );
      if (echo) {
        boundary = String(echo.position);
        break;
      }
      cursor = activity.cursor;
      if (!activity.hasMore) {
        boundary = cursor;
        break;
      }
      if (page === 9) throw new Error("Could not locate the follow-up run boundary.");
    }
    await deps.sql`update jobs set followup_sent_at = ${at}, followup_boundary = ${boundary},
      cursor = ${boundary}, revision = revision + 1 where id = ${job.id} and followup_sent_at is null`;
  } catch (error) {
    const reason = `The ${workerNoun()} did not take the follow-up: ${(error as Error).message}`;
    await deps.sql`update jobs set last_summary = 'The follow-up could not be sent yet.', watch_until = now() + interval '1 minute' where id = ${job.id}`;
    throw new Error(`The follow-up could not start. ${reason}`);
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
  await editEndPost(deps.sql, parent, "I sent the follow-up on the same branch.");
  return {
    answer: `I sent the follow-up to the ${workerNoun()}.`,
    job: (await getJob(deps.sql, job.id)) ?? job,
  };
}

// The child starts on the parent's thread. Send records its own run boundary. No task watches it:
// a one-minute lease keeps reconcile away until the send lands, and then reconcile takes it
// over. It also takes over the parent's pull request watch, so a later wake posts once, under
// the follow-up.
async function insertFollowUp(sql: Sql, parent: Job, requestKey: string, brief: Brief) {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`select id from jobs where id = ${parent.id} for update`;
    const [same] = await tx<Job[]>`select * from jobs where request_key = ${requestKey}`;
    if (same) return { ...same, id: Number(same.id) };
    const current = await getJobByRef(tx, jobRef(parent.id));
    if (!current || current.closedAt || (await laterJob(tx, current)))
      throw new JobSetupError("This job was closed or continued. Ask for a new proposal.");
    const [row] = await tx<{ id: number }[]>`
    insert into jobs (
      request_key, session_id, kind, title, owner, slack_channel, slack_thread_ts, code_channel, brief, worker,
      worker_project_id, worker_identity, worker_thread_id, worker_model, cursor, status, started_at, parent_job_id,
      pr_url, pr_watched_url, pr_wake_cursor, watch_until
    )
    select
      ${requestKey}, session_id, 'code-change', ${brief.title}, owner, slack_channel,
      slack_thread_ts, code_channel, ${json(tx, brief)}, worker, worker_project_id, worker_identity, worker_thread_id,
      worker_model, cursor, 'running', now(), id, pr_url, pr_watched_url, pr_wake_cursor,
      now() + interval '1 minute'
    from jobs where id = ${parent.id}
    returning id
  `;
    const job = row && (await getJobByRef(tx, jobRef(Number(row.id))));
    if (!job) throw new Error("insert into jobs returned no row");
    return job;
  });
}

// The longest summary Sym shares in the original thread.
const SUMMARY_SHARE_MAX = 3000;

export async function closeJob(
  deps: JobDeps,
  ref: string,
  by: string,
  options: { summary?: string } = {},
): Promise<string> {
  const job = await getJobByRef(deps.sql, ref);
  if (!job) return "I couldn't find that work.";
  if (!TERMINAL.includes(job.status)) return "I'm still working on this. Stop it first.";
  const refusal = await deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    // Follow-up insertion takes this same parent lock. Closing cannot settle a child that
    // started between the latest-job check and close acceptance.
    await sql`select id from jobs where id = ${job.id} for update`;
    const current = await getJobByRef(sql, ref);
    if (!current || !TERMINAL.includes(current.status))
      return "I'm still working on this. Stop it first.";
    const later = await laterJob(sql, current);
    if (later) return "A follow-up continued this thread. Close the latest work instead.";
    await sql`
      update jobs set closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, ${by}),
        archive_state = case when code_channel and archive_state = 'none' then 'pending' else archive_state end
      where id = ${job.id}
    `;
    await sql`update conversation_choices set expires_at = least(expires_at, now()) where job_id = ${job.id}`;
    return undefined;
  });
  if (refusal) return refusal;
  // Decision 078: a summary goes to the original thread before the archive, so it reaches
  // people even if the archive needs a retry.
  const shared = options.summary ? await shareSummary(deps, job, options.summary) : "";
  const answer = await completeClosure(deps, job.id);
  await deliverNow(deps);
  return shared ? `${answer} ${shared}` : answer;
}

// Posts the brain's summary as a reply in the thread the work was asked in. Slack's own
// `summary_message_ts` only labels the archived channel; it posts nothing in the thread.
async function shareSummary(deps: JobDeps, job: Job, summary: string): Promise<string> {
  const text = summary.trim().slice(0, SUMMARY_SHARE_MAX);
  if (!text) return "";
  if (!job.codeChannel) return "This work is in its thread already, so reply there instead.";
  if (!job.originChannel || !job.originThreadTs) {
    return "I couldn't share the summary: this channel has no original thread.";
  }
  await enqueuePost(deps.sql, {
    idempotencyKey: `${jobRef(job.id)}:origin-summary`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: { channel: job.originChannel, thread_ts: job.originThreadTs, text },
    display: chooseDisplay({
      kind: job.kind,
      needsAction: false,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: text.split("\n").length,
      surface: /^D/.test(job.originChannel) ? "dm" : "channel",
      quiet: false,
    }),
  });
  await deliverNow(deps);
  const post = await latestPost(deps.sql, job.id, `${jobRef(job.id)}:origin-summary`);
  return post?.status === "sent"
    ? "I posted the summary in the original thread."
    : "The summary will post in the original thread once Slack accepts it.";
}

// Close acceptance stops PR following through closed_at. External settlement and archive are
// separate confirmed facts. Reconcile retries any fact missing after a restart.
async function completeClosure(deps: JobDeps, id: number): Promise<string> {
  // closed_at prevents follow-up insertion. External calls hold no transaction or row lock.
  const requested = await getJobByRef(deps.sql, jobRef(id));
  const ref = jobRef(id);
  if (!requested?.closedAt) return "This has no close request.";
  let settlementPending = false;
  const settle = async () => {
    if (!requested.workerSettledAt) {
      try {
        if (requested.workerThreadId) {
          if (!deps.worker.settle) throw new Error("The worker connection needs repair.");
          await deps.worker.settle(requested.workerThreadId);
        }
        await deps.sql`update jobs set worker_settled_at = coalesce(worker_settled_at, now()) where id = ${id}`;
      } catch {
        settlementPending = true;
      }
    }
  };
  let archiveError: string | null = null;
  const archive = async () => {
    if (requested.codeChannel && requested.archiveState !== "archived") {
      const missing = !requested.slackChannel
        ? "missing_channel"
        : !deps.slack
          ? "missing_client"
          : null;
      const [end] = await deps.sql<{ slackTs: string | null }[]>`
      select slack_ts from outbox where job_id = ${id} and idempotency_key = ${`${ref}:end`} and status = 'sent'
    `;
      const archived =
        !missing && (await archiveCodeChannel(deps, requested, end?.slackTs ?? null));
      if (archived) {
        await deps.sql`update jobs set archive_state = 'archived', archive_error = null where id = ${id}`;
      } else {
        archiveError =
          missing === "missing_channel"
            ? "I couldn't archive this: its channel ID is missing. The saved job needs repair."
            : missing === "missing_client"
              ? "I couldn't archive this: the Slack connection is missing. It needs repair."
              : "I couldn't archive this channel. I'll retry.";
        await deps.sql`update jobs set archive_state = ${missing ? "repair" : "pending"},
        archive_error = ${missing ?? "archive_failed"} where id = ${id} and archive_state <> 'archived'`;
      }
    }
  };
  await Promise.all([settle(), archive()]);
  const job = (await getJobByRef(deps.sql, ref)) ?? requested;
  if (job.archiveState === "archived") archiveError = null;
  const closed =
    job.codeChannel && job.archiveState === "archived"
      ? "Closed this and archived its channel."
      : job.codeChannel
        ? "I stopped following this."
        : "Closed this.";
  if (settlementPending || archiveError) {
    const retry = settlementPending ? "I couldn't settle the worker thread. I'll retry." : "";
    const text = [archiveError, retry].filter(Boolean).join(" ");
    await closureNotice(deps, job, text);
    await editEndPost(deps.sql, job, `${closed} ${text}`, true);
    return `${closed} ${text}`;
  }
  await clearClosureNotice(deps, job);
  const [watch] = await deps.sql<
    { watched: boolean }[]
  >`select pr_watched_url is not null as watched from jobs where id = ${job.id}`;
  await editEndPost(
    deps.sql,
    job,
    job.codeChannel
      ? "I've closed this and archived its channel."
      : `I've closed this.${watch?.watched ? " I stopped following its PR." : ""}`,
    true,
  );
  return closed;
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
        text: job.codeChannel ? "I've archived this channel." : "I've closed this.",
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
      and not (status = 'cancelled' and parent_job_id is not null and followup_sent_at is null)
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
export async function editEndPost(
  sql: Sql,
  job: Job,
  note: string,
  replaceClosure = false,
): Promise<void> {
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
  // Keep actor and follow-up notes from the latest edit. Closure state replaces its old note.
  const [edited] = await sql<{ payload: { text?: string; blocks?: Record<string, unknown>[] } }[]>`
    select payload from outbox
    where payload ->> 'channel' = ${post.payload.channel} and payload ->> 'ts' = ${post.slackTs}
      and method = 'chat.update' and status <> 'failed'
    order by id desc limit 1
  `;
  let text = edited?.payload.text ?? post.payload.text ?? "";
  const kept = withoutResultButtons(edited?.payload.blocks ?? post.payload.blocks ?? []).filter(
    (block) => {
      const old = replaceClosure ? closureNoteText(block, ref) : undefined;
      if (!old) return true;
      const at = text.lastIndexOf(`\n${old}`);
      if (at >= 0) text = text.slice(0, at) + text.slice(at + old.length + 1);
      return false;
    },
  );
  const blocks = [...kept, { type: "context", elements: [{ type: "mrkdwn", text: note }] }];
  await enqueuePost(sql, {
    idempotencyKey: `${ref}:end-edit:${note}`,
    jobId: job.id,
    method: "chat.update",
    payload: {
      channel: post.payload.channel,
      ts: post.slackTs,
      text: `${text}\n${note}`,
      blocks,
    },
    display: post.display,
  });
}

function closureNoteText(block: Record<string, unknown>, ref: string): string | undefined {
  if (block.type !== "context" || !Array.isArray(block.elements) || block.elements.length !== 1)
    return undefined;
  const text = (block.elements[0] as { text?: unknown } | undefined)?.text;
  return typeof text === "string" &&
    [
      "I stopped following this.",
      "Closed this.",
      "Closed this and ",
      "I've closed this.",
      "I've closed this and ",
      `I stopped following ${ref}.`,
      `Closed ${ref}.`,
      `I've closed ${ref}.`,
      `Closed ${ref} and `,
      `I've closed ${ref} and `,
    ].some((prefix) => text.startsWith(prefix))
    ? text
    : undefined;
}

function withoutResultButtons(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  return blocks.flatMap((block) => {
    if (block.type !== "actions" || !Array.isArray(block.elements)) return [block];
    const kept = (block.elements as { action_id?: string }[]).filter(
      (element) =>
        !RESULT_ACTION_IDS.includes(element.action_id ?? "") &&
        !element.action_id?.startsWith("sym_choice_"),
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
  _by: string,
): Promise<string | undefined> {
  const job = await getJobByRef(deps.sql, ref);
  if (!job?.slackChannel) return "I couldn't find that work.";
  if (!job.workerThreadId) return "This has not started yet.";
  if (kind === "steer" && TERMINAL.includes(job.status)) return "This already finished.";
  if (kind === "fix") {
    if (!FIXABLE.has(job.status)) return "This cannot take a fix now.";
    if (await isClosed(deps.sql, job.id)) return "This is closed.";
    const later = await laterJob(deps.sql, job);
    if (later) return "A follow-up continued this thread. Use the latest work.";
  }
  return kind === "steer"
    ? "Reply here with the direction. I'll read it in context."
    : "Tell me what should change. I'll propose the follow-up before starting it.";
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

// A follow-up is a stored proposal. Neither asking for one nor talking about the result sends
// work to the worker. Current project and worker limits are checked now and again on Start.
export async function proposeFollowUp(
  deps: JobDeps,
  ref: string,
  change: string,
  key: string,
): Promise<FollowUpResult> {
  const parent = await getJobByRef(deps.sql, ref);
  if (!parent) return { answer: "I couldn't find that work." };
  if (!FIXABLE.has(parent.status) || parent.closedAt)
    return { answer: "This can't take a follow-up now." };
  const later = await laterJob(deps.sql, parent);
  if (later) return { answer: "A follow-up continued this thread. Use the latest work." };
  const clean = cleanSteerText(change);
  if (!clean) return { answer: "What should change?" };
  let plan: Awaited<ReturnType<typeof planLaunch>>;
  try {
    plan = await planLaunch(deps, Brief.parse(parent.brief));
  } catch (error) {
    if (error instanceof JobSetupError) return { answer: error.message };
    throw error;
  }
  if (
    !parent.workerThreadId ||
    !parent.workerIdentity ||
    parent.workerIdentity !== deps.workerIdentity ||
    parent.workerProjectId !== plan.projectId
  ) {
    return { answer: "The worker or project has changed. Ask for new work." };
  }
  const question =
    /\?$/.test(clean) || /^(can|could|would|will|should|do|does|is|are)\b/i.test(clean);
  const text = question
    ? `You asked: '${clean.replace(/[.!?]+$/, "")}?' I'd continue on the same branch. Should I start?`
    : `I'll make this change on the same branch: ${clean.replace(/[.!?]+$/, "")}. Should I start?`;
  const proposal = await propose(deps.sql, {
    key,
    job: parent,
    kind: "followup",
    payload: { change: clean },
    message: escapeMrkdwn(text),
  });
  await enqueuePost(deps.sql, {
    idempotencyKey: `proposal:${proposal.id}`,
    jobId: parent.id,
    method: "chat.postMessage",
    payload: {
      channel: proposal.channel,
      ...(proposal.threadTs ? { thread_ts: proposal.threadTs } : {}),
      text: proposal.message,
      blocks: proposalBlocks(proposal),
    },
    display: promptDisplay(parent, true),
  });
  await deliverNow(deps);
  return { answer: "I posted the proposal. Nothing starts until Start.", job: parent };
}
