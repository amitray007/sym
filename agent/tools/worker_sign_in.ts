import type { SessionAuthContext } from "eve/context";
import { defineWorkflowTool } from "eve/tools";
import { createWebhook, sleep } from "workflow";
import { z } from "zod";
import { deliver } from "../../lib/delivery/deliver.ts";
import { chooseDisplay } from "../../lib/display.ts";
import { enqueuePost, postStatus } from "../../lib/ledger/outbox.ts";
import { ownerUserId } from "../../lib/owner.ts";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";
import { workerLabel, workerNoun } from "../../lib/worker-label.ts";
import { saveCredential } from "../../lib/workers/credentials.ts";
import { workerTarget } from "../../lib/workers/resolve.ts";
import { checkSignInCaller, SIGNED_IN_PAGE, signInRedirect } from "../../lib/workers/sign-in.ts";
import {
  beginSignIn,
  finishSignIn,
  newState,
  readRedirect,
  type SignInStart,
} from "../../lib/workers/t3/oauth.ts";

// The in-app worker sign-in (decision 036). The owner asks Sym to sign in to the worker. Sym
// registers with T3, sends the owner the T3 approval link in a DM, and waits on an Eve webhook
// for the browser redirect. Then it redeems the code and stores the token in Postgres.
//
// The OAuth calls run only in steps. The authorization URL goes only to the owner's DM, and
// nothing here logs it, the code, or the token.

// T3 codes live 60 seconds, but the owner may need time to open the DM. The link stops working
// on Sym's side after this.
const SIGN_IN_WAIT = "10m";

interface Target {
  name: string;
  mcpUrl: string;
}

type Prepared = { ok: true; owner: string; worker: Target } | { ok: false; reason: string };

type Begun = { ok: true; start: SignInStart } | { ok: false; reason: string };

type Completed =
  | { status: "ignored" }
  | { status: "refused" | "failed"; reason: string }
  | { status: "signed_in"; worker: string; expiresAt: string | null };

