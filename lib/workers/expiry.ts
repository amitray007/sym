import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import type { Pack } from "../pack/load.ts";
import { workerNoun } from "../worker-label.ts";

// Worker sign-in expiry (docs/workers.md, docs/architecture.md "Proactive updates"). The T3
// sign-in lasts 30 days and has no refresh token. Reconcile calls `queueSignInNotice` every pass.
// The owner gets one DM 5 days before and one after the sign-in expires.

export const WARN_DAYS = 5;
const DAY_MS = 86_400_000;

export type SignInStage = "none" | "warn" | "expired";

export interface SignInNotice {
  stage: SignInStage;
  // Whole days left, rounded up. 0 once expired.
  daysLeft: number;
}

// Reads `T3_TOKEN_EXPIRES_AT`, the expiry of an env token. A stored sign-in keeps its expiry on
// its row (decision 036). An empty or invalid value means the expiry is unknown.
export function parseSignInExpiry(value: string | undefined): Date | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function signInNotice(expiresAt: Date | null, now: Date): SignInNotice {
  if (!expiresAt) return { stage: "none", daysLeft: 0 };
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return { stage: "expired", daysLeft: 0 };
  const daysLeft = Math.ceil(left / DAY_MS);
  return { stage: left <= WARN_DAYS * DAY_MS ? "warn" : "none", daysLeft };
}

// Where the owner notice goes: the pack owner, then `SYM_OWNER_SLACK_USER`, then the digest
// target. A user ID opens a DM. Returns nothing when the deployment names no one.
export function ownerTarget(
  pack: Pack | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    pack?.config.owner.slackUserId ||
    env.SYM_OWNER_SLACK_USER ||
    env.SYM_DIGEST_CHANNEL ||
    undefined
  );
}

export interface SignInNoticeInput {
  expiresAt: Date | null;
  now: Date;
  // A user ID or channel ID, from `ownerTarget`.
  target: string | undefined;
}

// The in-app sign-in (decision 036): the owner asks Sym, and Sym sends the sign-in link in a DM.
export const renewStep = () => `Ask me to renew it and I will send you a private link.`;

export function signInText(stage: Exclude<SignInStage, "none">, input: SignInNoticeInput): string {
  const day = (input.expiresAt as Date).toISOString().slice(0, 10);
  const { daysLeft } = signInNotice(input.expiresAt, input.now);
  const step = renewStep();
  return stage === "warn"
    ? `The ${workerNoun()} sign-in expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"} (${day}). ${step}`
    : `The ${workerNoun()} sign-in expired on ${day}. ${step}`;
}

// Queues the due notice. The key holds the expiry date and the stage, so every pass after the
// first queues nothing, and a new sign-in (a new expiry date) starts fresh. Returns whether a
// notice was queued.
export async function queueSignInNotice(sql: Sql, input: SignInNoticeInput): Promise<boolean> {
  const { stage } = signInNotice(input.expiresAt, input.now);
  if (stage === "none" || !input.expiresAt || !input.target) return false;
  const day = input.expiresAt.toISOString().slice(0, 10);
  const text = signInText(stage, input);
  // Channel IDs start with C or G, DM IDs with D, and a user ID (U or W) opens a DM.
  const dm = /^[DUW]/.test(input.target);
  const display = chooseDisplay({
    kind: "worker-sign-in",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: 2,
    surface: dm ? "dm" : "channel",
    quiet: false,
  });
  const before =
    await sql`select 1 from outbox where idempotency_key = ${`signin:${day}:${stage}`}`;
  if (before.length > 0) return false;
  await enqueuePost(sql, {
    idempotencyKey: `signin:${day}:${stage}`,
    method: "chat.postMessage",
    payload: { channel: input.target, text },
    display: dm ? { ...display, target: "dm" } : display,
  });
  return true;
}
