import { resumeHook } from "eve/workflow/api";
import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { recordFeedback } from "../feedback/feedback.ts";
import { Brief } from "../jobs/brief.ts";
import {
  BRIEF_ACTION_ID,
  CLOSE_ACTION_ID,
  FIX_ACTION_ID,
  FIX_TEXT_ACTION_ID,
  LOOKS_GOOD_ACTION_ID,
  STEER_ACTION_ID,
  STEER_TEXT_ACTION_ID,
  STOP_ACTION_ID,
} from "../jobs/card.ts";
import {
  answerPrompt,
  closeJob,
  postPrompt,
  proposeFollowUp,
  startFollowUp,
} from "../jobs/followup.ts";
import { fullBrief } from "../jobs/messages.ts";
import { jobName } from "../jobs/names.ts";
import { refOfPrompt } from "../jobs/prompts.ts";
import type { JobDeps } from "../jobs/run.ts";
import { deliverNow } from "../jobs/run.ts";
import { steerJob, stopJob } from "../jobs/steer.ts";
import { getJob, getJobByRef } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import {
  decideProposal,
  type JobProposal,
  startWakeToken,
  typedProposal,
} from "../ledger/proposals.ts";
import { slackText } from "../quiet/command.ts";
import { isSlackUserAllowed } from "./guard.ts";

// The job buttons and text boxes in Slack (decisions 056, 060, and 005): Full brief on the brief,
// Steer and Stop on the live card, Looks good, Fix, and Close on the result, and the Steer and Fix text boxes. The channel
// checks the allow-list first. Answers go privately to the person who clicked.

export const JOB_ACTION_IDS = [
  BRIEF_ACTION_ID,
  STOP_ACTION_ID,
  STEER_ACTION_ID,
  LOOKS_GOOD_ACTION_ID,
  FIX_ACTION_ID,
  CLOSE_ACTION_ID,
  STEER_TEXT_ACTION_ID,
  FIX_TEXT_ACTION_ID,
];

export interface JobAction {
  actionId: string;
  value?: string;
  blockId?: string;
  messageTs?: string;
  user: { id: string };
}

const JOB_REF = /^J-\d+$/;

// Runs one job action. `reply` answers the clicker privately. Returns the answer it gave, or
// nothing when it stayed silent.
export async function handleJobAction(
  deps: JobDeps,
  action: JobAction,
  channel: string,
  reply: (text: string) => Promise<void>,
): Promise<string | undefined> {
  const by = action.user.id;
  const say = async (text: string) => {
    const plain = slackText(text);
    await reply(plain);
    return plain;
  };

  if (action.actionId === STEER_TEXT_ACTION_ID || action.actionId === FIX_TEXT_ACTION_ID) {
    const kind = action.actionId === STEER_TEXT_ACTION_ID ? "steer" : "fix";
    const ref = refOfPrompt(kind, action.blockId);
    const text = action.value?.trim() ?? "";
    if (!ref || !text || !action.messageTs) return undefined;
    const job = await getJobByRef(deps.sql, ref);
    if (!job) return say("I couldn't find that work.");
    // The box's own message ts keys the request, so a repeated Enter sends once.
    const outcome =
      kind === "steer"
        ? await steerJob(deps, ref, text, "steer", `box:${channel}:${action.messageTs}`)
        : (await proposeFollowUp(deps, ref, text, `legacy:${channel}:${action.messageTs}`)).answer;
    await answerPrompt(deps, job, { channel, ts: action.messageTs }, by, text, outcome);
    return slackText(outcome);
  }

  const ref = action.value ?? "";
  if (!JOB_REF.test(ref)) return undefined;
  switch (action.actionId) {
    case BRIEF_ACTION_ID: {
      const job = await getJobByRef(deps.sql, ref);
      // The brief answers only in the channel where its button was posted: the job's own, or the
      // thread a job moved out of into a code channel (decision 067).
      if (!job || (job.slackChannel !== channel && job.originChannel !== channel)) {
        return say("I couldn't find that work.");
      }
      // fullBrief escapes the brief's text itself, so it skips `say`.
      const text = fullBrief(Brief.parse(job.brief));
      await reply(text);
      return text;
    }
    case STOP_ACTION_ID:
      return say(await stopJob(deps, ref));
    case STEER_ACTION_ID: {
      const refusal = await postPrompt(deps, "steer", ref, by);
      return refusal ? say(refusal) : undefined;
    }
    case FIX_ACTION_ID: {
      const refusal = await postPrompt(deps, "fix", ref, by);
      return refusal ? say(refusal) : undefined;
    }
    case CLOSE_ACTION_ID:
      return say(await closeJob(deps, ref, by));
    case LOOKS_GOOD_ACTION_ID: {
      const job = await getJobByRef(deps.sql, ref);
      if (!job) return say("I couldn't find that work.");
      // One person's Looks good on one result counts once (the feedback table's unique index).
      await recordFeedback(deps.sql, {
        jobId: job.id,
        slackUser: by,
        kind: "thumbs_up",
        value: "looks_good",
        channel,
        messageTs: action.messageTs ?? null,
      });
      return say("Thanks, I recorded your feedback.");
    }
    default:
      return undefined;
  }
}

