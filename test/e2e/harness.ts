import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";
import { connect, type Sql } from "../../lib/db.ts";
import { type Job, jobRef } from "../../lib/ledger/jobs.ts";
import { migrate } from "../../lib/ledger/migrate.ts";
import { type FakeSlack, type FakeSlackMessage, startFakeSlack } from "../fakes/slack-server.ts";
import {
  type FakeT3,
  type FakeT3Step,
  type FakeT3Thread,
  startFakeT3,
} from "../fakes/t3-server.ts";
import {
  appMentionRequest,
  blockActionsRequest,
  channelMessageRequest,
  type SlackRequestParts,
} from "../helpers/slack-events.ts";

// The local end-to-end harness (milestone 1). It runs the real `eve dev` server with the fixture
// brain, a fake T3 MCP server, a fake Slack Web API, signed Slack events, and a fresh database on
// the local Postgres. Nothing connects to a real service.
//
// `eve dev` loads `.env.local` from the app root, so the harness copies the app into a temporary
// folder and runs it there. The real secrets never reach the server, and the run gets its own
// `.eve` state.

const REPO = resolve(import.meta.dirname, "../..");
const ADMIN_URL = process.env.E2E_ADMIN_DATABASE_URL ?? "postgres://sym:sym@localhost:55432/sym";

export const OWNER = "UOWNER";
export const BOT = "UBOT";
const SIGNING_SECRET = "e2e-signing-secret";
const BOT_TOKEN = "xoxb-e2e-fake";

export interface HarnessOptions {
  // The database the run creates and drops.
  database: string;
  // Extra environment for `eve dev`, applied last.
  env?: Record<string, string>;
}

export interface Harness {
  sql: Sql;
  slack: FakeSlack;
  t3: FakeT3;
  eveUrl: () => string;
  logs: () => string;
  // With E2E_REPORT=<file>, writes the eve log and every fake Slack and T3 call there.
  writeReport(): void;
  startEve(): Promise<void>;
  stopEve(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  // The process ID keeps two runs apart, such as two worktrees testing at once on one Postgres.
  const database = `${options.database}_${process.pid}`;
  const databaseUrl = await freshDatabase(database);
  const sql = connect({ url: databaseUrl });
  await migrate(sql);

  const slack = await startFakeSlack({ botToken: BOT_TOKEN, botUserId: BOT });
  // Each thread waits until the test, acting as the worker agent, gives it steps.
  // The worker has a project outside SYM_PROJECTS, so a scenario can show it stays untouched.
  const t3 = await startFakeT3({
    script: [],
    projects: [
      { id: "project-1", title: "test-repo", workspaceRoot: "/repos/test-repo" },
      { id: "project-2", title: "other-repo", workspaceRoot: "/repos/other-repo" },
    ],
  });

  const appDir = copyApp();
  const logFile = join(appDir, "eve.log");
  let child: ChildProcess | undefined;
  let url = "";

  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    EVE_TELEMETRY_DISABLED: "1",
    DATABASE_URL: databaseUrl,
    SYM_MODEL: "fixture",
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_API_BASE_URL: slack.apiBaseUrl,
    T3_MCP_URL: t3.url,
    T3_TOKEN: t3.token,
    SYM_SLACK_USERS: OWNER,
    SYM_PROJECTS: "test-repo",
    SYM_WORKER_MODEL: "fake/fake-model",
    SYM_WORKER_LABEL: "Builder",
    SYM_JOB_POLL_SECONDS: "2",
    SYM_JOB_POLL_AFTER_CALLBACK_SECONDS: "1",
    // The scenarios cover the opt-in verifier (decision 054).
    SYM_VERIFIER: "on",
  };

