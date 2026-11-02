import { allowedSlackUserFor } from "../identities.ts";
import type { LedgerDeps } from "../jobs/run.ts";
import { handOff, quote } from "../slack/send-to-sym.ts";
import type { FireResult } from "../triggers/fire.ts";
import { fireSourceTriggers, linearFacts } from "../triggers/sources.ts";

// What Sym does with Linear webhooks (decision 091). Eve's Linear channel verifies each one and
// calls these from its hooks. Sym never hosts the conversation in Linear: Builder needs the
// Start / Not now in Slack, and the brain's tools work from a Slack thread.
//
// - A person who delegates an issue to Sym (an Agent Session) is a request only when the owner
//   mapped that Linear user to an allowed Slack person. Sym hands it to that person's DM, where
//   their reply is their own request, and answers in Linear where to continue. Anyone else gets a
//   polite refusal in Linear.
// - An issue data webhook fires the matching `linear` triggers.

export interface LinearDeps extends LedgerDeps {
  env?: NodeJS.ProcessEnv;
}

interface LinearUser {
  id: string;
  email?: string | undefined;
}

// The parts of Eve's Agent Session event that Sym reads.
export interface LinearSessionEvent {
  action: string;
  agentSession: {
    id: string;
    creator?: LinearUser | undefined;
    creatorId?: string | null | undefined;
    issue?: { identifier?: string; title?: string; url?: string } | null | undefined;
  };
  agentActivity?: { id: string; body?: string | undefined; user?: LinearUser | undefined };
}

export interface LinearSessionContext {
  linear: {
    createActivity(content: { type: "response" | "error"; body: string }): Promise<unknown>;
  };
}

export const LINEAR_REFUSAL =
  "Thanks. I take work only from people on my allow-list whose Linear account is linked to " +
  "Slack, so I can't pick this up. Please ask in Slack.";
export const LINEAR_HANDED_OFF =
  "I sent this to you in Slack. Reply there and I'll pick it up; work that changes code asks " +
  "for your Start first.";
const LINEAR_UNREACHABLE = "I couldn't reach you in Slack just now. Please ask me there.";

export async function onLinearAgentSession(
  deps: LinearDeps,
  ctx: LinearSessionContext,
  event: LinearSessionEvent,
): Promise<"ignored" | "handed_off" | "refused" | "unreachable"> {
  if (event.action !== "created" && event.action !== "prompted") return "ignored";
  const env = deps.env ?? process.env;
  const person =
    event.action === "prompted"
      ? (event.agentActivity?.user ?? event.agentSession.creator)
      : event.agentSession.creator;
  const ids = [person?.email, person?.id, event.agentSession.creatorId];
  const user = allowedSlackUserFor("linear", ids, deps.pack, env);
  if (!user) {
    await ctx.linear.createActivity({ type: "response", body: LINEAR_REFUSAL });
    return "refused";
  }
  const issue = event.agentSession.issue;
  const name = [issue?.identifier, issue?.title].filter(Boolean).join(" ") || "an issue";
  const link = issue?.url ? `<${issue.url}|${name}>` : name;
  const said = event.agentActivity?.body?.trim();
  const handed = await handOff(deps, {
    user,
    key: `linear:${event.agentSession.id}:${event.agentActivity?.id ?? "created"}`,
    text: [
      `You handed me ${link} in Linear${said ? ":" : "."}`,
      ...(said ? [quote(said)] : []),
      "What should I do with it? Reply in this thread.",
    ].join("\n"),
  });
  await ctx.linear.createActivity(
    handed
      ? { type: "response", body: LINEAR_HANDED_OFF }
      : { type: "error", body: LINEAR_UNREACHABLE },
  );
  return handed ? "handed_off" : "unreachable";
}

export async function onLinearData(
  deps: LinearDeps,
  event: { type: string; delivery: { id: string | undefined }; raw: Record<string, unknown> },
): Promise<FireResult[]> {
  if (event.type !== "Issue") return [];
  // Linear names each delivery in a header; the payload's issue, action, and time stand in.
  const data = (event.raw.data ?? {}) as { id?: unknown };
  const delivery =
    event.delivery.id ??
    `${String(data.id)}:${String(event.raw.action)}:${String(event.raw.webhookTimestamp)}`;
  return fireSourceTriggers(
    { sql: deps.sql, slack: deps.slack, pack: deps.pack },
    linearFacts(event.raw),
    delivery,
  );
}