export interface ProposalOutcome {
  kind: "accepted" | "refused" | "stale" | "ambiguous";
  text: string;
}

export async function handleProposal(
  deps: JobDeps,
  input: {
    id: string;
    by: string;
    channel: string;
    threadTs: string | null;
    messageTs?: string;
    start: boolean;
  },
  allowed: (user: string) => boolean,
): Promise<ProposalOutcome> {
  if (!allowed(input.by) || !/^[1-9][0-9]*$/.test(input.id))
    return { kind: "refused", text: "I couldn't approve that request." };
  const decision = await deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    const [row] = await sql<
      JobProposal[]
    >`select * from job_proposals where id = ${input.id}::bigint`;
    if (
      !row ||
      row.channel !== input.channel ||
      row.threadTs !== input.threadTs ||
      (input.messageTs && row.messageTs !== input.messageTs) ||
      !allowed(input.by)
    )
      return undefined;
    return decideProposal(sql, input.id, input.by, input.start);
  });
  if (!decision || decision.status === "expired")
    return { kind: "stale", text: "That proposal is no longer current. Ask me for a new one." };
  if (decision.status === "approved" && decision.kind === "followup") {
    return { kind: "accepted", text: await executeFollowupProposal(deps, decision) };
  }
  const text =
    decision.status === "approved"
      ? `<@${input.by}> chose: Start. I'll start the approved work.`
      : `<@${input.by}> chose: Not now. I'll leave it there.`;
  await editProposal(deps, decision, text);
  if (decision.kind === "start") {
    const job = await getJob(deps.sql, decision.jobId);
    // The committed ledger decision grants authority. The hook only shortens the wait.
    // A finished or lost task may have no hook; reconcile still recovers accepted Starts.
    if (job) await resumeHook(startWakeToken(job.requestKey), null).catch(() => {});
  }
  return {
    kind: "accepted",
    text: decision.status === "approved" ? "Starting the approved work." : "I'll leave it there.",
  };
}

export async function handleTypedProposal(
  deps: JobDeps,
  input: {
    text: string;
    by: string;
    channel: string;
    threadTs: string | null;
    replyAfter?: string;
  },
  allowed: (user: string) => boolean,
): Promise<ProposalOutcome | undefined> {
  const text = input.text
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
  const start = /^(start|yes|yes please|go|go ahead|do it)$/.test(text);
  const dismiss = /^(not now|no|cancel|never mind)$/.test(text);
  if (!start && !dismiss) return undefined;
  const proposal = await typedProposal(deps.sql, input.channel, input.threadTs);
  if (!proposal) return undefined;
  if (proposal === "ambiguous")
    return {
      kind: "ambiguous",
      text: "There are several proposals here. Tell me which job you mean.",
    };
  if (input.replyAfter && proposal.messageTs !== input.replyAfter) return undefined;
  return handleProposal(
    deps,
    { id: proposal.id, by: input.by, channel: input.channel, threadTs: input.threadTs, start },
    allowed,
  );
}

