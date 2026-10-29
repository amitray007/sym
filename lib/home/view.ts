import { statusWords } from "../jobs/status.ts";
import { type Job, jobRef } from "../ledger/jobs.ts";
import type { Schedule } from "../schedules/rows.ts";
import { workerLabel } from "../worker-label.ts";

// The App Home tab (decision 052). Pure: data in, Block Kit out. The caller decides who gets which
// role and gathers the data (lib/home/collect.ts). Text from jobs and schedules is data, so it is
// escaped and cut before it reaches a block.

// Slack allows 100 blocks per Home view and 3000 characters per section text.
export const MAX_BLOCKS = 100;
export const MAX_SECTION_CHARS = 3000;
export const MAX_ACTIVE_JOBS = 10;
export const MAX_FINISHED_JOBS = 5;
export const MAX_SCHEDULES = 10;
export const MAX_PROJECTS = 20;
const MAX_TITLE_CHARS = 80;
const MAX_LINE_CHARS = 220;

export type HomeRole = "denied" | "member" | "owner";

export type WorkerHealth =
  | { state: "reachable"; expiresAt: Date | null }
  | { state: "not_signed_in" }
  | { state: "unknown"; expiresAt: Date | null };

export interface HomeConnection {
  name: string;
  status: string;
  // "OAuth sign-in valid", "token set", "no sign-in", and so on. Never a token.
  auth: string;
  // `auto`, `ask`, `hidden`, or null when tool hints decide.
  defaultMode: string | null;
}

export interface HomeData {
  now: Date;
  persona: { name: string; source: string };
  worker: WorkerHealth;
  active: Job[];
  closures?: Job[];
  finished: { done: number; failed: number; cancelled: number; latest: Job[] };
  schedules: Schedule[];
  // The allow-list names only. The collector never reads any other project.
  projects: string[];
  // Present for the owner only.
  owner?: {
    connections: HomeConnection[];
    quietUntil: Date | null;
  };
}

// Slack block objects stay loose: the view goes straight to `views.publish`.
export type Block = Record<string, unknown>;
export interface HomeView {
  type: "home";
  blocks: Block[];
}

export const NOT_SET_UP = "I'm not set up to help you yet. Ask the owner for access.";

