import { type AuthFn, extractBearerToken, withAuthChallenges } from "eve/channels/auth";
import { WORKER_PRINCIPAL } from "./callers.ts";
import type { Sql } from "./db.ts";
import { workerCapabilityJob } from "./jobs/worker-capabilities.ts";

export function workerCapabilityAuth(sql: () => Sql): AuthFn<Request> {
  return withAuthChallenges(
    async (request) => {
      const token = extractBearerToken(request.headers.get("authorization"));
      if (!token?.startsWith("symjob_")) return null;
      const jobId = await workerCapabilityJob(sql(), token);
      if (jobId === undefined) return null;
      return {
        attributes: { jobId: String(jobId) },
        authenticator: "sym-job-capability",
        principalId: WORKER_PRINCIPAL,
        principalType: "service" as const,
      };
    },
    [{ scheme: "Bearer" }],
  );
}
