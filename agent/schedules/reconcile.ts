import { defineSchedule } from "eve/schedules";
import { deliver } from "../../lib/delivery/deliver.ts";
import { reconcileJobs } from "../../lib/jobs/reconcile.ts";
import { ledgerDeps, withJobDeps } from "../../lib/runtime.ts";
import { ownerTarget, parseSignInExpiry, queueSignInNotice } from "../../lib/workers/expiry.ts";
import type { WorkerAdapter } from "../../lib/workers/types.ts";

// Reconcile (docs/architecture.md): every 3 minutes, take over the jobs no task watches.
export default defineSchedule({
  cron: "*/3 * * * *",
  async run() {
    const deps = ledgerDeps();
    // The worker sign-in has no refresh token, so the owner hears 5 days before it ends.
    await queueSignInNotice(deps.sql, {
      expiresAt: parseSignInExpiry(process.env.T3_TOKEN_EXPIRES_AT),
      now: new Date(),
      target: ownerTarget(deps.pack),
      mcpUrl: process.env.T3_MCP_URL,
    });
    try {
      await withJobDeps(reconcileJobs);
    } catch {
      // The worker connection failed, so every orphaned job is offline. Record that once.
      await reconcileJobs({ ...deps, worker: unreachableWorker });
    }
    if (deps.slack) await deliver(deps.sql, deps.slack);
  },
});

const unreachable = async (): Promise<never> => {
  throw new Error("The worker is unreachable.");
};

const unreachableWorker: WorkerAdapter = {
  capabilities: unreachable,
  projects: unreachable,
  findByTitle: unreachable,
  launch: unreachable,
  wait: unreachable,
  readActivity: unreachable,
  interrupt: unreachable,
  pendingQuestions: unreachable,
  answer: unreachable,
  send: unreachable,
};