  const harness: Harness = {
    sql,
    slack,
    t3,
    eveUrl: () => url,
    logs: () => readFileSync(logFile, "utf8"),
    writeReport() {
      const target = process.env.E2E_REPORT;
      if (!target) return;
      const lines = [
        harness.logs(),
        ...slack.calls.map((c) => `SLACK ${c.method} ${JSON.stringify(c.body)}`),
        ...t3.calls.map((c) => `T3 ${c.name} ${JSON.stringify(c.args)}`),
      ];
      appendFileSync(target, `${lines.join("\n")}\n`);
    },
    async startEve() {
      const port = await freePort();
      const out = openSync(logFile, "a");
      child = spawn(
        join(appDir, "node_modules/.bin/eve"),
        ["dev", "--no-ui", "--host", "127.0.0.1"],
        {
          cwd: appDir,
          // The worker calls back on the address it can reach, here the server itself.
          env: {
            ...env,
            PORT: String(port),
            SYM_CALLBACK_URL: `http://127.0.0.1:${port}`,
            ...options.env,
          },
          detached: true,
          stdio: ["ignore", out, out],
        },
      );
      url = `http://127.0.0.1:${port}`;
      await until(
        async () => {
          if (child?.exitCode !== null) throw new Error(`eve dev exited:\n${harness.logs()}`);
          const response = await fetch(`${url}/eve/v1/health`).catch(() => undefined);
          return response?.ok ? true : undefined;
        },
        { timeoutMs: 180_000, label: "eve dev health" },
      );
    },
    async stopEve() {
      if (child?.pid) await killTree(child.pid);
      child = undefined;
    },
    async close() {
      await harness.stopEve();
      await sql.end();
      await slack.close();
      await t3.close();
      if (!process.env.E2E_KEEP_APP) rmSync(appDir, { recursive: true, force: true });
      await dropDatabase(database);
    },
  };
  return harness;
}

// A Slack conversation in one channel thread, driven like the owner would drive it.
export class Conversation {
  rootTs = "";
  private readonly h: Harness;
  readonly channel: string;

  constructor(h: Harness, channel: string) {
    this.h = h;
    this.channel = channel;
  }

  // Posts the root message as the owner and sends Sym the signed app_mention.
  async mention(text: string, user = OWNER): Promise<void> {
    const root = this.h.slack.addMessage({ channel: this.channel, user, text });
    this.rootTs = root.ts;
    await postSlack(
      this.h,
      appMentionRequest({
        signingSecret: SIGNING_SECRET,
        channel: this.channel,
        user,
        text,
        ts: root.ts,
      }),
    );
  }

  // A reply in the thread that mentions Sym.
  async reply(text: string, user = OWNER): Promise<void> {
    const message = this.h.slack.addMessage({
      channel: this.channel,
      user,
      text,
      thread_ts: this.rootTs,
    });
    await postSlack(
      this.h,
      appMentionRequest({
        signingSecret: SIGNING_SECRET,
        channel: this.channel,
        user,
        text,
        ts: message.ts,
        threadTs: this.rootTs,
      }),
    );
  }

  // A plain reply in the thread that does not tag Sym, as a person talking to the thread.
  async say(text: string, user = OWNER): Promise<FakeSlackMessage> {
    const message = this.h.slack.addMessage({
      channel: this.channel,
      user,
      text,
      thread_ts: this.rootTs,
    });
    await postSlack(
      this.h,
      channelMessageRequest({
        signingSecret: SIGNING_SECRET,
        channel: this.channel,
        user,
        text,
        ts: message.ts,
        threadTs: this.rootTs,
      }),
    );
    return message;
  }

  // Messages in this thread (root excluded), in post order.
  messages(): FakeSlackMessage[] {
    return this.h.slack.messages.filter(
      (m) => m.channel === this.channel && m.thread_ts === this.rootTs,
    );
  }

  botMessages(): FakeSlackMessage[] {
    return this.messages().filter((m) => m.user === BOT);
  }

  // Waits for an Eve input request (HITL controls) in this thread whose text matches.
  async waitForControls(match: RegExp, timeoutMs = 60_000): Promise<HitlMessage> {
    return until(
      () => {
        for (const message of this.botMessages()) {
          const controls = hitlControls(message.blocks ?? []);
          if (controls.length > 0 && match.test(messageText(message))) {
            return { message, controls };
          }
        }
        return undefined;
      },
      { timeoutMs, label: `Slack controls matching ${match}` },
    );
  }

  // Waits for a bot message in this thread whose text matches, with or without controls.
  async waitForPrompt(match: RegExp, timeoutMs = 60_000): Promise<FakeSlackMessage> {
    return until(() => this.botMessages().find((m) => match.test(messageText(m))), {
      timeoutMs,
      label: `Slack message matching ${match}`,
    });
  }

