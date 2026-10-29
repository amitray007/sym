import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { projectRows } from "../../lib/projects/allowed.ts";
import { allowedFromEnv, withJobDeps } from "../../lib/runtime.ts";
import type { WorkerProject } from "../../lib/workers/types.ts";

// Sym's projects and whether the worker has each one (decision 042). Read-only. The worker lists
// every project it has, so the filter to Sym's list runs here, before the brain sees anything.

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "List the projects Sym works on, each with its worker title and whether the worker has it. " +
    "Use it to resolve a project name before a brief. It never lists other projects.",
  inputSchema: z.object({}),
  label: { start: () => "Check projects" },
  async execute(_input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const allowed = allowedFromEnv();
    if (allowed.length === 0) return { projects: [], note: "Sym has no projects configured." };
    // An unreachable or signed-out worker still gives the names, with an unknown state.
    const fromWorker: WorkerProject[] | undefined = await withJobDeps((deps) =>
      deps.worker.projects(),
    ).catch(() => undefined);
    return { projects: projectRows(allowed, fromWorker) };
  },
});
