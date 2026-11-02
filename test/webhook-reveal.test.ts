import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SlackApi } from "../lib/slack/api.ts";
import { redactSecrets } from "../lib/slack/redact.ts";
import { readThread, threadText } from "../lib/slack/source-thread.ts";
import { createTrigger, rotateWebhookSecret, type Trigger } from "../lib/triggers/rows.ts";
import { webhookSecret } from "../lib/triggers/webhook.ts";
import {
  createReveal,
  revealText,
  sendRevealLink,
  showReveal,
  useReveal,
} from "../lib/triggers/webhook-reveal.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 090: a webhook secret shows once, on Sym's own page, from a link that expires in 15
// minutes. A GET never burns or shows it. Slack reads redact anything shaped like a secret.

const KEY = "r".repeat(40);
const ENV = { SYM_WEBHOOK_KEY: KEY, SYM_SIGNIN_URL: "https://sym.example.com" };
const NOW = new Date("2026-11-03T12:00:00Z");

describe("secret redaction", () => {
  const secret = webhookSecret(KEY, "hook-redact-0123456789", 1);

  it("redacts webhook secrets in text, and nothing else", () => {
    expect(redactSecrets(`key: ${secret}.`)).toBe("key: whsec_[redacted].");
    expect(redactSecrets("whsec_short stays")).toBe("whsec_short stays");
    expect(redactSecrets("no secrets")).toBe("no secrets");
  });

  it("redacts the worker's view of a Slack thread", async () => {
    const slack: SlackApi = {
      async call() {
        return { messages: [{ ts: "1.1", user: "U1", text: `here: ${secret}` }] };
      },
    };
    const messages = await readThread(slack, { channel: "C1", ts: "1.1" });
    expect(threadText(messages)).not.toContain(secret);
    expect(threadText(messages)).toContain("whsec_[redacted]");
  });
});

describe.skipIf(!hasDatabase)("the one-time secret page", () => {
  const ledger = useLedger();
  let n = 0;
  const make = () =>
    createTrigger(ledger.sql(), {
      kind: "webhook",
      channel: null,
      keywords: [],
      emoji: null,
      title: "Deploy <alerts>",
      instruction: "Summarize.",
      builder: "ask",
      destination: "CALERTS",
      owner: "UCREATOR",
      hookId: `hook-reveal-${++n}-0123456789`,
    });
  const deps = { sql: undefined as never, env: ENV, now: NOW };
  const with_ = (now = NOW) => ({ ...deps, sql: ledger.sql(), now });
  const formOf = async (response: Response) =>
    /name="form" value="([0-9a-f]+)"/.exec(await response.text())?.[1] ?? "";
  const post = (form: string, headers: Record<string, string> = {}) =>
    new Request("https://sym.example.com/sym/reveal/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ form }).toString(),
    });

  it("shows a button on GET, and the secret once on a POST with the page's token", async () => {
    const trigger = await make();
    const token = await createReveal(ledger.sql(), trigger, NOW);
    const secret = webhookSecret(KEY, trigger.hookId ?? "", 1);
    // A GET, such as a link preview, shows no secret and burns nothing, however often.
    for (const _ of [1, 2]) {
      const get = await showReveal(with_(), token);
      expect(get.status).toBe(200);
      expect(get.headers.get("cache-control")).toBe("no-store");
      expect(get.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await get.clone().text();
      expect(html).toContain("Reveal secret");
      expect(html).not.toContain(secret);
    }
    const form = await formOf(await showReveal(with_(), token));
    // A POST without the page's token, or from another site, shows nothing.
    expect((await useReveal(with_(), post("0".repeat(64)), token)).status).toBe(403);
    expect(
      (await useReveal(with_(), post(form, { "sec-fetch-site": "cross-site" }), token)).status,
    ).toBe(403);
    const shown = await useReveal(with_(), post(form), token);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).toContain(secret);
    expect(html).toContain("Deploy &#60;alerts&#62;");
    // Once only.
    expect((await useReveal(with_(), post(form), token)).status).toBe(410);
    expect((await showReveal(with_(), token)).status).toBe(410);
  });

  it("stores only a hash of the token", async () => {
    const trigger = await make();
    const token = await createReveal(ledger.sql(), trigger, NOW);
    const rows = await ledger.sql()`select * from webhook_reveals where trigger_id = ${trigger.id}`;
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("expires after 15 minutes, and after a rotation", async () => {
    const trigger = await make();
    const token = await createReveal(ledger.sql(), trigger, NOW);
    const form = await formOf(await showReveal(with_(), token));
    const late = new Date(NOW.getTime() + 16 * 60_000);
    expect((await showReveal(with_(late), token)).status).toBe(410);
    expect((await useReveal(with_(late), post(form), token)).status).toBe(410);

    const other = await make();
    const old = await createReveal(ledger.sql(), other, NOW);
    const oldForm = await formOf(await showReveal(with_(), old));
    await rotateWebhookSecret(ledger.sql(), other.id, "UCREATOR");
    expect((await useReveal(with_(), post(oldForm), old)).status).toBe(410);
    expect((await showReveal(with_(), "not-a-token")).status).toBe(410);
  });

  it("DMs the link with unfurls off and never the secret", async () => {
    const trigger: Trigger = await make();
    const posts: Record<string, unknown>[] = [];
    const slack: SlackApi = {
      async call(method, body) {
        if (method === "conversations.open") return { channel: { id: "DUCREATOR" } };
        posts.push(body);
        return { ts: "1.1" };
      },
    };
    expect(await sendRevealLink({ sql: ledger.sql(), slack }, trigger, ENV, NOW)).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: "DUCREATOR",
      unfurl_links: false,
      unfurl_media: false,
    });
    const text = String(posts[0]?.text);
    expect(text).toContain(`https://sym.example.com/sym/hooks/${trigger.hookId}`);
    expect(text).toMatch(/https:\/\/sym\.example\.com\/sym\/reveal\/[A-Za-z0-9_-]{43}/);
    expect(text).not.toContain("whsec_");
    expect(revealText(trigger, "u", "r")).not.toContain("whsec_");
  });
});
