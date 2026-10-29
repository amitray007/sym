import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { getJob, type Job, jobRef, updateJob } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import type { SlackApi } from "./api.ts";

// Slack code channels for worker jobs (decision 067, docs/slack-code.md). With SYM_CODE_CHANNELS
// on, a job that a person starts moves from its thread into its own code channel. The channel
// shows the job's status and a context bar, and Close archives it with the result as its summary.
// The channel calls post no message, so they skip the outbox; the one post here, a question link,
// goes through it. Slack refusals fail soft: the job stays where it is, and Sym logs the Slack
// error code only.

export function codeChannelsOn(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.SYM_CODE_CHANNELS?.trim() ?? "");
}

export type SessionStatus = "active" | "processing" | "suspended" | "closed";

interface Deps {
  sql: Sql;
  slack?: SlackApi;
}

// Slack names a channel from its title. The ref keeps it unique and findable.
export function codeChannelName(job: Pick<Job, "id" | "title">): string {
  return `${jobRef(job.id)} ${job.title}`.slice(0, 80);
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

// Moves a started job into a new code channel. Returns the updated job, or the job unchanged when
// the feature is off, Slack is not configured, the job is already moved, or the thread is a direct
// message, a Slack Connect channel, or a code channel itself. Any Slack refusal also keeps the job
// in its thread. A private thread gets a private channel; one Slack opens as public anyway is
// archived, as Eve does. A failed ledger write throws, so the step retries, and the retry reaches
// the same channel through session_id.
export async function moveToCodeChannel(deps: Deps, job: Job): Promise<Job> {
  if (!codeChannelsOn() || !deps.slack || job.codeChannel) return job;
  const slack = deps.slack;
  const channel = job.slackChannel;
  if (!channel) return job;
  const origin = await originOf(deps.sql, job);
  if (!origin) return job;
  let channelId: string;
  try {
    const from = await conversation(slack, channel);
    if (from.is_im || from.is_mpim || from.is_ext_shared || isCodeChannel(from)) return job;
    const isPrivate = from.is_private === true;
    const created = await slack.call("agents.conversations.create", {
      name: codeChannelName(job),
      session_id: `sym-${jobRef(job.id)}`,
      origin_channel_id: channel,
      origin_message_ts: origin,
      ...(isPrivate ? { is_private: true } : {}),
    });
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
  await setChannelStatus(deps, moved, "processing");
  return moved;
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

// Eve asks a moved job's questions in the thread it came from, because the job's task runs in that
// thread's session. The channel shows the question with a link there, so people find it.
export async function pointToQuestion(
  deps: Deps,
  job: Job,
  requestId: string,
  prompt: string,
): Promise<void> {
  if (!job.codeChannel || !job.slackChannel) return;
  const ref = jobRef(job.id);
  let link: string | undefined;
  if (deps.slack && job.originChannel && job.originThreadTs) {
    const permalink = await deps.slack
      .call("chat.getPermalink", { channel: job.originChannel, message_ts: job.originThreadTs })
      .catch(() => undefined);
    if (typeof permalink?.permalink === "string") link = permalink.permalink;
  }
  const where = link ? `<${link}|the thread where it started>` : "the thread where it started";
  const text = `${ref} has a question: ${prompt.slice(0, 500)}\nAnswer it in ${where}.`;
  await enqueuePost(deps.sql, {
    idempotencyKey: `${ref}:question-link:${requestId}`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: { channel: job.slackChannel, text },
    display: chooseDisplay({
      kind: job.kind,
      needsAction: true,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: 2,
      surface: "channel",
      quiet: false,
    }),
  });
}

// The context bar: the job, its project, and its pull request once there is one. Slack keeps at
// most five items and replaces the whole bar on each call.
export async function setContextBar(deps: Deps, job: Job, project?: string): Promise<void> {
  if (!job.codeChannel || !job.slackChannel || !deps.slack) return;
  const name = project ?? projectOf(job);
  const items = [
    { key: "job", label: jobRef(job.id), icon: "code" },
    ...(name ? [{ key: "project", label: name, icon: "folder" }] : []),
    ...(job.prUrl ? [{ key: "pr", label: "Pull request", icon: "branch", url: job.prUrl }] : []),
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

// Archives a closed job's channel. The result post becomes the summary Slack shares in the
// origin thread. A channel Slack opened without an origin takes no summary, so Sym archives it
// without one.
export async function archiveCodeChannel(
  deps: Deps,
  job: Job,
  summaryTs: string | null,
): Promise<void> {
  if (!job.codeChannel || !job.slackChannel || !deps.slack) return;
  await setChannelStatus(deps, job, "closed");
  const archive = (summary: string | null) =>
    deps.slack?.call("agents.conversations.archive", {
      channel_id: job.slackChannel,
      ...(summary ? { summary_message_ts: summary } : {}),
    });
  try {
    await archive(summaryTs);
  } catch (error) {
    const code = slackCode(error);
    if (code === "already_archived") return;
    if (summaryTs && (code === "no_origin_link" || code === "summary_message_not_found")) {
      await archive(null)?.catch((retry: unknown) => {
        console.warn(`Sym could not archive the channel of ${jobRef(job.id)}.`, slackCode(retry));
      });
      return;
    }
    console.warn(`Sym could not archive the channel of ${jobRef(job.id)}.`, code);
  }
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
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown_error";
}
