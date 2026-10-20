// The worker models the brain may pick from (decision 041). Pure functions, no I/O and no Node.js
// builtins: modules that a "use workflow" body reaches import this file.
import type { WorkerCapabilities } from "./types.ts";

export interface ModelEntry {
  // `<provider>/<model>`. The provider is the worker's provider instance ID.
  id: string;
  // One line that tells the brain when to pick this model.
  use: string;
  // The wanted reasoning effort, for example `medium`. Sent when the model offers it.
  effort?: string | undefined;
  default?: boolean | undefined;
}

// Used when the pack names no models for the worker. These are T3 provider instance IDs.
export const DEFAULT_MODELS: readonly ModelEntry[] = [
  {
    id: "claudeAgent/claude-sonnet-5-5",
    effort: "medium",
    use: "Normal changes with a clear scope, tests, docs",
    default: true,
  },
  {
    id: "claudeAgent/claude-opus-5-5",
    effort: "high",
    use: "Hard bugs, cross-cutting refactors, unclear scope, migrations, security",
  },
  {
    id: "codex/gpt-6-luna",
    effort: "low",
    use: "Scheduled checks, read-only questions, mechanical edits",
  },
  {
    id: "codex/gpt-6.1-sol",
    effort: "high",
    use: "Retry after a Claude job fails, or when Claude limits run out",
  },
];

// `<provider>/<model>`: both parts non-empty, no spaces. The model part may hold slashes.
export const MODEL_ID = /^[^/\s]+\/\S+$/;

export function splitModelId(id: string): { providerId: string; model: string } | undefined {
  if (!MODEL_ID.test(id)) return undefined;
  const slash = id.indexOf("/");
  return { providerId: id.slice(0, slash), model: id.slice(slash + 1) };
}

export interface ModelList {
  entries: ModelEntry[];
  // The id of the entry used when nothing else applies.
  defaultId: string;
}

// The effective list for a worker: the pack's models, else the built-in ones. `envModel`
// (SYM_WORKER_MODEL) becomes the default entry, and joins the list when it is missing.
export function modelList(configured?: readonly ModelEntry[], envModel?: string): ModelList {
  const base = configured && configured.length > 0 ? configured : DEFAULT_MODELS;
  let entries = base.map((entry) => ({ ...entry }));
  let defaultId = entries.find((entry) => entry.default)?.id ?? entries[0]?.id ?? "";
  if (envModel) {
    if (!entries.some((entry) => entry.id === envModel)) {
      entries = [...entries, { id: envModel, use: "Set as the default by SYM_WORKER_MODEL." }];
    }
    defaultId = envModel;
  }
  return {
    entries: entries.map(({ default: _default, ...entry }) => entry),
    defaultId,
  };
}

export interface ModelChoice {
  entry: ModelEntry;
  // Why the choice differs from what was asked, for the owner. Absent when it matches.
  note?: string;
}

// Resolution order: the pack project's model, the brief's model when it is on the list, then the
// list default. A model off the list never fails a job; the default replaces it.
export function chooseModel(
  list: ModelList,
  input: { projectModel?: string | undefined; briefModel?: string | undefined },
): ModelChoice {
  const byId = (id: string | undefined) => list.entries.find((entry) => entry.id === id);
  const fallback = byId(list.defaultId) ?? list.entries[0];
  if (!fallback) throw new Error("the worker model list is empty");
  const pinned = byId(input.projectModel);
  if (pinned) return { entry: pinned };
  const asked = byId(input.briefModel);
  if (asked) return { entry: asked };
  if (input.briefModel) {
    return {
      entry: fallback,
      note: `The brief asked for ${input.briefModel}, which is not on the list. Used ${fallback.id}.`,
    };
  }
  return { entry: fallback };
}

export function isOffered(capabilities: WorkerCapabilities, id: string): boolean {
  const parts = splitModelId(id);
  if (!parts) return false;
  const provider = capabilities.providers.find((p) => p.id === parts.providerId);
  return Boolean(provider?.available && provider.models.includes(parts.model));
}

