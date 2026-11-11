import { researchBudgetUsd } from "./brain/budget.ts";
import { DEFAULT_MODEL, promptCacheTtl, selectedProvider } from "./brain/model.ts";
import { DEFAULT_DIGEST_CRON, digestChannel, digestEnabled } from "./digest/post.ts";
import { feedbackEnabled } from "./feedback/feedback.ts";
import { allowedGitHubRepos } from "./github-repos.ts";
import { mappedSlackUsers } from "./identities.ts";
import { writerEnabled } from "./jobs/writer.ts";
import { ownerUserId } from "./owner.ts";
import type { Pack } from "./pack/load.ts";
import {
  DEFAULT_SANDBOX_IMAGE,
  sandboxEnabled,
  sandboxImage,
  sandboxMemoryBytes,
} from "./sandbox/config.ts";
import { isValidCron } from "./schedules/cron.ts";
import { allowedSlackUsers } from "./slack/guard.ts";
import { strangerRepliesOn } from "./slack/strangers.ts";
import { runsPerHour } from "./triggers/fire.ts";
import { gateModelId } from "./triggers/gate.ts";
import { githubConfigured, linearConfigured } from "./triggers/sources.ts";
import { webhookKey } from "./triggers/webhook.ts";
import { transcriptionRoute } from "./voice/route.ts";

// The deployment's settings, for the brain's instructions (decision 097). Each line reads the
// same helper the code reads, so the brain answers "who can use you?" or "where does the digest
// go?" from the real configuration. It names settings and people, never a secret's value.

type Env = Record<string, string | undefined>;

// A long allow-list would crowd the prompt; the brain says how many more there are.
const MAX_LISTED_PEOPLE = 50;

export function settingsInstructions(pack: Pack | undefined, env: Env = process.env): string {
  return [
    "# How Sym is set up here",
    "",
    "These are this deployment's settings. Answer questions about who can use Sym and how it is set up from this list, and do not guess beyond it. Only the owner changes settings, in the deployment's configuration; name the setting in backticks when someone asks how to change one. The list holds no secret values, and you never reveal one.",
    "",
    sourceLine(pack),
    "",
    "## People",
    ...peopleLines(pack, env),
    "",
    "## Replies and reports",
    ...replyLines(pack, env),
    "",
    "## Models",
    ...modelLines(env),
    "",
    "## Triggers",
    ...triggerLines(pack, env),
    "",
    "## Connections",
    ...connectionLines(env),
  ].join("\n");
}

function sourceLine(pack: Pack | undefined): string {
  return pack
    ? "A pack (`SYM_PACK_DIR`) sets the owner, the allow-list, projects, identities, GitHub repositories, and channels; environment variables set the rest."
    : "No pack is loaded, so environment variables set everything.";
}

function peopleLines(pack: Pack | undefined, env: Env): string[] {
  const owner = ownerUserId(pack, env);
  const allowed = allowedSlackUsers(pack, env.SYM_SLACK_USERS);
  const strangers = strangerRepliesOn(env.SYM_STRANGER_REPLIES);
  return [
    "- People below are Slack user IDs. Look up a name with `slack_user` before you list people, and tag someone only when asked.",
    owner
      ? `- Owner: ${owner} (${pack ? "the pack" : "`SYM_OWNER_SLACK_USER`"}). Only the owner approves playbooks and rules.`
      : "- No owner is set (`SYM_OWNER_SLACK_USER`), so anyone on the allow-list may approve playbooks and rules.",
    allowed.length === 0
      ? `- Nobody is on the allow-list (${pack ? "the pack's `allowList`" : "`SYM_SLACK_USERS`"}).`
      : `- Allow-list, the only people Sym answers (${pack ? "the pack's owner and `allowList`" : "`SYM_SLACK_USERS`"}): ${listPeople(allowed)}.`,
    strangers
      ? "- Someone off the allow-list who writes to Sym gets a private line telling them to ask the owner (`SYM_STRANGER_REPLIES`)."
      : "- Someone off the allow-list gets no reply (`SYM_STRANGER_REPLIES` is off).",
    `- In a thread with several people, they call Sym "${env.SYM_BOT_NAME?.trim() || "sym"}" without a tag (\`SYM_BOT_NAME\`).`,
    identityLine(
      "GitHub",
      pack ? "the pack's `identities`" : "`SYM_GITHUB_USERS`",
      mappedSlackUsers("github", pack, env),
    ),
    identityLine(
      "Linear",
      pack ? "the pack's `identities`" : "`SYM_LINEAR_USERS`",
      mappedSlackUsers("linear", pack, env),
    ),
  ];
}

