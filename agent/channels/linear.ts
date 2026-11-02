import type { RouteHandlerArgs } from "eve/channels";
import { type LinearChannelState, linearChannel } from "eve/channels/linear";
import { onLinearAgentSession, onLinearData } from "../../lib/integrations/linear.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { linearConfigured } from "../../lib/triggers/sources.ts";

// Linear webhooks at /eve/v1/linear (decision 091). Eve verifies Linear-Signature and the
// timestamp with LINEAR_WEBHOOK_SECRET and calls these hooks. No session runs in Linear: a
// delegation from a mapped, allowed person moves to that person's Slack DM, and issue events fire
// `linear` triggers, whose runs post in Slack. Without the Linear variables the route answers 404
// and does nothing.

const warn = (what: string) => (error: unknown) => {
  console.warn(`Sym could not handle a Linear ${what}.`, (error as Error)?.name ?? "Error");
};

const channel = linearChannel({
  async onAgentSession(ctx, event) {
    await onLinearAgentSession(ledgerDeps(), ctx, event).catch(warn("agent session"));
    return null;
  },
  async onDataWebhook(event) {
    await onLinearData(ledgerDeps(), event).catch(warn("issue event"));
  },
});

const notFound = () => new Response("not found", { status: 404 });

const linear: typeof channel = {
  ...channel,
  routes: channel.routes.map((route) =>
    route.transport === "websocket"
      ? route
      : {
          ...route,
          handler: (request: Request, args: RouteHandlerArgs<LinearChannelState>) =>
            linearConfigured() ? route.handler(request, args) : Promise.resolve(notFound()),
        },
  ),
};

export default linear;
