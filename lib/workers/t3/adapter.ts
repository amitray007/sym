import { z } from "zod";
import type {
  Activity,
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
} from "../types.ts";

// Calls one T3 MCP tool and returns its structured result. `connectT3` provides the real one.
// Tests pass a fake, so they never reach a real worker.
export type CallTool = (
  name: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

// T3 results carry more fields than Sym reads. Zod objects drop unknown keys, so a T3 upgrade
// that adds fields does not break the adapter.
const Capabilities = z.object({
  providers: z.array(
    z.object({
      providerInstanceId: z.string(),
      displayName: z.string(),
      models: z.array(z.object({ id: z.string() })),
      constraints: z.array(z.string()).default([]),
    }),
  ),
});

const ProjectPage = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      workspaceRoot: z.string(),
      deletedAt: z.string().nullable().optional(),
    }),
  ),
  nextCursor: z.number().int().nullable(),
});

const Thread = z.object({ threadId: z.string(), title: z.string(), status: z.string() });

const ThreadPage = z.object({ threads: z.array(Thread) });

const Launched = z.object({ threadId: z.string(), status: z.string() });

const Waited = z.object({ status: z.string(), timedOut: z.boolean() });

const ThreadRead = z.object({
  thread: z.object({ status: z.string(), pendingRequestCount: z.number().int().default(0) }),
  items: z.array(
    z.object({
      position: z.number().int(),
      type: z.string(),
      text: z.string().nullable().default(""),
    }),
  ),
  nextPosition: z.number().int().nullable(),
  hasMore: z.boolean().default(false),
});

// `t3_pending_request_list` returns IDs only and leaves out approval requests. The questions come
// from `t3_pending_request_read`.
const PendingIds = z.object({ requestIds: z.array(z.string()) });

const PendingRequest = z.object({
  requestId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string().optional(),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
      multiSelect: z.boolean().default(false),
    }),
  ),
});

// `watch_pull_request` links the pull request first when needed (T3 PullRequestsToolkit.
// setWatching), so Sym needs no separate `link_pull_request` call.
const Watched = z.object({ watching: z.boolean(), wasWatching: z.boolean() });

// Stops a cursor loop if the worker keeps returning a cursor.
const MAX_PROJECT_PAGES = 50;

// A blocking call such as `t3_thread_wait` gets this much time beyond its own timeout, so the
// worker answers before the MCP request times out.
const REQUEST_MARGIN_MS = 15_000;

// Item text past this length stays on the worker. The job card needs a summary, not a transcript.
const MAX_ITEM_CHARS = 4000;

// T3 thread and run states, mapped to the shared worker states (docs/workers.md).
const STATUS: Record<string, WorkerStatus> = {
  preparing: "running",
  queued: "running",
  starting: "running",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  rolled_back: "failed",
  interrupted: "interrupted",
  cancelled: "interrupted",
};

export function toWorkerStatus(t3Status: string): WorkerStatus {
  // `idle` means the thread has no run. Step 4 checks what a finished launched thread reports.
  return STATUS[t3Status] ?? "unknown";
}

const toThread = (thread: z.infer<typeof Thread>): WorkerThread => ({
  id: thread.threadId,
  title: thread.title,
  status: toWorkerStatus(thread.status),
});

export interface T3AdapterOptions {
  // When the sign-in stops working: the stored sign-in, else `T3_TOKEN_EXPIRES_AT` (decision 036).
  signInExpiresAt?: Date | null;
}

