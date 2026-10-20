// The adopter pack manifest (docs/adopting.md). A pack holds adopter specifics only. It never
// holds secrets, so the schema rejects any field that looks like one.
import { z } from "zod";
import { DEFAULT_MODELS, MODEL_ID } from "../workers/models.ts";

const slackUserId = z
  .string()
  .regex(/^[UW][A-Z0-9]+$/, "must be a Slack user ID such as U0123456789");
const slackChannelId = z.string().regex(/^[CGD][A-Z0-9]+$/, "must be a Slack channel ID");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must look like HH:MM");
const relativeFile = z.string().min(1).endsWith(".md", "must be a Markdown file");

const modelId = z.string().regex(MODEL_ID, "must look like <provider>/<model>");

// One model the brain may pick for a worker job (decision 041).
const workerModelEntry = z.strictObject({
  id: modelId,
  // When to pick this model. The brain reads it.
  use: z.string().min(1),
  effort: z.string().min(1).optional(),
  default: z.boolean().optional(),
});

const worker = z.strictObject({
  name: z.string().min(1),
  kind: z.literal("t3"),
  // The MCP URL from the worker's settings. It must carry no credentials.
  mcpUrl: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, "must not carry credentials, a query, or a fragment"),
  // The models the brain may pick. Without any, the built-in list applies.
  models: z.array(workerModelEntry).optional(),
});

const project = z.strictObject({
  name: z.string().min(1),
  worker: z.string().min(1),
  // The worker's project ID or title. Defaults to `name`.
  workerProject: z.string().min(1).optional(),
  allowedPaths: z.array(z.string().min(1)).min(1),
  defaultBaseBranch: z.string().min(1).default("main"),
  // "none" means the worker never pushes or opens a pull request.
  prPolicy: z.enum(["none", "draft"]).default("none"),
  productionData: z.literal("read-only").default("read-only"),
  // Always run this project's jobs on this model. It must be on the worker's list.
  model: modelId.optional(),
});

export const packSchema = z
  .strictObject({
    owner: z.strictObject({ slackUserId: slackUserId }),
    allowList: z.array(slackUserId).default([]),
    timeZone: z.string().min(1).optional(),
    quietHours: z.strictObject({ from: clock, to: clock }).optional(),
    channels: z
      .strictObject({ default: slackChannelId, digest: slackChannelId.optional() })
      .optional(),
    workers: z.array(worker).default([]),
    projects: z.array(project).default([]),
    // Markdown files, relative to the pack folder.
    instructions: z.array(relativeFile).default([]),
    // The brain's persona, such as personas/dry.md. It wins over SYM_PERSONA (decision 044).
    persona: relativeFile.optional(),
    playbooks: z.array(relativeFile).default([]),
  })
  .superRefine((pack, ctx) => {
    const names = new Set(pack.workers.map((w) => w.name));
    if (names.size !== pack.workers.length) {
      ctx.addIssue({ code: "custom", path: ["workers"], message: "worker names must be unique" });
    }
    const projectNames = pack.projects.map((p) => p.name.toLowerCase());
    if (new Set(projectNames).size !== projectNames.length) {
      ctx.addIssue({ code: "custom", path: ["projects"], message: "project names must be unique" });
    }
    pack.workers.forEach((w, index) => {
      const ids = (w.models ?? []).map((m) => m.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", index, "models"],
          message: "model ids must be unique",
        });
      }
      if ((w.models ?? []).filter((m) => m.default).length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", index, "models"],
          message: "at most one model can set default: true",
        });
      }
    });
    pack.projects.forEach((p, index) => {
      const worker = pack.workers.find((w) => w.name === p.worker);
      if (p.model && worker) {
        const listed = worker.models?.length ? worker.models : DEFAULT_MODELS;
        if (!listed.some((m) => m.id === p.model)) {
          ctx.addIssue({
            code: "custom",
            path: ["projects", index, "model"],
            message: `"${p.model}" is not in the model list of worker "${worker.name}"`,
          });
        }
      }
      if (!names.has(p.worker)) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", index, "worker"],
          message: `unknown worker "${p.worker}"`,
        });
      }
    });
  });

export type PackConfig = z.infer<typeof packSchema>;
export type PackProject = PackConfig["projects"][number];
export type PackWorker = PackConfig["workers"][number];

const SECRET_KEY =
  /token|secret|passw(or)?d|api[-_]?key|private[-_]?key|credential|^key$|_key$|Key$/;

// Finds the path of every object key that looks like a secret field.
export function findSecretFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecretFields(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const here = path ? `${path}.${key}` : key;
      return [...(SECRET_KEY.test(key) ? [here] : []), ...findSecretFields(child, here)];
    });
  }
  return [];
}
