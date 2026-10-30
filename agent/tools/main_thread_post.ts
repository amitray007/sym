import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller } from "../../lib/callers.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { MAIN_THREAD_POST_MAX, postToMainThread } from "../../lib/slack/main-thread.ts";

// Posts in the thread a code channel came from, when a person asks (decision 079). A code channel
// is the same agent as its thread, so it can still speak there.
export default defineTool({
  description:
    "From a code channel, post a message in the main thread it came from. Use it only when a person asks, such as 'summarize this in the main thread' or 'let them know in the original thread'. Write the message in your voice for people who were not in the channel: what happened, the outcome, and links such as the PR. Never post there on your own. When the person also asks to close, post first, then call job_close.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(MAIN_THREAD_POST_MAX)
      .describe("The message to post in the main thread. A few short lines."),
  }),
  async execute({ text }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return "Worker threads cannot post in Slack.";
    return postToMainThread(ledgerDeps(), { sessionId: ctx.session.id, callId: ctx.callId, text });
  },
});
