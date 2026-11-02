import { defineChannel, GET, POST } from "eve/channels";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";
import { APP_AUTH } from "../../lib/triggers/fire.ts";
import { receiveWebhook } from "../../lib/triggers/webhook.ts";
import { showReveal, useReveal } from "../../lib/triggers/webhook-reveal.ts";
import slack from "./slack.ts";

// Webhook triggers (docs/architecture.md, flow 2c; decision 090). Each trigger has its own URL,
// `/sym/hooks/<hook id>`. The route checks the size, the signature, and the timestamp, reserves
// one run, and answers 202 at once. The run then starts in Slack as the app principal, like a
// scheduled run, so it acts for the trigger's creator. `/sym/reveal/<token>` is the one-time page
// that shows a creator their secret. This channel hosts no conversation.

export default defineChannel({
  routes: [
    POST("/sym/hooks/:hookId", async (request, { params, to, waitUntil }) =>
      receiveWebhook(
        {
          sql: ledger(),
          slack: slackFromEnv(),
          pack: pack(),
          waitUntil,
          send: async ({ message, target, key, title }) =>
            (await to(slack, target).send(message, { auth: APP_AUTH, idempotencyKey: key, title }))
              .sessionId,
        },
        request,
        params.hookId ?? "",
      ),
    ),
    GET("/sym/reveal/:token", async (_request, { params }) =>
      showReveal({ sql: ledger() }, params.token ?? ""),
    ),
    POST("/sym/reveal/:token", async (request, { params }) =>
      useReveal({ sql: ledger() }, request, params.token ?? ""),
    ),
  ],
});
