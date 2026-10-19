// The worker adapter contract (docs/workers.md). The `t3_job` tool and reconcile call only these
// operations, so another worker can replace T3 Code without changes to the ledger or the loop.
// Later steps add questions, steering, and interrupts.

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

export interface WorkerProvider {
  id: string;
  name: string;
  models: string[];
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
  model?: { providerId: string; model: string };
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
}
