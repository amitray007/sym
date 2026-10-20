import type {
  Activity,
  ActivityItem,
  LaunchRequest,
  PullRequestWatch,
  SendMode,
  WaitResult,
  WorkerAdapter,
  WorkerAnswers,
  WorkerCapabilities,
  WorkerHealth,
  WorkerProject,
  WorkerQuestion,
  WorkerStatus,
  WorkerThread,
} from "../../lib/workers/types.ts";

// One step of a scripted worker run. Each `wait` call moves a thread to its next step.
export interface FakeStep {
  status: WorkerStatus;
  items?: string[];
  pendingRequests?: number;
  // Questions the worker waits on in this step. They also count as pending requests.
  questions?: WorkerQuestion[];
}

interface FakeThread {
  thread: WorkerThread;
  projectId: string;
  request: LaunchRequest;
  items: ActivityItem[];
  steps: FakeStep[];
  pendingRequests: number;
  questions: WorkerQuestion[];
}

export interface FakeWorkerOptions {
  projects?: WorkerProject[];
  // The run every launched thread follows.
  script?: FakeStep[];
  // The next launch creates the thread but throws, like a lost launch response.
  loseNextLaunchResponse?: boolean;
  // What `capabilities` reports. Defaults: fake, claudeAgent, and codex, all available.
  capabilities?: WorkerCapabilities;
  // What `health` reports. Defaults: reachable, signed in, no known expiry.
  health?: WorkerHealth;
}

// Thread IDs stay unique across fake workers, like real worker thread IDs.
let nextThread = 1;

// An in-memory worker for tests. Tests never call a real worker.
export class FakeWorker implements WorkerAdapter {
  readonly threads = new Map<string, FakeThread>();
  readonly interrupts: { threadId: string; requestId: string }[] = [];
  readonly answers: { threadId: string; requestId: string; answers: WorkerAnswers }[] = [];
  readonly sends: { threadId: string; text: string; mode: SendMode; requestId: string }[] = [];
  readonly watches: { threadId: string; prUrl: string; requestId: string }[] = [];
  // Set to make `watchPullRequest` fail, like T3 refusing to watch a merged pull request.
  watchError: string | undefined;
  launches = 0;
  private loseNextLaunchResponse: boolean;
  private readonly options: FakeWorkerOptions;

  constructor(options: FakeWorkerOptions = {}) {
    this.options = options;
    this.loseNextLaunchResponse = options.loseNextLaunchResponse ?? false;
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return (
      this.options.capabilities ?? {
        providers: [
          { id: "fake", name: "Fake", models: ["fake-model"], available: true },
          {
            id: "claudeAgent",
            name: "Claude",
            models: ["claude-sonnet-5-5", "claude-opus-5-5"],
            modelOptions: {
              "claude-sonnet-5-5": [{ id: "effort", values: ["low", "medium", "high"] }],
              "claude-opus-5-5": [{ id: "effort", values: ["low", "medium", "high"] }],
            },
            available: true,
          },
          {
            id: "codex",
            name: "Codex",
            models: ["gpt-6-luna", "gpt-6.1-sol"],
            modelOptions: {
              "gpt-6-luna": [{ id: "reasoningEffort", values: ["low", "medium", "high"] }],
              "gpt-6.1-sol": [{ id: "reasoningEffort", values: ["low", "medium", "high"] }],
            },
            available: true,
          },
        ],
      }
    );
  }

  async projects(): Promise<WorkerProject[]> {
    return this.options.projects ?? [{ id: "project-1", title: "test-repo", workspaceRoot: "/r" }];
  }

  async findByTitle(projectId: string, titlePrefix: string) {
    for (const fake of this.threads.values()) {
      if (fake.projectId === projectId && fake.thread.title.startsWith(titlePrefix)) {
        return { ...fake.thread };
      }
    }
    return undefined;
  }

