import { describe, expect, it } from "vitest";
import type { Pack } from "../lib/pack/load.ts";
import { settingsInstructions } from "../lib/settings.ts";

function packWith(config: Partial<Pack["config"]>): Pack {
  return {
    dir: "/pack",
    config: {
      owner: { slackUserId: "U0OWNER" },
      allowList: [],
      workers: [],
      projects: [],
      instructions: [],
      playbooks: [],
      skills: [],
      identities: [],
      githubRepositories: [],
      ...config,
    } as Pack["config"],
    instructions: [],
    playbooks: [],
    skills: [],
    schedules: [],
  };
}

describe("settingsInstructions", () => {
  it("lists the owner and the allow-list from the environment", () => {
    const note = settingsInstructions(undefined, {
      SYM_OWNER_SLACK_USER: "U0OWNER",
      SYM_SLACK_USERS: "U0OWNER, U0ALEX,U0ALEX",
    });
    expect(note).toContain("No pack is loaded");
    expect(note).toContain("Owner: U0OWNER (`SYM_OWNER_SLACK_USER`)");
    expect(note).toContain("the only people Sym answers (`SYM_SLACK_USERS`): U0OWNER, U0ALEX.");
  });

  it("says when nobody is allowed and no owner is set", () => {
    const note = settingsInstructions(undefined, {});
    expect(note).toContain("Nobody is on the allow-list (`SYM_SLACK_USERS`).");
    expect(note).toContain("No owner is set");
  });

  it("reads people, identities, repositories, and channels from a pack over the environment", () => {
    const pack = packWith({
      allowList: ["U0SAM"],
      identities: [{ slackUserId: "U0SAM", githubId: 42 }],
      githubRepositories: ["acme/app"],
      channels: { default: "C0MAIN", digest: "C0DIGEST" },
      timeZone: "Europe/Berlin",
    });
    const note = settingsInstructions(pack, {
      SYM_SLACK_USERS: "U0ENV",
      SYM_GITHUB_REPOS: "env/repo",
      SYM_DIGEST: "on",
    });
    expect(note).toContain("A pack (`SYM_PACK_DIR`)");
    expect(note).toContain(": U0OWNER, U0SAM.");
    expect(note).not.toContain("U0ENV");
    expect(note).toContain("GitHub accounts are mapped for U0SAM");
    expect(note).toContain("No Linear accounts are mapped");
    expect(note).toContain("GitHub repositories Sym may read events from: acme/app.");
    expect(note).not.toContain("env/repo");
    expect(note).toContain(
      "The daily digest goes to the channel C0DIGEST on the cron `0 17 * * *`",
    );
    expect(note).toContain("Time zone: Europe/Berlin");
    expect(note).toContain("Default channel: the channel C0MAIN");
  });

  it("caps a long allow-list", () => {
    const users = Array.from({ length: 53 }, (_, i) => `U${String(i).padStart(4, "0")}`);
    const note = settingsInstructions(undefined, { SYM_SLACK_USERS: users.join(",") });
    expect(note).toContain("U0049, and 3 more.");
    expect(note).not.toContain("U0050");
  });

  it("follows each switch", () => {
    const on = settingsInstructions(undefined, {
      SYM_STRANGER_REPLIES: "on",
      SYM_FEEDBACK: "on",
      SYM_RESULT_WRITER: "on",
      SYM_DIGEST: "on",
      SYM_DIGEST_CHANNEL: "U0OWNER",
      SYM_DIGEST_CRON: "30 8 * * 1-5",
      SYM_TRIGGER_RUNS_PER_HOUR: "5",
      SYM_BOT_NAME: "Robo",
    });
    expect(on).toContain("gets a private line telling them to ask the owner");
    expect(on).toContain("helpful / not helpful buttons");
    expect(on).toContain("A model writes each finished job's result");
    expect(on).toContain("a direct message to U0OWNER on the cron `30 8 * * 1-5`");
    expect(on).toContain("at most 5 runs per hour");
    expect(on).toContain('they call Sym "Robo"');
    const off = settingsInstructions(undefined, {
      SYM_STRANGER_REPLIES: "off",
      SYM_FEEDBACK: "off",
      SYM_RESULT_WRITER: "off",
      SYM_DIGEST: "on",
    });
    expect(off).toContain("gets no reply");
    expect(off).toContain("no feedback buttons");
    expect(off).toContain("fixed template");
    expect(off).toContain("on but has no channel");
    expect(off).toContain("Weekly playbook proposals are off");
  });

  it("describes the model route, the trigger gate, and the sandbox", () => {
    const direct = settingsInstructions(undefined, {
      SYM_MODEL_PROVIDER: "anthropic",
      SYM_MODEL: "claude-sonnet-5-5",
      SYM_REASONING: "high",
      SYM_PROMPT_CACHE_TTL: "1h",
      SYM_RESEARCH_BUDGET_USD: "1.5",
      SYM_TRANSCRIBE_MODEL: "off",
      SYM_SANDBOX: "on",
      SYM_SANDBOX_MEMORY: "2g",
    });
    expect(direct).toContain("`claude-sonnet-5-5` directly on anthropic");
    expect(direct).toContain("reasoning `high`");
    expect(direct).toContain("lasts one hour");
    expect(direct).toContain("about $1.50 per session");
    expect(direct).toContain("Voice notes are not transcribed");
    expect(direct).toContain("A model check (`claude-haiku-5-5`)");
    expect(direct).toContain("2048 MB of memory");
    const gateway = settingsInstructions(undefined, { SYM_TRIGGER_GATE: "off" });
    expect(gateway).toContain("`anthropic/claude-sonnet-5.5` through the AI Gateway");
    expect(gateway).toContain("every keyword match, with no model check");
    expect(gateway).not.toContain("sandbox has");
  });

  it("names configured connections without their secret values", () => {
    const secrets = {
      SYM_WEBHOOK_KEY: "k".repeat(40),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key-value",
      GITHUB_WEBHOOK_SECRET: "github-secret-value",
      LINEAR_AGENT_ACCESS_TOKEN: "linear-token-value",
      LINEAR_WEBHOOK_SECRET: "linear-secret-value",
      SYM_API_TOKEN: "api-token-value",
      SYM_MCP_TOKEN: "mcp-token-value",
      SYM_CALLBACK_URL: "https://sym.example.com/callback-secret-path",
    };
    const note = settingsInstructions(undefined, secrets);
    expect(note).toContain("Webhook triggers are available");
    expect(note).toContain("The GitHub app is connected");
    expect(note).toContain("The Linear app is connected");
    expect(note).toContain("Workers report job progress to Sym as it happens");
    expect(note).toContain("Sym has a public address");
    expect(note).toContain("can call Sym's session API with a token");
    expect(note).toContain("read job status over Sym's MCP endpoint");
    for (const value of Object.values(secrets)) expect(note).not.toContain(value);
    const none = settingsInstructions(undefined, {});
    expect(none).toContain("Webhook triggers are off");
    expect(none).toContain("GitHub is not connected");
    expect(none).toContain("Linear is not connected");
    expect(none).toContain("every 4 minutes");
    expect(none).toContain("no public address");
  });
});
