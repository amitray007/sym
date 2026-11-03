import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "../db.ts";
import type { Pack } from "../pack/load.ts";
import type { SlackApi } from "../slack/api.ts";
import { creatorMayRun, runsPerHour, type SendRun, sendRun } from "./fire.ts";
import {
  claimDeferredRun,
  endDeferred,
  getWebhookTrigger,
  type RunTarget,
  reserveTriggerRun,
  type Trigger,
  triggerRef,
  type WebhookTriggerEvent,
} from "./rows.ts";

// Webhook triggers (docs/architecture.md, flow 2c; decision 090). Each trigger has its own URL
// with an unguessable ID and its own signing secret. A request must carry a fresh timestamp and
// an HMAC-SHA256 signature over the timestamp and the raw body. Sym stores no secret: it derives
// each one from SYM_WEBHOOK_KEY, the hook ID, and the trigger's secret version, so a rotation
// bumps the version. A verified request reserves a run and gets 202 at once; the run starts right
// after, or with a later dispatcher tick if that send fails. Nothing here logs a secret, a
// signature, a header, or the body.

export const WEBHOOK_PATH = "/sym/hooks";
export const TIMESTAMP_HEADER = "x-sym-timestamp";
export const SIGNATURE_HEADER = "x-sym-signature";
// The largest body Sym reads.
export const BODY_MAX = 64 * 1024;
// How far a timestamp may sit from Sym's clock, either way.
export const WINDOW_SECONDS = 300;
// The longest body, as JSON text, that a run message carries.
const FACTS_MAX = 8000;
const KEY_MIN = 32;
const HOOK_ID = /^[A-Za-z0-9_-]{16,64}$/;
// Bad signatures one hook may take per minute before Sym stops checking them.
const BAD_SIGNATURES_PER_MINUTE = 30;

export const WEBHOOKS_OFF =
  "Webhook triggers are off: the owner sets SYM_WEBHOOK_KEY (at least 32 characters) in the " +
  "deployment first.";

// The deployment key every webhook secret derives from, or undefined when webhooks are off.
export function webhookKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.SYM_WEBHOOK_KEY?.trim();
  return key && key.length >= KEY_MIN ? key : undefined;
}

// A new hook ID: 144 random bits, URL-safe.
export const newHookId = (): string => randomBytes(18).toString("base64url");

// The signing secret of one hook at one version. Changing SYM_WEBHOOK_KEY changes every secret.
export function webhookSecret(key: string, hookId: string, version: number): string {
  const mac = createHmac("sha256", key).update(`sym-webhook:${hookId}:${version}`);
  return `whsec_${mac.digest("base64url")}`;
}

// The public base URL: SYM_SIGNIN_URL, Sym's public HTTPS address (decision 036), else
// SYM_CALLBACK_URL (decision 028). Empty without either, so URLs are paths alone.
export function publicBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SYM_SIGNIN_URL?.trim() || env.SYM_CALLBACK_URL?.trim() || "").replace(/\/+$/, "");
}

