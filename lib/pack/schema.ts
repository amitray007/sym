// The adopter pack manifest (docs/adopting.md). A pack holds adopter specifics only. It never
// holds secrets, so the schema rejects any field that looks like one.
import { z } from "zod";

const slackUserId = z
  .string()
  .regex(/^[UW][A-Z0-9]+$/, "must be a Slack user ID such as U0123456789");
const slackChannelId = z.string().regex(/^[CGD][A-Z0-9]+$/, "must be a Slack channel ID");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must look like HH:MM");
const relativeFile = z.string().min(1).endsWith(".md", "must be a Markdown file");

const worker = z.strictObject({
  name: z.string().min(1),
  kind: z.literal("t3"),
  // The MCP URL from the worker's settings. It must carry no credentials.
  mcpUrl: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, "must not carry credentials, a query, or a fragment"),
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
    pack.projects.forEach((p, index) => {
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
