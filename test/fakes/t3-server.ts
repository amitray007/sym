import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// An in-process fake of T3's MCP server over Streamable HTTP, for real-wire tests and the e2e
// runner. Result shapes follow T3's orchestrator MCP contract (packages/contracts/src/
// orchestratorMcp.ts, apps/server/src/mcp/toolkits/thread). It binds to 127.0.0.1 only.

// T3's thread statuses: `idle` plus the run statuses.
export type FakeT3Status =
  | "idle"
  | "preparing"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

// A user-input request as `t3_pending_request_read` returns it.
export interface FakeT3Request {
  requestId: string;
  questions: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description: string }[];
    multiSelect?: boolean;
  }[];
}

// One step of a thread's run. Each `t3_thread_wait` moves the thread to its next step.
export interface FakeT3Step {
  status: FakeT3Status;
  items?: string[];
  questions?: FakeT3Request[];
}

export interface FakeT3Item {
  position: number;
  type: string;
  text: string;
}

export interface FakeT3Thread {
  threadId: string;
  projectId: string;
  title: string;
  status: FakeT3Status;
  items: FakeT3Item[];
  steps: FakeT3Step[];
  questions: FakeT3Request[];
  answers: { requestId: string; answers: Record<string, unknown> }[];
  sends: { message: string; mode: string; clientRequestId: string | undefined }[];
  interrupts: { reason: string | undefined; clientRequestId: string | undefined }[];
  // Each t3_thread_organize action on the thread, such as "settle".
  organized: string[];
  launch: Record<string, unknown>;
  // Pull requests linked to the thread, and whether T3 watches each one.
  // The facts `list_thread_pull_requests` reports are optional, so a test sets only what it needs.
  pullRequests: {
    url: string;
    watching: boolean;
    state?: string;
    headBranch?: string;
    baseBranch?: string;
    isDraft?: boolean;
  }[];
}

export interface FakeT3Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface FakeT3Options {
  // The bearer token the server requires. Random by default.
  token?: string;
  projects?: FakeT3Project[];
  // The run every launched thread follows. Change it later with `setScript`.
  script?: FakeT3Step[];
  // Projects and threads per page, so tests can force cursor paging.
  pageSize?: number;
  // Seconds an OAuth token lasts. T3 gives 30 days.
  oauthTokenSeconds?: number;
}

// The OAuth sign-in as T3 runs it (decision 036): discovery, stateless registration, an
// authorization endpoint, and a token endpoint. The fake approves at once, as if the owner
// clicked Approve on the consent page, and redirects with `code`, `state`, and `iss`.
export interface FakeT3OAuth {
  // The OAuth issuer: the server origin.
  issuer: string;
  // Registered clients, by client ID.
  clients: Map<string, { redirectUris: string[] }>;
  // Tokens the token endpoint issued. The MCP endpoint accepts them like `token`.
  issued: string[];
  // MCP requests that carried an issued token.
  oauthCalls: number;
  // The next authorization redirect carries `error=access_denied`, like a refused consent.
  denyNext(): void;
  // The next authorization redirect carries this issuer instead of the real one.
  wrongIssuerNext(issuer: string): void;
}

export interface FakeT3 {
  url: string;
  token: string;
  threads: Map<string, FakeT3Thread>;
  // Every tool call the server received, in order.
  calls: { name: string; args: Record<string, unknown> }[];
  // Requests the server refused for a missing or wrong token.
  unauthorized: number;
  oauth: FakeT3OAuth;
  setScript(script: FakeT3Step[]): void;
  // Adds the item T3 shows when a watched pull request wakes the worker: a `notification` item
  // whose text is the summary (orchestration-v2/pullRequestWatch.ts), for example
  // `#12: checks failed`.
  addWake(threadId: string, summary: string): void;
  // The next `watch_pull_request` call fails with this message, like a merged pull request.
  failNextWatch(message: string): void;
  // The next call to `tool` runs, then the server drops the connection before it answers, like
  // a launch response lost on the network.
  dropNextResponse(tool: string): void;
  close(): Promise<void>;
}

// A model's reasoning effort option, in the shape of T3 `orchestrator_capabilities`.
const effortOption = (id: string) => ({
  id,
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
  currentValue: "medium",
});

const DEFAULT_SCRIPT: FakeT3Step[] = [{ status: "completed", items: ["Done"] }];

const TERMINAL = new Set<FakeT3Status>(["completed", "failed", "interrupted", "cancelled"]);

