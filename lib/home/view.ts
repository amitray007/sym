import { formatDuration } from "../jobs/card.ts";
import { STATUS_EMOJI, statusWords } from "../jobs/status.ts";
import { type Job, jobRef } from "../ledger/jobs.ts";
import { type Schedule, scheduleRef } from "../schedules/rows.ts";
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

export const NOT_SET_UP = "Sym isn't set up for you.";

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

function jobAge(job: Job, now: Date): string {
  if (job.finishedAt) return `${formatDuration(now.getTime() - job.finishedAt.getTime())} ago`;
  const since = job.startedAt ?? job.createdAt;
  return formatDuration(now.getTime() - since.getTime());
}

function jobLine(job: Job, now: Date): string {
  const link = threadLink(job);
  const ref = link ? `<${link}|${esc(jobRef(job.id))}>` : esc(jobRef(job.id));
  const title = esc(clip(job.title, MAX_TITLE_CHARS));
  return `${STATUS_EMOJI[job.status]} ${ref} · ${title} · ${statusWords()[job.status]} · ${jobAge(job, now)}`;
}

// Jobs that wait for a person come first, then the rest by reference.
const NEEDS_YOU = new Set(["waiting_input", "waiting_permission"]);
function byAttention(a: Job, b: Job): number {
  const need = Number(NEEDS_YOU.has(b.status)) - Number(NEEDS_YOU.has(a.status));
  return need !== 0 ? need : a.id - b.id;
}

// Slack shows the time in the reader's own zone.
function slackDate(at: Date): string {
  return `<!date^${Math.floor(at.getTime() / 1000)}^{date_short_pretty} {time}|${at.toISOString()}>`;
}

function scheduleLine(schedule: Schedule): string {
  const ref = scheduleRef(schedule.id);
  const title = esc(clip(schedule.title, MAX_TITLE_CHARS));
  if (schedule.status === "paused") return `⏸ ${ref} · ${title} · paused`;
  if (schedule.status === "pending_approval") return `⏳ ${ref} · ${title} · waiting for approval`;
  const next = schedule.nextFireAt ? `next ${slackDate(schedule.nextFireAt)}` : "no next run";
  return `🗓 ${ref} · ${title} · ${next}`;
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
      return `*${label}:* ✅ reachable, signed in · ${expiryText(worker.expiresAt, now)}`;
    case "not_signed_in":
      return `*${label}:* ⚠️ not signed in`;
    case "unknown":
      return `*${label}:* ❔ status unknown · ${expiryText(worker.expiresAt, now)}`;
  }
}

function connectionLine(connection: HomeConnection): string {
  const mode = connection.defaultMode
    ? `default mode ${connection.defaultMode}`
    : "default mode by tool hints";
  return clip(
    `• \`${esc(connection.name)}\` · ${connection.status} · ${esc(connection.auth)} · ${mode}`,
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
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: "Sym" } },
    section(`*Persona:* ${esc(data.persona.name)}\n${workerLine(data.worker, now)}`),
    { type: "divider" },
  ];

  const active = [...data.active].sort(byAttention);
  blocks.push(heading(`Running and waiting (${active.length})`));
  blocks.push(
    section(
      active.length === 0
        ? "_No active jobs._"
        : listLines(
            active.map((job) => jobLine(job, now)),
            MAX_ACTIVE_JOBS,
          ),
    ),
  );

  const { finished } = data;
  const total = finished.done + finished.failed + finished.cancelled;
  blocks.push(heading("Finished in the last 24 hours"));
  blocks.push(
    section(
      total === 0
        ? "_None._"
        : [
            `✅ ${finished.done} done · ❌ ${finished.failed} failed` +
              (finished.cancelled > 0 ? ` · 🚫 ${finished.cancelled} cancelled` : ""),
            listLines(
              finished.latest.map((job) => jobLine(job, now)),
              MAX_FINISHED_JOBS,
            ),
          ].join("\n"),
    ),
  );

  blocks.push(heading(`Schedules (${data.schedules.length})`));
  blocks.push(
    section(
      data.schedules.length === 0
        ? "_No schedules._"
        : listLines(data.schedules.map(scheduleLine), MAX_SCHEDULES),
    ),
  );

  blocks.push(heading("Projects Sym works on"));
  blocks.push(
    section(
      data.projects.length === 0
        ? "_None configured._"
        : listLines(
            data.projects.map((name) => `• ${esc(clip(name, MAX_TITLE_CHARS))}`),
            MAX_PROJECTS,
          ),
    ),
  );

  if (role === "owner" && data.owner) {
    blocks.push({ type: "divider" });
    blocks.push(heading(`Connections (${data.owner.connections.length})`));
    blocks.push(
      section(
        data.owner.connections.length === 0
          ? "_No MCP connections._"
          : listLines(data.owner.connections.map(connectionLine), MAX_SCHEDULES),
      ),
    );
    blocks.push(heading("Settings"));
    blocks.push(
      section(
        `Persona ${esc(data.persona.name)} (${esc(data.persona.source)}) · ${quietText(data.owner.quietUntil, now)}`,
      ),
    );
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Updated ${slackDate(now)}` }],
  });
  return { type: "home", blocks: blocks.slice(0, MAX_BLOCKS) };
}
