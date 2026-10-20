// Pure rules the job flow applies from the pack. No I/O.

import { type ModelList, modelList } from "../workers/models.ts";
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

// Extra constraint lines for the worker message. A draft PR needs both the pack's policy and the
// brief's request: the pack narrows a brief, never widens it.
export function briefGuardrails(
  _pack: Pack,
  project: PackProject,
  openPullRequest: boolean,
): string[] {
  return [
    `Change only files that match: ${project.allowedPaths.join(", ")}.`,
    project.prPolicy === "draft" && openPullRequest
      ? "Push the branch and open a draft pull request. Never mark it ready for review."
      : "Do not push and do not open a pull request.",
    "Keep production data read-only.",
  ];
}

// The owner always counts. An empty allow-list means the owner only.
export function isAllowedSlackUser(pack: Pack, userId: string): boolean {
  return userId === pack.config.owner.slackUserId || pack.config.allowList.includes(userId);
}

// The model list for a pack worker (decision 041). `envModel` is SYM_WORKER_MODEL.
export function workerModelList(
  pack: Pack | undefined,
  workerName: string | undefined,
  envModel?: string,
): ModelList {
  const workers = pack?.config.workers ?? [];
  const worker =
    workers.find((w) => w.name === workerName) ?? (workers.length === 1 ? workers[0] : undefined);
  return modelList(worker?.models, envModel);
}