function listPeople(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED_PEOPLE).join(", ");
  const more = ids.length - MAX_LISTED_PEOPLE;
  return more > 0 ? `${shown}, and ${more} more` : shown;
}

function identityLine(source: string, setting: string, people: string[]): string {
  return people.length === 0
    ? `- No ${source} accounts are mapped to Slack people (${setting}), so no ${source} request reaches a Slack person.`
    : `- ${source} accounts are mapped for ${listPeople(people)} (${setting}).`;
}

function replyLines(pack: Pack | undefined, env: Env): string[] {
  const channel = digestChannel(pack, env);
  const where = channel ? destination(channel) : undefined;
  const cron = env.SYM_DIGEST_CRON?.trim();
  const time = cron && isValidCron(cron) ? cron : DEFAULT_DIGEST_CRON;
  const digest = !digestEnabled(env)
    ? "- The daily digest is off (`SYM_DIGEST`)."
    : where
      ? `- The daily digest goes to ${where} on the cron \`${time}\` in UTC (\`SYM_DIGEST_CRON\`).`
      : "- The daily digest is on but has no channel (`SYM_DIGEST_CHANNEL`), so it posts nothing.";
  return [
    feedbackEnabled(env)
      ? "- Job results carry helpful / not helpful buttons (`SYM_FEEDBACK`)."
      : "- Job results carry no feedback buttons (`SYM_FEEDBACK` is off).",
    writerEnabled(env)
      ? "- A model writes each finished job's result in Sym's voice (`SYM_RESULT_WRITER`)."
      : "- Finished job results use a fixed template (`SYM_RESULT_WRITER` is off).",
    digest,
    where
      ? `- Weekly playbook proposals go to ${where}.`
      : "- Weekly playbook proposals are off, because no digest channel is set.",
    ...(pack?.config.timeZone ? [`- Time zone: ${pack.config.timeZone} (the pack).`] : []),
    ...(pack?.config.quietHours
      ? [
          `- Quiet hours: ${pack.config.quietHours.from} to ${pack.config.quietHours.to} (the pack).`,
        ]
      : []),
    ...(pack?.config.channels
      ? [`- Default channel: ${destination(pack.config.channels.default)} (the pack).`]
      : []),
  ];
}

// A channel ID, or a user ID for a direct message.
function destination(id: string): string {
  return /^[UW]/.test(id) ? `a direct message to ${id}` : `the channel ${id}`;
}