export function t3Adapter(call: CallTool, options: T3AdapterOptions = {}): WorkerAdapter {
  return {
    async capabilities(): Promise<WorkerCapabilities> {
      const result = Capabilities.parse(await call("orchestrator_capabilities", {}));
      return {
        providers: result.providers.map((provider) => ({
          id: provider.providerInstanceId,
          name: provider.displayName,
          models: provider.models.map((model) => model.id),
          available: provider.constraints.length === 0 && provider.models.length > 0,
        })),
      };
    },

    async projects(): Promise<WorkerProject[]> {
      const projects: WorkerProject[] = [];
      let cursor: number | null = null;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const result = ProjectPage.parse(
          await call("t3_project_list", cursor === null ? { limit: 100 } : { limit: 100, cursor }),
        );
        for (const project of result.projects) {
          if (project.deletedAt) continue;
          projects.push({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          });
        }
        if (result.nextCursor === null) return projects;
        cursor = result.nextCursor;
      }
      throw new Error(`t3_project_list returned more than ${MAX_PROJECT_PAGES} pages`);
    },

    async findByTitle(projectId, titlePrefix) {
      const result = ThreadPage.parse(
        await call("t3_thread_list", { projectId, titleContains: titlePrefix, limit: 10 }),
      );
      // A prefix match, so a job title that mentions another job cannot match that job.
      const match = result.threads.find((thread) => thread.title.startsWith(titlePrefix));
      return match && toThread(match);
    },

    async launch(request: LaunchRequest): Promise<WorkerThread> {
      const result = Launched.parse(
        await call("t3_thread_launch", {
          projectId: request.projectId,
          title: request.title,
          message: request.message,
          workspaceStrategy: {
            type: "worktree",
            baseRef: request.baseRef,
            startFromOrigin: true,
            ...(request.branch ? { branch: request.branch } : {}),
          },
          ...(request.model
            ? {
                modelSelection: {
                  instanceId: request.model.providerId,
                  model: request.model.model,
                },
              }
            : {}),
        }),
      );
      return {
        id: result.threadId,
        title: request.title,
        status: toWorkerStatus(result.status),
      };
    },

    async wait(threadId, timeoutMs): Promise<WaitResult> {
      const result = Waited.parse(
        await call(
          "t3_thread_wait",
          { threadId, timeoutMs },
          { timeoutMs: timeoutMs + REQUEST_MARGIN_MS },
        ),
      );
      return { status: toWorkerStatus(result.status), timedOut: result.timedOut };
    },

    async readActivity(threadId, cursor): Promise<Activity> {
      const result = ThreadRead.parse(
        await call("t3_thread_read", {
          threadId,
          view: "activity",
          limit: 100,
          maxCharsPerItem: MAX_ITEM_CHARS,
          ...(cursor === null ? {} : { afterPosition: Number(cursor) }),
        }),
      );
      return {
        status: toWorkerStatus(result.thread.status),
        items: result.items.map((item) => ({
          position: item.position,
          type: item.type,
          text: item.text ?? "",
        })),
        cursor: result.nextPosition === null ? cursor : String(result.nextPosition),
        pendingRequests: result.thread.pendingRequestCount,
        hasMore: result.hasMore,
      };
    },

    async interrupt(threadId, reason, requestId) {
      await call("t3_thread_interrupt", { threadId, reason, clientRequestId: requestId });
    },

    async pendingQuestions(threadId): Promise<WorkerQuestion[]> {
      const { requestIds } = PendingIds.parse(await call("t3_pending_request_list", { threadId }));
      const found: WorkerQuestion[] = [];
      for (const requestId of requestIds) {
        // A request can resolve between the list and the read. T3 then fails the read; skip it,
        // because it is no longer a question.
        const read = await call("t3_pending_request_read", { threadId, requestId }).catch(
          () => undefined,
        );
        if (read === undefined) continue;
        const request = PendingRequest.parse(read);
        found.push({
          requestId: request.requestId,
          questions: request.questions.map((question) => ({
            id: question.id,
            ...(question.header ? { header: question.header } : {}),
            prompt: question.question,
            options: question.options.map((option) => ({
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
            multiSelect: question.multiSelect,
          })),
        });
      }
      return found;
    },

    async answer(threadId, requestId, answers: WorkerAnswers) {
      // T3 has no retry key here. A second answer to the same request fails with "not found".
      await call("t3_pending_request_respond", { threadId, requestId, answers });
    },

    async send(threadId, text, mode: SendMode, requestId) {
      await call("t3_thread_send", {
        threadId,
        message: text,
        mode,
        clientRequestId: requestId,
      });
    },

    async watchPullRequest(threadId, prUrl): Promise<PullRequestWatch> {
      // T3 refuses a read-only client, a merged pull request, and a subagent thread. The error
      // text reaches the caller.
      const result = Watched.parse(await call("watch_pull_request", { threadId, url: prUrl }));
      return { watching: result.watching, alreadyWatching: result.wasWatching };
    },

    async health(): Promise<WorkerHealth> {
      const signInExpiresAt = options.signInExpiresAt ?? null;
      try {
        await call("orchestrator_capabilities", {});
        return { reachable: true, signedIn: true, signInExpiresAt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A 401 means the worker answered and refused the token.
        if (/\b401\b|unauthori[sz]ed/i.test(message)) {
          return { reachable: true, signedIn: false, signInExpiresAt };
        }
        return { reachable: false, signedIn: false, signInExpiresAt };
      }
    },
  };
}