export async function startFakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  const token = options.token ?? `fake-t3-${Math.random().toString(36).slice(2)}`;
  const pageSize = options.pageSize ?? 100;
  const projects = options.projects ?? [
    { id: "project-1", title: "test-repo", workspaceRoot: "/repos/test-repo" },
  ];
  let script = options.script ?? DEFAULT_SCRIPT;
  let nextThread = 1;
  const drops: string[] = [];
  const watchFailures: string[] = [];
  const threads = new Map<string, FakeT3Thread>();
  const oauthTokenSeconds = options.oauthTokenSeconds ?? 30 * 86_400;
  let denyNext = false;
  let wrongIssuer: string | undefined;
  // Pending codes: one use each, like T3.
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource: string }
  >();
  const state: FakeT3 = {
    url: "",
    token,
    threads,
    calls: [],
    unauthorized: 0,
    oauth: {
      issuer: "",
      clients: new Map(),
      issued: [],
      oauthCalls: 0,
      denyNext: () => {
        denyNext = true;
      },
      wrongIssuerNext: (issuer) => {
        wrongIssuer = issuer;
      },
    },
    setScript: (next) => {
      script = next;
    },
    addWake: (threadId, summary) => {
      const thread = getThread(threadId);
      thread.items.push({ position: thread.items.length, type: "notification", text: summary });
    },
    failNextWatch: (message) => {
      watchFailures.push(message);
    },
    dropNextResponse: (tool) => {
      drops.push(tool);
    },
    close: async () => {},
  };

  const sendResults = new Map<string, unknown>();
  const interruptResults = new Map<string, unknown>();

  const getThread = (threadId: string): FakeT3Thread => {
    const thread = threads.get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} was not found.`);
    return thread;
  };

  function buildServer(): McpServer {
    const server = new McpServer({ name: "fake-t3", version: "0.0.0" });

    // Records the call and wraps the result like a T3 tool: structuredContent plus a JSON text.
    const tool = <Shape extends z.ZodRawShape>(
      name: string,
      shape: Shape,
      handler: (args: z.infer<z.ZodObject<Shape>>) => unknown,
    ) => {
      server.registerTool(name, { inputSchema: z.object(shape) }, async (args: unknown) => {
        state.calls.push({ name, args: { ...(args as Record<string, unknown>) } });
        try {
          const result = handler(args as z.infer<z.ZodObject<Shape>>) as Record<string, unknown>;
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
          };
        }
      });
    };

    tool("orchestrator_capabilities", {}, () => ({
      parentThreadId: null,
      providers: [
        {
          providerInstanceId: "fake",
          driverKind: "fake",
          displayName: "Fake",
          models: [{ id: "fake-model", label: "Fake model", options: [] }],
          constraints: [],
        },
        {
          providerInstanceId: "claudeAgent",
          driverKind: "claudeAgent",
          displayName: "Claude",
          models: ["claude-sonnet-5-5", "claude-opus-5-5"].map((id) => ({
            id,
            label: id,
            options: [effortOption("effort")],
          })),
          constraints: [],
        },
        {
          providerInstanceId: "codex",
          driverKind: "codex",
          displayName: "Codex",
          models: ["gpt-6-luna", "gpt-6.1-sol"].map((id) => ({
            id,
            label: id,
            options: [effortOption("reasoningEffort")],
          })),
          constraints: [],
        },
      ],
      features: { threadManagement: true },
    }));

    tool(
      "t3_project_list",
      { limit: z.number().int().optional(), cursor: z.number().int().optional() },
      ({ limit, cursor }) => {
        const start = cursor ?? 0;
        const end = start + Math.min(limit ?? pageSize, pageSize);
        return {
          projects: projects.slice(start, end).map((project) => ({
            ...project,
            scripts: [],
            deletedAt: null,
          })),
          nextCursor: end < projects.length ? end : null,
        };
      },
    );

    tool(
      "t3_thread_list",
      {
        projectId: z.string().optional(),
        titleContains: z.string().optional(),
        limit: z.number().int().optional(),
        cursor: z.number().int().optional(),
      },
      ({ projectId, titleContains, limit, cursor }) => {
        const matches = [...threads.values()].filter(
          (thread) =>
            (projectId === undefined || thread.projectId === projectId) &&
            (titleContains === undefined || thread.title.includes(titleContains)),
        );
        const start = cursor ?? 0;
        const end = start + Math.min(limit ?? pageSize, pageSize);
        return {
          projectId: projectId ?? projects[0]?.id ?? "",
          currentThreadId: null,
          threads: matches.slice(start, end).map((thread) => ({
            threadId: thread.threadId,
            title: thread.title,
            status: thread.status,
            itemCount: thread.items.length,
          })),
          nextCursor: end < matches.length ? end : null,
          total: matches.length,
        };
      },
    );

    tool(
      "t3_thread_launch",
      {
        projectId: z.string(),
        title: z.string().optional(),
        message: z.string(),
        workspaceStrategy: z.unknown().optional(),
        modelSelection: z.unknown().optional(),
      },
      (args) => {
        if (!projects.some((project) => project.id === args.projectId)) {
          throw new Error(`Project ${args.projectId} was not found.`);
        }
        const thread: FakeT3Thread = {
          threadId: `thread-${nextThread++}`,
          projectId: args.projectId,
          title: args.title ?? "Untitled",
          status: "preparing",
          items: [],
          steps: structuredClone(script),
          questions: [],
          answers: [],
          sends: [],
          interrupts: [],
          organized: [],
          launch: { ...args },
          pullRequests: [],
        };
        threads.set(thread.threadId, thread);
        return {
          threadId: thread.threadId,
          projectId: thread.projectId,
          runId: `run-${thread.threadId}`,
          status: thread.status,
        };
      },
    );

    tool(
      "t3_thread_wait",
      { threadId: z.string(), runId: z.string().optional(), timeoutMs: z.number().optional() },
      ({ threadId }) => {
        const thread = getThread(threadId);
        const step = thread.steps.shift();
        if (step) {
          thread.status = step.status;
          thread.questions = structuredClone(step.questions ?? []);
          for (const text of step.items ?? []) {
            thread.items.push({
              position: thread.items.length,
              type: "assistant_message",
              text,
            });
          }
        }
        return {
          threadId,
          runId: `run-${threadId}`,
          status: thread.status,
          // A run that is still going when the script ends or pauses looks like a wait timeout.
          timedOut: !TERMINAL.has(thread.status) && thread.status !== "waiting",
        };
      },
    );

    tool(
      "t3_thread_read",
      {
        threadId: z.string(),
        view: z.string().optional(),
        afterPosition: z.number().int().optional(),
        limit: z.number().int().optional(),
        maxCharsPerItem: z.number().int().optional(),
        itemId: z.string().optional(),
        textOffset: z.number().int().optional(),
      },
      ({ threadId, afterPosition, limit, maxCharsPerItem, itemId, textOffset }) => {
        const thread = getThread(threadId);
        // Like T3: text is cut at maxCharsPerItem, and itemId with textOffset reads the rest.
        const cut = (text: string, from: number) => {
          const end = maxCharsPerItem ? from + maxCharsPerItem : text.length;
          return {
            text: text.slice(from, end),
            textTruncated: end < text.length,
            nextTextOffset: end < text.length ? end : null,
          };
        };
        if (itemId !== undefined) {
          const item = thread.items.find((entry) => `item-${entry.position}` === itemId);
          if (!item) throw new Error(`no item ${itemId}`);
          return {
            thread: { threadId, status: thread.status, pendingRequestCount: 0 },
            items: [
              {
                position: item.position,
                itemId,
                type: item.type,
                ...cut(item.text, textOffset ?? 0),
              },
            ],
            nextPosition: item.position,
            hasMore: false,
          };
        }
        const after = afterPosition ?? -1;
        const pending = thread.items.filter((item) => item.position > after);
        const page = pending.slice(0, limit ?? 100);
        return {
          thread: {
            threadId,
            projectId: thread.projectId,
            title: thread.title,
            status: thread.status,
            pendingRequestCount: thread.questions.length,
            itemCount: thread.items.length,
          },
          recentRuns: [],
          items: page.map((item) => ({
            position: item.position,
            visibility: "local",
            type: item.type,
            status: "completed",
            title: null,
            itemId: `item-${item.position}`,
            ...cut(item.text, 0),
          })),
          nextPosition: page.at(-1)?.position ?? null,
          hasMore: pending.length > page.length,
        };
      },
    );

    tool(
      "t3_thread_interrupt",
      {
        threadId: z.string(),
        runId: z.string().optional(),
        reason: z.string().optional(),
        clientRequestId: z.string().optional(),
      },
      ({ threadId, reason, clientRequestId }) => {
        const thread = getThread(threadId);
        const key = clientRequestId && `${threadId}:${clientRequestId}`;
        const earlier = key ? interruptResults.get(key) : undefined;
        if (earlier) return earlier as Record<string, unknown>;
        thread.interrupts.push({ reason, clientRequestId });
        const running = !TERMINAL.has(thread.status) && thread.status !== "idle";
        if (running) thread.status = "interrupted";
        const result = {
          threadId,
          runId: `run-${threadId}`,
          status: running ? "interrupt_requested" : "not_running",
        };
        if (key) interruptResults.set(key, result);
        return result;
      },
    );

    tool("t3_pending_request_list", { threadId: z.string().optional() }, ({ threadId }) => ({
      requestIds: getThread(threadId ?? "").questions.map((request) => request.requestId),
    }));

    tool(
      "t3_pending_request_read",
      { threadId: z.string().optional(), requestId: z.string() },
      ({ threadId, requestId }) => {
        const request = getThread(threadId ?? "").questions.find(
          (candidate) => candidate.requestId === requestId,
        );
        if (!request) throw new Error("The pending user-input request was not found.");
        return request;
      },
    );

    tool(
      "t3_pending_request_respond",
      {
        threadId: z.string().optional(),
        requestId: z.string(),
        answers: z.record(z.string(), z.unknown()),
      },
      ({ threadId, requestId, answers }) => {
        const thread = getThread(threadId ?? "");
        const index = thread.questions.findIndex((request) => request.requestId === requestId);
        if (index < 0) throw new Error("The pending user-input request was not found.");
        thread.questions.splice(index, 1);
        thread.answers.push({ requestId, answers });
        // The agent continues once its question is answered.
        if (thread.questions.length === 0 && thread.status === "waiting") thread.status = "running";
        return { sequence: thread.answers.length };
      },
    );

    tool(
      "t3_thread_send",
      {
        threadId: z.string(),
        message: z.string(),
        mode: z.enum(["auto", "queue", "steer", "restart"]).optional(),
        clientRequestId: z.string().optional(),
      },
      ({ threadId, message, mode, clientRequestId }) => {
        const thread = getThread(threadId);
        const key = clientRequestId && `${threadId}:${clientRequestId}`;
        // T3 treats a repeated clientRequestId as the same send.
        const earlier = key ? sendResults.get(key) : undefined;
        if (earlier) return earlier as Record<string, unknown>;
        thread.sends.push({ message, mode: mode ?? "auto", clientRequestId });
        const active = !TERMINAL.has(thread.status) && thread.status !== "idle";
        const delivery = !active ? "started" : mode === "queue" ? "queued" : "steered";
        if (!active) thread.status = "running";
        const result = {
          threadId,
          messageId: `message-${thread.sends.length}`,
          runId: `run-${threadId}`,
          status: thread.status,
          delivery,
        };
        if (key) sendResults.set(key, result);
        return result;
      },
    );

    // Results follow apps/server/src/mcp/toolkits/pullRequests/tools.ts. A caller outside a
    // thread must pass threadId.
    const pullRequestTarget = {
      threadId: z.string().optional(),
      url: z.string().optional(),
      repository: z.string().optional(),
      number: z.number().int().optional(),
      host: z.string().optional(),
    };
    const identity = (url: string) => {
      const match = /^https?:\/\/([^/]+)\/(.+)\/pull\/(\d+)/.exec(url);
      if (!match) throw new Error("This is not a recognised pull request URL.");
      return { host: match[1], repository: match[2], number: Number(match[3]), url };
    };

    tool(
      "t3_thread_organize",
      { threadId: z.string(), action: z.string(), snoozedUntil: z.string().optional() },
      ({ threadId, action }) => {
        getThread(threadId).organized.push(action);
        return { threadId, action };
      },
    );

    tool("link_pull_request", pullRequestTarget, ({ threadId, url }) => {
      const thread = getThread(threadId ?? "");
      const target = identity(url ?? "");
      const alreadyLinked = thread.pullRequests.some((link) => link.url === target.url);
      if (!alreadyLinked) thread.pullRequests.push({ url: target.url, watching: false });
      return { ...target, alreadyLinked };
    });

    tool("list_thread_pull_requests", { threadId: z.string() }, ({ threadId }) => ({
      pullRequests: getThread(threadId).pullRequests.map((link) => {
        const target = identity(link.url);
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          url: link.url,
          source: "agent",
          watching: link.watching,
          state: link.state ?? "open",
          title: `Pull request ${target.number}`,
          headBranch: link.headBranch ?? null,
          baseBranch: link.baseBranch ?? null,
          isDraft: link.isDraft ?? false,
          stack: null,
        };
      }),
      chains: [],
    }));

    tool("watch_pull_request", pullRequestTarget, ({ threadId, url }) => {
      const failure = watchFailures.shift();
      if (failure) throw new Error(failure);
      const thread = getThread(threadId ?? "");
      const target = identity(url ?? "");
      let link = thread.pullRequests.find((candidate) => candidate.url === target.url);
      // Watching links the pull request first when needed.
      if (!link) {
        link = { url: target.url, watching: false };
        thread.pullRequests.push(link);
      }
      const wasWatching = link.watching;
      link.watching = true;
      return { ...target, watching: true, wasWatching };
    });

    return server;
  }

  const handler = createMcpHandler(buildServer, { legacy: "stateless" });

  const http = createServer((req, res) => {
    void serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (await serveOAuth(req, res)) return;
    const bearer = req.headers.authorization;
    const issuedToken = state.oauth.issued.some((issued) => bearer === `Bearer ${issued}`);
    if (issuedToken) state.oauth.oauthCalls++;
    if (bearer !== `Bearer ${token}` && !issuedToken) {
      state.unauthorized++;
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = Buffer.concat(chunks);
    const response = await handler.fetch(
      new Request(`http://${req.headers.host}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(hasBody ? { body } : {}),
      }),
    );
    const dropAt = drops.indexOf(toolCalled(body) ?? "");
    if (dropAt >= 0) {
      drops.splice(dropAt, 1);
      // Let the tool finish, then lose the answer.
      await response.text();
      req.socket.destroy();
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    res.on("close", () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }

  // The OAuth endpoints. Returns false for any other path.
  async function serveOAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", state.oauth.issuer || "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const issuer = state.oauth.issuer;
    switch (`${req.method} ${url.pathname}`) {
      case "GET /.well-known/oauth-protected-resource/mcp":
      case "GET /.well-known/oauth-protected-resource":
        send(200, {
          resource: state.url,
          authorization_servers: [issuer],
          scopes_supported: ["orchestration:read", "orchestration:operate"],
        });
        return true;
      case "GET /.well-known/oauth-authorization-server":
        send(200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
        return true;
      case "POST /oauth/register": {
        const body = JSON.parse((await readBody(req)) || "{}") as { redirect_uris?: string[] };
        const redirectUris = body.redirect_uris ?? [];
        const allowed = redirectUris.every((uri) => {
          const target = new URL(uri);
          return target.protocol === "https:" || target.hostname === "127.0.0.1";
        });
        if (redirectUris.length === 0 || !allowed) {
          send(400, { error: "invalid_redirect_uri" });
          return true;
        }
        const clientId = `client-${randomBytes(6).toString("hex")}`;
        state.oauth.clients.set(clientId, { redirectUris });
        send(201, {
          ...body,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: "none",
        });
        return true;
      }
      case "GET /oauth/authorize": {
        const q = url.searchParams;
        const client = state.oauth.clients.get(q.get("client_id") ?? "");
        const redirectUri = q.get("redirect_uri") ?? "";
        if (
          !client?.redirectUris.includes(redirectUri) ||
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          q.get("resource") !== state.url
        ) {
          send(400, { error: "invalid_request" });
          return true;
        }
        const target = new URL(redirectUri);
        target.searchParams.set("state", q.get("state") ?? "");
        target.searchParams.set("iss", wrongIssuer ?? issuer);
        wrongIssuer = undefined;
        if (denyNext) {
          denyNext = false;
          target.searchParams.set("error", "access_denied");
        } else {
          const code = `code-${randomBytes(8).toString("hex")}`;
          codes.set(code, {
            clientId: q.get("client_id") ?? "",
            redirectUri,
            challenge: q.get("code_challenge") ?? "",
            resource: q.get("resource") ?? "",
          });
          target.searchParams.set("code", code);
        }
        res.writeHead(302, { location: target.toString() });
        res.end();
        return true;
      }
      case "POST /oauth/token": {
        const form = new URLSearchParams(await readBody(req));
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          form.get("grant_type") !== "authorization_code" ||
          !code ||
          code.clientId !== form.get("client_id") ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.resource !== form.get("resource") ||
          code.challenge !== challenge
        ) {
          send(400, { error: "invalid_grant" });
          return true;
        }
        const accessToken = `t3-oauth-${randomBytes(12).toString("hex")}`;
        state.oauth.issued.push(accessToken);
        send(200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: oauthTokenSeconds,
          scope: "orchestration:read orchestration:operate",
        });
        return true;
      }
      default:
        return false;
    }
  }

  // The tool a JSON-RPC `tools/call` request names.
  function toolCalled(body: Buffer): string | undefined {
    try {
      const message = JSON.parse(body.toString("utf8")) as {
        method?: string;
        params?: { name?: string };
      };
      return message.method === "tools/call" ? message.params?.name : undefined;
    } catch {
      return undefined;
    }
  }

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/mcp`;
  state.oauth.issuer = `http://127.0.0.1:${port}`;
  state.close = async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await handler.close();
  };
  return state;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
