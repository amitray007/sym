import type { Sql } from "../db.ts";
import { envSwitch } from "../env-switch.ts";
import { getJob, type Job, jobRef, updateJob } from "../ledger/jobs.ts";
import { type SlackApi, SlackApiError } from "./api.ts";

// Slack code channels for worker jobs (decision 067, docs/slack-code.md). With SYM_CODE_CHANNELS
// on, a job that a person starts moves from its thread into its own code channel. The channel
// shows the job's status and a context bar, and Close archives it with the result as its summary.
// The channel calls post no message, so they skip the outbox; the one post here, a question link,
// goes through it. Slack refusals fail soft: the job stays where it is, and Sym logs the Slack
// error code only.

export function codeChannelsOn(env: Record<string, string | undefined> = process.env): boolean {
  return envSwitch(env.SYM_CODE_CHANNELS, false);
}

export type SessionStatus = "active" | "processing" | "suspended" | "closed";

interface Deps {
  sql: Sql;
  slack?: SlackApi;
}

// Use the work's title. Add a numeric suffix only after an explicit name collision.
export function codeChannelName(job: Pick<Job, "id" | "title">): string {
  return job.title.slice(0, 80);
}

// The message the channel starts from: the person's latest message in the thread, else the
// thread root. Slack invites its author and links the channel there.
async function originOf(sql: Sql, job: Job): Promise<string | null> {
  if (!job.sessionId) return job.slackThreadTs;
  const [row] = await sql<{ messageTs: string | null; channelId: string }[]>`
    select message_ts, channel_id from session_threads where session_id = ${job.sessionId}
  `;
  if (row?.messageTs && row.channelId === job.slackChannel) return row.messageTs;
  return job.slackThreadTs;
}

// Moves a job into a new code channel before its brief posts, so the brief, Start, and the work
// stay out of the thread it was asked in (decision 077). `status` is the channel's first status:
// `suspended` while the job waits for Start. A job proposed inside a code channel, such as one the
// `code_channel` tool opened, takes that channel instead of opening another (decision 068).
// Returns the updated job, or the job unchanged when the feature is off, Slack is not configured,
// the job is already moved, or the thread is a direct message or a Slack Connect channel. Any
// Slack refusal also keeps the job in its thread. A private thread gets a private channel; one Slack opens as public anyway is
// archived, as Eve does. A failed ledger write throws, so the step retries, and the retry reaches
// the same channel through session_id.
export async function moveToCodeChannel(
  deps: Deps,
  job: Job,
  status: SessionStatus = "processing",
): Promise<Job> {
  if (!codeChannelsOn() || !deps.slack || job.codeChannel) return job;
  const slack = deps.slack;
  const channel = job.slackChannel;
  if (!channel) return job;
  let from: ConversationInfo;
  try {
    from = await conversation(slack, channel);
  } catch (error) {
    console.warn(`Sym kept ${jobRef(job.id)} in its thread.`, slackCode(error));
    return job;
  }
  if (isCodeChannel(from)) return adoptCodeChannel(deps, job, status);
  const origin = await originOf(deps.sql, job);
  if (!origin) return job;
  let channelId: string;
  try {
    if (from.is_im || from.is_mpim || from.is_ext_shared) return job;
    const isPrivate = from.is_private === true;
    const create = (name: string) =>
      slack.call("agents.conversations.create", {
        name,
        session_id: `sym-${jobRef(job.id)}`,
        origin_channel_id: channel,
        origin_message_ts: origin,
        ...(isPrivate ? { is_private: true } : {}),
      });
    let created: Record<string, unknown>;
    try {
      created = await create(codeChannelName(job));
    } catch (error) {
      if (slackCode(error) !== "name_taken") throw error;
      const suffix = ` #${job.id}`;
      created = await create(`${job.title.slice(0, 80 - suffix.length)}${suffix}`);
    }
    if (typeof created.channel_id !== "string" || !created.channel_id) return job;
    channelId = created.channel_id;
    if (isPrivate && (await conversation(slack, channelId)).is_private !== true) {
      await slack.call("agents.conversations.archive", { channel_id: channelId }).catch(() => {});
      console.warn(
        `Sym kept ${jobRef(job.id)} in its private thread: Slack opened a public channel.`,
      );
      return job;
    }
  } catch (error) {
    console.warn(`Sym kept ${jobRef(job.id)} in its thread.`, slackCode(error));
    return job;
  }
  const moved = await updateJob(deps.sql, job.id, {
    slackChannel: channelId,
    slackThreadTs: null,
    codeChannel: true,
    originChannel: channel,
    originThreadTs: job.slackThreadTs ?? origin,
  });
  await setContextBar(deps, moved);
  await setChannelStatus(deps, moved, status);
  return moved;
}

// The job already lives in a code channel: it posts top-level there and keeps the channel's status
// and context bar, with no origin thread of its own.
async function adoptCodeChannel(deps: Deps, job: Job, status: SessionStatus): Promise<Job> {
  const adopted = await updateJob(deps.sql, job.id, { slackThreadTs: null, codeChannel: true });
  await setContextBar(deps, adopted);
  await setChannelStatus(deps, adopted, status);
  return adopted;
}

