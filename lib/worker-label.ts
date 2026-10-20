// The name Slack users see for the worker (decision 043). The software behind it stays out of
// Slack. Pure, with no Node.js builtins: lib/jobs/** reaches it from a workflow body.

export const DEFAULT_WORKER_LABEL = "Worker";
const MAX_LABEL_LENGTH = 30;

type Env = Record<string, string | undefined>;

function defaultEnv(): Env {
  return typeof process === "undefined" ? {} : process.env;
}

export function workerLabel(env: Env = defaultEnv()): string {
  const text = (env.SYM_WORKER_LABEL ?? "").replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_WORKER_LABEL;
  return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH).trimEnd() : text;
}

/** The label for mid-sentence use, such as "the builder". */
export function workerNoun(env: Env = defaultEnv()): string {
  return workerLabel(env).toLowerCase();
}

/** The dynamic instruction for the brain. */
export function workerLabelInstructions(env: Env = defaultEnv()): string {
  return [
    "# Worker name",
    "",
    `Call the worker "${workerLabel(env)}" in every message. Never name the software that runs it, even if asked.`,
    "Never mention tool names to people.",
  ].join("\n");
}