export default defineWorkflowTool({
  description:
    "Sign Sym in to its worker when the owner asks, or when the sign-in expired. " +
    "Only the owner can use it. Sym sends the owner a private approval link and waits up to " +
    "10 minutes. Runs as a task: you get a receipt now and the result later. If the status says " +
    "the DM could not be sent yet, say so and do not tell the owner to check their DM. Never " +
    "repeat the link anywhere.",
  inputSchema: z.object({}),
  label: {
    start: () => `${workerLabel()} sign-in`,
    delta: (_input, progress: { status: string }) => progress.status,
  },
  async *task(_input, ctx) {
    "use workflow";
    const prepared = await prepare(ctx.session.auth.current ?? null);
    if (!prepared.ok) return { status: "refused", reason: prepared.reason };

    // A browser GET with the code and state in the query resumes this webhook. Any visit gets
    // the same page; the state check below decides what counts.
    const webhook = createWebhook({
      respondWith: new Response(SIGNED_IN_PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
    });
    const begun = await begin(prepared.worker, webhook.url);
    if (!begun.ok) return { status: "not_started", reason: begun.reason };
    const delivery = await sendLink(
      begun.start.authorizationUrl,
      prepared.owner,
      `${ctx.session.id}:${ctx.callId}`,
    );
    // The link is never in this text. A DM that did not go out stays queued and retries.
    yield {
      status:
        delivery === "sent"
          ? "Sent the owner a sign-in link in a DM"
          : "The sign-in DM could not be sent yet and stays queued for retry",
    };
    const queuedNote =
      delivery === "sent"
        ? ""
        : " The DM could not be sent yet and stays queued for retry. Do not tell the owner to check their DM.";

    const stopped = new Promise<"stopped">((resolve) => {
      if (ctx.abortSignal.aborted) resolve("stopped");
      ctx.abortSignal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    const deadline = sleep(SIGN_IN_WAIT).then(() => "timeout" as const);
    const requests = webhook[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([requests.next(), deadline, stopped]);
      if (next === "stopped") return { status: "cancelled" };
      if (next === "timeout" || next.done) {
        return {
          status: "timed_out",
          reason: `The owner did not approve within 10 minutes. Ask again for a new link.${queuedNote}`,
        };
      }
      const outcome = await complete(begun.start, next.value.url, prepared.worker, prepared.owner);
      if (outcome.status === "ignored") continue;
      return outcome.status === "signed_in"
        ? {
            status: "signed_in",
            worker: outcome.worker,
            expiresAt: outcome.expiresAt,
            note: "Tell the owner the sign-in worked and when it expires. Never repeat the link.",
          }
        : { status: outcome.status, reason: outcome.reason };
    }
  },
});

// Owner check and worker choice. The pack and the env are read in a step, so a replay sees the
// same values.
async function prepare(caller: SessionAuthContext | null): Promise<Prepared> {
  "use step";
  const adopterPack = pack();
  // Unlike other owner matters, a deployment without an owner refuses everyone here.
  const check = checkSignInCaller(caller, ownerUserId(adopterPack));
  if (!check.ok) return check;
  const target = workerTarget(adopterPack, process.env);
  if (!target.mcpUrl) {
    return {
      ok: false,
      reason: `Sym has no ${workerNoun()} URL. Add the ${workerNoun()} to the pack, or set T3_MCP_URL (docs/workers.md).`,
    };
  }
  return { ok: true, owner: check.owner, worker: { name: target.name, mcpUrl: target.mcpUrl } };
}

// Discovery, registration, and PKCE for the webhook's public address.
async function begin(worker: Target, webhookUrl: string): Promise<Begun> {
  "use step";
  const redirect = signInRedirect(webhookUrl, process.env);
  if (!redirect.ok) return redirect;
  try {
    const start = await beginSignIn({
      mcpUrl: worker.mcpUrl,
      redirectUrl: redirect.url,
      state: newState(),
    });
    return { ok: true, start };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Sym could not start the sign-in with the ${workerNoun()}: ${reason}`,
    };
  }
}

// The link goes to the owner's DM only, never to a shared thread.
async function sendLink(
  authorizationUrl: string,
  owner: string,
  key: string,
): Promise<"sent" | "queued"> {
  "use step";
  const sql = ledger();
  const display = chooseDisplay({
    kind: "worker-sign-in",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: 2,
    surface: "dm",
    quiet: false,
  });
  const post = await enqueuePost(sql, {
    idempotencyKey: `signin-link:${key}`,
    method: "chat.postMessage",
    payload: {
      channel: owner,
      text:
        `Approve Sym on the ${workerNoun()}: <${authorizationUrl}|open the sign-in page>. ` +
        "Pick the access level there. The link works for 10 minutes. Do not share it.",
      unfurl_links: false,
      unfurl_media: false,
    },
    display: { ...display, target: "dm" },
  });
  const slack = slackFromEnv();
  // A failed send stays in the outbox for the delivery schedule.
  if (slack) await deliver(sql, slack).catch(() => {});
  return (await postStatus(sql, post.id)) === "sent" ? "sent" : "queued";
}

// Checks the redirect, redeems the code, and stores the token. The code and the token stay in
// this step. Errors come back as reasons, so a used code is not redeemed twice on a retry.
async function complete(
  start: SignInStart,
  requestUrl: string,
  worker: Target,
  owner: string,
): Promise<Completed> {
  "use step";
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return { status: "ignored" };
  }
  const redirect = readRedirect(params, start);
  if (redirect.kind === "ignore") return { status: "ignored" };
  if (redirect.kind === "refused") return { status: "refused", reason: redirect.reason };
  try {
    const token = await finishSignIn(start, redirect);
    await saveCredential(ledger(), {
      worker: worker.name,
      mcpUrl: worker.mcpUrl,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      approvedBy: owner,
    });
    return {
      status: "signed_in",
      worker: worker.name,
      expiresAt: token.expiresAt?.toISOString() ?? null,
    };
  } catch (error) {
    // finishSignIn and saveCredential build their messages without secrets.
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
