import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import type { SlackApi } from "../slack/api.ts";
import { getTrigger, type Trigger, triggerRef } from "./rows.ts";
import {
  publicBase,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  webhookKey,
  webhookSecret,
  webhookUrl,
} from "./webhook.ts";

// Shows a webhook trigger's secret to its creator once (decision 090). Sym DMs the creator a link
// to its own HTTPS route, never the secret, so the secret never lands in Slack, Postgres, a tool
// result, the brain, or a log. The link lasts 15 minutes and works once. A GET shows only a
// "Reveal secret" button, so a link preview or a page fetch cannot use it up or see the secret;
// only a POST with the link's token and the page's form token shows it. Postgres keeps a hash of
// the token, never the token.

export const REVEAL_PATH = "/sym/reveal";
const REVEAL_TTL_MS = 15 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const formToken = (key: string, tokenHash: string) =>
  createHmac("sha256", key).update(`sym-reveal-form:${tokenHash}`).digest("hex");

// Stores a new one-time link for the trigger's current secret and returns its token.
export async function createReveal(sql: Sql, trigger: Trigger, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into webhook_reveals (token_hash, trigger_id, secret_version, owner, expires_at)
    values (
      ${sha256(token)}, ${trigger.id}, ${trigger.secretVersion}, ${trigger.owner},
      ${new Date(now.getTime() + REVEAL_TTL_MS)}
    )
  `;
  return token;
}

export const revealUrl = (token: string, env: NodeJS.ProcessEnv = process.env) =>
  `${publicBase(env)}${REVEAL_PATH}/${token}`;

// DMs the creator the webhook URL and a one-time link to its secret. False when the DM failed;
// the creator then rotates for a new link.
export async function sendRevealLink(
  deps: { sql: Sql; slack?: SlackApi | undefined },
  trigger: Trigger,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<boolean> {
  if (!deps.slack || !trigger.hookId) return false;
  // Every Slack post goes through the display rule. A setup answer needs the person's action.
  const display = chooseDisplay({
    kind: "webhook-secret",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: 6,
    surface: "dm",
    quiet: false,
  });
  if (display.level === 0) return false;
  try {
    const opened = await deps.slack.call("conversations.open", { users: trigger.owner });
    const channel = (opened.channel as { id?: unknown } | undefined)?.id;
    if (typeof channel !== "string" || !channel.startsWith("D")) return false;
    const token = await createReveal(deps.sql, trigger, now);
    // Straight to Slack, not through the outbox, so Postgres never holds the link.
    await deps.slack.call("chat.postMessage", {
      channel,
      text: revealText(trigger, webhookUrl(trigger.hookId, env), revealUrl(token, env)),
      unfurl_links: false,
      unfurl_media: false,
    });
    return true;
  } catch {
    // Slack's error can echo the request body, which holds the link. Log nothing.
    return false;
  }
}

export function revealText(trigger: Trigger, url: string, reveal: string): string {
  return [
    `Webhook for *${trigger.title}* (${triggerRef(trigger.id)}).`,
    `URL: ${url}`,
    `Signing secret: <${reveal}|open this link> within 15 minutes to see it. It works once.`,
    `Sign each POST: set \`${TIMESTAMP_HEADER}\` to the Unix time in seconds and ` +
      `\`${SIGNATURE_HEADER}\` to \`sha256=\` plus the hex HMAC-SHA256 of ` +
      "`<timestamp>.<raw body>` with the secret.",
    "Keep the secret out of Slack. If it leaks, ask me to rotate it.",
  ].join("\n");
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;` +
    `max-width:36rem;margin:3rem auto;padding:0 1rem}code{word-break:break-all;font-size:15px;` +
    `background:#f2f2f2;padding:.4rem;display:block}button{font:inherit;padding:.5rem 1rem}` +
    `</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const gone = () =>
  page(
    410,
    "Link expired",
    "<p>This link expired or was already used. Ask Sym to rotate the secret for a new one.</p>",
  );

interface RevealDeps {
  sql: Sql;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

// GET: shows the button if the link still works. It changes nothing.
export async function showReveal(deps: RevealDeps, token: string): Promise<Response> {
  const key = webhookKey(deps.env ?? process.env);
  if (!key || !TOKEN.test(token)) return gone();
  const hash = sha256(token);
  const now = deps.now ?? new Date();
  const [row] = await deps.sql`
    select 1 from webhook_reveals
    where token_hash = ${hash} and revealed_at is null and expires_at > ${now}
  `;
  if (!row) return gone();
  return page(
    200,
    "Webhook secret",
    `<p>The secret shows once. Copy it before you leave this page.</p>` +
      `<form method="post"><input type="hidden" name="form" value="${formToken(key, hash)}">` +
      `<button type="submit">Reveal secret</button></form>`,
  );
}

// POST: burns the link and shows the secret, once. It needs the form token from the GET page,
// and refuses a cross-site request.
export async function useReveal(
  deps: RevealDeps,
  request: Request,
  token: string,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const key = webhookKey(env);
  if (!key || !TOKEN.test(token)) return gone();
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return page(403, "Not allowed", "<p>Open the link from Slack.</p>");
  }
  const hash = sha256(token);
  const form = new URLSearchParams(await request.text().catch(() => "")).get("form") ?? "";
  const expected = Buffer.from(formToken(key, hash));
  const given = Buffer.from(form);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return page(403, "Not allowed", "<p>Open the link from Slack and press the button.</p>");
  }
  const now = deps.now ?? new Date();
  const [row] = await deps.sql<{ triggerId: number; secretVersion: number }[]>`
    update webhook_reveals set revealed_at = ${now}
    where token_hash = ${hash} and revealed_at is null and expires_at > ${now}
    returning trigger_id, secret_version
  `;
  if (!row) return gone();
  const trigger = await getTrigger(deps.sql, Number(row.triggerId));
  if (
    !trigger?.hookId ||
    trigger.status === "deleted" ||
    trigger.secretVersion !== Number(row.secretVersion)
  ) {
    return gone();
  }
  const secret = webhookSecret(key, trigger.hookId, trigger.secretVersion);
  return page(
    200,
    "Webhook secret",
    `<p>Signing secret for <b>${esc(trigger.title)}</b>. This page will not show it again.</p>` +
      `<code>${esc(secret)}</code><p>URL: <code>${esc(webhookUrl(trigger.hookId, env))}</code></p>`,
  );
}