interface ConversationInfo {
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_ext_shared?: boolean;
  properties?: { record_channel?: { record_type?: string } };
}

async function conversation(slack: SlackApi, channel: string): Promise<ConversationInfo> {
  const info = await slack.call("conversations.info", { channel });
  return (info.channel ?? {}) as ConversationInfo;
}

function isCodeChannel(info: ConversationInfo): boolean {
  return info.properties?.record_channel?.record_type === "agent_channel";
}

// The context bar: its project, its pull request once there is one, and Close. Slack keeps at
// most five items and replaces the whole bar on each call.
// The bar's Close action (decision 076). Slack sends a code_channel_action event on a click.
const CLOSE_ITEM = { key: "close", label: "Close channel", icon: "lock", item_type: "action" };

// A conversation channel has no job, and Eve's openCodeChannel returns no channel ID, so nothing
// sets its bar at creation. The first turn there adds the Close item. Once per process is enough:
// Slack keeps the bar, and a repeat after a restart rewrites the same item.
const conversationBars = new Set<string>();
export async function ensureConversationBar(deps: Deps, channelId: string): Promise<void> {
  if (!deps.slack || conversationBars.has(channelId)) return;
  conversationBars.add(channelId);
  try {
    await deps.slack.call("agents.conversations.setProperties", {
      channel_id: channelId,
      code_channel: { context_bar_items: [CLOSE_ITEM] },
    });
  } catch (error) {
    conversationBars.delete(channelId);
    console.warn("Sym could not set the context bar of a code channel.", slackCode(error));
  }
}

export async function setContextBar(deps: Deps, job: Job, project?: string): Promise<void> {
  if (!job.codeChannel || !job.slackChannel || !deps.slack) return;
  const name = project ?? projectOf(job);
  const items = [
    ...(name ? [{ key: "project", label: name, icon: "folder" }] : []),
    ...(job.prUrl ? [{ key: "pr", label: "Pull request", icon: "branch", url: job.prUrl }] : []),
    CLOSE_ITEM,
  ];
  try {
    await deps.slack.call("agents.conversations.setProperties", {
      channel_id: job.slackChannel,
      code_channel: { context_bar_items: items },
    });
  } catch (error) {
    console.warn(`Sym could not set the context bar of ${jobRef(job.id)}.`, slackCode(error));
  }
}

export async function setChannelStatus(deps: Deps, job: Job, status: SessionStatus): Promise<void> {
  if (!job.codeChannel || !job.slackChannel || !deps.slack) return;
  try {
    await deps.slack.call("agents.sessions.setStatus", { channel_id: job.slackChannel, status });
  } catch (error) {
    console.warn(`Sym could not set the status of ${jobRef(job.id)}.`, slackCode(error));
  }
}

// Archives a closed job's channel. It passes no summary: Slack would label the session card in the
// main thread with it, and Sym posts there only when a person asks (decision 079).
export async function archiveCodeChannel(deps: Deps, job: Job): Promise<boolean> {
  const slack = deps.slack;
  const channel = job.slackChannel;
  if (!job.codeChannel || !channel || !slack) return false;
  try {
    await slack.call("agents.conversations.archive", { channel_id: channel });
  } catch (error) {
    const code = slackCode(error);
    if (code !== "already_archived") {
      console.warn(`Sym could not archive the channel of ${jobRef(job.id)}.`, code);
      return false;
    }
  }
  await setChannelStatus(deps, job, "closed");
  return true;
}

// The session status that matches a job: working, waiting on a person, or done. Undefined for a
// job with no session to show.
export function jobSessionStatus(job: Job): SessionStatus | undefined {
  if (!job.codeChannel) return undefined;
  if (job.archiveState === "archived") return "closed";
  // A job proposed in its channel waits for Start there (decision 077).
  if (job.status === "launching" && !job.workerThreadId) return "suspended";
  if (job.status === "waiting_input" || job.status === "waiting_permission") return "suspended";
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return "active";
  }
  return "processing";
}

// The newest job whose code channel this is. Every message in the channel belongs to it.
export async function jobOfCodeChannel(sql: Sql, channelId: string): Promise<Job | undefined> {
  const [row] = await sql<{ id: number }[]>`
    select id from jobs where slack_channel = ${channelId} and code_channel
    order by id desc limit 1
  `;
  return row ? getJob(sql, Number(row.id)) : undefined;
}

function projectOf(job: Job): string | undefined {
  const brief = job.brief as { project?: unknown } | null;
  return typeof brief?.project === "string" ? brief.project : undefined;
}

function slackCode(error: unknown): string {
  if (error instanceof SlackApiError) return error.code;
  return error instanceof Error ? error.name : "unknown_error";
}

// When Slack opens a code channel it posts a quote of the origin message, with the origin's author
// and text. A quoted mention of Sym then arrives as a new app_mention, and Eve 0.88 checks for
// the quote only on plain channel messages. The quote is context, not a request.
export function isOriginQuote(raw: Record<string, unknown>): boolean {
  const blocks = raw.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some((block) => (block as { block_id?: unknown })?.block_id === ORIGIN_QUOTE_BLOCK)
  );
}

const ORIGIN_QUOTE_BLOCK = "agent_channel_origin_context";