export interface ModelSelection {
  providerId: string;
  model: string;
  options?: { id: string; value: string }[];
}

export interface AvailableChoice {
  // Absent when no listed model is available: the launch then sends no model.
  entry?: ModelEntry;
  selection?: ModelSelection;
  note?: string;
}

// Keeps the chosen model when the worker offers it. Otherwise takes the first available listed
// model, the default first, and says so.
export function resolveAvailable(
  list: ModelList,
  choice: ModelChoice,
  capabilities: WorkerCapabilities,
): AvailableChoice {
  const ordered = [
    choice.entry,
    ...list.entries.filter((entry) => entry.id === list.defaultId),
    ...list.entries,
  ];
  const usable = ordered.find((entry) => isOffered(capabilities, entry.id));
  if (!usable) {
    return {
      note: [choice.note, "No listed model is available on the worker. Used the project default."]
        .filter(Boolean)
        .join(" "),
    };
  }
  const parts = splitModelId(usable.id);
  if (!parts) return {};
  const note =
    usable.id === choice.entry.id
      ? choice.note
      : [choice.note, `${choice.entry.id} is not available on the worker. Used ${usable.id}.`]
          .filter(Boolean)
          .join(" ");
  const effort = usable.effort
    ? effortOption(capabilities, parts.providerId, parts.model, usable.effort)
    : undefined;
  return {
    entry: usable,
    selection: { ...parts, ...(effort ? { options: [effort] } : {}) },
    ...(note ? { note } : {}),
  };
}

// The option IDs that set reasoning effort. They differ by provider.
export const EFFORT_OPTION_IDS = ["effort", "reasoningEffort", "reasoning_effort", "reasoning"];

function effortOption(
  capabilities: WorkerCapabilities,
  providerId: string,
  model: string,
  wanted: string,
): { id: string; value: string } | undefined {
  const provider = capabilities.providers.find((p) => p.id === providerId);
  const options = provider?.modelOptions?.[model] ?? [];
  for (const option of options) {
    if (!EFFORT_OPTION_IDS.includes(option.id)) continue;
    const value =
      option.values.find((v) => v === wanted) ??
      option.values.find((v) => v.toLowerCase() === wanted.toLowerCase());
    if (value) return { id: option.id, value };
  }
  return undefined;
}

// `claude-sonnet-5-5 (medium)`: the model part of the ID, with the effort when there is one.
export function modelLabel(entry: ModelEntry): string {
  const model = entry.id.slice(entry.id.indexOf("/") + 1);
  return entry.effort ? `${model} (${entry.effort})` : model;
}

// The brief's model line, for example `Model: claude-sonnet-5-5 (medium) · default`. It shows
// the model the launch will ask for, before the worker's availability is known.
export function briefModelLine(
  list: ModelList,
  input: { projectModel?: string | undefined; briefModel?: string | undefined; reason?: string },
): string {
  const choice = chooseModel(list, input);
  const pinned = input.projectModel !== undefined && choice.entry.id === input.projectModel;
  const why = pinned
    ? "set for this project"
    : (choice.note ??
      (input.briefModel
        ? input.reason
        : choice.entry.id === list.defaultId
          ? "default"
          : undefined));
  return `Model: ${modelLabel(choice.entry)}${why ? ` · ${why}` : ""}`;
}

// The list as the brain reads it. One block per named worker when a pack has several.
export function modelInstructions(lists: { worker?: string; list: ModelList }[]): string {
  const block = ({ worker, list }: (typeof lists)[number]) =>
    [
      worker ? `Worker ${worker}:` : "",
      ...list.entries.map(
        (entry) =>
          `- ${entry.id}${entry.effort ? ` (${entry.effort})` : ""}${
            entry.id === list.defaultId ? " [default]" : ""
          }: ${entry.use}`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  return `# Worker models\n\nSet \`model\` in the brief to one id from this list. Leave it out for the default.\n\n${lists.map(block).join("\n\n")}`;
}