/** Escapes the three characters Slack reads as markup. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

// Keeps a section under Slack's limit, cutting whole lines.
function fitText(text: string): string {
  if (text.length <= MAX_SECTION_CHARS) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && lines.join("\n").length > MAX_SECTION_CHARS - 20) lines.pop();
  const kept = lines.join("\n");
  return kept.length > MAX_SECTION_CHARS ? kept.slice(0, MAX_SECTION_CHARS) : `${kept}\n_+ more_`;
}

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text: fitText(text) },
});

const heading = (text: string): Block => section(`*${text}*`);

// Lists at most `max` lines, then "+N more".
function listLines(lines: string[], max: number): string {
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`_+${lines.length - max} more_`);
  return shown.join("\n");
}

// A Slack deep link to a thread, or to a job's own code channel (decision 067). It works in any
// workspace the reader is signed in to.
function threadLink(job: Job): string | undefined {
  if (job.codeChannel && job.slackChannel) {
    return `https://slack.com/app_redirect?channel=${encodeURIComponent(job.slackChannel)}`;
  }
  if (!job.slackChannel || !job.slackThreadTs) return undefined;
  const channel = encodeURIComponent(job.slackChannel);
  const ts = encodeURIComponent(job.slackThreadTs);
  return `https://slack.com/app_redirect?channel=${channel}&message_ts=${ts}`;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} days`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} hours`;
  return `${minutes} minutes`;
}
function needsYou(job: Job, now: Date): boolean {
  return (
    ["launching", "waiting_input", "waiting_permission", "worker_offline"].includes(job.status) ||
    Boolean(
      job.closedAt &&
        (!job.workerSettledAt || (job.codeChannel && job.archiveState !== "archived")),
    ) ||
    ["pending", "repair"].includes(job.archiveState) ||
    (!job.finishedAt &&
      now.getTime() - (job.lastActivityAt ?? job.startedAt ?? job.createdAt).getTime() >=
        86_400_000)
  );
}
function jobLine(job: Job, now: Date): string {
  const link = threadLink(job);
  const ref = link ? `<${link}|${esc(jobRef(job.id))}>` : esc(jobRef(job.id));
  const since = job.finishedAt ?? job.lastActivityAt ?? job.startedAt ?? job.createdAt;
  const age = duration(now.getTime() - since.getTime());
  const state =
    job.closedAt && job.codeChannel && job.archiveState !== "archived"
      ? job.archiveState === "repair" || job.archiveError
        ? "channel archive failed; needs repair"
        : "channel archive pending"
      : job.closedAt && !job.workerSettledAt
        ? "worker settlement pending"
        : job.status === "launching"
          ? "waiting for you to start it"
          : job.status === "worker_offline"
            ? "worker is offline"
            : !job.finishedAt && needsYou(job, now) && !job.status.startsWith("waiting")
              ? `no activity for ${age}`
              : statusWords()[job.status];
  return `${ref} · ${esc(clip(job.title, MAX_TITLE_CHARS))} · ${state} · ${age}${job.finishedAt ? " ago" : ""}`;
}

// Slack shows the time in the reader's own zone.
function slackDate(at: Date): string {
  return `<!date^${Math.floor(at.getTime() / 1000)}^{date_short_pretty} {time}|${at.toISOString()}>`;
}

function expiryText(expiresAt: Date | null, now: Date): string {
  if (!expiresAt) return "sign-in expiry unknown";
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return "sign-in expired";
  const days = Math.ceil(left / 86_400_000);
  return `sign-in expires in ${days} ${days === 1 ? "day" : "days"}`;
}

function workerLine(worker: WorkerHealth, now: Date): string {
  const label = esc(workerLabel());
  switch (worker.state) {
    case "reachable":
      return `*${label}:* signed in · ${expiryText(worker.expiresAt, now)}`;
    case "not_signed_in":
      return `*${label}:* not signed in`;
    case "unknown":
      return `*${label}:* status unknown · ${expiryText(worker.expiresAt, now)}`;
  }
}

function connectionLine(connection: HomeConnection): string {
  const mode =
    connection.defaultMode === "hidden"
      ? "tools hidden"
      : connection.defaultMode === "auto"
        ? "runs without asking"
        : connection.defaultMode === "ask"
          ? "asks before each call"
          : "reads tools marked read-only, asks before other calls";
  return clip(
    `${esc(connection.name)}: ${mode}; individual tool settings still apply. ${esc(connection.auth)}.`,
    MAX_LINE_CHARS,
  );
}

function quietText(until: Date | null, now: Date): string {
  return until && until.getTime() > now.getTime()
    ? `quiet until ${slackDate(until)}`
    : "quiet mode off";
}

/** Builds the Home view for one role. */
export function homeView(role: HomeRole, data?: HomeData): HomeView {
  if (role === "denied" || !data) {
    return { type: "home", blocks: [section(NOT_SET_UP)] };
  }
  const { now } = data;
  const attention = [
    ...new Map(
      [...data.active, ...(data.closures ?? []), ...data.finished.latest]
        .filter((job) => needsYou(job, now))
        .map((job) => [job.id, job]),
    ).values(),
  ];
  const pendingSchedules = data.schedules.filter(
    (schedule) => schedule.status === "pending_approval",
  );
  const count = attention.length + pendingSchedules.length;
  const running = data.active.filter((job) => !needsYou(job, now));
  const blocks: Block[] = [
    section(
      count === 0
        ? "Nothing needs you."
        : `${count === 1 ? "One item needs" : `${count} items need`} you.`,
    ),
  ];
  const jobs = (label: string, rows: Job[], limit: number) => {
    if (!rows.length) return;
    blocks.push(heading(label));
    blocks.push(
      section(
        listLines(
          rows.map((job) => jobLine(job, now)),
          limit,
        ),
      ),
    );
  };
  if (count) {
    blocks.push(heading("Needs you"));
    blocks.push(
      section(
        listLines(
          [
            ...attention.map((job) => jobLine(job, now)),
            ...pendingSchedules.map(
              (schedule) =>
                `S-${schedule.id} · ${esc(clip(schedule.title, MAX_TITLE_CHARS))} · waiting for approval`,
            ),
          ],
          MAX_ACTIVE_JOBS,
        ),
      ),
    );
  }
  jobs("Running", running, MAX_ACTIVE_JOBS);
  jobs(
    "Finished today",
    data.finished.latest.filter((job) => !attention.some((item) => item.id === job.id)),
    MAX_FINISHED_JOBS,
  );
  if (!count && !data.active.length && !data.finished.latest.length)
    blocks.push(section("Ask me to start something."));
  if (role === "owner" && data.owner) {
    blocks.push(heading("Setup"));
    blocks.push(
      section(
        [
          workerLine(data.worker, now),
          `Persona ${esc(data.persona.name)} · ${quietText(data.owner.quietUntil, now)}`,
          `Projects: ${
            data.projects.length
              ? data.projects
                  .slice(0, MAX_PROJECTS)
                  .map((name) => esc(clip(name, MAX_TITLE_CHARS)))
                  .join(", ")
              : "none configured"
          }`,
          ...data.owner.connections.slice(0, MAX_SCHEDULES).map(connectionLine),
        ].join("\n"),
      ),
    );
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Updated ${slackDate(now)}` }],
  });
  return { type: "home", blocks: blocks.slice(0, MAX_BLOCKS) };
}
