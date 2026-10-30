// Live check of the worker job steps without Eve or a model: record a job, launch a T3 thread,
// receive the worker's callback, and check until the job ends. Run
// `pnpm t3:job-smoke <project>` with DATABASE_URL, T3_MCP_URL, and T3_TOKEN set. It launches a
// real worker thread, so point it only at a throwaway project.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { checkJob, launchOrAdopt, statusLine } from "../lib/jobs/run.ts";
import { createJob, jobRef } from "../lib/ledger/jobs.ts";
import { migrate } from "../lib/ledger/migrate.ts";
import { withJobDeps, withLedger } from "../lib/runtime.ts";

const project = process.argv[2];
if (!project) {
  console.error("Usage: pnpm t3:job-smoke <project title or ID>");
  process.exit(1);
}

const POLL_MS = 60_000;
const WAIT_MS = 30_000;
const DEADLINE_MS = 30 * 60_000;

// Stands in for Eve's callback webhook.
let calledBack = false;
const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/callback") calledBack = true;
  response.writeHead(204).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("No callback port.");
const callbackUrl = `http://127.0.0.1:${address.port}/callback`;

try {
  await withLedger(migrate);
  const job = await withLedger((sql) =>
    createJob(sql, {
      requestKey: `smoke-${randomUUID()}`,
      kind: "smoke-test",
      title: "Smoke test: add HELLO.md",
      worker: "t3",
      brief: {
        project,
        title: "Smoke test: add HELLO.md",
        goal: "Create HELLO.md with the single line `hello from Sym`, then commit it.",
        constraints: ["Change no other file."],
        doneWhen: ["HELLO.md exists on this worktree's branch in a commit."],
        baseRef: "main",
        openPullRequest: false,
      },
    }),
  );
  const ref = jobRef(job.id);
  console.info(`${ref}: ${statusLine("Launching worker thread")}`);

  const launched = await withJobDeps((deps) => launchOrAdopt(deps, job.id, callbackUrl));
  console.info(`${ref}: worker thread ${launched.workerThreadId}`);

  const started = Date.now();
  for (;;) {
    const waitStart = Date.now();
    while (!calledBack && Date.now() - waitStart < POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const check = await withJobDeps((deps) => checkJob(deps, job.id, WAIT_MS));
    console.info(
      `${statusLine(`${ref}: ${check.summary}`)}  [${check.status}${calledBack ? ", called back" : ""}]`,
    );
    if (check.terminal) {
      console.info(`\nFinal status: ${check.status}`);
      console.info(`Last message:\n${check.lastMessage ?? "(none)"}`);
      break;
    }
    if (Date.now() - started > DEADLINE_MS) {
      console.error(`${ref} did not finish in 30 minutes. It keeps running on the worker.`);
      process.exitCode = 1;
      break;
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server.close();
  // The runtime pool stays open otherwise.
  process.exit();
}