function modelLines(env: Env): string[] {
  const provider = selectedProvider(env);
  const configured = env.SYM_MODEL?.trim();
  const model =
    configured === "fixture"
      ? "a scripted test model"
      : configured
        ? `\`${configured}\``
        : provider === "gateway"
          ? `\`${DEFAULT_MODEL}\``
          : "the provider's default model";
  const route = provider === "gateway" ? "through the AI Gateway" : `directly on ${provider}`;
  const reasoning = env.SYM_REASONING?.trim();
  const audio = transcriptionRoute(env);
  const lines = [
    `- Sym's brain runs on ${model} ${route} (\`SYM_MODEL\`, \`SYM_MODEL_PROVIDER\`), with ${reasoning ? `reasoning \`${reasoning}\`` : "the default reasoning level"} (\`SYM_REASONING\`).`,
    `- The prompt cache lasts ${promptCacheTtl(env) === "1h" ? "one hour" : "five minutes"} (\`SYM_PROMPT_CACHE_TTL\`).`,
    `- The researcher may spend about $${researchBudgetUsd(env).toFixed(2)} per session (\`SYM_RESEARCH_BUDGET_USD\`).`,
    audio
      ? `- Voice notes are transcribed with \`${audio.model}\` (\`SYM_TRANSCRIBE_MODEL\`).`
      : "- Voice notes are not transcribed (`SYM_TRANSCRIBE_MODEL`).",
  ];
  if (sandboxEnabled(env)) {
    const image = sandboxImage(env);
    lines.push(
      `- Each sandbox has ${Math.round(sandboxMemoryBytes(env) / 1024 ** 2)} MB of memory (\`SYM_SANDBOX_MEMORY\`) and runs ${image === DEFAULT_SANDBOX_IMAGE ? "Eve's default image" : `the image \`${image}\``} (\`SYM_SANDBOX_IMAGE\`).`,
    );
  }
  return lines;
}

function triggerLines(pack: Pack | undefined, env: Env): string[] {
  const gate = gateModelId(env);
  const repos = allowedGitHubRepos(pack, env);
  const github = githubConfigured(env);
  return [
    `- One trigger starts at most ${runsPerHour(env.SYM_TRIGGER_RUNS_PER_HOUR)} runs per hour (\`SYM_TRIGGER_RUNS_PER_HOUR\`).`,
    gate === null
      ? "- Message triggers fire on every keyword match, with no model check (`SYM_TRIGGER_GATE`)."
      : `- A model check (${gate ? `\`${gate}\`` : "Eve's default decision model"}) skips message triggers a new message clearly does not need (\`SYM_TRIGGER_GATE\`).`,
    webhookKey(env)
      ? "- Webhook triggers are available (`SYM_WEBHOOK_KEY` is set)."
      : "- Webhook triggers are off (`SYM_WEBHOOK_KEY` is not set).",
    github
      ? "- The GitHub app is connected, so GitHub triggers and mentions work."
      : "- GitHub is not connected (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`).",
    repos.length === 0
      ? `- No GitHub repositories are listed (${pack ? "the pack's `githubRepositories`" : "`SYM_GITHUB_REPOS`"}), so GitHub triggers cannot be created.`
      : `- GitHub repositories Sym may read events from: ${repos.join(", ")}.`,
    linearConfigured(env)
      ? "- The Linear app is connected, so Linear triggers and delegations work."
      : "- Linear is not connected (`LINEAR_AGENT_ACCESS_TOKEN`, `LINEAR_WEBHOOK_SECRET`).",
  ];
}

function connectionLines(env: Env): string[] {
  const set = (name: string) => Boolean(env[name]?.trim());
  return [
    set("SYM_CALLBACK_URL")
      ? "- Workers report job progress to Sym as it happens (`SYM_CALLBACK_URL`)."
      : "- Sym checks running jobs every 4 minutes, because workers have no address to call back (`SYM_CALLBACK_URL`).",
    set("SYM_SIGNIN_URL") || set("SYM_CALLBACK_URL")
      ? "- Sym has a public address, so worker sign-in and webhook links work (`SYM_SIGNIN_URL`)."
      : "- Sym has no public address, so worker sign-in links and webhook URLs cannot be built (`SYM_SIGNIN_URL`).",
    set("SYM_API_TOKEN")
      ? "- Scripts and operators can call Sym's session API with a token (`SYM_API_TOKEN`)."
      : "- Sym's session API is closed to scripts in production (`SYM_API_TOKEN` is not set).",
    set("SYM_MCP_TOKEN")
      ? "- Outside tools can read job status over Sym's MCP endpoint with a token (`SYM_MCP_TOKEN`)."
      : "- Sym's MCP endpoint takes job tokens only (`SYM_MCP_TOKEN` is not set).",
  ];
}
