import { describe, expect, it } from "vitest";
import {
  ownerTarget,
  parseSignInExpiry,
  queueSignInNotice,
  signInNotice,
  signInText,
} from "../lib/workers/expiry.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const DAY = 86_400_000;
const expiresAt = new Date("2026-11-10T12:00:00Z");
const at = (daysBefore: number) => new Date(expiresAt.getTime() - daysBefore * DAY);

describe("signInNotice", () => {
  it("is none when the expiry is unknown or far away", () => {
    expect(signInNotice(null, at(1)).stage).toBe("none");
    expect(signInNotice(expiresAt, at(20)).stage).toBe("none");
    expect(signInNotice(expiresAt, at(5.01)).stage).toBe("none");
  });

  it("warns from 5 days before", () => {
    expect(signInNotice(expiresAt, at(5))).toEqual({ stage: "warn", daysLeft: 5 });
    expect(signInNotice(expiresAt, at(0.2))).toEqual({ stage: "warn", daysLeft: 1 });
  });

  it("is expired at and after the expiry", () => {
    expect(signInNotice(expiresAt, expiresAt).stage).toBe("expired");
    expect(signInNotice(expiresAt, at(-3)).stage).toBe("expired");
  });
});

describe("parseSignInExpiry", () => {
  it("parses a date and ignores empty or invalid values", () => {
    expect(parseSignInExpiry("2026-11-10T12:00:00.000Z")).toEqual(expiresAt);
    expect(parseSignInExpiry("")).toBeNull();
    expect(parseSignInExpiry(undefined)).toBeNull();
    expect(parseSignInExpiry("soon")).toBeNull();
  });
});

describe("ownerTarget", () => {
  const pack = { config: { owner: { slackUserId: "UPACK" } } } as never;

  it("prefers the pack owner, then SYM_OWNER_SLACK_USER, then the digest target", () => {
    const env = { SYM_OWNER_SLACK_USER: "UENV", SYM_DIGEST_CHANNEL: "CDIG" };
    expect(ownerTarget(pack, env)).toBe("UPACK");
    expect(ownerTarget(undefined, env)).toBe("UENV");
    expect(ownerTarget(undefined, { SYM_DIGEST_CHANNEL: "CDIG" })).toBe("CDIG");
    expect(ownerTarget(undefined, {})).toBeUndefined();
  });
});

describe("signInText", () => {
  it("gives the re-approve step", () => {
    const text = signInText("warn", {
      expiresAt,
      now: at(4),
      target: "U1",
      mcpUrl: "https://worker.example/mcp",
    });
    expect(text).toBe(
      "The worker sign-in expires in 4 days (2026-11-10). To renew it, run `pnpm t3:login https://worker.example/mcp` and approve it in the browser.",
    );
  });

  it("says jobs pause after expiry", () => {
    expect(signInText("expired", { expiresAt, now: at(-1), target: "U1" })).toMatch(
      /expired on 2026-11-10\. Jobs pause until you approve a new one\. .*<mcp-url>/,
    );
  });
});

describe.skipIf(!hasDatabase)("queueSignInNotice", () => {
  const ledger = useLedger();
  const notices = async () =>
    ledger.sql()<{ key: string; payload: { channel: string; text: string }; display: unknown }[]>`
      select idempotency_key as key, payload, display from outbox
      where idempotency_key like 'signin:%' order by id`;

  it("queues nothing when no notice is due or nobody is named", async () => {
    const sql = ledger.sql();
    expect(await queueSignInNotice(sql, { expiresAt, now: at(20), target: "U1" })).toBe(false);
    expect(await queueSignInNotice(sql, { expiresAt, now: at(2), target: undefined })).toBe(false);
    expect(await queueSignInNotice(sql, { expiresAt: null, now: at(2), target: "U1" })).toBe(false);
    expect(await notices()).toEqual([]);
  });

  it("queues one DM per stage and expiry date, however often reconcile runs", async () => {
    const sql = ledger.sql();
    const input = { expiresAt, target: "U1", mcpUrl: "https://worker.example/mcp" };

    expect(await queueSignInNotice(sql, { ...input, now: at(4) })).toBe(true);
    expect(await queueSignInNotice(sql, { ...input, now: at(3) })).toBe(false);
    expect(await queueSignInNotice(sql, { ...input, now: at(-1) })).toBe(true);
    expect(await queueSignInNotice(sql, { ...input, now: at(-2) })).toBe(false);

    const rows = await notices();
    expect(rows.map((row) => row.key)).toEqual([
      "signin:2026-11-10:warn",
      "signin:2026-11-10:expired",
    ]);
    expect(rows[0]?.payload.channel).toBe("U1");
    expect(rows[0]?.display).toMatchObject({ level: 2, target: "dm", reason: "needs action" });
  });

  it("starts fresh after a new sign-in", async () => {
    const sql = ledger.sql();
    const renewed = new Date(expiresAt.getTime() + 30 * DAY);
    expect(
      await queueSignInNotice(sql, {
        expiresAt: renewed,
        now: new Date(renewed.getTime() - DAY),
        target: "U1",
      }),
    ).toBe(true);
    expect((await notices()).map((row) => row.key)).toContain("signin:2026-12-10:warn");
  });
});
