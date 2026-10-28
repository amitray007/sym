// Who is calling a tool (docs/eve.md, MCP channel). Eve's MCP channel publishes every plain tool,
// so tools check the caller themselves: worker-only tools serve only worker threads, and tools
// that change Sym's state refuse them.

// Both shared read bearers and per-job capabilities use this worker principal.
export const WORKER_PRINCIPAL = "sym-worker";

export type Caller =
  | { principalId?: string; attributes?: Record<string, unknown> }
  | null
  | undefined;

export function isWorkerCaller(caller: Caller): boolean {
  return caller?.principalId === WORKER_PRINCIPAL;
}

export const WORKER_ONLY = "This tool is for worker threads only.";
export const NOT_FOR_WORKERS = "Worker threads cannot call this tool.";

export function workerJobId(caller: Caller): number | undefined {
  const value = caller?.attributes?.jobId;
  const id = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  return isWorkerCaller(caller) && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
