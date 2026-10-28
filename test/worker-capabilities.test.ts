import { describe, expect, it } from "vitest";
import { bearerToken } from "../lib/bearer-auth.ts";
import { issueWorkerCapability, workerCapabilityJob } from "../lib/jobs/worker-capabilities.ts";
import { createJob, updateJob } from "../lib/ledger/jobs.ts";
import { workerCapabilityAuth } from "../lib/worker-auth.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const request = (token: string) =>
  new Request("http://localhost/eve/v1/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });

describe.skipIf(!hasDatabase)("worker capability authentication", () => {
  const ledger = useLedger();
  it("issues independent credentials, preserves retries, authenticates their scope, and revokes terminal jobs", async () => {
    const sql = ledger.sql();
    const make = (requestKey: string) =>
      createJob(sql, {
        requestKey,
        kind: "code-change",
        title: "Scoped callback",
        brief: {},
        worker: "t3",
      });
    const first = await make("capability-first");
    const second = await make("capability-second");
    const a = await issueWorkerCapability(sql, first.id, "https://sym.example/eve/v1/mcp");
    const b = await issueWorkerCapability(sql, second.id, "https://sym.example/eve/v1/mcp");
    expect(a.token).not.toBe(b.token);
    expect(await issueWorkerCapability(sql, first.id, "https://changed.invalid")).toEqual(a);
    const auth = workerCapabilityAuth(() => sql);
    expect(await auth(request(a.token))).toMatchObject({
      principalId: "sym-worker",
      attributes: { jobId: String(first.id) },
    });
    expect(await auth(request(b.token))).toMatchObject({
      attributes: { jobId: String(second.id) },
    });
    expect(await auth(request(`${a.token.slice(0, -1)}X`))).toBeNull();
    expect(await auth(request(`symjob_${"0".repeat(64)}`))).toBeNull();
    expect(await auth(request("shared-token"))).toBeNull();
    const shared = bearerToken({
      variable: "SYM_CAPABILITY_TEST_SHARED",
      authenticator: "shared",
      principalId: "sym-worker",
    });
    process.env.SYM_CAPABILITY_TEST_SHARED = "shared-token";
    try {
      expect(await shared(request("shared-token"))).toMatchObject({ attributes: {} });
    } finally {
      delete process.env.SYM_CAPABILITY_TEST_SHARED;
    }
    await updateJob(sql, first.id, { status: "done" });
    expect(await auth(request(a.token))).toBeNull();
    expect(await workerCapabilityJob(sql, b.token)).toBe(second.id);
  });
});
