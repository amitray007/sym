import { openCodeChannel } from "eve/channels/slack";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller } from "../../lib/callers.ts";
import { ledger } from "../../lib/runtime.ts";
import { codeChannelsOn } from "../../lib/slack/code-channel.ts";
import { recordChannelOrigin } from "../../lib/slack/main-thread.ts";
import slack from "../channels/slack.ts";

// Moves the conversation into a new Slack code channel when a person asks (decision 068). Only
// with SYM_CODE_CHANNELS on, and never for a worker thread. Eve opens the channel from the message
// that started the turn, copies the conversation, gives it the thread's privacy, and continues the
// session there. A refusal returns Slack's error code, and the brain answers in the thread.
export default defineDynamic((ctx) => {
  if (!codeChannelsOn() || isWorkerCaller(ctx.session.auth.current)) return null;
  return defineTool({
    description: [
      "Move this Slack conversation into a new code channel. Use it only when the person explicitly asks for a code channel.",
      "Never use it on your own, not even for long or multi-step work. Coding work goes through worker_job: it opens the job's own channel and asks for Start there.",
      "Call it once per request. Slack links the new channel here, so afterward reply in one short sentence at most.",
      "If it returns unavailable or refused, say why in the thread; do not retry.",
    ].join(" "),
    inputSchema: z.object({
      message: z
        .string()
        .describe("The task and where to start. The channel sees the conversation so far."),
      name: z.string().max(80).describe("A short title, such as `Flaky login test`."),
    }),
    async execute({ message, name }, toolCtx) {
      try {
        const opened = await openCodeChannel(toolCtx, slack, message, { name });
        // Decision 079: remember the thread it came from, so the channel can post there on request.
        const { channelId, threadTs } = toolCtx.channel.metadata ?? {};
        if (
          opened.status === "opened" &&
          typeof channelId === "string" &&
          typeof threadTs === "string"
        ) {
          await recordChannelOrigin(ledger(), opened.sessionId, { channel: channelId, threadTs });
        }
        return opened;
      } catch (error) {
        return { status: "refused" as const, reason: errorText(error) };
      }
    },
  });
});

// Eve throws Slack's error as a message that names the method and code; the brain relays it.
function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown_error";
}
