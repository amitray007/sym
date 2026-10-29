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
import { answerPrompt, closeJob, postPrompt, startFollowUp } from "../jobs/followup.ts";
import { fullBrief } from "../jobs/messages.ts";
import { refOfPrompt } from "../jobs/prompts.ts";
import type { JobDeps } from "../jobs/run.ts";
import { steerJob, stopJob } from "../jobs/steer.ts";
import { getJobByRef } from "../ledger/jobs.ts";
import { slackText } from "../quiet/command.ts";

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
    if (!job) return say(`There is no job ${ref}.`);
    // The box's own message ts keys the request, so a repeated Enter sends once.
    const outcome =
      kind === "steer"
        ? await steerJob(deps, ref, text, "steer", `box:${channel}:${action.messageTs}`)
        : (await startFollowUp(deps, ref, text, by, `${channel}:${action.messageTs}`)).answer;
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
        return say(`There is no job ${ref}.`);
      }
      // fullBrief escapes the brief's text itself, so it skips `say`.
      const text = fullBrief(Brief.parse(job.brief), ref);
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
      if (!job) return say(`There is no job ${ref}.`);
      // One person's Looks good on one result counts once (the feedback table's unique index).
      await recordFeedback(deps.sql, {
        jobId: job.id,
        slackUser: by,
        kind: "thumbs_up",
        value: "looks_good",
        channel,
        messageTs: action.messageTs ?? null,
      });
      return say(`Noted: ${ref} looks good.`);
    }
    default:
      return undefined;
  }
}
