import type { Sql } from "../db.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { OVER_CAP, reservePost } from "./own-posts.ts";
import { type ReachDeps, reachConversation, resolveTarget, UNREACHABLE } from "./reach.ts";

// Writes to a channel's canvas on request (decision 084). Sym creates the canvas when the channel
// has none, and otherwise adds to its end. It never replaces what people wrote there. Each write
// counts toward the requester's hourly post cap.

export const CANVAS_MAX = 20_000;

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
  const reserved = await reservePost(deps.sql, {
    key: `slack-canvas:${input.sessionId}:${input.callId}`,
    channelId: target.channel,
    requester: input.requester,
    sessionId: input.sessionId,
  });
  if (!reserved) return OVER_CAP;
  const content = { type: "markdown", markdown };
  try {
    const existing = await channelCanvasId(deps.slack, target.channel);
    if (existing) {
      await deps.slack.call("canvases.edit", {
        canvas_id: existing,
        changes: [{ operation: "insert_at_end", document_content: content }],
      });
      return "Added to the channel canvas.";
    }
    await deps.slack.call("conversations.canvases.create", {
      channel_id: target.channel,
      ...(input.title ? { title: input.title } : {}),
      document_content: content,
    });
    return "Created the channel canvas.";
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    console.warn(`Sym could not write a canvas: ${code}.`);
    if (code === "team_tier_cannot_create_channel_canvases") {
      return "This Slack plan doesn't allow channel canvases.";
    }
    return "Slack refused the canvas. Do not retry.";
  }
}

async function channelCanvasId(slack: SlackApi, channel: string): Promise<string | undefined> {
  const info = await slack.call("conversations.info", { channel });
  const canvas = (info.channel as { properties?: { canvas?: { file_id?: unknown } } } | undefined)
    ?.properties?.canvas;
  return typeof canvas?.file_id === "string" ? canvas.file_id : undefined;
}
