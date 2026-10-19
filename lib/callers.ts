// Who is calling a tool (docs/eve.md, MCP channel). Eve's MCP channel publishes every plain tool,
// so tools check the caller themselves: worker-only tools serve only worker threads, and tools
// that change Sym's state refuse them.

// The principal agent/channels/mcp.ts gives a worker thread that presents SYM_MCP_TOKEN.
export const WORKER_PRINCIPAL = "sym-worker";

type Caller = { principalId?: string } | null | undefined;

export function isWorkerCaller(caller: Caller): boolean {
  return caller?.principalId === WORKER_PRINCIPAL;
}

export const WORKER_ONLY = "This tool is for worker threads only.";
export const NOT_FOR_WORKERS = "Worker threads cannot call this tool.";