  // Clicks the control whose option value or label matches `choice`.
  async click(hitl: HitlMessage, choice: string, user = OWNER): Promise<void> {
    const control = hitl.controls.find((c) => c.label === choice || c.value === choice);
    if (!control) {
      throw new Error(
        `no control ${choice} in ${JSON.stringify(hitl.controls.map((c) => c.label))}`,
      );
    }
    await postSlack(
      this.h,
      blockActionsRequest({
        signingSecret: SIGNING_SECRET,
        channel: this.channel,
        user,
        messageTs: hitl.message.ts,
        threadTs: this.rootTs,
        actionId: control.actionId,
        actionType: control.type,
        ...(control.value === undefined
          ? {}
          : control.selected
            ? { selectedOptionValue: control.value }
            : { value: control.value }),
      }),
    );
  }
}

async function postSlack(h: Harness, parts: SlackRequestParts): Promise<void> {
  const response = await fetch(`${h.eveUrl()}/eve/v1/slack`, {
    method: "POST",
    headers: parts.headers,
    body: parts.body,
  });
  if (!response.ok) {
    throw new Error(`Slack route answered ${response.status}: ${await response.text()}`);
  }
}

export interface HitlControl {
  actionId: string;
  type: string;
  label: string;
  value: string | undefined;
  // True for radio buttons and selects, which send `selected_option.value`.
  selected: boolean;
}

export interface HitlMessage {
  message: FakeSlackMessage;
  controls: HitlControl[];
}

// Every Eve-owned answer control in a message's blocks, one entry per choice.
export function hitlControls(blocks: unknown[]): HitlControl[] {
  const found: HitlControl[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const element = node as Record<string, unknown>;
    const actionId = element.action_id;
    if (typeof actionId === "string" && actionId.startsWith("eve_input:")) {
      const type = String(element.type ?? "button");
      if (Array.isArray(element.options)) {
        for (const option of element.options as Record<string, unknown>[]) {
          found.push({
            actionId,
            type,
            label: plain(option.text),
            value: option.value as string | undefined,
            selected: true,
          });
        }
      } else {
        found.push({
          actionId,
          type,
          label: plain(element.text),
          value: element.value as string | undefined,
          selected: false,
        });
      }
      return;
    }
    for (const value of Object.values(element)) visit(value);
  };
  visit(blocks);
  return found;
}

function plain(text: unknown): string {
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && "text" in text) return String(text.text);
  return "";
}

// The text a person reads: the fallback text plus every text field in the blocks.
export function messageText(message: FakeSlackMessage): string {
  const parts: string[] = [message.text ?? "", message.markdown_text ?? ""];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "text" && typeof value === "string") parts.push(value);
      else visit(value);
    }
  };
  visit(message.blocks ?? []);
  return parts.join("\n");
}

// The worker agent's side. It reads the callback URL Sym put in the launch message, adds steps to
// the thread, and calls back, like a real worker agent finishing its turn.
export function callbackUrl(thread: FakeT3Thread): string {
  const message = String(thread.launch.message ?? "");
  const match = /curl -fsS -X POST '([^']+)'/.exec(message);
  if (!match?.[1]) throw new Error(`no callback URL in the launch message:\n${message}`);
  return match[1];
}

// SYM_CALLBACK_URL makes Sym hand the worker a URL on the server's real address, so the worker
// calls exactly the URL in its brief.
export async function workerAdvance(
  h: Harness,
  thread: FakeT3Thread,
  steps: FakeT3Step[],
  options: { callBack?: boolean } = {},
): Promise<void> {
  thread.steps.push(...steps);
  if (options.callBack === false) return;
  const given = new URL(callbackUrl(thread));
  if (given.origin !== new URL(h.eveUrl()).origin) {
    throw new Error(`the callback URL ${given.origin} is not the server ${h.eveUrl()}`);
  }
  const response = await fetch(given, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job: thread.title.slice(1, thread.title.indexOf("]")) }),
  });
  if (!response.ok) throw new Error(`callback answered ${response.status}`);
}

export function contractMessage(contract: Record<string, unknown>): string {
  return `All done.\n\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``;
}

export const SAMPLE_CONTRACT = {
  summary: "Added retry with exponential backoff to the sync.",
  pr_url: "https://github.com/example/test-repo/pull/7",
  tests: "12 passed",
  files_changed: ["src/sync.ts", "test/sync.test.ts"],
  open_questions: [],
};

// The worker's last step: it completes with the output contract block.
export function finishedSteps(): FakeT3Step[] {
  return [{ status: "completed", items: [contractMessage(SAMPLE_CONTRACT)] }];
}

let channelCount = 0;

// A fresh channel, so each scenario reads only its own messages.
export function newConversation(h: Harness): Conversation {
  channelCount++;
  return new Conversation(h, `C0E2E${channelCount}`);
}

export function briefMention(title: string, extra: Record<string, unknown> = {}): string {
  const brief = {
    project: "test-repo",
    title,
    goal: "Add retry with backoff to the sync.",
    doneWhen: ["Retries use backoff", "Tests pass"],
    openPullRequest: true,
    estimatedMinutes: 15,
    ...extra,
  };
  return `<@${BOT}> please do this\n\`\`\`brief\n${JSON.stringify(brief)}\n\`\`\``;
}