export function webhookUrl(hookId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${publicBase(env)}${WEBHOOK_PATH}/${hookId}`;
}

// The signature header value for a body sent at `timestamp` (Unix seconds).
export function signWebhook(secret: string, timestamp: string, body: Uint8Array | string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(body);
  return `sha256=${mac.digest("hex")}`;
}

export type Verdict = "ok" | "missing" | "expired" | "invalid";

export function verifyWebhook(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: Uint8Array;
  now: Date;
}): Verdict {
  const { timestamp, signature } = input;
  if (!timestamp || !signature) return "missing";
  if (!/^\d{1,12}$/.test(timestamp)) return "invalid";
  const skew = Math.abs(input.now.getTime() / 1000 - Number(timestamp));
  if (skew > WINDOW_SECONDS) return "expired";
  const expected = Buffer.from(signWebhook(input.secret, timestamp, input.body));
  const given = Buffer.from(signature.trim());
  return given.length === expected.length && timingSafeEqual(given, expected) ? "ok" : "invalid";
}

// Reads the body up to `max` bytes. Undefined when it is larger.
export async function readBody(request: Request, max = BODY_MAX): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// The run's facts: a JSON body parsed, any other body as text, cut to fit the run message.
export function webhookFacts(input: {
  body: Uint8Array;
  contentType: string | null;
  now: Date;
}): WebhookTriggerEvent {
  const text = new TextDecoder().decode(input.body);
  const contentType = input.contentType?.split(";")[0]?.trim().toLowerCase() || null;
  let body: unknown = text;
  if (contentType === "application/json" || contentType?.endsWith("+json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  const truncated = serialized.length > FACTS_MAX;
  return {
    kind: "webhook",
    contentType,
    body: truncated ? `${serialized.slice(0, FACTS_MAX)}…` : body,
    truncated,
    receivedAt: input.now.toISOString(),
  };
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

// What makes a request fire once. Only signed values count, so changing an unsigned header
// starts nothing new: the signature names the exact request, so a replay fires once, and the
// body names its content, so a re-signed copy inside the replay window fires once too.
export function webhookDedupe(signature: string, body: Uint8Array) {
  return {
    eventKey: `webhook:sig:${sha256(signature.trim())}`,
    recent: { key: `webhook:body:${sha256(body)}`, windowMs: 2 * WINDOW_SECONDS * 1000 },
  };
}

// Counts bad signatures per hook. Past the limit, the hook's row comes from a short cache, so a
// flood of forged requests stops before the database while a correctly signed request still runs.
const badSignatures = new Map<string, { count: number; resetAt: number }>();
const floodedRows = new Map<string, { trigger: Trigger | undefined; until: number }>();
const FLOODED_ROW_MS = 30_000;

async function webhookTriggerFor(sql: Sql, hookId: string, now: number) {
  if (!tooManyBad(hookId, now)) return getWebhookTrigger(sql, hookId);
  const cached = floodedRows.get(hookId);
  if (cached && cached.until > now) return cached.trigger;
  const trigger = await getWebhookTrigger(sql, hookId);
  if (floodedRows.size > 10_000) floodedRows.clear();
  floodedRows.set(hookId, { trigger, until: now + FLOODED_ROW_MS });
  return trigger;
}

function tooManyBad(hookId: string, now: number): boolean {
  const entry = badSignatures.get(hookId);
  return Boolean(entry && entry.resetAt > now && entry.count >= BAD_SIGNATURES_PER_MINUTE);
}

function noteBad(hookId: string, now: number): void {
  const entry = badSignatures.get(hookId);
  if (!entry || entry.resetAt <= now) {
    if (badSignatures.size > 10_000) badSignatures.clear();
    badSignatures.set(hookId, { count: 1, resetAt: now + 60_000 });
  } else {
    entry.count++;
  }
}

export interface WebhookDeps {
  sql: Sql;
  // Checks that the creator still reaches the destination channel.
  slack?: SlackApi | undefined;
  pack?: Pack | undefined;
  usersEnv?: string | undefined;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  maxPerHour?: number;
  send: SendRun;
  // Keeps the run's send alive after the response.
  waitUntil: (task: Promise<unknown>) => void;
}

const reply = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

// Handles one request to a webhook URL and answers at once. The run proceeds after the answer.
export async function receiveWebhook(
  deps: WebhookDeps,
  request: Request,
  hookId: string,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const key = webhookKey(env);
  if (!key || !HOOK_ID.test(hookId)) return reply(404, { ok: false, error: "not_found" });
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  // Cheap refusal first: no signature reaches no database.
  if (!timestamp || !signature) return reply(401, { ok: false, error: "signature_missing" });
  const now = deps.now ?? new Date();
  const body = await readBody(request);
  if (!body) return reply(413, { ok: false, error: "too_large", limitBytes: BODY_MAX });
  const trigger = await webhookTriggerFor(deps.sql, hookId, now.getTime());
  if (!trigger) return reply(404, { ok: false, error: "not_found" });
  const verdict = verifyWebhook({
    secret: webhookSecret(key, hookId, trigger.secretVersion),
    timestamp,
    signature,
    body,
    now,
  });
  if (verdict !== "ok") {
    const flooded = tooManyBad(hookId, now.getTime());
    noteBad(hookId, now.getTime());
    return flooded
      ? reply(429, { ok: false, error: "too_many_bad_signatures" }, { "retry-after": "60" })
      : reply(401, { ok: false, error: `signature_${verdict}` });
  }
  if (trigger.status !== "active") return reply(409, { ok: false, error: "paused" });
  const fireDeps = { sql: deps.sql, slack: deps.slack, pack: deps.pack, usersEnv: deps.usersEnv };
  // The creator must still be allowed and still reach the destination (decision 088).
  if (!(await creatorMayRun(fireDeps, trigger))) {
    console.warn(`Skipped ${triggerRef(trigger.id)}: its creator left the allow-list or channel.`);
    return reply(403, { ok: false, error: "creator_not_allowed" });
  }
  const facts = webhookFacts({ body, contentType: request.headers.get("content-type"), now });
  // The trigger's destination is required for a webhook, so every run starts a new thread there.
  const target: RunTarget = { channelId: trigger.destination ?? "" };
  // Deferred until the send below claims it: if this process dies after the answer, the
  // dispatcher sends the run within a minute.
  const reserved = await reserveTriggerRun(deps.sql, {
    triggerId: trigger.id,
    ...webhookDedupe(signature, body),
    facts,
    target,
    deferred: true,
    firedAt: now,
    maxPerHour: deps.maxPerHour ?? runsPerHour(env.SYM_TRIGGER_RUNS_PER_HOUR),
  });
  if (reserved.status === "duplicate") return reply(200, { ok: true, status: "duplicate" });
  if (reserved.status === "inactive") return reply(409, { ok: false, error: "paused" });
  if (reserved.status === "limited") {
    console.warn(`Skipped ${triggerRef(trigger.id)}: it reached its hourly run limit.`);
    return reply(429, { ok: false, error: "rate_limited" }, { "retry-after": "3600" });
  }
  deps.waitUntil(startNow(deps, trigger, reserved.run.id, facts, target));
  return reply(202, { ok: true, status: "accepted" });
}

// Sends the run now, unless the dispatcher holds it. A failed send keeps the run deferred: the
// lease runs out and a dispatcher tick retries it with the same delivery key, until the run is
// too old (10 minutes) and fails. Never throws.
async function startNow(
  deps: WebhookDeps,
  trigger: Trigger,
  runId: number,
  facts: WebhookTriggerEvent,
  target: RunTarget,
): Promise<void> {
  try {
    if (!(await claimDeferredRun(deps.sql, runId, deps.now ?? new Date()))) return;
    const ok = await sendRun({ sql: deps.sql }, trigger, runId, facts, target, deps.send, {
      keepOnFailure: true,
    });
    if (ok) await endDeferred(deps.sql, runId);
  } catch (error) {
    console.warn(`Sym could not start a run of ${triggerRef(trigger.id)}.`, String(error));
  }
}
