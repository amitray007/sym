import type { UsageRecordedData } from "eve/events";

export type CacheUsageLine = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedTokens: number;
  cacheHitRate: number;
};

// One line per model run and compaction summary (decision 094). A delegated call's record repeats
// what its subagent already logged, so it gets no line.
export function cacheUsageLine(data: UsageRecordedData): CacheUsageLine | null {
  if (data.kind !== "model" || !data.owner || "callId" in data.owner) return null;
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = data.usage;
  if (inputTokens <= 0) return null;
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedTokens: inputTokens - cacheReadTokens - cacheWriteTokens,
    cacheHitRate: Math.round((cacheReadTokens / inputTokens) * 100) / 100,
  };
}
