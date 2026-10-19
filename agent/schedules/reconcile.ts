import { defineSchedule } from "eve/schedules";
import { deliver } from "../../lib/delivery/deliver.ts";
import { reconcileWorkerPass } from "../../lib/jobs/reconcile.ts";
import { currentWorker, ledgerDeps, withJobDeps } from "../../lib/runtime.ts";
import { ownerTarget, queueSignInNotice } from "../../lib/workers/expiry.ts";

// Reconcile (docs/architecture.md): every 3 minutes, take over the jobs no task watches.
export default defineSchedule({
  cron: "*/3 * * * *",
  async run() {
    const deps = ledgerDeps();
    // The stored sign-in, else the env token (decision 036).
    const worker = await currentWorker();
    // The worker sign-in has no refresh token, so the owner hears 5 days before it ends.
    await queueSignInNotice(deps.sql, {
      expiresAt: worker?.expiresAt ?? null,
      now: new Date(),
      target: ownerTarget(deps.pack),
    });
    // Without any worker URL and token, the pass warns and marks no job offline.
    await reconcileWorkerPass(deps, worker ? withJobDeps : undefined);
    if (deps.slack) await deliver(deps.sql, deps.slack);
  },
});
