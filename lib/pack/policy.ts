// Pure rules the job flow applies from the pack. No I/O.
import type { Pack } from "./load.ts";
import type { PackProject, PackWorker } from "./schema.ts";

export type PackProjectResult =
  | {
      ok: true;
      project: PackProject;
      worker: PackWorker;
      // The worker project's ID or title, for the worker's own lookup.
      workerProject: string;
    }
  | { ok: false; reason: string };

export function resolvePackProject(pack: Pack, name: string): PackProjectResult {
  const wanted = name.trim().toLowerCase();
  const project = pack.config.projects.find((p) => p.name.toLowerCase() === wanted);
  if (!project) {
    return { ok: false, reason: `"${name}" is not in the pack's allowed projects.` };
  }
  const worker = pack.config.workers.find((w) => w.name === project.worker);
  if (!worker) return { ok: false, reason: `The pack has no worker "${project.worker}".` };
  return { ok: true, project, worker, workerProject: project.workerProject ?? project.name };
}

// Extra constraint lines for the worker message.
export function briefGuardrails(_pack: Pack, project: PackProject): string[] {
  return [
    `Change only files that match: ${project.allowedPaths.join(", ")}.`,
    project.prPolicy === "draft"
      ? "A draft pull request is allowed. Never mark it ready for review."
      : "Do not push and do not open a pull request.",
    "Keep production data read-only.",
  ];
}

// The owner always counts. An empty allow-list means the owner only.
export function isAllowedSlackUser(pack: Pack, userId: string): boolean {
  return userId === pack.config.owner.slackUserId || pack.config.allowList.includes(userId);
}
