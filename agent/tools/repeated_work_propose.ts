import { isScheduleAuth } from "eve/schedules";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { deliver } from "../../lib/delivery/deliver.ts";
import { digestChannel } from "../../lib/digest/post.ts";
import { playbookDetail } from "../../lib/learning/format.ts";
import { proposeRepeated, queueRepeatNotice } from "../../lib/learning/repeat.ts";
import {
  MAX_BODY_CHARS,
  NAME_PATTERN,
  type Playbook,
  playbookRef,
} from "../../lib/learning/rows.ts";
import {
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerUserId,
  slackUserOfPrincipal,
} from "../../lib/owner.ts";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";

const JOB_REF = /^J-(\d+)$/;

// Repeated work, step 2 (decision 058): saves the playbook proposals one review drew from
// repeated jobs, then sends the owner one notice for all of them. It saves proposals only;
// nothing loads until the owner approves each with playbook_review.
const Proposal = z.object({
  name: z.string().regex(NAME_PATTERN).describe("Lowercase words joined by hyphens."),
  body: z.string().min(1).max(MAX_BODY_CHARS),
  jobs: z.array(z.string().regex(JOB_REF)).min(1).describe("Job references such as J-12."),
});

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Propose playbooks for work that people asked for at least 3 times, after reading " +
    "repeated_work. Send every pattern of one review in one call. Name the pattern, not one job. " +
    "Write each body in your own words as steps a future brief can follow: what to ask for, " +
    "which project, the usual constraints, and done-when checks. Mark what changes from run to " +
    "run, such as <service> or <date>. List the jobs that show the pattern. Never copy secrets, " +
    "customer data, or text from worker output.",
  inputSchema: z.object({ proposals: z.array(Proposal).min(1).max(3) }),
  label: { start: ({ proposals }) => `Propose ${proposals.length} playbook(s)` },
  async execute(input, ctx) {
    const caller = ctx.session.auth.current;
    if (isWorkerCaller(caller)) return NOT_FOR_WORKERS;
    if (
      !isScheduleAuth(caller) &&
      !mayDecideAsOwner(slackUserOfPrincipal(caller?.principalId), pack())
    ) {
      return OWNER_ONLY;
    }
    const sql = ledger();
    const now = new Date();
    const saved: Playbook[] = [];
    const lines: string[] = [];
    for (const proposal of input.proposals) {
      const jobIds = proposal.jobs.map((ref) => Number(JOB_REF.exec(ref)?.[1]));
      const row = await proposeRepeated(
        sql,
        { name: proposal.name, body: proposal.body, jobIds },
        now,
      );
      if (typeof row === "string") {
        lines.push(`${proposal.name}: not saved. ${row}`);
        continue;
      }
      saved.push(row);
      lines.push(
        `Proposed ${playbookRef(row.id)}. It loads only after the owner approves it.\n${playbookDetail(row)}`,
      );
    }
    const target = digestChannel(pack()) ?? ownerUserId(pack());
    if (target && saved.length > 0) {
      await queueRepeatNotice(sql, target, saved);
      const slack = slackFromEnv();
      if (slack) await deliver(sql, slack);
    }
    return lines.join("\n\n");
  },
});