  async launch(request: LaunchRequest): Promise<WorkerThread> {
    this.launches++;
    const thread: WorkerThread = {
      id: `thread-${nextThread++}`,
      title: request.title,
      status: "running",
    };
    this.threads.set(thread.id, {
      thread,
      projectId: request.projectId,
      request,
      items: [],
      steps: [...(this.options.script ?? [{ status: "completed", items: ["Done"] }])],
      pendingRequests: 0,
      questions: [],
    });
    if (this.loseNextLaunchResponse) {
      this.loseNextLaunchResponse = false;
      throw new Error("fake: launch response lost");
    }
    return { ...thread };
  }

  async wait(threadId: string, _timeoutMs: number): Promise<WaitResult> {
    const fake = this.get(threadId);
    const step = fake.steps.shift();
    if (!step) return { status: fake.thread.status, timedOut: false };
    fake.thread.status = step.status;
    fake.questions = [...(step.questions ?? [])];
    fake.pendingRequests = step.pendingRequests ?? fake.questions.length;
    for (const text of step.items ?? []) {
      fake.items.push({ position: fake.items.length, type: "assistant_message", text });
    }
    return { status: step.status, timedOut: step.status === "running" };
  }

  async readActivity(threadId: string, cursor: string | null): Promise<Activity> {
    const fake = this.get(threadId);
    const after = cursor === null ? -1 : Number(cursor);
    const items = fake.items.filter((item) => item.position > after);
    const last = fake.items.at(-1);
    return {
      status: fake.thread.status,
      items,
      cursor: last ? String(last.position) : cursor,
      pendingRequests: fake.pendingRequests,
      hasMore: false,
    };
  }

  async interrupt(threadId: string, _reason: string, requestId: string): Promise<void> {
    const fake = this.get(threadId);
    this.interrupts.push({ threadId, requestId });
    if (fake.thread.status === "running" || fake.thread.status === "waiting") {
      fake.thread.status = "interrupted";
    }
  }

  async pendingQuestions(threadId: string): Promise<WorkerQuestion[]> {
    return structuredClone(this.get(threadId).questions);
  }

  async answer(threadId: string, requestId: string, answers: WorkerAnswers): Promise<void> {
    const fake = this.get(threadId);
    const index = fake.questions.findIndex((question) => question.requestId === requestId);
    // Like T3, a request that is gone (answered already) fails.
    if (index < 0) throw new Error(`fake: no pending request ${requestId}`);
    fake.questions.splice(index, 1);
    fake.pendingRequests = Math.max(0, fake.pendingRequests - 1);
    this.answers.push({ threadId, requestId, answers });
  }

  async send(threadId: string, text: string, mode: SendMode, requestId: string): Promise<void> {
    this.get(threadId);
    this.sends.push({ threadId, text, mode, requestId });
  }

  async watchPullRequest(
    threadId: string,
    prUrl: string,
    requestId: string,
  ): Promise<PullRequestWatch> {
    this.get(threadId);
    if (this.watchError) throw new Error(this.watchError);
    const alreadyWatching = this.watches.some(
      (watch) => watch.threadId === threadId && watch.prUrl === prUrl,
    );
    this.watches.push({ threadId, prUrl, requestId });
    return { watching: true, alreadyWatching };
  }

  async health(): Promise<WorkerHealth> {
    return this.options.health ?? { reachable: true, signedIn: true, signInExpiresAt: null };
  }

  // Adds the item T3 puts in a thread when a watched pull request wakes the worker: a
  // `notification` whose text is the wake summary, for example `#12: checks failed`.
  addWake(threadId: string, summary: string): ActivityItem {
    const fake = this.get(threadId);
    const item: ActivityItem = { position: fake.items.length, type: "notification", text: summary };
    fake.items.push(item);
    return item;
  }

  private get(threadId: string): FakeThread {
    const fake = this.threads.get(threadId);
    if (!fake) throw new Error(`fake: no thread ${threadId}`);
    return fake;
  }
}
