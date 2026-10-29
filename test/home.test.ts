import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateConnection, proposeConnection, setDefaultMode } from "../lib/connections/rows.ts";
import { collectHome, type HomeDeps, homeRole, publishHome } from "../lib/home/home.ts";
import { slackApiOfContext } from "../lib/home/live.ts";
import {
  type HomeData,
  homeView,
  MAX_ACTIVE_JOBS,
  MAX_BLOCKS,
  MAX_SECTION_CHARS,
  NOT_SET_UP,
} from "../lib/home/view.ts";
import { createJob, type Job, type JobStatus, updateJob } from "../lib/ledger/jobs.ts";
import { setQuietUntil } from "../lib/quiet/quiet.ts";
import { approveSchedule, createSchedule, pauseSchedule } from "../lib/schedules/rows.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const NOW = new Date("2026-03-02T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function job(id: number, overrides: Partial<Job> = {}): Job {
  return {
    id,
    requestKey: `k${id}`,
    sessionId: null,
    kind: "code-change",
    title: `Job ${id}`,
    status: "running",
    owner: null,
    slackChannel: "C1",
    slackThreadTs: "1700000000.000100",
    codeChannel: false,
    originChannel: null,
    originThreadTs: null,
    brief: {},
    worker: "t3",
    workerIdentity: null,
    workerProjectId: null,
    workerThreadId: null,
    workerModel: null,
    cursor: null,
    lastSummary: null,
    lastMessage: null,
    cardTs: null,
    card: null,
    cardVersion: 0,
    cardSentVersion: 0,
    display: null,
    prUrl: null,
    startedAt: minutesAgo(14),
    lastActivityAt: null,
    quietNoticedAt: null,
    watchUntil: null,
    revision: 0,
    verdict: null,
    prFacts: null,
    endPresentedAt: null,
    createdAt: minutesAgo(15),
    updatedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

function data(overrides: Partial<HomeData> = {}): HomeData {
  return {
    now: NOW,
    persona: { name: "casual", source: "default" },
    worker: { state: "reachable", expiresAt: new Date(NOW.getTime() + 12 * 86_400_000) },
    active: [],
    finished: { done: 0, failed: 0, cancelled: 0, latest: [] },
    schedules: [],
    projects: ["alpha"],
    ...overrides,
  };
}

const ownerData = (overrides: Partial<HomeData> = {}) =>
  data({
    owner: {
      connections: [{ name: "docs", status: "active", auth: "token set", defaultMode: "ask" }],
      quietUntil: null,
    },
    ...overrides,
  });

const textOf = (view: { blocks: unknown[] }) => JSON.stringify(view.blocks);

describe("homeView by role", () => {
  it("shows one short line to a user who is not allowed", () => {
    const view = homeView("denied");
    expect(view.type).toBe("home");
    expect(view.blocks).toHaveLength(1);
    expect(textOf(view)).toContain(NOT_SET_UP);
  });

  it("shows the dashboard to an allowed user without owner sections", () => {
    const view = homeView("member", ownerData());
    const text = textOf(view);
    expect(text).toContain("Running and waiting");
    expect(text).toContain("Schedules");
    expect(text).toContain("Projects Sym works on");
    expect(text).not.toContain("sym_home_refresh");
    expect(text).not.toContain("Connections");
    expect(text).not.toContain("Settings");
    expect(text).not.toContain("docs");
  });

  it("adds connections and settings for the owner", () => {
    const text = textOf(homeView("owner", ownerData()));
    expect(text).toContain("Connections (1)");
    expect(text).toContain("default mode ask");
    expect(text).toContain("quiet mode off");
    expect(text).toContain("Persona casual (default)");
  });

  it("shows the persona, the worker label, the sign-in expiry, and the update time", () => {
    const text = textOf(homeView("member", data()));
    expect(text).toContain("*Persona:* casual");
    expect(text).toContain("*Worker:* ✅ reachable, signed in");
    expect(text).toContain("sign-in expires in 12 days");
    expect(text).toContain("Updated <!date^");
  });

  it("lists a job with its status, age, and thread link, waiting jobs first", () => {
    const view = homeView(
      "member",
      data({
        active: [job(3), job(2, { status: "waiting_input", title: "Needs <you> & more" })],
      }),
    );
    const text = textOf(view);
    expect(text.indexOf("J-2")).toBeLessThan(text.indexOf("J-3"));
    expect(text).toContain("🙋");
    expect(text).toContain("Needs &lt;you&gt; &amp; more");
    expect(text).toContain("waiting for you");
    expect(text).toContain("app_redirect?channel=C1&message_ts=1700000000.000100");
    expect(text).toContain("14m");
  });

  it("links a job in its own code channel to the channel", () => {
    const view = homeView(
      "member",
      data({
        active: [job(4, { codeChannel: true, slackChannel: "CCODE1", slackThreadTs: null })],
      }),
    );
    expect(textOf(view)).toContain("app_redirect?channel=CCODE1");
    expect(textOf(view)).not.toContain("message_ts");
  });

  it("shows paused and waiting schedules", () => {
    const schedule = {
      id: 1,
      cron: "0 9 * * *",
      title: "Morning check",
      brief: {},
      channel: "C1",
      owner: "U1",
      status: "paused" as const,
      approvedBy: null,
      approvedAt: null,
      leaseUntil: null,
      lastFiredAt: null,
      nextFireAt: null,
      createdAt: NOW,
      packKey: null,
    };
    const text = textOf(
      homeView(
        "member",
        data({
          schedules: [
            schedule,
            {
              ...schedule,
              id: 2,
              status: "active",
              nextFireAt: new Date(NOW.getTime() + 3600_000),
            },
          ],
        }),
      ),
    );
    expect(text).toContain("S-1 · Morning check · paused");
    expect(text).toContain("S-2 · Morning check · next <!date^");
  });
});

describe("homeView limits", () => {
  it("shows at most ten active jobs and says how many more", () => {
    const active = Array.from({ length: 25 }, (_, i) => job(i + 1));
    const view = homeView("member", data({ active }));
    const text = textOf(view);
    expect(text).toContain("Running and waiting (25)");
    expect(text).toContain(`J-${MAX_ACTIVE_JOBS}`);
    expect(text).not.toContain("J-11 ");
    expect(text).toContain("+15 more");
  });

  it("shows at most five finished jobs and ten schedules", () => {
    const latest = Array.from({ length: 8 }, (_, i) =>
      job(i + 1, { status: "done", finishedAt: minutesAgo(i + 1) }),
    );
    const text = textOf(
      homeView("member", data({ finished: { done: 8, failed: 2, cancelled: 0, latest } })),
    );
    expect(text).toContain("✅ 8 done · ❌ 2 failed");
    expect(text).toContain("+3 more");
    expect(text).toContain("5m ago");
  });

  it("keeps every section under 3000 characters and the view under 100 blocks", () => {
    const long = "x".repeat(5000);
    const active = Array.from({ length: 40 }, (_, i) => job(i + 1, { title: long }));
    const projects = Array.from({ length: 200 }, (_, i) => `${long}${i}`);
    const view = homeView("owner", ownerData({ active, projects }));
    expect(view.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    for (const block of view.blocks as { text?: { text: string } }[]) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    }
  });
});

describe("worker state", () => {
  it("shows unknown when the worker check fails", async () => {
    const view = homeView("member", data({ worker: { state: "unknown", expiresAt: null } }));
    expect(textOf(view)).toContain("status unknown");
  });

  it("shows not signed in", () => {
    const text = textOf(homeView("member", data({ worker: { state: "not_signed_in" } })));
    expect(text).toContain("not signed in");
  });
});

describe.skipIf(!hasDatabase)("worker state from the worker", () => {
  const ledger = useLedger();
  const base = (): HomeDeps => ({
    sql: ledger.sql(),
    pack: undefined,
    env: {},
    now: () => NOW,
    worker: async () => ({ expiresAt: null }),
    ping: async () => {},
    warn: () => {},
  });

  it("turns a ping error or a slow ping into unknown", async () => {
    const failing = await collectHome(
      {
        ...base(),
        ping: async () => {
          throw new Error("boom");
        },
      },
      "member",
    );
    expect(failing.worker.state).toBe("unknown");
    const slow = await collectHome(
      { ...base(), pingTimeoutMs: 20, ping: () => new Promise(() => {}) },
      "member",
    );
    expect(slow.worker.state).toBe("unknown");
    const missing = await collectHome({ ...base(), worker: async () => undefined }, "member");
    expect(missing.worker.state).toBe("not_signed_in");
    const broken = await collectHome(
      {
        ...base(),
        worker: async () => {
          throw new Error("db down");
        },
      },
      "member",
    );
    expect(broken.worker.state).toBe("unknown");
  });

  it("reads no owner data for a member and only the allow-listed projects", async () => {
    const result = await collectHome({ ...base(), env: { SYM_PROJECTS: "alpha, beta" } }, "member");
    expect(result.owner).toBeUndefined();
    expect(result.projects).toEqual(["alpha", "beta"]);
  });
});

describe("homeRole", () => {
  const deps = (env: Record<string, string>) => ({ pack: undefined, env, warn: () => {} });

  it("separates denied, member, and owner", () => {
    const env = { SYM_SLACK_USERS: "UOWNER,UMEMBER", SYM_OWNER_SLACK_USER: "UOWNER" };
    expect(homeRole(deps(env), "UOWNER")).toBe("owner");
    expect(homeRole(deps(env), "UMEMBER")).toBe("member");
    expect(homeRole(deps(env), "UOTHER")).toBe("denied");
    expect(homeRole(deps(env), undefined)).toBe("denied");
  });

  it("never gives the owner role when no owner is configured", () => {
    expect(homeRole(deps({ SYM_SLACK_USERS: "UA" }), "UA")).toBe("member");
  });
});

describe.skipIf(!hasDatabase)("publishHome", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  const warnings: string[] = [];

  beforeAll(async () => {
    slack = await startFakeSlack({ botToken: "xoxb-home" });
  });
  afterAll(async () => {
    await slack.close();
  });

  const api = () =>
    slackApiFromEnv({ SLACK_BOT_TOKEN: "xoxb-home", SLACK_API_BASE_URL: slack.apiBaseUrl });

  const deps = (): HomeDeps => ({
    sql: ledger.sql(),
    pack: undefined,
    env: {
      SYM_SLACK_USERS: "UOWNER,UMEMBER",
      SYM_OWNER_SLACK_USER: "UOWNER",
      SYM_PROJECTS: "alpha",
    },
    now: () => NOW,
    worker: async () => ({ expiresAt: new Date(NOW.getTime() + 3 * 86_400_000) }),
    ping: async () => {},
    warn: (line) => warnings.push(line),
  });

  const make = async (key: string, title: string, status?: JobStatus) => {
    const created = await createJob(ledger.sql(), {
      requestKey: key,
      kind: "code-change",
      title,
      brief: { project: "secret-project" },
      worker: "t3",
      workerProjectId: "secret-project",
      slackChannel: "C9",
      slackThreadTs: "1.000001",
    });
    return status ? updateJob(ledger.sql(), created.id, { status }) : created;
  };

  it("publishes one line for a user who is not allowed", async () => {
    await publishHome(api(), deps(), "UOTHER");
    const text = JSON.stringify(slack.homeViews.UOTHER);
    expect(text).toContain(NOT_SET_UP);
    expect(text).not.toContain("Running and waiting");
  });

  it("publishes the dashboard for a member and the owner sections for the owner only", async () => {
    await make("home-run", "Retry loop", "running");
    await make("home-wait", "Billing", "waiting_input");
    await make("home-done", "Docs", "done");
    await make("home-fail", "Lint", "failed");
    const schedule = await createSchedule(ledger.sql(), {
      cron: "0 9 * * *",
      title: "Morning check",
      brief: {},
      channel: "C1",
      owner: "UOWNER",
    });
    await approveSchedule(ledger.sql(), schedule.id, "UOWNER", NOW);
    const paused = await createSchedule(ledger.sql(), {
      cron: "0 10 * * *",
      title: "Paused one",
      brief: {},
      channel: "C1",
      owner: "UOWNER",
    });
    await approveSchedule(ledger.sql(), paused.id, "UOWNER", NOW);
    await pauseSchedule(ledger.sql(), paused.id);
    const proposed = await proposeConnection(ledger.sql(), {
      name: "docs",
      url: "https://mcp.example.com",
      description: "",
      authKind: "none",
      envVar: null,
      tools: [],
      serverInstructions: null,
      createdBy: "UOWNER",
    });
    if (!proposed.ok) throw new Error("propose failed");
    await activateConnection(ledger.sql(), proposed.row.id, "UOWNER", NOW);
    await setDefaultMode(ledger.sql(), proposed.row.id, "ask");
    await setQuietUntil(ledger.sql(), new Date(NOW.getTime() + 3600_000));

    await publishHome(api(), deps(), "UMEMBER");
    await publishHome(api(), deps(), "UOWNER");

    const member = JSON.stringify(slack.homeViews.UMEMBER);
    expect(member).toContain("J-");
    expect(member).toContain("Retry loop");
    expect(member).toContain("waiting for you");
    expect(member).toContain("✅ 1 done · ❌ 1 failed");
    expect(member).toContain("Morning check");
    expect(member).toContain("Paused one · paused");
    expect(member).toContain("alpha");
    expect(member).toContain("expires in 3 days");
    expect(member).not.toContain("Connections");
    expect(member).not.toContain("docs\\`");

    const owner = JSON.stringify(slack.homeViews.UOWNER);
    expect(owner).toContain("Connections (1)");
    expect(owner).toContain("docs");
    expect(owner).toContain("default mode ask");
    expect(owner).toContain("quiet until");
  });

  it("never shows a project outside the allow-list", async () => {
    await publishHome(api(), deps(), "UOWNER");
    await publishHome(api(), deps(), "UMEMBER");
    for (const user of ["UOWNER", "UMEMBER"]) {
      expect(JSON.stringify(slack.homeViews[user])).not.toContain("secret-project");
    }
  });

  it("re-publishes fresh data on the next open", async () => {
    await make("home-refresh", "Added after open", "running");
    const request = async (operation: string, body: Record<string, unknown>) => {
      const response = await fetch(`${slack.apiBaseUrl}${operation}`, {
        method: "POST",
        headers: {
          authorization: "Bearer xoxb-home",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return (await response.json()) as { ok?: boolean; error?: string };
    };
    expect(JSON.stringify(slack.homeViews.UMEMBER)).not.toContain("Added after open");
    await publishHome(slackApiOfContext({ request }), deps(), "UMEMBER");
    expect(JSON.stringify(slack.homeViews.UMEMBER)).toContain("Added after open");
  });

  it("logs only the Slack error code when the publish fails", async () => {
    warnings.length = 0;
    slack.failNext("views.publish", "not_allowed_token_type");
    const ok = await publishHome(api(), deps(), "UMEMBER");
    expect(ok).toBe(false);
    expect(warnings).toEqual(["Sym could not publish the Home tab: not_allowed_token_type."]);
  });
});
