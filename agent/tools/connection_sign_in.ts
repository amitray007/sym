import type { SessionAuthContext } from "eve/context";
import { defineWorkflowTool } from "eve/tools";
import { createWebhook, sleep } from "workflow";
import { z } from "zod";
import { relistTools } from "../../lib/connections/add.ts";
import { saveConnectionCredential } from "../../lib/connections/credentials.ts";
import { probeServer } from "../../lib/connections/probe.ts";
import { getConnection, saveTools } from "../../lib/connections/rows.ts";
import {
  beginSignIn,
  clientOf,
  finishSignIn,
  newState,
  readRedirect,
  type SignInStart,
} from "../../lib/oauth.ts";
import { ownerUserId } from "../../lib/owner.ts";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";
import { sendSignInLink } from "../../lib/sign-in-link.ts";
import { checkSignInCaller, SIGNED_IN_PAGE, signInRedirect } from "../../lib/workers/sign-in.ts";

// Signs Sym in to an OAuth MCP connection (decision 045). It runs the worker sign-in flow
// (decision 036) against the connection's server: Sym registers, sends the owner the approval
// link in a DM, waits on an Eve webhook for the browser redirect, redeems the code, and stores
// the token and any refresh token in Postgres. Then it lists the server's tools with the token.
//
// The OAuth calls run only in steps. The link goes only to the owner's DM, and nothing here
// logs it, the code, or a token.

const SIGN_IN_WAIT = "10m";

interface Target {
  id: number;
  name: string;
  url: string;
}

type Prepared = { ok: true; owner: string; target: Target } | { ok: false; reason: string };

type Begun = { ok: true; start: SignInStart } | { ok: false; reason: string };

type Completed =
  | { status: "ignored" }
  | { status: "refused" | "failed"; reason: string }
  | { status: "signed_in"; expiresAt: string | null; refreshes: boolean; tools: number | null };

export default defineWorkflowTool({
  description:
    "Sign Sym in to an OAuth MCP connection after the owner approved it, or when its sign-in " +
    "expired. Only the owner can use it. Sym sends the owner a private sign-in link and waits " +
    "up to 10 minutes. Runs as a task: you get a receipt now and the result later. If the " +
    "status says the DM could not be sent yet, say so and do not tell the owner to check " +
    "their DM. Never repeat the link anywhere.",
  inputSchema: z.object({ name: z.string().describe("The connection name.") }),
  label: {
    start: ({ name }) => `Sign in to ${name}`,
    delta: (_input, progress: { status: string }) => progress.status,
  },
  async *task({ name }, ctx) {
    "use workflow";
    const prepared = await prepare(name, ctx.session.auth.current ?? null);
    if (!prepared.ok) return { status: "refused", reason: prepared.reason };

    const webhook = createWebhook({
      respondWith: new Response(SIGNED_IN_PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
    });
    const begun = await begin(prepared.target, webhook.url);
    if (!begun.ok) return { status: "not_started", reason: begun.reason };
    const delivery = await sendLink(
      prepared.target.name,
      begun.start.authorizationUrl,
      prepared.owner,
      `${ctx.session.id}:${ctx.callId}`,
    );
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
          reason: `The owner did not sign in within 10 minutes. Ask again for a new link.${queuedNote}`,
        };
      }
      const outcome = await complete(begun.start, next.value.url, prepared.target, prepared.owner);
      if (outcome.status === "ignored") continue;
      if (outcome.status !== "signed_in") return { status: outcome.status, reason: outcome.reason };
      return {
        status: "signed_in",
        connection: prepared.target.name,
        expiresAt: outcome.expiresAt,
        refreshes: outcome.refreshes,
        tools: outcome.tools,
        note:
          "Tell the owner the sign-in worked and the tools are available from the next " +
          "message. Never repeat the link.",
      };
    }
  },
});

// Owner check and the connection row, read in a step so a replay sees the same values.
async function prepare(name: string, caller: SessionAuthContext | null): Promise<Prepared> {
  "use step";
  const check = checkSignInCaller(caller, ownerUserId(pack()), "a connection");
  if (!check.ok) return check;
  const row = await getConnection(ledger(), name);
  if (row?.status !== "active") {
    return { ok: false, reason: `There is no approved connection named "${name}".` };
  }
  if (row.authKind !== "oauth") {
    return { ok: false, reason: `"${name}" does not use an OAuth sign-in.` };
  }
  return { ok: true, owner: check.owner, target: { id: row.id, name: row.name, url: row.url } };
}

async function begin(target: Target, webhookUrl: string): Promise<Begun> {
  "use step";
  const redirect = signInRedirect(webhookUrl, process.env);
  if (!redirect.ok) return redirect;
  try {
    const start = await beginSignIn({
      mcpUrl: target.url,
      redirectUrl: redirect.url,
      state: newState(),
    });
    return { ok: true, start };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "Error";
    return {
      ok: false,
      reason: `Sym could not start the sign-in with "${target.name}" (${reason}).`,
    };
  }
}

async function sendLink(
  name: string,
  authorizationUrl: string,
  owner: string,
  key: string,
): Promise<"sent" | "queued"> {
  "use step";
  return sendSignInLink(ledger(), slackFromEnv(), {
    owner,
    idempotencyKey: `connection-signin-link:${key}`,
    text:
      `Sign Sym in to the "${name}" connection: <${authorizationUrl}|open the sign-in page>. ` +
      "The link works for 10 minutes. Do not share it.",
  });
}

// Checks the redirect, redeems the code, stores the sign-in, and lists the tools. The code and
// the tokens stay in this step.
async function complete(
  start: SignInStart,
  requestUrl: string,
  target: Target,
  owner: string,
): Promise<Completed> {
  "use step";
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return { status: "ignored" };
  }
  const server = `"${target.name}"`;
  const redirect = readRedirect(params, start, server);
  if (redirect.kind === "ignore") return { status: "ignored" };
  if (redirect.kind === "refused") return { status: "refused", reason: redirect.reason };
  const sql = ledger();
  let token: Awaited<ReturnType<typeof finishSignIn>>;
  try {
    token = await finishSignIn(start, redirect, new Date(), server);
    await saveConnectionCredential(sql, {
      connectionId: target.id,
      token,
      oauthClient: clientOf(start),
      approvedBy: owner,
    });
  } catch (error) {
    // finishSignIn and saveConnectionCredential build their messages without secrets.
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  // The tools often list only with a token. A failure here leaves the default rule in place.
  let tools: number | null = null;
  const row = await getConnection(sql, target.name).catch(() => undefined);
  if (row?.id === target.id) {
    const listed = await relistTools(target.url, token.accessToken, row.tools, probeServer);
    if (listed.ok) {
      await saveTools(sql, row.id, listed.tools, listed.instructions);
      tools = listed.tools.length;
    }
  }
  return {
    status: "signed_in",
    expiresAt: token.expiresAt?.toISOString() ?? null,
    refreshes: token.refreshToken !== null,
    tools,
  };
}