async function executeFollowupProposal(
  deps: JobDeps,
  proposal: JobProposal,
  notify = false,
): Promise<string> {
  const payload = proposal.payload as { change?: unknown };
  if (typeof payload.change !== "string" || !proposal.decidedBy)
    return "I couldn't read that follow-up. Ask me for a new proposal.";
  const result = await startFollowUp(
    deps,
    `J-${proposal.jobId}`,
    payload.change,
    proposal.decidedBy,
    `proposal:${proposal.id}`,
  );
  await finishFollowupProposal(deps, proposal, result.answer, result.refused === true, notify);
  return result.answer;
}

export async function retryFollowupProposals(deps: JobDeps): Promise<void> {
  const rows = await deps.sql<JobProposal[]>`select * from job_proposals where kind = 'followup'
    and status = 'approved' and executed_at is null order by id limit 20`;
  for (const row of rows) {
    if (
      !row.decidedBy ||
      !isSlackUserAllowed(deps.pack, process.env.SYM_SLACK_USERS, row.decidedBy)
    ) {
      await finishFollowupProposal(
        deps,
        row,
        "The approver no longer has access. Ask for a new proposal.",
        true,
        true,
      );
      continue;
    }
    await executeFollowupProposal(
      deps,
      {
        ...row,
        id: String(row.id),
        jobId: Number(row.jobId),
      },
      true,
    ).catch(() => undefined);
  }
}

// Closing the proposal and cancelling its unsent child are one ledger operation. Queue both
// notices in that transaction too, so a crash cannot hide a permanent refusal.
async function finishFollowupProposal(
  deps: JobDeps,
  proposal: JobProposal,
  reason: string,
  refused: boolean,
  notify: boolean,
): Promise<void> {
  await deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    await sql`select id from job_proposals where id = ${proposal.id}::bigint for update`;
    const key = `fix:proposal:${proposal.id}`;
    if (refused) {
      await sql`update jobs set status = 'cancelled', finished_at = coalesce(finished_at, now()),
        last_summary = ${reason}, revision = revision + 1
        where request_key = ${key} and followup_sent_at is null and status = 'running'`;
    }
    const [closed] = await sql`update job_proposals set executed_at = now(),
      status = ${refused ? "expired" : "approved"} where id = ${proposal.id}::bigint
      and executed_at is null
      and not exists (select 1 from jobs where request_key = ${key}
        and followup_sent_at is null and status = 'running') returning id`;
    // A concurrent sender still owns an unsent child. Recovery will finish the proposal.
    if (!closed) return;
    const { slack: _held, ...rest } = deps;
    const queued = { ...rest, sql };
    await editProposal(queued, proposal, `<@${proposal.decidedBy}> chose: Start. ${reason}`);
    if (refused && notify && proposal.decidedBy) {
      const job = await getJobByRef(sql, `J-${proposal.jobId}`);
      await enqueuePost(sql, {
        idempotencyKey: `proposal:${proposal.id}:refused`,
        jobId: proposal.jobId,
        method: "chat.postMessage",
        payload: {
          channel: proposal.decidedBy,
          text: `I couldn't start the follow-up on ${job ? jobName(job) : "that work"}: ${reason}`,
        },
        display: {
          ...chooseDisplay({
            kind: "conversation",
            needsAction: true,
            isNew: true,
            estMinutes: 0,
            steps: 0,
            lines: 1,
            surface: "dm",
            quiet: false,
          }),
          target: "dm",
        },
      });
    }
  });
  await deliverNow(deps);
}

async function editProposal(deps: JobDeps, proposal: JobProposal, outcome: string): Promise<void> {
  if (!proposal.messageTs) return;
  const text = `${proposal.message}\n\n${outcome}`;
  await enqueuePost(deps.sql, {
    idempotencyKey: `proposal:${proposal.id}:decided`,
    jobId: proposal.jobId,
    method: "chat.update",
    payload: {
      channel: proposal.channel,
      ts: proposal.messageTs,
      text,
      blocks: [{ type: "markdown", text }],
    },
    display: chooseDisplay({
      kind: "conversation",
      needsAction: false,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: 1,
      surface: "channel",
      quiet: false,
    }),
  });
  await deliverNow(deps);
}