// Mentions Sym with a brief and waits for Eve's approval prompt and the job row.
export async function startJob(h: Harness, c: Conversation, title: string) {
  await c.mention(briefMention(title));
  const approval = await c.waitForControls(/Start J-\d+:/);
  const job = await jobInThread(h.sql, c.channel, c.rootTs);
  return { approval, job, ref: jobRef(job.id) };
}

export function launchesOf(h: Harness, ref: string) {
  return h.t3.calls.filter(
    (call) => call.name === "t3_thread_launch" && String(call.args.title).startsWith(`[${ref}]`),
  );
}

export function threadsOf(h: Harness, ref: string): FakeT3Thread[] {
  return [...h.t3.threads.values()].filter((thread) => thread.title.startsWith(`[${ref}]`));
}

// A live job card: Sym's message with a plan block.
export function isCard(message: FakeSlackMessage): boolean {
  return (message.blocks ?? []).some((block) => (block as { type?: string }).type === "plan");
}

export async function resultMessage(c: Conversation, ref: string): Promise<FakeSlackMessage> {
  // The result headline is "<status emoji> *J-3 · title* · 1m"; the job card has no emoji prefix.
  const headline = new RegExp(`^(✅|⚠️) \\*${ref} · `);
  return until(() => c.botMessages().find((m) => headline.test(m.text ?? "")), {
    label: `${ref} result message`,
  });
}

// Waits until Slack sees no new calls for a few seconds, so late posts would show up.
export async function settle(h: Harness, quietMs = 3_000): Promise<void> {
  let count = -1;
  await until(
    async () => {
      const now = h.slack.calls.length;
      if (now === count) return true;
      count = now;
      await new Promise((r) => setTimeout(r, quietMs));
      return h.slack.calls.length === count ? true : undefined;
    },
    { label: "Slack to go quiet", timeoutMs: 60_000, intervalMs: 0 },
  );
}

export async function jobInThread(sql: Sql, channel: string, threadTs: string) {
  return until(
    async () => {
      const [row] = await sql<Job[]>`
        select * from jobs where slack_channel = ${channel} and slack_thread_ts = ${threadTs}
        order by id desc limit 1
      `;
      return row ? { ...row, id: Number(row.id) } : undefined;
    },
    { timeoutMs: 30_000, label: `job in thread ${threadTs}` },
  );
}

export async function waitForJobStatus(sql: Sql, id: number, status: string, timeoutMs = 60_000) {
  return until(
    async () => {
      const [row] = await sql<Job[]>`select * from jobs where id = ${id}`;
      return row?.status === status ? { ...row, id: Number(row.id) } : undefined;
    },
    { timeoutMs, label: `${jobRef(id)} status ${status}` },
  );
}

export async function until<T>(
  check: () => T | undefined | Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label: string },
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith("eve dev exited")) throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${options.label}${lastError ? `: ${String(lastError)}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 200));
  }
}

// A copy of the app without `.env.local` or `.eve` state. node_modules is linked.
function copyApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sym-e2e-"));
  for (const entry of ["agent", "lib", "package.json", "tsconfig.json"]) {
    cpSync(join(REPO, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  return dir;
}

async function freshDatabase(name: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad database name ${name}`);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

// `eve dev` starts its server in a child with its own process group, so this walks the whole
// tree: TERM first, KILL what is left.
async function killTree(root: number): Promise<void> {
  const tree = descendants(root);
  for (const pid of tree) signal(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && tree.some(alive)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of tree) if (alive(pid)) signal(pid, "SIGKILL");
}

function descendants(root: number): number[] {
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
  const found = [root];
  for (let i = 0; i < found.length; i++) {
    for (const [pid, ppid] of table) if (ppid === found[i] && !found.includes(pid)) found.push(pid);
  }
  return found;
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
