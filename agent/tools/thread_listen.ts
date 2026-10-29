import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger } from "../../lib/runtime.ts";
import { LISTEN_MODES } from "../../lib/slack/addressing.ts";
import { changeListenMode } from "../../lib/slack/listen-setting.ts";

// "Only answer when tagged" in a thread with several people (decision 050). The setting is kept
// per thread. It only makes Sym quieter, or back to normal, so anyone allowed may change it and
// it needs no approval.
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Set how Sym listens in this Slack thread when someone asks. 'mention-only' means answer " +
    "only when tagged. 'all' means answer messages meant for Sym, the default. Works in a " +
    "channel thread, not a direct message. Reply with the one-line result.",
  inputSchema: z.object({
    mode: z.enum(LISTEN_MODES).describe("mention-only: answer only when tagged. all: the default."),
  }),
  label: { start: ({ mode }) => `Listen: ${mode}` },
  async execute({ mode }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const sql = ledger();
    return changeListenMode({
      sql,
      thread: await getSessionThread(sql, ctx.session.id),
      mode,
      userId: slackUserOfPrincipal(ctx.session.auth.current?.principalId),
    });
  },
});
