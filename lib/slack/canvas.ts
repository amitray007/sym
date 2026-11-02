import type { Sql } from "../db.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { isReserved, OVER_CAP, reservePost } from "./own-posts.ts";
import { type ReachDeps, reachConversation, resolveTarget, UNREACHABLE } from "./reach.ts";

// Writes to a channel's canvas on request (decision 084). Sym creates the canvas when the channel
// has none, and otherwise adds to its end. It never replaces what people wrote there. Each write
// counts toward the requester's hourly post cap.

// What an approval prompt can show in full.
export const CANVAS_MAX = 2800;

export interface CanvasInput {
  sessionId: string;
  callId: string;
  requester: string | undefined;
  target: string;
  markdown: string;
  title?: string | undefined;
}

export async function writeChannelCanvas(
  deps: ReachDeps & { sql: Sql },
  input: CanvasInput,
): Promise<string> {
  const markdown = input.markdown.trim().slice(0, CANVAS_MAX);
  if (!markdown) return "The canvas text is empty.";
  if (!deps.slack || !input.requester) return UNREACHABLE;
  const target = await resolveTarget(deps.slack, input.target).catch(() => undefined);
  if (!target) return UNREACHABLE;
  const reached = await reachConversation(deps, input.requester, target.channel);
  if (!reached || reached.isDirect) return UNREACHABLE;
  const key = `slack-canvas:${input.sessionId}:${input.callId}`;
  // A canvas write has no outbox row, so a replayed call must not append again.
  if (await isReserved(deps.sql, key)) return "That canvas write already ran.";
  const reservation = {
    key,
    channelId: target.channel,
    requester: input.requester,
    sessionId: input.sessionId,
  };
  if (!(await reservePost(deps.sql, reservation))) return OVER_CAP;
  try {
    return await appendOrCreate(deps.slack, target.channel, markdown, input.title);
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    console.warn(`Sym could not write a canvas: ${code}.`);
    if (code === "team_tier_cannot_create_channel_canvases") {
      return "This Slack plan doesn't allow channel canvases.";
    }
    return "Slack refused the canvas. Do not retry.";
  }
}

// Adds to the channel's canvas, or creates it. When someone else creates it first, Sym adds to
// theirs instead.
async function appendOrCreate(
  slack: SlackApi,
  channel: string,
  markdown: string,
  title: string | undefined,
): Promise<string> {
  const content = { type: "markdown", markdown };
  const append = (canvasId: string) =>
    slack.call("canvases.edit", {
      canvas_id: canvasId,
      changes: [{ operation: "insert_at_end", document_content: content }],
    });
  const existing = await channelCanvasId(slack, channel);
  if (existing) {
    await append(existing);
    return "Added to the channel canvas.";
  }
  try {
    await slack.call("conversations.canvases.create", {
      channel_id: channel,
      ...(title ? { title } : {}),
      document_content: content,
    });
    return "Created the channel canvas.";
  } catch (error) {
    if (!(error instanceof SlackApiError) || error.code !== "channel_canvas_already_exists") {
      throw error;
    }
    const created = await channelCanvasId(slack, channel);
    if (!created) throw error;
    await append(created);
    return "Added to the channel canvas.";
  }
}

async function channelCanvasId(slack: SlackApi, channel: string): Promise<string | undefined> {
  const info = await slack.call("conversations.info", { channel });
  const canvas = (info.channel as { properties?: { canvas?: { file_id?: unknown } } } | undefined)
    ?.properties?.canvas;
  return typeof canvas?.file_id === "string" ? canvas.file_id : undefined;
}
