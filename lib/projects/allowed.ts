import type { Pack } from "../pack/load.ts";
import type { WorkerProject } from "../workers/types.ts";

// The projects Sym may touch (decision 042). Sym's T3 token can read every T3 project, so this
// list is the only guard: every path from T3 to the brain filters through it. Pure, with no Node
// builtins, because `lib/jobs/**` reaches it from a workflow body.

export interface AllowedProject {
  // The name the brain and the owner use: a pack project name, or a SYM_PROJECTS entry.
  name: string;
  // The T3 project ID or title to look up on the worker.
  workerProject: string;
}

// Without a pack, SYM_PROJECTS lists T3 project titles or IDs, comma-separated. With a pack, the
// pack's projects are the list and SYM_PROJECTS is ignored. With neither, the list is empty and
// nothing runs (fail closed).
export function allowedProjects(pack: Pack | undefined, env?: string): AllowedProject[] {
  if (pack) {
    return pack.config.projects.map((p) => ({
      name: p.name,
      workerProject: p.workerProject ?? p.name,
    }));
  }
  const seen = new Set<string>();
  const list: AllowedProject[] = [];
  for (const entry of (env ?? "").split(",")) {
    const name = entry.trim();
    if (name === "" || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    list.push({ name, workerProject: name });
  }
  return list;
}

// Exact name or ID, else a case-insensitive exact name. The same matching as the worker lookup.
export function findAllowedProject(
  list: readonly AllowedProject[],
  asked: string,
): AllowedProject | undefined {
  const wanted = asked.trim().toLowerCase();
  return (
    list.find((p) => p.name === asked || p.workerProject === asked) ??
    list.find((p) => p.name.toLowerCase() === wanted)
  );
}

// The same words whether the asked-for project exists on the worker or not, so a refusal never
// confirms that another project exists.
export function projectRefusal(list: readonly AllowedProject[], asked: string): string {
  const works =
    list.length === 0 ? "Sym has no projects configured." : `Sym works on: ${names(list)}.`;
  return `"${asked.trim().slice(0, 80)}" is not one of Sym's projects. ${works}`;
}

// The refusal for a brief, or nothing when its project is allowed.
export function checkProject(list: readonly AllowedProject[], asked: string): string | undefined {
  return findAllowedProject(list, asked) ? undefined : projectRefusal(list, asked);
}

export const names = (list: readonly AllowedProject[]) => list.map((p) => p.name).join(", ");

// The brain's view of the list: dynamic instruction text.
export function projectInstructions(list: readonly AllowedProject[]): string {
  if (list.length === 0) {
    return [
      "# Projects",
      "",
      "Sym has no projects configured, so it cannot start a job. If asked for work, say that the",
      "owner must configure Sym's projects. Do not name, guess, or discuss any other project.",
    ].join("\n");
  }
  return [
    "# Projects",
    "",
    "Sym works only on these projects:",
    ...list.map((p) => `- ${p.name}`),
    "",
    "Use only these names in a brief. Call `worker_projects` to check one. Never name, list,",
    "guess, or discuss any other project, its threads, files, or jobs. If asked about anything",
    "else, say Sym only works on the projects above.",
  ].join("\n");
}

// The worker project for an allowed entry: exact ID, else case-insensitive exact title.
export function matchWorkerProject(
  projects: readonly WorkerProject[],
  key: string,
): WorkerProject | undefined {
  const wanted = key.trim().toLowerCase();
  return (
    projects.find((p) => p.id === key) ?? projects.find((p) => p.title.toLowerCase() === wanted)
  );
}

export interface ProjectRow {
  name: string;
  // The T3 title when the worker has the project, else the configured name.
  title: string;
  // `unknown` when the worker could not be asked.
  worker: "present" | "missing" | "unknown";
}

// The allowed projects with their worker state. Filters in code: a project outside the list is
// never returned or counted. `projects` is undefined when the worker is unreachable.
export function projectRows(
  list: readonly AllowedProject[],
  projects: readonly WorkerProject[] | undefined,
): ProjectRow[] {
  return list.map((p) => {
    if (!projects) return { name: p.name, title: p.name, worker: "unknown" };
    const match = matchWorkerProject(projects, p.workerProject);
    return match
      ? { name: p.name, title: match.title, worker: "present" }
      : { name: p.name, title: p.name, worker: "missing" };
  });
}
