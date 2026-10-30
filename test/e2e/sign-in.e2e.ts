import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOT,
  type Harness,
  launchesOf,
  messageText,
  newConversation,
  OWNER,
  startHarness,
  startJob,
  until,
} from "./harness.ts";

// The in-app worker sign-in (decision 036). The owner asks Sym in Slack, gets the T3 link in a
// DM, approves (the fake T3 approves at once), and the browser redirect lands on Eve's webhook
// with a GET. Sym redeems the code, stores the token in Postgres, and uses it for the next job.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    database: "sym_e2e_sign_in",
    env: { SYM_OWNER_SLACK_USER: OWNER },
  });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

interface CredentialRow {
  worker: string;
  mcpUrl: string;
  accessToken: string;
  expiresAt: Date | null;
  approvedBy: string | null;
}

describe("worker sign-in", () => {
  it("signs in from Slack, stores the token, and uses it for the next job", async () => {
    const c = newConversation(h);
    await c.mention(`<@${BOT}> please sign in to the worker`);

    // The link goes to the owner's DM, never to the thread.
    const dm = await until(
      () =>
        h.slack.messages.find(
          (m) => m.channel === OWNER && /approve my builder sign-in/.test(messageText(m)),
        ),
      { label: "the sign-in DM", timeoutMs: 60_000 },
    );
    const link = /<([^|>]+)\|/.exec(dm.text ?? "")?.[1];
    if (!link) throw new Error("no link in the sign-in DM");
    expect(c.messages().some((m) => messageText(m).includes(link))).toBe(false);

    // The owner's browser: T3 approves and redirects to Sym with a GET.
    const consent = await fetch(link, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const redirect = new URL(consent.headers.get("location") ?? "");
    expect(redirect.origin).toBe(new URL(h.eveUrl()).origin);
    expect(redirect.pathname).toMatch(/^\/\.well-known\/workflow\/v1\/webhook\//);

    // A stray visit without the state does not end the sign-in.
    const stray = await fetch(`${redirect.origin}${redirect.pathname}`);
    expect(stray.status).toBe(200);
    await stray.text();

    const page = await fetch(redirect);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("You can close this tab");

    const row = await until(
      async () => {
        const [found] = await h.sql<CredentialRow[]>`
          select worker, mcp_url, access_token, expires_at, approved_by
          from worker_credentials where worker = 'default'`;
        return found;
      },
      { label: "the stored sign-in", timeoutMs: 60_000 },
    );
    expect(row).toMatchObject({ worker: "default", mcpUrl: h.t3.url, approvedBy: OWNER });
    expect(h.t3.oauth.issued).toEqual([row.accessToken]);
    const days = ((row.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    // The token never reaches the eve log.
    expect(h.logs()).not.toContain(row.accessToken);

    // The next job runs on the stored token, ahead of the env T3_TOKEN.
    const before = h.t3.oauth.oauthCalls;
    const job = newConversation(h);
    const { approval, ref } = await startJob(h, job, "Signed-in job");
    await job.click(approval, "Start");
    await until(() => launchesOf(h, ref)[0], { label: `${ref} launch` });
    expect(h.t3.oauth.oauthCalls).toBeGreaterThan(before);
  });
});
