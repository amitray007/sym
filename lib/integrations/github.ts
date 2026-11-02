import { createHash } from "node:crypto";
import { isGitHubRepoAllowed } from "../github-repos.ts";
import { allowedSlackUserFor } from "../identities.ts";
import type { LedgerDeps } from "../jobs/run.ts";
import { handOff, quote } from "../slack/send-to-sym.ts";
import type { FireResult } from "../triggers/fire.ts";
import type { GitHubEventName } from "../triggers/rows.ts";
import { fireSourceTriggers, githubFacts } from "../triggers/sources.ts";

// What Sym does with GitHub App webhooks (decision 091). Eve's GitHub channel verifies each one
// and calls these from its hooks. Every hook returns no dispatch: Sym never hosts a conversation
// on GitHub and never edits repositories itself. Only repositories on the owner's list count.
//
// - An issue, pull request, check suite, or comment event fires the matching `github` triggers.
//   Comments by bots, Sym's own replies included, fire nothing, so a run cannot fire itself.
// - A comment that mentions the app is a request only from a GitHub account (by its numeric ID)
//   the owner mapped to an allowed Slack person. Sym hands it to that person's DM, where their
//   reply is their own request with the normal Start / Not now. Anyone else gets a polite
//   refusal on GitHub, at most once an hour per person and issue.

export interface GitHubDeps extends LedgerDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

// The parts of Eve's inbound GitHub context that Sym reads.
export interface GitHubContext {
  repository: { fullName: string };
  sender: { login: string; type: string };
  delivery: { id: string };
  conversation: { issueNumber: number | null; pullRequestNumber: number | null };
  thread: { post(message: string): Promise<unknown> };
}

export interface GitHubCommentInput {
  author: { id: number; login: string; type: string } | undefined;
  body: string;
  htmlUrl: string | undefined;
  raw: Record<string, unknown>;
}

// One event from a hook: its action, the event's object (Eve's `raw`), and the issue or pull
// request number when the object does not carry it.
export interface GitHubEventInput {
  action: string | null;
  item: Record<string, unknown>;
  number?: number | null;
}

export const GITHUB_REFUSAL =
  "Thanks for the mention. I take requests only from people on my allow-list whose GitHub " +
  "account is linked to Slack, so I can't act on this one. Please ask in Slack.";
export const GITHUB_HANDED_OFF =
  "Got it. I sent this to you in Slack; reply there and I'll pick it up.";
const GITHUB_UNREACHABLE = "I couldn't reach you in Slack just now. Please ask me there.";
const REFUSAL_COOLDOWN_MS = 60 * 60_000;

// Replies already posted, by comment, and refusals, by person and issue. In memory: a restart
// may repeat one reply, never a run or a DM, which the ledger dedupes.
const replied = new Map<string, number>();

function firstReply(key: string, now: number, windowMs: number): boolean {
  const last = replied.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  if (replied.size > 10_000) replied.clear();
  replied.set(key, now);
  return true;
}

// A hash of the verified event's content, so a redelivery under another delivery ID fires
// nothing (decision 091).
function contentKey(repository: string, event: GitHubEventName, input: GitHubEventInput): string {
  const content = JSON.stringify({ repository, event, action: input.action, item: input.item });
  return `github:content:${createHash("sha256").update(content).digest("hex")}`;
}

export async function fireGitHubEvent(
  deps: GitHubDeps,
  ctx: Pick<GitHubContext, "repository" | "sender" | "delivery">,
  event: GitHubEventName,
  input: GitHubEventInput,
): Promise<FireResult[]> {
  const repository = ctx.repository.fullName;
  if (!isGitHubRepoAllowed(repository, deps.pack, deps.env)) return [];
  const facts = githubFacts({ event, ...input, repository, sender: ctx.sender.login });
  return fireSourceTriggers(
    { sql: deps.sql, slack: deps.slack, pack: deps.pack },
    facts,
    `github:${ctx.delivery.id}`,
    [contentKey(repository, event, input)],
  );
}

// True when the comment names the app with its invocation token, `@<app slug>`.
export function mentionsApp(body: string, slug: string | undefined): boolean {
  if (!slug) return false;
  const name = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])@${name}(?![\\w-])`, "i").test(body);
}

export async function onGitHubComment(
  deps: GitHubDeps,
  ctx: GitHubContext,
  comment: GitHubCommentInput,
): Promise<"ignored" | "handed_off" | "refused" | "unreachable" | "repeated"> {
  const env = deps.env ?? process.env;
  if (!comment.author || comment.author.type === "Bot") return "ignored";
  const repository = ctx.repository.fullName;
  if (!isGitHubRepoAllowed(repository, deps.pack, env)) return "ignored";
  const number = ctx.conversation.pullRequestNumber ?? ctx.conversation.issueNumber;
  await fireGitHubEvent(deps, ctx, "issue_comment", {
    action: "created",
    item: comment.raw,
    number,
  });
  if (!mentionsApp(comment.body, env.GITHUB_APP_SLUG?.trim())) return "ignored";
  const now = (deps.now?.() ?? new Date()).getTime();
  // The comment's own ID is signed content, so a redelivery cannot post or DM twice.
  const commentId = String(comment.raw.id ?? comment.htmlUrl ?? ctx.delivery.id);
  const user = allowedSlackUserFor("github", [comment.author.id], deps.pack, env);
  if (!user) {
    const who = `refusal:${repository}#${number}:${comment.author.id}`;
    if (!firstReply(`comment:${commentId}`, now, REFUSAL_COOLDOWN_MS)) return "repeated";
    if (!firstReply(who, now, REFUSAL_COOLDOWN_MS)) return "repeated";
    await ctx.thread.post(GITHUB_REFUSAL);
    return "refused";
  }
  const where = `${repository}${number ? `#${number}` : ""}`;
  const link = comment.htmlUrl ? `<${comment.htmlUrl}|${where}>` : where;
  const handed = await handOff(deps, {
    user,
    key: `github:comment:${commentId}`,
    text: [
      `You mentioned me on GitHub in ${link}:`,
      quote(comment.body),
      "What should I do with it? Reply in this thread.",
    ].join("\n"),
  });
  if (!firstReply(`comment:${commentId}`, now, REFUSAL_COOLDOWN_MS)) return "repeated";
  await ctx.thread.post(handed ? GITHUB_HANDED_OFF : GITHUB_UNREACHABLE);
  return handed ? "handed_off" : "unreachable";
}
