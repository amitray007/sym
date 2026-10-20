// The worker adapter contract (docs/workers.md). The `worker_job` tool and reconcile call only these
// operations, so another worker can replace T3 Code without changes to the ledger or the loop.

// Every adapter maps its worker's states to these.
export type WorkerStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export interface WorkerProject {
  id: string;
  title: string;
  workspaceRoot: string;
}

// A select option of a model, with the value IDs it accepts.
export interface WorkerSelectOption {
  id: string;
  values: string[];
}

export interface WorkerProvider {
  id: string;
  name: string;
  models: string[];
  // Per model ID, the select options the worker offers, such as reasoning effort.
  modelOptions?: Record<string, WorkerSelectOption[]>;
  // False when the worker reports a constraint, for example a disabled provider.
  available: boolean;
}

export interface WorkerCapabilities {
  providers: WorkerProvider[];
}

export interface WorkerThread {
  id: string;
  title: string;
  status: WorkerStatus;
}

export interface LaunchRequest {
  projectId: string;
  // Holds the job reference, for example `[J-142] Billing sync retry`, so `findByTitle` can
  // find the thread after a lost launch response.
  title: string;
  // The brief, the output contract, and the callback URL.
  message: string;
  // The branch the new worktree starts from.
  baseRef: string;
  branch?: string;
  // Options are `{ id, value }` pairs such as the reasoning effort.
  model?: { providerId: string; model: string; options?: { id: string; value: string }[] };
}

export interface WaitResult {
  status: WorkerStatus;
  timedOut: boolean;
}

export interface ActivityItem {
  position: number;
  // The worker's item type, for example `assistant_message` or `tool_call`.
  type: string;
  text: string;
}

export interface Activity {
  status: WorkerStatus;
  items: ActivityItem[];
  // Pass back to read only newer items. The ledger stores it on the job row.
  cursor: string | null;
  // Questions or permission prompts that wait for a person.
  pendingRequests: number;
  // More items wait after `cursor`. Read again to get them.
  hasMore: boolean;
}

// A question the worker agent asked and waits on. One worker request can hold several questions.
export interface WorkerQuestion {
  requestId: string;
  questions: {
    id: string;
    header?: string;
    prompt: string;
    options: { label: string; description?: string }[];
    multiSelect: boolean;
  }[];
}

// Answers keyed by question ID. Each answer is the chosen option labels or free text.
export type WorkerAnswers = Record<string, string | string[]>;

export interface WorkerHealth {
  // The worker answered a call.
  reachable: boolean;
  // The worker accepted Sym's sign-in. False after a 401.
  signedIn: boolean;
  // When the sign-in stops working, if Sym knows it: from the stored sign-in, else
  // `T3_TOKEN_EXPIRES_AT`.
  signInExpiresAt: Date | null;
}

export interface PullRequestWatch {
  // The worker now watches the pull request.
  watching: boolean;
  alreadyWatching: boolean;
}

export type SendMode = "auto" | "queue" | "steer";

export interface WorkerAdapter {
  capabilities(): Promise<WorkerCapabilities>;
  projects(): Promise<WorkerProject[]>;
  // Finds the thread whose title starts with `titlePrefix`, such as `[J-142]`.
  findByTitle(projectId: string, titlePrefix: string): Promise<WorkerThread | undefined>;
  // No retry key on T3: call `findByTitle` first, and never retry a launch blindly.
  launch(request: LaunchRequest): Promise<WorkerThread>;
  // Keep the timeout short (1 to 5 minutes) so HTTP calls do not time out.
  wait(threadId: string, timeoutMs: number): Promise<WaitResult>;
  readActivity(threadId: string, cursor: string | null): Promise<Activity>;
  // Stops the thread's running turn. `requestId` makes a retry safe.
  interrupt(threadId: string, reason: string, requestId: string): Promise<void>;
  // Questions the worker agent asked. Permission prompts are not questions and never appear here.
  pendingQuestions(threadId: string): Promise<WorkerQuestion[]>;
  answer(threadId: string, requestId: string, answers: WorkerAnswers): Promise<void>;
  // Steers or queues a message to the thread. `requestId` makes a retry safe.
  send(threadId: string, text: string, mode: SendMode, requestId: string): Promise<void>;
  // Optional: a worker without pull request wakes leaves it out. Links the pull request to the
  // thread and asks the worker to watch it, so the worker agent wakes on CI failures and review
  // comments. A repeat call is safe on T3. `requestId` is for adapters that need a retry key.
  watchPullRequest?(threadId: string, prUrl: string, requestId: string): Promise<PullRequestWatch>;
  // Optional: reachability and sign-in state, for the sign-in expiry notice.
  health?(): Promise<WorkerHealth>;
}
