import type {
  Activity,
  ActivityItem,
  LaunchRequest,
  WaitResult,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerProject,
  WorkerStatus,
  WorkerThread,
} from "../../lib/workers/types.ts";

// One step of a scripted worker run. Each `wait` call moves a thread to its next step.
export interface FakeStep {
  status: WorkerStatus;
  items?: string[];
  pendingRequests?: number;
}

interface FakeThread {
  thread: WorkerThread;
  projectId: string;
  request: LaunchRequest;
  items: ActivityItem[];
  steps: FakeStep[];
  pendingRequests: number;
}

export interface FakeWorkerOptions {
  projects?: WorkerProject[];
  // The run every launched thread follows.
  script?: FakeStep[];
  // The next launch creates the thread but throws, like a lost launch response.
  loseNextLaunchResponse?: boolean;
}

// Thread IDs stay unique across fake workers, like real worker thread IDs.
let nextThread = 1;

// An in-memory worker for tests. Tests never call a real worker.
export class FakeWorker implements WorkerAdapter {
  readonly threads = new Map<string, FakeThread>();
  readonly interrupts: { threadId: string; requestId: string }[] = [];
  launches = 0;
  private loseNextLaunchResponse: boolean;
  private readonly options: FakeWorkerOptions;

  constructor(options: FakeWorkerOptions = {}) {
    this.options = options;
    this.loseNextLaunchResponse = options.loseNextLaunchResponse ?? false;
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return { providers: [{ id: "fake", name: "Fake", models: ["fake-model"], available: true }] };
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
    fake.pendingRequests = step.pendingRequests ?? 0;
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

  private get(threadId: string): FakeThread {
    const fake = this.threads.get(threadId);
    if (!fake) throw new Error(`fake: no thread ${threadId}`);
    return fake;
  }
}
