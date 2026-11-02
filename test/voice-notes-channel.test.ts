import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import { presentBrief } from "../lib/jobs/present.ts";
import type { JobDeps } from "../lib/jobs/run.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import type { Audio, TranscriptionRoute } from "../lib/voice/route.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { wavBytes } from "./helpers/audio.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

// Voice notes through the Slack channel's own handlers (decision 092): only an allowed person's
// audio in a message meant for Sym is transcribed, and a transcript never clicks Start.

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  deps: undefined as JobDeps | undefined,
  route: undefined as TranscriptionRoute | undefined,
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  pack: () => undefined,
  slackFromEnv: () => runtime.deps?.slack,
  withJobDeps: (fn: (deps: JobDeps) => unknown) => {
    if (!runtime.deps) throw new Error("Missing test dependencies");
    return fn(runtime.deps);
  },
}));
vi.mock("../lib/voice/route.ts", () => ({ transcriptionRoute: () => runtime.route }));
vi.mock("eve/channels/slack", async (original) => ({
  ...(await original<object>()),
  slackChannel: (config: unknown) => config,
}));

import channelDefinition from "../agent/channels/slack.ts";

// biome-ignore lint/suspicious/noExplicitAny: invoke the registered channel handlers with a focused Slack context
const channel = channelDefinition as any;

describe.skipIf(!hasDatabase)("voice notes in the Slack channel handlers", () => {
  const ledger = useLedger();
  afterEach(() => vi.unstubAllEnvs());

  async function setup(key: string, options: { people?: string[]; partner?: string } = {}) {
    runtime.sql = ledger.sql();
    vi.stubEnv("SYM_SLACK_USERS", "U1,U2");
    vi.stubEnv("SYM_STRANGER_REPLIES", "off");
    const wav = wavBytes();
    const download = vi.fn(async () => wav);
    const slack: SlackApi = {
      call: vi.fn(async (_method: string, body: Record<string, unknown>) => ({
        ok: true,
        ts: body.ts ?? "2.0",
      })),
      download,
    };
    runtime.deps = {
      sql: runtime.sql,
      slack,
      worker: new FakeWorker(),
      allowedProjects: TEST_PROJECTS,
    };
    const heard: Audio[] = [];
    const transcript = { text: "please look at the failing build" };
    runtime.route = {
      name: "gateway",
      model: "fake/transcribe",
      async transcribe(audio) {
        heard.push(audio);
        return transcript.text;
      },
    };
    await recordSessionThread(runtime.sql, {
      sessionId: key,
      channelId: "C1",
      threadTs: key,
      teamId: "T1",
      userId: options.partner ?? "U1",
    });
    const messages = [{ ts: "2.0", user: "UBOT", botId: "bot", isMe: true, text: "Start?" }];
    const ctx = {
      isSubscribed: async () => true,
      isBotMentioned: () => false,
      slack: { channelId: "C1", threadTs: key, codeChannel: false, request: slack.call },
      thread: {
        recentMessages: messages,
        refresh: async () => {},
        listParticipants: async () => options.people ?? ["U1"],
      },
    };
    // A message with only a Slack audio clip, as Eve parses it.
    const voiceMessage = (by: string) => {
      const file = {
        id: "FCLIP1",
        name: "audio_message.wav",
        mimetype: "audio/wav",
        size: wav.byteLength,
        url_private: "https://files.slack.com/files-pri/T1-FCLIP1/audio_message.wav",
        subtype: "slack_audio",
        duration_ms: 3_000,
      };
      return {
        channelId: "C1",
        threadTs: key,
        ts: "3.0",
        text: "",
        author: { userId: by, isBot: false },
        attachments: [
          {
            id: file.id,
            type: "audio",
            name: file.name,
            mimeType: file.mimetype,
            size: file.size,
            url: file.url_private,
          },
        ],
        raw: { type: "message", user: by, files: [file] },
      };
    };
    return { ctx, voiceMessage, download, heard, transcript, wav, sql: runtime.sql };
  }

  it("transcribes an allowed person's clip in a thread meant for Sym", async () => {
    const s = await setup("solo");
    const result = await channel.onMessage(s.ctx, s.voiceMessage("U1"));
    expect(s.download).toHaveBeenCalledOnce();
    expect(s.heard[0]?.bytes).toEqual(s.wav);
    expect(result.context.at(-1)).toContain(
      "<voice_transcript>\nplease look at the failing build\n</voice_transcript>",
    );
  });

  it("does not transcribe audio from a person off the allow-list", async () => {
    const s = await setup("stranger");
    expect(await channel.onAppMention(s.ctx, s.voiceMessage("U9"))).toBeNull();
    expect(await channel.onDirectMessage(s.ctx, s.voiceMessage("U9"))).toBeNull();
    expect(await channel.onMessage(s.ctx, s.voiceMessage("U9"))).toBeNull();
    expect(s.download).not.toHaveBeenCalled();
    expect(s.heard).toHaveLength(0);
  });

  it("does not transcribe audio in a shared thread when the message is not meant for Sym", async () => {
    // U1 and U2 share the thread, Sym last served U2, and the clip carries no tag.
    const s = await setup("shared", { people: ["U1", "U2"], partner: "U2" });
    expect(await channel.onMessage(s.ctx, s.voiceMessage("U1"))).toBeNull();
    expect(s.download).not.toHaveBeenCalled();
    expect(s.heard).toHaveLength(0);
  });

  it("does not transcribe audio in a top-level channel message, the trigger path", async () => {
    const s = await setup("top-level");
    const message = { ...s.voiceMessage("U1"), threadTs: "3.0", ts: "3.0" };
    expect(await channel.onMessage({ ...s.ctx, send: vi.fn() }, message)).toBeNull();
    expect(s.download).not.toHaveBeenCalled();
    expect(s.heard).toHaveLength(0);
  });

  it("does not let a spoken yes click Start on a pending brief", async () => {
    const s = await setup("spoken-yes");
    const job = await createJob(s.sql, {
      requestKey: "spoken-yes",
      sessionId: "spoken-yes",
      kind: "code-change",
      title: "Retry",
      brief: {
        project: "test-repo",
        title: "Retry",
        goal: "add retries",
        constraints: [],
        doneWhen: ["Test"],
        estimatedMinutes: 5,
        openPullRequest: false,
      },
      worker: "fake",
      owner: "U1",
      slackChannel: "C1",
      slackThreadTs: "spoken-yes",
    });
    await presentBrief(s.sql, job);
    await s.sql`update job_proposals set message_ts = '2.0' where job_id = ${job.id}`;
    s.transcript.text = "yes";
    const result = await channel.onMessage(s.ctx, s.voiceMessage("U1"));
    // The turn reaches the brain with the transcript, and the proposal stays pending.
    expect(result.context.at(-1)).toContain("<voice_transcript>\nyes\n</voice_transcript>");
    const [proposal] = await s.sql`select status from job_proposals where job_id = ${job.id}`;
    expect(proposal?.status).toBe("pending");
    // Control: the same person's typed yes in the same place does approve.
    await channel.onMessage(s.ctx, { ...s.voiceMessage("U1"), text: "yes", attachments: [] });
    const [typed] = await s.sql`select status from job_proposals where job_id = ${job.id}`;
    expect(typed?.status).toBe("approved");
  });
});
